import type { DocumentCategory } from '../types';
import type {
  AnyDocument,
  BusinessCard,
  DocumentType,
} from '../types';
import {
  attachExtractionReviewToCard,
  pagesFromScan,
} from './extraction-review';
import {
  applyDocumentFieldMerge,
} from './document-field-merge-application';
import { mergeDocumentPageFields } from './document-field-merge';
import {
  localSnapshotsToScanPageResults,
} from './document-page-extraction';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocumentAsync,
  shouldSkipStructuredCanonicalApply,
  type StructuredDocumentExtraction,
} from './document-structured-extraction';
import type { LocalOcrScanResult } from './local-ocr-pages';
import { scanPagesLocally } from './local-ocr-pages';
import { aggregateOcrQuality } from './ocr-quality';
import { buildCardTitle, parseCardFromPages } from './parser';
import { yieldToOperationEventLoop } from './scan-operation-lifecycle';
import {
  createScanProcessDeadline,
  createStructuredProcessDeadline,
  pageResultsDeadline,
  processDeadlineExceeded,
} from './scan-process-deadline';
import { logDocumentEngineBuild } from './document-engine-build';
import { traceScan } from './scan-trace';
import { notifyTrialScanCompleted } from './trial-scan-client';
import type { DocumentPageCaptureMetadata } from './document-capture-orientation';
import { createId } from './id';
import { logDocumentProcess } from './document-process-log';
import { PARSER_BUILD_ID } from './parser-version';
import type { PageExtractionResult } from './document-page-extraction';
import type { DocumentProcessProgressListener } from './document-process-progress';
import {
  classifyDocumentProcessResult,
  createDocumentProcessProgressReporter,
  type DocumentProcessResult,
} from './document-process-progress';
import {
  DocumentDuplicateCancelledError,
  DocumentDuplicateOpenExistingError,
} from './document-duplicate-guard';
import { inferCanonicalDocumentType } from './document-label-dictionary';
import { extractInlineDocumentNumberDate } from './document-inline-date';

export type ScanProcessWarning = 'ocr_empty' | 'ocr_short';

export interface ScanProcessOperation {
  readonly operationId: string;
  isActiveBeforeClaim(): boolean;
  isClaimCurrent(): boolean;
  tryFinalize(): boolean;
}

export interface ScanProcessPersistenceGuard {
  operationId: string;
  isActive(): boolean;
}

export interface ScanProcessPorts {
  ensureReady(): Promise<void>;
  scanPage(imageUri: string): Promise<LocalOcrScanResult>;
  publishBusinessCard(
    card: BusinessCard,
    cardImageUris: readonly string[],
    personImageUris: readonly string[]
  ): boolean;
  persistDocument(
    document: AnyDocument,
    guard: ScanProcessPersistenceGuard
  ): Promise<void>;
  notifyWarning(
    warning: ScanProcessWarning,
    documentType: DocumentType
  ): void;
  navigate(targetId: string, options?: { processResult?: DocumentProcessResult }): void;
  onProgress?: DocumentProcessProgressListener;
  yieldBeforeClaim?(): Promise<void>;
}

export interface ScanProcessRequest {
  documentType: DocumentType;
  /** User-selected category/tag. It does not choose a different extraction engine. */
  documentCategory?: DocumentCategory;
  imageUris: readonly string[];
  ocrImageUris?: readonly string[];
  originalImageUris?: readonly string[];
  pageCaptureMetadata?: readonly DocumentPageCaptureMetadata[];
  personImageUris?: readonly string[];
  operation: ScanProcessOperation;
  ports: ScanProcessPorts;
}

export type ScanProcessOutcome =
  | {
      status: 'completed';
      document: AnyDocument;
      ocrWorked: boolean;
      processResult: DocumentProcessResult;
    }
  | {
      status: 'ocr_insufficient';
    }
  | {
      status: 'inactive';
      checkpoint:
        | 'after_ready'
        | 'after_ocr'
        | 'before_claim'
        | 'claim_rejected'
        | 'publish_rejected'
        | 'after_publish'
        | 'duplicate_cancelled';
    };

function buildBusinessCard(
  pages: Awaited<ReturnType<typeof scanPagesLocally>>['pages'],
  imageUris: readonly string[],
  personImageUris: readonly string[],
  ocrQuality: ReturnType<typeof aggregateOcrQuality>
): BusinessCard {
  const parsed = parseCardFromPages(pages);
  const card: BusinessCard = {
    ...parsed,
    type: 'business_card',
    title: buildCardTitle(
      parsed.company,
      parsed.firstName,
      parsed.lastName
    ),
    images: [],
    ocrQuality,
  };
  const withReview = attachExtractionReviewToCard(
    card,
    pagesFromScan(pages)
  );
  const lastPersonPhoto = personImageUris.at(-1);
  return {
    ...withReview,
    images: [...imageUris],
    ...(lastPersonPhoto ? { contactPhotoUri: lastPersonPhoto } : {}),
  };
}


function layoutInputsFromPages(
  pages: Awaited<ReturnType<typeof scanPagesLocally>>['pages'],
  pageCaptureMetadata?: readonly DocumentPageCaptureMetadata[],
) {
  return pages.map((page, pageIndex) => ({
    pageIndex,
    lines: page.lines,
    rawText: page.rawText,
    width: page.ocrCanvasWidth ?? pageCaptureMetadata?.[pageIndex]?.width,
    height: page.ocrCanvasHeight ?? pageCaptureMetadata?.[pageIndex]?.height,
    rotationDegrees: page.rotationDegrees,
    ocrCanvasWidth: page.ocrCanvasWidth,
    ocrCanvasHeight: page.ocrCanvasHeight,
  }));
}


function enforceCommercialExtractionSanity(
  documentType: Exclude<DocumentType, 'business_card'>,
  pages: Awaited<ReturnType<typeof scanPagesLocally>>['pages'],
  extraction: StructuredDocumentExtraction,
): StructuredDocumentExtraction {
  if (documentType === 'free_document') return extraction;

  const meaningfulLineCount = pages.reduce(
    (sum, page) => sum + page.lines.filter((line) => line.text.trim().length >= 2).length,
    0,
  );
  const rawTextLength = pages.reduce((sum, page) => sum + page.rawText.trim().length, 0);

  // Text-rich commercial documents with zero extracted rows must never look
  // "complete". This is the exact failure mode seen on noisy/handwritten-like
  // scans: OCR saw substantial text, but row binding yielded nothing.
  if (
    extraction.items.length === 0 &&
    meaningfulLineCount >= 12 &&
    rawTextLength >= 80
  ) {
    const reason = 'ocr_text_without_line_items';
    return {
      ...extraction,
      complete: false,
      requiresReview: true,
      requiresRescan: extraction.requiresRescan,
      summary: {
        ...extraction.summary,
        requiresReview: true,
      },
      reasons: extraction.reasons.includes(reason)
        ? extraction.reasons
        : [...extraction.reasons, reason],
    };
  }
  return extraction;
}

/** Estrazione strutturata completa durante Elabora; deferred solo su OCR assente o errore runtime. */
async function resolveStructuredExtractionForScan(
  documentType: Exclude<DocumentType, 'business_card'>,
  pages: Awaited<ReturnType<typeof scanPagesLocally>>['pages'],
  pageCaptureMetadata?: readonly DocumentPageCaptureMetadata[],
  options?: {
    isActive?: () => boolean;
    processDeadline?: number;
    onProgress?: DocumentProcessProgressListener;
  },
): Promise<StructuredDocumentExtraction> {
  traceScan('workflow:structured_begin');
  const inputs = layoutInputsFromPages(pages, pageCaptureMetadata);
  const readableText = pages.map((page) => page.rawText).join('\n').trim();
  if (pages.every((page) => page.lines.length === 0) && readableText.length < 10) {
    traceScan('workflow:structured_skipped', { reason: 'insufficient_ocr' });
    return {
      schemaVersion: 1,
      metadata: {},
      items: [],
      summary: { taxSummaries: [], conflicts: [], requiresReview: true },
      conditions: {},
      pages: inputs.map((input, pageIndex) => ({
        pageIndex,
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        lines: [],
        zones: [],
        status: 'incomplete' as const,
        complete: false,
        requiresRescan: true,
        reasons: ['structured_extraction_insufficient_ocr'],
      })),
      complete: false,
      requiresRescan: true,
      requiresReview: true,
      reasons: ['structured_extraction_insufficient_ocr'],
    };
  }
  try {
    const extraction = await extractStructuredDocumentAsync(documentType, inputs, {
      ...options,
      processDeadline: options?.processDeadline,
      onProgress: options?.onProgress,
    });
    const saneExtraction = enforceCommercialExtractionSanity(documentType, pages, extraction);
    traceScan('workflow:structured_done', {
      deferred: false,
      items: saneExtraction.items.length,
      complete: saneExtraction.complete,
    });
    return saneExtraction;
  } catch (error) {
    traceScan('workflow:structured_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      schemaVersion: 1,
      metadata: {},
      items: [],
      summary: { taxSummaries: [], conflicts: [], requiresReview: true },
      conditions: {},
      pages: inputs.map((input, pageIndex) => ({
        pageIndex,
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        lines: [],
        zones: [],
        status: 'partial' as const,
        complete: false,
        requiresRescan: false,
        reasons: ['structured_extraction_runtime_error'],
      })),
      complete: false,
      requiresRescan: false,
      requiresReview: true,
      reasons: ['structured_extraction_runtime_error'],
    };
  }
}

function buildDocumentProcessingShell(
  documentType: Exclude<DocumentType, 'business_card'>,
  imageUris: readonly string[],
  pageExtractions: PageExtractionResult[],
  ocrQuality: ReturnType<typeof aggregateOcrQuality>,
  pageCaptureMetadata?: readonly DocumentPageCaptureMetadata[],
  originalImageUris?: readonly string[],
): AnyDocument {
  const shared = {
    id: createId(),
    images: [...imageUris],
    items: [],
    confidence: {},
    title: '',
    rawText: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    pageExtractions,
    ocrQuality,
    ...(originalImageUris ? { originalImages: [...originalImageUris] } : {}),
    ...(pageCaptureMetadata ? { pageCaptureMetadata: [...pageCaptureMetadata] } : {}),
  };
  switch (documentType) {
    case 'quote':
      return { ...shared, type: 'quote' };
    case 'order':
      return { ...shared, type: 'order' };
    case 'invoice':
      return { ...shared, type: 'invoice' };
    case 'free_document':
      return { ...shared, type: 'free_document', extractedFields: {} };
  }
}

function explicitDocumentIdentityFromOcr(
  pages: Awaited<ReturnType<typeof scanPagesLocally>>['pages'],
): {
  type?: Exclude<DocumentType, 'business_card' | 'free_document'>;
  number?: string;
  date?: Date;
} {
  const lines = pages.flatMap((page) => page.rawText.split(/\r?\n/).map((text) => text.trim()).filter(Boolean));
  // Never let the first incidental commercial word decide the document type.
  // Real documents routinely contain references to invoices, quotations and orders
  // together. Score all early header evidence, giving strong explicit headings and
  // type-specific number labels much more weight than incidental references.
  const typeScores: Record<'quotation' | 'order' | 'invoice', number> = {
    quotation: 0, order: 0, invoice: 0,
  };
  lines.slice(0, 50).forEach((line, index) => {
    const normalized = line.toLowerCase();
    const inferred = inferCanonicalDocumentType(line)?.type;
    if (inferred === 'quotation' || inferred === 'order' || inferred === 'invoice') {
      typeScores[inferred] += index < 12 ? 3 : index < 25 ? 2 : 1;
    }
    if (/\b(?:auftragsbest(?:ä|ae|a)tigung|order\s+confirmation|conferma\s+d['’]?ordine|orden\s+de\s+compra|purchase\s+order)\b/i.test(normalized)) typeScores.order += 10;
    if (/\b(?:auftragsnummer|order\s+(?:no\.?|number)|ordine\s+n\.?|pedido\s+n[º°.]?)\b/i.test(normalized)) typeScores.order += 7;
    if (/\b(?:tax\s+invoice|commercial\s+invoice|fattura(?:\s+elettronica)?|rechnung|facture|factura)\b/i.test(normalized)) typeScores.invoice += 8;
    if (/\b(?:rechnungsnummer|invoice\s+(?:no\.?|number)|fattura\s+n\.?|facture\s+n[º°.]?)\b/i.test(normalized)) typeScores.invoice += 7;
    if (/\b(?:preventivo|offerta\s+(?:tecnico[- ]economica|commerciale)|quotation|devis|angebot)\b/i.test(normalized)) typeScores.quotation += 8;
    if (/\b(?:angebotsnummer|quotation\s+(?:no\.?|number)|quote\s+(?:no\.?|number)|preventivo\s+n\.?|devis\s+n[º°.]?)\b/i.test(normalized)) typeScores.quotation += 7;
    // Explicit historical/reference wording must not outweigh the current heading.
    if (/\b(?:reference|riferimento|bezug|ancienne|precedente|previous|old|storico|historical)\b/i.test(normalized)) {
      if (/invoice|fattura|rechnung|facture|factura/i.test(normalized)) typeScores.invoice -= 3;
      if (/quotation|quote|preventivo|offerta|angebot|devis/i.test(normalized)) typeScores.quotation -= 3;
      if (/order|ordine|auftrag|pedido/i.test(normalized)) typeScores.order -= 3;
    }
  });
  const strongHeadingType = lines.slice(0, 24).reduce<keyof typeof typeScores | undefined>((winner, line, index) => {
    if (winner) return winner;
    const normalized = line.toLowerCase().replace(/\s+/g, ' ').trim();
    const headerWeight = index < 12;
    if (headerWeight && /^(?:auftragsbest(?:ä|ae|a)tigung|order confirmation|conferma d['’]?ordine|ordine(?:\s*[/|-]\s*bestellung)?|purchase order|bestellung)\b/i.test(normalized)) return 'order';
    if (headerWeight && /^(?:invoice|tax invoice|commercial invoice|fattura(?: elettronica)?|rechnung|facture|factura)\b/i.test(normalized)) return 'invoice';
    if (headerWeight && /^(?:quotation|quote|preventivo|offerta(?: tecnico[- ]economica| commerciale)?|devis|angebot)\b/i.test(normalized)) return 'quotation';
    return undefined;
  }, undefined);
  const rankedTypes = (Object.entries(typeScores) as Array<[keyof typeof typeScores, number]>)
    .sort((a, b) => b[1] - a[1]);
  const canonicalType = strongHeadingType ?? (
    rankedTypes[0][1] >= 7 && rankedTypes[0][1] >= rankedTypes[1][1] + 2
      ? rankedTypes[0][0]
      : undefined
  );
  const type: Exclude<DocumentType, 'business_card' | 'free_document'> | undefined =
    canonicalType === 'quotation' ? 'quote' : canonicalType;

  const labeledNumber = lines.slice(0, 50).flatMap((line) => {
    const direct = line.match(/\b(?:auftragsnummer|rechnungsnummer|angebotsnummer|fattura\s*n\.?|ordine\s*n\.?|preventivo\s*n\.?|invoice\s*(?:no\.?|number)|order\s*(?:no\.?|number)|quotation\s*(?:no\.?|number)|quote\s*(?:no\.?|number))\s*[:#.-]*\s*([A-Z0-9][A-Z0-9/._-]{2,30})\b/i)?.[1];
    return direct && !/^[+-]?\d+[.,]\d{2,4}$/.test(direct) ? [direct] : [];
  })[0];

  let dateRaw: string | undefined;
  for (let index = 0; index < Math.min(lines.length, 55) && !dateRaw; index += 1) {
    const window = lines.slice(index, index + 5).join(' ');
    const inline = extractInlineDocumentNumberDate(lines[index]) ?? extractInlineDocumentNumberDate(window);
    if (inline && (!labeledNumber || inline.identifier.toLowerCase() === labeledNumber.toLowerCase())) {
      dateRaw = inline.rawDate;
      break;
    }
    if (labeledNumber && lines[index].includes(labeledNumber)) {
      dateRaw = window.match(/\b(?:del|vom|dated)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{4})\b/i)?.[1];
    }
  }
  const date = dateRaw ? (() => {
    const match = dateRaw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!match) return undefined;
    const parsed = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), 12, 0, 0);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  })() : undefined;
  return {
    ...(type ? { type } : {}),
    ...(labeledNumber ? { number: labeledNumber } : {}),
    ...(date ? { date } : {}),
  };
}

function applyExplicitOcrIdentity(
  document: AnyDocument,
  identity: ReturnType<typeof explicitDocumentIdentityFromOcr>,
): AnyDocument {
  if (document.type === 'business_card' || document.type === 'free_document') return document;
  const structuredNumber = (document as AnyDocument & { structuredExtraction?: StructuredDocumentExtraction }).structuredExtraction?.metadata.documentNumber;
  const hasStructuredNumber = structuredNumber?.normalizedValue !== undefined
    && structuredNumber.validationStatus !== 'invalid';
  const number = hasStructuredNumber ? undefined : identity.number;
  const date = identity.date;
  if (document.type === 'quote') {
    return {
      ...document,
      ...(number ? { quoteNumber: number, title: `Preventivo ${number}` } : {}),
      ...(date ? { quoteDate: date } : {}),
    };
  }
  if (document.type === 'order') {
    return {
      ...document,
      ...(number ? { orderNumber: number, title: `Ordine ${number}` } : {}),
      ...(date ? { orderDate: date } : {}),
    };
  }
  return {
    ...document,
    ...(number ? { invoiceNumber: number, title: `Fattura ${number}` } : {}),
    ...(date ? { invoiceDate: date } : {}),
  };
}

function buildLocalDocument(
  documentType: Exclude<DocumentType, 'business_card'>,
  pages: Awaited<ReturnType<typeof scanPagesLocally>>['pages'],
  imageUris: readonly string[],
  ocrQuality: ReturnType<typeof aggregateOcrQuality>,
  pageExtractions: PageExtractionResult[],
  structuredExtraction: StructuredDocumentExtraction,
  pageCaptureMetadata?: readonly DocumentPageCaptureMetadata[],
  originalImageUris?: readonly string[],
): AnyDocument {
  traceScan('workflow:build_local_begin', { lines: pages.reduce((n, p) => n + p.lines.length, 0) });
  traceScan('workflow:field_merge_begin');
  const fieldMerge = mergeDocumentPageFields(pageExtractions);
  traceScan('workflow:field_merge_done');
  const mergeStarted = Date.now();
  logDocumentProcess('merge_start');
  const explicitIdentity = explicitDocumentIdentityFromOcr(pages);
  const effectiveDocumentType = explicitIdentity.type ?? documentType;
  const shell = buildDocumentProcessingShell(
    effectiveDocumentType,
    imageUris,
    pageExtractions,
    ocrQuality,
    pageCaptureMetadata,
    originalImageUris,
  );
  const merged = applyDocumentFieldMerge(shell, fieldMerge, { mode: 'new_scan' });
  console.warn(`[StructuredMergePerf] before ${JSON.stringify({
    structuredItems: structuredExtraction.items.length,
    localItems: Array.isArray((merged as { items?: unknown[] }).items) ? (merged as { items: unknown[] }).items.length : 0,
    fallbackItems: 0,
  })}`);
  if (shouldSkipStructuredCanonicalApply(structuredExtraction)) {
    traceScan('workflow:structured_deferred_only', {
      reasons: structuredExtraction.reasons.join(','),
    });
    const deferredBase: AnyDocument = { ...merged, structuredExtraction };
    const deferredDocument = applyExplicitOcrIdentity(deferredBase, explicitIdentity);
    logDocumentProcess('merge_done', { ms: Date.now() - mergeStarted, deferred: true });
    return deferredDocument;
  }
  const document = applyStructuredExtractionToDocument(
    merged,
    structuredExtraction,
    { mode: 'new_scan' },
  );
  console.warn(`[StructuredMergePerf] after ${JSON.stringify({
    finalItems: Array.isArray((document as { items?: unknown[] }).items) ? (document as { items: unknown[] }).items.length : 0,
  })}`);
  const recoveredDocument = applyExplicitOcrIdentity(document, explicitIdentity);
  logDocumentProcess('merge_done', { ms: Date.now() - mergeStarted, deferred: false });
  return recoveredDocument;
}

export async function processCapturedScan(
  request: ScanProcessRequest
): Promise<ScanProcessOutcome> {
  const {
    documentType,
    documentCategory,
    imageUris,
    ocrImageUris = imageUris,
    originalImageUris,
    pageCaptureMetadata,
    personImageUris = [],
    operation,
    ports,
  } = request;

  if (ocrImageUris.length !== imageUris.length) {
    throw new Error('Numero immagini OCR non allineato alle sorgenti persistenti');
  }
  if (originalImageUris && originalImageUris.length !== imageUris.length) {
    throw new Error('Numero immagini originali non allineato alle pagine persistenti');
  }

  await ports.ensureReady();
  if (!operation.isActiveBeforeClaim()) {
    return { status: 'inactive', checkpoint: 'after_ready' };
  }

  const processStarted = Date.now();
  const processDeadline = createScanProcessDeadline(imageUris.length);
  const progress = createDocumentProcessProgressReporter(ports.onProgress, {
    startedAt: processStarted,
  });
  progress.prepare();
  logDocumentProcess('start', {
    documentType,
    pages: imageUris.length,
    processDeadlineMs: processDeadline - processStarted,
  });

  logDocumentProcess('ocr_start');
  const ocrStarted = Date.now();
  const { pages, ocrWorked } = await scanPagesLocally(
    ocrImageUris,
    ports.scanPage,
    {
      isActive: operation.isActiveBeforeClaim,
      // Business-card OCR is a user-facing capture operation.  The process
      // clock must therefore govern ML Kit too, not only later parsing.
      ...(documentType === 'business_card'
        ? { deadline: processDeadline, operationIdPrefix: operation.operationId }
        : {}),
      onPageComplete: (pageIndex, pageCount) => {
        progress.ocrPage(pageIndex, pageCount);
        progress.maybeSlow();
      },
    }
  );
  logDocumentProcess('ocr_done', { ms: Date.now() - ocrStarted });
  traceScan('workflow:after_ocr', {
    pages: pages.length,
    ocrWorked,
    ms: Date.now() - ocrStarted,
  });
  if (!operation.isActiveBeforeClaim()) {
    return { status: 'inactive', checkpoint: 'after_ocr' };
  }

  let document: AnyDocument;
  let businessCardOcrInsufficient = false;
  if (documentType === 'business_card') {
    const ocrQuality = aggregateOcrQuality(
      pages.flatMap((page, pageIndex) => {
        const imageUri = imageUris[pageIndex];
        return imageUris.indexOf(imageUri) === pageIndex
          ? [page.ocrQuality]
          : [];
      })
    );
    document = buildBusinessCard(
      pages,
      imageUris,
      personImageUris,
      ocrQuality
    );
    const cardReview = document.type === 'business_card' ? document.extractionReview : undefined;
    const criticalReviewFields = new Set(['firstName', 'lastName', 'company', 'emails']);
    const criticalReviewCount = (cardReview?.reviewFields ?? []).filter((field) =>
      criticalReviewFields.has(field)
    ).length;
    businessCardOcrInsufficient =
      ocrQuality.requiresReview && criticalReviewCount >= 2;
    if (businessCardOcrInsufficient) {
      console.warn('[BusinessCardQuality] rejected', {
        heuristicQuality: ocrQuality.heuristicQuality,
        criticalReviewCount,
        reviewFields: cardReview?.reviewFields ?? [],
      });
    }
  } else {
    traceScan('workflow:page_results_begin');
    logDocumentProcess('page_results_start');
    progress.pageResults();
    await yieldToOperationEventLoop();
    const pageResultsStarted = Date.now();
    const pageResultsBudget = pageResultsDeadline(processDeadline);
    const pageExtractions = localSnapshotsToScanPageResults(
      documentType,
      imageUris,
      pages,
      { deadline: pageResultsBudget },
    );
    const pageResultsMs = Date.now() - pageResultsStarted;
    logDocumentProcess('page_results_done', {
      ms: pageResultsMs,
      pages: pageExtractions.length,
      budgetExceeded: processDeadlineExceeded(pageResultsBudget),
    });
    traceScan('workflow:page_results_done', {
      pages: pageExtractions.length,
      ms: pageResultsMs,
    });
    await yieldToOperationEventLoop();
    if (processDeadlineExceeded(processDeadline)) {
      logDocumentProcess('watchdog_warning', { stage: 'before_structured' });
    }
    const ocrQuality = aggregateOcrQuality(
      pageExtractions
        .filter((page) => page.duplicateOf === undefined)
        .map((page) => page.ocrQuality)
    );
    await yieldToOperationEventLoop();
    const structuredDeadline = createStructuredProcessDeadline(pages.length);
    logDocumentEngineBuild({ pageCount: pages.length, deadlineMode: 'structured_independent' });
    logDocumentProcess('structured_start', {
      parserBuildId: PARSER_BUILD_ID,
      ocrRemainingMs: processDeadline - Date.now(),
      structuredBudgetMs: structuredDeadline - Date.now(),
    });
    const structuredStarted = Date.now();
    const structuredExtraction = await resolveStructuredExtractionForScan(
      documentType,
      pages,
      pageCaptureMetadata,
      {
        isActive: operation.isActiveBeforeClaim,
        processDeadline: structuredDeadline,
        onProgress: ports.onProgress,
      },
    );
    logDocumentProcess('structured_done', {
      ms: Date.now() - structuredStarted,
      items: structuredExtraction.items.length,
      complete: structuredExtraction.complete,
      reasons: structuredExtraction.reasons,
    });
    await yieldToOperationEventLoop();
    const extractionSignalsOcrReview =
      structuredExtraction.requiresReview &&
      (structuredExtraction.items.length === 0 ||
        structuredExtraction.reasons.some((reason) =>
          /ocr_text_without_line_items|items_missing|zero_items|dropped|mismatch/i.test(reason)
        ));
    const effectiveOcrQuality = extractionSignalsOcrReview
      ? { ...ocrQuality, requiresReview: true }
      : ocrQuality;
    document = buildLocalDocument(
      documentType,
      pages,
      imageUris,
      effectiveOcrQuality,
      pageExtractions,
      structuredExtraction,
      pageCaptureMetadata,
      originalImageUris,
    );
    if (documentCategory) {
      document = { ...document, category: documentCategory };
    }
    traceScan('workflow:build_local_done');
  }

  const allText = pages.map((page) => page.rawText).join('\n\n');
  const classifiedProcessResult = documentType === 'business_card'
    ? (businessCardOcrInsufficient ? 'ocr_insufficient' as const : 'success' as const)
    : classifyDocumentProcessResult({
        ocrWorked,
        rawTextLength: allText.trim().length,
        structuredExtraction: document.type !== 'business_card'
          ? document.structuredExtraction
          : undefined,
      });
  // An explicitly selected generic image is valid even when it contains no
  // readable text. It is still stored locally; OCR remains best-effort only.
  const processResult =
    documentCategory === 'generic_image' && classifiedProcessResult === 'ocr_insufficient'
      ? 'success' as const
      : classifiedProcessResult;

  if (processResult === 'ocr_insufficient') {
    progress.done();
    return { status: 'ocr_insufficient' };
  }

  traceScan('workflow:document_built', { type: document.type, id: document.id });
  await (ports.yieldBeforeClaim ?? yieldToOperationEventLoop)();
  if (!operation.isActiveBeforeClaim()) {
    return { status: 'inactive', checkpoint: 'before_claim' };
  }
  if (!operation.tryFinalize()) {
    return { status: 'inactive', checkpoint: 'claim_rejected' };
  }

  // Questo workflow resta locale/offline. Il cloud è raggiungibile soltanto
  // dal flusso di review esplicita, dopo il consenso dell'utente.
  if (document.type === 'business_card') {
    if (
      !operation.isClaimCurrent() ||
      !ports.publishBusinessCard(
        document,
        imageUris,
        personImageUris
      )
    ) {
      return { status: 'inactive', checkpoint: 'publish_rejected' };
    }
  } else {
    traceScan('workflow:persist_begin', { id: document.id });
    logDocumentProcess('persist_start', { id: document.id });
    progress.persist();
    const persistStarted = Date.now();
    try {
      await ports.persistDocument(document, {
        operationId: operation.operationId,
        isActive: operation.isClaimCurrent,
      });
    } catch (error) {
      if (error instanceof DocumentDuplicateCancelledError) {
        return { status: 'inactive', checkpoint: 'duplicate_cancelled' };
      }
      if (error instanceof DocumentDuplicateOpenExistingError) {
        ports.navigate(error.existingId, { processResult });
        return { status: 'completed', document, ocrWorked, processResult };
      }
      throw error;
    }
    logDocumentProcess('persist_done', { id: document.id, ms: Date.now() - persistStarted });
    traceScan('workflow:persist_done', { id: document.id, ms: Date.now() - persistStarted });
  }

  if (!operation.isClaimCurrent()) {
    return { status: 'inactive', checkpoint: 'after_publish' };
  }

  await notifyTrialScanCompleted({
    operationId: operation.operationId,
    event:
      documentType === 'business_card'
        ? 'business_card_draft_ready'
        : 'document_persisted',
  });

  const allTextForWarnings = pages.map((page) => page.rawText).join('\n\n');
  if (!ocrWorked) {
    ports.notifyWarning('ocr_empty', documentType);
  } else if (
    documentType !== 'business_card' &&
    allTextForWarnings.trim().length < 40 &&
    processResult !== 'partial_success'
  ) {
    ports.notifyWarning('ocr_short', documentType);
  }

  progress.done();
  ports.navigate(String(document.id).trim(), { processResult });
  traceScan('workflow:navigate', { id: document.id, processResult });
  logDocumentProcess('total', { ms: Date.now() - processStarted, id: document.id, processResult });
  return { status: 'completed', document, ocrWorked, processResult };
}

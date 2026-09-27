import type { AnyDocument, OcrLine } from '../types';
import type { DocumentLayoutPageInput } from './document-layout';
import type { StructuredDocumentExtraction, StructuredDocumentType } from './document-structure';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocumentAsync,
} from './document-structured-extraction';
import { createScanProcessDeadline } from './scan-process-deadline';
import {
  type CanonicalParseSnapshot,
  recordStage,
} from './document-parse-snapshot';
import { sanitizeDocumentMonetaryFields } from './document-monetary-guardrails';
import { getDocumentProcessPerfReport } from './document-process-perf';

export interface CanonicalOcrPageInput {
  pageIndex: number;
  rawText: string;
  width?: number;
  height?: number;
  rotationDegrees?: 0 | 90 | 180 | 270;
  ocrCanvasWidth?: number;
  ocrCanvasHeight?: number;
  lines: readonly OcrLine[];
}

export interface CanonicalParseInput {
  documentType: StructuredDocumentType;
  pages: readonly CanonicalOcrPageInput[];
  deadlineMode?: 'production' | 'unlimited';
}

export interface CanonicalParseResult {
  extraction: StructuredDocumentExtraction;
  persisted: AnyDocument;
  snapshot: CanonicalParseSnapshot;
}

export function layoutInputsFromCanonicalPages(
  pages: readonly CanonicalOcrPageInput[],
): DocumentLayoutPageInput[] {
  return pages.map((page) => ({
    pageIndex: page.pageIndex,
    rawText: page.rawText,
    lines: page.lines,
    ...(page.width ? { width: page.width } : {}),
    ...(page.height ? { height: page.height } : {}),
    ...(page.rotationDegrees ? { rotationDegrees: page.rotationDegrees } : {}),
    ...(page.ocrCanvasWidth ? { ocrCanvasWidth: page.ocrCanvasWidth } : {}),
    ...(page.ocrCanvasHeight ? { ocrCanvasHeight: page.ocrCanvasHeight } : {}),
  }));
}

export function canonicalPagesFromPersistedDocument(document: AnyDocument): CanonicalOcrPageInput[] {
  const capture = 'pageCaptureMetadata' in document ? document.pageCaptureMetadata : undefined;
  return (document.structuredExtraction?.pages ?? []).map((page, index) => {
    const meta = capture?.[index];
    const width = page.width ?? meta?.ocrWidth ?? meta?.persistedWidth ?? meta?.width;
    const height = page.height ?? meta?.ocrHeight ?? meta?.persistedHeight ?? meta?.height;
    const rotation = meta?.rotationApplied === 90 || meta?.rotationApplied === 180 || meta?.rotationApplied === 270
      ? meta.rotationApplied
      : undefined;
    return {
      pageIndex: page.pageIndex,
      rawText: page.lines.map((line) => line.text).join('\n'),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(rotation ? { rotationDegrees: rotation } : {}),
      ...(meta?.ocrWidth ? { ocrCanvasWidth: meta.ocrWidth } : {}),
      ...(meta?.ocrHeight ? { ocrCanvasHeight: meta.ocrHeight } : {}),
      lines: page.lines.map((line): OcrLine => ({
        text: line.text,
        confidence: 0.9,
        ...(line.boundingBox ? { boundingBox: line.boundingBox } : {}),
        ...(line.elements ? { elements: line.elements } : {}),
      })),
    };
  });
}

/**
 * Single production entry used by Android scan workflow, Node replay, and tests.
 * Does not invent a second parser.
 */
export async function parseStructuredDocumentFromOcr(
  input: CanonicalParseInput,
  options?: { persistShell?: AnyDocument },
): Promise<CanonicalParseResult> {
  const deadlineMode = input.deadlineMode ?? 'production';
  const pages = layoutInputsFromCanonicalPages(input.pages);
  const processDeadline = deadlineMode === 'production'
    ? createScanProcessDeadline(pages.length)
    : undefined;
  const extraction = await extractStructuredDocumentAsync(input.documentType, pages, {
    ...(processDeadline !== undefined ? { processDeadline } : {}),
  });
  const shell = options?.persistShell ?? emptyShell(input.documentType);
  const persisted = applyStructuredExtractionToDocument(shell, extraction, { mode: 'new_scan' });
  const snapshot = buildSnapshotFromResult(input, extraction, persisted, deadlineMode);
  return { extraction, persisted, snapshot };
}

function emptyShell(documentType: StructuredDocumentType): AnyDocument {
  const shared = {
    id: 'canonical-replay',
    images: [],
    items: [],
    confidence: {},
    title: '',
    rawText: '',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  if (documentType === 'order') return { ...shared, type: 'order' };
  if (documentType === 'invoice') return { ...shared, type: 'invoice' };
  if (documentType === 'free_document')
    return { ...shared, type: 'free_document', extractedFields: {} };
  return { ...shared, type: 'quote' };
}

function buildSnapshotFromResult(
  input: CanonicalParseInput,
  extraction: StructuredDocumentExtraction,
  persisted: AnyDocument,
  deadlineMode: 'production' | 'unlimited',
): CanonicalParseSnapshot {
  const ocrLineCount = input.pages.reduce((sum, page) => sum + page.lines.length, 0);
  const geometryCount = input.pages.reduce(
    (sum, page) => sum + page.lines.filter((line) => !!line.boundingBox).length,
    0,
  );
  const monetary = sanitizeDocumentMonetaryFields({
    subtotal:
      persisted.type === 'quote' || persisted.type === 'order' || persisted.type === 'invoice'
        ? persisted.subtotal
        : undefined,
    vatAmount:
      persisted.type === 'quote' || persisted.type === 'order' || persisted.type === 'invoice'
        ? persisted.vatAmount
        : undefined,
    total:
      persisted.type === 'quote' || persisted.type === 'order' || persisted.type === 'invoice'
        ? persisted.total
        : undefined,
    items:
      persisted.type === 'quote' || persisted.type === 'order' || persisted.type === 'invoice'
        ? persisted.items
        : undefined,
  });
  const tableZones = extraction.pages.flatMap((page) =>
    page.zones.filter((zone) => zone.classification === 'items_table').map((zone) => ({
      pageIndex: page.pageIndex,
      classification: zone.classification,
      lineCount: zone.lineIds.length,
    })));
  const columnSemantics = extraction.items.map((item) => ({
    qty: item.quantity?.normalizedValue ?? null,
    unitPrice: item.unitPrice?.normalizedValue ?? null,
    discount: item.discount?.normalizedValue ?? null,
    vat: item.vatRate?.normalizedValue ?? null,
    total: item.lineTotal?.normalizedValue ?? null,
  }));
  const perf = getDocumentProcessPerfReport();
  return {
    runtime: typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object'
      ? 'hermes'
      : 'node',
    input: {
      pageCount: input.pages.length,
      ocrLineCount,
      geometryCount,
      documentType: input.documentType,
      deadlineMode,
    },
    stageTimings: perf.stages.map((entry) => ({
      stage: entry.stage,
      durationMs: entry.durationMs,
    })),
    stages: [
      recordStage('normalized_ocr', input.pages.map((page) => page.lines.map((line) => ({
        text: line.text,
        box: line.boundingBox ?? null,
      })))),
      recordStage('language', extraction.language?.primaryLanguage ?? null),
      recordStage('layout', extraction.pages.map((page) => ({
        pageIndex: page.pageIndex,
        zones: page.zones.map((zone) => zone.classification),
      }))),
      recordStage('zones', tableZones),
      recordStage('party_candidates', {
        issuer: extraction.issuer?.name?.normalizedValue ?? null,
        customer: extraction.customer?.name?.normalizedValue ?? null,
        recipient: extraction.recipient?.name?.normalizedValue ?? null,
      }),
      recordStage('issuer_candidates', extraction.issuer?.name?.normalizedValue ?? null),
      recordStage('customer_candidates', extraction.customer?.name?.normalizedValue ?? null),
      recordStage('date_candidates', {
        issue: extraction.metadata.issueDate?.normalizedValue ?? null,
        due: extraction.metadata.dueDate?.normalizedValue ?? null,
      }),
      recordStage('table_headers', tableZones.map((zone) => zone.lineCount)),
      recordStage('column_semantics', columnSemantics),
      recordStage('row_bands', { itemCount: extraction.items.length }),
      recordStage('item_candidates', extraction.items.map((item) => item.description?.normalizedValue ?? null)),
      recordStage('selected_items', extraction.items.map((item) => ({
        qty: item.quantity?.normalizedValue ?? null,
        price: item.unitPrice?.normalizedValue ?? null,
        total: item.lineTotal?.normalizedValue ?? null,
      }))),
      recordStage('totals_candidates', {
        subtotal: extraction.summary.subtotal?.normalizedValue ?? null,
        discount: extraction.summary.discountTotal?.normalizedValue ?? null,
        shipping: extraction.summary.shippingCost?.normalizedValue ?? null,
        vat: extraction.summary.vatAmount?.normalizedValue ?? null,
        total: extraction.summary.total?.normalizedValue ?? null,
      }),
      recordStage('selected_gross', extraction.summary.subtotal?.normalizedValue ?? null),
      recordStage('selected_discount', extraction.summary.discountTotal?.normalizedValue ?? null),
      recordStage('selected_net_taxable', extraction.summary.taxableAmount?.normalizedValue
        ?? extraction.summary.subtotal?.normalizedValue ?? null),
      recordStage('selected_vat', extraction.summary.vatAmount?.normalizedValue ?? null),
      recordStage('selected_grand_total', extraction.summary.total?.normalizedValue ?? null),
      recordStage('document_number', extraction.metadata.documentNumber?.normalizedValue ?? null),
      recordStage('canonical_result', {
        items: extraction.items.length,
        issuer: extraction.issuer?.name?.normalizedValue ?? null,
        customer: extraction.customer?.name?.normalizedValue ?? null,
        number: extraction.metadata.documentNumber?.normalizedValue ?? null,
        subtotal: extraction.summary.subtotal?.normalizedValue ?? null,
        vat: extraction.summary.vatAmount?.normalizedValue ?? null,
        total: extraction.summary.total?.normalizedValue ?? null,
        discount: extraction.summary.discountTotal?.normalizedValue ?? null,
        shipping: extraction.summary.shippingCost?.normalizedValue ?? null,
      }),
      recordStage('persistence_input', persisted.type === 'business_card' ? null : {
        customer:
          persisted.type === 'free_document' ? null : persisted.customerName ?? null,
        items: persisted.type === 'free_document' ? 0 : persisted.items?.length ?? 0,
        subtotal: persisted.type === 'free_document' ? null : monetary.subtotal ?? null,
        vat: persisted.type === 'free_document' ? null : monetary.vatAmount ?? null,
        total: persisted.type === 'free_document' ? null : monetary.total ?? null,
      }),
    ],
  };
}

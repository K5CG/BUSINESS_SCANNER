import type {
  AnyDocument,
  DocumentType,
  FreeDocument,
  InvoiceDocument,
  OrderDocument,
  QuoteDocument,
} from '../types';
import type {
  GeminiDocumentExtract,
  GeminiDocumentExtractOutcome,
} from './gemini-ocr';
import {
  extractCloudPagesWithLocalFallback,
  type LocalDocumentPageExtractor,
  type DocumentPageStructureBuilder,
  type DocumentPageStructuredFields,
  type PageExtractionResult,
} from './document-page-extraction';
import { aggregateOcrQuality, assessOcrQuality } from './ocr-quality';
import {
  mergeDocumentPageFields,
  mergeResultToStructuredFields,
  type DocumentFieldMergeResult,
} from './document-field-merge';
import {
  applyDocumentFieldMerge,
  fieldMergeToGeminiExtract,
} from './document-field-merge-application';
import type { BuildDocumentFromExtractOptions } from './document-from-extract';
import { MAX_CLOUD_DOCUMENT_PAGES } from './cloud-ai-limits';
import { isRcCloudAiEnabled } from './release-rc-policy';
import { mergeAiStructuredDocuments } from './document-ai-contract';

export type DocumentAiReviewDecision = 'cancel' | 'confirm';

export type DocumentAiReviewOutcome =
  | { status: 'cancelled'; document: AnyDocument }
  | { status: 'ok'; document: AnyDocument; aiExtract: GeminiDocumentExtract }
  | { status: 'not_configured'; document: AnyDocument }
  | {
      status: 'error';
      document: AnyDocument;
      message?: string;
      reason?: 'provider_unavailable' | 'credits_exhausted' | 'invalid_request';
    };

export type DocumentAiReviewOptions = {
  /** Test-only: consente di esercitare il workflow AI mantenendo RC_AI_DISABLED=true in produzione. */
  testOnlyBypassRcCloudAi?: boolean;
};

export type DocumentAiPageExtractor = (
  imageUri: string,
  pageIndex?: number,
  pageCount?: number
) => Promise<GeminiDocumentExtractOutcome>;

export type DocumentFromExtractBuilder = (
  documentType: DocumentType,
  extract: GeminiDocumentExtract,
  options?: BuildDocumentFromExtractOptions
) => AnyDocument;

function firstNonEmpty(
  extracts: readonly GeminiDocumentExtract[],
  select: (extract: GeminiDocumentExtract) => string | undefined
): string | undefined {
  for (const extract of extracts) {
    const value = select(extract)?.trim();
    if (value) return value;
  }
  return undefined;
}

function lastObservedNumber(
  extracts: readonly GeminiDocumentExtract[],
  select: (extract: GeminiDocumentExtract) => number | undefined
): number | undefined {
  let zeroObserved = false;

  for (let index = extracts.length - 1; index >= 0; index -= 1) {
    const value = select(extracts[index]);
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      continue;
    }

    // I DTO Gemini legacy valorizzano i numeri mancanti con 0. In un merge
    // multipagina uno 0 di placeholder su una pagina successiva non deve
    // cancellare un importo positivo realmente osservato su una pagina
    // precedente. Lo zero resta comunque valido quando e' l'unico valore
    // numerico osservato nell'intero documento.
    if (value === 0) {
      zeroObserved = true;
      continue;
    }

    return value;
  }

  return zeroObserved ? 0 : undefined;
}

export function mergeGeminiDocumentExtracts(
  extracts: readonly GeminiDocumentExtract[]
): GeminiDocumentExtract {
  if (extracts.length === 0) {
    throw new Error('Nessuna pagina estratta');
  }

  const rawText = extracts
      .map((extract) => extract.rawText.trim())
      .filter(Boolean)
      .join('\n\n');
  const documentNumber = firstNonEmpty(
    extracts,
    (extract) => extract.documentNumber
  );
  const customerName = firstNonEmpty(
    extracts,
    (extract) => extract.customerName
  );
  const date = firstNonEmpty(extracts, (extract) => extract.date);
  const subtotal = lastObservedNumber(
    extracts,
    (extract) => extract.subtotal
  );
  const vatAmount = lastObservedNumber(
    extracts,
    (extract) => extract.vatAmount
  );
  const total = lastObservedNumber(extracts, (extract) => extract.total);
  const items = extracts.flatMap((extract) => extract.items ?? []);
  const structured = mergeAiStructuredDocuments(
    extracts.flatMap((extract) => extract.structured ? [extract.structured] : [])
  );

  return {
    rawText,
    ...(documentNumber !== undefined ? { documentNumber } : {}),
    ...(customerName !== undefined ? { customerName } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(subtotal !== undefined ? { subtotal } : {}),
    ...(vatAmount !== undefined ? { vatAmount } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(items.length > 0 ? { items } : {}),
    ...(structured ? { structured } : {}),
  };
}

function confidenceForPartialExtraction(
  current: Record<string, number>,
  rebuilt: Record<string, number>,
  fields: DocumentPageStructuredFields,
  numberKey: 'quoteNumber' | 'orderNumber' | 'documentNumber'
): Record<string, number> {
  const next = { ...rebuilt };
  const preserveWhenMissing = (
    key: string,
    fieldPresent: boolean
  ): void => {
    if (fieldPresent) return;
    if (current[key] !== undefined) next[key] = current[key];
    else delete next[key];
  };
  preserveWhenMissing(numberKey, !!fields.documentNumber);
  preserveWhenMissing('date', !!fields.date);
  preserveWhenMissing('customerName', !!fields.customerName);
  preserveWhenMissing('subtotal', fields.subtotal !== undefined);
  preserveWhenMissing('vatAmount', fields.vatAmount !== undefined);
  preserveWhenMissing('total', fields.total !== undefined);
  return next;
}

function hasOnlyCompleteItems(fields: DocumentPageStructuredFields): boolean {
  return (
    !!fields.items?.length &&
    fields.items.every(
      (item) =>
        !!item.description &&
        item.quantity !== undefined &&
        item.unitPrice !== undefined &&
        item.total !== undefined
    )
  );
}

/**
 * Il builder Gemini preesistente usa valori obbligatori. In una review
 * per-pagina parziale, i placeholder del DTO non devono cancellare dati giÃ 
 * validi del record corrente.
 */
export function preserveCurrentFieldsForPartialPageReview(
  current: AnyDocument,
  rebuilt: AnyDocument,
  fields: DocumentPageStructuredFields
): AnyDocument {
  if (current.type !== rebuilt.type || current.type === 'business_card') {
    return rebuilt;
  }

  switch (current.type) {
    case 'quote': {
      const candidate = rebuilt as QuoteDocument;
      const keepTitle =
        !fields.documentNumber && !fields.customerName && !fields.date;
      return {
        ...candidate,
        title: keepTitle ? current.title : candidate.title,
        quoteNumber: fields.documentNumber
          ? candidate.quoteNumber
          : current.quoteNumber,
        quoteDate: fields.date ? candidate.quoteDate : current.quoteDate,
        customerName: fields.customerName
          ? candidate.customerName
          : current.customerName,
        customerVat: current.customerVat,
        items: hasOnlyCompleteItems(fields) ? candidate.items : current.items,
        subtotal:
          fields.subtotal !== undefined
            ? candidate.subtotal
            : current.subtotal,
        vatAmount:
          fields.vatAmount !== undefined
            ? candidate.vatAmount
            : current.vatAmount,
        total: fields.total !== undefined ? candidate.total : current.total,
        currency: current.currency,
        confidence: confidenceForPartialExtraction(
          current.confidence,
          candidate.confidence,
          fields,
          'quoteNumber'
        ),
      };
    }
    case 'order': {
      const candidate = rebuilt as OrderDocument;
      const keepTitle =
        !fields.documentNumber && !fields.customerName && !fields.date;
      return {
        ...candidate,
        title: keepTitle ? current.title : candidate.title,
        orderNumber: fields.documentNumber
          ? candidate.orderNumber
          : current.orderNumber,
        orderDate: fields.date ? candidate.orderDate : current.orderDate,
        customerName: fields.customerName
          ? candidate.customerName
          : current.customerName,
        customerVat: current.customerVat,
        items: hasOnlyCompleteItems(fields) ? candidate.items : current.items,
        subtotal:
          fields.subtotal !== undefined
            ? candidate.subtotal
            : current.subtotal,
        vatAmount:
          fields.vatAmount !== undefined
            ? candidate.vatAmount
            : current.vatAmount,
        total: fields.total !== undefined ? candidate.total : current.total,
        currency: current.currency,
        confidence: confidenceForPartialExtraction(
          current.confidence,
          candidate.confidence,
          fields,
          'orderNumber'
        ),
      };
    }
    case 'invoice': {
      const candidate = rebuilt as InvoiceDocument;
      const keepTitle =
        !fields.documentNumber && !fields.customerName && !fields.date;
      return {
        ...candidate,
        title: keepTitle ? current.title : candidate.title,
        invoiceNumber: fields.documentNumber
          ? candidate.invoiceNumber
          : current.invoiceNumber,
        invoiceDate: fields.date ? candidate.invoiceDate : current.invoiceDate,
        customerName: fields.customerName
          ? candidate.customerName
          : current.customerName,
        customerVat: current.customerVat,
        items: hasOnlyCompleteItems(fields) ? candidate.items : current.items,
        subtotal:
          fields.subtotal !== undefined
            ? candidate.subtotal
            : current.subtotal,
        vatAmount:
          fields.vatAmount !== undefined
            ? candidate.vatAmount
            : current.vatAmount,
        total: fields.total !== undefined ? candidate.total : current.total,
        currency: current.currency,
        confidence: confidenceForPartialExtraction(
          current.confidence,
          candidate.confidence,
          fields,
          'documentNumber'
        ),
      };
    }
    case 'free_document': {
      const candidate = rebuilt as FreeDocument;
      const keepTitle = !fields.documentNumber && !fields.date;
      return {
        ...candidate,
        title: keepTitle ? current.title : candidate.title,
        documentNumber: fields.documentNumber
          ? candidate.documentNumber
          : current.documentNumber,
        documentDate: fields.date
          ? candidate.documentDate
          : current.documentDate,
        extractedFields: fields.extractedFields
          ? candidate.extractedFields
          : current.extractedFields,
        confidence: confidenceForPartialExtraction(
          current.confidence,
          candidate.confidence,
          fields,
          'documentNumber'
        ),
      };
    }
  }
}

/**
 * Flusso puro della revisione AI. Nessun salvataggio avviene qui:
 * il chiamante decide se e quando persistere il documento restituito.
 */
export async function runDocumentAiReview(
  decision: DocumentAiReviewDecision,
  currentDocument: AnyDocument,
  extractPage: DocumentAiPageExtractor,
  buildDocument: DocumentFromExtractBuilder,
  extractLocalPage?: LocalDocumentPageExtractor,
  structureLocalPage?: DocumentPageStructureBuilder,
  options?: DocumentAiReviewOptions
): Promise<DocumentAiReviewOutcome> {
  if (decision === 'cancel') {
    return { status: 'cancelled', document: currentDocument };
  }

  if (!options?.testOnlyBypassRcCloudAi && !isRcCloudAiEnabled()) {
    return {
      status: 'error',
      document: currentDocument,
      message: 'AI deferred for this release candidate',
    };
  }

  if (
    currentDocument.type === 'business_card' ||
    currentDocument.images.length === 0
  ) {
    return {
      status: 'error',
      document: currentDocument,
      message: 'Il documento non contiene pagine elaborabili',
    };
  }
  if (
    currentDocument.images.length > MAX_CLOUD_DOCUMENT_PAGES &&
    !extractLocalPage
  ) {
    return {
      status: 'error',
      document: currentDocument,
      message: `Il limite cloud Ã¨ di ${MAX_CLOUD_DOCUMENT_PAGES} pagine`,
    };
  }

  try {
    let mergedExtract: GeminiDocumentExtract;
    let pageExtractions: PageExtractionResult[] | undefined;
    let aggregatedFields: DocumentPageStructuredFields | undefined;
    let fieldMerge: DocumentFieldMergeResult | undefined;

    if (extractLocalPage) {
      const batch = await extractCloudPagesWithLocalFallback(
        currentDocument.type,
        currentDocument.images,
        extractPage,
        extractLocalPage,
        structureLocalPage,
        { abortOnCloudError: false }
      );
      if (batch.status === 'not_configured') {
        return { status: 'not_configured', document: currentDocument };
      }
      if (batch.status === 'credits_exhausted') {
        return {
          status: 'error',
          document: currentDocument,
          message: 'Crediti AI esauriti',
          reason: 'credits_exhausted',
        };
      }
      if (batch.status === 'error') {
        return {
          status: 'error',
          document: currentDocument,
          message: batch.message,
          reason:
            batch.reason === 'provider_unavailable'
              ? 'provider_unavailable'
              : 'invalid_request',
        };
      }

      pageExtractions = batch.results;
      fieldMerge = mergeDocumentPageFields(pageExtractions);
      const successfulTextAvailable = pageExtractions.some(
        (page) =>
          page.duplicateOf === undefined &&
          page.processingMethod !== 'failed' &&
          page.completed &&
          !!page.rawText.trim()
      );
      if (!successfulTextAvailable) {
        const failedPageTextAvailable = pageExtractions.some(
          (page) =>
            page.duplicateOf === undefined &&
            !!page.rawText.trim()
        );
        const tracedCurrentDocument = applyDocumentFieldMerge(
          currentDocument,
          fieldMerge,
          {
            mode: 'preserve_existing',
            currentDocument,
          }
        );
        const reviewableDocument = {
          ...tracedCurrentDocument,
          pageExtractions,
          ocrQuality: aggregateOcrQuality(
            pageExtractions
              .filter((page) => page.duplicateOf === undefined)
              .map((page) => page.ocrQuality)
          ),
          rawText: failedPageTextAvailable
            ? fieldMerge.rawText
            : currentDocument.rawText,
        } as AnyDocument;
        return {
          status: 'error',
          document: reviewableDocument,
          message: 'Nessuna pagina ha restituito testo leggibile',
        };
      }
      mergedExtract = fieldMergeToGeminiExtract(fieldMerge);
      const structured = mergeAiStructuredDocuments(
        pageExtractions.flatMap((page) => page.aiStructured ? [page.aiStructured] : [])
      );
      if (structured) mergedExtract.structured = structured;
      aggregatedFields = mergeResultToStructuredFields(fieldMerge);
    } else {
      // CompatibilitÃ  Fase 1A: senza fallback esplicito il flusso conserva il
      // precedente comportamento fail-safe e non applica risultati parziali.
      const extracts: GeminiDocumentExtract[] = [];

      for (
        let pageIndex = 0;
        pageIndex < currentDocument.images.length;
        pageIndex += 1
      ) {
        const imageUri = currentDocument.images[pageIndex];
        const outcome = await extractPage(
          imageUri,
          pageIndex,
          currentDocument.images.length
        );
        if (outcome.status === 'not_configured') {
          return { status: 'not_configured', document: currentDocument };
        }
        if (outcome.status === 'error') {
          return {
            status: 'error',
            document: currentDocument,
            message: outcome.message,
            reason: 'provider_unavailable',
          };
        }
        if (outcome.status === 'credits_exhausted') {
          return {
            status: 'error',
            document: currentDocument,
            message: 'Crediti AI esauriti',
            reason: 'credits_exhausted',
          };
        }
        extracts.push(outcome.extract);
      }

      mergedExtract = mergeGeminiDocumentExtracts(extracts);
      if (!mergedExtract.rawText.trim()) {
        return {
          status: 'error',
          document: currentDocument,
          message: 'Il supporto AI non ha restituito testo',
        };
      }
    }

    const builtDocument = buildDocument(
      currentDocument.type,
      mergedExtract,
      fieldMerge ? { exactStructuredFields: true } : undefined
    );
    if (builtDocument.type !== currentDocument.type) {
      return {
        status: 'error',
        document: currentDocument,
        message: 'Tipo documento non coerente',
      };
    }
    let rebuilt = aggregatedFields
      ? preserveCurrentFieldsForPartialPageReview(
          currentDocument,
          builtDocument,
          aggregatedFields
        )
      : builtDocument;
    if (fieldMerge) {
      rebuilt = applyDocumentFieldMerge(rebuilt, fieldMerge, {
        mode: 'preserve_existing',
        currentDocument,
      });
    }

    const notes = 'notes' in currentDocument
      ? { notes: currentDocument.notes }
      : {};
    const reviewedOcrQuality = pageExtractions
      ? aggregateOcrQuality(
          pageExtractions
            .filter((page) => page.duplicateOf === undefined)
            .map((page) => page.ocrQuality)
        )
      : assessOcrQuality([], mergedExtract.rawText, {
          confidenceType: 'unknown',
          recognizedFieldCount: Math.max(
            0,
            Object.keys(mergedExtract).length - 1
          ),
          source: 'cloud',
        });
    const candidate = {
      ...currentDocument,
      ...rebuilt,
      ...notes,
      id: currentDocument.id,
      images: currentDocument.images,
      ...(pageExtractions ? { pageExtractions } : {}),
      ocrQuality: reviewedOcrQuality,
      createdAt: currentDocument.createdAt,
      updatedAt: currentDocument.updatedAt,
    } as AnyDocument;

    return { status: 'ok', document: candidate, aiExtract: mergedExtract };
  } catch (error) {
    return {
      status: 'error',
      document: currentDocument,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}


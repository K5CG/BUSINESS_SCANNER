export type DocumentProcessStage =
  | 'prepare'
  | 'ocr'
  | 'page_results'
  | 'layout'
  | 'metadata'
  | 'items_totals'
  | 'reconciliation'
  | 'fallback'
  | 'persist'
  | 'done';

export type DocumentProcessProgress = {
  stage: DocumentProcessStage;
  percent: number;
  messageKey: string;
  messageParams?: Record<string, string | number>;
  slow?: boolean;
};

export type DocumentProcessResult = 'success' | 'partial_success' | 'ocr_insufficient';

export type DocumentProcessProgressListener = (progress: DocumentProcessProgress) => void;

const STAGE_PERCENT: Record<DocumentProcessStage, number> = {
  prepare: 5,
  ocr: 10,
  page_results: 35,
  layout: 42,
  // 65% is emitted after language, at parties/metadata. A freeze here means
  // identity + items/totals are still running — not a fake animation stall.
  metadata: 60,
  items_totals: 72,
  reconciliation: 87,
  fallback: 90,
  persist: 94,
  done: 100,
};

const STAGE_MESSAGE: Record<DocumentProcessStage, string> = {
  prepare: 'processing.prepare',
  ocr: 'processing.ocr',
  page_results: 'processing.pageResults',
  layout: 'processing.layout',
  metadata: 'processing.metadata',
  items_totals: 'processing.itemsTotals',
  reconciliation: 'processing.reconcile',
  fallback: 'processing.fallback',
  persist: 'processing.persist',
  done: 'processing.done',
};

const OCR_START = STAGE_PERCENT.ocr;
const OCR_END = STAGE_PERCENT.page_results;

export function createDocumentProcessProgressReporter(
  listener?: DocumentProcessProgressListener,
  options?: { slowAfterMs?: number; startedAt?: number },
) {
  const startedAt = options?.startedAt ?? Date.now();
  const slowAfterMs = options?.slowAfterMs ?? 8_000;
  let lastPercent = 0;

  const emit = (stage: DocumentProcessStage, percent?: number, slow?: boolean) => {
    const resolved = Math.max(
      lastPercent,
      percent ?? STAGE_PERCENT[stage],
    );
    lastPercent = Math.min(100, resolved);
    listener?.({
      stage,
      percent: lastPercent,
      messageKey: slow ? 'processing.slow' : STAGE_MESSAGE[stage],
      ...(slow ? { slow: true } : {}),
    });
  };

  const emitOcrPage = (pageIndex: number, pageCount: number) => {
    if (pageCount <= 0) {
      emit('ocr', OCR_START);
      return;
    }
    const span = OCR_END - OCR_START;
    const fraction = (pageIndex + 1) / pageCount;
    const percent = OCR_START + span * fraction;
    lastPercent = Math.max(lastPercent, Math.min(100, percent));
    listener?.({
      stage: 'ocr',
      percent: lastPercent,
      messageKey: 'processing.ocrPage',
      messageParams: { current: pageIndex + 1, total: pageCount },
    });
  };

  const maybeSlow = () => {
    if (Date.now() - startedAt >= slowAfterMs && lastPercent < 100) {
      listener?.({
        stage: 'layout',
        percent: lastPercent,
        messageKey: 'processing.slow',
        slow: true,
      });
    }
  };

  return {
    prepare: () => emit('prepare'),
    ocrPage: emitOcrPage,
    pageResults: () => emit('page_results'),
    layout: () => emit('layout'),
    metadata: () => emit('metadata'),
    itemsTotals: () => emit('items_totals'),
    reconciliation: () => emit('reconciliation'),
    fallback: () => emit('fallback', STAGE_PERCENT.fallback),
    persist: () => emit('persist'),
    done: () => emit('done', 100),
    maybeSlow,
    get lastPercent() {
      return lastPercent;
    },
  };
}

export function classifyDocumentProcessResult(input: {
  ocrWorked: boolean;
  rawTextLength: number;
  structuredExtraction?: {
    complete?: boolean;
    requiresRescan?: boolean;
    requiresReview?: boolean;
    reasons?: readonly string[];
  };
}): DocumentProcessResult {
  const reasons = input.structuredExtraction?.reasons ?? [];
  if (
    !input.ocrWorked
    || input.rawTextLength < 10
    || reasons.includes('structured_extraction_insufficient_ocr')
    || (input.structuredExtraction?.requiresRescan && input.rawTextLength < 40)
  ) {
    return 'ocr_insufficient';
  }
  if (
    input.structuredExtraction?.complete
    && !input.structuredExtraction.requiresReview
    && !reasons.some((reason) =>
      reason.includes('timeout')
      || reason.includes('semantic_fallback')
      || reason.includes('partial')
      || reason === 'structured_language_timeout')
  ) {
    return 'success';
  }
  return 'partial_success';
}

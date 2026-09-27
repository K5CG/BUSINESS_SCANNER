import type { StructuredDocumentExtraction } from './document-structure';
import { logDocumentProcess } from './document-process-log';

export const SINGLE_PAGE_STRUCTURED_WARN_MS = 8_000;
export const SINGLE_PAGE_STRUCTURED_HARD_MS = 15_000;
export const MULTI_PAGE_STRUCTURED_WARN_MS = 15_000;
export const MULTI_PAGE_STRUCTURED_HARD_MS = 30_000;

export function structuredDeadlineMs(pageCount: number): number {
  return pageCount <= 1 ? SINGLE_PAGE_STRUCTURED_HARD_MS : MULTI_PAGE_STRUCTURED_HARD_MS;
}

export function structuredWarningMs(pageCount: number): number {
  return pageCount <= 1 ? SINGLE_PAGE_STRUCTURED_WARN_MS : MULTI_PAGE_STRUCTURED_WARN_MS;
}

export function createStructuredTimeoutFallback(
  reason = 'structured_extraction_timeout',
): StructuredDocumentExtraction {
  return {
    schemaVersion: 1,
    metadata: {},
    items: [],
    summary: { taxSummaries: [], conflicts: [], requiresReview: true },
    conditions: {},
    pages: [],
    complete: false,
    requiresRescan: false,
    requiresReview: true,
    reasons: [reason],
  };
}

export async function runWithProcessingWatchdog<T>(
  label: string,
  pageCount: number,
  task: () => Promise<T>,
  onTimeout: () => T,
): Promise<T> {
  const warnMs = structuredWarningMs(pageCount);
  const hardMs = structuredDeadlineMs(pageCount);
  let warned = false;
  const warnTimer = setTimeout(() => {
    warned = true;
    logDocumentProcess('watchdog_warning', { label, pageCount, warnMs });
  }, warnMs);

  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardPromise = new Promise<T>((resolve) => {
    hardTimer = setTimeout(() => {
      logDocumentProcess('watchdog_timeout', { label, pageCount, hardMs, warned });
      resolve(onTimeout());
    }, hardMs);
  });

  try {
    return await Promise.race([task(), hardPromise]);
  } finally {
    clearTimeout(warnTimer);
    if (hardTimer !== undefined) clearTimeout(hardTimer);
  }
}

export const SINGLE_PAGE_PROCESS_BUDGET_MS = 10_000;
export const SINGLE_PAGE_PROCESS_HARD_MS = 10_000;
export const TWO_PAGE_PROCESS_HARD_MS = 15_000;
export const PAGE_RESULTS_BUDGET_MS = 2_000;
export const MIN_HEAVY_STAGE_REMAINING_MS = 900;

export function createScanProcessDeadline(pageCount: number): number {
  const hardMs = pageCount <= 1
    ? SINGLE_PAGE_PROCESS_HARD_MS
    : TWO_PAGE_PROCESS_HARD_MS;
  return Date.now() + hardMs;
}

/** Structured parse clock. Independent of OCR so leftover scan time cannot starve parties/items. */
export function createStructuredProcessDeadline(pageCount: number): number {
  return createScanProcessDeadline(pageCount);
}

/** Test/replay helper: shared scan clock after simulated OCR consumption. */
export function createSharedScanDeadlineAfterOcr(pageCount: number, ocrConsumedMs: number): number {
  return createScanProcessDeadline(pageCount) - Math.max(0, ocrConsumedMs);
}

export function processDeadlineExceeded(deadline?: number): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

export function processDeadlineRemainingMs(deadline?: number): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - Date.now());
}

export function canStartHeavyStage(
  deadline?: number,
  minRemainingMs = MIN_HEAVY_STAGE_REMAINING_MS,
): boolean {
  if (deadline === undefined) return true;
  return deadline - Date.now() >= minRemainingMs;
}

export function pageResultsDeadline(deadline?: number): number {
  const pageBudget = Date.now() + PAGE_RESULTS_BUDGET_MS;
  if (deadline === undefined) return pageBudget;
  return Math.min(pageBudget, deadline);
}

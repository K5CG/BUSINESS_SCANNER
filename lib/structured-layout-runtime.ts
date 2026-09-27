declare const __DEV__: boolean | undefined;

import { isDevLogEnabled } from './release-diagnostics';

function devWarn(tag: string, step: string, detail?: Record<string, unknown>): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[${tag}] ${step}${suffix}`);
}

export const STRUCTURED_LAYOUT_DEADLINE_MS = 5_000;
/** Per-stage loop guard — caps pathological inner loops, not normal structured target. */
export const STRUCTURED_LAYOUT_STAGE_BUDGET_MS = 1_500;
export const TABLE_BAND_BUDGET_MS = 750;
export const REGIONS_BUDGET_MS = 750;
export const TABLE_PRECHECK_BUDGET_MS = 100;
export const CLASSIFY_LINES_CHECK_EVERY = 16;
export const MAX_LAYOUT_LINES = 256;
export const MAX_GEOMETRIC_SIGNALS = 48;
export const MAX_GEOMETRIC_GROUPS = 8;
export const MAX_PAIR_COMPARISONS = 512;
export const MAX_CLUSTER_ITERATIONS = 64;

export class StructuredLayoutTimeoutError extends Error {
  readonly reason = 'structured_layout_timeout' as const;

  constructor(message = 'STRUCTURED_LAYOUT_TIMEOUT') {
    super(message);
    this.name = 'StructuredLayoutTimeoutError';
  }
}

export function createLayoutDeadline(
  budgetMs = STRUCTURED_LAYOUT_DEADLINE_MS,
): number {
  return Date.now() + budgetMs;
}

export function layoutDeadlineExceeded(deadline?: number): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

export function resolveEffectiveDeadline(options: {
  started: number;
  layoutBudgetMs?: number;
  processDeadline?: number;
  localBudgetMs?: number;
}): number {
  const candidates = [
    options.started + (options.layoutBudgetMs ?? STRUCTURED_LAYOUT_DEADLINE_MS),
  ];
  if (options.processDeadline !== undefined) candidates.push(options.processDeadline);
  if (options.localBudgetMs !== undefined) candidates.push(options.started + options.localBudgetMs);
  return Math.min(...candidates);
}

export function remainingLayoutMs(processDeadline?: number): number | undefined {
  if (processDeadline === undefined) return undefined;
  return Math.max(0, processDeadline - Date.now());
}

export function logStructuredLayout(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[StructuredLayout] ${step}${suffix}`);
}

export function logStructuredLayoutPerf(
  step: string,
  ms: number,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[StructuredLayoutPerf] ${step} ms=${ms}${suffix}`);
}

export function logTableBandPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[TableBandPerf] ${step}${suffix}`);
}

export function logRegionPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[RegionPerf] ${step}${suffix}`);
}

export function logClassifyPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[ClassifyPerf] ${step}${suffix}`);
}

export function logMetadataPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[MetadataPerf] ${step}${suffix}`);
}

export const METADATA_CHECK_EVERY = 16;

export function logItemsPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[ItemsPerf] ${step}${suffix}`);
}

export function logTotalsPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[TotalsPerf] ${step}${suffix}`);
}

export function logItemsTotalsPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[ItemsTotalsPerf] ${step}${suffix}`);
}

export function logItemsCallPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[ItemsCallPerf] ${step}${suffix}`);
}

export function logItemsPostPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[ItemsPostPerf] ${step}${suffix}`);
}

export function logTableHeadersPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  if (!isDevLogEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[TableHeadersPerf] ${step}${suffix}`);
}

export function logItemsZonePerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  devWarn('ItemsZonePerf', step, detail);
}

export function logRowGroupPerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  devWarn('RowGroupPerf', step, detail);
}

export function logRowPrePerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  devWarn('RowPrePerf', step, detail);
}

export function logItemParsePerf(
  step: string,
  detail?: Record<string, unknown>,
): void {
  devWarn('ItemParsePerf', step, detail);
}

export function logSummaryPerf(step: string, detail?: Record<string, unknown>): void {
  devWarn('SummaryPerf', step, detail);
}

export const ITEMS_CHECK_EVERY = 16;

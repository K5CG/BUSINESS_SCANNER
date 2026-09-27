import { isQaDocumentLoggingEnabled } from './qa-document-logging';

export type DocumentProcessPerfStage =
  | 'ocr_input_preparation'
  | 'language_detection'
  | 'page_layout_normalization'
  | 'table_zone_detection'
  | 'header_column_detection'
  | 'row_band_clustering'
  | 'item_candidate_generation'
  | 'multiline_description_merge'
  | 'numeric_repair'
  | 'item_validation'
  | 'item_prune_drop'
  | 'totals_candidate_extraction'
  | 'totals_semantic_ranking'
  | 'parties_metadata_extraction'
  | 'international_value_parsing'
  | 'monetary_guardrails'
  | 'semantic_fallback'
  | 'semantic_overlay'
  | 'consistency_completeness'
  | 'canonical_merge'
  | 'persistence_mapping'
  | 'items_and_totals'
  | 'items_retry'
  | 'build_items_context';

export type DocumentProcessPerfExtra = {
  pageIndex?: number;
  inputLineCount?: number;
  outputCandidateCount?: number;
  deadlineRemainingMs?: number;
  [key: string]: unknown;
};

export type DocumentProcessPerfEntry = {
  stage: string;
  durationMs: number;
  elapsedTotalMs: number;
  pageIndex?: number;
  inputLineCount?: number;
  outputCandidateCount?: number;
  deadlineRemainingMs?: number;
};

export type DocumentProcessPerfReport = {
  startedAt: number;
  totalMs: number;
  stages: DocumentProcessPerfEntry[];
  counters: Record<string, number>;
};

type OpenStage = {
  stage: string;
  startedAt: number;
  extra?: DocumentProcessPerfExtra;
};

const shouldLog = (): boolean => isQaDocumentLoggingEnabled();

let processStarted = 0;
const open = new Map<string, OpenStage>();
const stages: DocumentProcessPerfEntry[] = [];
const counters: Record<string, number> = {};

function elapsedTotalMs(): number {
  return processStarted ? Date.now() - processStarted : 0;
}

function logPerf(event: 'stage_start' | 'stage_end', payload: Record<string, unknown>): void {
  if (!shouldLog()) return;
  console.warn(`[DocumentStagePerf] ${event} ${JSON.stringify(payload)}`);
}

export function startDocumentProcessPerf(startedAt = Date.now()): void {
  processStarted = startedAt;
  open.clear();
  stages.length = 0;
  for (const key of Object.keys(counters)) delete counters[key];
}

export function countDocumentProcessPerf(name: string, n = 1): void {
  counters[name] = (counters[name] ?? 0) + n;
}

export function documentProcessPerfStageStart(stage: string, extra?: DocumentProcessPerfExtra): void {
  if (!processStarted) startDocumentProcessPerf();
  open.set(stage, { stage, startedAt: Date.now(), extra });
  logPerf('stage_start', {
    stage,
    elapsedTotalMs: elapsedTotalMs(),
    ...extra,
  });
}

export function documentProcessPerfStageEnd(stage: string, extra?: DocumentProcessPerfExtra): void {
  const current = open.get(stage);
  const endedAt = Date.now();
  const durationMs = current ? endedAt - current.startedAt : 0;
  const merged = { ...current?.extra, ...extra };
  open.delete(stage);
  const entry: DocumentProcessPerfEntry = {
    stage,
    durationMs,
    elapsedTotalMs: elapsedTotalMs(),
    ...(merged.pageIndex !== undefined ? { pageIndex: Number(merged.pageIndex) } : {}),
    ...(merged.inputLineCount !== undefined ? { inputLineCount: Number(merged.inputLineCount) } : {}),
    ...(merged.outputCandidateCount !== undefined ? { outputCandidateCount: Number(merged.outputCandidateCount) } : {}),
    ...(merged.deadlineRemainingMs !== undefined ? { deadlineRemainingMs: Number(merged.deadlineRemainingMs) } : {}),
  };
  stages.push(entry);
  logPerf('stage_end', {
    stage,
    durationMs,
    elapsedTotalMs: entry.elapsedTotalMs,
    ...(entry.pageIndex !== undefined ? { pageIndex: entry.pageIndex } : {}),
    ...(entry.inputLineCount !== undefined ? { inputLineCount: entry.inputLineCount } : {}),
    ...(entry.outputCandidateCount !== undefined ? { outputCandidateCount: entry.outputCandidateCount } : {}),
    ...(entry.deadlineRemainingMs !== undefined ? { deadlineRemainingMs: entry.deadlineRemainingMs } : {}),
  });
}

export function measureDocumentProcessPerf<T>(
  stage: string,
  extra: DocumentProcessPerfExtra | undefined,
  work: () => T,
): T {
  documentProcessPerfStageStart(stage, extra);
  try {
    return work();
  } finally {
    documentProcessPerfStageEnd(stage, extra);
  }
}

export function getDocumentProcessPerfReport(): DocumentProcessPerfReport {
  return {
    startedAt: processStarted,
    totalMs: elapsedTotalMs(),
    stages: [...stages],
    counters: { ...counters },
  };
}

export function formatDocumentProcessPerfTable(report = getDocumentProcessPerfReport()): string {
  const rows = report.stages.map((entry) =>
    `${entry.stage.padEnd(32)} ${String(entry.durationMs).padStart(7)}ms  elapsed=${String(entry.elapsedTotalMs).padStart(7)}ms`
    + (entry.inputLineCount !== undefined ? `  lines=${entry.inputLineCount}` : '')
    + (entry.outputCandidateCount !== undefined ? `  out=${entry.outputCandidateCount}` : '')
    + (entry.deadlineRemainingMs !== undefined ? `  remain=${entry.deadlineRemainingMs}` : ''));
  const counts = Object.entries(report.counters)
    .sort((left, right) => right[1] - left[1])
    .map(([name, value]) => `  ${name}=${value}`);
  return [
    `totalMs=${report.totalMs}`,
    ...rows,
    ...(counts.length ? ['counters:', ...counts] : []),
  ].join('\n');
}

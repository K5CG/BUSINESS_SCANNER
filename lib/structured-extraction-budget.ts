import {
  SINGLE_PAGE_PROCESS_HARD_MS,
  TWO_PAGE_PROCESS_HARD_MS,
} from './scan-process-deadline';

export interface StructuredBudgetInput {
  pageCount: number;
  lineCount: number;
  tableSignalCount?: number;
  processDeadline?: number;
}

/** Target structured-work budget from document size — not a pathological loop cap. */
export function computeAdaptiveStructuredBudget(input: StructuredBudgetInput): number {
  const linesPerPage = input.pageCount > 0
    ? Math.ceil(input.lineCount / input.pageCount)
    : input.lineCount;
  let targetMs: number;
  if (linesPerPage <= 60) targetMs = 3_000;
  else if (linesPerPage <= 120) targetMs = 4_000;
  else if (linesPerPage <= 180) targetMs = 5_000;
  else targetMs = 6_000;

  const signals = input.tableSignalCount ?? 0;
  if (signals >= 8) targetMs += 500;
  else if (signals >= 4) targetMs += 250;

  if (input.pageCount > 1) {
    targetMs += (input.pageCount - 1) * 2_000;
  }

  const hardCeiling = input.pageCount <= 1
    ? SINGLE_PAGE_PROCESS_HARD_MS - 2_000
    : TWO_PAGE_PROCESS_HARD_MS - 3_000;
  targetMs = Math.min(targetMs, hardCeiling);

  if (input.processDeadline !== undefined) {
    const remaining = Math.max(0, input.processDeadline - Date.now());
    targetMs = Math.min(targetMs, remaining);
  }

  return Math.max(1_500, targetMs);
}

export function estimateTableSignalCount(
  inputs: readonly { lines: readonly { text: string }[] }[],
): number {
  let count = 0;
  for (const input of inputs) {
    for (const line of input.lines) {
      if (line.text.length > 36) continue;
      if (/\b(?:codice|descrizione|q\.?ta|quantit|qty|prezzo|price|importo|totale riga|unit price|description|menge|amount)\b/i.test(line.text)) {
        count += 1;
      }
    }
  }
  return count;
}

export function layoutBudgetForPage(input: {
  pageLineCount: number;
  pageCount: number;
  tableSignalCount?: number;
  processDeadline?: number;
  remainingProcessMs?: number;
}): number {
  const adaptive = computeAdaptiveStructuredBudget({
    pageCount: input.pageCount,
    lineCount: input.pageLineCount,
    tableSignalCount: input.tableSignalCount,
    processDeadline: input.processDeadline,
  });
  if (input.remainingProcessMs === undefined) return adaptive;
  return Math.min(adaptive, Math.max(900, input.remainingProcessMs - 400));
}

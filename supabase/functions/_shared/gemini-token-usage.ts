/**
 * Passive Gemini token metering — numbers only, never document contents.
 * Does not alter prompts, generation config, models, or credit policy.
 */

export type GeminiProviderCallType =
  | 'card_structure'
  | 'document_extract'
  | 'pdf_summary'
  | 'pdf_items'
  | 'pdf_aggregate';

export type GeminiMeterOperationType =
  | 'business_card_ai'
  | 'document_page_ai'
  | 'pdf_page_ai'
  | 'document_reprocess';

export interface GeminiTokenUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

export interface GeminiTokenUsageCallReport extends GeminiTokenUsage {
  callType: GeminiProviderCallType;
}

export interface GeminiTokenUsageReport {
  model: string;
  operationType: GeminiMeterOperationType;
  pageCount: number;
  creditsCharged: number;
  calls: GeminiTokenUsageCallReport[];
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 50_000_000) return undefined;
  return value;
}

/** Extract usageMetadata from a Gemini generateContent JSON payload. */
export function parseGeminiUsageMetadata(payload: unknown): GeminiTokenUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usageMetadata)) return undefined;
  const meta = payload.usageMetadata;
  const usage: GeminiTokenUsage = {};
  const prompt = readNonNegInt(meta.promptTokenCount);
  const candidates = readNonNegInt(meta.candidatesTokenCount);
  const total = readNonNegInt(meta.totalTokenCount);
  const cached = readNonNegInt(meta.cachedContentTokenCount);
  const thoughts =
    readNonNegInt(meta.thoughtsTokenCount) ?? readNonNegInt(meta.thinkingTokens);

  if (prompt !== undefined) usage.promptTokenCount = prompt;
  if (candidates !== undefined) usage.candidatesTokenCount = candidates;
  if (total !== undefined) usage.totalTokenCount = total;
  if (cached !== undefined) usage.cachedContentTokenCount = cached;
  if (thoughts !== undefined) usage.thoughtsTokenCount = thoughts;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function sumOptional(
  values: Array<number | undefined>
): number | undefined {
  let sum = 0;
  let seen = false;
  for (const value of values) {
    if (value === undefined) continue;
    sum += value;
    seen = true;
  }
  return seen ? sum : undefined;
}

export function aggregateGeminiTokenUsage(
  parts: Array<GeminiTokenUsage | undefined>
): GeminiTokenUsage | undefined {
  const usage: GeminiTokenUsage = {};
  const prompt = sumOptional(parts.map((p) => p?.promptTokenCount));
  const candidates = sumOptional(parts.map((p) => p?.candidatesTokenCount));
  const total = sumOptional(parts.map((p) => p?.totalTokenCount));
  const cached = sumOptional(parts.map((p) => p?.cachedContentTokenCount));
  const thoughts = sumOptional(parts.map((p) => p?.thoughtsTokenCount));
  if (prompt !== undefined) usage.promptTokenCount = prompt;
  if (candidates !== undefined) usage.candidatesTokenCount = candidates;
  if (total !== undefined) usage.totalTokenCount = total;
  if (cached !== undefined) usage.cachedContentTokenCount = cached;
  if (thoughts !== undefined) usage.thoughtsTokenCount = thoughts;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function buildGeminiTokenUsageReport(input: {
  model: string;
  operationType: GeminiMeterOperationType;
  pageCount: number;
  creditsCharged: number;
  calls: GeminiTokenUsageCallReport[];
}): GeminiTokenUsageReport {
  const aggregate = aggregateGeminiTokenUsage(input.calls);
  return {
    model: input.model,
    operationType: input.operationType,
    pageCount: Math.max(1, Math.min(input.pageCount, 100)),
    creditsCharged: Math.max(0, Math.min(input.creditsCharged, 100_000)),
    calls: input.calls,
    ...(aggregate ?? {}),
  };
}

/**
 * Privacy-safe diagnostic object for logs / probe output.
 * Never includes document text, PII, keys, or raw provider payloads.
 */
export function toSafeTokenUsageDiagnostic(
  report: GeminiTokenUsageReport
): Record<string, string | number | Record<string, string | number>[]> {
  return {
    operationType: report.operationType,
    model: report.model,
    pageCount: report.pageCount,
    creditsCharged: report.creditsCharged,
    promptTokens: report.promptTokenCount ?? 0,
    outputTokens: report.candidatesTokenCount ?? 0,
    totalTokens: report.totalTokenCount ?? 0,
    ...(report.cachedContentTokenCount !== undefined
      ? { cachedTokens: report.cachedContentTokenCount }
      : {}),
    ...(report.thoughtsTokenCount !== undefined
      ? { thoughtsTokens: report.thoughtsTokenCount }
      : {}),
    calls: report.calls.map((call) => ({
      callType: call.callType,
      promptTokens: call.promptTokenCount ?? 0,
      outputTokens: call.candidatesTokenCount ?? 0,
      totalTokens: call.totalTokenCount ?? 0,
      ...(call.cachedContentTokenCount !== undefined
        ? { cachedTokens: call.cachedContentTokenCount }
        : {}),
      ...(call.thoughtsTokenCount !== undefined
        ? { thoughtsTokens: call.thoughtsTokenCount }
        : {}),
    })),
  };
}

/** Official paid-tier rates (USD / 1M tokens) as of 2026-08-12 — source: ai.google.dev/gemini-api/docs/pricing */
export const GEMINI_PAID_RATES_USD_PER_MTK_2026_08_12 = {
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'gemini-3.6-flash': { input: 1.5, output: 7.5 },
} as const;

export type PricedGeminiModel = keyof typeof GEMINI_PAID_RATES_USD_PER_MTK_2026_08_12;

export function estimateGeminiCostUsd(input: {
  model: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}): { inputUsd: number; outputUsd: number; totalUsd: number } | null {
  const rates =
    GEMINI_PAID_RATES_USD_PER_MTK_2026_08_12[
      input.model as PricedGeminiModel
    ];
  if (!rates) return null;
  const prompt = input.promptTokenCount ?? 0;
  const output = input.candidatesTokenCount ?? 0;
  const inputUsd = (prompt / 1_000_000) * rates.input;
  const outputUsd = (output / 1_000_000) * rates.output;
  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
  };
}

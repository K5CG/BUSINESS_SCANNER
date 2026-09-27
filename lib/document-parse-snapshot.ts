export const CANONICAL_SNAPSHOT_STAGES = [
  'normalized_ocr',
  'language',
  'layout',
  'zones',
  'party_candidates',
  'issuer_candidates',
  'customer_candidates',
  'date_candidates',
  'table_headers',
  'column_semantics',
  'row_bands',
  'item_candidates',
  'selected_items',
  'totals_candidates',
  'selected_gross',
  'selected_discount',
  'selected_net_taxable',
  'selected_vat',
  'selected_grand_total',
  'document_number',
  'canonical_result',
  'persistence_input',
] as const;

export type CanonicalSnapshotStage = (typeof CANONICAL_SNAPSHOT_STAGES)[number];

export interface CanonicalStageRecord {
  stage: CanonicalSnapshotStage;
  hash: string;
  output: unknown;
}

export interface CanonicalStageTiming {
  stage: string;
  durationMs: number;
}

export interface CanonicalParseSnapshot {
  runtime: 'node' | 'hermes' | 'unknown';
  input: {
    pageCount: number;
    ocrLineCount: number;
    geometryCount: number;
    documentType: string;
    deadlineMode: 'production' | 'unlimited';
  };
  stages: CanonicalStageRecord[];
  stageTimings?: CanonicalStageTiming[];
  firstDifferingStage?: CanonicalSnapshotStage;
}

const IRRELEVANT_KEY = /(?:timestamp|createdAt|updatedAt|elapsed|durationMs|ms|uuid|id|operationId|deadlineRemaining|reasons|timeoutReason|requiresReview|conflicts)/i;

export function stableCanonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(stripIrrelevant(value)));
}

export function hashCanonicalValue(value: unknown): string {
  return fallbackHash(stableCanonicalJson(value));
}

export function recordStage(stage: CanonicalSnapshotStage, output: unknown): CanonicalStageRecord {
  return { stage, hash: hashCanonicalValue(output), output };
}

export const SEMANTIC_PARITY_STAGES: readonly CanonicalSnapshotStage[] = [
  'language',
  'issuer_candidates',
  'customer_candidates',
  'date_candidates',
  'selected_items',
  'selected_gross',
  'selected_discount',
  'selected_net_taxable',
  'selected_vat',
  'selected_grand_total',
  'document_number',
  'canonical_result',
  'persistence_input',
];

export function firstDifferingStage(
  left: CanonicalParseSnapshot,
  right: CanonicalParseSnapshot,
  stages: readonly CanonicalSnapshotStage[] = CANONICAL_SNAPSHOT_STAGES,
): CanonicalSnapshotStage | undefined {
  const rightByStage = new Map(right.stages.map((entry) => [entry.stage, entry]));
  for (const stage of stages) {
    const a = left.stages.find((entry) => entry.stage === stage);
    const b = rightByStage.get(stage);
    if (!a || !b) return stage;
    if (a.hash !== b.hash) return stage;
  }
  return undefined;
}

export function firstSemanticDifferingStage(
  left: CanonicalParseSnapshot,
  right: CanonicalParseSnapshot,
): CanonicalSnapshotStage | undefined {
  return firstDifferingStage(left, right, SEMANTIC_PARITY_STAGES);
}

function stripIrrelevant(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIrrelevant);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (IRRELEVANT_KEY.test(key)) continue;
    out[key] = stripIrrelevant(entry);
  }
  return out;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}

function fallbackHash(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type FieldQuality = 'EMPTY' | 'INVALID' | 'WEAK' | 'COHERENT' | 'STRONG';

const RANK: Record<FieldQuality, number> = {
  EMPTY: 0,
  INVALID: 1,
  WEAK: 2,
  COHERENT: 3,
  STRONG: 4,
};

export function fieldQualityRank(quality: FieldQuality): number {
  return RANK[quality];
}

export function classifyTextFieldQuality(
  value: string | null | undefined,
  options?: { invalid?: boolean; strong?: boolean; weak?: boolean },
): FieldQuality {
  const text = value?.trim() ?? '';
  if (!text) return 'EMPTY';
  if (options?.invalid) return 'INVALID';
  if (options?.strong) return 'STRONG';
  if (options?.weak) return 'WEAK';
  return 'COHERENT';
}

export function classifyNumericFieldQuality(
  value: number | null | undefined,
  options?: { invalid?: boolean; strong?: boolean; weak?: boolean },
): FieldQuality {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'EMPTY';
  if (options?.invalid) return 'INVALID';
  if (options?.strong) return 'STRONG';
  if (options?.weak) return 'WEAK';
  return 'COHERENT';
}

export function incomingFieldIsStronger(current: FieldQuality, incoming: FieldQuality): boolean {
  return RANK[incoming] > RANK[current];
}

export type FallbackDecision = 'fallback_replace' | 'fallback_fill' | 'fallback_rejected_weaker';

export function decideFallbackReplacement(
  current: FieldQuality,
  incoming: FieldQuality,
): FallbackDecision {
  if (current === 'EMPTY' || current === 'INVALID') {
    return incoming === 'EMPTY' || incoming === 'INVALID' ? 'fallback_rejected_weaker' : 'fallback_fill';
  }
  return incomingFieldIsStronger(current, incoming) ? 'fallback_replace' : 'fallback_rejected_weaker';
}

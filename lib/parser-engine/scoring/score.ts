import type { Candidate, FieldKind, ScoredCandidate } from '../types';
import {
  enrichFeatureVector,
  FEATURE_LABELS,
  featureToSignal,
  type FeatureContribution,
  type FeatureEnrichmentContext,
  type FeatureKey,
} from './features';
import {
  getBaseCandidateScore,
  getNegativeWeightSum,
  getPositiveWeightSum,
  getWeightsForField,
  type FeatureWeightMap,
} from './weights';

export interface ScoredCandidateDetail<T> extends ScoredCandidate<T> {
  confidence: number;
  reasons: string[];
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function formatReason(contribution: FeatureContribution): string {
  const sign = contribution.contribution >= 0 ? '+' : '−';
  const magnitude = Math.abs(contribution.contribution).toFixed(2);
  return `${sign}${magnitude}: ${contribution.label}`;
}

function computeContribution(
  key: FeatureKey,
  weight: number,
  signal: number | boolean | undefined
): FeatureContribution | null {
  if (signal === undefined) return null;

  const label = FEATURE_LABELS[key];

  if (typeof signal === 'boolean') {
    if (!signal && weight > 0) return null;
    if (!signal && weight < 0) return null;
    return {
      key,
      label,
      contribution: weight,
      rawValue: signal,
    };
  }

  if (typeof signal === 'number') {
    if (signal === 0 && weight > 0) return null;
    const contribution = weight * signal;
    if (Math.abs(contribution) < 0.001) return null;
    return {
      key,
      label,
      contribution,
      rawValue: signal,
    };
  }

  return null;
}

function buildContributions(
  features: ReturnType<typeof enrichFeatureVector>,
  weights: FeatureWeightMap
): FeatureContribution[] {
  const contributions: FeatureContribution[] = [];

  for (const [key, weight] of Object.entries(weights) as [FeatureKey, number][]) {
    if (!weight) continue;
    const signal = featureToSignal(key, features[key]);
    const contribution = computeContribution(key, weight, signal);
    if (contribution) contributions.push(contribution);
  }

  return contributions;
}

function normalizeScore(rawScore: number, weights: FeatureWeightMap): number {
  const base = getBaseCandidateScore();
  const positiveMax = getPositiveWeightSum(weights) + base;
  const negativeMax = getNegativeWeightSum(weights);
  const min = -negativeMax;
  const max = positiveMax;
  if (max <= min) return clamp01(base);
  return clamp01((rawScore - min) / (max - min));
}

function deriveConfidence(score: number, ocrConfidence: number | undefined): number {
  const ocr = ocrConfidence ?? 0.7;
  return clamp01(score * 0.72 + ocr * 0.28);
}

function pickReasons(contributions: FeatureContribution[], limit = 6): string[] {
  const sorted = [...contributions].sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)
  );
  return sorted.slice(0, limit).map(formatReason);
}

/**
 * Calcola punteggio, confidence e reason per un singolo candidato.
 */
export function scoreCandidate<T>(
  candidate: Candidate<T>,
  fieldKind: FieldKind
): ScoredCandidateDetail<T> {
  const weights = getWeightsForField(fieldKind);
  const context: FeatureEnrichmentContext = {
    fieldKind,
    rawText: candidate.rawText,
    value: candidate.value,
  };
  const features = enrichFeatureVector(candidate.features, context);
  const contributions = buildContributions(features, weights);

  let rawScore = getBaseCandidateScore();
  for (const item of contributions) {
    rawScore += item.contribution;
  }

  const score = normalizeScore(rawScore, weights);
  const confidence = deriveConfidence(score, features.confidenceOcr);
  const reasons =
    pickReasons(contributions).length > 0
      ? pickReasons(contributions)
      : [`base: candidato ${fieldKind} con punteggio minimo`];

  return {
    ...candidate,
    features,
    score,
    confidence,
    reasons,
  };
}

/** Calcola punteggio per una lista di candidati (ordine invariato). */
export function scoreCandidates<T>(
  candidates: Candidate<T>[],
  fieldKind: FieldKind
): ScoredCandidateDetail<T>[] {
  return candidates.map((candidate) => scoreCandidate(candidate, fieldKind));
}

/** Ordina per score decrescente (tie-break: confidence). */
export function sortScoredCandidates<T>(
  candidates: ScoredCandidateDetail<T>[]
): ScoredCandidateDetail<T>[] {
  return [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.confidence - a.confidence;
  });
}

/** Converte in `ScoredCandidate` senza metadati (compatibilità `CardDraft`). */
export function toScoredCandidate<T>(detail: ScoredCandidateDetail<T>): ScoredCandidate<T> {
  return {
    value: detail.value,
    sourceLineIndices: detail.sourceLineIndices,
    extractor: detail.extractor,
    rawText: detail.rawText,
    features: detail.features,
    score: detail.score,
  };
}

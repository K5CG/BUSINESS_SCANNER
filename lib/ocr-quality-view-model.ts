import type { OcrQualityMetadata } from '../types';

export interface OcrQualityViewModel {
  confidenceKind: 'measured' | 'estimated' | 'unavailable';
  confidenceLabel: string;
  confidenceValue?: string;
  estimatedQualityLabel?: string;
  estimatedQualityValue?: string;
  requiresReview: boolean;
}

function percent(value: number | undefined): string | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? `${Math.round(value * 100)}%`
    : undefined;
}

export function buildOcrQualityViewModel(
  quality: OcrQualityMetadata,
  locale: 'it' | 'en' = 'it'
): OcrQualityViewModel {
  const measuredValue =
    quality.confidenceType === 'measured'
      ? percent(quality.measuredConfidence)
      : undefined;
  const estimatedValue = percent(quality.heuristicQuality);
  const italian = locale === 'it';

  if (measuredValue) {
    return {
      confidenceKind: 'measured',
      confidenceLabel: italian
        ? 'Affidabilità OCR misurata'
        : 'Measured OCR confidence',
      confidenceValue: measuredValue,
      ...(estimatedValue
        ? {
            estimatedQualityLabel: italian
              ? 'Qualità OCR stimata'
              : 'Estimated OCR quality',
            estimatedQualityValue: estimatedValue,
          }
        : {}),
      requiresReview: quality.requiresReview,
    };
  }

  if (quality.confidenceType === 'heuristic' && estimatedValue) {
    return {
      confidenceKind: 'estimated',
      confidenceLabel: italian
        ? 'Qualità OCR stimata'
        : 'Estimated OCR quality',
      confidenceValue: estimatedValue,
      requiresReview: quality.requiresReview,
    };
  }

  return {
    confidenceKind: 'unavailable',
    confidenceLabel: italian
      ? 'Affidabilità OCR non disponibile'
      : 'OCR confidence unavailable',
    ...(estimatedValue
      ? {
          estimatedQualityLabel: italian
            ? 'Qualità OCR stimata'
            : 'Estimated OCR quality',
          estimatedQualityValue: estimatedValue,
        }
      : {}),
    requiresReview: quality.requiresReview,
  };
}

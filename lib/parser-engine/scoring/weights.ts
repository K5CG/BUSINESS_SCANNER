import type { FieldKind } from '../types';
import type { FeatureKey } from './features';

export type FeatureWeightMap = Partial<Record<FeatureKey, number>>;

/** Pesi condivisi tra campi (valori tunabili). */
export const SHARED_WEIGHTS: FeatureWeightMap = {
  confidenceOcr: 0.22,
  positionRank: 0.08,
  crossPageAgreement: 0.18,
  mutualExclusionPenalty: -0.35,
  aiSourceBoost: 0.15,
  hasCatalogKeyword: -0.28,
};

/**
 * Pesi per campo — tutti generici, nessun override per biglietto/brand.
 * Valori positivi = bonus; negativi = penalità.
 */
export const FIELD_WEIGHTS: Record<FieldKind, FeatureWeightMap> = {
  firstName: {
    ...SHARED_WEIGHTS,
    isTitleCase: 0.2,
    inFirstNameDict: 0.25,
    emailLocalPartMatch: 0.42,
    tokenCount: 0.1,
    hasEmailPattern: -0.2,
    hasPhonePattern: -0.15,
    hasLegalForm: -0.25,
    hasRoleKeyword: -0.1,
    isAllCaps: 0.05,
  },
  lastName: {
    ...SHARED_WEIGHTS,
    isTitleCase: 0.18,
    emailLocalPartMatch: 0.38,
    tokenCount: 0.12,
    hasEmailPattern: -0.2,
    hasPhonePattern: -0.15,
    hasLegalForm: -0.25,
    isAllCaps: 0.08,
  },
  role: {
    ...SHARED_WEIGHTS,
    hasRoleKeyword: 0.42,
    crossPageAgreement: 0.38,
    isTitleCase: 0.14,
    tokenCount: 0.1,
    positionRank: 0.06,
    isAllCaps: -0.22,
    hasLegalForm: -0.2,
    hasAddressPattern: -0.18,
    hasEmailPattern: -0.28,
    hasPhonePattern: -0.22,
    hasCatalogKeyword: -0.72,
  },
  company: {
    ...SHARED_WEIGHTS,
    hasLegalForm: 0.62,
    isTitleCase: 0.14,
    isAllCaps: 0.1,
    emailDomainMatch: 0.52,
    websiteDomainMatch: 0.44,
    positionRank: 0.14,
    crossPageAgreement: 0.34,
    hasCatalogKeyword: -0.78,
    hasAddressPattern: -0.5,
    postalCodeValid: -0.45,
    provinceValid: -0.4,
    hasPhonePattern: -0.42,
    hasRoleKeyword: -0.55,
    hasEmailPattern: -0.18,
    hasVatPattern: -0.35,
    lineLength: 0.08,
    tokenCount: 0.06,
  },
  email: {
    ...SHARED_WEIGHTS,
    hasEmailPattern: 0.4,
    emailDomainMatch: 0.15,
    emailLocalPartMatch: 0.12,
    confidenceOcr: 0.28,
    hasCatalogKeyword: -0.2,
    hasPhonePattern: -0.05,
  },
  phone: {
    ...SHARED_WEIGHTS,
    hasPhonePattern: 0.38,
    hasEmailPattern: -0.15,
    hasAddressPattern: -0.05,
    lineLength: 0.05,
  },
  website: {
    ...SHARED_WEIGHTS,
    websiteDomainMatch: 0.42,
    confidenceOcr: 0.36,
    emailDomainMatch: 0.28,
    hasEmailPattern: -0.05,
    positionRank: 0.06,
    hasPhonePattern: -0.45,
    hasCatalogKeyword: -0.35,
  },
  address: {
    ...SHARED_WEIGHTS,
    hasAddressPattern: 0.28,
    postalCodeValid: 0.38,
    provinceValid: 0.28,
    tokenCount: 0.34,
    confidenceOcr: 0.18,
    lineLength: 0.08,
    hasEmailPattern: -0.22,
    hasPhonePattern: -0.12,
    hasRoleKeyword: -0.16,
    hasLegalForm: -0.22,
    hasCatalogKeyword: -0.15,
  },
  vatNumber: {
    ...SHARED_WEIGHTS,
    hasVatPattern: 0.4,
    confidenceOcr: 0.2,
    hasEmailPattern: -0.1,
    hasPhonePattern: -0.1,
  },
  taxCode: {
    ...SHARED_WEIGHTS,
    hasVatPattern: 0.35,
    confidenceOcr: 0.2,
    hasEmailPattern: -0.1,
    hasPhonePattern: -0.1,
  },
};

const BASE_CANDIDATE_SCORE = 0.25;

/**
 * Tuning selection-time per candidati `company:layout` (usato in resolve/select).
 * Non altera lo scoring grezzo: solo tie-break controllato in selezione.
 */
export const LAYOUT_COMPANY_SELECTION_BOOST = 0.06;
export const LAYOUT_COMPANY_NEAR_GAP = 0.1;

/** Score effettivo in selezione company (boost moderato solo per company:layout). */
export function effectiveCompanySelectionScore(score: number, extractor: string): number {
  if (extractor === 'company:layout') {
    return score + LAYOUT_COMPANY_SELECTION_BOOST;
  }
  return score;
}

/** Pesi effettivi per un campo (copia mutabile per tuning runtime futuro). */
export function getWeightsForField(fieldKind: FieldKind): FeatureWeightMap {
  return { ...FIELD_WEIGHTS[fieldKind] };
}

export function getBaseCandidateScore(): number {
  return BASE_CANDIDATE_SCORE;
}

/** Somma dei pesi positivi per normalizzazione del punteggio. */
export function getPositiveWeightSum(weights: FeatureWeightMap): number {
  return Object.values(weights).reduce((sum, w) => sum + (w && w > 0 ? w : 0), 0);
}

/** Somma assoluta dei pesi negativi per normalizzazione. */
export function getNegativeWeightSum(weights: FeatureWeightMap): number {
  return Object.values(weights).reduce((sum, w) => sum + (w && w < 0 ? Math.abs(w) : 0), 0);
}

/** Applica un moltiplicatore di tuning globale (default 1). */
export function scaleWeights(weights: FeatureWeightMap, factor: number): FeatureWeightMap {
  if (factor === 1) return weights;
  const scaled: FeatureWeightMap = {};
  for (const [key, value] of Object.entries(weights) as [FeatureKey, number][]) {
    scaled[key] = value * factor;
  }
  return scaled;
}

export function listActiveWeightKeys(fieldKind: FieldKind): FeatureKey[] {
  return Object.keys(FIELD_WEIGHTS[fieldKind]) as FeatureKey[];
}

export function getWeight(fieldKind: FieldKind, feature: FeatureKey): number {
  const weights = getWeightsForField(fieldKind);
  return weights[feature] ?? 0;
}

import type { Address, Phone } from '../../types';

/** Bounding box OCR (allineato a `OcrLine.boundingBox`). */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Riga OCR normalizzata con indice stabile per provenienza candidati. */
export interface RawLine {
  text: string;
  confidence: number;
  boundingBox?: BoundingBox;
  lineIndex: number;
}

/** Campi estratti dal parser (sottoinsieme di `BusinessCard`). */
export type FieldKind =
  | 'firstName'
  | 'lastName'
  | 'role'
  | 'company'
  | 'email'
  | 'phone'
  | 'website'
  | 'address'
  | 'vatNumber'
  | 'taxCode';

/**
 * Feature numeriche/booleane per lo scoring.
 * Tutte opzionali: ogni estrattore popola solo quelle rilevanti.
 */
export interface FeatureVector {
  positionRank?: number;
  lineLength?: number;
  confidenceOcr?: number;
  hasLegalForm?: boolean;
  hasRoleKeyword?: boolean;
  hasCatalogKeyword?: boolean;
  hasAddressPattern?: boolean;
  hasEmailPattern?: boolean;
  hasPhonePattern?: boolean;
  hasVatPattern?: boolean;
  isAllCaps?: boolean;
  isTitleCase?: boolean;
  tokenCount?: number;
  inFirstNameDict?: boolean;
  emailDomainMatch?: number;
  emailLocalPartMatch?: number;
  websiteDomainMatch?: number;
  provinceValid?: boolean;
  postalCodeValid?: boolean;
  crossPageAgreement?: number;
  mutualExclusionPenalty?: number;
  aiSourceBoost?: number;
}

/** Candidato grezzo prodotto da un estrattore (nessuna selezione). */
export interface Candidate<T> {
  value: T;
  sourceLineIndices: number[];
  extractor: string;
  rawText: string;
  features: FeatureVector;
}

/** Candidato con punteggio combinato. */
export type ScoredCandidate<T> = Candidate<T> & { score: number };

/** Accumulo pre-resolve: candidati scored per campo. */
export type CardDraft = Partial<Record<FieldKind, ScoredCandidate<unknown>[]>>;

/** Output della fase normalize per una singola pagina. */
export interface NormalizedInput {
  lines: RawLine[];
  rawText: string;
  repairedText: string;
}

/** Campi risolti prima dell'assemblaggio in `BusinessCard`. */
export interface ResolvedCard {
  firstName: string;
  lastName: string;
  role: string;
  company: string;
  emails: string[];
  phones: Phone[];
  address?: Address;
  vatNumber?: string;
  taxCode?: string;
  website?: string;
  rawText: string;
  confidence: Record<string, number>;
}

/** Limiti allineati al parser legacy (difesa da input OCR enormi). */
export const MAX_CARD_LINES = 120;
export const MAX_CARD_LINE_LEN = 180;
export const MAX_CARD_TEXT_LEN = 6000;

/** Soglia verticale (px) per considerare due righe sulla stessa riga di lettura. */
export const LINE_SORT_Y_TOLERANCE = 12;

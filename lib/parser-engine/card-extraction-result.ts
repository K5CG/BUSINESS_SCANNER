import type { Address, Phone } from '../../types';
import type { EmailEvidenceMetadata } from '../email-evidence';

export type FieldConfidence = 'high' | 'medium' | 'low';

export type ExtractionSource =
  | 'ocr'
  | 'layout'
  | 'email'
  | 'website'
  | 'ai'
  | 'legacy'
  | 'observed'
  | 'repaired'
  | 'inferred'
  | 'user';

export interface NumericEvidenceMetadata {
  rawValue: string;
  normalizedValue: string;
  lineId: number;
  pageIndex: number;
  evidenceType:
    | 'vat'
    | 'phone'
    | 'fax'
    | 'taxCode'
    | 'postalCode'
    | 'documentNumber'
    | 'unknownNumericIdentifier';
  reason: string;
  confidence: number;
  validationStatus: 'valid' | 'invalid' | 'unverified' | 'not_applicable';
}

export interface NumericEvidenceResolutionMetadata {
  accepted: NumericEvidenceMetadata[];
  ambiguous: NumericEvidenceMetadata[];
  rejected: NumericEvidenceMetadata[];
}

export interface PageCoherenceMetadata {
  decision: 'match' | 'mismatch' | 'ambiguous';
  primaryPage: number | null;
  includedPageIndexes: number[];
  excludedPageIndexes: number[];
  pendingPageIndexes: number[];
  confidence: number;
  decisionReasons: string[];
  requiresReview: boolean;
  /** Evidenze numeriche usate dalla decisione, con provenance OCR. */
  numericEvidence?: NumericEvidenceResolutionMetadata;
}

export interface ExtractedField<T> {
  value: T | null;
  confidence: FieldConfidence;
  score: number;
  source: ExtractionSource;
  reasons: string[];
}

export interface BusinessCardExtractionResult {
  firstName: ExtractedField<string>;
  lastName: ExtractedField<string>;
  company: ExtractedField<string>;
  role: ExtractedField<string>;
  emails: ExtractedField<string[]>;
  phones: ExtractedField<Phone[]>;
  website: ExtractedField<string>;
  address: ExtractedField<Address | null>;
  /**
   * Sedi secondarie osservate e validate. La sede primaria resta in
   * `address`; il campo è opzionale per i record legacy.
   */
  addressAlternatives?: Address[];
  vatNumber: ExtractedField<string>;
  taxCode: ExtractedField<string>;
  rawText: string;
  needsReview: boolean;
  reviewFields: string[];
  /** Evidenza e provenienza per ogni indirizzo proposto (Fase 3B). */
  emailEvidence?: EmailEvidenceMetadata[];
  /** Partizione multipagina usata dal parser; opzionale sui record legacy. */
  pageCoherence?: PageCoherenceMetadata;
}

/** Soglie generiche per classificare la confidence (nessuna regola per singolo biglietto). */
export const CONFIDENCE_THRESHOLDS = {
  structured: { high: 0.72, medium: 0.45 },
  semantic: { high: 0.74, medium: 0.44 },
  collectMin: 0.22,
  companyAmbiguityGap: 0.12,
} as const;

export const SEMANTIC_FIELD_KEYS = [
  'firstName',
  'lastName',
  'company',
  'role',
  'address',
] as const;

export const STRUCTURED_FIELD_KEYS = [
  'emails',
  'phones',
  'website',
  'vatNumber',
  'taxCode',
] as const;

export type SemanticFieldKey = (typeof SEMANTIC_FIELD_KEYS)[number];
export type StructuredFieldKey = (typeof STRUCTURED_FIELD_KEYS)[number];

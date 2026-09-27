import type { DocumentLayoutLine, SemanticDocumentRegion } from './document-structure';
import { isPlausibleDocumentDiscountAmount } from './document-totals-roles';
import { logQaDocument } from './qa-document-logging';

const YEAR_LIKE_DIGITS = /^(?:19|20)\d{2}$/;

const EXCLUDED_DISCOUNT_REGIONS = new Set<SemanticDocumentRegion>([
  'notes',
  'payment_terms',
  'footer',
  'historical_recap',
  'statistical_recap',
  'tax_recap',
]);

const TOTALS_DISCOUNT_REGIONS = new Set<SemanticDocumentRegion>([
  'document_totals',
  'table_subtotal',
]);

const DOCUMENT_DISCOUNT_LABEL =
  /\b(?:sconto\s+(?:documento|merci|totale|globale)|document\s+discount|discount\s+(?:document|total)|totale\s+sconto|remise(?:\s+(?:document|globale|totale|ht))?|rabatt(?:\s+(?:gesamt|dokument))?|descuento(?:\s+(?:documento|total))?)\b/i;

const GENERIC_DISCOUNT_LABEL =
  /\b(?:discount|sconto|remise|rabatt|descuento)\b/i;

const NON_AMOUNT_DISCOUNT_CONTEXT =
  /\b(?:incoterms?|resa\b|consegna|delivery\s+terms?|shipping\s+terms?|payment\s+terms?|condizioni\s+di\s+(?:fornitura|pagamento|consegna)|validit[aà]|giorni|iban|bic|swift|copyright|regolamento|note:|osservazioni|observaciones)\b/i;

export function isExplicitDocumentDiscountLabel(text: string): boolean {
  return DOCUMENT_DISCOUNT_LABEL.test(text)
    || (GENERIC_DISCOUNT_LABEL.test(text) && /\b(?:totale|total|documento|merci|merce|globale|document|ht|importo)\b/i.test(text));
}

export function isYearLikeStandaloneAmount(text: string, value?: number): boolean {
  const trimmed = text.trim();
  if (/[€$£]|(?:EUR|USD|GBP|CHF)/i.test(trimmed)) return false;
  if (/[.,]\d{2}/.test(trimmed)) return false;
  const compact = trimmed.replace(/[^\d.,]/g, '');
  if (/[.,]/.test(compact)) return false;
  const digits = trimmed.replace(/\D/g, '');
  if (!YEAR_LIKE_DIGITS.test(digits)) return false;
  const year = Number(digits);
  if (value !== undefined && value !== year && Math.abs(value) !== year) return false;
  return year >= 1900 && year <= 2099;
}

export function looksLikeDocumentDiscountMoney(text: string, value?: number): boolean {
  if (value === undefined || !Number.isFinite(value) || value === 0) return false;
  if (isYearLikeStandaloneAmount(text, value)) return false;
  if (/%/.test(text) && Math.abs(value) <= 100) return false;
  return /[.,]\d{2}/.test(text)
    || /[€$£]|(?:EUR|USD|GBP|CHF)/i.test(text)
    || /(?:^|\s)[-−–—]\s*\d/.test(text);
}

export function documentDiscountValueRejection(
  valueLine: DocumentLayoutLine,
  parsedValue: number | undefined,
  labelLine?: DocumentLayoutLine,
): string | undefined {
  if (parsedValue === undefined || !Number.isFinite(parsedValue)) return 'unparsed';
  if (isYearLikeStandaloneAmount(valueLine.text, parsedValue)) return 'year_like_token';
  if (NON_AMOUNT_DISCOUNT_CONTEXT.test(valueLine.text)) return 'notes_or_terms_context';
  if (!looksLikeDocumentDiscountMoney(valueLine.text, parsedValue)) return 'non_monetary_shape';
  const region = valueLine.semanticRegion;
  if (region === 'tax_recap' || region === 'historical_recap' || region === 'statistical_recap') {
    return `excluded_region:${region}`;
  }
  if (region === 'commercial_table_body') {
    const printedSigned = /(?:^|\s)[-−–—]\s*\d/.test(valueLine.text);
    if (!printedSigned && !(labelLine && isExplicitDocumentDiscountLabel(labelLine.text))) {
      return `excluded_region:${region}`;
    }
  }
  const labelInTotals = !!labelLine && (
    (labelLine.semanticRegion !== undefined && TOTALS_DISCOUNT_REGIONS.has(labelLine.semanticRegion))
    || isExplicitDocumentDiscountLabel(labelLine.text)
  );
  const labelTotalsRegion = labelLine?.semanticRegion !== undefined
    && TOTALS_DISCOUNT_REGIONS.has(labelLine.semanticRegion);
  if (region && EXCLUDED_DISCOUNT_REGIONS.has(region)) {
    if (!(labelInTotals && labelTotalsRegion && isExplicitDocumentDiscountLabel(labelLine?.text ?? ''))) {
      return `excluded_region:${region}`;
    }
  }
  return undefined;
}

export interface DocumentDiscountCandidateLog {
  rawText: string;
  parsedValue?: number;
  page: number;
  region?: string;
  label?: string;
  sourceLineIds: readonly string[];
  evidence: string;
  rejectionReason?: string;
  won: boolean;
}

export function logDocumentDiscountCandidate(entry: DocumentDiscountCandidateLog): void {
  logQaDocument('DocumentDiscountCandidate', {
    rawText: entry.rawText.slice(0, 80),
    parsedValue: entry.parsedValue,
    page: entry.page,
    region: entry.region ?? 'unknown',
    label: entry.label?.slice(0, 80),
    sourceLineIds: entry.sourceLineIds,
    evidence: entry.evidence,
    rejectionReason: entry.rejectionReason,
    won: entry.won,
  });
}

export function deriveDocumentDiscountFromSurroundingTotals(input: {
  subtotal?: number;
  shipping?: number;
  vat?: number;
  grandTotal?: number;
}): { value: number; confidence: 'derived' } | undefined {
  const { subtotal, vat, grandTotal, shipping } = input;
  if (subtotal === undefined || vat === undefined || grandTotal === undefined || shipping === undefined) {
    return undefined;
  }
  const implied = Math.round((grandTotal - subtotal - vat - shipping) * 100) / 100;
  if (!(implied < -0.05)) return undefined;
  if (!isPlausibleDocumentDiscountAmount(implied, subtotal)) return undefined;
  return { value: implied, confidence: 'derived' };
}

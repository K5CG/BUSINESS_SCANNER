/**
 * Generic issuer evidence. Named suppliers/fixtures must never appear here.
 * Missing issuer is safer than a payment-section or metadata false positive.
 */

const PAYMENT_CONTEXT =
  /\b(?:iban|bic|swift|bonifico|bankverbindung|coordinate\s+bancarie|bank\s+details|sort\s+code|modalit[aà]\s+di\s+pagamento|payment\s+(?:instructions|details|terms)|pagamento\s+a\s+mezzo|mezzo\s+di\s+pagamento|filiale|agenzia\s+di|bank\s+branch)\b/i;
const BANK_LABEL =
  /\b(?:banca|banque|banco|bank|sparkasse|bankverbindung)\s*:/i;
const STRONG_LEGAL_FORM =
  /\b(?:s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|sarl|gmbh|ltd\.?|inc\.?|bv|sl|ag)\b/i;
const WEAK_SA_TOKEN = /(?:^|\s)s\.?a\.?(?:\s|$)/i;
const CONTACT_ONLY =
  /^(?:tel|phone|fax|e-?mail|pec|www\.|http|iban|bic|swift|p\.?\s*iva|vat|c\.?f\.?)/i;
const FIELD_HEADING =
  /^(?:emittente|fornitore|supplier|seller|vendor|issuer|intestazione|cliente|customer|destinatario|recipient|spettabile|bill\s+to|ship\s+to)\s*:?\s*$/i;
const AMOUNT_ONLY = /^\s*-?\d[\d\s.,]*\d\s*(?:€|eur|usd|gbp|chf)?\s*$/i;
const DATE_ONLY = /(?:^|\s)\d{1,2}[./-]\d{1,2}[./-]\d{2,4}(?:\s|$)/;

export interface IssuerCandidateEvidence {
  name: string;
  yRatio: number;
  inHeaderZone: boolean;
  inSenderBlock: boolean;
  hasStrongLegalForm: boolean;
  hasWeakSaOnly: boolean;
  nearbyVat: boolean;
  nearbyAddress: boolean;
  nearbyWebsite: boolean;
  inPaymentZone: boolean;
  nearbyPaymentContext: boolean;
}

export interface IssuerCandidateDecision {
  accept: boolean;
  score: number;
  rejectReason?: string;
}

export function isPaymentSectionContext(
  lineText: string,
  neighborTexts: readonly string[] = [],
): boolean {
  if (PAYMENT_CONTEXT.test(lineText) || BANK_LABEL.test(lineText)) return true;
  return neighborTexts.some((text) => PAYMENT_CONTEXT.test(text) || BANK_LABEL.test(text));
}

export function isRejectedIssuerName(name: string): boolean {
  const text = name.trim();
  if (text.length < 3 || text.length > 120) return true;
  const withoutLegal = text
    .replace(/\b(?:s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?a\.?s\.?|s\.?n\.?c\.?|sarl|gmbh|ltd\.?|inc\.?|bv|sl|ag|s\.?a\.?)\b/gi, '')
    .replace(/[.\s,/-]/g, '');
  if (withoutLegal.length < 3 && STRONG_LEGAL_FORM.test(text)) return true;
  if (FIELD_HEADING.test(text)) return true;
  if (CONTACT_ONLY.test(text)) return true;
  if (AMOUNT_ONLY.test(text) || DATE_ONLY.test(text)) return true;
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/i.test(text.replace(/\s/g, ''))) return true;
  if (/\b(?:iban|bic|swift)\b/i.test(text)) return true;
  if (/^(?:p\.?\s*iva|vat|tva|mwst|c\.?f\.?|codice\s+fiscale)\b/i.test(text)) return true;
  if (/@/.test(text) || /^\+?\d[\d\s()./-]{6,}$/.test(text)) return true;
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(text)) return true;
  if (/^(?:n\.?|nr\.?|no\.?)\s*[A-Z0-9]/i.test(text) && text.length <= 24) return true;
  if (/\b(?:filiale|agenzia|sucursal|bank\s+branch|bankverbindung)\b/i.test(text)) return true;
  return false;
}

export function scoreIssuerCandidate(evidence: IssuerCandidateEvidence): IssuerCandidateDecision {
  if (isRejectedIssuerName(evidence.name)) {
    return { accept: false, score: -100, rejectReason: 'rejected_issuer_token' };
  }
  if (evidence.inPaymentZone || evidence.nearbyPaymentContext) {
    return { accept: false, score: -80, rejectReason: 'payment_section' };
  }
  if (evidence.hasWeakSaOnly && !evidence.hasStrongLegalForm && !evidence.nearbyVat && !evidence.inHeaderZone) {
    return { accept: false, score: -40, rejectReason: 'weak_legal_form_without_org_evidence' };
  }

  let score = 0;
  if (evidence.inHeaderZone || evidence.yRatio <= 0.28) score += 6;
  if (evidence.inSenderBlock) score += 3;
  if (evidence.hasStrongLegalForm) score += 5;
  if (evidence.nearbyVat) score += 4;
  if (evidence.nearbyAddress) score += 2;
  if (evidence.nearbyWebsite) score += 3;
  if (evidence.yRatio > 0.72 && !evidence.hasStrongLegalForm && !evidence.nearbyWebsite) score -= 3;
  const corroborated = evidence.hasStrongLegalForm
    || evidence.nearbyVat
    || evidence.nearbyWebsite
    || (evidence.inHeaderZone && evidence.nearbyAddress);
  if (!corroborated || score < 5) {
    return { accept: false, score, rejectReason: 'insufficient_issuer_evidence' };
  }
  return { accept: true, score };
}

export function hasStrongIssuerLegalForm(name: string): boolean {
  return STRONG_LEGAL_FORM.test(name);
}

export function hasWeakSaOnlyLegalForm(name: string): boolean {
  return WEAK_SA_TOKEN.test(name) && !STRONG_LEGAL_FORM.test(name);
}

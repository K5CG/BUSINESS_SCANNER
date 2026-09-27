import type { FeatureVector, FieldKind } from '../types';
import { isAllCaps, isTitleCase, tokenize } from '../normalize/tokens';
import { addressCompletenessScore, isValidItalianPostalCode, isValidItalianProvince } from '../validators/address';
import { ACTIVITY_WORDS_REGEX, COMPANY_DESCRIPTOR_WORDS } from '../validators/dictionaries';
import { isGenericEmailLocalPart } from '../extractors/email';
import type { Address } from '../../../types';
import {
  brandMultisetKey,
  FIRM_SUFFIX_WORDS,
  hasLegalForm,
  isCompanyNoiseLine,
  isLikelyIndustryAcronymLine,
  isIsolatedLegalFormOnly,
  isStandaloneFirmSuffixWord,
  isSuffixOnlyCompany,
  levenshteinDistance,
  normalizeBrandKey,
  ROLE_KEYWORD_REGEX,
  stripLegalFormSuffix,
} from '../validators/dictionaries';
import { isLikelyActivityRoleLine, isPlausiblePersonNameLine } from '../validators/name';

/** Forme giuridiche IT/EU/US — pattern generico. */
const LEGAL_FORM_REGEX =
  /\b(S\.?\s*R\.?\s*L\.?\.?|S\.?\s*P\.?\s*A\.?\.?|S\.?\s*N\.?\s*C\.?\.?|S\.?\s*A\.?\s*S\.?\.?|S\.?\s*A\.?\s*P\.?\.?|S\.?\s*D\.?\s*F\.?\.?|\bsrl\b|\bspa\b|\bsnc\b|GmbH|AG|Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|PLC|BV|NV|SA|S\.?\s*A\.?\s*R\.?\.?|Co\.?\s*Kg|Oy|AB|AS|ApS|S\.?\s*L\.?)\b/i;

/** Keyword ruolo professionali — allineato a validators/dictionaries. */
const PROFESSIONAL_ROLE_STEMS = [
  'revisore',
  'contabile',
  'commercialista',
  'consulente',
  'avvocato',
  'ingegnere',
  'architetto',
  'tributarista',
  'professionista',
  'notaio',
];

function normalizeLexiconWord(word: string): string {
  return word.toLowerCase().replace(/[^a-zà-ü]/g, '');
}

/** True se il token appartiene al lessico ruolo/professione (non marchio). */
export function isProfessionalLexiconWord(word: string): boolean {
  const bare = normalizeLexiconWord(word);
  if (!bare || bare.length < 3) return true;
  if (ROLE_KEYWORD_REGEX.test(word)) return true;
  if (isStandaloneFirmSuffixWord(word)) return true;
  return PROFESSIONAL_ROLE_STEMS.some(
    (stem) =>
      Math.abs(bare.length - stem.length) <= 2 && levenshteinDistance(bare, stem) <= 2
  );
}

/**
 * True se il valore è solo lessico di ruolo/professione, senza token marchio.
 * Es. "Revisore Contabile", "Revisore Gontabile" — non ragione sociale.
 */
export function isRoleOnlyCompanyValue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (hasLegalForm(t) || LEGAL_FORM_REGEX.test(t)) return false;
  if (hasCompanyDescriptorInText(t)) return false;

  const brand = stripLegalFormSuffix(t).trim();
  const words = tokenize(brand);
  if (words.length === 0 || words.length > 6) return false;

  let roleWords = 0;
  let brandWords = 0;
  for (const word of words) {
    const bare = word.replace(/[^A-Za-zÀ-ü0-9&.'`-]/g, '');
    if (!bare || bare.length < 2) continue;
    if (isProfessionalLexiconWord(bare)) {
      roleWords++;
    } else if (bare.length >= 3) {
      brandWords++;
    }
  }

  return roleWords > 0 && brandWords === 0;
}

/** True se la riga è un frammento di ruolo, non un marchio. */
export function isRoleFragmentLine(text: string): boolean {
  return isRoleOnlyCompanyValue(text);
}

const ADDRESS_PATTERN =
  /\b(via|viale|piazza|corso|vicolo|street|road|avenue|blvd|str\.?)\b/i;

const POSTAL_CODE_PATTERN = /\b\d{5}\b/;

const PROVINCE_PATTERN = /\([A-Z]{2}\)|\b-\s*[A-Z]{2}\s*-/;

const VAT_LABEL_PATTERN =
  /(?:p\.?\s*iva|partita\s*iva|vat|cod\.?\s*fisc|codice\s*fiscale|c\.?\s*f\.?)/i;

const EMAIL_LABEL_PATTERN = /\b(?:e-?mail|e\s*mail|pec|cmail)\s*:?/i;

const EXPLICIT_WEBSITE_PATTERN = /(?:https?:\/\/)?(?:www\.|ww\.)([a-z0-9-]+\.[a-z]{2,})/i;

export type FeatureKey = keyof FeatureVector;

/** Etichette leggibili per le reason dello scoring. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  positionRank: 'posizione in alto sul biglietto',
  lineLength: 'lunghezza riga',
  confidenceOcr: 'affidabilità OCR',
  hasLegalForm: 'contiene forma giuridica',
  hasRoleKeyword: 'contiene keyword di ruolo',
  hasCatalogKeyword: 'sembra riga catalogo/descrizione',
  hasAddressPattern: 'contiene pattern indirizzo',
  hasEmailPattern: 'contiene email',
  hasPhonePattern: 'contiene telefono',
  hasVatPattern: 'contiene dato fiscale',
  isAllCaps: 'testo tutto maiuscolo',
  isTitleCase: 'testo in Title Case',
  tokenCount: 'numero token',
  inFirstNameDict: 'nome comune riconosciuto',
  emailDomainMatch: 'dominio email coerente',
  emailLocalPartMatch: 'local-part coerente con nome',
  websiteDomainMatch: 'dominio sito coerente',
  provinceValid: 'provincia valida',
  postalCodeValid: 'CAP plausibile',
  crossPageAgreement: 'accordo fronte/retro',
  mutualExclusionPenalty: 'conflitto con altro campo',
  aiSourceBoost: 'suggerimento AI',
};

export interface FeatureEnrichmentContext {
  fieldKind: FieldKind;
  rawText: string;
  value?: unknown;
  lineCount?: number;
}

/** Conta ripetizioni di marchio nel testo (fronte/retro, righe adiacenti). */
export function buildBrandRepetitionScores(
  lines: Array<{ text: string }>
): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (text: string) => {
    const key = normalizeBrandKey(text);
    const mKey = brandMultisetKey(text);
    if (key.length >= 6) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (mKey.length >= 6) counts.set(mKey, (counts.get(mKey) ?? 0) + 1);
  };

  const tryPair = (a: string, b: string) => {
    if (!a || !b || isCompanyNoiseLine(b) || isLikelyActivityRoleLine(b)) return;
    if (isPlausiblePersonNameLine(`${a} ${b}`) || isPlausiblePersonNameLine(a)) return;
    bump(`${a} ${b}`);
    bump(combineBrandFragments(a, b));
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    bump(t);
    if (i + 1 < lines.length) tryPair(t, lines[i + 1].text.trim());
    if (i > 0) tryPair(lines[i - 1].text.trim(), t);
  }

  return counts;
}

export function combineBrandFragments(first: string, second: string): string {
  const a = first.trim();
  const b = second.trim();
  if (!a || !b) return `${a} ${b}`.trim();
  const aIsMainCaps = /^[A-ZÀ-Ü]{3,}$/.test(a);
  const bIsMainCaps = /^[A-ZÀ-Ü]{3,}$/.test(b);
  const aIsSubtitle = /^[a-zà-ü]/.test(a);
  const bIsSubtitle = /^[a-zà-ü]/.test(b);
  if (aIsMainCaps && bIsSubtitle) return `${a} ${b}`;
  if (bIsMainCaps && aIsSubtitle) return `${b} ${a}`;
  return `${a} ${b}`;
}

export function repetitionBonusForCompany(text: string, repetition: Map<string, number>): number {
  const key = normalizeBrandKey(text);
  const mKey = brandMultisetKey(text);
  const count = Math.max(repetition.get(key) ?? 0, repetition.get(mKey) ?? 0);
  if (count >= 2) return 1;
  for (const [k, c] of repetition) {
    if (c >= 2 && (key.includes(k) || mKey.includes(k)) && k.length >= 8) return 0.7;
  }
  return 0;
}

export function isDisqualifiedCompanyValue(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (isIsolatedLegalFormOnly(t)) return true;
  if (isLikelyIndustryAcronymLine(t)) return true;
  if (isPlausiblePersonNameLine(t)) return true;
  if (isRoleOnlyCompanyValue(t)) return true;
  if (isSuffixOnlyCompany(t)) return true;
  return isDisqualifiedCompanyText(t);
}

/** Riga che per struttura sembra catalogo, non contatto (pattern linguistici). */
export function looksLikeCatalogLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^[*•·\-–—]\s/.test(t)) return true;
  if (/^\d+[\s.)]/.test(t)) return true;
  if (t.length > 50 && /[,;:](\s|$)/.test(t)) return true;
  if (/\d+\s*%/.test(t)) return true;
  if (/\s-\s/.test(t) && t.split(/\s+/).length >= 3) return true;
  if (/\w-\s*$/.test(t)) return true;
  return false;
}

/** Riga con struttura tipica di indirizzo/località (non ragione sociale). */
export function looksLikeAddressOrLocationLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ADDRESS_PATTERN.test(t)) return true;
  if (/\b\d{5}\b/.test(t) && /\([A-Za-z]{1,2}\)/.test(t)) return true;
  if (/\b\d{5}\b/.test(t) && /\b(?:italy|italia)\b/i.test(t)) return true;
  if (/^\d{5}\s+[A-Za-zÀ-ü]/i.test(t)) return true;
  if (/\b(?:sede\s+legale|sede\s+operativa|registered\s+office|head\s*quarters)\b/i.test(t)) return true;
  return false;
}

/** Riga prevalentemente numerica (telefono, P.IVA isolata, ecc.). */
export function looksLikePhoneOrNumericLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const digits = t.replace(/\D/g, '');
  if (digits.length >= 9 && digits.length / Math.max(t.length, 1) >= 0.55) return true;
  if (/^(?:tel\.?|fax\.?|phone|mob\.?|cell\.?)\b/i.test(t) && digits.length >= 6) return true;
  return false;
}

/** True se il testo contiene un descriptor aziendale generico dal dizionario. */
export function hasCompanyDescriptorInText(text: string): boolean {
  const words = tokenize(text);
  return words.some((w) => COMPANY_DESCRIPTOR_WORDS.has(w.toLowerCase().replace(/[.,]/g, '')));
}

const DESCRIPTIVE_ACTIVITY_WORDS = new Set([
  'attrezzato',
  'centri',
  'storici',
  'microsabbiatura',
  'verniciatura',
  'idropulitura',
  'progettazione',
  'servizi',
  'soluzioni',
  'consulenza',
  'vendita',
  'produzione',
  'installazione',
  'cataloghi',
  'sabbiatura',
  'verniciature',
  'idropulizia',
]);

function normalizeDescriptorToken(word: string): string {
  return word.toLowerCase().replace(/[.,'’`\-]/g, '');
}

/**
 * Riga slogan/attività (es. servizi, verniciatura, ATTREZZATO PER …) — non ragione sociale
 * quando esiste un candidato con forma giuridica e/o dominio coerente.
 */
export function isDescriptiveActivityLine(text: string): boolean {
  const t = text.trim();
  if (!t || hasLegalForm(t)) return false;

  const words = tokenize(t);
  if (words.length < 2) return false;

  const descriptorHits = words.filter((word) => {
    const key = normalizeDescriptorToken(word);
    return (
      DESCRIPTIVE_ACTIVITY_WORDS.has(key) ||
      COMPANY_DESCRIPTOR_WORDS.has(key) ||
      ACTIVITY_WORDS_REGEX.test(word)
    );
  }).length;

  if (descriptorHits === 0) return false;

  if (/\s-\s/.test(t) && words.length >= 3) return true;
  if (isAllCaps(t) && (/\bper\b/i.test(t) || descriptorHits >= 2)) return true;
  if (isAllCaps(t) && t.length > 22 && words.length >= 3) return true;
  if (descriptorHits >= Math.max(2, Math.ceil(words.length * 0.5))) return true;

  return false;
}

/** Evidenza forte: forma giuridica + dominio email/sito coerente col marchio. */
export function hasLegalFormDomainEvidence(features: FeatureVector, text: string): boolean {
  if (!hasLegalForm(text)) return false;
  const domain = Math.max(features.emailDomainMatch ?? 0, features.websiteDomainMatch ?? 0);
  return domain >= 0.7;
}

/** Candidato azienda improbabile: indirizzo, catalogo, telefono, CAP+città. */
export function isDisqualifiedCompanyText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return true;
  if (looksLikeCatalogLine(t)) return true;
  if (isDescriptiveActivityLine(t)) return true;
  if (looksLikeAddressOrLocationLine(t)) return true;
  if (looksLikePhoneOrNumericLine(t)) return true;
  if (VAT_LABEL_PATTERN.test(t)) return true;
  if (ROLE_KEYWORD_REGEX.test(t) && !hasCompanyDescriptorInText(t) && !LEGAL_FORM_REGEX.test(t)) {
    return true;
  }
  if (isRoleOnlyCompanyValue(t)) return true;
  if (isSuffixOnlyCompany(t)) return true;
  return false;
}

/** Deriva feature strutturali dal testo grezzo del candidato. */
export function deriveFeaturesFromText(text: string): FeatureVector {
  const tokens = tokenize(text);
  return {
    lineLength: text.length,
    tokenCount: tokens.length,
    hasLegalForm: LEGAL_FORM_REGEX.test(text),
    hasRoleKeyword: ROLE_KEYWORD_REGEX.test(text),
    hasCatalogKeyword: looksLikeCatalogLine(text),
    hasAddressPattern: ADDRESS_PATTERN.test(text),
    hasEmailPattern: /@/.test(text),
    hasPhonePattern: /\d{5,}/.test(text.replace(/\s/g, '')),
    hasVatPattern: VAT_LABEL_PATTERN.test(text) || /\b\d{11}\b/.test(text),
    isAllCaps: isAllCaps(text),
    isTitleCase: isTitleCase(text),
    postalCodeValid: POSTAL_CODE_PATTERN.test(text),
    provinceValid: PROVINCE_PATTERN.test(text),
  };
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeLineLength(length: number): number {
  if (length <= 0) return 0;
  if (length <= 8) return 0.2;
  if (length <= 25) return 0.6;
  if (length <= 80) return 1;
  return 0.7;
}

function normalizeTokenCount(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.5;
  if (count <= 4) return 1;
  if (count <= 8) return 0.6;
  return 0.3;
}

/**
 * Unisce le feature già presenti sul candidato con quelle derivate dal testo.
 * I valori espliciti del candidato hanno precedenza sui derivati.
 */
export function enrichFeatureVector(
  features: FeatureVector,
  context: FeatureEnrichmentContext
): FeatureVector {
  const derived = deriveFeaturesFromText(context.rawText);
  const merged: FeatureVector = { ...derived, ...features };

  if (merged.lineLength !== undefined) {
    merged.lineLength = normalizeLineLength(merged.lineLength);
  }
  if (merged.tokenCount !== undefined) {
    merged.tokenCount = normalizeTokenCount(merged.tokenCount);
  }
  if (merged.positionRank !== undefined) {
    merged.positionRank = clamp01(merged.positionRank);
  }
  if (merged.confidenceOcr !== undefined) {
    merged.confidenceOcr = clamp01(merged.confidenceOcr);
  }
  if (merged.crossPageAgreement !== undefined) {
    merged.crossPageAgreement = clamp01(merged.crossPageAgreement);
  }
  if (merged.emailDomainMatch !== undefined) {
    merged.emailDomainMatch = clamp01(merged.emailDomainMatch);
  }
  if (merged.emailLocalPartMatch !== undefined) {
    merged.emailLocalPartMatch = clamp01(merged.emailLocalPartMatch);
  }
  if (merged.websiteDomainMatch !== undefined) {
    merged.websiteDomainMatch = clamp01(merged.websiteDomainMatch);
  }
  if (merged.mutualExclusionPenalty !== undefined) {
    merged.mutualExclusionPenalty = Math.max(0, merged.mutualExclusionPenalty);
  }
  if (merged.aiSourceBoost !== undefined) {
    merged.aiSourceBoost = clamp01(merged.aiSourceBoost);
  }

  if (context.fieldKind === 'email' && typeof context.value === 'string') {
    if (isGenericEmailLocalPart(context.value)) {
      merged.hasCatalogKeyword = true;
    }
    if (EMAIL_LABEL_PATTERN.test(context.rawText)) {
      merged.confidenceOcr = Math.max(merged.confidenceOcr ?? 0.5, 0.9);
    }
  }

  if (context.fieldKind === 'website' && typeof context.value === 'string') {
    const raw = context.rawText.toLowerCase();
    const value = context.value.toLowerCase();
    if (EXPLICIT_WEBSITE_PATTERN.test(context.rawText) && raw.includes(value.replace(/^www\./, ''))) {
      merged.websiteDomainMatch = Math.max(merged.websiteDomainMatch ?? 0, 1);
      merged.confidenceOcr = Math.max(merged.confidenceOcr ?? 0.5, 0.93);
    }
  }

  if (context.fieldKind === 'company') {
    const text = typeof context.value === 'string' ? context.value : context.rawText;
    if (hasCompanyDescriptorInText(text)) {
      merged.isTitleCase = merged.isTitleCase || isTitleCase(text);
    }
    if (isDisqualifiedCompanyText(text) || isDisqualifiedCompanyValue(text)) {
      merged.hasAddressPattern = true;
      merged.hasCatalogKeyword = true;
    }
    if (isIsolatedLegalFormOnly(text)) {
      merged.hasLegalForm = false;
      merged.hasCatalogKeyword = true;
    }
    if (isLikelyIndustryAcronymLine(text)) {
      merged.hasRoleKeyword = true;
      merged.hasCatalogKeyword = true;
    }
    if (hasLegalForm(text) && stripLegalFormSuffix(text).length >= 4) {
      merged.hasLegalForm = true;
      merged.lineLength = Math.max(merged.lineLength ?? 0, 0.85);
    }
    if (hasLegalFormDomainEvidence(merged, text)) {
      merged.hasLegalForm = true;
      merged.emailDomainMatch = Math.max(merged.emailDomainMatch ?? 0, 0.98);
      merged.websiteDomainMatch = Math.max(merged.websiteDomainMatch ?? 0, 0.98);
      merged.crossPageAgreement = Math.max(merged.crossPageAgreement ?? 0, 0.9);
      merged.confidenceOcr = Math.max(merged.confidenceOcr ?? 0.5, 0.95);
    }
    if (isDescriptiveActivityLine(text)) {
      merged.hasCatalogKeyword = true;
      merged.hasRoleKeyword = true;
      merged.mutualExclusionPenalty = Math.max(merged.mutualExclusionPenalty ?? 0, 0.45);
    }
  }

  if (context.fieldKind === 'firstName' || context.fieldKind === 'lastName') {
    if ((merged.emailLocalPartMatch ?? 0) >= 0.7) {
      merged.confidenceOcr = Math.max(merged.confidenceOcr ?? 0.5, 0.82);
      merged.inFirstNameDict = true;
    }
    const raw = context.rawText.trim();
    if (raw && !merged.hasCatalogKeyword && !merged.hasRoleKeyword) {
      merged.isTitleCase = merged.isTitleCase || isTitleCase(raw);
      merged.isAllCaps = merged.isAllCaps || isAllCaps(raw);
    }
  }

  if (context.fieldKind === 'role') {
    const text = context.rawText.trim();
    if (ROLE_KEYWORD_REGEX.test(text)) {
      merged.hasRoleKeyword = true;
      merged.confidenceOcr = Math.max(merged.confidenceOcr ?? 0.5, 0.85);
    }
    if (text.length >= 8 && text.length <= 55 && !merged.hasEmailPattern && !merged.hasPhonePattern) {
      merged.tokenCount = Math.max(merged.tokenCount ?? 0, normalizeTokenCount(text.split(/\s+/).length));
    }
  }

  if (context.fieldKind === 'address' && context.value && typeof context.value === 'object') {
    const addr = context.value as Address;
    const completeness = addressCompletenessScore(addr);
    merged.tokenCount = completeness;
    merged.postalCodeValid = isValidItalianPostalCode(addr.postalCode);
    merged.provinceValid = isValidItalianProvince(addr.region);
    if (completeness >= 0.75) {
      merged.confidenceOcr = Math.max(merged.confidenceOcr ?? 0.5, 0.9);
    } else if (completeness <= 0.35) {
      merged.confidenceOcr = Math.min(merged.confidenceOcr ?? 0.5, 0.4);
    }
  }

  return merged;
}

export interface FeatureContribution {
  key: FeatureKey;
  label: string;
  contribution: number;
  rawValue: number | boolean | undefined;
}

/** Converte una feature in contributo numerico grezzo (prima dei pesi). */
export function featureToSignal(key: FeatureKey, value: FeatureVector[FeatureKey]): number | boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  return undefined;
}

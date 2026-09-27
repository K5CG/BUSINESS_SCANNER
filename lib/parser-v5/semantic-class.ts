import {
  COMMON_FIRST_NAMES,
  isCommonFirstName,
  matchTerminalLegalFormSuffix,
  ROLE_KEYWORD_REGEX,
  normalizeBrandKey,
  ITALIAN_CITY_NAMES,
  isItalianCityName,
  NON_PERSON_WORDS,
} from '../parser-engine/validators/dictionaries';
import { parsePersonNameFromLine, isBrandSloganPersonName } from '../parser-engine/validators/name';
import { normalizeFusedPersonLine, parseCapsSurnameFirstLine } from './person-token-split';
import { isCompanySloganClaimLine } from '../parser-engine/validators/role';
import {
  isProductCategoryTagline,
  isOcrFusedEmailLikeLine,
  isGenericBusinessCategoryWord,
  isExplicitContactFieldLine,
} from '../parser-engine/validators/company';
import { hasOcrBrandNoise } from '../parser-engine/validators/brand-normalizer';
import { validateEmail } from '../parser-engine/validators/email';
import { normalizeCountryCode } from '../address-format';

export type SemanticClass =
  | 'PERSON'
  | 'ROLE'
  | 'COMPANY_LEGAL'
  | 'COMPANY_BRAND'
  | 'ADDRESS'
  | 'LOCATION_LIST'
  | 'CERTIFICATION_BADGE'
  | 'PRODUCT_BRAND'
  | 'SLOGAN'
  | 'STRUCTURED_CONTACT'
  | 'UNKNOWN';

const CERTIFICATION_BADGE_RE =
  /^(?:gold|silver|platinum|partner|certified|reseller|premier|authorized|volume(?:\s+reseller)?)$/i;

const BADGE_LINE_RE =
  /\b(?:gold|silver|platinum)\s+partner\b|\b(?:sap|microsoft|oracle)\s+gold\b|\b(?:certified|authorized|premier)\s+partner\b|\bvolume\s+reseller\b/i;

const STRONG_ROLE_AS_COMPANY_RE =
  /^(?:dirigente|responsabile|presidente|partner|amministratore|amministratrice|titolare|socio|consulente|manager|director|president)$/i;

const ORGANIZATIONAL_UNIT_PERSON_RE =
  /\b(?:management|advisory|professional|business|corporate|strategy|strategic|technology|engineering|financial|operations?|human\s+resources?|talent|data|people|public|risk|change|enterprise)\s+(?:consultants?|consulting|services?|department|division|unit|office|team|practice|affairs|initiatives?|acquisition|science|culture|development|policy|compliance|management|architecture)\b/i;

export function isOrganizationalUnitIdentityLine(text: string): boolean {
  return ORGANIZATIONAL_UNIT_PERSON_RE.test(text);
}

const GLOBAL_OFFICE_LIST_RE =
  /\b(?:head\s+office|registered\s+office|corporate\s+office|global\s+office|sales\s+office|branch\s+office|headquarters?|hq|zentrale|hauptsitz|sede\s+centrale|si[eè]ge\s+(?:social|central))\b/i;

const MULTI_COUNTRY_RE =
  /\b(?:ireland|usa|germany|france|belgium|belgique|uk|korea|japan|china|pakistan)\b/gi;

const PROFESSIONAL_TITLE_FRAGMENT_RE =
  /^(?:avy|ing|avv|dott|geom|arch|prof|sig|dr)\.?$/i;

// "Dott.ssa in Diritto dell'Economia" è una qualifica, non un nominativo.
// Non intercetta invece "Dott.ssa Nome Cognome".
const ACADEMIC_QUALIFICATION_PERSON_RE =
  /^(?:dott\.?ssa?|dott\.?|dr\.?|prof\.?)\s+in\s+(?:[\p{L}'’-]+\s+){0,5}(?:diritto|giurisprudenza|law|economia|economics|scienz\w*|engineering|ingegneria|architettura|medicina|informatica|management)\b/iu;

const GREEK_ALPHABET_TOKEN_RE =
  /^(?:alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa|lambda|mu|nu|xi|omicron|pi|rho|sigma|tau|upsilon|phi|chi|psi|omega)$/i;

const GENERIC_CONTACT_OR_DEPARTMENT_TOKEN_RE =
  /^(?:info|contact|contatti|sales|vendite|commerciale|export|amministrazione|administration|admin|office|ufficio|segreteria|ordini|orders?|support|assistenza|service|customer(?:service)?|customerservice|marketing|hello|mail|posta|pec|webmaster|hr|jobs?|careers?|press|restaurant|shop|store|booking|bookings|reception|help|enquir(?:y|ies)|inquir(?:y|ies)|accounts?|billing|team|reservations?|projects?|quality|media|relations?|partnerships?|intelligence|communications?|procurement|finance|legal|design|research|cloud|product|operations?|engineering|department|division|formazione|training|education)$/i;

export function isGenericContactOrDepartmentToken(token: string): boolean {
  const normalized = token
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}]/gu, '');
  return Boolean(
    normalized &&
    GENERIC_CONTACT_OR_DEPARTMENT_TOKEN_RE.test(normalized)
  );
}

export function isGenericContactIdentityLine(text: string): boolean {
  const words = text
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}]/gu, ''))
    .filter(Boolean);
  return (
    words.length >= 2 &&
    words.length <= 3 &&
    words.some((word) => isGenericContactOrDepartmentToken(word))
  );
}

const LOCATION_LIST_TOKENS = new Set([
  ...ITALIAN_CITY_NAMES,
  'prato', 'villorba', 'schio', 'legnaro', 'treviso', 'milano', 'padova', 'bologna', 'roma', 'firenze',
  'napoli', 'torino', 'venezia', 'bergamo', 'verona', 'trieste', 'udine', 'ancona', 'parma', 'modena',
  'amsterdam', 'athens', 'barcelona', 'beijing', 'berlin', 'boston', 'brussels', 'bucharest',
  'budapest', 'chicago', 'copenhagen', 'delhi', 'doha', 'dubai', 'dublin', 'geneva', 'helsinki',
  'istanbul', 'lisbon', 'london', 'madrid', 'melbourne', 'montreal', 'mumbai', 'oslo', 'paris',
  'prague', 'riga', 'riyadh', 'rotterdam', 'seattle', 'seoul', 'shanghai', 'singapore', 'sofia',
  'stockholm', 'sydney', 'tallinn', 'tokyo', 'toronto', 'vancouver', 'vienna', 'vilnius', 'warsaw',
  'zurich',
]);

export function isKnownCityName(word: string): boolean {
  const norm = word
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]/g, '');
  return norm.length >= 3 && LOCATION_LIST_TOKENS.has(norm);
}

/** Conta token che sono città/località note. */
export function countKnownCityTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  let n = 0;
  for (const w of words) {
    if (isKnownCityName(w)) n += 1;
  }
  return n;
}

/** Lista di 3+ località → non è company. */
export function isLocationListLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 12) return false;
  const cityCount = countKnownCityTokens(t);
  if (cityCount >= 3) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 4 && cityCount >= 2 && !/\b(?:s\.?\s*r\.?\s*l|gmbh|spa|srl|snc)\b/i.test(t)) {
    return true;
  }
  if (/^(?:treviso|milano|padova|bologna|roma|firenze|napoli|torino|venezia)(?:\s+(?:treviso|milano|padova|bologna|roma|firenze|napoli|torino|venezia)){2,}/i.test(t)) {
    return true;
  }
  return false;
}

/** Badge certificazione (Gold, Partner, …) — non company. */
export function isCertificationBadgeLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 48) return false;
  if (BADGE_LINE_RE.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 1 && CERTIFICATION_BADGE_RE.test(words[0])) return true;
  if (words.length === 2 && words.every((w) => CERTIFICATION_BADGE_RE.test(w) || /^sap$/i.test(w))) {
    return true;
  }
  if (/^gold\s+certified$/i.test(t.replace(/\s+/g, ' '))) return true;
  if (/^(?:european|global|regional)\s+distributor$/i.test(t)) return true;
  if (/^cr[eé]dit\s+agricole$/i.test(t)) return true;
  if (/^soft(?:ware|vare)\s+evolution$/i.test(t)) return true;
  if (/^insurance\s+brokers?$/i.test(t)) return true;
  return false;
}

/** Titolo/certificazione professionale — non ragione sociale. */
export function isProfessionalCertificationCompanyLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 64) return false;
  if (/\bistruttore\b/i.test(t) && /\b(?:csen|livello|corso|1°|2°)\b/i.test(t)) return true;
  if (/\b(?:istruttore|formatore|docente)\b/i.test(t) && !/\b(?:s\.?\s*r\.?\s*l|srl|spa|gmbh|ltd)\b/i.test(t)) {
    return t.split(/\s+/).length <= 6;
  }
  return false;
}

/** Ruolo isolato scelto come company (Dirigente, Partner, …). */
export function isRoleWordAsCompany(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  if (STRONG_ROLE_AS_COMPANY_RE.test(t)) return true;
  if (ROLE_KEYWORD_REGEX.test(t) && !/\b(?:s\.?\s*r\.?\s*l|gmbh|spa|srl|snc|s\.?\s*p\.?\s*a)\b/i.test(t)) {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length <= 3) return true;
  }
  return false;
}

/** Slogan / frase grammaticale → non persona. */
export function isSloganAsPersonLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isCompanySloganClaimLine(t)) return true;
  if (/^per\s+[a-zà-ü]{4,}/i.test(t)) return true;
  if (/^formazione\s+(?:e|per)\s+/i.test(t)) return true;
  const parsed = parsePersonNameFromLine(t);
  if (!parsed) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 2 && /^per$/i.test(words[0])) return true;
  if (words.every((w) => /^[a-zà-ü]+$/.test(w)) && words.some((w) => /(?:ormazione|orientamento|formazione)/i.test(w))) {
    return true;
  }
  return false;
}

/** OCR logo/tecnico non plausibile come persona. */
export function isLogoNoisePersonLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 5 || t.length > 24) return false;
  if (parsePersonNameFromLine(t)) return false;
  if (/@|www\.|http/i.test(t)) return false;
  const letters = t.replace(/[^a-zà-ü]/gi, '');
  if (letters.length < 5) return false;
  const vowels = (letters.match(/[aeiouàèéìòùAEIOU]/g) ?? []).length;
  const vowelRatio = vowels / letters.length;
  if (vowelRatio < 0.22 && letters.length >= 6) return true;
  if (/^[A-Z]{5,}$/.test(t) && vowelRatio < 0.3) return true;
  if (/^(?:teghnig|tehnigl|toughk|hinsson|kyb|tmi)$/i.test(normalizeBrandKey(t))) return true;
  return false;
}

/** Frammento titolo professionale finito nel nome (Avy ← Avv.). */
export function stripProfessionalTitleFragment(firstName: string, lastName: string): {
  firstName: string;
  lastName: string;
} {
  let first = firstName.trim();
  let last = lastName.trim();
  const firstParts = first.split(/\s+/).filter(Boolean);
  if (firstParts.length >= 2 && PROFESSIONAL_TITLE_FRAGMENT_RE.test(firstParts[0])) {
    first = firstParts.slice(1).join(' ');
  }
  if (PROFESSIONAL_TITLE_FRAGMENT_RE.test(first)) {
    first = '';
  }
  return { firstName: first, lastName: last };
}

/** Company candidate da scartare per classe semantica. */
export function shouldRejectCompanyCandidate(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (isExplicitContactFieldLine(t)) return true;
  if (/^(?:e-?\s*mail|pec|cmail)\s*[.:\-]/i.test(t)) return true;
  if (hasOcrBrandNoise(t)) return true;
  if (isGenericBusinessCategoryWord(t)) return true;
  if (/\+\d{2,}|\b(?:tel|fax|mob)\b|\b\d{3}[\s.\-]\d{3}/i.test(t)) return true;
  const fragWords = t.split(/\s+/).filter(Boolean);
  if (
    !matchTerminalLegalFormSuffix(t) &&
    fragWords.length === 2 &&
    fragWords[0]!.replace(/[^A-Za-z0-9]/g, '').length <= 2
  ) {
    return true;
  }
  if (isProductCategoryTagline(t)) return true;
  if (!matchTerminalLegalFormSuffix(t) && isCompanySloganClaimLine(t)) {
    return true;
  }
  if (isOcrFusedEmailLikeLine(t)) return true;
  if (isLocationListLine(t)) return true;
  if (isCertificationBadgeLine(t)) return true;
  if (isProfessionalCertificationCompanyLine(t)) return true;
  if (isRoleWordAsCompany(t)) return true;
  if (isLegalFormOnlyCompanyLine(t)) return true;
  if (isMarketingSloganCompanyLine(t)) return true;
  if (hasAddressFragmentInCompany(t)) return true;
  if (isItalianCityName(t) && t.split(/\s+/).length === 1) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 1 && isKnownCityName(words[0]!)) return true;
  if (words.length === 1 && isCommonFirstName(words[0]!.toLowerCase())) return true;
  if (/\b(?:skype|www\.|https?:\/\/)\b/i.test(t)) return true;
  if (/\bskype\s*:/i.test(t)) return true;
  return false;
}

/** Riga prodotto/marchio commerciale (TMIMOTORBIKE ND., …) — non persona. */
export function isProductBrandLineAsPerson(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 6) return false;
  const compact = t.replace(/[^A-Za-zÀ-ÿ]/gi, '').toLowerCase();
  if (COMMON_FIRST_NAMES.has(compact)) return false;
  if (/\b(?:motorbike|motorcycle|industries|importers?|exporters?|distributor|manufacturer)\b/i.test(t)) {
    return true;
  }
  if (/\b(?:ind|nd|ltd|inc|gmbh|bvba|s\.?r\.?l)\.?$/i.test(t)) return true;
  // Solo token unico (TMIMOTORBIKE): COGNOME NOME su due parole resta persona.
  if (!/\s/.test(t) && /^[A-Z][A-Z0-9]{6,}$/.test(t)) return true;
  return false;
}

/** Riga persona corroborata da un ruolo sulla riga successiva. */
export function isLikelyPersonNameAboveRoleLine(
  text: string,
  nextLineText?: string | null
): boolean {
  if (!text?.trim() || !nextLineText?.trim()) return false;
  if (!ROLE_KEYWORD_REGEX.test(nextLineText)) return false;
  if (parseCapsSurnameFirstLine(text)) return true;
  const normalized = normalizeFusedPersonLine(text);
  if (parseCapsSurnameFirstLine(normalized)) return true;
  const parsed =
    parsePersonNameFromLine(normalized) ?? parsePersonNameFromLine(text);
  if (!parsed?.firstName || !parsed.lastName) return false;
  const firstCore = parsed.firstName.replace(/\./g, '').trim();
  if (firstCore.length <= 1 && parsed.lastName.length >= 6) {
    const fused = parsePersonNameFromLine(normalized);
    return (fused?.firstName.replace(/\./g, '').trim().length ?? 0) > 1;
  }
  return firstCore.length >= 2;
}

const INSTITUTION_OR_CITY_TOKEN =
  /\b(?:university|college|division|department|dipartimento|faculty|facolt[aà]|metropolitan|institute|istituto|instituto|school|polytechnic|pol[iu]tecnic[oa]|boston|admissions|outreach|education)\b/i;

const ROMAN_NUMERAL_LINE = /^\s*[IVXLCDM]{2,}\s*$/i;

/** Frammento istituzionale OCR (università, divisioni) — non persona. */
export function isInstitutionalOcrPersonGarbage(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 6) return false;
  if (INSTITUTION_OR_CITY_TOKEN.test(t)) return true;
  if (ROMAN_NUMERAL_LINE.test(t) && t.replace(/\s+/g, '').length <= 16) return true;
  const letters = t.replace(/[^a-zà-ü]/gi, '');
  if (letters.length >= 6) {
    const vowels = (letters.match(/[aeiouàèéìòù]/gi) ?? []).length;
    if (vowels / letters.length < 0.2) return true;
  }
  if (/^[A-Z]{6,}$/.test(t.replace(/\s+/g, '')) && !parsePersonNameFromLine(t)) {
    if (!isCommonFirstName(t.toLowerCase())) return true;
  }
  const words = t.split(/\s+/).filter(Boolean);
  if (
    words.length === 2 &&
    words.every((w) => /^[A-Z]{4,}$/.test(w)) &&
    !words.some((w) => isCommonFirstName(w.toLowerCase()))
  ) {
    const joined = words.join('');
    const vowels = (joined.match(/[AEIOU]/gi) ?? []).length;
    if (vowels / joined.length < 0.25) return true;
  }
  return false;
}

/** Persona = token splittati dalla ragione sociale (EXHAUST / SYSTÈM). */
export function isPersonDuplicateOfCompany(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  company: string | null | undefined
): boolean {
  const fn = normalizeBrandKey(firstName ?? '');
  const ln = normalizeBrandKey(lastName ?? '');
  const co = normalizeBrandKey(company ?? '');
  if (!fn || !ln || !co) return false;
  if (`${fn}${ln}` === co || `${fn} ${ln}` === co.replace(/\s+/g, ' ')) return true;
  const words = (company ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 5) {
    const w0 = normalizeBrandKey(words[0]);
    const w1 = normalizeBrandKey(words[1]);
    if (fn === w0 && ln === w1) return true;
  }
  return false;
}

/** Cognome = nome senza evidenza (Filippo / Filippo). */
export function isDuplicateGivenNameAsSurname(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): boolean {
  const fn = normalizeBrandKey(firstName ?? '');
  const ln = normalizeBrandKey(lastName ?? '');
  return Boolean(fn && ln && fn === ln && fn.length >= 3);
}

/** Solo forma giuridica — non company. */
export function isLegalFormOnlyCompanyLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 48) return false;
  if (/^\(?\s*private\s*\)?\s*limited$/i.test(t)) return true;
  if (/^(?:private|limited|ltd|llc|inc|gmbh|ag|srl|spa|snc|sas|bvba)$/i.test(t)) return true;
  if (/^\([^)]{3,30}\)\s*(?:limited|ltd)$/i.test(t)) return true;
  return false;
}

/** Slogan marketing — non company. */
export function isMarketingSloganCompanyLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\ba\s+knowledge\s+company\b/i.test(t)) return true;
  if (/\b(?:next\s+generation|customer\s+oriented|global\s+enterprise)\s+(?:platform|solutions?)\b/i.test(t)) return true;
  // Trade-activity banners often OCR as the company name (not the brand).
  if (/\bmanufacturers?\b/i.test(t) && /\bimporters?\b/i.test(t) && /\bexporters?\b/i.test(t)) {
    return true;
  }
  const words = t.split(/\s+/).filter(Boolean);
  const startsWithPromotionalImperative =
    /^(?:inspire|imagine|discover|empower|transform|connect|create|shape|drive|unlock|accelerate|simplify|elevate|experience|rethink|explore|enable)\b/i.test(
      t
    );
  const hasPromotionalObject =
    /\b(?:the|your|our|future|tomorrow|next|better|beyond|possibilit(?:y|ies)|success|difference|world)\b/i.test(
      t
    );
  if (
    words.length >= 3 &&
    words.length <= 8 &&
    startsWithPromotionalImperative &&
    hasPromotionalObject
  ) {
    return true;
  }
  return false;
}

/** Frammento indirizzo finito in company (Blocco 38 Bis). */
export function hasAddressFragmentInCompany(text: string): boolean {
  return /\b(?:blocco|block|p\.?\s*za|piazza|via|viale|corso|z\.?\s*i\.?)\b/i.test(text) &&
    /\b(?:\d{1,4}\s*(?:bis|ter|quater)?)\b/i.test(text);
}

/** Company = dominio email senza forma legale. */
export function isDomainRootAsCompany(company: string, emails: string[] = []): boolean {
  const co = normalizeBrandKey(company);
  if (!co || co.length < 5) return false;
  if (/\b(?:s\.?\s*r\.?\s*l|srl|spa|gmbh|ltd|llc|inc|snc)\b/i.test(company)) return false;
  for (const email of emails) {
    const dom = email.split('@')[1]?.toLowerCase().trim();
    if (!dom) continue;
    const root = normalizeBrandKey(dom.split('.')[0] ?? '');
    if (root.length >= 5 && (co === root || co.includes(root) || root.includes(co))) {
      return true;
    }
  }
  return false;
}

function hasExplicitInstitutionalPersonEvidence(text: string): boolean {
  const t = text.trim();
  return (
    INSTITUTION_OR_CITY_TOKEN.test(t) ||
    (ROMAN_NUMERAL_LINE.test(t) &&
      t.replace(/\s+/g, '').length <= 16)
  );
}

function shouldRejectPersonCandidateSemantics(text: string): boolean {
  if (!text?.trim()) return true;
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (ACADEMIC_QUALIFICATION_PERSON_RE.test(trimmed)) return true;
  if (/^(?:canale|channel)\s+(?:italia|italy|tv|radio)\b/i.test(trimmed)) return true;
  if (matchTerminalLegalFormSuffix(trimmed)) {
    return true;
  }
  if (
    words.some((word) => {
      const key = normalizeBrandKey(word);
      return (
        NON_PERSON_WORDS.has(key) ||
        isGenericBusinessCategoryWord(word)
      );
    })
  ) {
    return true;
  }
  if (isGenericContactIdentityLine(trimmed)) {
    return true;
  }
  if (/^(?:net|gross)\s+weight\b/i.test(trimmed)) {
    return true;
  }
  if (
    words.length === 2 &&
    words.every((word) => GREEK_ALPHABET_TOKEN_RE.test(word))
  ) {
    return true;
  }
  const twoTokenStreet = trimmed.match(
    /^([\p{L}'’.-]+)\s+(?:street|road|avenue|boulevard|lane|drive)$/iu
  );
  if (
    (twoTokenStreet &&
      !COMMON_FIRST_NAMES.has(normalizeBrandKey(twoTokenStreet[1]!))) ||
    (/\d/.test(trimmed) &&
      /\b(?:via|viale|piazza|corso|vicolo|strada|street|road|avenue|boulevard|lane|drive)\b/i.test(
        trimmed
      ))
  ) {
    return true;
  }
  if (/^[A-Z]{2,4}$/.test(trimmed) && !isCommonFirstName(trimmed.toLowerCase())) {
    return true;
  }
  if (words.length === 1 && isKnownCityName(words[0])) {
    return true;
  }
  if (normalizeCountryCode(trimmed)) {
    return true;
  }
  if (ORGANIZATIONAL_UNIT_PERSON_RE.test(text)) {
    return true;
  }
  if (/\b(?:head|office|signature|firma|sede|commerciale|administration|center|senter|centro|unipersonale)\b/i.test(text)) {
    return true;
  }
  if (isSloganAsPersonLine(text)) {
    return true;
  }
  if (isProductBrandLineAsPerson(text)) {
    return true;
  }
  if (/^for\s+[a-zA-ZÀ-ÿ]{3,}/i.test(text.trim())) {
    return true;
  }
  if (isLocationListLine(text)) {
    return true;
  }
  if (isCertificationBadgeLine(text)) {
    return true;
  }
  if (/@|www\.|https?:\/\//i.test(text)) {
    return true;
  }
  if (/\bskype\b/i.test(text)) {
    return true;
  }
  const parsed = parsePersonNameFromLine(text);
  if (parsed && isBrandSloganPersonName(parsed.firstName, parsed.lastName)) {
    return true;
  }
  return false;
}

/** Person candidate da scartare. */
export function shouldRejectPersonCandidate(text: string): boolean {
  return (
    shouldRejectPersonCandidateSemantics(text) ||
    isLogoNoisePersonLine(text) ||
    isInstitutionalOcrPersonGarbage(text)
  );
}

/**
 * Una repair non confermata può soltanto disambiguare due token già osservati
 * integralmente. In quel caso non usiamo euristiche fonetiche o lessici di
 * nomi, ma continuiamo a rifiutare ruoli, indirizzi e classi non-persona
 * esplicite.
 */
export function shouldRejectCorroboratedObservedPersonCandidate(
  text: string
): boolean {
  const t = text.trim();
  if (shouldRejectPersonCandidateSemantics(t)) return true;
  if (hasExplicitInstitutionalPersonEvidence(t)) return true;
  if (ROLE_KEYWORD_REGEX.test(t)) return true;
  if (
    /\b(?:building|suite|floor|office)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** Blocco indirizzo globale multi-sede (retro biglietto). */
export function isGlobalOfficeAddressBlock(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (GLOBAL_OFFICE_LIST_RE.test(t)) return true;
  const countries = t.match(MULTI_COUNTRY_RE) ?? [];
  const uniqueCountries = new Set(countries.map((c) => c.toLowerCase()));
  if (uniqueCountries.size >= 2) return true;
  const cityLines = (t.match(/\b(?:frankfurt|paris|dublin|san francisco|lommel|sialkot)\b/gi) ?? []).length;
  if (cityLines >= 2) return true;
  return false;
}

/** Città = cognome già noto → invalido. */
export function isCityMatchingPersonSurname(city: string | undefined, lastName: string | undefined): boolean {
  if (!city?.trim() || !lastName?.trim()) return false;
  const cityKey = normalizeBrandKey(city);
  const lastKey = normalizeBrandKey(lastName.split(/\s+/).pop() ?? lastName);
  if (!cityKey || !lastKey || cityKey.length < 3) return false;
  return cityKey === lastKey || (lastKey.length >= 4 && cityKey.includes(lastKey));
}

/** Email OCR senza @ — scarta. */
export function sanitizeStructuredEmails(emails: string[]): string[] {
  const out: string[] = [];
  for (const raw of emails) {
    const trimmed = raw.trim();
    if (!trimmed.includes('@')) continue;
    const valid = validateEmail(trimmed);
    if (valid) out.push(valid);
  }
  return out;
}

/**
 * Validazione finale parser-v5 — riusa i validator condivisi del motore.
 */
import type { Address } from '../../types';
import { hasStrongNumberedStreetStructure } from '../address-format';
import { validateFinalAddress } from '../parser-engine/validators/address';
import {
  alignCompanyToEmailDomain,
  isDomainOnlyCompanyValue,
  isProviderDerivedCompanyName,
  isPreservableCompanyCandidate,
  isRejectedCompanyValue,
  pickOrganizationHeaderFromEvidence,
  recoverBrandWhenHostingEmail,
  recoverCompoundBrandFromAdjacentOcrLines,
  recoverOcrHeaderBrand,
  recoverStackedBrandLinesFromWebsite,
  resolveOrganizationFromOcr,
  sanitizeCompanyValue,
  shouldPreferEmailBrandOverCompany,
} from '../parser-engine/validators/company';
import { normalizeOcrBrandValue, resolveBrandFromEmailDomain } from '../parser-engine/validators/brand-normalizer';
import {
  ROLE_KEYWORD_REGEX,
  COMMON_FIRST_NAMES,
  LEGAL_FORM_PATTERN_SOURCE,
  hasAmbiguousTerminalLegalSeparator,
  hasLegalForm,
  hasTerminalLegalFormSuffix,
  isAmbiguousTerminalLegalPhrase,
  isCommonFirstName,
  isItalianCityName,
  matchTerminalLegalFormSuffix,
  normalizeBrandKey,
  levenshteinDistance,
} from '../parser-engine/validators/dictionaries';
import { canonicalizeKnownLegalForm, isKnownLegalFormTypography } from '../parser-engine/validators/legal-form-catalog';
import {
  isClaimLikeTerminalLegalPhrase,
  isCompanySloganClaimLine,
} from '../parser-engine/validators/role';
import { isProductCategoryTagline } from '../parser-engine/validators/company';
import { parsePersonNameFromLine, parseNameFromEmailLocal, validatePersonName } from '../parser-engine/validators/name';
import { stripProfessionalTitleFragment, shouldRejectCompanyCandidate, shouldRejectPersonCandidate, shouldRejectCorroboratedObservedPersonCandidate, isRoleWordAsCompany, isSloganAsPersonLine, isLogoNoisePersonLine, isCertificationBadgeLine, isPersonDuplicateOfCompany, isDuplicateGivenNameAsSurname, isDomainRootAsCompany, isProductBrandLineAsPerson, isInstitutionalOcrPersonGarbage, isMarketingSloganCompanyLine } from './semantic-class';
import { reconcilePersonWithEmailEvidence } from './person-email-reconcile';
import {
  hasExactObservedPersonalEmailEvidence,
  parseExactObservedPersonFromEmail,
  parseOrderedObservedPersonFromPersonalEmail,
  personEmailAffinityScore,
  recoverPersonMatchingPersonalEmail,
  primaryPersonalEmail,
} from './person-email-ownership';
import { recoverPersonOnBrandOnlyCard } from './brand-only-person';
import { normalizeFusedPersonLine } from './person-token-split';
import { isOcrRoleGarbage } from './role-quality';
import {
  getPrimaryBusinessEmailDomain,
  resolveExplicitWebsiteFromText,
  resolveWebsiteWithPrimaryEmailDomain,
  validateWebsite,
} from '../parser-engine/validators/website';
import { isGenericProviderDomain } from '../parser-engine/extractors/website';
import type { V5AddressParts } from './engine';
import { splitFusedDomainBrand } from './company-normalize';
import {
  extractBusinessDomainRoot,
  extractBusinessDomainRootCandidates,
} from '../parser-engine/validators/brand-domain';
import {
  collectEmailEvidence,
  observedEmailValues,
} from './email-evidence';

const LEGAL_RE = new RegExp(
  `(?:\\b|(?=[\\u3040-\\u30ff\\u3400-\\u9fff\\uac00-\\ud7af]))${LEGAL_FORM_PATTERN_SOURCE}(?=[\\s.,;:)]|$)`,
  'iu'
);

const ACTIVITY_RE =
  /\b(?:soluzioni?|solutions?|servizi|services?|systems?|sistemi|software|hardware|consulting|consulenz[ae]|tecnolog\w+|technolog\w+|informatic[ao]|engineering|ingegneria|automazione|impianti|logistica|packaging|comunicazione|design|web|digital|management|marketing|innovation|innovativ\w+|quality|qualit[aà]|group|gruppo|international)\b/i;

function isExactCommonFirstName(value: string): boolean {
  return COMMON_FIRST_NAMES.has(normalizeBrandKey(value));
}

function hasPositiveObservedPersonEvidence(
  line: string,
  firstName: string,
  lastName: string,
  emails: string[]
): boolean {
  if (isExactCommonFirstName(firstName)) return true;
  if (personEmailAffinityScore(firstName, lastName, emails) >= 3) return true;
  return /^(?:(?:dott|dott\.ssa|dr|prof|avv|ing|arch|geom|rag|sig|sig\.ra)\.?\s+)/i.test(
    line.trim()
  );
}

const CONTACT_IN_COMPANY_RE =
  /\b(?:tel\.?|fax|telefono|phone|mob\.?|cell|e-?mail|mail|www\.|https?:\/\/|@)\b/i;

export function finalizeWebsiteValue(
  emails: string[],
  website: string | null | undefined
): { value: string | null; reasons: string[] } {
  const before = validateWebsite(website ?? undefined);
  const value = resolveWebsiteWithPrimaryEmailDomain(before, emails);
  const reasons: string[] = [];
  if (!value) return { value: null, reasons };
  if (!before || before !== value) reasons.push('validato/coerente con email');
  if (before && before !== value) reasons.push('sostituito host OCR invalido');
  return { value, reasons };
}

export function finalizeAddressParts(parts: V5AddressParts | null): V5AddressParts | null {
  if (!parts) return null;
  const draft: Address = {
    full: parts.full,
    street: parts.street,
    civicNumber: parts.civicNumber,
    postalCode: parts.postalCode,
    city: parts.city,
    region: parts.region,
    country: parts.country,
  };
  const validated = validateFinalAddress(draft);
  if (!validated) return null;
  // I blocchi universali hanno gia superato i guardrail address-like: il full
  // osservato resta intatto, mentre i componenti strutturati sono validati.
  const full = parts.rawLines?.length ? parts.full : validated.full ?? parts.full;
  if (!full) return null;
  const preserveUniversalParts = Boolean(parts.rawLines?.length);
  const selectedStreet = preserveUniversalParts ? parts.street ?? validated.street : validated.street;
  const selectedCivic = preserveUniversalParts ? parts.civicNumber ?? validated.civicNumber : validated.civicNumber;
  // Nelle address internazionali "2F, ..." / "10F, ..." indica il piano,
  // non il civico. Non duplicarlo nel campo civicNumber.
  const civicNumber =
    selectedCivic &&
    /^\d{1,3}F$/i.test(selectedCivic) &&
    /^\s*\d{1,3}F(?:\s|,)/i.test(selectedStreet ?? full)
      ? undefined
      : selectedCivic;
  return {
    full,
    street: selectedStreet,
    civicNumber,
    postalCode: preserveUniversalParts ? parts.postalCode ?? validated.postalCode : validated.postalCode,
    city: preserveUniversalParts ? parts.city ?? validated.city : validated.city,
    region: preserveUniversalParts ? parts.region ?? validated.region : validated.region,
    country: preserveUniversalParts ? parts.country ?? validated.country : validated.country,
    completeness: parts.completeness,
    partial: parts.partial,
    rawLines: parts.rawLines,
    sourceLineIds: parts.sourceLineIds,
    page: parts.page,
    order: parts.order,
    addressType: parts.addressType,
    confidence: parts.confidence,
    requiresReview: parts.requiresReview,
  };
}

const INSTITUTIONAL_ORG_RE =
  /\b(?:universit[aà\u00e0\u00e4\u00fc][rT]?|universit[eé]|universidade|universidad|faculdade|faculd|college|istituto|instituto|politecnico|politenico|scuola\s+(?:superiore|normale)|libera\s+cattedra|fondazione|azienda\s+(?:ospedaliera|sanitaria|unità)|unità\s+locale|ulss|ulss\d|servizio\s+sanitario|ospedale|ministero|comune\s+di|provincia\s+di|regione\s+(?:del|della|di)?|ente\s+(?:locale|pubblico)|camera\s+di\s+commercio|ordine\s+(?:dei|degli)|fondazione)\b/i;

function isCompanySloganOnly(value: string): boolean {
  const t = sanitizeCompanyValue(value);
  if (!t) return true;
  // Nomi istituzionali/accademici → mai slogan
  if (INSTITUTIONAL_ORG_RE.test(t)) return false;
  // Le sigle terminali brevi (AS, SA, AG, ...) non provano da sole che la
  // riga sia una società: senza corroborazione restano testo ambiguo.
  if (isAmbiguousTerminalLegalPhrase(t)) return true;
  // Una forma giuridica osservata rende la riga una ragione sociale, anche
  // quando il nome contiene parole di attività come "consulting".
  if (hasTerminalLegalFormSuffix(t)) return false;
  if (isProductCategoryTagline(t)) return true;
  if (isCompanySloganClaimLine(t)) return true;
  if (isMarketingSloganCompanyLine(t)) return true;
  if (/\b(?:resto|difficile)\b/i.test(t) && t.split(/\s+/).length >= 2) return true;
  if (CONTACT_IN_COMPANY_RE.test(t)) return true;
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 3 && ACTIVITY_RE.test(t)) return true;
  if (/[|/]/.test(t) && ACTIVITY_RE.test(t)) return true;
  return false;
}

function observedPersonFromRawLine(
  rawLine: string | null | undefined,
  emails: string[] = [],
  company?: string | null
): { firstName: string; lastName: string } | null {
  const raw = rawLine?.trim().replace(/[’‘´]/g, "'") ?? '';
  if (!raw || shouldRejectPersonCandidate(raw) || isInstitutionalOcrPersonGarbage(raw)) {
    return null;
  }

  const rawWords = raw
    .replace(/[.,;:]+$/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (
    rawWords.length < 2 ||
    rawWords.length > 4 ||
    !rawWords.every((word) => /^\p{Lu}[\p{Ll}\p{M}'`-]+$/u.test(word))
  ) {
    return null;
  }

  const parsed = parsePersonNameFromLine(raw);
  if (!parsed?.firstName || !parsed.lastName) return null;
  const observedOrder = {
    firstName: rawWords[0]!,
    lastName: rawWords.slice(1).join(' '),
  };
  const validated = validatePersonName(observedOrder);
  if (!validated?.firstName || !validated.lastName) return null;

  const parsedKeys = [
    normalizeBrandKey(parsed.firstName),
    normalizeBrandKey(parsed.lastName),
  ].sort();
  const observedKeys = [
    normalizeBrandKey(validated.firstName),
    normalizeBrandKey(validated.lastName),
  ].sort();
  if (parsedKeys.join('|') !== observedKeys.join('|')) return null;
  if (
    isNameContaminatedByEmail(validated.firstName, validated.lastName, emails) ||
    isSurnameFragmentOfEmailDomain(validated.lastName, emails) ||
    isPersonDuplicateOfCompany(validated.firstName, validated.lastName, company)
  ) {
    return null;
  }

  return {
    firstName: validated.firstName,
    lastName: validated.lastName,
  };
}

function isNameContaminatedByEmail(
  first: string | null | undefined,
  last: string | null | undefined,
  emails: string[] = []
): boolean {
  const firstParts = (first ?? '')
    .split(/\s+/)
    .map((p) => normalizeBrandKey(p.replace(/\./g, '')))
    .filter(Boolean);
  const lastKey = normalizeBrandKey(last ?? '');
  const hasGivenNameBeyondBrand =
    firstParts.length >= 1 &&
    firstParts.some((p) => p.length >= 3 || (p.length === 1 && /^[a-z]$/i.test(p))) &&
    (!lastKey || !firstParts.every((p) => p === lastKey));

  const parts = [first, last].map((p) => normalizeBrandKey(p ?? ''));
  for (const email of emails) {
    const domain = email.split('@')[1]?.toLowerCase().trim();
    if (!domain || isGenericProviderDomain(domain)) continue;
    const root = normalizeBrandKey(domain.split('.')[0] ?? '');
    if (!root || root.length < 4) continue;
    const contaminated = parts.some((p) => p && (p === root || p.includes(root) || root.includes(p)));
    if (contaminated && hasGivenNameBeyondBrand) continue;
    if (contaminated) return true;
  }
  return false;
}

function repairDiOwnerNameFields(
  first: string | null | undefined,
  last: string | null | undefined
): { firstName: string | null; lastName: string | null } | null {
  const f = (first ?? '').trim();
  const l = (last ?? '').trim();
  const diLead = f.match(/^Di\s+(.+)$/i);
  if (diLead && l) {
    return { firstName: l, lastName: diLead[1].trim() };
  }
  return null;
}

function extractEmailSurnameToken(emails: string[] = []): string | null {
  for (const email of emails) {
    const fromEmail = parseNameFromEmailLocal(email);
    if (fromEmail?.lastName) return fromEmail.lastName;
  }
  return null;
}

/** Cognome OCR che coincide con un frammento del dominio aziendale. */
function isSurnameFragmentOfEmailDomain(last: string, emails: string[] = []): boolean {
  const lastKey = normalizeBrandKey(last);
  if (!lastKey || lastKey.length < 4) return false;
  for (const email of emails) {
    const domain = email.split('@')[1]?.toLowerCase().trim();
    if (!domain || isGenericProviderDomain(domain)) continue;
    const root = normalizeBrandKey(domain.split('.')[0] ?? '');
    if (root.length >= 6 && root.includes(lastKey) && lastKey.length <= root.length - 2) {
      return true;
    }
  }
  return false;
}

function repairSurnameFromEmailLocal(
  first: string | null | undefined,
  last: string | null | undefined,
  emails: string[] = []
): { firstName: string | null; lastName: string | null } | null {
  const firstTrim = (first ?? '').trim();
  if (!firstTrim) return null;
  const lastTrim = (last ?? '').trim();
  const emailSurname = extractEmailSurnameToken(emails);
  if (!emailSurname) return null;
  if (lastTrim && normalizeBrandKey(lastTrim) === normalizeBrandKey(emailSurname)) return null;

  const shouldRepair =
    !lastTrim ||
    lastTrim.length < 2 ||
    isSurnameFragmentOfEmailDomain(lastTrim, emails);

  if (!shouldRepair) return null;

  const repaired = validatePersonName({
    firstName: firstTrim,
    lastName: emailSurname,
  });
  if (repaired) {
    return { firstName: repaired.firstName || null, lastName: repaired.lastName || null };
  }
  return null;
}

function emailLocalNameParts(email: string): string[] {
  return (email.split('@')[0] ?? '').split(/[._-]+/).filter((p) => p.length >= 1);
}

function repairSurnameTypoFromEmailLocal(
  first: string | null | undefined,
  last: string | null | undefined,
  emails: string[] = []
): { firstName: string | null; lastName: string | null } | null {
  const firstTrim = (first ?? '').trim();
  const lastTrim = (last ?? '').trim();
  if (!firstTrim || !lastTrim) return null;
  const lastKey = normalizeBrandKey(lastTrim);
  const firstKey = normalizeBrandKey(firstTrim);
  for (const email of emails) {
    const parts = emailLocalNameParts(email);
    if (parts.length >= 2) {
      const emailFirstKey = normalizeBrandKey(parts[0]);
      const emailLastKey = normalizeBrandKey(parts[parts.length - 1]);
      if (emailFirstKey === firstKey && emailLastKey === lastKey) return null;
      if (
        emailFirstKey === firstKey &&
        emailLastKey !== firstKey &&
        levenshteinDistance(lastKey, emailLastKey) <= 1
      ) {
        const repaired = validatePersonName({
          firstName: firstTrim,
          lastName: parts[parts.length - 1].charAt(0).toUpperCase() + parts[parts.length - 1].slice(1).toLowerCase(),
        });
        if (repaired?.lastName && normalizeBrandKey(repaired.lastName) !== firstKey) {
          return { firstName: repaired.firstName || null, lastName: repaired.lastName || null };
        }
      }
    }
    const localPart = parts[0]?.trim();
    if (!localPart || localPart.length < 4) continue;
    const localKey = normalizeBrandKey(localPart);
    if (!localKey) continue;
    if (parts.length >= 2 && localKey === firstKey) continue;
    if (localKey !== lastKey && levenshteinDistance(localKey, lastKey) <= 1) {
      const preferred = localPart.length <= lastTrim.length ? localPart : lastTrim;
      const repaired = validatePersonName({
        firstName: firstTrim,
        lastName: preferred.charAt(0).toUpperCase() + preferred.slice(1).toLowerCase(),
      });
      if (
        repaired?.lastName &&
        normalizeBrandKey(repaired.lastName) !== firstKey
      ) {
        return { firstName: repaired.firstName || null, lastName: repaired.lastName || null };
      }
    }
    if (localKey === lastKey && localPart.length >= 6) {
      for (let i = 1; i < localPart.length - 1; i += 1) {
        if (!/[aeiouàèéìòù]/i.test(localPart[i])) continue;
        if (!/[aeiouàèéìòù]/i.test(localPart[i - 1])) continue;
        const candidate = localPart.slice(0, i) + localPart.slice(i + 1);
        if (normalizeBrandKey(candidate) === lastKey) continue;
        const repaired = validatePersonName({
          firstName: firstTrim,
          lastName: candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase(),
        });
        if (repaired?.lastName && levenshteinDistance(normalizeBrandKey(repaired.lastName), lastKey) === 1) {
          return { firstName: repaired.firstName || null, lastName: repaired.lastName || null };
        }
      }
    }
  }
  return null;
}

function recoverPersonFromCapsAndEmailLocal(
  rawText: string | undefined,
  emails: string[] = []
): { firstName: string; lastName: string } | null {
  const personal = primaryPersonalEmail(emails);
  if (!personal || !rawText?.trim()) return null;
  const fromEmail = parseNameFromEmailLocal(personal);
  const lnKey = normalizeBrandKey(fromEmail?.lastName ?? '');
  if (!lnKey || lnKey.length < 4) return null;

  let firstCaps: string | null = null;
  let lastCaps: string | null = null;
  for (const line of rawText.split('\n')) {
    const t = line.trim();
    if (!t || t.length < 4 || t.length > 24) continue;
    if (/@|www\.|https?:|tel|fax/i.test(t)) continue;
    const phoneName = t.match(/(?:\d[\d.\s-]{6,})\s+([A-ZÀ-Ü]{3,})\s*$/);
    if (phoneName) {
      const observedFirst = phoneName[1]!;
      if (isExactCommonFirstName(observedFirst)) {
        firstCaps =
          observedFirst.charAt(0).toUpperCase() +
          observedFirst.slice(1).toLowerCase();
      }
      continue;
    }
    if (/\d{3}|[.]/.test(t)) continue;
    const key = normalizeBrandKey(t);
    if (key === lnKey || key.includes(lnKey) || lnKey.includes(key)) {
      lastCaps = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    } else if (/^[A-ZÀ-Ü]{4,}$/.test(t)) {
      if (isExactCommonFirstName(t)) {
        firstCaps = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
      }
    }
  }
  if (firstCaps && lastCaps) {
    const validated = validatePersonName({ firstName: firstCaps, lastName: lastCaps });
    if (validated?.firstName && validated.lastName) {
      return { firstName: validated.firstName, lastName: validated.lastName };
    }
  }
  if (fromEmail?.firstName && fromEmail.lastName) {
    return { firstName: fromEmail.firstName, lastName: fromEmail.lastName };
  }
  if (fromEmail?.lastName && firstCaps && lastCaps) {
    return { firstName: firstCaps, lastName: lastCaps };
  }
  return null;
}

function recoverPersonFromAdjacentCapsNameLines(
  rawText: string | undefined,
  emails: string[] = []
): { firstName: string; lastName: string } | null {
  if (!rawText?.trim()) return null;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const personal = primaryPersonalEmail(emails);
  const localKey = personal ? (personal.split('@')[0] ?? '').toLowerCase().replace(/[^a-zà-ü]/g, '') : '';

  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i]!;
    const b = lines[i + 1]!;
    if (a.length < 4 || b.length < 4 || a.length > 16 || b.length > 16) continue;
    if (/@|www\.|https?:|tel|fax|\d{3}/i.test(a) || /@|www\.|https?:|tel|fax|\d{3}/i.test(b)) continue;
    if (!/^[A-ZÀ-Ü][A-Za-zÀ-ü]{1,}$/.test(a) || !/^[A-ZÀ-Ü][A-Za-zÀ-ü]{1,}$/.test(b)) continue;
    if (shouldRejectPersonCandidate(`${a} ${b}`)) continue;

    const firstGuess = a.charAt(0) + a.slice(1).toLowerCase();
    const lastGuess = b.charAt(0) + b.slice(1).toLowerCase();
    const validated = validatePersonName({ firstName: firstGuess, lastName: lastGuess });
    if (!validated?.firstName || !validated.lastName) continue;

    const lnKey = normalizeBrandKey(validated.lastName);
    const fnKey = normalizeBrandKey(validated.firstName);
    if (localKey && (localKey.includes(lnKey) || localKey.includes(fnKey + lnKey))) {
      return { firstName: validated.firstName, lastName: validated.lastName };
    }
    if (localKey && lnKey.length >= 4 && localKey.endsWith(lnKey.slice(0, 4))) {
      return { firstName: validated.firstName, lastName: validated.lastName };
    }
  }
  return null;
}

/** Nome in evidenza su riga CAPS (es. MAURIZIO LAIN) — preferito su email di agenzia terza. */
function recoverPersonFromProminentCapsLine(
  rawText: string | undefined
): { firstName: string; lastName: string } | null {
  if (!rawText?.trim()) return null;
  let best: { firstName: string; lastName: string; score: number } | null = null;
  for (const line of rawText.split('\n')) {
    const t = line.trim();
    if (t.length < 6 || t.length > 40) continue;
    const wordCount = t.split(/\s+/).filter(Boolean).length;
    if (wordCount < 2 || wordCount > 4) continue;
    if (shouldRejectPersonCandidate(t) || isInstitutionalOcrPersonGarbage(t)) continue;
    if (/\b(?:court|street|avenue|road|drive|lane|boulevard|strasse|straße|via|viale|corso|piazza)\b/i.test(t)) {
      continue;
    }
    if (/\b(?:SPA|GROUP|ENERGY|AGENZIA|CONSULENTE|CELL|TEL|VIA|S\.?P\.?A|GMBH|UNIVERSITY|COLLEGE)\b/i.test(t)) {
      continue;
    }
    if (isSloganAsPersonLine(t) || isLogoNoisePersonLine(t)) continue;
    if (isCertificationBadgeLine(t)) continue;
    // Righe ALLCAPS 2-token senza nome noto → brand aziendale (MOTOCARD RAS, BDB SYSTEMS)
    const tWords = t.split(/\s+/).filter(Boolean);
    if (tWords.every(w => /^[A-ZÀ-Ü]{1,}$/.test(w))) {
      const hasName = tWords.some(w => isExactCommonFirstName(w));
      if (!hasName) continue;
    }
    const parsed = parsePersonNameFromLine(t);
    if (!parsed?.firstName || !parsed?.lastName) continue;
    const words = t.split(/\s+/).filter(Boolean);
    let firstName = parsed.firstName;
    let lastName = parsed.lastName;
    if (
      words.length === 2 &&
      isExactCommonFirstName(words[1]!) &&
      !isExactCommonFirstName(words[0]!)
    ) {
      firstName = words[1]!.charAt(0).toUpperCase() + words[1]!.slice(1).toLowerCase();
      lastName = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1).toLowerCase();
    }
    const validated = validatePersonName({ firstName, lastName });
    if (!validated?.firstName || !validated.lastName) continue;
    const titleCase =
      /^[A-ZÀ-Ü][a-zà-ü]/.test(validated.firstName) && /^[A-ZÀ-Ü][a-zà-ü]/.test(validated.lastName);
    const score = titleCase ? 3 : wordCount === 2 && /^[A-ZÀ-Ü]/.test(t) ? 1 : 2;
    if (score > (best?.score ?? 0)) {
      best = { firstName: validated.firstName, lastName: validated.lastName, score };
    }
  }
  return best ? { firstName: best.firstName, lastName: best.lastName } : null;
}

/** Nome su riga CAPS separata dal cognome. */
function repairFirstNameFromSplitCapsLines(
  first: string | null | undefined,
  last: string | null | undefined,
  rawText: string | undefined
): { firstName: string | null; lastName: string | null } | null {
  const lastTrim = (last ?? '').trim();
  if (!lastTrim || !rawText?.trim()) return null;
  const lastKey = normalizeBrandKey(lastTrim);
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/^[A-ZÀ-Ü]{4,}$/.test(line)) continue;
    if (!isExactCommonFirstName(line)) continue;
    const observedFirst =
      line.charAt(0).toUpperCase() + line.slice(1).toLowerCase();
    const hasLast = lines.some((other) => normalizeBrandKey(other) === lastKey);
    if (!hasLast) continue;
    const curKey = normalizeBrandKey(first ?? '');
    const observedKey = normalizeBrandKey(observedFirst);
    if (curKey && curKey === observedKey) return null;
    const validated = validatePersonName({
      firstName: observedFirst,
      lastName: lastTrim,
    });
    if (validated?.firstName && validated.lastName) {
      return { firstName: validated.firstName, lastName: validated.lastName };
    }
  }
  return null;
}

/** Preferisce nome OCR su typo email (STEFANO vs stetano.pasin@). */
function repairFirstNameFromOcrCapsEvidence(
  first: string | null | undefined,
  last: string | null | undefined,
  rawText: string | undefined
): { firstName: string | null; lastName: string | null } | null {
  const lastTrim = (last ?? '').trim();
  if (!lastTrim || !rawText?.trim()) return null;
  const lastKey = normalizeBrandKey(lastTrim);
  for (const line of rawText.split('\n')) {
    const t = line.trim();
    const m = t.match(/^([A-ZÀ-Ü][A-Za-zÀ-ü'’.-]{2,})\s+([A-ZÀ-Ü][A-Za-zÀ-ü'’.-]{2,})$/);
    if (!m) continue;
    if (normalizeBrandKey(m[2]) !== lastKey) continue;
    const ocrFirst = m[1];
    const curFirst = (first ?? '').trim();
    if (!curFirst) continue;
    const ocrKey = normalizeBrandKey(ocrFirst);
    const curKey = normalizeBrandKey(curFirst);
    if (ocrKey === curKey) return null;
    if (levenshteinDistance(ocrKey, curKey) > 1) continue;
    const validated = validatePersonName({ firstName: ocrFirst, lastName: m[2] });
    if (validated?.firstName) {
      return { firstName: validated.firstName, lastName: validated.lastName || lastTrim };
    }
  }
  return null;
}

function emailLooksLikeThirdPartyAgency(emails: string[], person: { firstName: string; lastName: string }): boolean {
  const personal = emails.find((e) => e.includes('@') && !isGenericProviderDomain(e.split('@')[1] ?? ''));
  if (!personal) return false;
  const local = (personal.split('@')[0] ?? '').toLowerCase();
  const fn = normalizeBrandKey(person.firstName);
  const ln = normalizeBrandKey(person.lastName);
  if (fn && local.includes(fn)) return false;
  if (ln && local.includes(ln)) return false;
  return local.length >= 4;
}

function parseItalianDiOwnerName(text: string): { firstName: string; lastName: string } | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > 6) return null;
  const particles = new Set(['de', 'di', 'del', 'della', 'dello', 'dei', 'degli', 'da', 'dal', 'van', 'von']);
  if (!particles.has(words[0].toLowerCase())) return null;
  const surnameLen = words.length >= 4 ? 2 : 2;
  const surname = words.slice(0, surnameLen).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  const given = words.slice(surnameLen).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  const validated = validatePersonName({ firstName: given, lastName: surname });
  if (!validated?.firstName || !validated.lastName) return null;
  return { firstName: validated.firstName, lastName: validated.lastName };
}

function recoverPersonFromDiOwnerLine(
  rawText: string | undefined
): { firstName: string; lastName: string } | null {
  if (!rawText?.trim()) return null;
  for (const line of rawText.split('\n')) {
    const m = line.trim().match(/^di\s+(.+)$/i);
    if (!m?.[1]) continue;
    const ownerText = m[1].trim();
    const italian = parseItalianDiOwnerName(ownerText);
    if (italian) return italian;
    const parsed = parsePersonNameFromLine(ownerText);
    if (!parsed?.firstName || !parsed?.lastName) continue;
    const validated = validatePersonName(parsed);
    if (validated?.firstName && validated.lastName) {
      return { firstName: validated.firstName, lastName: validated.lastName };
    }
  }
  return null;
}

function recoverSingleGivenNameFromOcr(
  rawText: string | undefined,
  emails: string[] = []
): { firstName: string; lastName: string | null } | null {
  if (!rawText?.trim()) return null;
  const personal = primaryPersonalEmail(emails);
  const local = personal ? (personal.split('@')[0] ?? '').toLowerCase().replace(/[^a-z]/g, '') : '';
  for (const line of rawText.split('\n')) {
    const t = line.trim();
    if (!t || t.length < 3 || t.length > 16) continue;
    if (/@|www\.|https?:|tel|fax|\d{3}/i.test(t)) continue;
    if (!/^[A-ZÀ-Ü][a-zà-ü]{2,}$/.test(t)) continue;
    if (shouldRejectPersonCandidate(t) || isInstitutionalOcrPersonGarbage(t)) continue;
    const key = t.toLowerCase();
    const first = isExactCommonFirstName(key)
      ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
      : null;
    if (!first) continue;
    if (local && (local.startsWith(key) || local === key)) {
      return { firstName: first, lastName: null };
    }
    if (personal) {
      const fromEmail = parseNameFromEmailLocal(personal);
      if (fromEmail?.firstName && normalizeBrandKey(fromEmail.firstName) === normalizeBrandKey(first)) {
        return { firstName: fromEmail.firstName, lastName: fromEmail.lastName || null };
      }
    }
  }
  return null;
}

export function finalizePersonFields(
  first: string | null | undefined,
  last: string | null | undefined,
  rawLine?: string,
  emails: string[] = [],
  rawText?: string,
  company?: string | null,
  preserveExactObservedSelection = false
): { firstName: string | null; lastName: string | null } {
  const observedPerson = observedPersonFromRawLine(rawLine, emails, company);
  const selectedExactEmailPerson = parseExactObservedPersonFromEmail(
    `${first ?? ''} ${last ?? ''}`.trim(),
    emails
  );
  if (
    observedPerson &&
    (
      !selectedExactEmailPerson ||
      (
        normalizeBrandKey(observedPerson.firstName) ===
          normalizeBrandKey(selectedExactEmailPerson.firstName) &&
        normalizeBrandKey(observedPerson.lastName) ===
          normalizeBrandKey(selectedExactEmailPerson.lastName)
      )
    )
  ) {
    return observedPerson;
  }
  if (selectedExactEmailPerson) {
    return selectedExactEmailPerson;
  }

  const cardText = rawText ?? rawLine;
  const normalizedRawLine = rawLine?.trim() ?? '';
  const exactPersonalEmailEvidence =
    Boolean(normalizedRawLine) &&
    hasExactObservedPersonalEmailEvidence(normalizedRawLine, emails);
  const personLineGarbage =
    Boolean(normalizedRawLine) &&
    !exactPersonalEmailEvidence &&
    (shouldRejectPersonCandidate(normalizedRawLine) ||
      isInstitutionalOcrPersonGarbage(normalizedRawLine));
  const personValueGarbage =
    Boolean(`${first ?? ''} ${last ?? ''}`.trim()) &&
    !hasExactObservedPersonalEmailEvidence(
      `${first ?? ''} ${last ?? ''}`.trim(),
      emails
    ) &&
    (shouldRejectPersonCandidate(`${first ?? ''} ${last ?? ''}`.trim()) ||
      isInstitutionalOcrPersonGarbage(`${first ?? ''} ${last ?? ''}`.trim()));
  const needsPersonRecovery =
    !first?.trim() ||
    !last?.trim() ||
    personLineGarbage ||
    personValueGarbage ||
    isPersonDuplicateOfCompany(first, last, company);
  const rawPersonKeys = normalizedRawLine
    .replace(/[.,;:]+$/g, '')
    .split(/\s+/)
    .map((token) => normalizeBrandKey(token))
    .filter(Boolean);
  const selectedPersonKeys = `${first ?? ''} ${last ?? ''}`
    .trim()
    .split(/\s+/)
    .map((token) => normalizeBrandKey(token))
    .filter(Boolean);
  const exactObservedSelection =
    rawPersonKeys.length >= 2 &&
    rawPersonKeys.length === selectedPersonKeys.length &&
    [...rawPersonKeys].sort().join('|') ===
      [...selectedPersonKeys].sort().join('|');

  // Open-set person evidence: il chiamante abilita questa via solo quando la
  // selezione arriva da una riga persona osservata con ruolo adiacente. Se la
  // stessa coppia di token e' ripetuta ESATTAMENTE, nello stesso ordine, dalla
  // local-part di una email personale business, preserviamo entrambi i token
  // anche quando il cognome e' omografo di un termine indirizzo (Road/Lane/
  // Street/Park). Nessun dizionario o fuzzy repair: tutta l'evidenza viene
  // dai token OCR osservati e dall'email osservata.
  const orderedObservedEmailPerson =
    preserveExactObservedSelection && normalizedRawLine
      ? parseOrderedObservedPersonFromPersonalEmail(
          normalizedRawLine,
          emails
        )
      : null;
  if (
    orderedObservedEmailPerson &&
    exactObservedSelection &&
    !isPersonDuplicateOfCompany(first, last, company)
  ) {
    return orderedObservedEmailPerson;
  }

  if (
    preserveExactObservedSelection &&
    exactObservedSelection &&
    (
      exactPersonalEmailEvidence ||
      !shouldRejectCorroboratedObservedPersonCandidate(normalizedRawLine)
    ) &&
    (
      exactPersonalEmailEvidence ||
      !isInstitutionalOcrPersonGarbage(normalizedRawLine)
    ) &&
    !isPersonDuplicateOfCompany(first, last, company)
  ) {
    if (exactPersonalEmailEvidence) {
      const exactEmailPerson = parseExactObservedPersonFromEmail(
        normalizedRawLine,
        emails
      );
      if (exactEmailPerson) return exactEmailPerson;
    }
    const selected = validatePersonName({
      firstName: first ?? '',
      lastName: last ?? '',
    });
    if (selected?.firstName && selected.lastName) {
      return {
        firstName: selected.firstName,
        lastName: selected.lastName,
      };
    }
  }

  if (needsPersonRecovery && cardText) {
    const singleGiven = recoverSingleGivenNameFromOcr(cardText, emails);
    if (singleGiven?.firstName) {
      return { firstName: singleGiven.firstName, lastName: singleGiven.lastName };
    }
    for (const line of cardText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.split(/\s+/).filter(Boolean).length < 2) continue;
      const parsed =
        parsePersonNameFromLine(normalizeFusedPersonLine(trimmed, emails)) ??
        parsePersonNameFromLine(trimmed);
      if (!parsed?.firstName || !parsed.lastName) continue;
      const validated = validatePersonName(parsed);
      if (
        validated?.firstName &&
        validated.lastName &&
        !shouldRejectPersonCandidate(trimmed) &&
        hasPositiveObservedPersonEvidence(
          trimmed,
          validated.firstName,
          validated.lastName,
          emails
        )
      ) {
        return { firstName: validated.firstName, lastName: validated.lastName };
      }
    }
    for (let i = 0; i < cardText.split('\n').length - 1; i++) {
      const line = cardText.split('\n')[i]!.trim();
      const next = cardText.split('\n')[i + 1]!.trim();
      if (!ROLE_KEYWORD_REGEX.test(next)) continue;
      const normalized = normalizeFusedPersonLine(line, emails);
      const parsed = parsePersonNameFromLine(normalized) ?? parsePersonNameFromLine(line);
      if (!parsed?.firstName || !parsed.lastName) continue;
      const validated = validatePersonName(parsed);
      if (
        validated?.firstName &&
        validated.lastName &&
        !shouldRejectPersonCandidate(line) &&
        hasPositiveObservedPersonEvidence(
          line,
          validated.firstName,
          validated.lastName,
          emails
        )
      ) {
        return { firstName: validated.firstName, lastName: validated.lastName };
      }
    }
    const capsEmail = recoverPersonFromCapsAndEmailLocal(cardText, emails);
    if (capsEmail) {
      return { firstName: capsEmail.firstName, lastName: capsEmail.lastName };
    }
    const splitCaps = recoverPersonFromAdjacentCapsNameLines(cardText, emails);
    if (splitCaps) {
      return { firstName: splitCaps.firstName, lastName: splitCaps.lastName };
    }
    const brandPerson = recoverPersonOnBrandOnlyCard(cardText, emails);
    if (brandPerson) {
      return { firstName: brandPerson.firstName, lastName: brandPerson.lastName };
    }
  }

  if (isPersonDuplicateOfCompany(first, last, company) && cardText) {
    const brandPerson = recoverPersonOnBrandOnlyCard(cardText, emails);
    if (brandPerson) {
      return { firstName: brandPerson.firstName, lastName: brandPerson.lastName };
    }
  }

  const firstCore = (first ?? '').replace(/\./g, '').trim();
  if (firstCore.length <= 1 && (last ?? '').trim().length >= 6 && rawLine?.trim()) {
    const normalized = normalizeFusedPersonLine(rawLine, emails);
    const fromFused = parsePersonNameFromLine(normalized);
    if (fromFused?.firstName && fromFused.lastName) {
      const validated = validatePersonName(fromFused);
      if (validated?.firstName && validated.firstName.replace(/\./g, '').trim().length > 1) {
        return { firstName: validated.firstName, lastName: validated.lastName };
      }
    }
  }

  const emailPerson = recoverPersonMatchingPersonalEmail(cardText, emails);
  if (emailPerson && primaryPersonalEmail(emails)) {
    const affinity = personEmailAffinityScore(emailPerson.firstName, emailPerson.lastName, emails);
    if (affinity >= 2) {
      return { firstName: emailPerson.firstName, lastName: emailPerson.lastName };
    }
  }
  if (emailPerson) {
    const ocrAffinity = personEmailAffinityScore(first, last, emails);
    const emailAffinity = personEmailAffinityScore(emailPerson.firstName, emailPerson.lastName, emails);
    const ocrLineRejected = rawLine?.trim() ? shouldRejectPersonCandidate(rawLine) : false;
    const ocrInstitutionalGarbage = rawLine?.trim() ? isInstitutionalOcrPersonGarbage(rawLine) : false;
    if (ocrLineRejected || ocrInstitutionalGarbage || (emailAffinity >= 2.5 && emailAffinity > ocrAffinity)) {
      return { firstName: emailPerson.firstName, lastName: emailPerson.lastName };
    }
  }

  if (isDuplicateGivenNameAsSurname(first, last)) {
    const personal = primaryPersonalEmail(emails);
    if (personal) {
      const fromEmail = parseNameFromEmailLocal(personal);
      if (fromEmail?.lastName && normalizeBrandKey(fromEmail.lastName) !== normalizeBrandKey(first ?? '')) {
        return {
          firstName: fromEmail.firstName || first || null,
          lastName: fromEmail.lastName,
        };
      }
    }
  }

  const diOwner = recoverPersonFromDiOwnerLine(cardText);
  if (diOwner) {
    const brandFirstKey = normalizeBrandKey(first ?? '');
    if (
      isCertificationBadgeLine(`${first ?? ''} ${last ?? ''}`.trim()) ||
      !brandFirstKey ||
      !isCommonFirstName(brandFirstKey)
    ) {
      return { firstName: diOwner.firstName, lastName: diOwner.lastName };
    }
  }
  const badgeName = `${first ?? ''} ${last ?? ''}`.trim();
  if (isPersonDuplicateOfCompany(first, last, company)) {
    const recovered = recoverPersonMatchingPersonalEmail(cardText, emails);
    if (recovered) return recovered;
    const alt = recoverPersonFromProminentCapsLine(cardText);
    if (alt && !isPersonDuplicateOfCompany(alt.firstName, alt.lastName, company)) {
      return alt;
    }
    return { firstName: null, lastName: null };
  }
  if (badgeName && isCertificationBadgeLine(badgeName)) {
    for (const email of emails) {
      const fromEmail = parseNameFromEmailLocal(email);
      if (fromEmail?.firstName && fromEmail?.lastName) {
        return { firstName: fromEmail.firstName, lastName: fromEmail.lastName };
      }
    }
    return { firstName: null, lastName: null };
  }

  const capsPerson = recoverPersonFromProminentCapsLine(cardText);
  if (
    capsPerson &&
    company?.trim() &&
    /\b(?:university|college)\b/i.test(company) &&
    (!first?.trim() || !last?.trim())
  ) {
    return capsPerson;
  }
  if (capsPerson && (rawLine?.trim() ? isInstitutionalOcrPersonGarbage(rawLine) : false)) {
    return capsPerson;
  }
  if (capsPerson && emailLooksLikeThirdPartyAgency(emails, capsPerson)) {
    return capsPerson;
  }
  if (capsPerson) {
    const lastKey = normalizeBrandKey(last ?? '');
    const capsLastKey = normalizeBrandKey(capsPerson.lastName);
    if (!lastKey || (lastKey !== capsLastKey && capsLastKey.length >= 3)) {
      return capsPerson;
    }
  }

  const ocrFirstRepair = repairFirstNameFromOcrCapsEvidence(first, last, cardText);
  if (ocrFirstRepair) {
    first = ocrFirstRepair.firstName;
    last = ocrFirstRepair.lastName;
  }
  const diRepair = repairDiOwnerNameFields(first, last);
  if (diRepair) {
    const validated = validatePersonName({ firstName: diRepair.firstName ?? '', lastName: diRepair.lastName ?? '' });
    if (validated) {
      return { firstName: validated.firstName || null, lastName: validated.lastName || null };
    }
  }

  const stripped = stripProfessionalTitleFragment(first ?? '', last ?? '');
  first = stripped.firstName;
  last = stripped.lastName;

  if (isNameContaminatedByEmail(first, last, emails)) {
    return { firstName: null, lastName: null };
  }
  const f = (first ?? '').trim().toLowerCase();
  const l = (last ?? '').trim().toLowerCase();
  if (
    (f.length <= 1 && /\bmail\b/i.test(l)) ||
    f === 'e' ||
    /^mail\b/.test(l) ||
    /\bmail\s+info\b/i.test(`${f} ${l}`)
  ) {
    return { firstName: null, lastName: null };
  }
  const raw = rawLine?.trim() ?? '';
  const rawWords = raw.split(/\s+/).filter(Boolean);
  const preferLine =
    rawWords.length >= 2 && /^[A-Za-z]\.?$/.test(rawWords[0]?.replace(/\./g, '') ?? '');

  if (raw && preferLine) {
    const normalized = normalizeFusedPersonLine(raw, emails);
    const fromLine = parsePersonNameFromLine(normalized) ?? parsePersonNameFromLine(raw);
    if (fromLine) {
      const validated = validatePersonName(fromLine);
      if (validated) {
        return { firstName: validated.firstName || null, lastName: validated.lastName || null };
      }
    }
  }
  const validated = validatePersonName({ firstName: first ?? '', lastName: last ?? '' });
  if (validated) {
    if (isItalianCityName(validated.lastName)) {
      for (const email of emails) {
        const fromEmail = parseNameFromEmailLocal(email);
        if (fromEmail?.firstName && fromEmail.lastName && !isItalianCityName(fromEmail.lastName)) {
          return { firstName: fromEmail.firstName, lastName: fromEmail.lastName };
        }
      }
      return { firstName: validated.firstName || null, lastName: null };
    }
    if (!validated.lastName || validated.lastName.length < 2) {
      const emailRepair = repairSurnameFromEmailLocal(validated.firstName, validated.lastName, emails);
      if (emailRepair) return emailRepair;
    } else if (isSurnameFragmentOfEmailDomain(validated.lastName, emails)) {
      const emailRepair = repairSurnameFromEmailLocal(validated.firstName, validated.lastName, emails);
      if (emailRepair) return emailRepair;
    }
    const typoRepair = repairSurnameTypoFromEmailLocal(validated.firstName, validated.lastName, emails);
    if (typoRepair) return typoRepair;
    const splitCapsRepair = repairFirstNameFromSplitCapsLines(
      validated.firstName,
      validated.lastName,
      cardText
    );
    if (splitCapsRepair) return splitCapsRepair;
    const ocrFirstRepair = repairFirstNameFromOcrCapsEvidence(
      validated.firstName,
      validated.lastName,
      cardText
    );
    if (ocrFirstRepair) return ocrFirstRepair;
    const reconciled = reconcilePersonWithEmailEvidence(validated.firstName, validated.lastName, emails);
    const ocrAfterReconcile = repairFirstNameFromOcrCapsEvidence(
      reconciled.firstName,
      reconciled.lastName,
      cardText
    );
    if (ocrAfterReconcile) return ocrAfterReconcile;
    if (reconciled.firstName || reconciled.lastName) {
      return { firstName: reconciled.firstName, lastName: reconciled.lastName };
    }
    return { firstName: validated.firstName || null, lastName: validated.lastName || null };
  }
  const emailRepair = repairSurnameFromEmailLocal(first, last, emails);
  if (emailRepair) return emailRepair;
  const reconciled = reconcilePersonWithEmailEvidence(first, last, emails);
  if (reconciled.firstName || reconciled.lastName) {
    return { firstName: reconciled.firstName, lastName: reconciled.lastName };
  }
  if (raw) {
    const normalized = normalizeFusedPersonLine(raw, emails);
    const fromLine = parsePersonNameFromLine(normalized);
    if (fromLine) {
      const validated = validatePersonName(fromLine);
      if (validated?.firstName && validated.lastName) {
        return { firstName: validated.firstName, lastName: validated.lastName };
      }
    }
  }
  return { firstName: null, lastName: null };
}

export function finalizeRoleValue(
  role: string | null | undefined,
  company?: string | null
): string | null {
  if (!role?.trim()) return null;
  let value = role.trim().replace(/\s+/g, ' ');
  // Le parentesi che racchiudono l'intero titolo sono rumore tipografico OCR,
  // non parte del ruolo (es. "(CEO )"). Non tocchiamo parentesi interne.
  value = value.replace(/^\(\s*([^()]+?)\s*\)$/u, '$1').trim();

  // P0 ROLE SUFFIX RECOVERY
  // OCR reale: una riga puo contenere un brand/reparto rumoroso prima di un
  // titolo executive valido ("... Group CIO"). Se il prefisso NON contiene
  // gia parole di ruolo, conserva soltanto la coda executive osservata.
  const executiveTail = value.match(
    /\b((?:(?:senior|sr\.?|junior|jr\.?|group|global|regional|area|division|department|country)\s+){0,3}(?:CEO|CTO|CFO|COO|CIO|CMO|CISO|CHRO|VP|MD|GM))\s*$/i
  );
  if (executiveTail?.[1] && executiveTail.index !== undefined && executiveTail.index > 0) {
    const prefix = value.slice(0, executiveTail.index).trim();
    if (prefix && !ROLE_KEYWORD_REGEX.test(prefix)) {
      value = executiveTail[1]
        .replace(/\b(ceo|cto|cfo|coo|cio|cmo|ciso|chro|vp|md|gm)\b/gi, (m) => m.toUpperCase())
        .replace(/\b(group|global|regional|area|division|department|country|senior|junior)\b/gi, (m) =>
          m.charAt(0).toUpperCase() + m.slice(1).toLowerCase()
        );
    }
  }

  const affiliationBadge = /^(?:partner|affiliato|affiliate|dealer|reseller|rivenditore|concessionario|authorized\s+dealer)$/i;
  value = value.replace(
    /\s+(?:affiliato|affiliate|dealer|reseller|rivenditore|concessionario|authorized\s+dealer)\s*$/i,
    ''
  );

  value = value
    .replace(/^title\s*:\s*["']?/i, '')
    .replace(/["'`]+$/g, '')
    .trim();

  // Una lettera isolata in coda a una qualifica professionale completa e'
  // una tipica troncatura OCR; non estendiamo la regola ad altri ruoli.
  value = value.replace(
    /\b(Dottore\s+Commercialista|Revisore\s+Contabile|Amministratore\s+Delegato)\s+[a-z]$/i,
    '$1'
  );
  // Titoli di cortesia accanto al nome non sono una professione. Se manca un
  // ruolo verificabile e' preferibile lasciare il campo vuoto.
  if (/^(?:dott(?:ore)?|dr|prof(?:essore)?)\.?$/i.test(value)) return null;

  // Rigetta "Alexander Pohl, CEO" (nome persona + virgola + ruolo) - estrai solo il ruolo
  const personRolePattern = value.match(/^([A-ZÀ-Ü][a-zà-ü]{1,})\s+([A-ZÀ-Ü][a-zà-ü]{1,})\s*,\s*(.+)$/);
  if (personRolePattern) {
    // E' un nome persona + ruolo inline: estrai solo il ruolo
    const roleOnly = personRolePattern[3]?.trim();
    if (roleOnly && ROLE_KEYWORD_REGEX.test(roleOnly)) {
      value = roleOnly;
    } else {
      return null;
    }
  }

  const ocrRoleFixes: Array<[RegExp, string]> = [
    [/administra\s+tion/i, 'Administration'],
    [/manage\s+ment/i, 'Management'],
    [/special\s+ist/i, 'Specialist'],
    [/\bconsutant\b/i, 'Consultant'],
    [/dev(?:elopment)?\.?\s*&?\s*strategy/i, 'Dev. & Strategy'],
  ];
  for (const [re, repl] of ocrRoleFixes) {
    value = value.replace(re, repl);
  }

  if (/^[A-Z]{3,}$/.test(value) && !/^(CEO|CTO|CFO|COO|HR|IT|QA|R&D|GM|VP|MD)$/.test(value)) {
    value = value.charAt(0) + value.slice(1).toLowerCase();
  } else if (/^[a-zà-ü]/.test(value)) {
    value = value.replace(/^\w/u, (c) => c.toUpperCase());
  }

  if (
    /\b(?:service\s+partner|authorized\s+dealer|centro\s+assistenza|partner\s+autorizzato|miele\s+service)\b/i.test(
      value
    )
  ) {
    return null;
  }

  const pipeParts = value.split(/\s*\|\s*/);
  if (pipeParts.length >= 2 && ROLE_KEYWORD_REGEX.test(pipeParts[0] ?? '')) {
    const right = pipeParts.slice(1).join(' | ');
    if (
      hasLegalForm(right) ||
      /\b(?:academy|training|group|gruppo|srl|spa|verona|milano|roma)\b/i.test(right)
    ) {
      value = (pipeParts[0] ?? '').trim();
    }
  }

  const dashParts = value.split(/\s+-\s+/);
  if (dashParts.length >= 2 && ROLE_KEYWORD_REGEX.test(dashParts[0] ?? '')) {
    const right = dashParts.slice(1).join(' - ');
    if (
      hasLegalForm(right) ||
      /\b(?:academy|training|group|gruppo|srl|spa|verona|milano|roma)\b/i.test(right)
    ) {
      value = (dashParts[0] ?? '').trim();
    }
  }

  value = value.replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  if (!value) return null;
  const slashParts = value
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (slashParts.length > 1) {
    let validRoleParts = slashParts.filter(
      (part) =>
        ROLE_KEYWORD_REGEX.test(part) &&
        !isOcrRoleGarbage(part) &&
        !isLegalPhraseAsRole(part)
    );
    if (validRoleParts.some((part) => !affiliationBadge.test(part))) {
      validRoleParts = validRoleParts.filter((part) => !affiliationBadge.test(part));
    }
    if (!validRoleParts.length) return null;
    value = validRoleParts.join(' / ');
  } else if (isRejectedCompanyValue(value)) {
    return null;
  }
  if (hasLegalForm(value) && !ROLE_KEYWORD_REGEX.test(value)) return null;
  if (!ROLE_KEYWORD_REGEX.test(value) && value.split(/\s+/).length > 5) return null;

  if (company?.trim()) {
    const comp = company.trim().toLowerCase();
    const low = value.toLowerCase();
    let companyIndex = -1;
    let searchFrom = 0;
    while (searchFrom <= low.length - comp.length) {
      const index = low.indexOf(comp, searchFrom);
      if (index < 0) break;
      const before = index > 0 ? low[index - 1] : '';
      const after =
        index + comp.length < low.length
          ? low[index + comp.length]
          : '';
      if (
        !/[\p{L}\p{N}]/u.test(before) &&
        !/[\p{L}\p{N}]/u.test(after)
      ) {
        companyIndex = index;
        break;
      }
      searchFrom = index + 1;
    }
    if (companyIndex >= 0) {
      const cleanSide = (part: string) =>
        part.replace(/^[-–—|/:,;\s]+|[-–—|/:,;\s]+$/g, '').trim();
      const sides = [
        cleanSide(value.slice(0, companyIndex)),
        cleanSide(value.slice(companyIndex + comp.length)),
      ].filter(
        (part) =>
          Boolean(part) &&
          ROLE_KEYWORD_REGEX.test(part)
      );
      if (!sides.length) return null;
      value = sides.join(' / ');
    }
  }

  if (isOcrRoleGarbage(value)) return null;
  if (isLegalPhraseAsRole(value)) return null;

  return value;
}

function isLegalPhraseAsRole(value: string): boolean {
  const t = value.trim();
  if (/^a\s+socio\s+unico$/i.test(t)) return true;
  if (/^socio\s+unico$/i.test(t) && !/\b(?:responsabile|direttore|manager)\b/i.test(t)) return true;
  if (/^sede\s+(?:commerciale|legale|operativa)$/i.test(t)) return true;
  return false;
}

function companyBrandEvidenceAligns(value: string, evidence: string): boolean {
  const valueKey = normalizeBrandKey(value);
  const evidenceKey = normalizeBrandKey(evidence);
  if (!valueKey || !evidenceKey || Math.min(valueKey.length, evidenceKey.length) < 4) {
    return false;
  }
  if (valueKey === evidenceKey) return true;

  // La corroborazione deve riguardare l'identità completa, non un'etichetta
  // che coincide soltanto con il prefisso del testo ("STATUS: ACTIVE" /
  // status.com). È ammessa unicamente una correzione OCR di un carattere su
  // chiavi intere e di lunghezza comparabile.
  return (
    Math.max(valueKey.length, evidenceKey.length) >= 6 &&
    Math.abs(valueKey.length - evidenceKey.length) <= 1 &&
    levenshteinDistance(valueKey, evidenceKey) <= 1
  );
}

function observedBusinessHostsAlignBrand(
  brand: string,
  emails: string[],
  rawText: string
): boolean {
  const hosts = new Set<string>();
  for (const email of emails) {
    const domain = getPrimaryBusinessEmailDomain([email]);
    if (domain) hosts.add(domain);
  }
  const website = resolveExplicitWebsiteFromText(rawText);
  if (website) hosts.add(website);
  if (!hosts.size) return false;

  return [...hosts].every((host) =>
    extractBusinessDomainRootCandidates(host).some((candidate) =>
      companyBrandEvidenceAligns(
        brand,
        splitFusedDomainBrand(candidate)
      )
    )
  );
}

function formatAllCapsObservedCompanyBrand(value: string): string {
  const letters = value.replace(/[^A-Za-zÀ-ü]/g, '');
  if (!letters || letters !== letters.toUpperCase()) return value;
  if (/[:=]/u.test(value)) return value;

  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .split('-')
        .map((part) => {
          if (/^(?:[A-Z0-9&]\.?){1,4}$/.test(part) && part.includes('.')) {
            return part;
          }
          if (/^[A-Z0-9&]{1,4}$/.test(part)) return part;
          return part
            ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
            : part;
        })
        .join('-')
    )
    .join(' ');
}

function canonicalObservedLegalSuffix(value: string): string {
  const observed = value.trim().replace(/\s+/g, ' ');
  if (isKnownLegalFormTypography(observed)) return observed;
  return canonicalizeKnownLegalForm(observed) ?? observed;
}

function formatObservedTerminalLegalCompany(
  value: string,
  emails: string[],
  rawText: string
): string | null {
  const valueKey = normalizeBrandKey(value);
  if (!valueKey || !rawText.trim()) return null;

  for (const rawLine of rawText.split(/\r?\n/)) {
    let line = sanitizeCompanyValue(rawLine.trim());
    let inlineNumberedLocation = false;
    if (line && normalizeBrandKey(line) !== valueKey) {
      const legalMatches = [
        ...rawLine.matchAll(new RegExp(LEGAL_RE.source, 'gi')),
      ];
      for (const legalMatch of legalMatches.reverse()) {
        const legalEnd = (legalMatch.index ?? 0) + legalMatch[0].length;
        const observedCompany = sanitizeCompanyValue(
          rawLine.slice(0, legalEnd).trim()
        );
        const locationTail = rawLine.slice(legalEnd).trim();
        const isOnlyLocationUnit =
          /^(?:building|suite|floor|unit|office|warehouse|plant|factory|lot|block|tower|edificio|piano|interno)\s+/i.test(
            locationTail.replace(/^[,;:–—-]\s*/, '')
          );
        const isDelimitedNumberedLocation =
          /^[,;:–—-]\s*/u.test(locationTail) &&
          !isOnlyLocationUnit &&
          hasStrongNumberedStreetStructure(locationTail);
        if (
          observedCompany &&
          normalizeBrandKey(observedCompany) === valueKey &&
          isDelimitedNumberedLocation
        ) {
          line = observedCompany;
          inlineNumberedLocation = true;
          break;
        }
      }
    }
    if (!line || normalizeBrandKey(line) !== valueKey) continue;
    const legal = matchTerminalLegalFormSuffix(line);
    if (!legal) continue;

    if (legal.strength === 'ambiguous') {
      const evidence = strongObservedCompanyBrand(emails, rawText);
      const corroborated =
        inlineNumberedLocation ||
        Boolean(evidence && companyBrandEvidenceAligns(legal.brand, evidence)) ||
        observedBusinessHostsAlignBrand(legal.brand, emails, rawText);
      if (!corroborated) {
        continue;
      }
    }
    if (
      competingObservedBrandForAmbiguousLegalLine(line, emails, rawText)
    ) {
      continue;
    }

    const brand = formatAllCapsObservedCompanyBrand(
      sanitizeCompanyValue(legal.brand)
    );
    if (!brand) continue;

    const suffix = canonicalObservedLegalSuffix(legal.suffix);
    const tail = line.slice(legal.brand.length);
    if (/^\s*,/.test(tail)) {
      return `${brand}, ${suffix}`;
    }
    if (/^\s*\(/.test(tail)) return `${brand} (${suffix})`;
    return `${brand} ${suffix}`;
  }
  return null;
}

function finalizeCompanyCandidate(
  value: string,
  emails: string[],
  rawText: string
): string | null {
  const competingClaimBrand = competingObservedBrandForAmbiguousLegalLine(
    value,
    emails,
    rawText
  );
  if (competingClaimBrand) {
    return finalizeCompanyCandidate(competingClaimBrand, emails, rawText);
  }

  const observedLegal = formatObservedTerminalLegalCompany(value, emails, rawText);
  if (
    observedLegal &&
    !isRejectedCompanyValue(observedLegal) &&
    !isProviderDerivedCompanyName(observedLegal)
  ) {
    return observedLegal;
  }
  if (/^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,6}$/i.test(value.replace(/\s+/g, '')) && !hasLegalForm(value)) {
    return null;
  }
  if (
    !value ||
    isRejectedCompanyValue(value) ||
    isCompanySloganOnly(value)
  ) {
    return null;
  }
  if (isProviderDerivedCompanyName(value)) return null;
  if (isDomainOnlyCompanyValue(value, emails, rawText)) return null;
  if (hasTerminalLegalFormSuffix(value)) {
    const aligned = alignCompanyToEmailDomain(value, emails, rawText);
    const kept = aligned || value;
    if (isRejectedCompanyValue(kept) || isCompanySloganOnly(kept)) return null;
    return kept;
  }
  const hostingBrand = recoverBrandWhenHostingEmail(value, emails, rawText);
  if (hostingBrand) value = hostingBrand;
  const domainBrand = resolveBrandFromEmailDomain(emails);
  const isCanonicalBrand =
    Boolean(domainBrand) && normalizeBrandKey(domainBrand!) === normalizeBrandKey(value);
  const observedHeaderCandidate = pickOrganizationHeaderFromEvidence(
    rawText,
    emails
  );
  const observedHeader =
    observedHeaderCandidate &&
    !isCompanySloganOnly(observedHeaderCandidate) &&
    !isClaimLikeTerminalLegalPhrase(observedHeaderCandidate)
      ? observedHeaderCandidate
      : null;
  const normalizedObservedHeader = observedHeader
    ? normalizeOcrBrandValue(observedHeader, emails)
    : null;
  const observedHeaderMatchesCanonicalAfterOcrRepair =
    Boolean(normalizedObservedHeader) &&
    normalizeBrandKey(normalizedObservedHeader!) === normalizeBrandKey(value);
  const fromOcr =
    observedHeader &&
    normalizeBrandKey(observedHeader) !== normalizeBrandKey(value) &&
    !observedHeaderMatchesCanonicalAfterOcrRepair
      ? observedHeader
      : isCanonicalBrand
        ? null
        : resolveOrganizationFromOcr(value, emails, rawText);
  if (fromOcr) {
    value = fromOcr;
  } else if (isDomainRootAsCompany(value, emails)) {
    if (!isCanonicalBrand) return null;
  } else {
    value = alignCompanyToEmailDomain(value, emails, rawText);
  }
  if (
    !value ||
    isRejectedCompanyValue(value) ||
    isCompanySloganOnly(value)
  ) {
    return null;
  }
  if (shouldRejectCompanyCandidate(value)) return null;
  if (value === value.toUpperCase() && /[A-Z]/.test(value)) {
    const wordCount = value.split(/\s+/).filter(Boolean).length;
    const hasHyphen = value.includes('-');
    if (value.length >= 6 && (hasHyphen || wordCount >= 2)) {
      value = value
        .split(/\s+/)
        .map((word) => {
          if (hasHyphen && word.includes('-')) {
            return word
              .split('-')
              .map((part) => (part.length > 0 ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
              .join('-');
          }
          if (/^[A-Z0-9]{1,4}$/.test(word)) return word;
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
    }
  }
  return value;
}

function recoverInstitutionalCompany(
  company: string,
  emails: string[],
  rawText: string
): string | null {
  const recovered = resolveOrganizationFromOcr(company, emails, rawText);
  if (!recovered || recovered === company) return null;
  if (
    isRejectedCompanyValue(recovered) ||
    shouldRejectCompanyCandidate(recovered)
  ) {
    return null;
  }
  return finalizeCompanyCandidate(recovered, emails, rawText) ?? recovered;
}

function brandFromObservedHost(value: string | null | undefined): string | null {
  const host = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0] ?? '';
  if (!host || isGenericProviderDomain(host)) return null;
  const root = extractBusinessDomainRoot(host);
  if (!root || root.length < 3 || !/[a-z]/i.test(root)) return null;
  const brand = splitFusedDomainBrand(root).trim();
  return brand && !isRejectedCompanyValue(brand) ? brand : null;
}

function observedBusinessEmailBrands(
  emails: string[],
  rawText: string
): { brand: string | null; conflict: boolean } {
  const parsedEmails = new Set(
    emails.map((email) => email.trim().toLowerCase()).filter(Boolean)
  );
  const observedEmails = observedEmailValues(
    collectEmailEvidence(
      rawText.split(/\r?\n/).map((rawOcr, lineId) => ({
        lineId,
        pageIndex: 0,
        rawOcr,
        confidence: 0.9,
      }))
    )
  ).filter((email) => parsedEmails.has(email.toLowerCase()));
  const domains = [
    ...new Set(
      observedEmails
        .map((email) => getPrimaryBusinessEmailDomain([email]))
        .filter((domain): domain is string => Boolean(domain))
    ),
  ];
  const brands = domains
    .map(brandFromObservedHost)
    .filter((brand): brand is string => Boolean(brand));

  let reconciled: string | null = null;
  for (const brand of brands) {
    if (!reconciled) {
      reconciled = brand;
      continue;
    }
    const currentKey = normalizeBrandKey(reconciled);
    const nextKey = normalizeBrandKey(brand);
    if (currentKey === nextKey) continue;
    return { brand: null, conflict: true };
  }

  return { brand: reconciled, conflict: false };
}

export interface ConvergentBusinessBrandEvidence {
  brand: string;
  emailBrand: string;
  websiteBrand: string;
}

export function hasConflictingObservedBusinessBrandEvidence(
  emails: string[],
  rawText: string
): boolean {
  const observedEmail = observedBusinessEmailBrands(emails, rawText);
  if (observedEmail.conflict) return true;
  if (!observedEmail.brand) return false;

  const explicitWebsite = resolveExplicitWebsiteFromText(rawText, []);
  const websiteBrand = brandFromObservedHost(explicitWebsite);
  if (!websiteBrand) return false;

  return (
    normalizeBrandKey(observedEmail.brand) !==
    normalizeBrandKey(websiteBrand)
  );
}

/**
 * Due fonti indipendenti sono convergenti soltanto quando identificano la
 * stessa radice completa. Una semplice relazione prefisso/suffisso non basta:
 * code.com e codeart.com restano evidenze discordanti.
 */
export function resolveConvergentBusinessBrandEvidence(
  emails: string[],
  rawText: string
): ConvergentBusinessBrandEvidence | null {
  const observedEmail = observedBusinessEmailBrands(emails, rawText);
  if (observedEmail.conflict || !observedEmail.brand) return null;

  const explicitWebsite = resolveExplicitWebsiteFromText(rawText, []);
  const websiteBrand = brandFromObservedHost(explicitWebsite);
  if (!websiteBrand) return null;

  const emailKey = normalizeBrandKey(observedEmail.brand);
  const websiteKey = normalizeBrandKey(websiteBrand);
  if (!emailKey || emailKey !== websiteKey) return null;

  return {
    brand: observedEmail.brand,
    emailBrand: observedEmail.brand,
    websiteBrand,
  };
}

function strongObservedCompanyBrand(
  emails: string[],
  rawText: string
): string | null {
  const convergent = resolveConvergentBusinessBrandEvidence(emails, rawText);
  if (convergent) return convergent.brand;

  const observedEmail = observedBusinessEmailBrands(emails, rawText);
  if (observedEmail.conflict) return null;
  const explicitWebsite = resolveExplicitWebsiteFromText(rawText, []);
  const websiteBrand = brandFromObservedHost(explicitWebsite);
  // Prefer a short caps brand mark printed on the card over a
  // website-root fallback when the trade-activity slogan was rejected.
  const shortCapsBrand = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(
      (line) =>
        /^[A-Z][A-Z0-9]{2,16}$/.test(line) &&
        !isMarketingSloganCompanyLine(line) &&
        !isCompanySloganClaimLine(line) &&
        !/^(?:TEL|FAX|VAT|IVA|LLC|LTD|INC|GMBH|SRL|SPA)$/i.test(line)
    );
  if (
    shortCapsBrand &&
    websiteBrand &&
    normalizeBrandKey(shortCapsBrand) !== normalizeBrandKey(websiteBrand)
  ) {
    const shortPos = rawText.indexOf(shortCapsBrand);
    const webPos = rawText.toLowerCase().search(/www\.|https?:\/\//i);
    if (shortPos >= 0 && (webPos < 0 || shortPos < webPos)) {
      return shortCapsBrand;
    }
  }
  if (observedEmail.brand && websiteBrand) return null;
  return observedEmail.brand ?? websiteBrand ?? shortCapsBrand ?? null;
}

function competingObservedBrandForAmbiguousLegalLine(
  value: string,
  emails: string[],
  rawText: string
): string | null {
  if (!hasAmbiguousTerminalLegalSeparator(value)) return null;
  const legal = matchTerminalLegalFormSuffix(value);
  if (!legal) return null;
  const evidence = resolveConvergentBusinessBrandEvidence(emails, rawText);
  if (!evidence) return null;
  if (companyBrandEvidenceAligns(legal.brand, evidence.brand)) {
    return null;
  }
  return evidence.brand;
}

export function finalizeCompanyValue(
  company: string | null | undefined,
  emails: string[],
  rawText: string
): string | null {
  const competingClaimBrand = company?.trim()
    ? competingObservedBrandForAmbiguousLegalLine(company, emails, rawText)
    : null;
  if (competingClaimBrand) {
    return finalizeCompanyCandidate(competingClaimBrand, emails, rawText);
  }

  const observedTerminalLegal = company?.trim()
    ? formatObservedTerminalLegalCompany(company, emails, rawText)
    : null;
  if (
    observedTerminalLegal &&
    !isRejectedCompanyValue(observedTerminalLegal) &&
    !isProviderDerivedCompanyName(observedTerminalLegal)
  ) {
    return observedTerminalLegal;
  }

  if (company?.trim() && isRoleWordAsCompany(company)) {
    const org = pickOrganizationHeaderFromEvidence(rawText, emails);
    if (org) {
      const fromRole = finalizeCompanyCandidate(org, emails, rawText);
      if (fromRole) return fromRole;
    }
  }

  if (
    company?.trim() &&
    !hasTerminalLegalFormSuffix(company) &&
    (isCompanySloganClaimLine(company) || isCompanySloganOnly(company))
  ) {
    const observedBrand = strongObservedCompanyBrand(emails, rawText);
    if (!observedBrand) return null;
    return finalizeCompanyCandidate(observedBrand, emails, rawText);
  }

  const selectedDomainBrand = resolveBrandFromEmailDomain(emails);
  if (
    company?.trim() &&
    selectedDomainBrand &&
    normalizeBrandKey(company) === normalizeBrandKey(selectedDomainBrand)
  ) {
    const observedOrganizationLine = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => {
        if (!line || /@|www\.|https?:|\d{3}/i.test(line)) return false;
        const words = line.split(/\s+/).filter(Boolean);
        if (words.length < 2 || words.length > 6) return false;
        if (line !== line.toUpperCase()) return false;
        if (!/\b(?:INDUSTRY|INDUSTRIES|COMPANY|CORPORATION|GROUP|SYSTEM|SYSTEMS|SOLUTION|SOLUTIONS|SERVICE|SERVICES|TECHNOLOGY|TECHNOLOGIES|ASSOCIATES)\b/i.test(line)) return false;
        if (isRejectedCompanyValue(line)) return false;
        return normalizeBrandKey(line) !== normalizeBrandKey(selectedDomainBrand);
      });
    if (observedOrganizationLine) {
      const observedOrganization = finalizeCompanyCandidate(observedOrganizationLine, emails, rawText);
      if (observedOrganization) return observedOrganization;
    }
  }

  if (company?.trim() && shouldPreferEmailBrandOverCompany(company, emails, rawText)) {
    const emailBrand = resolveBrandFromEmailDomain(emails);
    if (emailBrand) {
      const fromEmail = finalizeCompanyCandidate(emailBrand, emails, rawText);
      if (fromEmail) return fromEmail;
    }
  }

  if (!company?.trim()) {
    const recoveredHeader =
      pickOrganizationHeaderFromEvidence(rawText, emails) ??
      recoverOcrHeaderBrand(rawText, emails);
    if (recoveredHeader) return recoveredHeader;

    const hasObservedClaim = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .some(
        (line) =>
          isCompanySloganClaimLine(line) ||
          isMarketingSloganCompanyLine(line) ||
          isProductCategoryTagline(line)
      );
    if (!hasObservedClaim) return null;

    const observedBrand = strongObservedCompanyBrand(emails, rawText);
    return observedBrand
      ? finalizeCompanyCandidate(observedBrand, emails, rawText)
      : null;
  }

  const original = sanitizeCompanyValue(company);

  const domainBrand = resolveBrandFromEmailDomain(emails);
  if (
    domainBrand &&
    normalizeBrandKey(original) === normalizeBrandKey(domainBrand)
  ) {
    const canonicalDomain = finalizeCompanyCandidate(original, emails, rawText);
    if (canonicalDomain) return canonicalDomain;
  }

  const stackedBrand = recoverStackedBrandLinesFromWebsite(original, emails, rawText);
  if (stackedBrand) {
    const stackedFinal = finalizeCompanyCandidate(stackedBrand, emails, rawText);
    if (stackedFinal) return stackedFinal;
  }

  // Una ragione sociale completa osservata è evidenza più forte della radice
  // del dominio: la normalizzazione dei loghi non deve sostituirne il brand o
  // eliminare le parole descrittive prima della forma giuridica.
  let value = hasTerminalLegalFormSuffix(original)
    ? original
    : normalizeOcrBrandValue(original, emails) ?? original;
  value = sanitizeCompanyValue(value);

  const finalized = finalizeCompanyCandidate(value, emails, rawText);
  if (finalized) return finalized;

  const institutional = recoverInstitutionalCompany(value, emails, rawText);
  if (institutional) return institutional;

  if (hasTerminalLegalFormSuffix(original)) {
    if (!isRejectedCompanyValue(original) && !isCompanySloganOnly(original)) {
      return original;
    }
    return null;
  }

  const headerBrand = recoverOcrHeaderBrand(rawText, emails);
  if (headerBrand && isPreservableCompanyCandidate(original)) {
    const headerKey = normalizeBrandKey(headerBrand);
    const originalKey = normalizeBrandKey(original);
    const headerIsWorseTypo =
      headerKey !== originalKey &&
      levenshteinDistance(headerKey, originalKey) === 1 &&
      headerKey.length > originalKey.length;
    if (!headerIsWorseTypo) {
      const headerFinal = finalizeCompanyCandidate(headerBrand, emails, rawText);
      if (headerFinal) return headerFinal;
    }
  }

  if (isPreservableCompanyCandidate(original)) {
    const preserved = finalizeCompanyCandidate(original, emails, rawText);
    if (preserved) return preserved;
    const normalized = normalizeOcrBrandValue(original, emails) ?? original;
    if (normalized && !isRejectedCompanyValue(normalized) && !isCompanySloganOnly(normalized)) {
      return normalized;
    }
    if (!isRejectedCompanyValue(original) && !isCompanySloganOnly(original)) {
      return original;
    }
  }

  if (domainBrand && normalizeBrandKey(original) === normalizeBrandKey(domainBrand)) {
    return original;
  }

  return headerBrand && !hasTerminalLegalFormSuffix(original)
    ? finalizeCompanyCandidate(headerBrand, emails, rawText)
    : null;
}

import type { BusinessCard } from '../types';
import type { EmailEvidenceMetadata } from './email-evidence';
import { getSafeContactEmails } from './email-evidence';
import {
  validateTaxCode,
  validateVatNumber,
} from './parser-engine/validators/vat';

/** Contratto legacy usato dal flusso di salvataggio esistente. */
export type DuplicateStrength = 'strong' | 'medium';

export type DuplicateTier = 'exact' | 'probable' | 'possible';
export type DuplicateSignalStrength = 'strong' | 'medium' | 'weak';

export type DuplicateSignalKind =
  | 'page_fingerprint'
  | 'image_set'
  | 'email_same'
  | 'email_repaired_observed'
  | 'email_ocr_compatible'
  | 'phone_same'
  | 'whatsapp_same'
  | 'phone_ocr_compatible'
  | 'tax_id_same'
  | 'domain_person'
  | 'name_exact'
  | 'name_fuzzy'
  | 'company_exact'
  | 'company_fuzzy'
  | 'city_same'
  | 'address_compatible'
  | 'domain_same'
  | 'phone_suffix_domain'
  | 'country_same';

export type DuplicateComparedField =
  | 'name'
  | 'company'
  | 'emails'
  | 'phones'
  | 'website'
  | 'address'
  | 'city'
  | 'country'
  | 'vatNumber'
  | 'taxCode'
  | 'images'
  | 'rawText';

export interface ContactDuplicateSignal {
  kind: DuplicateSignalKind;
  strength: DuplicateSignalStrength;
  score: number;
  fields: DuplicateComparedField[];
}

export interface ContactDuplicateMatch {
  contact: BusinessCard;
  /** Compatibilità con il guard legacy. */
  strength: DuplicateStrength;
  /** Compatibilità con il motivo sintetico mostrato dal guard legacy. */
  reason: 'email' | 'phone' | 'name_company' | 'name';
  tier: DuplicateTier;
  score: number;
  reasons: string[];
  signals: ContactDuplicateSignal[];
  equalFields: DuplicateComparedField[];
  differentFields: DuplicateComparedField[];
}

interface ClassifiedEmail {
  value: string;
  origin: 'observed' | 'repaired' | 'user';
}

interface CandidateContext {
  card: BusinessCard;
  emails: ClassifiedEmail[];
  phones: Set<string>;
  whatsappPhones: Set<string>;
  websiteDomains: Set<string>;
  emailDomains: Set<string>;
  name: string;
  company: string;
  city: string;
  address: string;
  country: string;
  personalTaxIds: Set<string>;
  organizationTaxIds: Set<string>;
  vatIds: Set<string>;
  taxCodeIds: Set<string>;
  pageFingerprint: string;
  imageFingerprint: string;
  meaningfulFieldCount: number;
}

interface CollectedTaxIds {
  all: Set<string>;
  personal: Set<string>;
  organization: Set<string>;
  vat: Set<string>;
  taxCode: Set<string>;
}

const FIELD_ORDER: readonly DuplicateComparedField[] = [
  'name',
  'company',
  'emails',
  'phones',
  'website',
  'address',
  'city',
  'country',
  'vatNumber',
  'taxCode',
  'images',
  'rawText',
];

const GENERIC_EMAIL_DOMAINS = new Set([
  'aol.com',
  'fastwebnet.it',
  'gmail.com',
  'hotmail.com',
  'hotmail.it',
  'icloud.com',
  'libero.it',
  'live.com',
  'live.it',
  'mail.com',
  'msn.com',
  'outlook.com',
  'outlook.it',
  'proton.me',
  'protonmail.com',
  'virgilio.it',
  'yahoo.com',
  'yahoo.it',
]);

const GENERIC_MAILBOX_LOCAL_PARTS = new Set([
  'admin',
  'amministrazione',
  'contact',
  'contatti',
  'hello',
  'info',
  'mail',
  'office',
  'sales',
  'segreteria',
  'support',
]);

const LEGAL_COMPANY_SUFFIXES = new Set([
  'ag',
  'co',
  'company',
  'corp',
  'corporation',
  'gmbh',
  'inc',
  'incorporated',
  'ltd',
  'limited',
  'llc',
  'plc',
  'sa',
  'sas',
  'scarl',
  'srl',
  'spa',
]);

const REASON_BY_SIGNAL: Record<DuplicateSignalKind, string> = {
  page_fingerprint: 'stessa evidenza OCR fronte/retro',
  image_set: 'stesso insieme di immagini',
  email_same: 'stessa email osservata o confermata',
  email_repaired_observed: 'email riparata uguale a una email osservata',
  email_ocr_compatible: 'email compatibile per lieve errore OCR con identità corroborata',
  phone_same: 'stesso telefono normalizzato',
  whatsapp_same: 'stesso numero WhatsApp normalizzato',
  phone_ocr_compatible: 'telefono compatibile per prefisso o lieve errore OCR con identità corroborata',
  tax_id_same: 'stesso identificativo fiscale valido',
  domain_person: 'stesso dominio e persona compatibile',
  name_exact: 'stesso nome completo',
  name_fuzzy: 'nome compatibile con una lieve variazione OCR',
  company_exact: 'stessa azienda',
  company_fuzzy: 'azienda compatibile con una lieve variazione OCR',
  city_same: 'stessa località',
  address_compatible: 'indirizzo compatibile',
  domain_same: 'stesso dominio',
  phone_suffix_domain: 'stesso dominio e telefono parziale compatibile',
  country_same: 'stesso paese',
};

/** Normalizza testo per confronto (case, spazi, punteggiatura, trattini). */
export function normalizeContactToken(value: string | undefined): string {
  if (!value?.trim()) return '';
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function normalizeWords(value: string | undefined): string {
  if (!value?.trim()) return '';
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeCompany(value: string | undefined): string {
  const tokens = normalizeWords(value)
    .split(' ')
    .filter(Boolean)
    .filter((token) => !LEGAL_COMPANY_SUFFIXES.has(token));
  return tokens.join('');
}

function normalizeFingerprintBlock(value: string | undefined): string {
  if (!value?.trim()) return '';
  return value
    .split(/\r?\n/)
    .map((line) => normalizeContactToken(line))
    .filter(Boolean)
    .sort()
    .join('|');
}

/**
 * Il fingerprint ordina le pagine e le righe: fronte/retro invertiti producono
 * la stessa chiave. Viene usato solo se l'evidenza è abbastanza informativa.
 */
function cardPageFingerprint(card: BusinessCard): string {
  const pageTexts = (card.pageExtractions ?? [])
    .map((page) => normalizeFingerprintBlock(page.rawText))
    .filter(Boolean)
    .sort();
  const fingerprint = pageTexts.length
    ? pageTexts.join('||')
    : normalizeFingerprintBlock(card.rawText);
  return normalizeContactToken(fingerprint).length >= 40 ? fingerprint : '';
}

function imageSetFingerprint(card: BusinessCard): string {
  const images = [...new Set((card.images ?? []).map((value) => value.trim()))]
    .filter(Boolean)
    .sort();
  return images.length ? images.join('|') : '';
}

export function normalizeEmail(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

/**
 * Canonicalizza `00` e `+` come accesso internazionale equivalente. Rimuove
 * il country code soltanto per l'Italia, dove la forma nazionale è definita;
 * per gli altri paesi non inventa un country code assente.
 */
export function normalizePhone(value: string | undefined): string {
  const source = value ?? '';
  const explicitPlus = /^[^\d+]*\+/.test(source);
  let digits = source.replace(/\D/g, '');
  const explicitDoubleZero = digits.startsWith('00');
  if (explicitDoubleZero) digits = digits.slice(2);
  const explicitInternational = explicitPlus || explicitDoubleZero;
  if (
    explicitInternational &&
    digits.startsWith('39') &&
    digits.length >= 11 &&
    digits.length <= 13
  ) {
    digits = digits.slice(2);
  }
  return digits;
}

export function getContactDisplayName(card: BusinessCard): string {
  const name = [card.firstName, card.lastName].filter(Boolean).join(' ').trim();
  return name || card.company?.trim() || card.title?.trim() || 'Contatto';
}

function evidenceIsObservedOrUser(
  evidence: EmailEvidenceMetadata
): evidence is EmailEvidenceMetadata & { origin: 'observed' | 'user' } {
  return (
    (evidence.origin === 'observed' || evidence.origin === 'user') &&
    evidence.validationStatus === 'valid' &&
    evidence.confirmed &&
    !evidence.requiresReview
  );
}

function evidenceIsConfirmedRepair(
  evidence: EmailEvidenceMetadata
): boolean {
  return (
    evidence.origin === 'repaired' &&
    evidence.validationStatus === 'valid' &&
    evidence.confirmed &&
    !evidence.requiresReview
  );
}

function collectClassifiedEmails(card: BusinessCard): ClassifiedEmail[] {
  const byValueAndOrigin = new Map<string, ClassifiedEmail>();
  for (const value of getSafeContactEmails(card)) {
    const normalized = normalizeEmail(value);
    if (normalized) {
      byValueAndOrigin.set(`${normalized}|observed`, {
        value: normalized,
        origin: 'observed',
      });
    }
  }

  for (const evidence of card.emailEvidence ?? []) {
    const value = normalizeEmail(evidence.value);
    if (!value || !value.includes('@')) continue;
    if (evidenceIsObservedOrUser(evidence)) {
      byValueAndOrigin.set(`${value}|${evidence.origin}`, {
        value,
        origin: evidence.origin,
      });
    } else if (evidenceIsConfirmedRepair(evidence)) {
      byValueAndOrigin.set(`${value}|repaired`, {
        value,
        origin: 'repaired',
      });
    }
  }

  return [...byValueAndOrigin.values()].sort(
    (left, right) =>
      left.value.localeCompare(right.value) ||
      left.origin.localeCompare(right.origin)
  );
}

function collectPhones(card: BusinessCard): Set<string> {
  return new Set(
    (card.phones ?? [])
      .map((phone) => normalizePhone(phone.number))
      .filter((digits) => digits.length >= 6)
  );
}

function rawLineMentionsNumber(rawLine: string, number: string): boolean {
  const lineDigits = normalizePhone(rawLine);
  const suffixLength = Math.min(7, number.length);
  return (
    suffixLength >= 6 &&
    lineDigits.endsWith(number.slice(-suffixLength))
  );
}

function collectWhatsappPhones(card: BusinessCard): Set<string> {
  const phoneNumbers = [...collectPhones(card)];
  const whatsappLines = (card.rawText ?? '')
    .split(/\r?\n/)
    .filter((line) => /\b(?:whats\s*app|whatsapp|wa)\b/i.test(line));
  return new Set(
    phoneNumbers.filter((number) =>
      whatsappLines.some((line) => rawLineMentionsNumber(line, number))
    )
  );
}

function normalizeDomain(value: string | undefined): string {
  let normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('@')) normalized = normalized.split('@').pop() ?? '';
  normalized = normalized
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#\s]/, 1)[0]!
    .replace(/:\d+$/, '')
    .replace(/[.,;:]+$/, '');
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(
    normalized
  )
    ? normalized
    : '';
}

function collectWebsiteDomains(card: BusinessCard): Set<string> {
  const domain = normalizeDomain(card.website);
  return new Set(domain ? [domain] : []);
}

function collectEmailDomains(
  emails: readonly ClassifiedEmail[]
): Set<string> {
  return new Set(
    emails
      .map((email) => normalizeDomain(email.value))
      .filter((domain) => domain && !GENERIC_EMAIL_DOMAINS.has(domain))
  );
}

function normalizeAddress(card: BusinessCard): string {
  const address = card.address;
  if (!address) return '';
  return normalizeContactToken(
    [
      address.full,
      address.street,
      address.civicNumber,
      address.postalCode,
      address.city,
      address.region,
      address.country,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function collectTaxIds(card: BusinessCard): CollectedTaxIds {
  const all = new Set<string>();
  const personal = new Set<string>();
  const organization = new Set<string>();
  const vat = new Set<string>();
  const taxCodeValues = new Set<string>();
  if (card.vatNumber) {
    const value = validateVatNumber(card.vatNumber);
    if (value) {
      all.add(value);
      organization.add(value);
      vat.add(value);
    }
  }
  if (card.taxCode) {
    const value = validateTaxCode(card.taxCode);
    if (value) {
      all.add(value);
      taxCodeValues.add(value);
      if (value.length === 16) {
        personal.add(value);
      } else {
        organization.add(value);
      }
    }
  }
  return {
    all,
    personal,
    organization,
    vat,
    taxCode: taxCodeValues,
  };
}

function personName(card: BusinessCard): string {
  return [card.firstName, card.lastName]
    .map(normalizeContactToken)
    .filter(Boolean)
    .join(' ');
}

function meaningfulFieldCount(card: BusinessCard): number {
  return [
    personName(card),
    normalizeCompany(card.company),
    collectClassifiedEmails(card).length ? 'email' : '',
    collectPhones(card).size ? 'phone' : '',
    normalizeDomain(card.website),
    normalizeAddress(card),
    collectTaxIds(card).all.size ? 'tax' : '',
  ].filter(Boolean).length;
}

function context(card: BusinessCard): CandidateContext {
  const emails = collectClassifiedEmails(card);
  const taxIds = collectTaxIds(card);
  return {
    card,
    emails,
    phones: collectPhones(card),
    whatsappPhones: collectWhatsappPhones(card),
    websiteDomains: collectWebsiteDomains(card),
    emailDomains: collectEmailDomains(emails),
    name: personName(card),
    company: normalizeCompany(card.company),
    city: normalizeContactToken(card.address?.city),
    address: normalizeAddress(card),
    country: normalizeContactToken(card.address?.country),
    personalTaxIds: taxIds.personal,
    organizationTaxIds: taxIds.organization,
    vatIds: taxIds.vat,
    taxCodeIds: taxIds.taxCode,
    pageFingerprint: cardPageFingerprint(card),
    imageFingerprint: imageSetFingerprint(card),
    meaningfulFieldCount: meaningfulFieldCount(card),
  };
}

function intersection<T>(left: Set<T>, right: Set<T>): T[] {
  return [...left].filter((value) => right.has(value));
}

function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function stringSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const maxLength = Math.max(left.length, right.length);
  return 1 - levenshtein(left, right) / maxLength;
}

function companySimilarity(left: string, right: string): number {
  return stringSimilarity(left, right);
}

function areNamesClearlyDistinct(a: BusinessCard, b: BusinessCard): boolean {
  const aFirst = normalizeContactToken(a.firstName);
  const aLast = normalizeContactToken(a.lastName);
  const bFirst = normalizeContactToken(b.firstName);
  const bLast = normalizeContactToken(b.lastName);
  const firstConflict =
    Boolean(aFirst && bFirst) && stringSimilarity(aFirst, bFirst) < 0.58;
  const lastConflict =
    Boolean(aLast && bLast) && stringSimilarity(aLast, bLast) < 0.68;
  return firstConflict || lastConflict;
}

/** Due persone chiaramente nominate in modo diverso. API legacy conservata. */
export function areDistinctPeople(a: BusinessCard, b: BusinessCard): boolean {
  const aFirst = normalizeContactToken(a.firstName);
  const aLast = normalizeContactToken(a.lastName);
  const bFirst = normalizeContactToken(b.firstName);
  const bLast = normalizeContactToken(b.lastName);
  return (
    Boolean(aFirst && bFirst && aFirst !== bFirst) ||
    Boolean(aLast && bLast && aLast !== bLast)
  );
}

interface MatchedEmail {
  kind: 'same' | 'repaired_observed';
  value: string;
  genericMailbox: boolean;
}

function isGenericMailbox(value: string): boolean {
  const localPart = value.split('@', 1)[0] ?? '';
  const mailboxStem = localPart.split(/[+._-]/, 1)[0] ?? localPart;
  return GENERIC_MAILBOX_LOCAL_PARTS.has(mailboxStem);
}

function emailMatch(
  left: readonly ClassifiedEmail[],
  right: readonly ClassifiedEmail[]
): MatchedEmail | null {
  let best: { match: MatchedEmail; rank: number } | null = null;
  for (const a of left) {
    for (const b of right) {
      if (a.value !== b.value) continue;
      const repairedCount =
        Number(a.origin === 'repaired') + Number(b.origin === 'repaired');
      if (repairedCount > 1) continue;
      const kind = repairedCount === 0 ? 'same' : 'repaired_observed';
      const genericMailbox = isGenericMailbox(a.value);
      const rank = (genericMailbox ? 0 : 4) + (kind === 'same' ? 2 : 1);
      if (!best || rank > best.rank) {
        best = {
          match: {
            kind,
            value: a.value,
            genericMailbox,
          },
          rank,
        };
      }
    }
  }
  return best?.match ?? null;
}

function emailOcrCompatible(
  left: readonly ClassifiedEmail[],
  right: readonly ClassifiedEmail[]
): boolean {
  for (const a of left) {
    if (isGenericMailbox(a.value)) continue;
    const [aLocal = '', aDomain = ''] = a.value.split('@');
    for (const b of right) {
      if (a.value === b.value || isGenericMailbox(b.value)) continue;
      const [bLocal = '', bDomain = ''] = b.value.split('@');
      const sameDomainLocalOcr =
        aDomain === bDomain &&
        Math.min(aLocal.length, bLocal.length) >= 4 &&
        levenshtein(aLocal, bLocal) === 1;
      const sameLocalDomainOcr =
        aLocal === bLocal &&
        Math.min(aDomain.length, bDomain.length) >= 5 &&
        levenshtein(aDomain, bDomain) === 1;
      if (sameDomainLocalOcr || sameLocalDomainOcr) return true;
    }
  }
  return false;
}

function partialPhoneMatch(left: Set<string>, right: Set<string>): boolean {
  for (const a of left) {
    for (const b of right) {
      if (a === b || Math.min(a.length, b.length) < 9) continue;
      if (a.slice(-7) === b.slice(-7)) return true;
    }
  }
  return false;
}

function phoneOcrCompatible(left: Set<string>, right: Set<string>): boolean {
  for (const a of left) {
    for (const b of right) {
      if (
        a === b ||
        Math.min(a.length, b.length) < 9 ||
        Math.abs(a.length - b.length) > 1
      ) {
        continue;
      }
      if (levenshtein(a, b) === 1) return true;
    }
  }
  return false;
}

function fieldValues(
  item: CandidateContext
): Record<DuplicateComparedField, Set<string>> {
  const card = item.card;
  return {
    name: new Set(item.name ? [item.name] : []),
    company: new Set(item.company ? [item.company] : []),
    emails: new Set(item.emails.map((email) => email.value)),
    phones: item.phones,
    website: new Set(
      normalizeDomain(card.website) ? [normalizeDomain(card.website)] : []
    ),
    address: new Set(item.address ? [item.address] : []),
    city: new Set(item.city ? [item.city] : []),
    country: new Set(item.country ? [item.country] : []),
    vatNumber: item.vatIds,
    taxCode: item.taxCodeIds,
    images: new Set(
      (card.images ?? []).map((value) => value.trim()).filter(Boolean)
    ),
    rawText: new Set(item.pageFingerprint ? [item.pageFingerprint] : []),
  };
}

function compareFields(
  left: CandidateContext,
  right: CandidateContext
): Pick<ContactDuplicateMatch, 'equalFields' | 'differentFields'> {
  const leftValues = fieldValues(left);
  const rightValues = fieldValues(right);
  const equalFields: DuplicateComparedField[] = [];
  const differentFields: DuplicateComparedField[] = [];

  for (const field of FIELD_ORDER) {
    const a = leftValues[field];
    const b = rightValues[field];
    if (!a.size && !b.size) continue;
    if (intersection(a, b).length) {
      equalFields.push(field);
    } else {
      differentFields.push(field);
    }
  }
  return { equalFields, differentFields };
}

function legacyReason(
  signals: readonly ContactDuplicateSignal[]
): ContactDuplicateMatch['reason'] {
  if (
    signals.some(
      (signal) =>
        signal.kind === 'email_same' ||
        signal.kind === 'email_repaired_observed' ||
        signal.kind === 'email_ocr_compatible'
    )
  ) {
    return 'email';
  }
  if (
    signals.some(
      (signal) =>
        signal.kind === 'phone_same' ||
        signal.kind === 'whatsapp_same' ||
        signal.kind === 'phone_ocr_compatible' ||
        signal.kind === 'phone_suffix_domain'
    )
  ) {
    return 'phone';
  }
  if (
    signals.some(
      (signal) =>
        signal.kind === 'company_exact' ||
        signal.kind === 'company_fuzzy' ||
        signal.kind === 'domain_person' ||
        signal.kind === 'tax_id_same'
    )
  ) {
    return 'name_company';
  }
  return 'name';
}

function assessCandidate(
  incoming: CandidateContext,
  existing: CandidateContext
): ContactDuplicateMatch | null {
  const signals: ContactDuplicateSignal[] = [];
  const add = (
    kind: DuplicateSignalKind,
    strength: DuplicateSignalStrength,
    score: number,
    fields: DuplicateComparedField[]
  ) => {
    signals.push({ kind, strength, score, fields });
  };

  const clearlyDistinctPeople = areNamesClearlyDistinct(
    incoming.card,
    existing.card
  );
  const nameSimilarity = stringSimilarity(incoming.name, existing.name);
  const companyScore = companySimilarity(incoming.company, existing.company);
  const exactName =
    Boolean(incoming.name) && incoming.name === existing.name;
  const exactCompany =
    Boolean(incoming.company) && incoming.company === existing.company;
  const commonWebsiteDomains = intersection(
    incoming.websiteDomains,
    existing.websiteDomains
  );
  const commonEmailDomains = intersection(
    incoming.emailDomains,
    existing.emailDomains
  );
  const commonDomains = [
    ...new Set([...commonWebsiteDomains, ...commonEmailDomains]),
  ];
  const commonPhones = intersection(incoming.phones, existing.phones);
  const commonWhatsapp = intersection(
    incoming.whatsappPhones,
    existing.whatsappPhones
  );
  const commonPersonalTaxIds = intersection(
    incoming.personalTaxIds,
    existing.personalTaxIds
  );
  const commonOrganizationTaxIds = intersection(
    incoming.organizationTaxIds,
    existing.organizationTaxIds
  );
  const emailOcrCorroborated =
    exactName &&
    (exactCompany || commonWebsiteDomains.length > 0);
  const phoneOcrCorroborated =
    emailOcrCorroborated || (exactName && commonEmailDomains.length > 0);

  if (
    incoming.pageFingerprint &&
    incoming.pageFingerprint === existing.pageFingerprint &&
    !clearlyDistinctPeople
  ) {
    add('page_fingerprint', 'strong', 90, ['rawText']);
  }
  if (
    incoming.imageFingerprint &&
    incoming.imageFingerprint === existing.imageFingerprint
  ) {
    add('image_set', 'strong', 90, ['images']);
  }

  const matchedEmail = emailMatch(incoming.emails, existing.emails);
  if (matchedEmail?.genericMailbox) {
    if (exactName && !clearlyDistinctPeople) {
      add(
        matchedEmail.kind === 'same'
          ? 'email_same'
          : 'email_repaired_observed',
        'medium',
        18,
        ['emails']
      );
    }
  } else if (matchedEmail) {
    add(
      matchedEmail.kind === 'same'
        ? 'email_same'
        : 'email_repaired_observed',
      'strong',
      matchedEmail.kind === 'same' ? 72 : 68,
      ['emails']
    );
  } else if (
    !clearlyDistinctPeople &&
    emailOcrCorroborated &&
    emailOcrCompatible(incoming.emails, existing.emails)
  ) {
    add('email_ocr_compatible', 'strong', 58, ['emails']);
  }

  if (commonPhones.length && !clearlyDistinctPeople) {
    if (commonWhatsapp.length) {
      add('whatsapp_same', 'strong', 72, ['phones']);
    } else {
      add('phone_same', 'strong', 65, ['phones']);
    }
  } else if (
    !clearlyDistinctPeople &&
    phoneOcrCorroborated &&
    (partialPhoneMatch(incoming.phones, existing.phones) ||
      phoneOcrCompatible(incoming.phones, existing.phones))
  ) {
    add('phone_ocr_compatible', 'strong', 52, ['phones']);
  }

  if (commonPersonalTaxIds.length) {
    add('tax_id_same', 'strong', 80, ['vatNumber', 'taxCode']);
  } else if (commonOrganizationTaxIds.length) {
    add('tax_id_same', 'medium', 18, ['vatNumber', 'taxCode']);
  }

  if (
    commonWebsiteDomains.length &&
    exactName &&
    !clearlyDistinctPeople
  ) {
    add('domain_person', 'strong', 55, ['website', 'name']);
  }

  if (exactName) {
    add('name_exact', 'medium', 30, ['name']);
  } else if (
    !clearlyDistinctPeople &&
    incoming.name &&
    existing.name &&
    nameSimilarity >= 0.78
  ) {
    add('name_fuzzy', 'medium', 22, ['name']);
  }

  if (exactCompany) {
    add('company_exact', 'medium', 16, ['company']);
  } else if (
    incoming.company &&
    existing.company &&
    companyScore >= 0.76
  ) {
    add('company_fuzzy', 'medium', 12, ['company']);
  }

  if (incoming.city && incoming.city === existing.city) {
    add('city_same', 'medium', 10, ['city']);
  }
  if (
    incoming.address &&
    existing.address &&
    stringSimilarity(incoming.address, existing.address) >= 0.72
  ) {
    add('address_compatible', 'medium', 16, ['address']);
  }
  if (commonDomains.length) {
    add(
      'domain_same',
      'weak',
      8,
      commonWebsiteDomains.length ? ['website'] : ['emails']
    );
  }
  if (
    commonDomains.length &&
    !commonPhones.length &&
    !signals.some((signal) => signal.kind === 'phone_ocr_compatible') &&
    !clearlyDistinctPeople &&
    partialPhoneMatch(incoming.phones, existing.phones)
  ) {
    add(
      'phone_suffix_domain',
      'medium',
      28,
      ['phones', commonWebsiteDomains.length ? 'website' : 'emails']
    );
  }
  if (incoming.country && incoming.country === existing.country) {
    add('country_same', 'weak', 3, ['country']);
  }

  const strongSignals = signals.filter(
    (signal) => signal.strength === 'strong'
  );
  const personSignals = signals.filter(
    (signal) =>
      signal.kind === 'name_exact' || signal.kind === 'name_fuzzy'
  );
  const hasPartialPhoneDomain = signals.some(
    (signal) => signal.kind === 'phone_suffix_domain'
  );
  const hasFuzzyName = signals.some(
    (signal) => signal.kind === 'name_fuzzy'
  );
  const hasIndependentMediumForFuzzyName = signals.some(
    (signal) =>
      signal.strength === 'medium' &&
      signal.kind !== 'name_exact' &&
      signal.kind !== 'name_fuzzy'
  );

  if (
    (incoming.meaningfulFieldCount <= 1 ||
      existing.meaningfulFieldCount <= 1) &&
    !strongSignals.length
  ) {
    return null;
  }

  if (
    !strongSignals.length &&
    hasFuzzyName &&
    !hasIndependentMediumForFuzzyName &&
    !hasPartialPhoneDomain
  ) {
    // Un nome solo vagamente simile più un dominio condiviso può indicare
    // colleghi: serve una corroborazione realmente indipendente.
    return null;
  }

  // Azienda, dominio, sede o paese senza identità personale/forte non bastano.
  if (
    !strongSignals.length &&
    !personSignals.length &&
    !hasPartialPhoneDomain
  ) {
    return null;
  }

  let score = signals.reduce((sum, signal) => sum + signal.score, 0);
  if (
    clearlyDistinctPeople &&
    matchedEmail &&
    !matchedEmail.genericMailbox
  ) {
    // Una email personale identica resta forte, ma il conflitto richiede review.
    score -= 16;
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const comparisons = compareFields(incoming, existing);
  const exactFingerprint = signals.some(
    (signal) =>
      signal.kind === 'page_fingerprint' || signal.kind === 'image_set'
  );
  const exactEligibleStrongSignals = strongSignals.filter((signal) =>
    [
      'page_fingerprint',
      'image_set',
      'email_same',
      'phone_same',
      'whatsapp_same',
      'tax_id_same',
    ].includes(signal.kind)
  );
  const exactIdentity =
    signals.some((signal) => signal.kind === 'name_exact') &&
    signals.some((signal) => signal.kind === 'company_exact') &&
    exactEligibleStrongSignals.length > 0 &&
    !comparisons.differentFields.some((field) =>
      ['name', 'company', 'emails', 'phones', 'vatNumber', 'taxCode'].includes(
        field
      )
    );
  const hasCoreDifferences = comparisons.differentFields.some((field) =>
    ['name', 'company', 'emails', 'phones', 'vatNumber', 'taxCode'].includes(
      field
    )
  );

  let tier: DuplicateTier;
  if (
    exactFingerprint ||
    (exactEligibleStrongSignals.length >= 2 &&
      !clearlyDistinctPeople &&
      !hasCoreDifferences) ||
    exactIdentity
  ) {
    tier = 'exact';
  } else if (strongSignals.length) {
    tier = 'probable';
  } else {
    const mediumSignalCount = signals.filter(
      (signal) => signal.strength === 'medium'
    ).length;
    if (
      score < 28 ||
      (!hasPartialPhoneDomain &&
        (!personSignals.length || mediumSignalCount < 1))
    ) {
      return null;
    }
    tier = 'possible';
  }

  return {
    contact: existing.card,
    strength: tier === 'possible' ? 'medium' : 'strong',
    reason: legacyReason(signals),
    tier,
    score,
    reasons: signals.map((signal) => REASON_BY_SIGNAL[signal.kind]),
    signals,
    ...comparisons,
  };
}

const TIER_RANK: Record<DuplicateTier, number> = {
  exact: 3,
  probable: 2,
  possible: 1,
};

/**
 * Valuta tutti i candidati e li ordina in modo deterministico.
 * Non applica merge e non muta nessun record.
 */
export function findContactDuplicateCandidates(
  card: BusinessCard,
  existing: readonly BusinessCard[],
  excludeId?: string
): ContactDuplicateMatch[] {
  const incoming = context(card);
  return existing
    .filter((other) => {
      if (other.id === card.id) return false;
      if (excludeId && other.id === excludeId) return false;
      return true;
    })
    .map((other) => assessCandidate(incoming, context(other)))
    .filter((match): match is ContactDuplicateMatch => match !== null)
    .sort(
      (left, right) =>
        TIER_RANK[right.tier] - TIER_RANK[left.tier] ||
        right.score - left.score ||
        right.signals.reduce((sum, signal) => sum + signal.score, 0) -
          left.signals.reduce((sum, signal) => sum + signal.score, 0) ||
        left.contact.id.localeCompare(right.contact.id)
    );
}

/** Alias descrittivo per i nuovi consumer. */
export const assessContactDuplicates = findContactDuplicateCandidates;

/**
 * API legacy: restituisce il candidato migliore, ora derivato dalla valutazione
 * completa e deterministica.
 */
export function findContactDuplicate(
  card: BusinessCard,
  existing: BusinessCard[],
  excludeId?: string
): ContactDuplicateMatch | null {
  return findContactDuplicateCandidates(card, existing, excludeId)[0] ?? null;
}

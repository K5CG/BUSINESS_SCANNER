/**
 * Quality gate rielaborazione — non sovrascrivere campi buoni con candidati peggiori.
 */
import type { Address, BusinessCard, Phone } from '../types';
import { validatePersonName } from './parser-engine/validators/name';
import { hasLegalFormSuffix, normalizeBrandKey, ROLE_KEYWORD_REGEX } from './parser-engine/validators/dictionaries';
import { addressForeignContaminationRegression, isExplicitlyForeignAddress } from './geo-validation';
import { personEmailAffinityScore } from './parser-v5/person-email-ownership';
import { mergeReparsedEmailState } from './email-evidence';

export type ReparseDecision = 'accept' | 'keep_old' | 'manual_review';

export type ReparseFieldKey =
  | 'firstName'
  | 'lastName'
  | 'company'
  | 'role'
  | 'address'
  | 'vatNumber'
  | 'taxCode'
  | 'website';

export interface ReparseFieldDecision {
  field: ReparseFieldKey;
  oldValue: string;
  newValue: string;
  oldQuality: number;
  newQuality: number;
  decision: ReparseDecision;
  reasons: string[];
}

const PERSON_LABEL_RE =
  /\b(?:head|office|signature|firma|sede|commerciale|administration|center|senter|centro|unipersonale|societa|società|insurance|brokers)\b/i;

const PERSON_GARBAGE_RE =
  /[A-Z]{4,}[a-z][A-Z]{3,}|[a-z]{2,}[A-Z]{3,}[A-Za-z]*/;

/** Reject OCR fragments that repeat the identified person's name as a role. */
function isRolePersonNameMirror(role: string, firstName: string, lastName: string): boolean {
  if (!role.trim()) return false;
  const roleKey = normalizeBrandKey(role);
  const fullKey = normalizeBrandKey(`${firstName} ${lastName}`.trim());
  const lastKey = normalizeBrandKey(lastName ?? '');
  const firstKey = normalizeBrandKey(firstName ?? '');
  return (fullKey.length >= 4 && roleKey === fullKey) ||
    (lastKey.length >= 4 && roleKey === lastKey) ||
    (firstKey.length >= 4 && roleKey === firstKey) ||
    (lastKey.length >= 4 && firstKey.length >= 3 && roleKey.includes(lastKey) && roleKey.includes(firstKey));
}

function isAllCapsOcrGarbage(role: string): boolean {
  const value = role.trim();
  if (!value || /^(?:CEO|CFO|CTO|COO|CMO|CIO|VP|SVP|EVP|HR|IT|R&D|PM|GM|MD|PA)$/.test(value)) return false;
  if (ROLE_KEYWORD_REGEX.test(value)) return false;
  const compact = value.replace(/\s+/g, '');
  return compact === compact.toUpperCase() && compact.length >= 5 && !/[@./]/.test(compact);
}

function isAcademicAffiliationInRole(role: string): boolean {
  return /\b(?:universit[aà]|politecnico|istituto|accademia|college|university|division\s+of)\b/i.test(role);
}

function norm(v: unknown): string {
  return (v ?? '').toString().trim();
}

function scorePersonField(
  first: string,
  last: string,
  emails: string[] = []
): number {
  first = norm(first);
  last = norm(last);
  let score = 0;
  if (!first && !last) return 0;
  if (PERSON_LABEL_RE.test(`${first} ${last}`)) score -= 8;
  if (PERSON_GARBAGE_RE.test(`${first} ${last}`)) score -= 6;
  const validated = validatePersonName({ firstName: first, lastName: last });
  if (validated?.firstName && validated.lastName) score += 4;
  else if (validated?.firstName || validated?.lastName) score += 1;
  if (first && last && normalizeBrandKey(first) === normalizeBrandKey(last)) score -= 3;
  const affinity = personEmailAffinityScore(first, last, emails);
  score += Math.min(affinity, 4);
  if (first.replace(/\./g, '').length <= 1 && last.length >= 8) score -= 4;
  return score;
}

function scoreCompany(value: string): number {
  const t = value.trim();
  if (!t) return 0;
  let score = 1;
  const words = t.split(/\s+/).filter(Boolean);
  score += Math.min(words.length, 4);
  if (hasLegalFormSuffix(t) || /\b(?:s\.?\s*r\.?\s*l|spa|srl|gmbh|ltd|limited|inc)\b/i.test(t)) {
    score += 4;
  }
  if (t.length >= 12) score += 1;
  if (PERSON_LABEL_RE.test(t)) score -= 5;
  return score;
}

function scoreRole(value: string, firstName: string = '', lastName: string = ''): number {
  const t = value.trim();
  if (!t) return 0;
  if (PERSON_LABEL_RE.test(t)) return -2;
  if (/^a\s+socio\s+unico$/i.test(t)) return -3;
  if (ROLE_KEYWORD_REGEX.test(t)) return 4;
  if (PERSON_GARBAGE_RE.test(t)) return -5;
  if (isRolePersonNameMirror(t, firstName, lastName)) return -8;
  if (isAcademicAffiliationInRole(t)) return -4;
  if (isAllCapsOcrGarbage(t)) return -3;
  return 1;
}

function sameText(left: string | undefined, right: string | undefined): boolean {
  const a = normalizeBrandKey(left ?? '');
  const b = normalizeBrandKey(right ?? '');
  return a.length >= 3 && a === b;
}

function hasManualOverride(card: BusinessCard, field: 'company' | 'role' | 'address'): boolean {
  return Boolean(card.contactReviewState && Object.prototype.hasOwnProperty.call(
    card.contactReviewState.manualOverrides,
    field,
  ));
}

function isPersonOrCompanyCollision(card: BusinessCard): boolean {
  const person = `${card.firstName ?? ''} ${card.lastName ?? ''}`.trim();
  return sameText(card.role, card.company) || sameText(card.role, person) || sameText(card.role, card.lastName);
}

function hasFusedCivicAndPostalCode(address: Address | undefined | null): boolean {
  const civic = address?.civicNumber?.trim() ?? '';
  return /^\d{1,5}[a-z]?\s*-\s*\d{5}$/i.test(civic);
}

function isNearOcrRegression(current: string, initial: string): boolean {
  const now = normalizeBrandKey(current);
  const first = normalizeBrandKey(initial);
  if (!now || !first || now === first || Math.abs(now.length - first.length) > 1) return false;
  let changes = 0;
  let left = 0;
  let right = 0;
  while (left < now.length && right < first.length) {
    if (now[left] === first[right]) {
      left += 1;
      right += 1;
      continue;
    }
    if (++changes > 1) return false;
    if (now.length > first.length) left += 1;
    else if (first.length > now.length) right += 1;
    else {
      left += 1;
      right += 1;
    }
  }
  return true;
}

function looksLikeGluedDomainBrand(value: string): boolean {
  return /\.(?:it|com|net|org|eu|de|fr|uk|biz|info)[A-Z]/i.test(value.trim());
}

function isShortCompanyFragment(value: string, company: string): boolean {
  const part = normalizeBrandKey(value);
  const whole = normalizeBrandKey(company);
  return part.length >= 4 && part.length <= 12 && whole.length > part.length + 3 && whole.includes(part);
}

/**
 * I contatti gia' passati da una versione difettosa mantengono lo snapshot
 * iniziale. Lo si ripristina solo quando il valore corrente e'
 * semanticamente impossibile e non e' stato corretto manualmente dall'utente.
 */
function restoreCorruptedFieldsFromInitial(card: BusinessCard): BusinessCard {
  const initial = card.contactReviewState?.parsedInitial;
  if (!initial) return card;
  let next = card;
  if (
    !hasManualOverride(card, 'role') &&
    isPersonOrCompanyCollision(card) &&
    initial.role.trim() &&
    !sameText(initial.role, initial.company) &&
    !sameText(initial.role, `${initial.firstName} ${initial.lastName}`.trim())
  ) {
    next = { ...next, role: initial.role };
  }
  if (
    !hasManualOverride(card, 'company') &&
    isRoleOrCredential(card.company) &&
    initial.company.trim() &&
    !isRoleOrCredential(initial.company)
  ) {
    next = { ...next, company: initial.company };
  }
  if (
    !hasManualOverride(card, 'address') &&
    hasFusedCivicAndPostalCode(card.address) &&
    initial.address && !hasFusedCivicAndPostalCode(initial.address)
  ) {
    next = { ...next, address: { ...initial.address } };
  }
  // Uno snapshot iniziale è evidenza OCR già acquisita: una ri-elaborazione
  // non può sostituirlo con una variante a una sola lettera (es. cognome
  // troncato), se il campo non è stato modificato manualmente.
  if (
    !Object.prototype.hasOwnProperty.call(card.contactReviewState!.manualOverrides, 'lastName') &&
    initial.lastName?.trim() &&
    (
      isNearOcrRegression(card.lastName, initial.lastName) ||
      (
        initial.lastName.trim().length >= 5 &&
        new RegExp(`\\b${initial.lastName.trim().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(card.rawText ?? '') &&
        !new RegExp(`\\b${card.lastName.trim().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(card.rawText ?? '')
      )
    )
  ) {
    next = { ...next, lastName: initial.lastName };
  }
  // Un dominio/brand terminato e poi incollato alla riga successiva non è una
  // ragione sociale più ricca: lo snapshot separato è più affidabile.
  if (
    !hasManualOverride(card, 'company') &&
    initial.company?.trim() &&
    looksLikeGluedDomainBrand(card.company) &&
    normalizeBrandKey(card.company).startsWith(normalizeBrandKey(initial.company))
  ) {
    next = { ...next, company: initial.company };
  }
  if (
    !hasManualOverride(card, 'role') &&
    initial.role?.trim() &&
    isShortCompanyFragment(card.role, card.company) &&
    !isShortCompanyFragment(initial.role, initial.company)
  ) {
    next = { ...next, role: initial.role };
  }
  return next;
}

/** Ruoli/professioni non sono ragioni sociali, anche se la frase è lunga. */
function isRoleOrCredential(value: string): boolean {
  const text = value.trim();
  if (!text || hasLegalFormSuffix(text)) return false;
  return ROLE_KEYWORD_REGEX.test(text) ||
    /\b(?:dottore\s+commercialista|revisore\s+contabile|commercialista|avvocat[oa]|ingegner[ea]|architett[oa]|perito\s+industriale|consulent[ea]|amministratore|direttore|responsabile|manager|presidente|founder|partner)\b/i.test(text);
}

function scoreAddress(addr: Address | undefined, rawText: string): number {
  const full = norm(addr?.full);
  if (!full) return 0;
  let score = 2;
  if (/\b(?:via|viale|piazza|corso|strada)\b/i.test(full)) score += 2;
  if (/\b\d{5}\b/.test(full)) score += 1;
  if (/\(\s*[A-Z]{2}\s*\)/.test(full)) score += 1;
  if (isExplicitlyForeignAddress(full) && /\(\s*[A-Z]{2}\s*\)\s*-\s*IT\b/i.test(full)) score -= 8;
  if (/\b(?:tel\.?|fax|@|www\.)\b/i.test(full)) score -= 4;
  if (/\b(?:p\.?\s*iva|partita\s+iva|vat|codice\s+fiscale|c\.?\s*f\.?)\b/i.test(full)) score -= 5;
  if (rawText && isExplicitlyForeignAddress(rawText) && !isExplicitlyForeignAddress(full)) {
    score -= 2;
  }
  return score;
}

function companyShorteningRegression(oldVal: string, newVal: string): boolean {
  const o = oldVal.trim();
  const n = newVal.trim();
  if (!o || !n || o === n) return false;
  const oKey = normalizeBrandKey(o);
  const nKey = normalizeBrandKey(n);
  if (oKey.length >= 10 && nKey.length < oKey.length - 4) {
    if (hasLegalFormSuffix(o) && !hasLegalFormSuffix(n)) return true;
    if (o.split(/\s+/).length >= 3 && n.split(/\s+/).length <= 2) return true;
    if (oKey.includes(nKey) && nKey.length <= 8) return true;
  }
  return false;
}

function mergePhones(prevPhones: Phone[] | undefined, parsedPhones: Phone[] | undefined): Phone[] {
  const previous = prevPhones ?? [];
  const parsed = parsedPhones ?? [];
  if (parsed.length === 0) return previous;
  const clean = parsed.filter((phone) => {
    const digits = (phone.number ?? '').replace(/\D/g, '');
    return digits.length >= 8 && digits.replace(/[01]/g, '').length > 1;
  });
  return clean.length > 0 || previous.length === 0 ? clean : previous;
}

function pickField(
  field: ReparseFieldKey,
  oldVal: string,
  newVal: string,
  oldQ: number,
  newQ: number,
  extraReasons: string[] = []
): ReparseFieldDecision {
  let decision: ReparseDecision = 'accept';
  const reasons = [...extraReasons];

  if (!newVal && oldVal) {
    decision = 'keep_old';
    reasons.push('nuovo vuoto, conservo precedente');
  } else if (newVal && !oldVal) {
    decision = newQ > oldQ ? 'accept' : 'manual_review';
    reasons.push('campo prima vuoto');
  } else if (newVal === oldVal) {
    decision = 'accept';
    reasons.push('invariato');
  } else if (newQ < oldQ - 0.25) {
    decision = 'keep_old';
    reasons.push(`qualità nuova ${newQ.toFixed(1)} < precedente ${oldQ.toFixed(1)}`);
  } else if (newQ <= oldQ + 0.25) {
    decision = 'keep_old';
    reasons.push('miglioramento non dimostrato');
  } else {
    decision = 'accept';
    reasons.push(`qualità nuova ${newQ.toFixed(1)} > precedente ${oldQ.toFixed(1)}`);
  }

  return { field, oldValue: oldVal, newValue: newVal, oldQuality: oldQ, newQuality: newQ, decision, reasons };
}

export function mergeReparseWithQualityGate(
  prev: BusinessCard,
  parsed: BusinessCard
): { card: BusinessCard; decisions: ReparseFieldDecision[] } {
  prev = restoreCorruptedFieldsFromInitial(prev);
  const decisions: ReparseFieldDecision[] = [];
  const emails = parsed.emails?.length ? parsed.emails : prev.emails ?? [];

  const oldPersonQ = scorePersonField(prev.firstName, prev.lastName, emails);
  const newPersonQ = scorePersonField(parsed.firstName, parsed.lastName, emails);
  let firstName = parsed.firstName;
  let lastName = parsed.lastName;

  const personReasons: string[] = [];
  if (PERSON_LABEL_RE.test(`${parsed.firstName} ${parsed.lastName}`)) {
    personReasons.push('etichetta/ruolo come persona');
  }
  if (companyShorteningRegression(`${prev.firstName} ${prev.lastName}`, `${parsed.firstName} ${parsed.lastName}`)) {
    personReasons.push('persona precedente più plausibile');
  }

  const personPick = pickField(
    'firstName',
    `${prev.firstName} ${prev.lastName}`.trim(),
    `${parsed.firstName} ${parsed.lastName}`.trim(),
    oldPersonQ,
    newPersonQ,
    personReasons
  );
  if (personPick.decision === 'keep_old') {
    firstName = prev.firstName;
    lastName = prev.lastName;
  } else if (
    personPick.decision === 'manual_review' &&
    !`${prev.firstName ?? ''} ${prev.lastName ?? ''}`.trim() &&
    `${parsed.firstName ?? ''} ${parsed.lastName ?? ''}`.trim()
  ) {
    firstName = parsed.firstName;
    lastName = parsed.lastName;
  }
  decisions.push({ ...personPick, field: 'firstName' });
  decisions.push({
    ...personPick,
    field: 'lastName',
    oldValue: prev.lastName,
    newValue: parsed.lastName,
  });

  const oldCompQ = scoreCompany(prev.company);
  const newCompQ = scoreCompany(parsed.company);
  const compReasons: string[] = [];
  if (companyShorteningRegression(prev.company, parsed.company)) {
    compReasons.push('accorciamento brand senza forma giuridica');
  }
  const compPick = pickField('company', prev.company, parsed.company, oldCompQ, newCompQ, compReasons);
  if (
    prev.company.trim() &&
    !hasLegalFormSuffix(parsed.company) &&
    (isRoleOrCredential(parsed.company) || sameText(parsed.company, prev.role))
  ) {
    compPick.decision = 'keep_old';
    compPick.reasons.push('nuova azienda è un ruolo/professione o il precedente ruolo');
  }
  const company = compPick.decision === 'accept' ? parsed.company : prev.company;
  decisions.push(compPick);

  const oldRoleQ = scoreRole(prev.role, prev.firstName, prev.lastName);
  const newRoleQ = scoreRole(parsed.role, parsed.firstName ?? firstName, parsed.lastName ?? lastName);
  const roleReasons: string[] = [];
  if (!parsed.role && prev.role && oldRoleQ >= 3) {
    roleReasons.push('ruolo valido cancellato');
  }
  if (isRolePersonNameMirror(parsed.role, parsed.firstName ?? firstName, parsed.lastName ?? lastName)) {
    roleReasons.push('ruolo è specchio del nominativo (artefatto OCR)');
  }
  if (isAcademicAffiliationInRole(parsed.role)) roleReasons.push('affiliazione istituzionale nel campo ruolo');
  if (isAllCapsOcrGarbage(parsed.role)) roleReasons.push('testo tutto-maiuscolo non riconosciuto come ruolo valido');
  const rolePick = pickField('role', prev.role, parsed.role, oldRoleQ, newRoleQ, roleReasons);
  const parsedPerson = `${parsed.firstName ?? ''} ${parsed.lastName ?? ''}`.trim();
  const previousPerson = `${prev.firstName ?? ''} ${prev.lastName ?? ''}`.trim();
  if (
    parsed.role.trim() &&
    (sameText(parsed.role, prev.company) || sameText(parsed.role, parsedPerson) || sameText(parsed.role, previousPerson))
  ) {
    rolePick.decision = 'keep_old';
    rolePick.reasons.push('nuovo ruolo coincide con azienda o nominativo');
  }
  let role = rolePick.decision === 'accept' ? parsed.role : prev.role;
  if (!parsed.role && prev.role && oldRoleQ >= 3) role = prev.role;
  decisions.push(rolePick);

  const oldAddr = norm(prev.address?.full);
  const newAddr = norm(parsed.address?.full);
  const oldAddrQ = scoreAddress(prev.address, prev.rawText ?? '');
  const newAddrQ = scoreAddress(parsed.address, prev.rawText ?? '');
  const addrReasons: string[] = [];
  if (addressForeignContaminationRegression(oldAddr, newAddr)) {
    addrReasons.push('provincia/country IT su indirizzo estero');
  }
  const addrPick = pickField('address', oldAddr, newAddr, oldAddrQ, newAddrQ, addrReasons);
  let address = addrPick.decision === 'accept' ? parsed.address : prev.address;
  if (addressForeignContaminationRegression(oldAddr, newAddr)) {
    address = prev.address;
  }
  decisions.push(addrPick);

  for (const field of ['vatNumber', 'taxCode', 'website'] as const) {
    const o = norm(prev[field]);
    const n = norm(parsed[field]);
    const pick = pickField(field, o, n, o ? 3 : 0, n ? 3 : 0);
  if (field === 'vatNumber' || field === 'taxCode') {
      if (!n && o) pick.decision = 'keep_old';
    }
    decisions.push(pick);
  }

  const vatPick = decisions.find((d) => d.field === 'vatNumber')!;
  const taxPick = decisions.find((d) => d.field === 'taxCode')!;
  const webPick = decisions.find((d) => d.field === 'website')!;

  const emailState = mergeReparsedEmailState(prev, parsed);
  const phones = mergePhones(prev.phones, parsed.phones);
  const card: BusinessCard = {
    ...prev,
    firstName,
    lastName,
    company,
    role,
    emails: emailState.emails,
    emailEvidence: emailState.emailEvidence,
    phones,
    website: webPick.decision === 'accept' ? parsed.website : prev.website,
    address,
    vatNumber: vatPick.decision === 'accept' ? parsed.vatNumber : prev.vatNumber,
    taxCode: taxPick.decision === 'accept' ? parsed.taxCode : prev.taxCode,
    confidence: parsed.confidence,
    extractionReview: emailState.extractionReview,
    updatedAt: new Date(),
  };

  // Esegui il recupero anche dopo la fusione: il candidato può avere un
  // punteggio formale alto pur avendo ri-incollato una riga OCR già separata
  // nello snapshot. Lo snapshot non prevale mai su un override manuale.
  const recovered = restoreCorruptedFieldsFromInitial(card);
  return {
    card: {
      ...recovered,
      title: `${recovered.company ?? ''} ${recovered.firstName ?? ''} ${recovered.lastName ?? ''}`.trim(),
    },
    decisions,
  };
}

/**
 * parser-v5/index.ts — Adapter verso i contratti esistenti dell'app.
 *
 * - parseCardFromPagesV5(pages)  → stessa forma di ritorno del parser legacy
 *   (drop-in per MultiPageScanner), con confidence NUMERICHE reali e
 *   extractionReview già popolato.
 * - extractBusinessCardV5(pages) → BusinessCardExtractionResult (stesso
 *   formato del v4: il banner di review continua a funzionare invariato).
 */

import type { Address, BusinessCard, OcrLine, Phone } from '../../types';
import type {
  BusinessCardExtractionResult,
  ExtractedField,
  FieldConfidence,
} from '../parser-engine/card-extraction-result';
import { createId } from '../id';
import { normalizeAddress } from '../address-format';
import { extractCardV5 } from './engine';
import type { CardPageV5, V5Field, V5Result } from './engine';
import { emailDomainIncoherentWithWebsite } from './email-website-coherence';
import { isOcrRoleGarbage } from './role-quality';
import { hasAmbiguousTerminalLegalSeparator, hasLegalForm, isCommonFirstName, ROLE_KEYWORD_REGEX } from '../parser-engine/validators/dictionaries';
import { hasConfusableDigitInsideBrandToken } from '../parser-engine/validators/brand-normalizer';

export type { CardPageV5 } from './engine';

// ---------------------------------------------------------------------------

function toConfidence(score: number): FieldConfidence {
  return score >= 0.74 ? 'high' : score >= 0.44 ? 'medium' : 'low';
}

function toField<T>(
  f: V5Field<T>,
  source: ExtractedField<T>['source'] = f.source ?? 'layout'
): ExtractedField<T> {
  return {
    value: f.value,
    confidence: toConfidence(f.score),
    score: Number(f.score.toFixed(3)),
    source,
    reasons: f.reasons,
  };
}

function toAddressValue(a: V5Result['address']['value']): Address | undefined {
  if (!a) return undefined;
  const region = a.region?.trim().toUpperCase();
  // A trailing one-letter province artefact (e.g. "Schio (v)") is not a
  // locality.  Remove it only when a real two-letter province is present;
  // this keeps ordinary parenthetical locality data intact.
  const city = region && /^[A-Z]{2}$/.test(region)
    ? a.city?.replace(/\s*\([\p{L}]\)\s*$/u, '').trim()
    : a.city;
  const draft: Address = {
    full: city && city !== a.city
      ? a.full.replace(new RegExp(`\\b${a.city!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?=[,\-]|$)`, 'u'), city)
      : a.full,
    street: a.street,
    civicNumber: a.civicNumber,
    postalCode: a.postalCode,
    city,
    region,
    country: a.country,
  };
  // Un blocco universale e gia validato e conserva dettagli OCR che il
  // normalizzatore storico non modella (P.O. Box, stanza, edificio, range).
  if (a.rawLines?.length) return draft;
  try {
    const normalized = normalizeAddress(draft) ?? draft;
    return {
      ...normalized,
      postalCode: draft.postalCode ?? normalized.postalCode,
      city: draft.city ?? normalized.city,
      region: draft.region ?? normalized.region,
      country: draft.country ?? normalized.country,
    };
  } catch {
    return draft;
  }
}

function toAddress(r: V5Result): Address | undefined {
  return toAddressValue(r.address.value);
}

function toAddressAlternatives(r: V5Result): Address[] {
  return r.addressAlternatives
    .map((address) => toAddressValue(address))
    .filter((address): address is Address => Boolean(address));
}

function normalizedPersonText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recovers one missing terminal OCR letter in a surname only when the fuller
 * spelling is observed on the same OCR line together with the selected first
 * name. It does not invent a legal/company conversion and it never changes a
 * multi-letter difference.
 */
function completeTerminalSurnameFromSameLineEvidence(
  result: V5Result,
  pages: CardPageV5[],
): V5Result {
  const first = result.firstName.value?.trim() ?? '';
  const last = result.lastName.value?.trim() ?? '';
  if (!first || !last || last.length < 4) return result;

  const firstKey = normalizedPersonText(first);
  const lastWords = last.split(/\s+/).filter(Boolean);
  const lastKey = normalizedPersonText(last);
  if (!firstKey || lastWords.length === 0 || !lastKey) return result;

  const candidate = pages
    .flatMap((page) => page.lines?.map((line) => String(line.text ?? '')) ?? page.rawText.split(/\r?\n/))
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .find((line) => {
      const normalizedLine = normalizedPersonText(line);
      if (!normalizedLine.includes(firstKey)) return false;
      const words = line.match(/[\p{L}'’-]+/gu) ?? [];
      for (let index = 0; index <= words.length - lastWords.length; index++) {
        const phrase = words.slice(index, index + lastWords.length).join(' ');
        const phraseKey = normalizedPersonText(phrase);
        // Exactly one observed terminal letter may be restored; every other
        // letter must already agree with the OCR surname.
        if (
          phraseKey.length === lastKey.length + 1 &&
          phraseKey.startsWith(lastKey)
        ) {
          return true;
        }
      }
      return false;
    });

  if (!candidate) return result;
  const words = candidate.match(/[\p{L}'’-]+/gu) ?? [];
  for (let index = 0; index <= words.length - lastWords.length; index++) {
    const phrase = words.slice(index, index + lastWords.length).join(' ');
    const phraseKey = normalizedPersonText(phrase);
    if (phraseKey.length === lastKey.length + 1 && phraseKey.startsWith(lastKey)) {
      return {
        ...result,
        lastName: {
          ...result.lastName,
          value: phrase,
          score: Math.max(result.lastName.score, 0.78),
          reasons: [...result.lastName.reasons, 'cognome completato da evidenza OCR sulla stessa riga'],
        },
      };
    }
  }
  return result;
}

function pageTextLines(pages: CardPageV5[]): string[] {
  return pages.flatMap((page) =>
    page.lines?.length
      ? page.lines.map((line) => String(line.text ?? ''))
      : page.rawText.split(/\r?\n/),
  );
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return true;
}

/**
 * Removes only a leading OCR artefact made almost entirely of binary-looking
 * glyphs.  It deliberately leaves normal identifiers, phone numbers and the
 * first readable word untouched.
 */
function stripBinaryOcrPrefix(value: string): string {
  return value.replace(/^\s*(?:[01OIlxXoi]{6,}\s+)+/u, '').trim();
}

function normalizeObservedAcronymLegalSurface(value: string): string {
  const cleaned = stripBinaryOcrPrefix(value);
  const match = /^(.+?)(?:,|\s+)\s*(s\.n\.c\.)$/iu.exec(cleaned);
  if (!match) return cleaned;
  const base = match[1].trim();
  const letters = base.replace(/[^\p{L}]/gu, '');
  // This is surface recovery for an observed short acronym, not a legal-form
  // conversion.  Full company names keep their observed separator unchanged.
  if (letters.length < 2 || letters.length > 8 || !/^[\p{Lu}.\s]+$/u.test(base)) {
    return cleaned;
  }
  return `${base.replace(/[,.\s]+$/u, '')}. ${match[2]}`;
}

function recoverPersonEmailFromObservedEvidence(result: V5Result): V5Result {
  const first = normalizedPersonText(result.firstName.value ?? '').replace(/\s/g, '');
  const last = normalizedPersonText(result.lastName.value ?? '').replace(/\s/g, '');
  if (first.length < 2 || last.length < 3) return result;

  let changed = false;
  const replacements = new Map<string, string>();
  for (const evidence of result.emailEvidence) {
    if (evidence.origin !== 'observed' || evidence.validationStatus !== 'valid') continue;
    const match = /^([\p{L}]+)\.([\p{L}]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/iu.exec(evidence.value);
    if (!match) continue;
    const observedFirst = normalizedPersonText(match[1]).replace(/\s/g, '');
    const observedLast = normalizedPersonText(match[2]).replace(/\s/g, '');
    if (observedFirst !== first || !editDistanceAtMostOne(observedLast, last) || observedLast === last) continue;
    replacements.set(evidence.value.toLowerCase(), `${match[1]}.${result.lastName.value!.trim()}@${match[3]}`.toLowerCase());
  }
  if (!replacements.size) return result;

  const emails = (result.emails.value ?? []).map((value) => replacements.get(value.toLowerCase()) ?? value);
  const emailEvidence = result.emailEvidence.map((evidence) => {
    const recovered = replacements.get(evidence.value.toLowerCase());
    if (!recovered) return evidence;
    changed = true;
    return {
      ...evidence,
      value: recovered,
      repairedValue: recovered,
      origin: 'repaired' as const,
      transformations: [...evidence.transformations, 'local_part_aligned_with_selected_person_one_edit'],
      confidence: Math.min(evidence.confidence, 0.72),
      requiresReview: true,
      confirmed: false,
    };
  });
  return changed
    ? {
        ...result,
        emails: {
          ...result.emails,
          value: [...new Set(emails.map((value) => value.toLowerCase()))],
          reasons: [...result.emails.reasons, 'email locale riallineata al nominativo OCR con una sola differenza'],
        },
        emailEvidence,
      }
    : result;
}

const ITALIAN_ADDRESS_RE = /\b((?:via|viale|vicolo|piazza|corso|largo|piazzale)\s+[\p{L}\p{N}'’.\- ]+?),?\s*((?:n(?:r|\.?|°)\s*)?\d+[\p{L}]?(?:\/[\p{L}\p{N}]+)?)\s*[-–]?\s*(\d{5})\s+([\p{L}'’\- ]+?)\s*\(([A-Za-z]{2})\)?/iu;

function removeEmailCorroboratedRepeatedGivenName(result: V5Result): V5Result {
  const first = result.firstName.value?.trim() ?? '';
  const last = result.lastName.value?.trim() ?? '';
  const parts = last.split(/\s+/).filter(Boolean);
  if (!first || parts.length < 2 || normalizedPersonText(parts[0]) !== normalizedPersonText(first)) return result;
  const localExpected = `${normalizedPersonText(first)}${normalizedPersonText(parts.slice(1).join(''))}`.replace(/\s/g, '');
  const corroborated = result.emailEvidence.some((item) => {
    if (item.origin !== 'observed' || item.validationStatus !== 'valid') return false;
    return personEvidenceKey(item.value.split('@')[0]) === localExpected;
  });
  if (!corroborated) return result;
  return {
    ...result,
    lastName: {
      ...result.lastName,
      value: parts.slice(1).join(' '),
      score: Math.max(result.lastName.score, 0.8),
      reasons: [...result.lastName.reasons, 'nome duplicato rimosso: email osservata conferma il cognome'],
    },
  };
}

const GENERIC_MAIL_HOSTS = new Set([
  'gmail', 'yahoo', 'hotmail', 'outlook', 'live', 'icloud', 'libero', 'virgilio', 'alice', 'tiscali',
]);

function titleCaseDomainBrand(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * A logo-shaped OCR word is weak evidence. Two independently observed,
 * non-generic e-mails on the same domain are stronger textual evidence and
 * can name the company without guessing from pixels or a visual logo.
 */
function recoverCompanyFromRepeatedObservedEmailDomain(result: V5Result): V5Result {
  const domains = new Map<string, number>();
  for (const evidence of result.emailEvidence) {
    if (evidence.origin !== 'observed' || evidence.validationStatus !== 'valid') continue;
    const host = evidence.value.split('@')[1]?.toLowerCase().replace(/^www\./, '');
    const root = host?.split('.')[0]?.replace(/[^a-z0-9-]/g, '');
    if (!root || root.length < 3 || GENERIC_MAIL_HOSTS.has(root)) continue;
    domains.set(root, (domains.get(root) ?? 0) + 1);
  }
  const ranked = [...domains.entries()].sort((a, b) => b[1] - a[1]);
  const [root, count] = ranked[0] ?? [];
  if (!root || count < 2 || (ranked[1]?.[1] ?? 0) === count) return result;
  const recovered = titleCaseDomainBrand(root);
  if (!recovered || result.company.value === recovered) return result;
  return {
    ...result,
    company: {
      ...result.company,
      value: recovered,
      score: Math.max(result.company.score, 0.8),
      source: 'observed',
      reasons: [...result.company.reasons, 'azienda derivata da due email osservate sullo stesso dominio'],
    },
  };
}

/** Rejects a label-like OCR tail (e.g. address/image artefact) while retaining
 * a short clean acronym only when the observed e-mail domain corroborates it. */
function removeLabelLikeCompanyTail(result: V5Result): V5Result {
  const current = result.company.value?.trim() ?? '';
  const match = /^([A-Z]{2,12})\s+(?:[\p{L}]*?(?:add|addr|tel|fax|mail|web)[\p{L}]*\s*:\s*.+)$/iu.exec(current);
  if (!match) return result;
  const acronym = match[1].toUpperCase();
  const corroborated = result.emailEvidence.some((evidence) => {
    if (evidence.origin !== 'observed' || evidence.validationStatus !== 'valid') return false;
    const hostRoot = evidence.value.split('@')[1]?.toLowerCase().split('.')[0] ?? '';
    return hostRoot === acronym.toLowerCase() || hostRoot.startsWith(acronym.toLowerCase());
  });
  if (!corroborated) return result;
  return {
    ...result,
    company: {
      ...result.company,
      value: acronym,
      score: Math.max(result.company.score, 0.8),
      reasons: [...result.company.reasons, 'coda OCR con etichetta tecnica esclusa: acronimo corroborato dal dominio email'],
    },
  };
}

function recoverItalianAddressFromObservedLine(result: V5Result, pages: CardPageV5[]): V5Result {
  const candidate = pageTextLines(pages)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .map((line) => ITALIAN_ADDRESS_RE.exec(line))
    .find((match): match is RegExpExecArray => Boolean(match));
  if (!candidate) return result;
  const [, street, civicNumber, postalCode, city, region] = candidate;
  const normalizedCity = city.trim().replace(/[\s,.-]+$/u, '');
  if (!normalizedCity || /^(agenzia|immobiliare|consulting)$/iu.test(normalizedCity)) return result;
  const full = `${street.trim()}, ${civicNumber.trim()} - ${postalCode} ${normalizedCity} (${region.toUpperCase()})`;
  return {
    ...result,
    address: {
      ...result.address,
      value: {
        ...(result.address.value ?? { full }),
        full,
        street: street.trim(),
        civicNumber: civicNumber.trim(),
        postalCode,
        city: normalizedCity,
        region: region.toUpperCase(),
        rawLines: [candidate[0]],
        partial: false,
        completeness: 1,
      },
      score: Math.max(result.address.score, 0.76),
      reasons: [...result.address.reasons, 'indirizzo italiano ricomposto da riga OCR con CAP e provincia'],
    },
  };
}

/** Conservative, evidence-only repairs shared by preview and persisted card. */
function applyObservedStructuralRecovery(result: V5Result, pages: CardPageV5[]): V5Result {
  const company = result.company.value
    ? {
        ...result.company,
        value: normalizeObservedAcronymLegalSurface(result.company.value),
      }
    : result.company;
  const withCompany = company === result.company ? result : { ...result, company };
  return recoverItalianAddressFromObservedLine(
    recoverCompanyFromRepeatedObservedEmailDomain(
      removeLabelLikeCompanyTail(
        removeEmailCorroboratedRepeatedGivenName(
          recoverPersonEmailFromObservedEvidence(withCompany),
        ),
      ),
    ),
    pages,
  );
}

// ---------------------------------------------------------------------------

function emailSource(r: V5Result): ExtractedField<string[]>['source'] {
  if (r.emailEvidence.some((item) => item.origin === 'observed')) {
    return 'observed';
  }
  if (r.emailEvidence.some((item) => item.origin === 'repaired')) {
    return 'repaired';
  }
  return 'observed';
}

const HONORIFIC_PERSON_PREFIX_RE =
  /^(?:(?:dr\.?(?:ssa)?|dott\.?(?:ssa)?|ing\.?|arch\.?|avv\.?|prof\.?|mr\.?|mrs\.?|ms\.?|sig\.?(?:ra)?|herr|frau)\s+)+/i;

function personEvidenceKey(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

function observedEmailCorroboratesPerson(r: V5Result): boolean {
  const first = personEvidenceKey(r.firstName.value);
  const last = personEvidenceKey(r.lastName.value);
  if (first.length < 3 || last.length < 3) return false;

  return r.emailEvidence.some((item) => {
    if (
      item.origin !== 'observed' ||
      !item.confirmed ||
      item.requiresReview ||
      item.validationStatus !== 'valid'
    ) {
      return false;
    }
    const local = personEvidenceKey(item.value.split('@')[0]);
    return local.includes(first) && local.includes(last);
  });
}

function ocrLineReliability(line: OcrLine): number | null {
  const candidates = [
    line.measuredConfidence,
    line.heuristicQuality,
    line.confidence,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return Math.max(0, Math.min(1, candidate));
    }
  }
  return null;
}

function honorificPersonNeedsReview(
  r: V5Result,
  pages: CardPageV5[]
): boolean {
  const sourceIds = new Set([
    ...(r.firstName.lineIds ?? []),
    ...(r.lastName.lineIds ?? []),
  ]);
  if (!sourceIds.size || !r.firstName.value || !r.lastName.value) return false;
  if (isCommonFirstName(r.firstName.value)) return false;
  if (observedEmailCorroboratesPerson(r)) return false;

  const debugLine = r.debugLines.find(
    (line) =>
      sourceIds.has(line.id) &&
      HONORIFIC_PERSON_PREFIX_RE.test(line.text.trim())
  );
  if (!debugLine) return false;

  const sourceTextKey = personEvidenceKey(debugLine.text);
  const sourceLine = pages[debugLine.page]?.lines.find(
    (line) => personEvidenceKey(line.text) === sourceTextKey
  );
  if (!sourceLine) return false;

  const reliability = ocrLineReliability(sourceLine);
  return (
    sourceLine.confidenceType === 'heuristic' ||
    (reliability !== null && reliability < 0.85)
  );
}

function roleSourceNeedsReview(r: V5Result): boolean {
  const sourceIds = new Set(r.role.lineIds ?? []);
  if (!sourceIds.size) return false;
  return r.debugLines.some(
    (line) => sourceIds.has(line.id) && isOcrRoleGarbage(line.text)
  );
}

function applyConfidenceReviewSafety(
  result: BusinessCardExtractionResult,
  r: V5Result,
  pages: CardPageV5[]
): BusinessCardExtractionResult {
  const review: string[] = [];
  const semantic: Array<[string, ExtractedField<unknown>]> = [
    ['firstName', result.firstName],
    ['lastName', result.lastName],
    ['company', result.company],
    ['role', result.role],
    ['address', result.address],
  ];

  for (const [key, field] of semantic) {
    if (
      field.value == null ||
      field.value === '' ||
      field.confidence !== 'high'
    ) {
      review.push(key);
    }
  }

  if (honorificPersonNeedsReview(r, pages)) {
    review.push('firstName', 'lastName');
  }
  if (r.pageCoherence.requiresReview) {
    review.push('pageMismatch');
  }
  if (
    emailDomainIncoherentWithWebsite(r.emails.value ?? [], r.website.value) ||
    r.emailDomainOcrMismatch
  ) {
    review.push('emails');
  }
  if (r.emailEvidence.some((item) => item.requiresReview || !item.confirmed)) {
    review.push('emails');
  }

  if (r.address.value?.partial || r.address.value?.requiresReview) {
    review.push('address');
  }

  if (
    (result.role.value && isOcrRoleGarbage(result.role.value)) ||
    roleSourceNeedsReview(r)
  ) {
    review.push('role');
    result.role = {
      ...result.role,
      confidence: 'low',
      score: Math.min(result.role.score, 0.1),
      reasons: [...result.role.reasons, 'ruolo OCR non affidabile'],
    };
  }

  // Un testo chiaramente professionale non può essere presentato come
  // azienda ad alta confidence senza una forma societaria osservata.
  // Una ragione sociale osservata con separatore ':'/'=' immediatamente
  // prima della forma legale resta ambigua senza corroborazione business
  // indipendente. Questa safety agisce sull'output esposto: evita che passaggi
  // successivi rialzino LOW a MEDIUM soltanto per score/layout.
  const companyHasAmbiguousLegalSeparator = Boolean(
    result.company.value &&
      hasAmbiguousTerminalLegalSeparator(String(result.company.value))
  );
  const companyHasIndependentCorroboration = (r.company.reasons ?? []).some(
    (reason) =>
      /identit[aà] completa corroborata da evidenza business|azienda derivata da email e sito osservati concordi/i.test(
        reason
      )
  );
  if (companyHasAmbiguousLegalSeparator && !companyHasIndependentCorroboration) {
    review.push('company');
    result.company = {
      ...result.company,
      confidence: 'low',
      score: Math.min(result.company.score, 0.43),
      reasons: [
        ...result.company.reasons,
        'separatore societario ambiguo senza corroborazione business indipendente',
      ],
    };
  }

  if (
    result.company.value &&
    hasConfusableDigitInsideBrandToken(result.company.value)
  ) {
    review.push('company');
    const alreadyLowConfidence = result.company.confidence === 'low';
    result.company = {
      ...result.company,
      // I safety guard devono essere monotoni: un controllo successivo può
      // abbassare la confidence, mai rialzarla. In particolare una company già
      // LOW per separatore ambiguo non può tornare MEDIUM solo perché contiene
      // una cifra OCR confondibile.
      confidence: alreadyLowConfidence ? 'low' : 'medium',
      score: Math.min(result.company.score, alreadyLowConfidence ? 0.43 : 0.69),
      reasons: [
        ...result.company.reasons,
        'brand con cifra OCR confondibile: verifica richiesta',
      ],
    };
  }

  if (
    result.company.value &&
    ROLE_KEYWORD_REGEX.test(result.company.value) &&
    !hasLegalForm(result.company.value)
  ) {
    review.push('company');
    result.company = {
      ...result.company,
      confidence: 'low',
      score: Math.min(result.company.score, 0.3),
      reasons: [
        ...result.company.reasons,
        'testo professionale incompatibile con company',
      ],
    };
  }

  // Se lo stesso testo compete contemporaneamente come company e ruolo,
  // la contraddizione deve essere visibile e nessuno dei due campi può
  // conservare una confidence HIGH.
  if (
    result.company.value &&
    result.role.value &&
    result.company.value.trim().toLowerCase() ===
      result.role.value.trim().toLowerCase()
  ) {
    review.push('company', 'role');
    result.company = {
      ...result.company,
      confidence: 'low',
      score: Math.min(result.company.score, 0.25),
      reasons: [...result.company.reasons, 'company e ruolo in conflitto'],
    };
    result.role = {
      ...result.role,
      confidence: 'medium',
      score: Math.min(result.role.score, 0.73),
      reasons: [...result.role.reasons, 'company e ruolo in conflitto'],
    };
  }

  const reviewFields = [...new Set(review)];
  const reviewableKeys = new Set([
    'firstName',
    'lastName',
    'company',
    'role',
    'emails',
    'phones',
    'website',
    'address',
    'vatNumber',
    'taxCode',
  ]);

  // Invariante UI/provenance: un campo esplicitamente marcato "da rivedere"
  // non può contemporaneamente mostrare badge HIGH. Non cambia il valore
  // scelto dal parser né il ranking interno: limita solo la confidence esposta
  // all'utente finché l'evidenza resta riparata, contraddittoria o incerta.
  for (const key of reviewFields) {
    if (!reviewableKeys.has(key)) continue;
    const field = result[key as keyof BusinessCardExtractionResult];
    if (
      field &&
      typeof field === 'object' &&
      'confidence' in field &&
      (field as ExtractedField<unknown>).confidence === 'high'
    ) {
      const current = field as ExtractedField<unknown>;
      (result as unknown as Record<string, unknown>)[key] = {
        ...current,
        confidence: 'medium',
        score: Math.min(current.score, 0.73),
        reasons: [
          ...current.reasons,
          'campo in review: confidence massima medium',
        ],
      };
    }
  }

  result.reviewFields = reviewFields;
  result.needsReview =
    result.needsReview || r.pageCoherence.requiresReview || reviewFields.length > 0;
  return result;
}

export function extractBusinessCardV5(pages: CardPageV5[]): BusinessCardExtractionResult {
  const r = applyObservedStructuralRecovery(
    completeTerminalSurnameFromSameLineEvidence(extractCardV5(pages), pages),
    pages,
  );
  const address = toAddress(r);
  const addressAlternatives = toAddressAlternatives(r);

  const result: BusinessCardExtractionResult = {
    firstName: toField(r.firstName),
    lastName: toField(r.lastName),
    company: toField(r.company),
    role: toField(r.role),
    emails: toField(
      { ...r.emails, value: r.emails.value ?? [] },
      emailSource(r)
    ),
    phones: toField<Phone[]>({ ...r.phones, value: r.phones.value ?? [] }, 'ocr'),
    website: toField(r.website, r.website.reasons.some((x) => x.includes('email')) ? 'email' : 'ocr'),
    address: {
      value: address ?? null,
      confidence: toConfidence(r.address.score),
      score: Number(r.address.score.toFixed(3)),
      source: 'layout',
      reasons: r.address.reasons,
    },
    addressAlternatives,
    vatNumber: toField(r.vatNumber, 'ocr'),
    taxCode: toField(r.taxCode, 'ocr'),
    rawText: r.rawText,
    needsReview: false,
    reviewFields: [],
    emailEvidence: r.emailEvidence,
    pageCoherence: r.pageCoherence,
  };

  return applyConfidenceReviewSafety(result, r, pages);
}

// ---------------------------------------------------------------------------

export function parseCardFromPagesV5(
  pages: CardPageV5[]
): Omit<BusinessCard, 'type' | 'title' | 'images'> {
  const r = applyObservedStructuralRecovery(
    completeTerminalSurnameFromSameLineEvidence(extractCardV5(pages), pages),
    pages,
  );
  const review = extractionReviewFrom(r, pages);
  const address = toAddress(r);

  return {
    id: createId(),
    createdAt: new Date(),
    updatedAt: new Date(),
    rawText: r.rawText,
    firstName: r.firstName.value ?? '',
    lastName: r.lastName.value ?? '',
    role: r.role.value ?? '',
    company: r.company.value ?? '',
    emails: r.emails.value ?? [],
    emailEvidence: r.emailEvidence,
    phones: r.phones.value ?? [],
    website: r.website.value ?? undefined,
    address,
    vatNumber: r.vatNumber.value ?? undefined,
    taxCode: r.taxCode.value ?? undefined,
    confidence: {
      firstName: numWithReview(r.firstName.score, review.firstName),
      lastName: numWithReview(r.lastName.score, review.lastName),
      company: numWithReview(r.company.score, review.company),
      role: numWithReview(r.role.score, review.role),
      emails: numWithReview(r.emails.score, review.emails),
      phones: numWithReview(r.phones.score, review.phones),
      website: numWithReview(r.website.score, review.website),
      address: numWithReview(r.address.score, review.address),
      vatNumber: numWithReview(r.vatNumber.score, review.vatNumber),
      taxCode: numWithReview(r.taxCode.score, review.taxCode),
    },
    extractionReview: review,
  };
}

function num(v: number): number {
  return Number(Math.max(0.05, Math.min(0.99, v)).toFixed(2));
}

function numWithReview(
  value: number,
  field: ExtractedField<unknown>
): number {
  const normalized = num(value);
  if (field.confidence === 'low') return Math.min(normalized, 0.43);
  if (field.confidence === 'medium') return Math.min(normalized, 0.73);
  return normalized;
}

function extractionReviewFrom(
  r: V5Result,
  pages: CardPageV5[]
): BusinessCardExtractionResult {
  // riusa la mappatura senza rieseguire il motore
  const address = toAddress(r);
  const addressAlternatives = toAddressAlternatives(r);
  const res: BusinessCardExtractionResult = {
    firstName: toField(r.firstName),
    lastName: toField(r.lastName),
    company: toField(r.company),
    role: toField(r.role),
    emails: toField(
      { ...r.emails, value: r.emails.value ?? [] },
      emailSource(r)
    ),
    phones: toField<Phone[]>({ ...r.phones, value: r.phones.value ?? [] }, 'ocr'),
    website: toField(r.website, 'ocr'),
    address: {
      value: address ?? null,
      confidence: toConfidence(r.address.score),
      score: Number(r.address.score.toFixed(3)),
      source: 'layout',
      reasons: r.address.reasons,
    },
    addressAlternatives,
    vatNumber: toField(r.vatNumber, 'ocr'),
    taxCode: toField(r.taxCode, 'ocr'),
    rawText: r.rawText,
    needsReview: false,
    reviewFields: [],
    emailEvidence: r.emailEvidence,
    pageCoherence: r.pageCoherence,
  };
  return applyConfidenceReviewSafety(res, r, pages);
}

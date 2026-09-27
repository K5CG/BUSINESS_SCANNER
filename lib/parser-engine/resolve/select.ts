import type { Address, Phone } from '../../../types';
import type { CardDraft, FieldKind, ScoredCandidate } from '../types';
import type { PersonNameValue } from '../extractors/person-name';
import type { TaxIdValue } from '../extractors/vat-taxcode';
import type { ExtendedCardDraft } from '../merge/pages';
import {
  isDisqualifiedCompanyText,
  isDisqualifiedCompanyValue,
  looksLikeAddressOrLocationLine,
  looksLikeCatalogLine,
} from '../scoring/features';
import { sortScoredCandidates, type ScoredCandidateDetail } from '../scoring/score';
import {
  effectiveCompanySelectionScore,
  LAYOUT_COMPANY_NEAR_GAP,
} from '../scoring/weights';
import { validateEmail } from '../validators/email';
import { validatePersonName } from '../validators/name';
import { validatePhone } from '../validators/phone';
import { validateTaxCode, validateVatNumber } from '../validators/vat';

export const DEFAULT_MIN_SCORE = 0.32;
export const MAX_EMAILS = 4;
export const MAX_PHONES = 6;

export interface FieldDecision<T> {
  value?: T;
  score: number;
  confidence: number;
  reasons: string[];
  sourceLineIndices: number[];
  rejectedCount: number;
}

export interface DraftSelection {
  firstName?: FieldDecision<string>;
  lastName?: FieldDecision<string>;
  role?: FieldDecision<string>;
  company?: FieldDecision<string>;
  emails: FieldDecision<string>[];
  phones: FieldDecision<Phone>[];
  website?: FieldDecision<string>;
  address?: FieldDecision<Address>;
  vatNumber?: FieldDecision<string>;
  taxCode?: FieldDecision<string>;
}

export interface SelectResult {
  selection: DraftSelection;
  reasons: string[];
}

type AnyScored = ScoredCandidate<unknown> | ScoredCandidateDetail<unknown>;

function candidateConfidence(candidate: AnyScored): number {
  if ('confidence' in candidate && typeof candidate.confidence === 'number') {
    return candidate.confidence;
  }
  return candidate.score;
}

function candidateReasons(candidate: AnyScored, fieldKind: FieldKind): string[] {
  if ('reasons' in candidate && Array.isArray(candidate.reasons)) {
    return [...candidate.reasons];
  }
  return [`selezionato per ${fieldKind} (score ${candidate.score.toFixed(2)})`];
}

function isLayoutCompanyCandidate(candidate: AnyScored): boolean {
  return candidate.extractor === 'company:layout';
}

/** Rumore OCR generico (sigla provincia, frammento troppo corto) — non marchio. */
function isFormattingNoiseCompany(value: string): boolean {
  const t = value.trim();
  if (!t || t.length > 8) return false;
  if (/^\(?[A-Za-z]{1,2}\)?\.?$/.test(t)) return true;
  if (/^\d{1,6}[^\w\sÀ-ü]{0,2}$/.test(t)) return true;
  if (t.length <= 4 && !/[a-zà-ü]{2,}/i.test(t) && !/\d/.test(t)) return true;
  return false;
}

function isUnusableLayoutCompany(candidate: AnyScored, value: string): boolean {
  if (isDisqualifiedCompanyValue(value)) return true;
  if (isDisqualifiedCompanyText(value)) return true;
  if (looksLikeCatalogLine(value)) return true;
  if (looksLikeAddressOrLocationLine(value)) return true;
  if (isFormattingNoiseCompany(value)) return true;
  const features = candidate.features;
  if (features.hasCatalogKeyword || features.hasAddressPattern) return true;
  if (features.hasEmailPattern || features.hasPhonePattern) return true;
  if (/@/.test(value) || /\b(?:tel|fax|phone|e-?mail|pec)\b/i.test(value)) return true;
  return false;
}

interface CompanyCandidateEntry {
  candidate: AnyScored;
  value: string;
  raw: number;
  effective: number;
}

/**
 * Selezione company con preferenza layout controllata (non layout-first assoluto).
 * Un candidato layout può vincere solo se competitivo col migliore non-layout.
 */
function selectTopCompany(
  candidates: AnyScored[] | undefined,
  minScore: number
): FieldDecision<string> | undefined {
  const ordered = sortedCandidates(candidates);
  let rejected = 0;
  const valid: CompanyCandidateEntry[] = [];

  for (const candidate of ordered) {
    const value = typeof candidate.value === 'string' ? candidate.value.trim() : '';
    if (!value) {
      rejected++;
      continue;
    }
    if (isLayoutCompanyCandidate(candidate) && isUnusableLayoutCompany(candidate, value)) {
      rejected++;
      continue;
    }
    valid.push({
      candidate,
      value,
      raw: candidate.score,
      effective: effectiveCompanySelectionScore(candidate.score, candidate.extractor),
    });
  }

  const aboveMin = valid.filter((entry) => entry.raw >= minScore);
  const pick = (entry: CompanyCandidateEntry, extraReasons: string[] = []): FieldDecision<string> => ({
    value: entry.value,
    score: entry.raw,
    confidence: candidateConfidence(entry.candidate),
    reasons: [
      ...candidateReasons(entry.candidate, 'company'),
      ...extraReasons,
    ],
    sourceLineIndices: [...entry.candidate.sourceLineIndices],
    rejectedCount: rejected,
  });

  if (aboveMin.length === 0) {
    if (ordered.length > 0) {
      return {
        score: ordered[0].score,
        confidence: candidateConfidence(ordered[0]),
        reasons: [`nessun candidato company sopra soglia ${minScore.toFixed(2)}`],
        sourceLineIndices: [],
        rejectedCount: ordered.length,
      };
    }
    return undefined;
  }

  let winner = [...aboveMin].sort((a, b) => b.raw - a.raw)[0];
  const nonLayout = aboveMin.filter((entry) => !isLayoutCompanyCandidate(entry.candidate));
  const layouts = aboveMin.filter((entry) => isLayoutCompanyCandidate(entry.candidate));

  if (layouts.length > 0 && nonLayout.length > 0) {
    const referenceNonLayout = [...nonLayout]
      .filter((entry) => !isFormattingNoiseCompany(entry.value))
      .sort((a, b) => b.raw - a.raw)[0];
    const bestLayout = [...layouts].sort((a, b) => b.effective - a.effective)[0];

    if (referenceNonLayout && bestLayout) {
      const nearReference = bestLayout.raw >= referenceNonLayout.raw - LAYOUT_COMPANY_NEAR_GAP;
      const layoutCompetitive =
        bestLayout.effective >= referenceNonLayout.raw - LAYOUT_COMPANY_NEAR_GAP;
      const beatsReference = bestLayout.effective >= referenceNonLayout.effective;

      if (nearReference && layoutCompetitive && beatsReference) {
        const noiseWinner = isFormattingNoiseCompany(winner.value);
        const layoutBeatsWinner =
          bestLayout.effective > winner.raw ||
          (noiseWinner && bestLayout.raw >= winner.raw - LAYOUT_COMPANY_NEAR_GAP);

        if (layoutBeatsWinner) {
          winner = bestLayout;
        }
      }
    }
  }

  const layoutReason =
    isLayoutCompanyCandidate(winner.candidate)
      ? [`preferenza layout controllata (effective ${winner.effective.toFixed(2)})`]
      : [];

  return pick(winner, layoutReason);
}

function sortedCandidates(candidates: AnyScored[] | undefined): AnyScored[] {
  if (!candidates?.length) return [];
  const detailed = candidates.map((c) => ({
    ...c,
    confidence: candidateConfidence(c),
    reasons: 'reasons' in c && Array.isArray(c.reasons) ? c.reasons : [],
  })) as ScoredCandidateDetail<unknown>[];
  return sortScoredCandidates(detailed);
}

function selectTopOne<T>(
  candidates: AnyScored[] | undefined,
  fieldKind: FieldKind,
  minScore: number,
  validate: (value: unknown) => T | null
): FieldDecision<T> | undefined {
  const ordered = sortedCandidates(candidates);
  let rejected = 0;

  for (const candidate of ordered) {
    const valid = validate(candidate.value);
    if (!valid) {
      rejected++;
      continue;
    }
    if (candidate.score < minScore) {
      rejected++;
      continue;
    }
    return {
      value: valid,
      score: candidate.score,
      confidence: candidateConfidence(candidate),
      reasons: candidateReasons(candidate, fieldKind),
      sourceLineIndices: [...candidate.sourceLineIndices],
      rejectedCount: rejected,
    };
  }

  if (ordered.length > 0) {
    return {
      score: ordered[0].score,
      confidence: candidateConfidence(ordered[0]),
      reasons: [`nessun candidato ${fieldKind} sopra soglia ${minScore.toFixed(2)}`],
      sourceLineIndices: [],
      rejectedCount: ordered.length,
    };
  }

  return undefined;
}

function selectTopMany<T>(
  candidates: AnyScored[] | undefined,
  fieldKind: FieldKind,
  minScore: number,
  limit: number,
  validate: (value: unknown) => T | null,
  keyFn: (value: T) => string
): { selected: FieldDecision<T>[]; reasons: string[] } {
  const ordered = sortedCandidates(candidates);
  const selected: FieldDecision<T>[] = [];
  const seen = new Set<string>();
  const reasons: string[] = [];
  let rejected = 0;

  for (const candidate of ordered) {
    const valid = validate(candidate.value);
    if (!valid || candidate.score < minScore) {
      rejected++;
      continue;
    }
    const key = keyFn(valid);
    if (seen.has(key)) {
      rejected++;
      continue;
    }
    seen.add(key);
    selected.push({
      value: valid,
      score: candidate.score,
      confidence: candidateConfidence(candidate),
      reasons: candidateReasons(candidate, fieldKind),
      sourceLineIndices: [...candidate.sourceLineIndices],
      rejectedCount: rejected,
    });
    if (selected.length >= limit) break;
  }

  if (selected.length === 0 && ordered.length > 0) {
    reasons.push(`nessun candidato ${fieldKind} valido sopra soglia ${minScore.toFixed(2)}`);
  }

  return { selected, reasons };
}

function pickTaxId(
  value: unknown,
  kind: 'vatNumber' | 'taxCode'
): string | null {
  if (typeof value === 'string') {
    return kind === 'vatNumber' ? validateVatNumber(value) : validateTaxCode(value);
  }
  if (value && typeof value === 'object') {
    const tax = value as TaxIdValue;
    const raw = kind === 'vatNumber' ? tax.vatNumber : tax.taxCode;
    if (!raw) return null;
    return kind === 'vatNumber' ? validateVatNumber(raw) : validateTaxCode(raw);
  }
  return null;
}

function fieldDecisionFromPersonName(
  candidate: AnyScored,
  fieldKind: 'firstName' | 'lastName',
  value: string,
  rejected: number
): FieldDecision<string> {
  return {
    value,
    score: candidate.score,
    confidence: candidateConfidence(candidate),
    reasons: candidateReasons(candidate, fieldKind),
    sourceLineIndices: [...candidate.sourceLineIndices],
    rejectedCount: rejected,
  };
}

/**
 * Seleziona nome+cognome come unità atomica da candidati person-name.
 * Fallback su pool firstName/lastName separati (es. draft di emergenza).
 */
function selectPersonNameFields(
  draft: ExtendedCardDraft,
  minScore: number
): { firstName?: FieldDecision<string>; lastName?: FieldDecision<string> } {
  const ordered = sortedCandidates(draft.personName as AnyScored[] | undefined);
  let rejected = 0;

  for (const candidate of ordered) {
    const valid = validatePersonName(candidate.value as PersonNameValue);
    if (!valid) {
      rejected++;
      continue;
    }
    if (candidate.score < minScore) {
      rejected++;
      continue;
    }

    const firstName = valid.firstName
      ? fieldDecisionFromPersonName(candidate, 'firstName', valid.firstName, rejected)
      : undefined;
    const lastName = valid.lastName
      ? fieldDecisionFromPersonName(candidate, 'lastName', valid.lastName, rejected)
      : undefined;

    if (firstName || lastName) {
      return { firstName, lastName };
    }
    rejected++;
  }

  return {
    firstName: selectTopOne(draft.firstName, 'firstName', minScore, (v) =>
      typeof v === 'string' && v.trim() ? v.trim() : null
    ),
    lastName: selectTopOne(draft.lastName, 'lastName', minScore, (v) =>
      typeof v === 'string' && v.trim() ? v.trim() : null
    ),
  };
}

/**
 * Seleziona i migliori candidati per ogni campo dal draft scored.
 */
export function selectFromDraft(
  draft: CardDraft,
  minScore: number = DEFAULT_MIN_SCORE
): SelectResult {
  const reasons: string[] = [];

  const { firstName, lastName } = selectPersonNameFields(draft as ExtendedCardDraft, minScore);
  const role = selectTopOne(draft.role, 'role', minScore, (v) =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  );
  const company = selectTopCompany(draft.company as AnyScored[] | undefined, minScore);
  const website = selectTopOne(draft.website, 'website', minScore, (v) =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  );
  const address = selectTopOne(draft.address, 'address', minScore, (v) => {
    if (!v || typeof v !== 'object') return null;
    return v as Address;
  });
  const vatNumber = selectTopOne(draft.vatNumber, 'vatNumber', minScore, (v) => pickTaxId(v, 'vatNumber'));
  const taxCode = selectTopOne(draft.taxCode, 'taxCode', minScore, (v) => pickTaxId(v, 'taxCode'));

  const emailResult = selectTopMany(
    draft.email,
    'email',
    minScore,
    MAX_EMAILS,
    (v) => (typeof v === 'string' ? validateEmail(v) : null),
    (v) => v
  );
  const phoneResult = selectTopMany(
    draft.phone,
    'phone',
    minScore,
    MAX_PHONES,
    (v) => validatePhone(v as Phone),
    (v) => v.number.replace(/\D/g, '')
  );

  reasons.push(...emailResult.reasons, ...phoneResult.reasons);

  if (firstName?.value) reasons.push(`firstName: "${firstName.value}" (score ${firstName.score.toFixed(2)})`);
  if (company?.value) reasons.push(`company: "${company.value}" (score ${company.score.toFixed(2)})`);

  return {
    selection: {
      firstName,
      lastName,
      role,
      company,
      emails: emailResult.selected,
      phones: phoneResult.selected,
      website,
      address,
      vatNumber,
      taxCode,
    },
    reasons,
  };
}

/** Estrae gli indici riga usati da una decisione di campo. */
export function collectUsedLineIndices(selection: DraftSelection): Map<number, FieldKind[]> {
  const map = new Map<number, FieldKind[]>();

  const add = (field: FieldKind, indices: number[]) => {
    for (const index of indices) {
      const list = map.get(index) ?? [];
      list.push(field);
      map.set(index, list);
    }
  };

  if (selection.firstName?.sourceLineIndices) add('firstName', selection.firstName.sourceLineIndices);
  if (selection.lastName?.sourceLineIndices) add('lastName', selection.lastName.sourceLineIndices);
  if (selection.role?.sourceLineIndices) add('role', selection.role.sourceLineIndices);
  if (selection.company?.sourceLineIndices) add('company', selection.company.sourceLineIndices);
  if (selection.website?.sourceLineIndices) add('website', selection.website.sourceLineIndices);
  if (selection.address?.sourceLineIndices) add('address', selection.address.sourceLineIndices);
  if (selection.vatNumber?.sourceLineIndices) add('vatNumber', selection.vatNumber.sourceLineIndices);
  if (selection.taxCode?.sourceLineIndices) add('taxCode', selection.taxCode.sourceLineIndices);
  for (const email of selection.emails) add('email', email.sourceLineIndices);
  for (const phone of selection.phones) add('phone', phone.sourceLineIndices);

  return map;
}

/** Score di un campo nella selezione (0 se assente). */
export function fieldScore(selection: DraftSelection, field: FieldKind): number {
  switch (field) {
    case 'email':
      return selection.emails[0]?.score ?? 0;
    case 'phone':
      return selection.phones[0]?.score ?? 0;
    default:
      return (selection[field] as FieldDecision<unknown> | undefined)?.score ?? 0;
  }
}

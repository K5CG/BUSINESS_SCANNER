import type { CardDraft, FieldKind, ScoredCandidate } from '../types';
import type { Phone } from '../../../types';
import type { Address } from '../../../types';
import type { TaxIdValue } from '../extractors/vat-taxcode';
import type { PersonNameValue } from '../extractors/person-name';
import { addressCompletenessScore, rankAddressCandidate } from '../validators/address';
import {
  isRoleOnlyCompanyValue,
  repetitionBonusForCompany,
} from '../scoring/features';
import {
  hasLegalFormSuffix,
  isIsolatedLegalFormOnly,
  isLikelyIndustryAcronymLine,
  isStandaloneFirmSuffixWord,
  isSuffixOnlyCompany,
  stripLegalFormSuffix,
} from '../validators/dictionaries';

export const PERSON_NAME_EXTRACTOR = 'person-name';

/** Draft esteso: candidati nome persona atomici prima dello split in assemble. */
export type ExtendedCardDraft = CardDraft & {
  personName?: ScoredCandidate<PersonNameValue>[];
};

const MULTI_FIELDS: FieldKind[] = ['email', 'phone'];
const SINGLE_FIELDS: FieldKind[] = [
  'role',
  'company',
  'website',
  'address',
  'vatNumber',
  'taxCode',
];

function personNameKey(value: PersonNameValue): string {
  return `${value.firstName}|${value.lastName}`.toLowerCase();
}

/** True se firstName e lastName sono l'unico conflitto sulla stessa riga OCR. */
export function isPersonNameOnlyLineConflict(fields: FieldKind[]): boolean {
  const unique = [...new Set(fields)];
  return unique.length === 2 && unique.includes('firstName') && unique.includes('lastName');
}

function normalizeKey(field: FieldKind, value: unknown): string {
  if (value == null) return '';
  if (field === 'phone') {
    const phone = value as Phone;
    return phone.number.replace(/\D/g, '');
  }
  if (field === 'address') {
    const addr = value as Address;
    const street = (addr.street ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (street) return street;
    return (addr.full ?? '').toLowerCase().trim();
  }
  if (typeof value === 'object') {
    const tax = value as TaxIdValue;
    if (field === 'vatNumber') return tax.vatNumber ?? '';
    if (field === 'taxCode') return tax.taxCode ?? '';
    return JSON.stringify(value);
  }
  return String(value).toLowerCase().trim();
}

function mergeCandidate(
  existing: ScoredCandidate<unknown>,
  incoming: ScoredCandidate<unknown>
): ScoredCandidate<unknown> {
  const agreement = Math.min(1, (existing.features.crossPageAgreement ?? 0) + 0.35);
  return {
    ...existing,
    score: Math.min(1, Math.max(existing.score, incoming.score) + 0.05),
    sourceLineIndices: [...new Set([...existing.sourceLineIndices, ...incoming.sourceLineIndices])],
    features: {
      ...existing.features,
      ...incoming.features,
      crossPageAgreement: agreement,
    },
  };
}

function dedupeCandidates(
  candidates: ScoredCandidate<unknown>[],
  field: FieldKind
): ScoredCandidate<unknown>[] {
  const byKey = new Map<string, ScoredCandidate<unknown>>();

  for (const candidate of candidates) {
    const key = normalizeKey(field, candidate.value);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...candidate,
        features: { ...candidate.features, crossPageAgreement: candidate.features.crossPageAgreement ?? 0 },
      });
      continue;
    }
    byKey.set(key, mergeCandidate(existing, candidate));
  }

  return [...byKey.values()];
}

/**
 * Fonde i draft di più pagine (fronte/retro) accumulando candidati
 * e premiando accordo cross-page sullo stesso valore.
 */
export function mergePageDrafts(drafts: CardDraft[]): CardDraft {
  if (drafts.length === 0) return {};
  if (drafts.length === 1) return drafts[0];

  const merged: CardDraft = {};

  for (const field of MULTI_FIELDS) {
    const all = drafts.flatMap((draft) => draft[field] ?? []);
    merged[field] = dedupeCandidates(all, field);
  }

  for (const field of SINGLE_FIELDS) {
    if (field === 'company') {
      const all = drafts.flatMap((draft) => draft.company ?? []);
      merged.company = dedupeCompanyCandidates(all as ScoredCandidate<string>[]);
      continue;
    }
    if (field === 'address') {
      const all = drafts.flatMap((draft) => draft.address ?? []);
      merged.address = dedupeAddressCandidates(all as ScoredCandidate<Address>[]);
      continue;
    }
    const all = drafts.flatMap((draft) => draft[field] ?? []);
    merged[field] = dedupeCandidates(all, field);
  }

  const personNames = drafts.flatMap((draft) => (draft as ExtendedCardDraft).personName ?? []);
  if (personNames.length > 0) {
    (merged as ExtendedCardDraft).personName = dedupePersonNameCandidates(personNames);
  }

  return merged;
}

function dedupePersonNameCandidates(
  candidates: ScoredCandidate<PersonNameValue>[]
): ScoredCandidate<PersonNameValue>[] {
  const byKey = new Map<string, ScoredCandidate<PersonNameValue>>();

  for (const candidate of candidates) {
    const key = personNameKey(candidate.value);
    if (!key.replace(/\|/g, '').trim()) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...candidate,
        features: { ...candidate.features, crossPageAgreement: candidate.features.crossPageAgreement ?? 0 },
      });
      continue;
    }
    byKey.set(key, mergeCandidate(existing, candidate) as ScoredCandidate<PersonNameValue>);
  }

  return [...byKey.values()];
}

/** Unisce testo riparato di più pagine con separatore standard. */
export function mergePageTexts(texts: string[]): string {
  return texts.map((t) => t.trim()).filter(Boolean).join('\n\n---\n\n');
}

/** Espande un nome persona selezionato nei due campi stringa. */
export function personNameToFieldValues(
  name: PersonNameValue
): { firstName: string; lastName: string } {
  return {
    firstName: name.firstName?.trim() ?? '',
    lastName: name.lastName?.trim() ?? '',
  };
}

/** Espande candidati fiscali in vatNumber e taxCode. */
export function splitTaxIdCandidates(
  candidates: ScoredCandidate<TaxIdValue>[]
): { vatNumber: ScoredCandidate<string>[]; taxCode: ScoredCandidate<string>[] } {
  const vatNumber: ScoredCandidate<string>[] = [];
  const taxCode: ScoredCandidate<string>[] = [];

  for (const candidate of candidates) {
    if (candidate.value.vatNumber) {
      vatNumber.push({ ...candidate, value: candidate.value.vatNumber, extractor: `${candidate.extractor}:vat` });
    }
    if (candidate.value.taxCode) {
      taxCode.push({ ...candidate, value: candidate.value.taxCode, extractor: `${candidate.extractor}:tax` });
    }
  }

  return { vatNumber, taxCode };
}

/** Ranking composito per candidati azienda (score, non lunghezza). */
export function rankCompanyCandidate(candidate: ScoredCandidate<string>): number {
  const features = candidate.features;
  const value = String(candidate.value ?? '');
  let rank = candidate.score;

  if (features.hasLegalForm) rank += 0.12;
  if (hasLegalFormSuffix(value)) rank += 0.18;
  if (features.isTitleCase) rank += 0.05;
  if (features.emailDomainMatch) rank += 0.1 * features.emailDomainMatch;
  if (features.websiteDomainMatch) rank += 0.08 * features.websiteDomainMatch;
  if (features.positionRank) rank += 0.04 * features.positionRank;
  if (features.crossPageAgreement) rank += 0.12 * features.crossPageAgreement;

  const brandLen = stripLegalFormSuffix(value).trim().length;
  if (brandLen >= 12) rank += 0.08;
  if (brandLen >= 20) rank += 0.06;

  const wordCount = value.split(/\s+/).filter(Boolean).length;
  const brandCore = stripLegalFormSuffix(value).trim();
  const normalizedCore = brandCore.toLowerCase().replace(/[^a-zà-ü]/g, '');
  if (wordCount > 5 && !hasLegalFormSuffix(value)) rank -= 0.35;
  if (wordCount === 1 && features.isAllCaps && brandLen >= 4 && brandLen <= 14) rank += 0.1;
  if (
    wordCount === 1 &&
    (features.emailDomainMatch ?? 0) >= 0.8 &&
    !features.isAllCaps &&
    normalizedCore.length >= 9
  ) {
    rank -= 0.25;
  }
  if (wordCount >= 2 && (features.emailDomainMatch ?? 0) >= 0.8) rank += 0.08;
  if (/&\s*[A-Za-zÀ-ü]{1,2}(?:\s|$)/.test(value)) rank -= 0.45;
  if (value.length > 55) rank -= 0.2;

  if (isIsolatedLegalFormOnly(value)) rank -= 2;
  if (isRoleOnlyCompanyValue(value)) rank -= 2;
  if (isStandaloneFirmSuffixWord(value)) rank -= 2;
  if (isSuffixOnlyCompany(value)) rank -= 2;
  if (isLikelyIndustryAcronymLine(value)) rank -= 1.5;
  if (features.hasAddressPattern) rank -= 0.25;
  if (features.hasCatalogKeyword) rank -= 0.25;
  if (features.postalCodeValid) rank -= 0.2;
  if (features.provinceValid) rank -= 0.18;
  if (features.hasPhonePattern) rank -= 0.2;
  if (features.hasRoleKeyword) rank -= 0.4;
  if (features.hasVatPattern) rank -= 0.15;

  return rank;
}

function dedupeCompanyCandidates(
  candidates: ScoredCandidate<string>[]
): ScoredCandidate<string>[] {
  const byKey = new Map<string, ScoredCandidate<string>>();

  for (const candidate of candidates) {
    const key = stripLegalFormSuffix(String(candidate.value ?? ''))
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...candidate,
        features: { ...candidate.features, crossPageAgreement: candidate.features.crossPageAgreement ?? 0 },
      });
      continue;
    }

    const winner =
      rankCompanyCandidate(candidate) >= rankCompanyCandidate(existing) ? candidate : existing;
    const loser = winner === candidate ? existing : candidate;
    const agreement = Math.min(1, (winner.features.crossPageAgreement ?? 0) + 0.35);

    const winnerValue = String(winner.value ?? '');
    const loserValue = String(loser.value ?? '');
    const preferLonger =
      rankCompanyCandidate(candidate) >= rankCompanyCandidate(existing) - 0.05 &&
      loserValue.length > winnerValue.length &&
      hasLegalFormSuffix(loserValue) &&
      !isIsolatedLegalFormOnly(loserValue);
    const preferBrandPlusSuffix =
      rankCompanyCandidate(candidate) >= rankCompanyCandidate(existing) - 0.08 &&
      isSuffixOnlyCompany(winnerValue) &&
      !isSuffixOnlyCompany(loserValue);
    const finalWinner = preferBrandPlusSuffix ? loser : (preferLonger ? loser : winner);
    const finalLoser = finalWinner === winner ? loser : winner;

    byKey.set(key, {
      ...finalWinner,
      sourceLineIndices: [...new Set([...finalWinner.sourceLineIndices, ...finalLoser.sourceLineIndices])],
      features: {
        ...finalWinner.features,
        crossPageAgreement: agreement,
      },
    });
  }

  return [...byKey.values()];
}

function dedupeAddressCandidates(
  candidates: ScoredCandidate<Address>[]
): ScoredCandidate<Address>[] {
  const byKey = new Map<string, ScoredCandidate<Address>>();

  for (const candidate of candidates) {
    const key = normalizeKey('address', candidate.value);
    if (!key) continue;

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...candidate,
        features: { ...candidate.features, crossPageAgreement: candidate.features.crossPageAgreement ?? 0 },
      });
      continue;
    }

    const winner =
      rankAddressCandidate(candidate.value, candidate.score) >=
      rankAddressCandidate(existing.value, existing.score)
        ? candidate
        : existing;
    const loser = winner === candidate ? existing : candidate;
    const agreement = Math.min(1, (winner.features.crossPageAgreement ?? 0) + 0.35);

    byKey.set(key, {
      ...winner,
      sourceLineIndices: [...new Set([...winner.sourceLineIndices, ...loser.sourceLineIndices])],
      features: {
        ...winner.features,
        crossPageAgreement: agreement,
        tokenCount: Math.max(
          winner.features.tokenCount ?? 0,
          addressCompletenessScore(winner.value)
        ),
      },
    });
  }

  return [...byKey.values()];
}

/** Preferisce il candidato azienda con ranking composito (non per lunghezza). */
export function pickPreferredCompanyValue(candidates: ScoredCandidate<string>[]): string {
  if (!candidates.length) return '';
  const ordered = [...candidates].sort(
    (a, b) => rankCompanyCandidate(b) - rankCompanyCandidate(a)
  );
  const bestRank = rankCompanyCandidate(ordered[0]);
  const close = ordered.filter((c) => bestRank - rankCompanyCandidate(c) <= 0.1);
  const withLegal = close.filter((c) => hasLegalFormSuffix(String(c.value ?? '')));
  let pool = withLegal.length ? withLegal : close;
  pool = pool.filter((c) => !isStandaloneFirmSuffixWord(String(c.value ?? '')));
  pool = pool.filter((c) => !isSuffixOnlyCompany(String(c.value ?? '')));
  pool = pool.filter((c) => !isRoleOnlyCompanyValue(String(c.value ?? '')));
  if (!pool.length) pool = close.filter((c) => !isRoleOnlyCompanyValue(String(c.value ?? '')));
  if (!pool.length) pool = close.filter((c) => !isSuffixOnlyCompany(String(c.value ?? '')));
  if (!pool.length) pool = close;
  if (pool.length <= 1) return pool[0]?.value ?? '';

  if (!withLegal.length) {
    pool.sort(
      (a, b) =>
        stripLegalFormSuffix(String(a.value ?? '')).length -
        stripLegalFormSuffix(String(b.value ?? '')).length
    );
  }
  return pool[0]?.value ?? '';
}

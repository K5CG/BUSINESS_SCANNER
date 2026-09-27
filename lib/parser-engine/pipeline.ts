import type { BusinessCard, OcrLine } from '../../types';
import { createId } from '../id';
import { extractAddressCandidates, enrichSelectedAddress } from './extractors/address';
import { extractCompanyCandidates } from './extractors/company';
import { detectLayoutFromPages, detectLayoutFromRawLines } from './layout/debug';
import { extractEmailCandidates } from './extractors/email';
import { extractPersonNameCandidates } from './extractors/person-name';
import { extractPhoneCandidates } from './extractors/phone';
import { extractRoleCandidates, rankRoleNearName } from './extractors/role';
import { extractTaxIdCandidates } from './extractors/vat-taxcode';
import { extractWebsiteCandidates } from './extractors/website';
import type { CardFields } from './merge/ai-merge';
import {
  mergePageDrafts,
  mergePageTexts,
  PERSON_NAME_EXTRACTOR,
  splitTaxIdCandidates,
  type ExtendedCardDraft,
} from './merge/pages';
import { buildNormalizedInput, clampOcrLines } from './normalize/lines';
import { repairOcrContactText } from './normalize/ocr-repair';
import { capitalizeWord } from './normalize/tokens';
import { applyConstraints } from './resolve/constraints';
import {
  reconcileCompanySelection,
  reconcileSelection,
} from './resolve/reconcile';
import { selectFromDraft, type DraftSelection } from './resolve/select';
import { scoreCandidates, toScoredCandidate } from './scoring/score';
import type { Candidate, CardDraft, FieldKind, NormalizedInput, ScoredCandidate } from './types';
import { validateAddress, validateFinalAddress } from './validators/address';
import { resolveExplicitWebsiteFromText } from './validators/website';
import {
  COMMON_FIRST_NAMES,
  LEGAL_FORM_REGEX,
  stripLegalFormSuffix,
} from './validators/dictionaries';
import { runtimeLogger } from '../safe-runtime-logger';

export interface CardPage {
  lines: OcrLine[];
  rawText: string;
}

function normalizeBrandKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[oO]/g, '0')
    .replace(/[^a-z0-9]/g, '');
}

function formatCompanyLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function stripPersonNamePrefixFromCompany(
  company: string,
  firstName: string,
  lastName: string
): string {
  if (!company || !firstName || !lastName) return company;
  const prefix = `${firstName} ${lastName}`.trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const trimmed = company.trim();
  if (norm(trimmed).startsWith(`${norm(prefix)} `)) {
    return trimmed.slice(prefix.length).trim();
  }
  return company;
}

function dedupeCompanyBrandTokens(company: string): string {
  const legal = company.match(LEGAL_FORM_REGEX)?.[0] ?? '';
  const brand = stripLegalFormSuffix(company).trim();
  const words = brand.split(/\s+/).filter(Boolean);
  if (words.length < 2) return company;

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const word of words) {
    const key = normalizeBrandKey(word);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(word);
  }

  const rebuilt = deduped.join(' ');
  return legal ? formatCompanyLine(`${rebuilt} ${legal}`) : formatCompanyLine(rebuilt);
}

function scoreField<T>(candidates: Candidate<T>[], field: FieldKind): ScoredCandidate<unknown>[] {
  return scoreCandidates(candidates, field).map(toScoredCandidate);
}

function remapCandidateIndices(
  candidate: ScoredCandidate<unknown>,
  offset: number
): ScoredCandidate<unknown> {
  if (offset <= 0) return candidate;
  return {
    ...candidate,
    sourceLineIndices: candidate.sourceLineIndices.map((index) => index + offset),
  };
}

function remapDraftLineIndices(draft: ExtendedCardDraft, offset: number): ExtendedCardDraft {
  if (offset <= 0) return draft;

  const remapList = (list: ScoredCandidate<unknown>[] | undefined) =>
    list?.map((candidate) => remapCandidateIndices(candidate, offset));

  return {
    ...draft,
    email: remapList(draft.email),
    phone: remapList(draft.phone),
    website: remapList(draft.website),
    company: remapList(draft.company),
    role: remapList(draft.role),
    address: remapList(draft.address),
    vatNumber: remapList(draft.vatNumber),
    taxCode: remapList(draft.taxCode),
    personName: draft.personName?.map((candidate) =>
      remapCandidateIndices(candidate, offset)
    ) as ExtendedCardDraft['personName'],
  };
}

function buildMergedNormalizedInput(pages: CardPage[]): NormalizedInput {
  let offset = 0;
  const lines = pages.flatMap((page) => {
    const input = buildNormalizedInput(page.lines, page.rawText);
    const remapped = input.lines.map((line) => ({
      ...line,
      lineIndex: line.lineIndex + offset,
    }));
    offset += input.lines.length;
    return remapped;
  });
  const rawText = mergePageTexts(pages.map((p) => p.rawText.trim()));
  return {
    lines,
    rawText,
    repairedText: repairOcrContactText(rawText),
  };
}

function pickRoleNearName(
  selection: DraftSelection,
  mergedDraft: ExtendedCardDraft
): string {
  const current = selection.role?.value?.trim();
  if (current) return current;

  const nameLine =
    selection.firstName?.sourceLineIndices[0] ??
    selection.lastName?.sourceLineIndices[0] ??
    mergedDraft.personName?.[0]?.sourceLineIndices[0];

  const roles = (mergedDraft.role ?? []) as ScoredCandidate<string>[];
  if (!roles.length) return '';

  const ranked = [...roles].sort((a, b) => {
    const nearA = rankRoleNearName(a as Candidate<string>, nameLine);
    const nearB = rankRoleNearName(b as Candidate<string>, nameLine);
    return b.score + nearB - (a.score + nearA);
  });

  return String(ranked[0]?.value ?? '').trim();
}

function findExplicitWebsiteInText(rawText: string, emails: string[] = []): string | undefined {
  return resolveExplicitWebsiteFromText(rawText, emails);
}

function buildPageDraft(input: NormalizedInput): ExtendedCardDraft {
  const emailRaw = extractEmailCandidates(input);
  const emails = scoreField(emailRaw, 'email');
  const phones = scoreField(extractPhoneCandidates(input), 'phone');

  const emailValues = emailRaw.map((c) => c.value);
  const websiteRaw = extractWebsiteCandidates(input, emailValues);
  const websites = scoreField(websiteRaw, 'website');
  const layout = detectLayoutFromRawLines(input.lines);
  const companies = scoreField(
    extractCompanyCandidates(input, emailRaw, websiteRaw.map((c) => c.value), layout),
    'company'
  );

  const taxScored = scoreCandidates(extractTaxIdCandidates(input), 'vatNumber');
  const { vatNumber, taxCode } = splitTaxIdCandidates(taxScored);

  const addresses = scoreField(extractAddressCandidates(input), 'address');

  const personScored = scoreCandidates(extractPersonNameCandidates(input, emailRaw), 'firstName');
  const roles = scoreField(extractRoleCandidates(input), 'role');

  const draft: ExtendedCardDraft = {
    email: emails,
    phone: phones,
    website: websites,
    vatNumber,
    taxCode,
    address: addresses,
    personName: personScored.map((candidate) => ({
      ...candidate,
      extractor: PERSON_NAME_EXTRACTOR,
    })),
    role: roles,
    company: companies,
  };

  return draft;
}

function mergeSupplementalCandidates<T>(
  existing: ScoredCandidate<unknown>[] | undefined,
  supplemental: ScoredCandidate<unknown>[]
): ScoredCandidate<unknown>[] {
  const byValue = new Map<string, ScoredCandidate<unknown>>();
  for (const candidate of existing ?? []) {
    byValue.set(String(candidate.value).toLowerCase(), candidate);
  }
  for (const candidate of supplemental) {
    const key = String(candidate.value).toLowerCase();
    const prev = byValue.get(key);
    if (!prev || candidate.score > prev.score) {
      byValue.set(key, {
        ...candidate,
        score: Math.max(candidate.score, prev?.score ?? 0),
        features: {
          ...candidate.features,
          crossPageAgreement: Math.max(candidate.features.crossPageAgreement ?? 0, prev?.features.crossPageAgreement ?? 0, 0.5),
        },
      });
    }
  }
  return [...byValue.values()];
}

function mergeSupplementalPersonNames(
  existing: ExtendedCardDraft['personName'],
  supplemental: ExtendedCardDraft['personName']
): ExtendedCardDraft['personName'] {
  const byKey = new Map<string, NonNullable<ExtendedCardDraft['personName']>[number]>();
  const keyOf = (value: { firstName: string; lastName: string }) =>
    `${value.firstName}|${value.lastName}`.toLowerCase();

  for (const candidate of existing ?? []) {
    byKey.set(keyOf(candidate.value), candidate);
  }
  for (const candidate of supplemental ?? []) {
    const key = keyOf(candidate.value);
    const prev = byKey.get(key);
    if (!prev || candidate.score > prev.score) {
      byKey.set(key, {
        ...candidate,
        score: Math.max(candidate.score, prev?.score ?? 0),
        features: {
          ...candidate.features,
          crossPageAgreement: Math.max(
            candidate.features.crossPageAgreement ?? 0,
            prev?.features.crossPageAgreement ?? 0,
            0.5
          ),
        },
      });
    }
  }

  return [...byKey.values()];
}

function supplementDraftFromMergedText(
  draft: ExtendedCardDraft,
  pages: CardPage[]
): ExtendedCardDraft {
  if (pages.length <= 1) return draft;

  const mergedInput = buildMergedNormalizedInput(pages);
  const emailRaw = extractEmailCandidates(mergedInput);
  const websiteRaw = extractWebsiteCandidates(mergedInput, emailRaw.map((c) => c.value));
  const personRaw = extractPersonNameCandidates(mergedInput, emailRaw);
  const roleRaw = extractRoleCandidates(mergedInput);
  const layout = detectLayoutFromPages(
    pages.map((page) => {
      const input = buildNormalizedInput(page.lines, page.rawText);
      return { lines: input.lines };
    })
  );

  const companyRaw = extractCompanyCandidates(
    mergedInput,
    emailRaw,
    websiteRaw.map((c) => c.value),
    layout
  );

  return {
    ...draft,
    email: mergeSupplementalCandidates(draft.email, scoreField(emailRaw, 'email')),
    website: mergeSupplementalCandidates(draft.website, scoreField(websiteRaw, 'website')),
    company: mergeSupplementalCandidates(draft.company, scoreField(companyRaw, 'company')),
    personName: mergeSupplementalPersonNames(
      draft.personName,
      scoreCandidates(personRaw, 'firstName').map((candidate) => ({
        ...toScoredCandidate(candidate),
        extractor: PERSON_NAME_EXTRACTOR,
      })) as ExtendedCardDraft['personName']
    ),
    role: mergeSupplementalCandidates(draft.role, scoreField(roleRaw, 'role')),
  };
}

function fallbackPageDraft(rawText: string): ExtendedCardDraft {
  const text = rawText.trim();
  const repaired = repairOcrContactText(text);
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 2)
    .map((line, lineIndex) => ({
      text: line,
      confidence: 0.7,
      lineIndex,
    }));

  const input: NormalizedInput = { lines, rawText: text, repairedText: repaired };
  const draft = buildPageDraft(input);

  const caps = text.match(/\b([A-ZÀ-Ü]{2,})\s+([A-ZÀ-Ü]{2,})\b/);
  if (caps && COMMON_FIRST_NAMES.has(caps[1].toLowerCase()) && !draft.personName?.length) {
    const fn = capitalizeWord(caps[1]);
    const ln = capitalizeWord(caps[2]);
    draft.personName = [
      {
        value: { firstName: fn, lastName: ln },
        sourceLineIndices: [],
        extractor: 'fallback:caps',
        rawText: caps[0],
        features: { confidenceOcr: 0.5 },
        score: 0.4,
      },
    ];
  }

  return draft;
}

function buildConfidence(
  selection: DraftSelection,
  fields: Pick<CardFields, 'firstName' | 'lastName' | 'company' | 'role' | 'emails' | 'phones'>
): Record<string, number> {
  return {
    firstName: fields.firstName ? (selection.firstName?.confidence ?? 0.75) : 0.2,
    lastName: fields.lastName ? (selection.lastName?.confidence ?? 0.7) : 0.2,
    company: fields.company ? (selection.company?.confidence ?? 0.8) : 0.2,
    role: fields.role ? (selection.role?.confidence ?? 0.75) : 0.2,
    emails: fields.emails.length > 0 ? Math.max(selection.emails[0]?.confidence ?? 0.9, 0.85) : 0.2,
    phones: fields.phones.length > 0 ? Math.max(selection.phones[0]?.confidence ?? 0.85, 0.8) : 0.2,
  };
}

function assembleFields(
  selection: DraftSelection,
  mergedDraft: ExtendedCardDraft,
  multiPage: boolean,
  rawText: string,
  mergedLines: NormalizedInput['lines'] = []
): CardFields {
  const reconciled = reconcileSelection(selection, {
    rawText,
    website: selection.website?.value,
    company: selection.company?.value,
  });

  let company = reconciled.company;

  const companyEnriched = reconcileCompanySelection(
    company,
    mergedDraft.company as ScoredCandidate<string>[] | undefined,
    mergedLines,
    reconciled.emails,
    reconciled.website,
    rawText,
    reconciled.firstName,
    reconciled.lastName
  );
  company = companyEnriched.company;

  company = dedupeCompanyBrandTokens(
    stripPersonNamePrefixFromCompany(company, reconciled.firstName, reconciled.lastName)
  );

  const role = pickRoleNearName(selection, mergedDraft) || selection.role?.value || '';
  let address = validateFinalAddress(selection.address?.value ?? null) ?? undefined;
  address = validateFinalAddress(enrichSelectedAddress(address, repairOcrContactText(rawText), rawText) ?? null) ?? undefined;
  const vatNumber = selection.vatNumber?.value;
  const taxCode = selection.taxCode?.value;

  let website = reconciled.website;
  const explicitWebsite = findExplicitWebsiteInText(rawText, reconciled.emails);
  if (explicitWebsite) {
    website = explicitWebsite;
  }

  const fields: CardFields = {
    firstName: reconciled.firstName,
    lastName: reconciled.lastName,
    role,
    company,
    emails: reconciled.emails,
    phones: reconciled.phones,
    address,
    vatNumber,
    taxCode,
    website,
    rawText: repairOcrContactText(rawText),
    confidence: buildConfidence(selection, {
      firstName: reconciled.firstName,
      lastName: reconciled.lastName,
      company,
      role,
      emails: reconciled.emails,
      phones: reconciled.phones,
    }),
  };

  return fields;
}

/**
 * Orchestrazione: normalize → extract → score → resolve → validate → assemble.
 * Nessuna invocazione AI automatica.
 */
export function parseCardFromPages(
  pages: CardPage[]
): Omit<BusinessCard, 'type' | 'title' | 'images'> {
  const safePages = pages.map((page) => {
    const { lines, rawText } = clampOcrLines(page.lines, page.rawText);
    return { lines, rawText };
  });

  const pageDrafts: ExtendedCardDraft[] = [];
  const repairedTexts: string[] = [];
  let lineOffset = 0;

  for (const page of safePages) {
    try {
      const input = buildNormalizedInput(page.lines, page.rawText);
      const draft = remapDraftLineIndices(buildPageDraft(input), lineOffset);
      pageDrafts.push(draft);
      repairedTexts.push(input.repairedText);
      lineOffset += input.lines.length;
    } catch (error) {
      runtimeLogger.warn('PARSER_PAGE_FALLBACK', error, {
        status: 'failed',
        stage: 'parse',
        source: 'local',
      });
      const fallback = fallbackPageDraft(page.rawText);
      pageDrafts.push(remapDraftLineIndices(fallback, lineOffset));
      repairedTexts.push(repairOcrContactText(page.rawText.trim()));
      lineOffset += page.rawText.split('\n').filter((l) => l.trim().length >= 2).length;
    }
  }

  const mergedDraft =
    safePages.length === 1
      ? pageDrafts[0]
      : supplementDraftFromMergedText(mergePageDrafts(pageDrafts), safePages);
  const rawText = mergePageTexts(repairedTexts);
  const mergedLines = buildMergedNormalizedInput(safePages).lines;

  const { selection } = selectFromDraft(mergedDraft);
  const { selection: constrained } = applyConstraints(selection, mergedDraft);
  const fields = assembleFields(
    constrained,
    mergedDraft,
    safePages.length > 1,
    rawText,
    mergedLines
  );

  return {
    ...fields,
    id: createId(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function parseCard(
  lines: OcrLine[],
  rawText: string
): Omit<BusinessCard, 'type' | 'title' | 'images'> {
  return parseCardFromPages([{ lines, rawText }]);
}

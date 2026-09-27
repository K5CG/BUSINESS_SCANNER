import type { Address, Phone } from '../../types';
import { extractAddressCandidates } from './extractors/address';
import {
  extractCompanyCandidates,
} from './extractors/company';
import { extractEmailCandidates } from './extractors/email';
import { extractPersonNameCandidates } from './extractors/person-name';
import { extractPhoneCandidates } from './extractors/phone';
import { extractRoleCandidates } from './extractors/role';
import { extractTaxIdCandidates } from './extractors/vat-taxcode';
import { extractWebsiteCandidates } from './extractors/website';
import { detectLayoutFromPages, detectLayoutFromRawLines } from './layout/debug';
import {
  mergePageDrafts,
  mergePageTexts,
  PERSON_NAME_EXTRACTOR,
  splitTaxIdCandidates,
  type ExtendedCardDraft,
} from './merge/pages';
import { buildNormalizedInput, clampOcrLines } from './normalize/lines';
import { repairOcrContactText } from './normalize/ocr-repair';
import { parseCardFromPages, type CardPage } from './pipeline';
import { applyConstraints } from './resolve/constraints';
import { selectFromDraft, type DraftSelection, type FieldDecision } from './resolve/select';
import { scoreCandidates, toScoredCandidate } from './scoring/score';
import type { Candidate, FieldKind, NormalizedInput, ScoredCandidate } from './types';
import { validateEmail } from './validators/email';
import { validatePhone } from './validators/phone';
import { validateTaxCode, validateVatNumber } from './validators/vat';
import { addressCompletenessScore, isValidItalianPostalCode, isValidItalianProvince, validateAddress, validateFinalAddress } from './validators/address';
import { isGenericEmailLocalPart } from './extractors/email';
import { validateWebsite, resolveWebsiteWithPrimaryEmailDomain, getPrimaryBusinessEmailDomain, websiteHostMatchesEmailDomain } from './validators/website';
import { isCompanySloganClaimLine } from './validators/role';
import { sanitizeCompanyValue, isRejectedCompanyValue, alignCompanyToEmailDomain } from './validators/company';
import { hasLegalForm } from './validators/dictionaries';
import { hasLegalFormDomainEvidence } from './scoring/features';
import {
  CONFIDENCE_THRESHOLDS,
  type BusinessCardExtractionResult,
  type ExtractionSource,
  type ExtractedField,
  type FieldConfidence,
  type SemanticFieldKey,
} from './card-extraction-result';
import { applyUniversalOverrides } from './universal-card-postprocess';

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
  return {
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
}

function mergeSupplementalCandidates(
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
          crossPageAgreement: Math.max(
            candidate.features.crossPageAgreement ?? 0,
            prev?.features.crossPageAgreement ?? 0,
            0.5
          ),
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

function buildMergedDraft(pages: CardPage[]): ExtendedCardDraft {
  const safePages = pages.map((page) => {
    const { lines, rawText } = clampOcrLines(page.lines, page.rawText);
    return { lines, rawText };
  });
  const pageDrafts: ExtendedCardDraft[] = [];
  let lineOffset = 0;
  for (const page of safePages) {
    const input = buildNormalizedInput(page.lines, page.rawText);
    pageDrafts.push(remapDraftLineIndices(buildPageDraft(input), lineOffset));
    lineOffset += input.lines.length;
  }
  return safePages.length === 1
    ? pageDrafts[0]
    : supplementDraftFromMergedText(mergePageDrafts(pageDrafts), safePages);
}

function inferSourceFromExtractor(extractor: string | undefined): ExtractionSource {
  const tag = (extractor ?? '').toLowerCase();
  if (tag.includes('layout')) return 'layout';
  if (tag.includes('email')) return 'email';
  if (tag.includes('website')) return 'website';
  if (tag.includes('ai')) return 'ai';
  if (tag.includes('legacy')) return 'legacy';
  return 'ocr';
}

function findCandidateExtractor(
  draft: ExtendedCardDraft,
  field: FieldKind,
  value: string | undefined
): string | undefined {
  if (!value?.trim()) return undefined;
  const key = value.trim().toLowerCase();
  const pool = draft[field] as ScoredCandidate<unknown>[] | undefined;
  const hit = pool?.find((c) => String(c.value ?? '').trim().toLowerCase() === key);
  return hit?.extractor;
}

function classifyConfidence(
  score: number,
  structured: boolean,
  ambiguous = false
): FieldConfidence {
  const thresholds = structured ? CONFIDENCE_THRESHOLDS.structured : CONFIDENCE_THRESHOLDS.semantic;
  const adjusted = ambiguous ? score - 0.08 : score;
  if (adjusted >= thresholds.high) return 'high';
  if (adjusted >= thresholds.medium) return 'medium';
  return 'low';
}

function buildScalarField(
  value: string | null | undefined,
  decision: FieldDecision<string> | undefined,
  draft: ExtendedCardDraft,
  fieldKind: FieldKind,
  structured: boolean,
  extraReasons: string[] = [],
  ambiguous = false
): ExtractedField<string> {
  const trimmed = value?.trim() || null;
  const score = decision?.score ?? (trimmed ? 0.35 : 0);
  const reasons = [...(decision?.reasons ?? [])];
  if (decision?.rejectedCount) {
    reasons.push(`candidati scartati: ${decision.rejectedCount}`);
  }
  reasons.push(...extraReasons);

  if (!trimmed) {
    return {
      value: null,
      confidence: 'low',
      score,
      source: 'ocr',
      reasons: reasons.length ? reasons : ['nessun valore estratto'],
    };
  }

  const extractor =
    findCandidateExtractor(draft, fieldKind, trimmed ?? undefined) ??
    (decision?.sourceLineIndices.length ? 'ocr:selection' : undefined);

  return {
    value: trimmed,
    confidence: classifyConfidence(score, structured, ambiguous),
    score,
    source: inferSourceFromExtractor(extractor),
    reasons,
  };
}

function companyAlternativeReasons(draft: ExtendedCardDraft): { reasons: string[]; ambiguous: boolean } {
  const companies = [...(draft.company ?? [])]
    .filter((c) => typeof c.value === 'string' && c.value.trim())
    .sort((a, b) => b.score - a.score);
  if (companies.length < 2) return { reasons: [], ambiguous: false };

  const topScore = companies[0]?.score ?? 0;
  const close = companies.filter(
    (c, index) =>
      index > 0 &&
      topScore - c.score <= CONFIDENCE_THRESHOLDS.companyAmbiguityGap &&
      c.score >= CONFIDENCE_THRESHOLDS.collectMin
  );

  const reasons = close.slice(0, 4).map(
    (c) =>
      `alternativa company: "${String(c.value)}" (score ${c.score.toFixed(2)}, ${c.extractor})`
  );
  return { reasons, ambiguous: close.length > 0 };
}

function collectAllEmails(draft: ExtendedCardDraft, parsed: string[]): string[] {
  const seen = new Set<string>();
  for (const email of parsed) {
    const valid = validateEmail(email);
    if (valid) seen.add(valid.toLowerCase());
  }
  for (const candidate of draft.email ?? []) {
    if (candidate.score < CONFIDENCE_THRESHOLDS.collectMin) continue;
    const valid = validateEmail(String(candidate.value ?? ''));
    if (valid) seen.add(valid.toLowerCase());
  }
  return [...seen];
}

function collectAllPhones(draft: ExtendedCardDraft, parsed: Phone[]): Phone[] {
  const byKey = new Map<string, Phone>();
  for (const phone of parsed) {
    const valid = validatePhone(phone);
    if (valid) byKey.set(valid.number.replace(/\D/g, ''), valid);
  }
  for (const candidate of draft.phone ?? []) {
    if (candidate.score < CONFIDENCE_THRESHOLDS.collectMin) continue;
    const valid = validatePhone(candidate.value as Phone);
    if (valid) byKey.set(valid.number.replace(/\D/g, ''), valid);
  }
  return [...byKey.values()];
}

function collectTaxIds(
  draft: ExtendedCardDraft,
  parsedVat: string | undefined,
  parsedTax: string | undefined
): { vat: string | null; tax: string | null; vatScore: number; taxScore: number; vatReasons: string[]; taxReasons: string[] } {
  let vat = parsedVat?.trim() || null;
  let tax = parsedTax?.trim() || null;
  let vatScore = vat ? 0.75 : 0;
  let taxScore = tax ? 0.75 : 0;
  const vatReasons: string[] = [];
  const taxReasons: string[] = [];

  for (const candidate of draft.vatNumber ?? []) {
    if (candidate.score < CONFIDENCE_THRESHOLDS.collectMin) continue;
    const valid = validateVatNumber(String(candidate.value ?? ''));
    if (!valid) continue;
    if (!vat || candidate.score > vatScore) {
      vat = valid;
      vatScore = candidate.score;
      vatReasons.push(`P.IVA da candidato (score ${candidate.score.toFixed(2)})`);
    }
  }

  for (const candidate of draft.taxCode ?? []) {
    if (candidate.score < CONFIDENCE_THRESHOLDS.collectMin) continue;
    const valid = validateTaxCode(String(candidate.value ?? ''));
    if (!valid) continue;
    if (!tax || candidate.score > taxScore) {
      tax = valid;
      taxScore = candidate.score;
      taxReasons.push(`CF da candidato (score ${candidate.score.toFixed(2)})`);
    }
  }

  if (vat && !tax && /^\d{11}$/.test(vat)) {
    const shared = draft.vatNumber?.find((c) => String(c.value) === vat && c.extractor.includes(':tax'));
    if (shared || draft.taxCode?.some((c) => String(c.value) === vat)) {
      tax = vat;
      taxScore = Math.max(taxScore, shared?.score ?? 0.82);
      taxReasons.push('P.IVA/CF condivisi da etichetta combinata');
    }
  }

  return { vat, tax, vatScore, taxScore, vatReasons, taxReasons };
}

function buildListField<T>(
  values: T[],
  decisions: FieldDecision<T>[],
  structured: boolean,
  emptyReason: string
): ExtractedField<T[]> {
  if (!values.length) {
    return {
      value: null,
      confidence: 'low',
      score: 0,
      source: 'ocr',
      reasons: [emptyReason],
    };
  }

  const topScore = Math.max(...decisions.map((d) => d.score), 0.5);
  const avgConfidence =
    decisions.length > 0
      ? decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length
      : topScore;

  return {
    value: values,
    confidence: classifyConfidence(Math.max(topScore, avgConfidence), structured),
    score: topScore,
    source: inferSourceFromExtractor(
      decisions[0] ? `ocr:${decisions.length}` : undefined
    ),
    reasons: [
      `${values.length} valore/i estratto/i`,
      ...decisions.flatMap((d) => d.reasons).slice(0, 4),
    ],
  };
}

function findCompanyCandidateFeatures(
  draft: ExtendedCardDraft,
  company: string | undefined
): ScoredCandidate<unknown> | undefined {
  if (!company?.trim()) return undefined;
  const key = company.trim().toLowerCase();
  return draft.company?.find((c) => String(c.value ?? '').trim().toLowerCase() === key);
}

function resolveWebsiteValue(
  website: string | undefined | null,
  emails: string[],
  draft: ExtendedCardDraft
): { value: string | null; explicit: boolean; emailAligned: boolean } {
  const value = resolveWebsiteWithPrimaryEmailDomain(website, emails);
  if (!value) {
    return { value: null, explicit: false, emailAligned: false };
  }

  const emailDomain = getPrimaryBusinessEmailDomain(emails);
  const emailAligned = emailDomain ? websiteHostMatchesEmailDomain(value, emailDomain) : false;
  const candidate = draft.website?.find(
    (c) => validateWebsite(String(c.value ?? '')) === value
  );
  const explicit = Boolean(
    candidate?.extractor === 'website' && emailAligned
  );

  return { value, explicit, emailAligned };
}

function findRoleCandidateFeatures(
  draft: ExtendedCardDraft,
  role: string | undefined
): ScoredCandidate<unknown> | undefined {
  if (!role?.trim()) return undefined;
  const key = role.trim().toLowerCase();
  return draft.role?.find((c) => String(c.value ?? '').trim().toLowerCase() === key);
}

function applyFieldConfidenceBoosts(
  result: BusinessCardExtractionResult,
  draft: ExtendedCardDraft,
  emails: string[]
): BusinessCardExtractionResult {
  const boosted = { ...result };

  if (boosted.company.value) {
    const aligned = alignCompanyToEmailDomain(boosted.company.value, emails, boosted.rawText);
    const cleaned = sanitizeCompanyValue(aligned);
    if (!cleaned || isRejectedCompanyValue(cleaned)) {
      boosted.company = {
        ...boosted.company,
        value: null,
        confidence: 'low',
        reasons: [...boosted.company.reasons, 'ragione sociale non valida'],
      };
    } else if (cleaned !== boosted.company.value) {
      boosted.company = { ...boosted.company, value: cleaned };
    }
  }

  if (boosted.address.value) {
    const validated = validateFinalAddress(boosted.address.value);
    if (!validated) {
      boosted.address = {
        ...boosted.address,
        value: null,
        confidence: 'low',
        reasons: [...boosted.address.reasons, 'indirizzo scartato: validazione finale'],
      };
    } else if (validated !== boosted.address.value) {
      boosted.address = { ...boosted.address, value: validated };
    }
  }

  const companyCandidate = findCompanyCandidateFeatures(draft, boosted.company.value ?? undefined);
  if (
    boosted.company.value &&
    hasLegalForm(boosted.company.value) &&
    companyCandidate &&
    hasLegalFormDomainEvidence(companyCandidate.features, boosted.company.value)
  ) {
    boosted.company = {
      ...boosted.company,
      score: Math.max(boosted.company.score, 0.88),
      confidence: 'high',
      reasons: [...boosted.company.reasons, 'forma giuridica + dominio email/sito coerente'],
    };
  }

  if (boosted.firstName.value && boosted.lastName.value) {
    const nameScore = Math.max(boosted.firstName.score, boosted.lastName.score);
    const hasEmailEvidence = (draft.personName ?? draft.firstName ?? []).some(
      (c) => (c.features.emailLocalPartMatch ?? 0) >= 0.7
    );
    const boostedScore = hasEmailEvidence ? Math.max(nameScore, 0.78) : Math.min(nameScore, 0.72);
    const nameConfidence =
      hasEmailEvidence && boostedScore >= 0.76
        ? 'high'
        : boostedScore >= 0.55
          ? 'medium'
          : 'low';
    boosted.firstName = {
      ...boosted.firstName,
      score: boostedScore,
      confidence: nameConfidence,
    };
    boosted.lastName = {
      ...boosted.lastName,
      score: boostedScore,
      confidence: nameConfidence,
    };
  }

  const roleCandidate = findRoleCandidateFeatures(draft, boosted.role.value ?? undefined);
  if (boosted.role.value && !isCompanySloganClaimLine(boosted.role.value)) {
    const nearName = (roleCandidate?.features.crossPageAgreement ?? 0) >= 0.65;
    const hasRoleKeyword = Boolean(roleCandidate?.features.hasRoleKeyword);
    if (hasRoleKeyword && nearName) {
      boosted.role = {
        ...boosted.role,
        score: Math.max(boosted.role.score, 0.82),
        confidence: 'high',
        reasons: [...boosted.role.reasons, 'ruolo professionale vicino al nome'],
      };
    } else if (hasRoleKeyword) {
      boosted.role = {
        ...boosted.role,
        confidence: 'medium',
      };
    } else {
      boosted.role = {
        ...boosted.role,
        confidence: 'low',
      };
    }
  } else if (boosted.role.value && isCompanySloganClaimLine(boosted.role.value)) {
    boosted.role = {
      ...boosted.role,
      confidence: 'low',
      reasons: [...boosted.role.reasons, 'testo assimilabile a slogan aziendale'],
    };
  }

  const websiteResolved = resolveWebsiteValue(boosted.website.value, emails, draft);
  if (websiteResolved.value) {
    const emailDomain = getPrimaryBusinessEmailDomain(emails);
    const matchesEmailDomain =
      Boolean(emailDomain) &&
      websiteHostMatchesEmailDomain(websiteResolved.value, emailDomain!);
    const canBeHigh = matchesEmailDomain && websiteResolved.emailAligned;
    boosted.website = {
      ...boosted.website,
      value: websiteResolved.value,
      score: Math.max(
        boosted.website.score,
        websiteResolved.explicit ? 0.85 : websiteResolved.emailAligned ? 0.78 : 0.5
      ),
      confidence: canBeHigh ? 'high' : 'medium',
      source: websiteResolved.explicit ? boosted.website.source : 'email',
      reasons: [
        ...boosted.website.reasons,
        websiteResolved.explicit
          ? 'sito esplicito nel testo OCR'
          : 'sito derivato da dominio email aziendale',
      ],
    };
  } else {
    boosted.website = {
      ...boosted.website,
      value: null,
      confidence: 'low',
      reasons: [...boosted.website.reasons, 'nessun sito valido (host numerico o assente)'],
    };
  }

  const addr = boosted.address.value;
  if (addr) {
    const completeness = addressCompletenessScore(addr);
    const fullItalian =
      Boolean(addr.street?.trim()) &&
      isValidItalianPostalCode(addr.postalCode) &&
      Boolean(addr.city?.trim()) &&
      isValidItalianProvince(addr.region);
    if (fullItalian || completeness >= 0.9) {
      boosted.address = {
        ...boosted.address,
        score: Math.max(boosted.address.score, 0.9),
        confidence: 'high',
        reasons: [...boosted.address.reasons, 'CAP + città + provincia + via'],
      };
    }
  }

  if (boosted.vatNumber.value && boosted.taxCode.value && boosted.vatNumber.value === boosted.taxCode.value) {
    boosted.vatNumber = {
      ...boosted.vatNumber,
      score: Math.max(boosted.vatNumber.score, 0.88),
      confidence: 'high',
      reasons: [...boosted.vatNumber.reasons, 'P.IVA/CF condivisi'],
    };
    boosted.taxCode = {
      ...boosted.taxCode,
      score: Math.max(boosted.taxCode.score, 0.88),
      confidence: 'high',
      reasons: [...boosted.taxCode.reasons, 'P.IVA/CF condivisi'],
    };
  }

  return boosted;
}

function finalizeWithEmailDomain(
  result: BusinessCardExtractionResult,
  emails: string[]
): BusinessCardExtractionResult {
  const next = { ...result };

  if (next.company.value) {
    const aligned = alignCompanyToEmailDomain(next.company.value, emails, next.rawText);
    const cleaned = sanitizeCompanyValue(aligned);
    next.company = {
      ...next.company,
      value: cleaned && !isRejectedCompanyValue(cleaned) ? cleaned : null,
    };
  }

  const website = resolveWebsiteWithPrimaryEmailDomain(next.website.value, emails);
  if (website) {
    const emailDomain = getPrimaryBusinessEmailDomain(emails);
    const matchesEmailDomain = Boolean(
      emailDomain && websiteHostMatchesEmailDomain(website, emailDomain)
    );
    next.website = {
      ...next.website,
      value: website,
      confidence: matchesEmailDomain ? 'high' : 'medium',
      source: matchesEmailDomain ? 'email' : next.website.source,
      reasons: [
        ...next.website.reasons,
        matchesEmailDomain
          ? 'sito allineato a dominio email aziendale'
          : 'sito non coerente con dominio email',
      ],
    };
  } else {
    next.website = {
      ...next.website,
      value: null,
      confidence: 'low',
    };
  }

  return next;
}

function applyFinalAddressField(
  field: ExtractedField<Address | null>
): ExtractedField<Address | null> {
  const validated = validateFinalAddress(field.value);
  if (!validated) {
    return {
      ...field,
      value: null,
      confidence: 'low',
      reasons: [...field.reasons, 'indirizzo scartato: validazione finale'],
    };
  }
  return { ...field, value: validated };
}

function computeReviewFields(result: BusinessCardExtractionResult): string[] {
  const review: string[] = [];
  const check = (key: SemanticFieldKey | 'emails' | 'phones' | 'website' | 'vatNumber' | 'taxCode') => {
    const field = result[key] as ExtractedField<unknown>;
    if (key === 'address') {
      if (!field.value) {
        if (field.reasons.some((reason) => /indirizzo scartato/i.test(reason))) {
          review.push('address');
        }
        return;
      }
    } else if (!field.value) {
      return;
    }
    if (field.confidence === 'low') {
      review.push(key);
      return;
    }
    if (
      field.confidence === 'medium' &&
      (key === 'company' || key === 'firstName' || key === 'lastName' || key === 'role' || key === 'address')
    ) {
      review.push(key);
    }
  };

  for (const key of [
    'firstName',
    'lastName',
    'company',
    'role',
    'address',
    'emails',
    'phones',
    'website',
    'vatNumber',
    'taxCode',
  ] as const) {
    check(key);
  }

  const hasFirst = Boolean(result.firstName.value?.trim());
  const hasLast = Boolean(result.lastName.value?.trim());
  if (hasFirst !== hasLast) {
    if (!review.includes('firstName') && hasFirst) review.push('firstName');
    if (!review.includes('lastName') && hasLast) review.push('lastName');
  }

  return [...new Set(review)];
}

/**
 * Adapter sperimentale: usa il parser-engine esistente e restituisce un risultato
 * best-effort con confidence per campo. Non modifica la pipeline di produzione.
 */
export function extractCardWithConfidence(pages: CardPage[]): BusinessCardExtractionResult {
  const safePages = pages.map((page) => {
    const { lines, rawText } = clampOcrLines(page.lines, page.rawText);
    return { lines, rawText };
  });

  const parsed = parseCardFromPages(safePages);
  const mergedDraft = buildMergedDraft(safePages);
  const { selection } = selectFromDraft(mergedDraft);
  const { selection: constrained } = applyConstraints(selection, mergedDraft);

  const companyAlts = companyAlternativeReasons(mergedDraft);
  const emails = collectAllEmails(mergedDraft, parsed.emails);
  const phones = collectAllPhones(mergedDraft, parsed.phones);
  const taxIds = collectTaxIds(mergedDraft, parsed.vatNumber, parsed.taxCode);

  const firstName = buildScalarField(
    parsed.firstName,
    constrained.firstName,
    mergedDraft,
    'firstName',
    false
  );
  const lastName = buildScalarField(
    parsed.lastName,
    constrained.lastName,
    mergedDraft,
    'lastName',
    false
  );
  const company = buildScalarField(
    parsed.company,
    constrained.company,
    mergedDraft,
    'company',
    false,
    companyAlts.reasons,
    companyAlts.ambiguous
  );
  const role = buildScalarField(parsed.role, constrained.role, mergedDraft, 'role', false);
  const website = buildScalarField(
    parsed.website,
    constrained.website,
    mergedDraft,
    'website',
    true
  );
  const vatNumber = buildScalarField(taxIds.vat, constrained.vatNumber, mergedDraft, 'vatNumber', true, taxIds.vatReasons);
  const taxCode = buildScalarField(taxIds.tax, constrained.taxCode, mergedDraft, 'taxCode', true, taxIds.taxReasons);

  const addressValue = parsed.address ?? null;
  const addressDecision = constrained.address;
  const address: ExtractedField<Address | null> = {
    value: addressValue,
    confidence: classifyConfidence(
      addressDecision?.score ?? (addressValue ? 0.55 : 0),
      false,
      false
    ),
    score: addressDecision?.score ?? (addressValue ? 0.55 : 0),
    source: inferSourceFromExtractor(findCandidateExtractor(
      mergedDraft,
      'address',
      addressValue?.full ?? addressValue?.street
    )),
    reasons: addressDecision?.reasons ?? (addressValue ? ['indirizzo assemblato'] : ['nessun indirizzo']),
  };

  const emailsField = buildListField(
    emails,
    constrained.emails,
    true,
    'nessuna email valida rilevata'
  );
  const phonesField = buildListField(
    phones,
    constrained.phones,
    true,
    'nessun telefono valido rilevato'
  );

  const boosted = applyFieldConfidenceBoosts(
    {
    firstName,
    lastName,
    company,
    role,
    emails: emailsField,
    phones: phonesField,
    website,
    address,
    vatNumber,
    taxCode,
    rawText: parsed.rawText,
    needsReview: false,
    reviewFields: [],
    },
    mergedDraft,
    emails
  );

  const partial = applyUniversalOverrides(boosted);
  const finalized = finalizeWithEmailDomain(partial, emails);
  finalized.address = applyFinalAddressField(finalized.address);

  const reviewFields = computeReviewFields(finalized);
  return {
    ...finalized,
    reviewFields,
    needsReview: reviewFields.length > 0,
  };
}

export type { CardPage };

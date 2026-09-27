import type { Phone } from '../../../types';
import { isGenericEmailLocalPart } from '../extractors/email';
import { isGenericProviderDomain } from '../extractors/website';
import { capitalizeWord, tokenize } from '../normalize/tokens';
import { repairOcrContactText } from '../normalize/ocr-repair';
import { dedupeEmails, validateEmail } from '../validators/email';
import {
  COMPANY_DESCRIPTOR_WORDS,
  hasLegalFormSuffix,
  isIsolatedLegalFormOnly,
  isLikelyIndustryAcronymLine,
  normalizeBrandKey,
  stripLegalFormSuffix,
} from '../validators/dictionaries';
import { extractCompanyCandidates } from '../extractors/company';
import { rankCompanyCandidate, pickPreferredCompanyValue } from '../merge/pages';
import type { ScoredCandidate } from '../types';
import {
  isDisqualifiedCompanyValue,
  isRoleOnlyCompanyValue,
  looksLikeAddressOrLocationLine,
  looksLikeCatalogLine,
} from '../scoring/features';
import {
  parseNameFromEmailLocal,
  parsePersonNameFromLine,
  validatePersonName,
} from '../validators/name';
import { hasLegalForm } from '../validators/dictionaries';
import { alignCompanyToEmailDomain, sanitizeCompanyValue } from '../validators/company';
import { validateWebsite, resolveWebsiteWithPrimaryEmailDomain } from '../validators/website';
import type { DraftSelection } from './select';

const EMAIL_SINGLE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const LEGAL_FORM_STRIP =
  /\s*,?\s*\b(S\.?\s*R\.?\s*L\.?\.?|S\.?\s*P\.?\s*A\.?\.?|S\.?\s*N\.?\s*C\.?\.?|S\.?\s*A\.?\s*S\.?\.?|GmbH|AG|Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|PLC|BV|NV|SA|S\.?\s*L\.?)\.?\s*$/i;

const GENERIC_MAILBOX_DOMAINS = new Set(['email.it']);
const LAYOUT_COMPANY_EXTRACTOR = 'company:layout';
const LEGAL_FORM_REPLACEMENT_RANK_GAP = 0.28;
const LEGAL_FORM_REPLACEMENT_SCORE_GAP = 0.18;

function isLayoutCompanyExtractor(extractor: string): boolean {
  return extractor === LAYOUT_COMPANY_EXTRACTOR;
}

function normalizeCompanyMatchKey(value: string): string {
  return normalizeComparableKey(stripLegalFormSuffix(value));
}

function findMatchingLayoutCandidate(
  company: string,
  draftCompanies?: ScoredCandidate<string>[]
): ScoredCandidate<string> | undefined {
  if (!company.trim() || !draftCompanies?.length) return undefined;

  const targetKey = normalizeCompanyMatchKey(company);
  if (!targetKey) return undefined;

  const layouts = draftCompanies.filter((c) => isLayoutCompanyExtractor(c.extractor));
  let best: ScoredCandidate<string> | undefined;
  let bestOverlap = 0;

  for (const candidate of layouts) {
    const value = String(candidate.value ?? '').trim();
    if (!value) continue;
    const key = normalizeCompanyMatchKey(value);
    if (key === targetKey) return candidate;

    const overlap = Math.min(key.length, targetKey.length);
    if (overlap >= 6 && (targetKey.includes(key) || key.includes(targetKey)) && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = candidate;
    }
  }

  if (best) return best;

  const companyWords = tokenize(stripLegalFormSuffix(company))
    .map((word) => normalizeComparableKey(word))
    .filter((key) => key.length >= 4);

  for (const candidate of layouts) {
    const layoutWords = tokenize(stripLegalFormSuffix(String(candidate.value ?? '')))
      .map((word) => normalizeComparableKey(word))
      .filter((key) => key.length >= 4);
    if (!layoutWords.length || !companyWords.length) continue;

    const shared = companyWords.filter((word) =>
      layoutWords.some(
        (layoutWord) => keysPlausiblySame(word, layoutWord) || word.includes(layoutWord) || layoutWord.includes(word)
      )
    );
    const threshold = Math.min(2, Math.min(companyWords.length, layoutWords.length));
    if (shared.length >= threshold) {
      const score = shared.length / Math.max(companyWords.length, layoutWords.length);
      if (score > bestOverlap) {
        bestOverlap = score;
        best = candidate;
      }
    }
  }

  return bestOverlap >= 0.35 ? best : undefined;
}

function shouldProtectLayoutSelection(
  company: string,
  draftCompanies?: ScoredCandidate<string>[]
): { protect: boolean; anchor?: ScoredCandidate<string> } {
  if (!company.trim() || !draftCompanies?.length) return { protect: false };

  const trimmed = company.trim();
  const targetKey = normalizeCompanyMatchKey(trimmed);
  if (!targetKey) return { protect: false };

  const exactLayout = draftCompanies.find(
    (candidate) =>
      isLayoutCompanyExtractor(candidate.extractor) && String(candidate.value ?? '').trim() === trimmed
  );
  if (exactLayout) {
    const anchorValue = String(exactLayout.value ?? '').trim();
    if (anchorValue && !isClearlyUnusableCompany(anchorValue)) {
      const sameValueNonLayout = draftCompanies
        .filter(
          (candidate) =>
            !isLayoutCompanyExtractor(candidate.extractor) &&
            String(candidate.value ?? '').trim() === trimmed
        )
        .sort((a, b) => b.score - a.score)[0];
      if (!sameValueNonLayout || sameValueNonLayout.score <= exactLayout.score + 0.02) {
        return { protect: true, anchor: exactLayout };
      }
    }
  }

  const sameKey = draftCompanies.filter(
    (candidate) => normalizeCompanyMatchKey(String(candidate.value ?? '')) === targetKey
  );
  const layoutMatches = sameKey.filter((candidate) => isLayoutCompanyExtractor(candidate.extractor));
  if (!layoutMatches.length) return { protect: false };

  const nonLayoutMatches = sameKey.filter((candidate) => !isLayoutCompanyExtractor(candidate.extractor));
  const bestLayout = [...layoutMatches].sort((a, b) => b.score - a.score)[0];
  const bestNonLayout = nonLayoutMatches.length
    ? [...nonLayoutMatches].sort((a, b) => b.score - a.score)[0]
    : undefined;

  if (bestNonLayout && bestNonLayout.score > bestLayout.score + 0.02) {
    return { protect: false };
  }

  const anchorValue = String(bestLayout.value ?? '').trim();
  if (!anchorValue || isClearlyUnusableCompany(anchorValue)) {
    return { protect: false };
  }

  return { protect: true, anchor: bestLayout };
}

function findSelectedLayoutAnchor(
  company: string,
  draftCompanies?: ScoredCandidate<string>[]
): ScoredCandidate<string> | undefined {
  return shouldProtectLayoutSelection(company, draftCompanies).anchor;
}

function isDomainFusedBrandMutation(
  company: string,
  layoutAnchor: ScoredCandidate<string>,
  emails: string[],
  website?: string
): boolean {
  const anchorValue = String(layoutAnchor.value ?? '').trim();
  if (!anchorValue || !layoutHasSeparatedBrand(anchorValue)) return false;

  const anchorFirst = normalizeComparableKey(
    stripLegalFormSuffix(anchorValue).trim().split(/\s+/)[0] ?? ''
  );
  const companyFirst = normalizeComparableKey(
    stripLegalFormSuffix(company).trim().split(/\s+/)[0] ?? ''
  );
  if (!anchorFirst || !companyFirst) return false;
  if (anchorFirst === companyFirst) return false;

  if (
    companyFirst.length > anchorFirst.length &&
    anchorFirst.length >= 4 &&
    companyFirst.includes(anchorFirst)
  ) {
    return collectBrandHints(emails, website).some(
      (hint) => keysPlausiblySame(companyFirst, hint.key) || companyFirst.includes(hint.key)
    );
  }

  if (keysPlausiblySame(anchorFirst, companyFirst)) return false;

  if (wouldFuseDomainIntoSeparatedBrand(company, emails, website)) return true;

  return collectBrandHints(emails, website).some(
    (hint) =>
      hint.key.length >= 8 &&
      (companyFirst.includes(hint.key) || keysPlausiblySame(companyFirst, hint.key)) &&
      !keysPlausiblySame(anchorFirst, hint.key)
  );
}

function isSpellingDegradedLayoutBrand(
  company: string,
  layoutAnchor: ScoredCandidate<string>
): boolean {
  const anchorValue = String(layoutAnchor.value ?? '').trim();
  if (!anchorValue) return false;

  const anchorFirst = normalizeComparableKey(
    stripLegalFormSuffix(anchorValue).trim().split(/\s+/)[0] ?? ''
  );
  const companyFirst = normalizeComparableKey(
    stripLegalFormSuffix(company).trim().split(/\s+/)[0] ?? ''
  );
  if (!anchorFirst || !companyFirst || anchorFirst === companyFirst) return false;

  if (anchorFirst.length > companyFirst.length && anchorFirst.includes(companyFirst) && companyFirst.length >= 4) {
    return true;
  }

  return false;
}

function restoreLayoutSelectionIfMutated(
  company: string,
  layoutAnchor: ScoredCandidate<string>,
  emails: string[],
  website: string | undefined,
  reasons: string[]
): string {
  const anchorValue = String(layoutAnchor.value ?? '').trim();
  if (!anchorValue) return company;

  if (normalizeCompanyMatchKey(company) === normalizeCompanyMatchKey(anchorValue)) {
    return company;
  }

  if (
    isDomainFusedBrandMutation(company, layoutAnchor, emails, website) ||
    isSpellingDegradedLayoutBrand(company, layoutAnchor) ||
    (sharesLayoutBrandAnchor(company, layoutAnchor) &&
      isDescriptorOnlyCompany(company) &&
      layoutHasSeparatedBrand(anchorValue))
  ) {
    reasons.push(`layout ripristinato da selezione: "${anchorValue}"`);
    return anchorValue;
  }

  return company;
}

function layoutHasSeparatedBrand(company: string): boolean {
  return stripLegalFormSuffix(company).trim().split(/\s+/).filter(Boolean).length >= 2;
}

function isClearlyUnusableCompany(company: string): boolean {
  const t = company.trim();
  if (!t) return true;
  if (looksLikeAddressOrLocationLine(t)) return true;
  if (isRoleOnlyCompanyValue(t)) return true;
  if (looksLikeCatalogLine(t) && !layoutHasSeparatedBrand(t)) return true;
  if (/^\(?[A-Za-z]{1,2}\)?\.?$/.test(t)) return true;
  if (isDisqualifiedCompanyValue(t) && t.length <= 8) return true;
  return false;
}

function isDescriptorOnlyCompany(company: string): boolean {
  const words = tokenize(stripLegalFormSuffix(company));
  if (!words.length) return true;
  const nonDescriptor = words.filter((word) => {
    const key = word.toLowerCase().replace(/[.,'’`]/g, '');
    return key.length >= 3 && !COMPANY_DESCRIPTOR_WORDS.has(key);
  });
  return nonDescriptor.length === 0;
}

function sharesLayoutBrandAnchor(value: string, layoutAnchor: ScoredCandidate<string>): boolean {
  const anchorValue = String(layoutAnchor.value ?? '').trim();
  if (!anchorValue) return false;

  const anchorWords = stripLegalFormSuffix(anchorValue)
    .trim()
    .split(/\s+/)
    .map((word) => normalizeComparableKey(word))
    .filter((key) => key.length >= 3);
  if (!anchorWords.length) return false;

  const valueKey = normalizeCompanyMatchKey(value);
  if (anchorWords.some((anchorKey) => keysPlausiblySame(anchorKey, valueKey) || valueKey.includes(anchorKey))) {
    return true;
  }

  const valueWords = stripLegalFormSuffix(value)
    .trim()
    .split(/\s+/)
    .map((word) => normalizeComparableKey(word))
    .filter((key) => key.length >= 3);

  const shared = valueWords.filter((word) =>
    anchorWords.some((anchorKey) => keysPlausiblySame(word, anchorKey) || word.includes(anchorKey) || anchorKey.includes(word))
  );
  return shared.length >= 1;
}

function findDraftCandidateForValue(
  draftCompanies: ScoredCandidate<string>[],
  value: string
): ScoredCandidate<string> | undefined {
  const key = normalizeCompanyMatchKey(value);
  return draftCompanies.find((c) => normalizeCompanyMatchKey(String(c.value ?? '')) === key);
}

function isMuchBetterLegalFormAlternative(
  layoutValue: string,
  layoutCandidate: ScoredCandidate<string>,
  alternative: string,
  altCandidate: ScoredCandidate<string>
): boolean {
  if (!hasLegalFormSuffix(alternative) || hasLegalFormSuffix(layoutValue)) return false;
  const layoutRank = rankCompanyCandidate(layoutCandidate);
  const altRank = rankCompanyCandidate(altCandidate);
  return (
    altRank >= layoutRank + LEGAL_FORM_REPLACEMENT_RANK_GAP &&
    altCandidate.score >= layoutCandidate.score + LEGAL_FORM_REPLACEMENT_SCORE_GAP
  );
}

function wouldFuseDomainIntoSeparatedBrand(
  company: string,
  emails: string[],
  website?: string
): boolean {
  if (!layoutHasSeparatedBrand(company)) return false;
  const firstKey = normalizeComparableKey(stripLegalFormSuffix(company).trim().split(/\s+/)[0] ?? '');
  if (!firstKey) return false;

  for (const hint of collectBrandHints(emails, website)) {
    if (!hint.key) continue;
    const plausiblyAligned =
      keysPlausiblySame(firstKey, hint.key) || firstKey.includes(hint.key) || hint.key.includes(firstKey);
    if (!plausiblyAligned) continue;
    if (hint.key.length > firstKey.length) return true;
    if (hint.key.length >= 8 && !keysPlausiblySame(firstKey, hint.key)) return true;
  }
  return false;
}

function shouldAllowPreferredOverProtectedLayout(
  result: string,
  preferred: string,
  preferredCandidate: ScoredCandidate<string>,
  layoutAnchor: ScoredCandidate<string>
): { allow: boolean; reason?: string } {
  if (!preferred || preferred === result) return { allow: false };

  if (isClearlyUnusableCompany(result)) {
    return { allow: true, reason: 'layout sostituito: selezione noise/indirizzo/catalogo' };
  }

  if (isMuchBetterLegalFormAlternative(result, layoutAnchor, preferred, preferredCandidate)) {
    return { allow: true, reason: 'layout sostituito: forma giuridica completa molto superiore' };
  }

  if (!isLayoutCompanyExtractor(preferredCandidate.extractor)) {
    return { allow: false, reason: `layout preservato: bloccata sostituzione non-layout "${preferred}"` };
  }

  if (isDescriptorOnlyCompany(preferred) && layoutHasSeparatedBrand(result)) {
    return { allow: false, reason: `layout preservato: bloccato descrittore-only "${preferred}"` };
  }

  return { allow: false, reason: 'layout preservato: alternativa non migliorativa' };
}

function reconcileCompanySpellingProtected(
  company: string,
  emails: string[],
  website: string | undefined,
  protectSeparatedBrand: boolean
): { company: string; reasons: string[] } {
  if (protectSeparatedBrand && wouldFuseDomainIntoSeparatedBrand(company, emails, website)) {
    return { company, reasons: ['layout: grafia conservativa (no fusione dominio nel brand)'] };
  }
  return reconcileCompanySpelling(company, emails, website);
}

export interface ReconcileContext {
  rawText: string;
  website?: string;
  company?: string;
}

export interface ReconciledFields {
  firstName: string;
  lastName: string;
  company: string;
  emails: string[];
  phones: Phone[];
  website?: string;
  reasons: string[];
}

function levenshteinDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = temp;
    }
  }
  return dp[b.length];
}

function normalizeComparableKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[oO]/g, '0')
    .replace(/[^a-z0-9]/g, '');
}

/** Email locale personale (nome/cognome/iniziale), non marchio aziendale. */
function isPersonalEmailLocalPart(
  local: string,
  firstName?: string,
  lastName?: string
): boolean {
  if (!local || local.length < 2) return false;
  const localKey = normalizeComparableKey(local);
  const fn = firstName?.trim() ?? '';
  const ln = lastName?.trim() ?? '';
  if (!fn && !ln) return false;

  const fnKey = normalizeComparableKey(fn);
  const lnKey = normalizeComparableKey(ln);

  if (fnKey && lnKey) {
    if (localKey === fnKey + lnKey || localKey === lnKey + fnKey) return true;
    if (fn.length >= 1) {
      const initial = fn[0].toLowerCase();
      if (localKey === initial + lnKey) return true;
    }
  }

  if (lnKey.length >= 3 && localKey.includes(lnKey) && localKey.length <= lnKey.length + 3) {
    return true;
  }

  return false;
}

function keysPlausiblySame(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.abs(a.length - b.length) <= 2 && levenshteinDistance(a, b) <= 2) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

function extractDomainHints(text: string): string[] {
  const hints = new Set<string>();
  for (const m of text.matchAll(/\b(?:https?:\/\/)?(?:www\.|ww\.)([a-z0-9-]{3,})\b/gi)) {
    hints.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\b([a-z0-9-]{3,})\s+s\.?\s*r\.?\s*l\.?\b/gi)) {
    hints.add(m[1].toLowerCase());
  }
  return [...hints];
}

function collectTrustedDomainHints(text: string, website?: string, company?: string): string[] {
  const hints = new Set<string>();
  for (const h of extractDomainHints(text)) {
    if (h.length >= 3) hints.add(h);
  }
  return [...hints];
}

function collectContextualDomainHints(website?: string, company?: string): string[] {
  const hints = new Set<string>();
  if (website) {
    const host = website
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('.')[0]
      ?.toLowerCase();
    if (host && host.length >= 3) hints.add(host);
  }
  if (company) {
    const brand = stripLegalFormSuffix(company).trim().split(/\s+/)[0] ?? '';
    if (brand.length >= 3) hints.add(brand.toLowerCase());
  }
  return [...hints];
}

function emailFoundInContactText(email: string, text: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/\s+/g, '');
  const key = norm(email);
  return norm(repairOcrContactText(text)).includes(key) || norm(text).includes(key);
}

function isPlausibleEmailForHints(email: string, hints: string[]): boolean {
  if (!hints.length || !EMAIL_SINGLE.test(email)) return EMAIL_SINGLE.test(email);
  const hostKey = normalizeComparableKey(email.split('@')[1]?.split('.')[0] ?? '');
  if (!hostKey) return false;
  return hints.some((h) => {
    const hintKey = normalizeComparableKey(h);
    if (hostKey === hintKey) return true;
    const maxDist = hintKey.length <= 6 ? 3 : 2;
    return levenshteinDistance(hostKey, hintKey) <= maxDist;
  });
}

function reconcileEmailAddress(email: string, hints: string[]): string {
  const lower = email.toLowerCase().trim();
  const at = lower.indexOf('@');
  if (at < 0) return email;
  const domain = lower.slice(at + 1);
  if (isGenericProviderDomain(domain)) return lower;

  const local = lower.slice(0, at);
  const dot = domain.indexOf('.');
  if (dot < 0 || !hints.length) return lower;

  const host = domain.slice(0, dot);
  const tld = domain.slice(dot + 1);
  const hostKey = normalizeComparableKey(host);

  let bestHost = host;
  let bestScore = hostKey.length >= 3 ? 5 : 0;

  for (const hint of hints) {
    const hintKey = normalizeComparableKey(hint);
    if (!hintKey) continue;
    if (hostKey === hintKey) return lower;

    const dist = levenshteinDistance(hostKey, hintKey);
    const maxDist = hintKey.length <= 6 ? 3 : 2;
    if (dist > 0 && dist <= maxDist) {
      const score = (maxDist - dist + 1) * 10 + hintKey.length;
      if (score > bestScore) {
        bestScore = score;
        bestHost = hint.toLowerCase();
      }
    }
  }

  if (bestHost !== host) return `${local}@${bestHost}.${tld}`;
  return lower;
}

/**
 * Riconcilia email con indizi da testo, sito e azienda (grafica dominio generica).
 * API compatibile con il parser legacy.
 */
export function reconcileEmailsWithCardContext(
  emails: string[],
  text: string,
  website?: string,
  company?: string
): string[] {
  const textHints = collectTrustedDomainHints(text);
  const contextualHints = collectContextualDomainHints(website, company);
  const correctionHints = [...new Set([...textHints, ...contextualHints])];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of emails) {
    const fixed = reconcileEmailAddress(raw, textHints.length ? textHints : correctionHints);
    const valid = validateEmail(fixed);
    if (!valid) continue;

    const extractedFromText = emailFoundInContactText(raw, text) || emailFoundInContactText(valid, text);
    if (
      !extractedFromText &&
      contextualHints.length &&
      !isPlausibleEmailForHints(valid, contextualHints) &&
      textHints.length &&
      !isPlausibleEmailForHints(valid, textHints)
    ) {
      continue;
    }

    if (!seen.has(valid)) {
      seen.add(valid);
      out.push(valid);
    }
  }

  return dedupeEmails(out);
}

function pickPersonalEmail(emails: string[]): string {
  const personal = emails.find((email) => {
    const local = email.split('@')[0] ?? '';
    return local.length > 0 && !isGenericEmailLocalPart(email);
  });
  return personal ?? emails[0] ?? '';
}

function websiteHostRoot(website?: string): string | undefined {
  if (!website) return undefined;
  const host = website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0] ?? '';
  const root = host.split('.')[0];
  return root && root.length >= 2 ? root.toLowerCase() : undefined;
}

function completeWebsiteHost(website: string, emails: string[]): string {
  const stripped = website.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (/\.[a-z]{2,}$/i.test(stripped)) return website;

  const emailDomain = pickPersonalEmail(emails).split('@')[1]?.toLowerCase();
  if (!emailDomain || isGenericProviderDomain(emailDomain)) return website;

  const siteHost = stripped.split('/')[0] ?? '';
  const emailRoot = emailDomain.split('.')[0] ?? '';
  if (!siteHost || !emailRoot) return website;

  if (
    siteHost === emailRoot ||
    keysPlausiblySame(normalizeComparableKey(siteHost), normalizeComparableKey(emailRoot))
  ) {
    return `www.${emailDomain}`;
  }

  const dist = levenshteinDistance(siteHost.toLowerCase(), emailRoot.toLowerCase());
  if (dist > 0 && dist <= 2 && Math.abs(siteHost.length - emailRoot.length) <= 3) {
    return `www.${emailDomain}`;
  }

  return website;
}

/**
 * Allinea sito web e dominio email quando sono graficamente simili.
 */
export function reconcileWebsiteWithEmail(
  website: string | undefined,
  emails: string[]
): { website?: string; reasons: string[] } {
  const reasons: string[] = [];
  const before = website;
  const resolved = resolveWebsiteWithPrimaryEmailDomain(website, emails) ?? undefined;

  if (!before && resolved) {
    reasons.push(`sito inferito da dominio email: ${resolved}`);
  } else if (before && resolved && validateWebsite(before) !== resolved) {
    reasons.push(`sito allineato a dominio email: ${before} → ${resolved}`);
  }

  return { website: resolved, reasons };
}

interface BrandHint {
  key: string;
  display: string;
  reliability: number;
}

function formatBrandToken(token: string): string {
  if (!token) return '';
  if (token.includes('-')) {
    return token
      .split('-')
      .map((part) => capitalizeWord(part))
      .join('-');
  }
  return capitalizeWord(token);
}

function collectBrandHints(emails: string[], website?: string): BrandHint[] {
  const hints: BrandHint[] = [];
  const email = pickPersonalEmail(emails) || emails[0];
  if (!email?.includes('@')) return hints;

  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const domain = email.split('@')[1]?.toLowerCase() ?? '';

  if (local.length >= 3 && !isGenericEmailLocalPart(email)) {
    hints.push({
      key: normalizeComparableKey(local),
      display: formatBrandToken(local),
      reliability: GENERIC_MAILBOX_DOMAINS.has(domain) ? 3 : 2,
    });
  }

  if (!isGenericProviderDomain(domain)) {
    const host = domain.split('.')[0] ?? '';
    if (host.length >= 3) {
      hints.push({
        key: normalizeComparableKey(host),
        display: formatBrandToken(host),
        reliability: 3,
      });
    }
  }

  const webRoot = websiteHostRoot(website);
  if (webRoot) {
    hints.push({
      key: normalizeComparableKey(webRoot),
      display: formatBrandToken(webRoot),
      reliability: 2,
    });
  }

  return hints;
}

function resolveMostProbableBrandWord(word: string, hints: BrandHint[]): string {
  const key = normalizeComparableKey(word);
  let bestDisplay = word;
  let bestScore = 0;

  for (const hint of hints) {
    if (!keysPlausiblySame(key, hint.key)) continue;
    const dist = levenshteinDistance(key, hint.key);
    const score = hint.reliability * 10 - dist;
    if (score > bestScore) {
      bestScore = score;
      bestDisplay = hint.display;
    }
  }

  return bestScore > 0 ? bestDisplay : word;
}

/**
 * Corregge la grafia del primo token azienda usando indizi da email/sito (similarità generica).
 */
export function reconcileCompanySpelling(
  company: string,
  emails: string[],
  website?: string
): { company: string; reasons: string[] } {
  const reasons: string[] = [];
  if (!company.trim()) return { company, reasons };
  if (hasLegalFormSuffix(company) && stripLegalFormSuffix(company).split(/\s+/).filter(Boolean).length >= 2) {
    return { company, reasons };
  }

  const hints = collectBrandHints(emails, website);
  if (!hints.length) return { company, reasons };

  const words = company.trim().split(/\s+/);
  const firstWord = words[0] ?? company;
  const firstKey = normalizeComparableKey(firstWord);
  const hasSimilarHint = hints.some((h) => keysPlausiblySame(firstKey, h.key));
  if (!hasSimilarHint) return { company, reasons };

  const fixedFirst = resolveMostProbableBrandWord(firstWord, hints);
  if (fixedFirst !== firstWord) {
    reasons.push(`azienda: grafia corretta "${firstWord}" → "${fixedFirst}"`);
  }
  const rest = words.slice(1).join(' ');
  return { company: rest ? `${fixedFirst} ${rest}` : fixedFirst, reasons };
}

function companyNeedsEnrichment(company: string): boolean {
  if (!company.trim()) return true;
  if (isIsolatedLegalFormOnly(company)) return true;
  if (isLikelyIndustryAcronymLine(company)) return true;
  return stripLegalFormSuffix(company).trim().length < 4;
}

function chooseSplitCompanyOverFused(
  currentCompany: string,
  candidates: ScoredCandidate<string>[] | undefined,
  emails: string[],
  website?: string
): string {
  if (!currentCompany || !candidates?.length) return currentCompany;
  const currentWords = stripLegalFormSuffix(currentCompany).trim().split(/\s+/).filter(Boolean);
  if (currentWords.length !== 1 || hasLegalFormSuffix(currentCompany)) return currentCompany;

  const emailDomainRoot = (pickPersonalEmail(emails).split('@')[1] ?? '').split('.')[0] ?? '';
  const websiteRoot = websiteHostRoot(website) ?? '';
  const hintKey = normalizeComparableKey(emailDomainRoot || websiteRoot);
  const currentKey = normalizeComparableKey(currentWords[0] ?? '');
  if (!hintKey || !keysPlausiblySame(currentKey, hintKey)) return currentCompany;

  const splitCandidate = candidates
    .map((c) => String(c.value ?? '').trim())
    .filter((value) => {
      if (!value || hasLegalFormSuffix(value)) return false;
      const words = stripLegalFormSuffix(value).trim().split(/\s+/).filter(Boolean);
      if (words.length < 2) return false;
      const key = normalizeComparableKey(stripLegalFormSuffix(value));
      return key.includes(hintKey) || hintKey.includes(key) || keysPlausiblySame(key, hintKey);
    })
    .sort((a, b) => b.length - a.length)[0];

  return splitCandidate || currentCompany;
}

/**
 * Migliora la company selezionata usando candidati draft, re-estrazione e hint email/sito.
 * Non distruttivo: preferisce forme con ragione sociale completa e marchio coerente.
 */
export function reconcileCompanySelection(
  company: string,
  draftCompanies: ScoredCandidate<string>[] | undefined,
  lines: Array<{ text: string; lineIndex: number }>,
  emails: string[],
  website?: string,
  rawText?: string,
  firstName?: string,
  lastName?: string
): { company: string; reasons: string[] } {
  const reasons: string[] = [];
  let result = company.trim();

  let selectedLayout: ScoredCandidate<string> | undefined;
  let protectLayout = false;
  let layoutLockedValue = '';

  const directProtection = shouldProtectLayoutSelection(result, draftCompanies);
  if (directProtection.protect && directProtection.anchor) {
    selectedLayout = directProtection.anchor;
    layoutLockedValue = String(selectedLayout.value ?? '').trim();
    protectLayout = true;
    result = layoutLockedValue;
    reasons.push('layout: selezione layout preservata');
  } else {
    const fuzzyLayout = findMatchingLayoutCandidate(result, draftCompanies);
    if (fuzzyLayout) {
      const restored = restoreLayoutSelectionIfMutated(result, fuzzyLayout, emails, website, reasons);
      if (restored !== result) {
        result = restored;
        const restoredProtection = shouldProtectLayoutSelection(result, draftCompanies);
        if (restoredProtection.protect && restoredProtection.anchor) {
          selectedLayout = restoredProtection.anchor;
        } else {
          selectedLayout = fuzzyLayout;
        }
        layoutLockedValue = String(selectedLayout.value ?? '').trim();
        if (layoutLockedValue && !isClearlyUnusableCompany(layoutLockedValue)) {
          protectLayout = true;
          result = layoutLockedValue;
          reasons.push('layout: selezione layout ripristinata');
        }
      }
    }
  }

  const layoutAnchor = selectedLayout;

  if (!result && firstName?.trim() && lastName?.trim()) {
    const email = pickPersonalEmail(emails) || emails[0];
    if (email?.includes('@')) {
      const local = email.split('@')[0] ?? '';
      const domain = email.split('@')[1] ?? '';
      if (
        isPersonalEmailLocalPart(local, firstName, lastName) &&
        isGenericProviderDomain(domain)
      ) {
        return { company: '', reasons };
      }
    }
  }

  if (draftCompanies?.length) {
    const preferred = pickPreferredCompanyValue(draftCompanies);
    const preferredCandidate =
      findDraftCandidateForValue(draftCompanies, preferred) ?? draftCompanies[0];

    let allowPreferred = !protectLayout;
    if (protectLayout && layoutAnchor && preferred) {
      const decision = shouldAllowPreferredOverProtectedLayout(
        result,
        preferred,
        preferredCandidate,
        layoutAnchor
      );
      allowPreferred = decision.allow;
      if (decision.reason) reasons.push(decision.reason);
    }

    if (allowPreferred && preferred) {
      const preferredRank = rankCompanyCandidate(preferredCandidate);
      const currentCandidate: ScoredCandidate<string> = layoutAnchor ?? {
        value: result,
        score: 0,
        features: {},
        sourceLineIndices: [],
        extractor: 'current',
        rawText: result,
      };
      const currentRank = result ? rankCompanyCandidate(currentCandidate) : -2;

      if (
        preferred !== result &&
        (companyNeedsEnrichment(result) ||
          (hasLegalFormSuffix(preferred) && !hasLegalFormSuffix(result)) ||
          preferredRank > currentRank + 0.05)
      ) {
        result = preferred;
        if (!reasons.some((r) => r.startsWith('layout'))) {
          reasons.push(`azienda preferita da candidati: "${preferred}"`);
        }
      }
    }

    const blockDomainSplit = protectLayout && layoutHasSeparatedBrand(result);
    if (!blockDomainSplit) {
      const splitPreferred = chooseSplitCompanyOverFused(result, draftCompanies, emails, website);
      if (splitPreferred !== result) {
        reasons.push(`azienda split da dominio/OCR preferita: "${splitPreferred}"`);
        result = splitPreferred;
      }
    } else {
      reasons.push('layout preservato: bloccato split dominio su brand separato');
    }
  }

  if ((!protectLayout || isClearlyUnusableCompany(result)) && !result.trim() && emails.length > 0) {
    const email = pickPersonalEmail(emails) || emails[0];
    const local = email?.split('@')[0]?.toLowerCase() ?? '';
    if (
      local.length >= 3 &&
      !isGenericEmailLocalPart(email) &&
      !isPersonalEmailLocalPart(local, firstName, lastName)
    ) {
      result = formatBrandToken(local);
      reasons.push(`marchio da email (azienda vuota): "${result}"`);
    }
  }

  const allowReextract =
    !protectLayout || isClearlyUnusableCompany(result) || companyNeedsEnrichment(result);
  if (allowReextract && companyNeedsEnrichment(result) && lines.length > 0) {
    const input = {
      lines: lines.map((l) => ({
        text: l.text,
        lineIndex: l.lineIndex,
        confidence: 0.8,
      })),
      rawText: rawText ?? lines.map((l) => l.text).join('\n'),
      repairedText: rawText ?? lines.map((l) => l.text).join('\n'),
    };
    const emailCandidates = emails.map((email, index) => ({
      value: email,
      sourceLineIndices: [index],
      extractor: 'reconcile-email',
      rawText: email,
      features: {},
    }));
    const extracted = extractCompanyCandidates(input, emailCandidates, website ? [website] : []);
    const scored = extracted.map((c) => ({ ...c, score: 0.5 })) as ScoredCandidate<string>[];
    const supplemental = pickPreferredCompanyValue(scored);
    if (supplemental) {
      if (protectLayout && layoutAnchor && isDescriptorOnlyCompany(supplemental)) {
        reasons.push(`layout preservato: bloccata re-estrazione descrittore-only "${supplemental}"`);
      } else if (!protectLayout || isClearlyUnusableCompany(result)) {
        result = supplemental;
        reasons.push(`azienda da re-estrazione testo: "${supplemental}"`);
      }
    }
  } else if (protectLayout && companyNeedsEnrichment(result)) {
    reasons.push('layout preservato: bloccata re-estrazione su selezione layout valida');
  }

  const blockEmailBrandMerge = protectLayout && layoutHasSeparatedBrand(result);
  const email = pickPersonalEmail(emails);
  if (!blockEmailBrandMerge && email) {
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    if (local.length >= 3 && !isGenericEmailLocalPart(email) && !isPersonalEmailLocalPart(local, firstName, lastName)) {
      const brandKey = normalizeComparableKey(local);
      const companyKey = normalizeComparableKey(stripLegalFormSuffix(result));
      const domainRoot = email.split('@')[1]?.split('.')[0] ?? '';
      const domainKey = normalizeComparableKey(domainRoot);
      const alignsWithDomain =
        keysPlausiblySame(brandKey, domainKey) ||
        domainKey.includes(brandKey) ||
        brandKey.includes(domainKey);
      if (brandKey.length >= 4 && !companyKey.includes(brandKey) && alignsWithDomain) {
        const taglineLike =
          !result ||
          /^[A-ZÀ-Ü][A-ZÀ-Ü&\s]{4,}$/.test(result) ||
          result.split(/\s+/).every((w) => w === w.toUpperCase());
        if (taglineLike) {
          result = `${formatBrandToken(local)} ${result}`.replace(/\s+/g, ' ').trim();
          reasons.push(`marchio da email aggiunto: "${formatBrandToken(local)}"`);
        }
      }
    }
  } else if (blockEmailBrandMerge) {
    reasons.push('layout preservato: bloccata fusione marchio da email');
  }

  if (protectLayout && layoutLockedValue) {
    reasons.push('layout preservato: bloccata grafia su selezione layout');
  } else {
    const spelling = reconcileCompanySpellingProtected(
      result,
      emails,
      website,
      layoutHasSeparatedBrand(result)
    );
    result = spelling.company;
    reasons.push(...spelling.reasons);
  }

  if (protectLayout && layoutAnchor && layoutLockedValue) {
    const altCandidate = findDraftCandidateForValue(draftCompanies ?? [], result);
    const allowedLegalForm =
      altCandidate &&
      isMuchBetterLegalFormAlternative(layoutLockedValue, layoutAnchor, result, altCandidate);
    if (
      !allowedLegalForm &&
      normalizeCompanyMatchKey(result) !== normalizeCompanyMatchKey(layoutLockedValue) &&
      (isDescriptorOnlyCompany(result) ||
        isDomainFusedBrandMutation(result, layoutAnchor, emails, website) ||
        !sharesLayoutBrandAnchor(result, layoutAnchor))
    ) {
      reasons.push(`layout ripristinato finale: "${layoutLockedValue}"`);
      result = layoutLockedValue;
    }
  }

  if (lastName?.trim() && result.trim()) {
    const words = result.trim().split(/\s+/);
    if (words.length === 2 && words[1].toLowerCase() === lastName.trim().toLowerCase()) {
      const hints = collectBrandHints(emails, website);
      const brandKey = normalizeComparableKey(words[0]);
      if (hints.some((h) => keysPlausiblySame(h.key, brandKey))) {
        result = words[0];
        reasons.push(`cognome rimosso dal marchio: "${words[0]}"`);
      }
    }
  }

  result = alignCompanyToEmailDomain(result, emails, rawText);
  result = sanitizeCompanyValue(result);

  return { company: result, reasons };
}

/**
 * Se la ragione sociale contiene un titolare ("di Nome Cognome …"), allinea il cognome OCR.
 */
export function reconcileNameWithCompany(
  firstName: string,
  lastName: string,
  company: string
): { firstName: string; lastName: string; reasons: string[] } {
  const reasons: string[] = [];
  if (!company || !firstName) return { firstName, lastName, reasons };

  const ownerMatch = company.match(
    /\bdi\s+(.+?)(?:\s*&\s*c\b\.?|\s+s\.?\s*a\.?\s*s\b|\s+s\.?\s*r\.?\s*l\b|\s+s\.?\s*n\.?\s*c\b|\s+snc\b|\s+sas\b|\s+srl\b|$)/i
  );
  if (!ownerMatch) return { firstName, lastName, reasons };

  const ownerWords = ownerMatch[1]
    .trim()
    .split(/\s+/)
    .filter((w) => /^[A-Za-zÀ-ü'`-]+$/.test(w));
  if (ownerWords.length < 2) return { firstName, lastName, reasons };

  const norm = (s: string) => s.toLowerCase().replace(/[^a-zà-ü]/g, '');
  const fnNorm = norm(firstName);
  if (!fnNorm) return { firstName, lastName, reasons };

  const firstIdx = ownerWords.findIndex((w) => {
    const wn = norm(w);
    return wn === fnNorm || (Math.abs(wn.length - fnNorm.length) <= 1 && levenshteinDistance(wn, fnNorm) <= 1);
  });
  if (firstIdx < 0) return { firstName, lastName, reasons };

  const correctedSurname = ownerWords.filter((_, i) => i !== firstIdx).map(capitalizeWord).join(' ');
  if (!correctedSurname) return { firstName, lastName, reasons };

  const lnNorm = norm(lastName);
  const surnameNorm = norm(correctedSurname);
  const closeEnough =
    !lnNorm ||
    lnNorm === surnameNorm ||
    (Math.abs(lnNorm.length - surnameNorm.length) <= 3 && levenshteinDistance(lnNorm, surnameNorm) <= 3);
  if (!closeEnough) return { firstName, lastName, reasons };

  if (correctedSurname !== lastName) {
    reasons.push(`cognome allineato da ragione sociale: "${lastName}" → "${correctedSurname}"`);
  }

  return {
    firstName: firstName || capitalizeWord(ownerWords[firstIdx]),
    lastName: correctedSurname,
    reasons,
  };
}

/**
 * Completa nome/cognome vuoti dalla local-part dell'email personale più plausibile.
 */
export function reconcileNameFromEmail(
  firstName: string,
  lastName: string,
  emails: string[]
): { firstName: string; lastName: string; reasons: string[] } {
  const reasons: string[] = [];
  if (firstName && lastName) return { firstName, lastName, reasons };

  const email = pickPersonalEmail(emails);
  if (!email) return { firstName, lastName, reasons };

  const parsed = parseNameFromEmailLocal(email);
  if (!parsed) return { firstName, lastName, reasons };

  let fn = firstName || parsed.firstName;
  let ln = lastName || parsed.lastName;

  if (!firstName && parsed.firstName) {
    reasons.push(`nome da email: "${parsed.firstName}"`);
  }
  if (!lastName && parsed.lastName) {
    reasons.push(`cognome da email: "${parsed.lastName}"`);
  }

  const valid = validatePersonName({ firstName: fn, lastName: ln });
  if (!valid) return { firstName, lastName, reasons };

  return { firstName: valid.firstName, lastName: valid.lastName, reasons };
}

/**
 * Se la ragione sociale è in realtà un nome persona (libero professionista),
 * sposta il testo su firstName/lastName e svuota company.
 */
export function reconcilePersonNameFromCompany(
  firstName: string,
  lastName: string,
  company: string
): { firstName: string; lastName: string; company: string; reasons: string[] } {
  const reasons: string[] = [];
  if (!company.trim() || hasLegalForm(company)) {
    return { firstName, lastName, company, reasons };
  }

  const parsed = parsePersonNameFromLine(company);
  if (!parsed) return { firstName, lastName, company, reasons };

  const norm = (s: string) => s.toLowerCase().replace(/[^a-zà-ü]/g, '');
  const parsedFull = norm(`${parsed.firstName} ${parsed.lastName}`);
  const companyNorm = norm(company);
  const currentFull = norm(`${firstName} ${lastName}`);

  const samePerson =
    companyNorm === parsedFull ||
    companyNorm === currentFull ||
    (firstName && norm(parsed.firstName) === norm(firstName) &&
      (norm(parsed.lastName) === norm(lastName) ||
        norm(parsed.lastName) === norm(lastName).replace(/\s/g, '')));

  if (!samePerson && firstName && lastName) {
    return { firstName, lastName, company, reasons };
  }

  const fn = firstName || parsed.firstName;
  const ln =
    lastName && parsed.lastName && parsed.lastName.includes(' ') && !lastName.includes(' ')
      ? parsed.lastName
      : lastName || parsed.lastName;
  const valid = validatePersonName({ firstName: fn, lastName: ln });
  if (!valid) return { firstName, lastName, company, reasons };

  reasons.push(`azienda rimossa (nome persona): "${company}"`);
  return {
    firstName: valid.firstName,
    lastName: valid.lastName,
    company: '',
    reasons,
  };
}

/**
 * Pipeline di riconciliazione generica post-selezione.
 */
export function reconcileSelection(
  selection: DraftSelection,
  context: ReconcileContext
): ReconciledFields {
  const reasons: string[] = [];

  let emails = selection.emails.map((e) => e.value).filter((v): v is string => Boolean(v));
  emails = reconcileEmailsWithCardContext(emails, context.rawText);
  reasons.push(`email riconciliate (testo): ${emails.length} valide`);

  let website = selection.website?.value;
  const websiteResult = reconcileWebsiteWithEmail(website, emails);
  website = websiteResult.website;
  reasons.push(...websiteResult.reasons);

  emails = reconcileEmailsWithCardContext(emails, context.rawText, website, context.company);
  reasons.push(`email riconciliate (contesto): ${emails.length} valide`);

  let company = selection.company?.value ?? '';
  const companyResult = reconcileCompanySpelling(company, emails, website);
  company = companyResult.company;
  reasons.push(...companyResult.reasons);

  let firstName = selection.firstName?.value ?? '';
  let lastName = selection.lastName?.value ?? '';

  const emailName = reconcileNameFromEmail(firstName, lastName, emails);
  firstName = emailName.firstName;
  lastName = emailName.lastName;
  reasons.push(...emailName.reasons);

  const companyName = reconcilePersonNameFromCompany(firstName, lastName, company);
  firstName = companyName.firstName;
  lastName = companyName.lastName;
  company = companyName.company;
  reasons.push(...companyName.reasons);

  const nameResult = reconcileNameWithCompany(firstName, lastName, company);
  firstName = nameResult.firstName;
  lastName = nameResult.lastName;
  reasons.push(...nameResult.reasons);

  const phones = selection.phones
    .map((p) => p.value)
    .filter((v): v is Phone => Boolean(v));

  return {
    firstName,
    lastName,
    company,
    emails,
    phones,
    website,
    reasons,
  };
}

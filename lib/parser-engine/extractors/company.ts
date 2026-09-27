import type { Candidate, FeatureVector, NormalizedInput } from '../types';
import type { BlockDetectionResult, LayoutBlock, LayoutLine } from '../layout/types';
import { isAllCaps, isTitleCase, tokenize } from '../normalize/tokens';
import {
 buildBrandRepetitionScores,
 combineBrandFragments,
 hasCompanyDescriptorInText,
 hasLegalFormDomainEvidence,
 isDescriptiveActivityLine,
 isDisqualifiedCompanyText,
 isDisqualifiedCompanyValue,
 isRoleOnlyCompanyValue,
 looksLikeAddressOrLocationLine,
 repetitionBonusForCompany,
} from '../scoring/features';
import {
 COMPANY_DESCRIPTOR_WORDS,
 FIRM_SUFFIX_WORDS,
 fixBareDiConnector,
 hasLegalForm,
 hasLegalFormSuffix,
 isCompanyNoiseLine,
 isLikelyIndustryAcronymLine,
 isIsolatedLegalFormOnly,
 isStandaloneFirmSuffixWord,
 isSuffixOnlyCompany,
 levenshteinDistance,
 normalizeBrandKey,
 normalizeLegalFormOcr,
 stripLegalFormSuffix,
} from '../validators/dictionaries';
import { isPlausiblePersonNameLine } from '../validators/name';
import { isRejectedCompanyValue, sanitizeCompanyValue } from '../validators/company';
import { isGenericEmailLocalPart } from './email';
import { isGenericProviderDomain } from './website';

const EXTRACTOR = 'company';
const LAYOUT_EXTRACTOR = 'company:layout';

function positionRank(lineIndex: number, lineCount: number): number {
 if (lineCount <= 1) return 0.5;
 return 1 - lineIndex / (lineCount - 1);
}

function digitCount(value: string): number {
 return value.replace(/\D/g, '').length;
}

function lineFeatures(
 line: { text: string; confidence: number; lineIndex: number },
 lineCount: number,
 extra: FeatureVector = {}
): FeatureVector {
 const text = line.text;
 return {
 positionRank: positionRank(line.lineIndex, lineCount),
 lineLength: text.length,
 confidenceOcr: line.confidence,
 hasLegalForm: hasLegalForm(text),
 isAllCaps: isAllCaps(text),
 isTitleCase: isTitleCase(text),
 tokenCount: tokenize(text).length,
 hasEmailPattern: /@/.test(text),
 hasAddressPattern: looksLikeAddressOrLocationLine(text),
 hasCatalogKeyword: isDisqualifiedCompanyText(text) || isDisqualifiedCompanyValue(text),
 ...extra,
 };
}

function makeCandidate(
 value: string,
 sourceLineIndices: number[],
 rawText: string,
 features: FeatureVector,
 extractor: string = EXTRACTOR
): Candidate<string> | null {
 const cleaned = sanitizeCompanyValue(value);
 if (!cleaned || isRejectedCompanyValue(cleaned)) return null;
 return { value: cleaned, sourceLineIndices, extractor, rawText, features };
}

function normalizeComparableKey(value: string): string {
 return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function collectDomainRoots(emailCandidates: Candidate<string>[], websiteHints: string[]): string[] {
 const roots = new Set<string>();
 for (const email of emailCandidates) {
 const domain = email.value.split('@')[1]?.toLowerCase();
 if (!domain || isGenericProviderDomain(domain)) continue;
 const root = domain.split('.')[0];
 if (root && root.length >= 3) roots.add(root);
 }
 for (const site of websiteHints) {
 const host = site.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]?.toLowerCase();
 if (!host || isGenericProviderDomain(host)) continue;
 const root = host.split('.')[0];
 if (root && root.length >= 3) roots.add(root);
 }
 return [...roots];
}

function computeDomainMatchScores(
 company: string,
 domainRoots: string[]
): Pick<FeatureVector, 'emailDomainMatch' | 'websiteDomainMatch'> {
 if (!domainRoots.length) return {};
 const brand = stripLegalFormSuffix(company).trim();
 const words = tokenize(brand);
 const firstWord = words[0] ?? brand;
 const brandKey = normalizeComparableKey(firstWord);
 const fullKey = normalizeComparableKey(brand);
 let best = 0;
 for (const root of domainRoots) {
 const rootKey = normalizeComparableKey(root);
 if (!rootKey) continue;
 if (fullKey === rootKey || fullKey.includes(rootKey) || rootKey.includes(fullKey) || brandKey === rootKey) {
 best = 1;
 break;
 }
 if (fullKey.length >= 5 && rootKey.length >= 5) {
  const overlap = Math.min(fullKey.length, rootKey.length);
  if (fullKey.slice(0, overlap) === rootKey.slice(0, overlap) && overlap >= 5) {
   best = Math.max(best, 0.92);
  }
 }
 const dist = levenshteinDistance(brandKey, rootKey);
 if (dist > 0 && dist <= 2 && Math.abs(brandKey.length - rootKey.length) <= 2) {
 best = Math.max(best, 0.75);
 }
 const fullDist = levenshteinDistance(fullKey, rootKey);
 if (fullDist > 0 && fullDist <= 2 && Math.abs(fullKey.length - rootKey.length) <= 2) {
 best = Math.max(best, 0.9);
 }
 }
 if (best <= 0) return {};
 return { emailDomainMatch: best, websiteDomainMatch: best };
}

function isProminentCompanyLine(text: string): boolean {
 const t = text.trim();
 if (!t || t.length < 2 || t.length > 120) return false;
 if (isStandaloneFirmSuffixWord(t) || isSuffixOnlyCompany(t) || isRoleOnlyCompanyValue(t)) return false;
 if (isCompanyNoiseLine(t) || isDisqualifiedCompanyValue(t) || isPlausiblePersonNameLine(t)) return false;
 if (isDescriptiveActivityLine(t)) return false;
 if (hasLegalForm(t)) return true;
 const words = tokenize(t);
 if (words.length < 1 || words.length > 8) return false;
 if (isAllCaps(t) && words.length <= 8) return true;
 if ((isTitleCase(t) || isAllCaps(t)) && words.length >= 2) {
 if (hasLegalForm(t) || hasCompanyDescriptorInText(t)) return true;
 if (words.length <= 4 && words.every((w) => /^[A-Za-zÀ-ü][A-Za-zÀ-ü0-9&.'`-]*$/.test(w))) return true;
 }
 if (words.length >= 2 && words.length <= 8) {
 return words.some((w) => COMPANY_DESCRIPTOR_WORDS.has(w.toLowerCase().replace(/[.,]/g, '')));
 }
 return false;
}

function isPlausibleBrandContinuation(text: string): boolean {
 const t = text.trim().replace(/\s+/g, ' ');
 if (!t || t.length > 45 || /@/.test(t) || digitCount(t) >= 4) return false;
 if (isCompanyNoiseLine(t) || isDisqualifiedCompanyValue(t) || isPlausiblePersonNameLine(t) || looksLikeAddressOrLocationLine(t)) return false;
 const words = t.split(/\s+/).filter(Boolean);
 // Un singolo token interamente minuscolo sotto un logo è quasi sempre
 // rumore OCR/decorativo, non il secondo frammento della ragione sociale.
 // I brand reali spezzati conservano almeno una maiuscola, un simbolo o più
 // parole (es. "Up Trail", "& Maule").
 if (words.length === 1 && /^[a-zà-öø-ÿ]{3,}$/i.test(t) && t === t.toLowerCase()) return false;
 return words.length >= 1 && words.length <= 4;
}

/**
 * OCR can read the final `I.` of an uppercase domain-style brand as `LL`
 * (for example `BRANDLLNET`).  This is intentionally narrow: it only repairs
 * one compact, all-caps brand token immediately followed by a known TLD.
 */
function normalizeOcrDomainStyleBrand(text: string): string | null {
 const compact = text.trim().replace(/\s+/g, '');
 const doubledL = compact.match(/^([A-Z0-9][A-Z0-9-]{2,})LL(NET|COM|ORG|IT|EU)$/);
 if (doubledL) return `${doubledL[1]}I.${doubledL[2]}`;
 const direct = compact.match(/^([A-Z0-9][A-Z0-9-]{2,})(?:I|L|1)[._-](NET|COM|ORG|IT|EU)$/);
 if (direct) return `${direct[1]}I.${direct[2]}`;
 return null;
}

function isPlausibleCompanyTagline(text: string): boolean {
 const t = text.trim();
 if (!t || t.length > 55 || isCompanyNoiseLine(t) || isPlausiblePersonNameLine(t) || looksLikeAddressOrLocationLine(t)) return false;
 if (/@/.test(t) || digitCount(t) >= 4 || /^(via|viale|piazza|corso|galleria|vicolo)\b/i.test(t)) return false;
 return true;
}

function matchFirmSuffixWord(fragment: string): string | undefined {
 const compact = fragment.toUpperCase().replace(/[^A-Z]/g, '');
 if (compact.length < 5) return undefined;
 for (const word of FIRM_SUFFIX_WORDS) {
 if (compact === word) return word;
 if (Math.abs(compact.length - word.length) <= 2 && levenshteinDistance(compact, word) <= 2) return word;
 }
 return undefined;
}

function collectFirmSuffixWords(lines: NormalizedInput['lines'], fromIdx: number): string[] {
 const suffixWords: string[] = [];
 for (let k = fromIdx; k < Math.min(fromIdx + 6, lines.length); k++) {
 const candidate = lines[k].text.trim();
 if (!candidate || /@/.test(candidate) || digitCount(candidate) >= 3) break;
 const bareLetters = candidate.toUpperCase().replace(/[^A-Z]/g, '');
 if (!bareLetters || /^(E|ED|AND)$/.test(bareLetters)) continue;
 const word = matchFirmSuffixWord(candidate);
 if (!word) break;
 suffixWords.push(word);
 }
 return suffixWords;
}
function inferSplitBrandFromDomain(domainRoot: string, lines: NormalizedInput['lines']): string | null {
 const domainKey = normalizeBrandKey(domainRoot);
 if (domainKey.length < 6) return null;
 const compactLines = lines.map((line) => ({
 lineIndex: line.lineIndex,
 text: line.text.trim(),
 key: normalizeBrandKey(line.text.trim().replace(/^&\s*/, '')),
 hasAmpPrefix: /^&\s*[A-Za-zÀ-ü]/.test(line.text.trim()),
 }));
 const findBestSupport = (target: string) => {
 let best: { text: string; lineIndex: number; hasAmpPrefix: boolean; score: number } | null = null;
 for (const line of compactLines) {
 if (!line.key || line.key.length < 3) continue;
 const starts = target.startsWith(line.key) || line.key.startsWith(target);
 const fuzzy = !starts && Math.abs(line.key.length - target.length) <= 2 && levenshteinDistance(line.key, target) <= 2;
 if (!starts && !fuzzy) continue;
 const score = starts ? 2 : 1;
 if (!best || score > best.score || (score === best.score && line.key.length > normalizeBrandKey(best.text).length)) {
 best = { text: line.text.replace(/^&\s*/, '').trim(), lineIndex: line.lineIndex, hasAmpPrefix: line.hasAmpPrefix, score };
 }
 }
 return best;
 };
 for (let splitAt = 3; splitAt <= domainKey.length - 3; splitAt++) {
 const left = domainKey.slice(0, splitAt);
 const right = domainKey.slice(splitAt);
 const leftSupport = findBestSupport(left);
 const rightSupport = findBestSupport(right);
 if (!leftSupport || !rightSupport || leftSupport.lineIndex === rightSupport.lineIndex) continue;
 if (isDisqualifiedCompanyValue(leftSupport.text) || isSuffixOnlyCompany(leftSupport.text) || isRoleOnlyCompanyValue(leftSupport.text)) continue;
 if (isDisqualifiedCompanyValue(rightSupport.text) || isSuffixOnlyCompany(rightSupport.text) || isRoleOnlyCompanyValue(rightSupport.text)) continue;
 const joiner = rightSupport.hasAmpPrefix ? ' & ' : ' ';
 let company = `${leftSupport.text}${joiner}${rightSupport.text}`.replace(/\s+/g, ' ').trim();
 const suffixWords = collectFirmSuffixWords(lines, Math.max(leftSupport.lineIndex, rightSupport.lineIndex) + 1);
 if (suffixWords.length) company += ` ${suffixWords.join(' ')}`;
 return company;
 }
 for (let i = 0; i < lines.length; i++) {
 const lineKey = normalizeBrandKey(lines[i].text.trim());
 if (lineKey.length < 3 || !domainKey.startsWith(lineKey)) continue;
 const remainder = domainKey.slice(lineKey.length);
 if (remainder.length < 3) continue;
 for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
 const otherRaw = lines[j].text.trim().replace(/^&\s*/, '');
 if (!otherRaw || /@/.test(otherRaw) || digitCount(otherRaw) >= 4) continue;
 const otherKey = normalizeBrandKey(otherRaw);
 const exact = remainder.startsWith(otherKey) || otherKey.startsWith(remainder);
 const fuzzy = !exact && otherKey.length >= 3 && Math.abs(otherKey.length - remainder.length) <= 1 && levenshteinDistance(otherKey, remainder) <= 2;
 if (exact || fuzzy) {
 let company = `${lines[i].text.trim()} & ${otherRaw.replace(/^&\s*/, '')}`;
 const suffixWords = collectFirmSuffixWords(lines, j + 1);
 if (suffixWords.length) company += ` ${suffixWords.join(' ')}`;
 return company;
 }
 }
 }
 return null;
}

function mergeAdjacentUpperTokens(lines: NormalizedInput['lines']): string[] {
 const results: string[] = [];
 let buffer: string[] = [];
 const flush = () => {
 if (buffer.length === 0) return;
 const joined = buffer.map((part) => part.trim()).filter(Boolean).reduce((acc, part) => {
 if (part === '&' || part === 'E') return acc ? `${acc} &` : '&';
 if (acc.endsWith('&') || acc.endsWith('& ')) return `${acc} ${part}`.replace(/\s+/g, ' ').trim();
 return acc ? `${acc} ${part}` : part;
 }, '');
 const cleaned = joined.replace(/\s+/g, ' ').trim();
 if (cleaned && cleaned.replace(/&/g, '').trim().length >= 2 && !isDisqualifiedCompanyValue(cleaned)) {
 results.push(cleaned);
 }
 buffer = [];
 };
 for (const line of lines) {
 const t = line.text.trim();
 const tokenish = /^[A-ZÀ-Ü0-9&][A-ZÀ-Ü0-9&.'`-]{0,30}$/.test(t) || t === '&' || /^&\s*\w+$/i.test(t);
 if (tokenish && t.length <= 35 && buffer.length < 3 && !/@/.test(t) && !/^\d{5,}$/.test(t) && !matchFirmSuffixWord(t) && !isDisqualifiedCompanyValue(t)) {
 buffer.push(t);
 continue;
 }
 flush();
 if (isProminentCompanyLine(t)) results.push(t);
 }
 flush();
 return results;
}

function linesCoverDomainBrand(domainRoot: string, lines: NormalizedInput['lines']): boolean {
 const dk = normalizeBrandKey(domainRoot);
 if (dk.length < 6) return false;
 const keys = lines.map((l) => normalizeBrandKey(l.text.trim())).filter((k) => k.length >= 3 && k.length <= 24);
 for (const lk of keys) {
 if (lk === dk) return true;
 if (dk.startsWith(lk)) {
 const rem = dk.slice(lk.length);
 if (rem.length >= 3 && keys.some((k) => k === rem || levenshteinDistance(k, rem) <= 1)) return true;
 }
 }
 for (let i = 0; i < keys.length; i++) {
 for (let j = i + 1; j < keys.length; j++) {
 if (keys[i] + keys[j] === dk || keys[j] + keys[i] === dk) return true;
 }
 }
 return false;
}

function hasDomainEvidenceInLines(domainRoot: string, lines: NormalizedInput['lines']): boolean {
 const dk = normalizeBrandKey(domainRoot);
 if (dk.length < 5) return false;
 return lines.some((line) => {
 const key = normalizeBrandKey(line.text.trim().replace(/^&\s*/, ''));
 if (key.length < 3 || isDisqualifiedCompanyValue(line.text.trim())) return false;
 return dk.includes(key) || key.includes(dk) || (Math.abs(dk.length - key.length) <= 2 && levenshteinDistance(dk, key) <= 2);
 });
}

function extractLegalFormCompanies(lines: NormalizedInput['lines']): string[] {
 const results: string[] = [];
 for (let i = 0; i < lines.length; i++) {
 const raw = normalizeLegalFormOcr(lines[i].text.trim().replace(/\s+/g, ' '));
 if (!raw || !hasLegalFormSuffix(raw) || /@/.test(raw) || digitCount(raw) >= 6) continue;
 let company = raw;
 if (/^e\s+/i.test(raw) && i > 0) {
 const prev = normalizeLegalFormOcr(lines[i - 1].text.trim());
 if (prev && isProminentCompanyLine(prev) && !isPlausiblePersonNameLine(prev)) {
 company = `${prev} ${raw}`.replace(/\s+/g, ' ');
 }
 } else {
 const prefixParts: string[] = [];
 for (let back = 1; back <= 5 && i - back >= 0; back++) {
 const prevRaw = lines[i - back].text.trim().replace(/\s+/g, ' ');
 if (!prevRaw || hasLegalFormSuffix(prevRaw) || /@/.test(prevRaw) || digitCount(prevRaw) >= 4 || isPlausiblePersonNameLine(prevRaw) || isLikelyIndustryAcronymLine(prevRaw) || prevRaw.length > 50) break;
 prefixParts.unshift(prevRaw);
 if (!/^e\s+/i.test(raw) && !/^e\s+/i.test(prevRaw)) break;
 }
 if (prefixParts.length) company = `${prefixParts.join(' ')} ${company}`.replace(/\s+/g, ' ');
 }
 if (!isDisqualifiedCompanyValue(company)) results.push(fixBareDiConnector(company));
 }
 for (let i = 0; i < lines.length; i++) {
 const raw = lines[i].text.trim();
 if (!isIsolatedLegalFormOnly(raw) || i === 0) continue;
 const prev = lines[i - 1].text.trim();
 if (!prev || isDisqualifiedCompanyValue(prev)) continue;
 const merged = `${prev} ${normalizeLegalFormOcr(raw)}`.replace(/\s+/g, ' ').trim();
 if (!isDisqualifiedCompanyValue(merged)) results.push(merged);
 }
 return results;
}

function enrichWithContinuations(company: string, lineIndex: number, lines: NormalizedInput['lines']): string {
 let result = company.trim();
 const ownDomainBrand = normalizeOcrDomainStyleBrand(result);
 if (ownDomainBrand) return ownDomainBrand;
 if (result.split(/\s+/).length === 1) {
 const next = lines[lineIndex + 1]?.text.trim();
 const prev = lines[lineIndex - 1]?.text.trim();
 const nextDomainBrand = next ? normalizeOcrDomainStyleBrand(next) : null;
 const prevDomainBrand = prev ? normalizeOcrDomainStyleBrand(prev) : null;
 // A compact domain-style brand is self-contained.  Never glue it to a
 // neighbouring vertical slogan or school/department descriptor.
 if (nextDomainBrand) {
 result = nextDomainBrand;
 } else if (prevDomainBrand) {
 result = prevDomainBrand;
 } else if (next && isPlausibleBrandContinuation(next)) {
 result = combineBrandFragments(result, next.replace(/^&(?=\S)/, '& '));
 const suffixWords = collectFirmSuffixWords(lines, lineIndex + 2);
 if (suffixWords.length) result += ` ${suffixWords.join(' ')}`;
 } else if (prev && isPlausibleBrandContinuation(prev)) {
 result = combineBrandFragments(prev, result);
 } else if (next && isPlausibleCompanyTagline(next)) {
 result = `${result} ${next}`;
 }
 }
 return fixBareDiConnector(result);
}

function companyFromEmailDomain(email: string): string | null {
 if (isGenericEmailLocalPart(email)) return null;
 const domain = email.split('@')[1]?.toLowerCase();
 if (!domain || isGenericProviderDomain(domain)) return null;
 const root = domain.split('.')[0] ?? '';
 if (root.length < 3) return null;
 return root.charAt(0).toUpperCase() + root.slice(1);
}

function dedupeKey(company: string): string {
 return stripLegalFormSuffix(company).toLowerCase().replace(/\s+/g, ' ').trim();
}

const NON_COMPANY_LAYOUT_KINDS = new Set(['address', 'contact', 'tax', 'noise']);

/** Token marchio con OCR fused (es. ABellotto) — non nome persona. */
function looksLikeOcrFusedBrandToken(text: string): boolean {
 const t = text.trim();
 if (!t || t.length < 4 || t.length > 32) return false;
 if (!/^[A-ZÀ-Ü][a-zà-ü]/.test(t)) return false;
 if (hasLegalForm(t) || hasLegalFormSuffix(t)) return false;
 return !isPlausiblePersonNameLine(t);
}

function isCoherentCompanyLine(text: string): boolean {
 const t = text.trim();
 if (!t || t.length < 2) return false;
 if (/@/.test(t) || digitCount(t) >= 6) return false;
 if (isCompanyNoiseLine(t) || looksLikeAddressOrLocationLine(t)) return false;
 if (isPlausiblePersonNameLine(t) && !hasLegalForm(t) && !looksLikeOcrFusedBrandToken(t)) return false;
 if (hasLegalForm(t) || hasLegalFormSuffix(t)) return true;
 if (looksLikeOcrFusedBrandToken(t)) return true;
 return (
  isProminentCompanyLine(t) ||
  /^[A-ZÀ-Ü&][A-ZÀ-Ü0-9&.'`-]{1,30}$/.test(t) ||
  /^[A-Za-zÀ-ü]{2,25}$/.test(t)
 );
}

function countCoherentCompanyLines(block: LayoutBlock): number {
 return block.lines.filter((line) => isCoherentCompanyLine(line.text)).length;
}

function hasPlausibleBrandToken(block: LayoutBlock): boolean {
 return blockHasPlausibleBrandAnchor(block);
}

function layoutBlockHasSalvageSignals(block: LayoutBlock): boolean {
 if (hasPlausibleBrandToken(block)) return true;
 if (block.features.hasLegalForm) return true;
 if (block.lines.some((line) => hasLegalForm(line.text) || hasLegalFormSuffix(line.text))) return true;
 if (countCoherentCompanyLines(block) >= 2) return true;
 return false;
}

function isLongCatalogOnlyBlock(block: LayoutBlock): boolean {
 const joined = joinCompanyBlockLines(block.lines);
 if (joined.length < 48) return false;
 if (!block.features.hasCatalogNoise) return false;
 return !hasPlausibleBrandToken(block) && !block.features.hasLegalForm;
}

function isPureContactLayoutBlock(block: LayoutBlock): boolean {
 const hasContact = block.features.hasEmail || block.features.hasPhone || block.features.hasWebsite;
 if (!hasContact) return false;
 return !layoutBlockHasSalvageSignals(block);
}

function evaluateLayoutCompanyBlock(block: LayoutBlock): { ok: boolean; reason: string } {
 if (NON_COMPANY_LAYOUT_KINDS.has(block.kind)) {
  return { ok: false, reason: `skip:kind=${block.kind}` };
 }
 if (block.kind !== 'company' || block.lines.length === 0) {
  return { ok: false, reason: 'skip:not-company-or-empty' };
 }
 if (isPureContactLayoutBlock(block)) {
  return { ok: false, reason: 'skip:pure-contact-block' };
 }
 if (
  block.features.hasAddressHints &&
  block.features.hasPostalCode &&
  !layoutBlockHasSalvageSignals(block)
 ) {
  return { ok: false, reason: 'skip:address-without-brand' };
 }
 if (isLongCatalogOnlyBlock(block)) {
  return { ok: false, reason: 'skip:long-catalog-no-brand' };
 }
 if (!layoutBlockHasSalvageSignals(block)) {
  return { ok: false, reason: 'skip:no-brand-legal-or-coherent-lines' };
 }
 if (block.features.hasCatalogNoise) {
  return { ok: true, reason: 'allow:catalogNoise+salvage-signals' };
 }
 return { ok: true, reason: 'allow:company-block' };
}

function isUsableLayoutCompanyBlock(block: LayoutBlock): boolean {
 return evaluateLayoutCompanyBlock(block).ok;
}

function layoutCandidateRawText(block: LayoutBlock, variantKind: string, blockReason: string): string {
 const anchor = block.lines[0]?.text.trim() ?? '';
 return `[layout:${block.id}|${variantKind}|${blockReason}|anchor=${anchor}] ${joinCompanyBlockLines(block.lines)}`;
}

function isMostlyDescriptorLine(text: string): boolean {
 const words = tokenize(stripLegalFormSuffix(text));
 if (!words.length) return true;
 const descriptorLike = words.filter((word) => {
 const key = word.toLowerCase().replace(/[.,'’`]/g, '');
 return COMPANY_DESCRIPTOR_WORDS.has(key) || /^(d'?interni|dinterni|progettazione)$/i.test(key);
 }).length;
 return descriptorLike >= words.length;
}

function blockHasPlausibleBrandAnchor(block: LayoutBlock): boolean {
 const brand = extractBrandPrefixFromBlock(block);
 if (!brand || brand.length < 2 || isSuffixOnlyCompany(brand) || isStandaloneFirmSuffixWord(brand)) return false;
 if (isMostlyDescriptorLine(brand) && block.lines.length <= 2 && !block.features.hasLegalForm) return false;
 if (isCompanyNoiseLine(brand) || isDisqualifiedCompanyValue(brand)) {
  if (!looksLikeOcrFusedBrandToken(brand.split(/\s+/)[0] ?? brand)) return false;
 }
 return true;
}

function sharesBrandAnchor(value: string, brand: string): boolean {
 const brandKey = normalizeComparableKey(stripLegalFormSuffix(brand));
 const valueKey = normalizeComparableKey(stripLegalFormSuffix(value));
 if (!brandKey || brandKey.length < 3) return true;
 if (valueKey.includes(brandKey) || brandKey.includes(valueKey)) return true;
 return tokenize(brand).map((word) => normalizeComparableKey(word)).filter((key) => key.length >= 3).some((key) => valueKey.includes(key));
}

function shouldRejectLayoutVariant(value: string, brand: string): boolean {
 if (!value || isCompanyNoiseLine(value) || isRoleOnlyCompanyValue(value) || looksLikeAddressOrLocationLine(value)) {
  return true;
 }
 if (isDisqualifiedCompanyValue(value) && !hasLegalForm(value) && !hasLegalFormSuffix(value)) return true;
 if (isMostlyDescriptorLine(value) && !hasLegalForm(value) && !hasLegalFormSuffix(value)) {
  if (!sharesBrandAnchor(value, brand)) return true;
 }
 return !sharesBrandAnchor(value, brand);
}

function joinCompanyBlockLines(lines: LayoutLine[]): string {
 let acc = '';
 for (const line of lines) {
 const part = line.text.trim().replace(/\s+/g, ' ');
 if (!part) continue;
 if (part === '&' || /^&\s*\S/.test(part)) {
 const token = part.replace(/^&\s*/, '').trim();
 acc = acc ? `${acc} &${token ? ` ${token}` : ''}`.trim() : token ? `& ${token}` : '&';
 continue;
 }
 acc = (acc.endsWith('&') || acc.endsWith(' &')) ? `${acc} ${part}`.replace(/\s+/g, ' ').trim() : (acc ? `${acc} ${part}` : part);
 }
 return fixBareDiConnector(acc.replace(/\s+/g, ' ').trim());
}

function extractBrandPrefixFromBlock(block: LayoutBlock): string {
 const parts: string[] = [];
 for (const line of block.lines) {
 const t = line.text.trim();
 if (!t || hasLegalFormSuffix(t) || hasLegalForm(t) || matchFirmSuffixWord(t) || /@/.test(t) || digitCount(t) >= 4 || isCompanyNoiseLine(t) || (isDisqualifiedCompanyValue(t) && !looksLikeOcrFusedBrandToken(t)) || parts.length >= 3) break;
 if (parts.length === 0 || isPlausibleBrandContinuation(t) || looksLikeOcrFusedBrandToken(t) || /^[A-ZÀ-Ü&][A-ZÀ-Ü0-9&.'`-]{0,28}$/.test(t) || /^[A-ZÀ-Ü][a-zà-ü]{2,20}$/.test(t)) {
 parts.push(t);
 continue;
 }
 break;
 }
 if (!parts.length) return block.lines[0]?.text.trim().replace(/^&\s*/, '') ?? '';
 return joinCompanyBlockLines(block.lines.filter((line) => parts.includes(line.text.trim())));
}

function blockLinesAsNormalized(block: LayoutBlock): NormalizedInput['lines'] {
 return block.lines.map((line) => ({ text: line.text, confidence: line.confidence, lineIndex: line.lineIndex }));
}

function collectDescriptorLines(block: LayoutBlock, brandLineCount: number): string[] {
 const descriptors: string[] = [];
 for (let i = brandLineCount; i < block.lines.length; i++) {
 const t = block.lines[i].text.trim();
 if (!t || hasLegalFormSuffix(t) || hasLegalForm(t) || matchFirmSuffixWord(t) || /@/.test(t) || digitCount(t) >= 4) continue;
 if (isPlausibleCompanyTagline(t) || hasCompanyDescriptorInText(t)) descriptors.push(t);
 }
 return descriptors;
}

function countBrandPrefixLines(block: LayoutBlock): number {
 let count = 0;
 for (const line of block.lines) {
 const t = line.text.trim();
 if (!t || hasLegalFormSuffix(t) || hasLegalForm(t) || matchFirmSuffixWord(t) || /@/.test(t) || digitCount(t) >= 4 || count >= 3) break;
 if (count === 0 || isPlausibleBrandContinuation(t) || looksLikeOcrFusedBrandToken(t) || /^[A-ZÀ-Ü&][A-ZÀ-Ü0-9&.'`-]{0,28}$/.test(t) || /^[A-ZÀ-Ü][a-zà-ü]{2,20}$/.test(t)) {
 count += 1;
 continue;
 }
 break;
 }
 return Math.max(1, count);
}

interface LayoutCompanyVariant {
 value: string;
 kind: string;
}

function generateLayoutCompanyVariants(block: LayoutBlock): LayoutCompanyVariant[] {
 const variants: LayoutCompanyVariant[] = [];
 const seen = new Set<string>();
 const add = (value: string, kind: string) => {
  const normalized = fixBareDiConnector(value.trim());
  if (!normalized || normalized.length < 2) return;
  const key = dedupeKey(normalized) || normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  variants.push({ value: normalized, kind });
 };

 if (!block.lines.length) return [];

 const brand = extractBrandPrefixFromBlock(block);
 if (brand) add(brand, 'brand-prefix');

 const fullJoin = joinCompanyBlockLines(block.lines);
 if (fullJoin && brand && !shouldRejectLayoutVariant(fullJoin, brand)) add(fullJoin, 'full-join');
 if (fullJoin && !brand && isCoherentCompanyLine(fullJoin)) add(fullJoin, 'full-join-no-brand');

 const brandLineCount = countBrandPrefixLines(block);
 const descriptors = collectDescriptorLines(block, brandLineCount);
 if (brand && descriptors.length) {
  const merged = fixBareDiConnector(`${brand} ${descriptors.join(' ')}`);
  if (!shouldRejectLayoutVariant(merged, brand)) add(merged, 'brand+descriptor');
 }

 for (const line of block.lines) {
  const legal = normalizeLegalFormOcr(line.text.trim());
  if (!hasLegalForm(legal) && !hasLegalFormSuffix(legal)) continue;
  if (brand) {
   const merged = fixBareDiConnector(`${brand} ${legal}`);
   if (!shouldRejectLayoutVariant(merged, brand)) add(merged, 'brand+legal-form');
  } else if (!shouldRejectLayoutVariant(legal, legal)) {
   add(legal, 'legal-form');
  }
 }

 const pseudoLines = blockLinesAsNormalized(block);
 const firstSuffixIdx = block.lines.findIndex((line) => matchFirmSuffixWord(line.text.trim()));
 if (brand && firstSuffixIdx >= 0) {
  const suffixWords = collectFirmSuffixWords(pseudoLines, firstSuffixIdx);
  if (suffixWords.length) {
   const merged = fixBareDiConnector(`${brand} ${suffixWords.join(' ')}`);
   if (!shouldRejectLayoutVariant(merged, brand)) add(merged, 'brand+firm-suffix');
  }
  const inlineSuffix = block.lines
   .slice(firstSuffixIdx)
   .map((line) => line.text.trim())
   .filter((t) => matchFirmSuffixWord(t))
   .join(' ');
  if (inlineSuffix) {
   const merged = fixBareDiConnector(`${brand} ${inlineSuffix}`);
   if (!shouldRejectLayoutVariant(merged, brand)) add(merged, 'brand+inline-suffix');
  }
 }

 if (!variants.length) {
  for (const line of block.lines) {
   const t = line.text.trim();
   if (!isCoherentCompanyLine(t)) continue;
   add(t, 'coherent-line');
  }
 }

 return variants;
}

function layoutBlockFeatures(
 block: LayoutBlock,
 lineCount: number,
 domainRoots: string[],
 repetition: Map<string, number>
): FeatureVector {
 const anchor = block.lines[0];
 const base = lineFeatures(
 { text: anchor.text, confidence: anchor.confidence, lineIndex: anchor.lineIndex },
 lineCount,
 {
 positionRank: Math.max(0, Math.min(1, 1 - block.features.verticalRank)),
 isAllCaps: block.features.avgUppercaseRatio >= 0.68,
 hasLegalForm: block.features.hasLegalForm,
 crossPageAgreement: 0.55,
 }
 );
 const joined = joinCompanyBlockLines(block.lines);
 const repBonus = repetitionBonusForCompany(joined, repetition);
 const domainScores = computeDomainMatchScores(joined, domainRoots);
 return { ...base, ...domainScores, crossPageAgreement: Math.max(base.crossPageAgreement ?? 0, repBonus, 0.55) };
}

export function extractLayoutCompanyCandidates(
 layout: BlockDetectionResult | undefined,
 input: NormalizedInput,
 emailCandidates: Candidate<string>[] = [],
 websiteHints: string[] = []
): Candidate<string>[] {
 if (!layout?.blocks.length) return [];
 const lineCount = input.lines.length;
 const domainRoots = collectDomainRoots(emailCandidates, websiteHints);
 const repetition = buildBrandRepetitionScores(input.lines);
 const candidates: Candidate<string>[] = [];
 for (const block of layout.blocks) {
  const usability = evaluateLayoutCompanyBlock(block);
  if (!usability.ok) continue;
  const sourceLineIndices = [...block.sourceLineIndices];
  const variants = generateLayoutCompanyVariants(block);
  const features = layoutBlockFeatures(block, lineCount, domainRoots, repetition);
  for (const variant of variants) {
   const value = variant.value;
   if (!value || value.length < 2 || isDisqualifiedCompanyValue(value)) continue;
   const candidate = makeCandidate(
     value,
     sourceLineIndices,
     layoutCandidateRawText(block, variant.kind, usability.reason),
     features,
     LAYOUT_EXTRACTOR
   );
   if (candidate) candidates.push(candidate);
  }
 }
 return candidates;
}

export function extractCompanyCandidates(
 input: NormalizedInput,
 emailCandidates: Candidate<string>[] = [],
 websiteHints: string[] = [],
 layout?: BlockDetectionResult
): Candidate<string>[] {
 const { lines } = input;
 const lineCount = lines.length;
 const seen = new Set<string>();
 const candidates: Candidate<string>[] = [];
 const domainRoots = collectDomainRoots(emailCandidates, websiteHints);
 const repetition = buildBrandRepetitionScores(lines);
 const legalCompanies = extractLegalFormCompanies(lines);
 const push = (
 company: string,
 sourceLineIndices: number[],
 rawText: string,
 line: { text: string; confidence: number; lineIndex: number },
 extra?: FeatureVector
 ) => {
 const value = fixBareDiConnector(company.trim());
 if (!value || value.length < 2 || isDisqualifiedCompanyValue(value)) return;
 const key = dedupeKey(value) || value.toLowerCase();
 if (seen.has(key)) return;
 seen.add(key);
 const repBonus = repetitionBonusForCompany(value, repetition);
 const domainScores = computeDomainMatchScores(value, domainRoots);
 const descriptivePenalty = isDescriptiveActivityLine(value)
  ? { hasCatalogKeyword: true, hasRoleKeyword: true }
  : {};
 const legalDomainBoost = hasLegalFormDomainEvidence(
  { ...domainScores, hasLegalForm: extra?.hasLegalForm ?? hasLegalForm(value) },
  value
 )
  ? { crossPageAgreement: 0.85, confidenceOcr: 0.95 }
  : {};
 const candidate = makeCandidate(value, sourceLineIndices, rawText, lineFeatures(line, lineCount, { ...domainScores, ...extra, ...descriptivePenalty, ...legalDomainBoost, crossPageAgreement: Math.max(extra?.crossPageAgreement ?? 0, repBonus, legalDomainBoost.crossPageAgreement ?? 0) }));
 if (candidate) candidates.push(candidate);
 };
 for (const legalCompany of legalCompanies) {
 const line = lines.find((l) => legalCompany.includes(l.text.trim())) ?? lines[0];
 if (line) push(legalCompany, [line.lineIndex], legalCompany, line, { hasLegalForm: true });
 }
 for (const line of lines) {
   const t = line.text.trim();
   if (!isProminentCompanyLine(t)) continue;
   const enriched = enrichWithContinuations(t, line.lineIndex, lines);
   push(enriched, [line.lineIndex], enriched, line);
   const suffix = matchFirmSuffixWord(t);
   if (suffix && line.lineIndex > 0) {
     const prev = lines.find((l) => l.lineIndex === line.lineIndex - 1);
     const prevText = prev?.text.trim() ?? '';
     if (prev && /^[A-ZÀ-Ü&][A-ZÀ-Ü0-9&.'`-]{0,30}$/.test(prevText) && !isSuffixOnlyCompany(prevText)) {
       const merged = `${prevText} ${t}`;
       if (!isSuffixOnlyCompany(merged)) push(merged, [prev.lineIndex, line.lineIndex], `${prev.text} ${t}`, line);
     }
   }
 }
 for (const merged of mergeAdjacentUpperTokens(lines)) {
   const firstLine = lines.find((l) => merged.includes(l.text.trim())) ?? lines[0];
   if (!firstLine) continue;
   push(merged, [firstLine.lineIndex], merged, firstLine, { isAllCaps: true });
 }
 for (const root of domainRoots) {
   if (linesCoverDomainBrand(root, lines)) continue;
   const split = inferSplitBrandFromDomain(root, lines);
   if (!split) continue;
   const line = lines[0];
   push(split, lines.slice(0, 4).map((l) => l.lineIndex), split, line, {
     emailDomainMatch: 1,
     websiteDomainMatch: 0.95,
     crossPageAgreement: 0.8,
   });
 }
 for (const emailCandidate of emailCandidates) {
   const fromDomain = companyFromEmailDomain(emailCandidate.value);
   if (!fromDomain) continue;
   const domain = emailCandidate.value.split('@')[1]?.split('.')[0] ?? '';
   if (inferSplitBrandFromDomain(domain, lines)) continue;
   if (linesCoverDomainBrand(domain, lines)) continue;
   if (!hasDomainEvidenceInLines(domain, lines)) continue;
   if (
     legalCompanies.some((c) => {
       const scores = computeDomainMatchScores(c, [domain]);
       return hasLegalForm(c) && (scores.emailDomainMatch ?? 0) >= 0.85;
     })
   ) {
     continue;
   }
   if (legalCompanies.some((c) => hasLegalFormSuffix(c))) continue;
   if (lines.some((l) => isProminentCompanyLine(l.text) && l.text.length > fromDomain.length + 2)) {
     continue;
   }
   const pseudoLine = {
     text: emailCandidate.rawText,
     confidence: emailCandidate.features.confidenceOcr ?? 0.6,
     lineIndex: emailCandidate.sourceLineIndices[0] ?? 0,
   };
   push(fromDomain, emailCandidate.sourceLineIndices, emailCandidate.rawText, pseudoLine, {
     emailDomainMatch: 0.85,
   });
 }
 for (const layoutCandidate of extractLayoutCompanyCandidates(layout, input, emailCandidates, websiteHints)) {
   const value = fixBareDiConnector(layoutCandidate.value.trim());
   if (!value || value.length < 2 || isDisqualifiedCompanyValue(value)) continue;
   const key = dedupeKey(value) || value.toLowerCase();
   if (seen.has(key)) continue;
   seen.add(key);
   const line =
     input.lines.find((l) => layoutCandidate.sourceLineIndices.includes(l.lineIndex)) ?? input.lines[0];
   if (!line) continue;
    const repBonus = repetitionBonusForCompany(value, repetition);
    const domainScores = computeDomainMatchScores(value, domainRoots);

    let layoutBoost = 0.15;
    const hasStrongDomain = (domainScores.emailDomainMatch ?? 0) > 0.7 || (domainScores.websiteDomainMatch ?? 0) > 0.7;
    if (hasStrongDomain) {
      layoutBoost += 0.35;
    }
    if (isMostlyDescriptorLine(value) && !hasLegalForm(value)) {
      layoutBoost -= 0.40;
    }

    const layoutCandidateEntry = makeCandidate(
        value,
        layoutCandidate.sourceLineIndices,
        layoutCandidate.rawText,
        {
          ...layoutCandidate.features,
          ...domainScores,
          emailDomainMatch: Math.min(1, (domainScores.emailDomainMatch ?? 0) + (hasStrongDomain ? layoutBoost : 0)),
          websiteDomainMatch: Math.min(1, (domainScores.websiteDomainMatch ?? 0) + (hasStrongDomain ? layoutBoost : 0)),
          crossPageAgreement: Math.max(layoutCandidate.features.crossPageAgreement ?? 0, repBonus, 0.55 + layoutBoost),
        },
        LAYOUT_EXTRACTOR
      );
    if (layoutCandidateEntry) candidates.push(layoutCandidateEntry);
  }
  return candidates;
}

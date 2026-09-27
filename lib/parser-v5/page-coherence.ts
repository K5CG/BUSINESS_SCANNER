/**
 * Coerenza multi-pagina.
 *
 * Le evidenze numeriche vengono prima classificate con provenance completa;
 * soltanto le P.IVA validate possono influenzare match/mismatch.
 */
import type { CardPageV5 } from './engine';
import { isGenericProviderDomain } from '../parser-engine/extractors/website';
import {
  levenshteinDistance,
  normalizeBrandKey,
} from '../parser-engine/validators/dictionaries';
import {
  collectNumericEvidence,
  resolveNumericEvidence,
  type NumericEvidence,
  type NumericEvidenceLine,
  type NumericEvidenceResolution,
} from './numeric-evidence';

const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const URL_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/gi;
const URL_LINE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/i;
const LEGAL_RE =
  /\b(?:s\.?\s*r\.?\s*l\.?|s\.?\s*p\.?\s*a\.?|s\.?\s*n\.?\s*c\.?|s\.?\s*a\.?\s*s\.?|srl|spa|snc|sas|gmbh|ag|ltd|llc|inc|corp(?:oration)?)\b/i;
const PERSON_LABEL_RE =
  /\b(?:nome|name|cognome|surname|family\s+name)\s*[:=\-]\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’ .-]{1,50})/gi;
const STREET_RE =
  /\b(?:via|viale|vicolo|piazza|piazzale|corso|largo|galleria|strada|street|road|avenue|boulevard|court|lane|drive|rue|route|calle|carrer|avenida|straat|strasse|straße|platz|allee|weg|gasse)\b/i;
const GENERIC_MAILBOX_RE =
  /^(?:info|contact|contacts|contatti|sales|admin|office|ufficio|hello|mail|posta|marketing|support|assistenza|service|booking|commerciale|segreteria|amministrazione|formazione|vendite|export|orders?|ordini|pec|webmaster|hr|jobs|press|restaurant|shop|store|no-?reply)\d*$/i;
const BACK_SIDE_CUE_RE =
  /\b(?:scan\s*me|scan|qr|qrcode|inquadra|vcard|whatsapp|salva\s+il\s+contatto)\b/i;
const ROLE_OR_GENERIC_RE =
  /\b(?:account|agent[eo]?|amministrazione|authorized|branch|business|certified|chief|commerciale|consultant|dealer|director|executive|gold|head|manager|marketing|office|partner|president|registered|responsabile|sales|service|support|technology)\b/i;
const FISCAL_PSEUDO_DOMAIN_RE =
  /^(?:p\.?iva|partita\.?iva|c\.?f|codice\.?fiscale)$/i;
const NON_DOMAIN_SUFFIX_RE =
  /\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|rtf|jpe?g|png|gif|svg|webp|tiff?|zip|rar|7z)$/i;

export type PageCoherenceDecision = 'match' | 'mismatch' | 'ambiguous';

export interface PageSignals {
  page: number;
  emails: string[];
  personalEmails: string[];
  personKeys: string[];
  businessDomains: string[];
  websiteDomains: string[];
  companyKeys: string[];
  logoKeys: string[];
  distinctiveTextKeys: string[];
  vatNumbers: string[];
  phoneNumbers: string[];
  faxNumbers: string[];
  taxCodes: string[];
  postalCodes: string[];
  addressKeys: string[];
  numericEvidence: NumericEvidence[];
  hasPersonLikeLine: boolean;
  hasBackSideCue: boolean;
  hasLegalForm: boolean;
  lineCount: number;
}

export interface PageCoherenceResult {
  pageMismatch: boolean;
  primaryPage: number;
  activePages: number[];
  reasons: string[];
  decision: PageCoherenceDecision;
  includedPages: number[];
  excludedPages: number[];
  pendingPages: number[];
  confidence: number;
  decisionReasons: string[];
  requiresReview: boolean;
  numericEvidence?: NumericEvidenceResolution;
}

interface PairAssessment {
  left: number;
  right: number;
  decision: PageCoherenceDecision;
  confidence: number;
  reasons: string[];
}

function normalizeDomainHost(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function compactDomain(domain: string): string {
  const host = normalizeDomainHost(domain);
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return normalizeBrandKey(host);
  const secondLevel = parts.at(-2) ?? '';
  const ccTldSecondLevels = new Set([
    'ac',
    'co',
    'com',
    'edu',
    'gov',
    'net',
    'org',
  ]);
  const root =
    (parts.at(-1)?.length === 2 &&
      ccTldSecondLevels.has(secondLevel) &&
      parts.length >= 3
      ? parts.at(-3)
      : secondLevel) ?? host;
  return normalizeBrandKey(root);
}

function valuesCompatible(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  if (
    left.length >= 4 &&
    right.length >= 4 &&
    (left.includes(right) || right.includes(left))
  ) {
    return true;
  }
  if (left.length < 6 || right.length < 6) return false;
  const maximumDistance = Math.min(
    2,
    Math.max(1, Math.floor(Math.max(left.length, right.length) * 0.2))
  );
  return (
    Math.abs(left.length - right.length) <= maximumDistance &&
    levenshteinDistance(left, right) <= maximumDistance
  );
}

function domainsCompatible(left: string, right: string): boolean {
  const leftHost = normalizeDomainHost(left);
  const rightHost = normalizeDomainHost(right);
  if (!leftHost || !rightHost) return false;
  if (leftHost === rightHost) return true;
  if (
    leftHost.endsWith(`.${rightHost}`) ||
    rightHost.endsWith(`.${leftHost}`)
  ) {
    return true;
  }
  if (
    leftHost.split('.').length > 2 &&
    rightHost.split('.').length > 2
  ) {
    return false;
  }
  return valuesCompatible(compactDomain(leftHost), compactDomain(rightHost));
}

function hasCompatiblePair(
  left: readonly string[],
  right: readonly string[],
  compatible: (a: string, b: string) => boolean = (a, b) => a === b
): boolean {
  return left.some((a) => right.some((b) => compatible(a, b)));
}

function setsConflict(
  left: readonly string[],
  right: readonly string[],
  compatible: (a: string, b: string) => boolean = (a, b) => a === b
): boolean {
  return (
    left.length > 0 &&
    right.length > 0 &&
    !hasCompatiblePair(left, right, compatible)
  );
}

function extractEmails(text: string): string[] {
  const emails = new Set(
    (text.match(EMAIL_RE) ?? []).map((value) => value.toLowerCase())
  );
  EMAIL_RE.lastIndex = 0;
  return [...emails].sort();
}

function isPersonalEmail(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return (
    local.length >= 3 &&
    /[a-z]/i.test(local) &&
    !GENERIC_MAILBOX_RE.test(local)
  );
}

function extractBusinessDomains(emails: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const email of emails) {
    const domain = email.split('@')[1]?.toLowerCase().trim();
    if (!domain || isGenericProviderDomain(domain)) continue;
    domains.add(domain);
  }
  return [...domains].sort();
}

function extractWebsiteDomains(text: string): string[] {
  const withoutEmails = text.replace(EMAIL_RE, ' ');
  EMAIL_RE.lastIndex = 0;
  const domains = new Set<string>();
  URL_RE.lastIndex = 0;
  for (const match of withoutEmails.matchAll(URL_RE)) {
    const offset = match.index ?? 0;
    const rawMatch = match[0] ?? '';
    const before = withoutEmails[offset - 1] ?? '';
    const after = withoutEmails[offset + rawMatch.length] ?? '';
    if (before === '@' || after === '@') continue;
    const host = rawMatch
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      ?.trim();
    if (
      !host ||
      host.includes('@') ||
      FISCAL_PSEUDO_DOMAIN_RE.test(host) ||
      NON_DOMAIN_SUFFIX_RE.test(host) ||
      isGenericProviderDomain(host)
    ) {
      continue;
    }
    domains.add(host);
  }
  URL_RE.lastIndex = 0;
  return [...domains].sort();
}

function extractCompanyKeys(lines: readonly string[]): string[] {
  const keys = new Set<string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!LEGAL_RE.test(line)) continue;
    const withoutLegal = line.replace(LEGAL_RE, ' ').trim();
    const shouldJoinPrevious =
      index > 0 &&
      (!normalizeBrandKey(withoutLegal) ||
        /^\s*(?:e|ed|and|&)\b/i.test(line));
    const source = shouldJoinPrevious
      ? `${lines[index - 1] ?? ''} ${line}`
      : line;
    const companyOnly =
      source
        .replace(LEGAL_RE, ' ')
        .split(
          /\b(?:via|viale|piazza|corso|largo|strada|street|road|avenue|boulevard)\b/i
        )[0]
        ?.split(/\s[|;–—-]\s/)[0] ?? '';
    const key = normalizeBrandKey(companyOnly);
    if (key.length >= 3) keys.add(key);
  }
  return [...keys].sort();
}

function isLikelyPersonLine(line: string): boolean {
  const trimmed = line.trim();
  if (
    !trimmed ||
    /[@\d]/.test(trimmed) ||
    URL_LINE_RE.test(trimmed) ||
    LEGAL_RE.test(trimmed) ||
    STREET_RE.test(trimmed) ||
    ROLE_OR_GENERIC_RE.test(trimmed) ||
    BACK_SIDE_CUE_RE.test(trimmed)
  ) {
    return false;
  }

  const words = trimmed.match(/\p{L}[\p{L}'’.-]*/gu) ?? [];
  if (words.length !== 2) return false;
  return words.every(
    (word) =>
      /^\p{Lu}[\p{L}'’.-]+$/u.test(word) ||
      (/^\p{Lu}+$/u.test(word) && word.length >= 2)
  );
}

function isLogoLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (
    !trimmed ||
    /[@\d]/.test(trimmed) ||
    URL_LINE_RE.test(trimmed) ||
    LEGAL_RE.test(trimmed) ||
    STREET_RE.test(trimmed) ||
    ROLE_OR_GENERIC_RE.test(trimmed) ||
    BACK_SIDE_CUE_RE.test(trimmed)
  ) {
    return false;
  }

  const words = trimmed.match(/\p{L}[\p{L}'’.-]*/gu) ?? [];
  const letters = trimmed.match(/\p{L}/gu) ?? [];
  const uppercase = trimmed.match(/\p{Lu}/gu) ?? [];
  const key = normalizeBrandKey(trimmed.replace(LEGAL_RE, ' '));
  return (
    words.length >= 1 &&
    words.length <= 4 &&
    letters.length >= 3 &&
    uppercase.length / letters.length >= 0.7 &&
    key.length >= 3 &&
    key.length <= 40
  ) || (
    words.length === 1 &&
    /^\p{Lu}[\p{L}'’.-]+$/u.test(trimmed) &&
    key.length >= 4 &&
    key.length <= 30
  );
}

function extractLogoKeys(lines: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const line of lines.slice(0, 4)) {
    if (!isLogoLikeLine(line)) continue;
    const key = normalizeBrandKey(line.replace(LEGAL_RE, ' '));
    if (key.length >= 3) keys.add(key);
  }
  return [...keys].sort();
}

function extractDistinctiveTextKeys(lines: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    const words = trimmed.match(/\p{L}[\p{L}'’.-]*/gu) ?? [];
    if (
      words.length < 2 ||
      words.length > 6 ||
      /[@\d]/.test(trimmed) ||
      URL_LINE_RE.test(trimmed) ||
      LEGAL_RE.test(trimmed) ||
      STREET_RE.test(trimmed) ||
      ROLE_OR_GENERIC_RE.test(trimmed) ||
      BACK_SIDE_CUE_RE.test(trimmed) ||
      isLikelyPersonLine(trimmed) ||
      isLogoLikeLine(trimmed)
    ) {
      continue;
    }
    const key = normalizeBrandKey(trimmed);
    if (key.length >= 8 && key.length <= 60) keys.add(key);
  }
  return [...keys].sort();
}

function extractPersonKeys(text: string): string[] {
  const keys = new Set<string>();
  PERSON_LABEL_RE.lastIndex = 0;
  for (const match of text.matchAll(PERSON_LABEL_RE)) {
    const key = normalizeBrandKey(match[1] ?? '');
    if (key.length >= 2) keys.add(key);
  }
  return [...keys].sort();
}

function extractAddressKeys(lines: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const line of lines) {
    if (!STREET_RE.test(line)) continue;
    const key = normalizeBrandKey(line);
    if (key.length >= 6) keys.add(key);
  }
  return [...keys].sort();
}

function hasLikelyPersonLine(
  lines: readonly string[],
  companyKeys: readonly string[],
  businessDomains: readonly string[]
): boolean {
  const organizationKeys = [
    ...companyKeys,
    ...businessDomains.map(compactDomain),
  ].filter(Boolean);
  return lines.slice(0, 4).some((line) => {
    if (!isLikelyPersonLine(line)) return false;
    const lineKey = normalizeBrandKey(line);
    return !organizationKeys.some(
      (key) => key === lineKey || key.includes(lineKey)
    );
  });
}

function numericLinesFromPages(
  pages: readonly CardPageV5[]
): NumericEvidenceLine[] {
  const result: NumericEvidenceLine[] = [];
  let lineId = 0;
  pages.forEach((page, pageIndex) => {
    const source = page.lines?.length
      ? page.lines.map((line) => String(line.text ?? ''))
      : (page.rawText ?? '').split(/\r?\n/);
    for (const text of source) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      result.push({ lineId: lineId++, pageIndex, text: trimmed });
    }
  });
  return result;
}

function pageSignals(
  page: CardPageV5,
  index: number,
  numericEvidence: readonly NumericEvidence[],
  acceptedEvidence: readonly NumericEvidence[]
): PageSignals {
  const lines = page.lines?.length
    ? page.lines.map((line) => String(line.text ?? ''))
    : (page.rawText ?? '').split(/\r?\n/);
  const text = page.rawText || lines.join('\n');
  const emails = extractEmails(text);
  const emailDomains = extractBusinessDomains(emails);
  const websiteDomains = extractWebsiteDomains(text);
  const businessDomains = [
    ...new Set([...emailDomains, ...websiteDomains]),
  ].sort();
  const companyKeys = extractCompanyKeys(lines);
  const hasLegalForm = LEGAL_RE.test(text);
  const accepted = acceptedEvidence.filter(
    (candidate) => candidate.pageIndex === index
  );

  const values = (type: NumericEvidence['evidenceType']): string[] =>
    [
      ...new Set(
        accepted
          .filter((candidate) => candidate.evidenceType === type)
          .map((candidate) => candidate.normalizedValue)
      ),
    ].sort();

  return {
    page: index,
    emails,
    personalEmails: emails.filter(isPersonalEmail),
    personKeys: extractPersonKeys(text),
    businessDomains,
    websiteDomains,
    companyKeys,
    logoKeys: extractLogoKeys(lines),
    distinctiveTextKeys: extractDistinctiveTextKeys(lines),
    vatNumbers: values('vat'),
    phoneNumbers: values('phone'),
    faxNumbers: values('fax'),
    taxCodes: values('taxCode'),
    postalCodes: values('postalCode'),
    addressKeys: extractAddressKeys(lines),
    numericEvidence: numericEvidence
      .filter((candidate) => candidate.pageIndex === index)
      .map((candidate) => ({ ...candidate })),
    hasPersonLikeLine: hasLikelyPersonLine(
      lines,
      companyKeys,
      businessDomains
    ),
    hasBackSideCue: BACK_SIDE_CUE_RE.test(text),
    hasLegalForm,
    lineCount: lines.filter((line) => line.trim()).length,
  };
}

function pageScore(signals: PageSignals): number {
  return (
    (signals.personalEmails.length || signals.personKeys.length ? 5 : 0) +
    (signals.vatNumbers.length ? 4 : 0) +
    (signals.businessDomains.length ? 2 : 0) +
    (signals.hasLegalForm ? 2 : 0) +
    (signals.lineCount ? 0.1 : 0)
  );
}

function comparePages(left: PageSignals, right: PageSignals): PairAssessment {
  const prefix = `pagine ${left.page + 1}/${right.page + 1}`;
  const samePersonalEmail = hasCompatiblePair(
    left.personalEmails,
    right.personalEmails
  );
  const samePersonKey = hasCompatiblePair(
    left.personKeys,
    right.personKeys,
    valuesCompatible
  );
  const sameTaxCode = hasCompatiblePair(left.taxCodes, right.taxCodes);
  const strongIdentityMatch =
    samePersonalEmail || samePersonKey || sameTaxCode;

  const personalEmailConflict = setsConflict(
    left.personalEmails,
    right.personalEmails
  );
  const personKeyConflict = setsConflict(
    left.personKeys,
    right.personKeys,
    valuesCompatible
  );
  const identityConflict = personalEmailConflict || personKeyConflict;

  const vatConflict = setsConflict(left.vatNumbers, right.vatNumbers);
  const companyConflict = setsConflict(
    left.companyKeys,
    right.companyKeys,
    valuesCompatible
  );
  const domainConflict = setsConflict(
    left.businessDomains,
    right.businessDomains,
    domainsCompatible
  );
  // Una P.IVA OCR incompatibile non può da sola separare fronte e retro se
  // le pagine condividono già un dominio o un brand aziendale. In quel caso
  // il numero è un candidato rumoroso e va segnalato, non usato per scartare
  // l'intera pagina.
  const organizationBridgeBeforeConflict =
    hasCompatiblePair(left.businessDomains, right.businessDomains, domainsCompatible) ||
    hasCompatiblePair(left.companyKeys, right.companyKeys, valuesCompatible) ||
    hasCompatiblePair(left.logoKeys, right.logoKeys, valuesCompatible) ||
    hasCompatiblePair(left.logoKeys, right.companyKeys, valuesCompatible) ||
    hasCompatiblePair(left.companyKeys, right.logoKeys, valuesCompatible);
  const unbridgedVatConflict = vatConflict && !organizationBridgeBeforeConflict;
  const corroboratedBusinessConflict =
    unbridgedVatConflict ||
    (companyConflict &&
      (domainConflict || (left.hasLegalForm && right.hasLegalForm))) ||
    (domainConflict &&
      left.hasLegalForm &&
      right.hasLegalForm);

  if (strongIdentityMatch && corroboratedBusinessConflict) {
    return {
      left: left.page,
      right: right.page,
      decision: 'ambiguous',
      confidence: 0.52,
      reasons: [
        `${prefix}: identità personale convergente ma evidenze aziendali contraddittorie`,
      ],
    };
  }

  if (identityConflict) {
    return {
      left: left.page,
      right: right.page,
      decision: 'mismatch',
      confidence: personalEmailConflict ? 0.96 : 0.88,
      reasons: [
        `${prefix}: identità personali incompatibili` +
          (personalEmailConflict ? ' (email personali distinte)' : ''),
      ],
    };
  }

  if (corroboratedBusinessConflict) {
    const details = [
      unbridgedVatConflict ? 'P.IVA validate distinte' : '',
      companyConflict ? 'aziende incompatibili' : '',
      domainConflict ? 'domini business incompatibili' : '',
    ].filter(Boolean);
    return {
      left: left.page,
      right: right.page,
      decision: 'mismatch',
      confidence: unbridgedVatConflict ? 0.98 : 0.9,
      reasons: [`${prefix}: ${details.join(', ')}`],
    };
  }

  if (strongIdentityMatch) {
    return {
      left: left.page,
      right: right.page,
      decision: 'match',
      confidence: samePersonalEmail ? 0.98 : sameTaxCode ? 0.94 : 0.9,
      reasons: [`${prefix}: identità personale convergente`],
    };
  }

  if (left.hasPersonLikeLine && right.hasPersonLikeLine) {
    return {
      left: left.page,
      right: right.page,
      decision: 'ambiguous',
      confidence: 0.46,
      reasons: [
        `${prefix}: possibili persone distinte con soli recapiti aziendali condivisi`,
      ],
    };
  }

  const domainKeys = (domains: readonly string[]): string[] =>
    domains.map(compactDomain).filter(Boolean);
  const leftDomainKeys = domainKeys(left.businessDomains);
  const rightDomainKeys = domainKeys(right.businessDomains);
  const organizationBridge =
    hasCompatiblePair(left.logoKeys, right.logoKeys, valuesCompatible) ||
    hasCompatiblePair(left.logoKeys, right.companyKeys, valuesCompatible) ||
    hasCompatiblePair(left.companyKeys, right.logoKeys, valuesCompatible) ||
    hasCompatiblePair(left.logoKeys, rightDomainKeys, valuesCompatible) ||
    hasCompatiblePair(leftDomainKeys, right.logoKeys, valuesCompatible) ||
    hasCompatiblePair(left.companyKeys, rightDomainKeys, valuesCompatible) ||
    hasCompatiblePair(leftDomainKeys, right.companyKeys, valuesCompatible);
  const distinctiveTextMatch = hasCompatiblePair(
    left.distinctiveTextKeys,
    right.distinctiveTextKeys,
    valuesCompatible
  );
  const hasPersonalPresence = (signals: PageSignals): boolean =>
    signals.personalEmails.length > 0 ||
    signals.personKeys.length > 0 ||
    signals.hasPersonLikeLine;
  const hasBackDetails = (signals: PageSignals): boolean =>
    signals.hasLegalForm ||
    signals.companyKeys.length > 0 ||
    signals.addressKeys.length > 0 ||
    signals.phoneNumbers.length > 0 ||
    signals.faxNumbers.length > 0 ||
    signals.vatNumbers.length > 0 ||
    signals.businessDomains.length > 0;
  const leftHasPerson = hasPersonalPresence(left);
  const rightHasPerson = hasPersonalPresence(right);
  const complementarySides =
    organizationBridge &&
    ((leftHasPerson && !rightHasPerson && hasBackDetails(right)) ||
      (rightHasPerson && !leftHasPerson && hasBackDetails(left)));
  const brandedBackCue =
    organizationBridge && (left.hasBackSideCue || right.hasBackSideCue);
  const sameVat = hasCompatiblePair(left.vatNumbers, right.vatNumbers);
  const samePhone =
    hasCompatiblePair(left.phoneNumbers, right.phoneNumbers) ||
    hasCompatiblePair(left.faxNumbers, right.faxNumbers);
  const sameAddress = hasCompatiblePair(
    left.addressKeys,
    right.addressKeys,
    valuesCompatible
  );

  const supportSignals = [
    hasCompatiblePair(
      left.businessDomains,
      right.businessDomains,
      domainsCompatible
    )
      ? 'dominio business'
      : '',
    hasCompatiblePair(
      left.companyKeys,
      right.companyKeys,
      valuesCompatible
    )
      ? 'azienda'
      : '',
    organizationBridge ? 'continuitÃ  logo/azienda' : '',
    distinctiveTextMatch ? 'testo distintivo condiviso' : '',
    complementarySides ? 'struttura fronte/retro complementare' : '',
    brandedBackCue ? 'segnale esplicito del retro' : '',
    sameVat ? 'P.IVA validata' : '',
    samePhone ? 'telefono/fax' : '',
    sameAddress ? 'indirizzo' : '',
  ].filter(Boolean);

  const hasIndependentSupport =
    distinctiveTextMatch ||
    complementarySides ||
    brandedBackCue ||
    sameVat ||
    samePhone ||
    sameAddress;

  if (supportSignals.length >= 2 && hasIndependentSupport) {
    return {
      left: left.page,
      right: right.page,
      decision: 'match',
      confidence: Math.min(0.95, 0.76 + supportSignals.length * 0.06),
      reasons: [
        `${prefix}: evidenze fronte/retro convergenti (${supportSignals.join(
          ', '
        )})`,
      ],
    };
  }

  return {
    left: left.page,
    right: right.page,
    decision: 'ambiguous',
    confidence: supportSignals.length === 1 ? 0.48 : 0.35,
    reasons: [
      `${prefix}: evidenze insufficienti` +
        (supportSignals.length
          ? ` (solo ${supportSignals[0]})`
          : ''),
    ],
  };
}

function pairKey(left: number, right: number): string {
  return `${Math.min(left, right)}:${Math.max(left, right)}`;
}

function chooseLargestMatchCluster(
  allPages: readonly number[],
  assessments: ReadonlyMap<string, PairAssessment>,
  signals: readonly PageSignals[],
  initialPrimary: number
): number[] {
  const isMatch = (left: number, right: number): boolean =>
    assessments.get(pairKey(left, right))?.decision === 'match';
  let best: number[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;

  const consider = (candidate: number[]): void => {
    const score = candidate.reduce(
      (sum, page) => sum + pageScore(signals[page]),
      0
    );
    if (
      candidate.length > best.length ||
      (candidate.length === best.length && score > bestScore) ||
      (candidate.length === best.length &&
        score === bestScore &&
        candidate.includes(initialPrimary) &&
        !best.includes(initialPrimary))
    ) {
      best = [...candidate].sort((a, b) => a - b);
      bestScore = score;
    }
  };

  if (allPages.length <= 12) {
    const subsetCount = 2 ** allPages.length;
    for (let mask = 1; mask < subsetCount; mask++) {
      const candidate = allPages.filter(
        (_, index) => (mask & (1 << index)) !== 0
      );
      if (
        candidate.every((page, index) =>
          candidate
            .slice(index + 1)
            .every((other) => isMatch(page, other))
        )
      ) {
        consider(candidate);
      }
    }
  } else {
    const ranked = [...allPages].sort(
      (a, b) => pageScore(signals[b]) - pageScore(signals[a]) || a - b
    );
    for (const seed of ranked) {
      const candidate = [seed];
      for (const page of ranked) {
        if (
          page !== seed &&
          candidate.every((member) => isMatch(member, page))
        ) {
          candidate.push(page);
        }
      }
      consider(candidate);
    }
  }

  return best;
}

function ambiguousResult(
  allPages: number[],
  primaryPage: number,
  reasons: string[],
  confidence: number,
  numericEvidence: NumericEvidenceResolution
): PageCoherenceResult {
  const decisionReasons = reasons.length
    ? [...new Set(reasons)]
    : ['evidenze multipagina insufficienti'];
  return {
    pageMismatch: false,
    primaryPage,
    activePages: [],
    reasons: decisionReasons,
    decision: 'ambiguous',
    includedPages: [],
    excludedPages: [],
    pendingPages: allPages,
    confidence,
    decisionReasons,
    requiresReview: true,
    numericEvidence,
  };
}

/**
 * Classifica le pagine come stesso biglietto, biglietti differenti o caso
 * ambiguo. Le linee opzionali permettono al runtime di conservare gli stessi
 * lineId usati dalla diagnostica del parser.
 */
export function analyzePageCoherence(
  pages: CardPageV5[],
  sourceLines?: readonly NumericEvidenceLine[]
): PageCoherenceResult {
  const evidence = collectNumericEvidence(
    sourceLines ?? numericLinesFromPages(pages)
  );
  const resolution = resolveNumericEvidence(evidence);

  if (pages.length <= 1) {
    const includedPages = pages.length === 1 ? [0] : [];
    return {
      pageMismatch: false,
      primaryPage: 0,
      activePages: includedPages,
      reasons: [],
      decision: 'match',
      includedPages,
      excludedPages: [],
      pendingPages: [],
      confidence: 1,
      decisionReasons: [],
      requiresReview: false,
      numericEvidence: resolution,
    };
  }

  const signals = pages.map((page, index) =>
    pageSignals(page, index, evidence, resolution.accepted)
  );
  const allPages = signals.map((signal) => signal.page);
  const ranked = [...signals].sort(
    (left, right) =>
      pageScore(right) - pageScore(left) || left.page - right.page
  );
  const initialPrimary = ranked[0]?.page ?? 0;
  const assessments = new Map<string, PairAssessment>();
  const allReasons: string[] = [];

  for (let left = 0; left < signals.length; left++) {
    for (let right = left + 1; right < signals.length; right++) {
      const assessment = comparePages(signals[left], signals[right]);
      assessments.set(pairKey(left, right), assessment);
      allReasons.push(...assessment.reasons);
    }
  }

  const pairValues = [...assessments.values()];
  if (pairValues.every((assessment) => assessment.decision === 'match')) {
    const confidence = Math.min(
      ...pairValues.map((assessment) => assessment.confidence)
    );
    const decisionReasons = [...new Set(allReasons)];
    return {
      pageMismatch: false,
      primaryPage: initialPrimary,
      activePages: allPages,
      reasons: decisionReasons,
      decision: 'match',
      includedPages: allPages,
      excludedPages: [],
      pendingPages: [],
      confidence,
      decisionReasons,
      requiresReview: false,
      numericEvidence: resolution,
    };
  }

  const ambiguous = pairValues.filter(
    (assessment) => assessment.decision === 'ambiguous'
  );
  if (ambiguous.length > 0) {
    return ambiguousResult(
      allPages,
      initialPrimary,
      allReasons,
      Math.min(...ambiguous.map((assessment) => assessment.confidence)),
      resolution
    );
  }

  const includedPages = chooseLargestMatchCluster(
    allPages,
    assessments,
    signals,
    initialPrimary
  );
  const includedSet = new Set(includedPages);
  const excludedPages = allPages.filter((page) => !includedSet.has(page));
  const everyExcludedIsMismatch = excludedPages.every((excluded) =>
    includedPages.every(
      (included) =>
        assessments.get(pairKey(excluded, included))?.decision === 'mismatch'
    )
  );
  if (!includedPages.length || !everyExcludedIsMismatch) {
    return ambiguousResult(
      allPages,
      initialPrimary,
      allReasons,
      0.4,
      resolution
    );
  }

  const primaryPage =
    ranked.find((signal) => includedSet.has(signal.page))?.page ??
    includedPages[0] ??
    initialPrimary;
  const mismatchConfidence = Math.min(
    ...pairValues
      .filter((assessment) => assessment.decision === 'mismatch')
      .map((assessment) => assessment.confidence)
  );
  const decisionReasons = [...new Set(allReasons)];

  return {
    pageMismatch: true,
    primaryPage,
    activePages: includedPages,
    reasons: decisionReasons,
    decision: 'mismatch',
    includedPages,
    excludedPages,
    pendingPages: [],
    confidence: mismatchConfidence,
    decisionReasons,
    requiresReview: true,
    numericEvidence: resolution,
  };
}

import type { Candidate, FeatureVector, NormalizedInput } from '../types';
import { repairOcrContactText } from '../normalize/ocr-repair';
import { levenshteinDistance } from '../validators/dictionaries';
import {
  isValidWebsiteHost,
  validateWebsite,
  websiteFromEmailDomain,
} from '../validators/website';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const FULL_URL_REGEX = /(?:https?:\/\/)?(www\.[a-z0-9-]+\.[a-z]{2,})/gi;
const PARTIAL_WWW_REGEX = /\b(?:www\.|ww\.)([a-z0-9-]{3,})\b/gi;
const BARE_DOMAIN_REGEX = /\b([a-z0-9-]+\.(?:com|it|net|org|eu|io))\b/gi;

/** Provider email/PEC generici — categoria di servizio, non marchi. */
const GENERIC_PROVIDER_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'libero.it',
  'live.com',
  'tiscali.it',
  'alice.it',
  'virgilio.it',
  'tin.it',
  'email.it',
  'pec.it',
  'legalmail.it',
]);

const PROVIDER_ROOTS = [
  'gmail',
  'yahoo',
  'hotmail',
  'outlook',
  'libero',
  'virgilio',
  'tiscali',
  'alice',
  'icloud',
  'live',
  'msn',
  'pec',
];

function providerRoot(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').split('.')[0] ?? '';
}

function isOcrVariantOfProviderRoot(root: string): boolean {
  const compact = root.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!compact || compact.length < 3) return false;
  for (const known of PROVIDER_ROOTS) {
    if (compact === known) return true;
    if (compact.length >= 4 && known.length >= 4 && levenshteinDistance(compact, known) <= 1) {
      return true;
    }
    if (compact.length >= 5 && known.length >= 5 && levenshteinDistance(compact, known) <= 2) {
      return true;
    }
  }
  return false;
}

const EXTRACTOR = 'website';
const INFERRED_EXTRACTOR = 'website:inferred';

function positionRank(lineIndex: number, lineCount: number): number {
  if (lineCount <= 1) return 0.5;
  return 1 - lineIndex / (lineCount - 1);
}

/** True per webmail, ISP consumer e domini PEC di terze parti. */
export function isGenericProviderDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  if (GENERIC_PROVIDER_DOMAINS.has(d)) return true;
  if (/pec|legalmail|postacert/i.test(d)) return true;
  return isOcrVariantOfProviderRoot(providerRoot(d));
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, '').trim();
}

function normalizeWebsite(url: string): string {
  const stripped = stripScheme(url);
  if (/^www\./i.test(stripped)) return stripped.toLowerCase();
  if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(stripped)) return `www.${stripped.toLowerCase()}`;
  return stripped.toLowerCase();
}

function makeCandidate(
  website: string,
  sourceLineIndices: number[],
  rawText: string,
  features: FeatureVector,
  extractor: string = EXTRACTOR
): Candidate<string> {
  return {
    value: normalizeWebsite(website),
    sourceLineIndices,
    extractor,
    rawText,
    features,
  };
}

function lineFeatures(
  line: { text: string; confidence: number; lineIndex: number },
  lineCount: number,
  explicit: boolean
): FeatureVector {
  return {
    positionRank: positionRank(line.lineIndex, lineCount),
    lineLength: line.text.length,
    confidenceOcr: explicit ? Math.max(line.confidence, 0.94) : line.confidence,
    hasEmailPattern: /@/.test(line.text),
    websiteDomainMatch: explicit ? 1 : undefined,
  };
}

function collectEmailHints(input: NormalizedInput, emailHints: string[]): string[] {
  const fromArg = emailHints.map((e) => e.toLowerCase()).filter(Boolean);
  const repaired = repairOcrContactText(input.repairedText);
  const fromText = (repaired.match(EMAIL_REGEX) ?? []).map((e) => e.toLowerCase());
  return [...new Set([...fromArg, ...fromText])];
}

function findLineForText(lines: NormalizedInput['lines'], fragment: string): number[] {
  const lower = fragment.toLowerCase();
  const hits = lines.filter((l) => {
    const raw = l.text.toLowerCase();
    const repaired = repairOcrContactText(l.text).toLowerCase();
    return raw.includes(lower) || repaired.includes(lower);
  }).map((l) => l.lineIndex);
  return hits;
}

function hasFullTld(url: string): boolean {
  const host = stripScheme(url).replace(/^www\./i, '');
  return /^[a-z0-9-]+\.[a-z]{2,}/i.test(host);
}

function isPartOfEmail(text: string, index: number, value: string): boolean {
  const before = text[index - 1] ?? '';
  const after = text[index + value.length] ?? '';
  // Evita falsi siti tipo "andrea.frosini" presi dalla parte locale di
  // andrea.frosini@azienda.it e "azienda.it" se è solo host email non esplicito.
  return before === '@' || after === '@';
}

/**
 * Estrae candidati sito web. `emailHints` opzionale per escludere provider generici
 * e proporre `www.{dominio}` quando non compare esplicitamente nel testo.
 */
export function extractWebsiteCandidates(
  input: NormalizedInput,
  emailHints: string[] = []
): Candidate<string>[] {
  const { lines } = input;
  const repairedText = repairOcrContactText(input.repairedText);
  const lineCount = lines.length;
  const emails = collectEmailHints(input, emailHints);
  const seen = new Set<string>();
  const candidates: Candidate<string>[] = [];

  const push = (
    url: string,
    sourceLineIndices: number[],
    rawText: string,
    features: FeatureVector,
    extractor: string = EXTRACTOR
  ) => {
    const normalized = validateWebsite(normalizeWebsite(url));
    if (!normalized) return;
    const host = normalized.replace(/^www\./, '').split('/')[0] ?? '';
    if (!host || !isValidWebsiteHost(host)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(makeCandidate(normalized, sourceLineIndices, rawText, features, extractor));
  };

  for (const line of lines) {
    const repairedLine = repairOcrContactText(line.text);

    for (const text of [line.text, repairedLine]) {
      for (const m of text.matchAll(FULL_URL_REGEX)) {
        if (isPartOfEmail(text, m.index ?? 0, m[0])) continue;
        push(m[0], [line.lineIndex], line.text, lineFeatures(line, lineCount, true));
      }
      for (const m of text.matchAll(PARTIAL_WWW_REGEX)) {
        if (hasFullTld(`www.${m[1]}`)) continue;
        push(`www.${m[1]}`, [line.lineIndex], line.text, {
          ...lineFeatures(line, lineCount, true),
          confidenceOcr: Math.max(line.confidence, 0.82),
        });
      }
      for (const m of text.matchAll(BARE_DOMAIN_REGEX)) {
        if (isPartOfEmail(text, m.index ?? 0, m[1])) continue;
        const site = m[1].toLowerCase();
        if (isGenericProviderDomain(site)) continue;
        push(`www.${site}`, [line.lineIndex], line.text, lineFeatures(line, lineCount, true));
      }
    }
  }

  for (const m of repairedText.matchAll(FULL_URL_REGEX)) {
    if (isPartOfEmail(repairedText, m.index ?? 0, m[0])) continue;
    push(m[0], findLineForText(lines, m[0]), m[0], { confidenceOcr: 0.9, websiteDomainMatch: 1 });
  }

  for (const m of repairedText.matchAll(PARTIAL_WWW_REGEX)) {
    const url = `www.${m[1]}`;
    if (hasFullTld(url)) continue;
    push(url, findLineForText(lines, url), url, { confidenceOcr: 0.8, websiteDomainMatch: 0.85 });
  }

  for (const email of emails) {
    const inferred = websiteFromEmailDomain(email);
    if (!inferred || seen.has(inferred)) continue;
    const hasExplicit = candidates.some((c) => c.extractor === EXTRACTOR);
    push(
      inferred,
      findLineForText(lines, inferred.replace(/^www\./, '')),
      email,
      {
        confidenceOcr: hasExplicit ? 0.42 : 0.78,
        emailDomainMatch: 0.95,
        websiteDomainMatch: 1,
      },
      INFERRED_EXTRACTOR
    );
  }

  const explicitValid = candidates.filter((c) => c.extractor === EXTRACTOR);
  if (!explicitValid.length) {
    return candidates.filter((c) => c.extractor === INFERRED_EXTRACTOR || validateWebsite(c.value));
  }

  return candidates.filter((c) => validateWebsite(c.value));
}

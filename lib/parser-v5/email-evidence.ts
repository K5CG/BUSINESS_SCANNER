import type { EmailEvidenceMetadata } from '../email-evidence';
import {
  isValidEmailFormat,
  normalizeEmail,
} from '../parser-engine/validators/email';

export interface EmailEvidenceLine {
  lineId: number;
  pageIndex: number;
  rawOcr: string;
  confidence: number;
}

const COMPLETE_EMAIL_RE =
  /[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
const TRAILING_PUNCTUATION_RE = /^[.,;:!?)}\]>]/;
const AT_TOKEN_RE = /(?:\[\s*at\s*\]|\(\s*at\s*\)|\{\s*at\s*\}|\s+at\s+|©)/gi;
const DOT_TOKEN_RE = /(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\}|\s+dot\s+)/gi;
const KNOWN_TLD_SOURCE =
  '(?:com|org|net|edu|gov|info|biz|io|eu|it|de|fr|es|ch|at|uk|be|nl|pt|gr|pl|cz|sk|si|hr|ro|bg|se|no|dk|fi|ie|us|ca|au|nz|jp|kr|cn|in|br|mx|za|pk)';
const EXPLICIT_EMAIL_LABEL_RE =
  /^(\s*(?:e[\s-]?mail|mail|email)\s*:\s*)(\S(?:.*\S)?)\s*$/i;
const EMAIL_LOCAL_RE =
  /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?$/i;
const EMAIL_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.05, Math.min(0.94, value));
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function createEvidence(
  line: EmailEvidenceLine,
  rawValue: string,
  value: string,
  transformations: string[],
  repaired: boolean
): EmailEvidenceMetadata {
  const normalized = normalizeEmail(value);
  const valid = isValidEmailFormat(normalized);
  const origin = repaired ? 'repaired' : 'observed';
  return {
    value: valid ? normalized : value.trim(),
    rawValue,
    repairedValue: repaired ? normalized : undefined,
    origin,
    pageIndex: line.pageIndex,
    lineId: line.lineId,
    rawOcr: line.rawOcr,
    transformations: unique(transformations),
    confidence: repaired
      ? Math.min(0.69, clampConfidence(line.confidence) * 0.72)
      : clampConfidence(line.confidence),
    validationStatus: valid ? 'valid' : 'invalid',
    requiresReview: repaired || !valid,
    confirmed: !repaired && valid,
  };
}

function collectCompleteMatches(
  text: string
): Array<{ value: string; index: number }> {
  const matches: Array<{ value: string; index: number }> = [];
  COMPLETE_EMAIL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPLETE_EMAIL_RE.exec(text)) !== null) {
    matches.push({ value: match[0], index: match.index });
  }
  COMPLETE_EMAIL_RE.lastIndex = 0;
  return matches;
}

function hasLeadingContactIcon(rawOcr: string, emailIndex: number): boolean {
  const prefix = rawOcr.slice(0, emailIndex).trim();
  if (!prefix) return false;
  if (/^(?:e-?mail|mail|email|contact)\s*:?\s*$/i.test(prefix)) return false;

  // Un glifo contatto può arrivare come simbolo Unicode oppure come sequenza
  // mojibake. Deve comunque precedere una email completa sulla stessa riga.
  return (
    /^[^\p{L}\p{N}@]{1,6}$/u.test(prefix) ||
    (
      prefix.length <= 8 &&
      /^[ÃÂâ]/u.test(prefix) &&
      /[^\p{L}\p{N}\s]/u.test(prefix)
    )
  );
}

function repairLabeledOcrAtSymbol(
  text: string
): { text: string; transformation?: string } {
  const labeled = text.match(EXPLICIT_EMAIL_LABEL_RE);
  if (!labeled) return { text };

  const prefix = labeled[1]!;
  const payload = labeled[2]!;
  if (payload.includes('@')) return { text };

  const registeredIndex = payload.indexOf('®');
  if (
    registeredIndex > 0 &&
    registeredIndex === payload.lastIndexOf('®')
  ) {
    const local = payload.slice(0, registeredIndex).trim();
    const domain = payload.slice(registeredIndex + 1).trim();
    const candidate = `${local}@${domain}`;
    if (
      EMAIL_LOCAL_RE.test(local) &&
      EMAIL_DOMAIN_RE.test(domain) &&
      isValidEmailFormat(normalizeEmail(candidate))
    ) {
      return {
        text: `${prefix}${candidate}`,
        transformation: 'replace_registered_symbol_with_at',
      };
    }
  }

  const candidates = new Set<string>();
  for (let index = 1; index < payload.length - 1; index += 1) {
    if (!/[oO]/.test(payload[index]!)) continue;
    const local = payload.slice(0, index).trim();
    const domain = payload.slice(index + 1).trim();
    if (!EMAIL_LOCAL_RE.test(local) || !EMAIL_DOMAIN_RE.test(domain)) {
      continue;
    }
    const candidate = normalizeEmail(`${local}@${domain}`);
    if (isValidEmailFormat(candidate)) candidates.add(candidate);
  }
  if (candidates.size !== 1) return { text };

  return {
    text: `${prefix}${[...candidates][0]}`,
    transformation: 'replace_ocr_o_with_at',
  };
}

function repairedLine(
  rawOcr: string
): { text: string; transformations: string[] } {
  let text = rawOcr;
  const transformations: string[] = [];

  if (AT_TOKEN_RE.test(text)) {
    text = text.replace(AT_TOKEN_RE, '@');
    transformations.push('replace_confused_at');
  }
  AT_TOKEN_RE.lastIndex = 0;

  if (DOT_TOKEN_RE.test(text)) {
    text = text.replace(DOT_TOKEN_RE, '.');
    transformations.push('replace_confused_dot');
  }
  DOT_TOKEN_RE.lastIndex = 0;

  if (/[a-z0-9._%+-]\s+@\s*[a-z0-9]/i.test(text) ||
      /[a-z0-9._%+-]\s*@\s+[a-z0-9]/i.test(text)) {
    text = text.replace(/\s*@\s*/g, '@');
    transformations.push('remove_spaces_around_at');
  }

  if (
    /[a-z0-9]\s+\.\s*[a-z0-9]/i.test(text) ||
    /[a-z0-9]\s*\.\s+[a-z0-9]/i.test(text)
  ) {
    text = text.replace(/\s*\.\s*/g, '.');
    transformations.push('remove_spaces_around_dot');
  }

  const domainSpacePattern = new RegExp(
    `(@[a-z0-9][a-z0-9.-]*)\\s+(${KNOWN_TLD_SOURCE})(?=\\s*(?:$|[,;:)]))`,
    'gi'
  );
  if (domainSpacePattern.test(text)) {
    domainSpacePattern.lastIndex = 0;
    text = text.replace(domainSpacePattern, '$1.$2');
    transformations.push('replace_domain_space_with_dot');
  }
  domainSpacePattern.lastIndex = 0;

  if (/@[a-z0-9.-]+[,;:][a-z]{2,}\b/i.test(text)) {
    text = text.replace(
      /(@[a-z0-9.-]+)[,;:]([a-z]{2,}\b)/gi,
      '$1.$2'
    );
    transformations.push('replace_confused_domain_dot');
  }

  // La stessa URL ripetuta dopo la mailbox e' un elemento grafico della riga
  // contatti. Senza questa separazione diventerebbe parte artificiale del TLD.
  const duplicatedWebsite = /\b([a-z0-9._%+\-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+))\s*[-–—]\s*(?:https?:\/\/)?(?:www\.)?\2\b/gi;
  if (duplicatedWebsite.test(text)) {
    duplicatedWebsite.lastIndex = 0;
    text = text.replace(duplicatedWebsite, '$1');
    transformations.push('strip_duplicate_website_after_email');
  }
  duplicatedWebsite.lastIndex = 0;

  const labeledAtRepair = repairLabeledOcrAtSymbol(text);
  if (labeledAtRepair.transformation) {
    text = labeledAtRepair.text;
    transformations.push(labeledAtRepair.transformation);
  }

  return { text, transformations };
}

function evidencePriority(evidence: EmailEvidenceMetadata): number {
  if (evidence.origin === 'observed') return 4;
  if (evidence.origin === 'user') return 3;
  if (evidence.origin === 'repaired') return 2;
  return 1;
}

/**
 * Classifica soltanto indirizzi sostenuti da una singola riga OCR inclusa.
 * Non combina mai nome, cognome, sito, dominio o altre email.
 */
export function collectEmailEvidence(
  lines: readonly EmailEvidenceLine[]
): EmailEvidenceMetadata[] {
  const byValue = new Map<string, EmailEvidenceMetadata>();

  const register = (evidence: EmailEvidenceMetadata) => {
    if (evidence.validationStatus !== 'valid') return;
    const key = normalizeEmail(evidence.value);
    const previous = byValue.get(key);
    if (
      !previous ||
      evidencePriority(evidence) > evidencePriority(previous) ||
      (evidencePriority(evidence) === evidencePriority(previous) &&
        evidence.confidence > previous.confidence)
    ) {
      byValue.set(key, evidence);
    }
  };

  for (const line of lines) {
    const observedMatches = collectCompleteMatches(line.rawOcr);
    for (const match of observedMatches) {
      // Il matcher permissivo puo' assorbire "-www.stesso-dominio" nel
      // dominio. Tagliamo solo quando la seconda URL coincide esattamente.
      const duplicated = match.value.match(/^(.+?@([a-z0-9-]+(?:\.[a-z0-9-]+)+))-www\.\2$/i);
      const observedValue = duplicated?.[1] ?? match.value;
      const following = line.rawOcr.slice(match.index + match.value.length);
      const hasTrailingPunctuation = TRAILING_PUNCTUATION_RE.test(following);
      const hasContactIcon = hasLeadingContactIcon(line.rawOcr, match.index);
      const rawValue = hasTrailingPunctuation
        ? observedValue + following[0]
        : observedValue;
      const transformations = [
        ...(observedValue !== observedValue.toLowerCase() ? ['lowercase'] : []),
        ...(duplicated ? ['strip_duplicate_website_after_email'] : []),
        ...(hasTrailingPunctuation ? ['trim_trailing_punctuation'] : []),
        ...(hasContactIcon ? ['remove_leading_contact_icon'] : []),
      ];
      register(
        createEvidence(
          line,
          rawValue,
          observedValue,
          transformations,
          hasTrailingPunctuation || hasContactIcon
        )
      );
    }

    const repaired = repairedLine(line.rawOcr);
    if (!repaired.transformations.length) continue;
    for (const match of collectCompleteMatches(repaired.text)) {
      register(
        createEvidence(
          line,
          line.rawOcr.trim(),
          match.value,
          [
            ...repaired.transformations,
            ...(match.value !== match.value.toLowerCase()
              ? ['lowercase']
              : []),
          ],
          true
        )
      );
    }
  }

  return [...byValue.values()];
}

export function parserEmailValues(
  evidence: readonly EmailEvidenceMetadata[]
): string[] {
  return evidence
    .filter(
      (item) =>
        item.validationStatus === 'valid' &&
        (item.origin === 'observed' || item.origin === 'repaired')
    )
    .map((item) => normalizeEmail(item.value));
}

export function observedEmailValues(
  evidence: readonly EmailEvidenceMetadata[]
): string[] {
  return evidence
    .filter(
      (item) =>
        item.validationStatus === 'valid' &&
        item.origin === 'observed' &&
        item.confirmed &&
        !item.requiresReview
    )
    .map((item) => normalizeEmail(item.value));
}

export function observedEmailScore(
  evidence: readonly EmailEvidenceMetadata[]
): number {
  const observed = evidence.filter(
    (item) =>
      item.origin === 'observed' &&
      item.validationStatus === 'valid' &&
      item.confirmed
  );
  if (!observed.length) return 0;
  return observed.reduce((sum, item) => sum + item.confidence, 0) /
    observed.length;
}

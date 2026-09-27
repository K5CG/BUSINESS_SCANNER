import type { Candidate, FeatureVector, NormalizedInput } from '../types';
import { isAllCaps, isTitleCase, tokenize } from '../normalize/tokens';
import {
  parseNameFromEmailLocal,
  parsePersonNameFromLine,
  type PersonNameValue,
  validatePersonName,
} from '../validators/name';
import { EMAIL_SINGLE_REGEX, isCommonFirstName } from '../validators/dictionaries';

const ITALIAN_OWNER_LINE =
  /^(?:di|del|della|dello|dei|degli|de)\s+(?:(?:dott\.?ssa?|dott\.?|sig\.?ra?|sig\.?|ing\.?|arch\.?|avv\.?|prof\.?|geom\.?)\s+)?([A-Za-zÀ-ü'`-]+)\s+([A-Za-zÀ-ü'`-]+)\s*$/i;

const EXTRACTOR = 'person-name';

function positionRank(lineIndex: number, lineCount: number): number {
  if (lineCount <= 1) return 0.5;
  return 1 - lineIndex / (lineCount - 1);
}

function lineFeatures(
  line: { text: string; confidence: number; lineIndex: number },
  lineCount: number,
  extra: FeatureVector = {}
): FeatureVector {
  const tokens = tokenize(line.text);
  return {
    positionRank: positionRank(line.lineIndex, lineCount),
    lineLength: line.text.length,
    confidenceOcr: line.confidence,
    tokenCount: tokens.length,
    isAllCaps: isAllCaps(line.text),
    isTitleCase: isTitleCase(line.text),
    inFirstNameDict: tokens.some((t) => isCommonFirstName(t)),
    hasEmailPattern: /@/.test(line.text),
    hasPhonePattern: /\d{5,}/.test(line.text.replace(/\s/g, '')),
    ...extra,
  };
}

function makeCandidate(
  value: PersonNameValue,
  sourceLineIndices: number[],
  rawText: string,
  features: FeatureVector
): Candidate<PersonNameValue> {
  return {
    value,
    sourceLineIndices,
    extractor: EXTRACTOR,
    rawText,
    features,
  };
}

function nameKey(value: PersonNameValue): string {
  return `${value.firstName}|${value.lastName}`.toLowerCase();
}

function digitCount(text: string): number {
  return text.replace(/\D/g, '').length;
}

function isExcludedNameMergeLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return true;
  if (EMAIL_SINGLE_REGEX.test(t)) return true;
  if (digitCount(t) >= 6) return true;
  if (/@|www\.|https?:/i.test(t)) return true;
  if (/^(via|viale|piazza|corso|tel\.?|fax\.?|cell\.?|phone|mobile)\b/i.test(t)) return true;
  return false;
}

/** Unisce due righe adiacenti con un token ciascuna in un nome plausibile. */
function tryParseSplitNameLines(
  firstLine: string,
  secondLine: string
): PersonNameValue | null {
  const a = firstLine.trim();
  const b = secondLine.trim();
  if (!a || !b) return null;
  if (a.split(/\s+/).length !== 1 || b.split(/\s+/).length !== 1) return null;
  if (!/^[A-Za-zÀ-ü'`-]{2,}$/.test(a) || !/^[A-Za-zÀ-ü'`-]{2,}$/.test(b)) return null;
  return parsePersonNameFromLine(`${a} ${b}`);
}

function collectSplitNameCandidates(
  lines: NormalizedInput['lines']
): Array<{ value: PersonNameValue; indices: number[]; rawText: string; confidence: number }> {
  const out: Array<{
    value: PersonNameValue;
    indices: number[];
    rawText: string;
    confidence: number;
  }> = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const lineA = lines[i];
    const lineB = lines[i + 1];
    if (isExcludedNameMergeLine(lineA.text) || isExcludedNameMergeLine(lineB.text)) continue;

    const parsed = tryParseSplitNameLines(lineA.text, lineB.text);
    if (!parsed) continue;

    out.push({
      value: parsed,
      indices: [lineA.lineIndex, lineB.lineIndex],
      rawText: `${lineA.text} ${lineB.text}`,
      confidence: Math.max(lineA.confidence, lineB.confidence),
    });
  }

  return out;
}

/**
 * Estrae candidati nome/cognome da righe OCR e opzionalmente da email personali.
 */
export function extractPersonNameCandidates(
  input: NormalizedInput,
  emailCandidates: Candidate<string>[] = []
): Candidate<PersonNameValue>[] {
  const { lines } = input;
  const lineCount = lines.length;
  const seen = new Set<string>();
  const candidates: Candidate<PersonNameValue>[] = [];

  const push = (
    value: PersonNameValue | null,
    line: { text: string; confidence: number; lineIndex: number },
    sourceLineIndices: number[] = [line.lineIndex],
    extra?: FeatureVector
  ) => {
    const valid = value ? validatePersonName(value) : null;
    if (!valid) return;
    const key = nameKey(valid);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(
      makeCandidate(valid, sourceLineIndices, line.text, lineFeatures(line, lineCount, extra))
    );
  };

  for (const line of lines) {
    push(parsePersonNameFromLine(line.text), line);

    const ownerMatch = line.text.trim().match(ITALIAN_OWNER_LINE);
    if (ownerMatch) {
      push(
        parsePersonNameFromLine(`${ownerMatch[1]} ${ownerMatch[2]}`),
        line,
        [line.lineIndex],
        { crossPageAgreement: 0.72, confidenceOcr: Math.max(line.confidence, 0.88) }
      );
    }
  }

  for (const split of collectSplitNameCandidates(lines)) {
    const pseudoLine = {
      text: split.rawText,
      confidence: split.confidence,
      lineIndex: split.indices[0] ?? 0,
    };
    push(split.value, pseudoLine, split.indices, { crossPageAgreement: 0.1 });
  }

  for (const emailCandidate of emailCandidates) {
    const parsed = parseNameFromEmailLocal(emailCandidate.value);
    if (!parsed?.firstName) continue;
    const pseudoLine = {
      text: emailCandidate.rawText,
      confidence: emailCandidate.features.confidenceOcr ?? 0.65,
      lineIndex: emailCandidate.sourceLineIndices[0] ?? 0,
    };
    push(parsed, pseudoLine, emailCandidate.sourceLineIndices, { emailLocalPartMatch: 0.85 });
  }

  return candidates;
}

export type { PersonNameValue };

import type { Candidate, FeatureVector, NormalizedInput } from '../types';
import { repairOcrContactText } from '../normalize/ocr-repair';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAIL_SINGLE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const EMAIL_LABEL_REGEX = /\b(?:e-?mail|e\s*mail|pec|cmail)\s*:?/i;

/** Caselle condivise tipiche — non persone, usate solo come feature. */
const GENERIC_LOCAL_PART =
  /^(info|noreply|contact|sales|admin|webmaster|office|mail|segreteria|ordini)$/i;

const EXTRACTOR = 'email';

function positionRank(lineIndex: number, lineCount: number): number {
  if (lineCount <= 1) return 0.5;
  return 1 - lineIndex / (lineCount - 1);
}

function emailFeatures(
  line: { text: string; confidence: number; lineIndex: number },
  lineCount: number,
  repairedLine: string
): FeatureVector {
  const hasLabel = EMAIL_LABEL_REGEX.test(line.text) || EMAIL_LABEL_REGEX.test(repairedLine);
  return {
    positionRank: positionRank(line.lineIndex, lineCount),
    lineLength: line.text.length,
    confidenceOcr: hasLabel ? Math.max(line.confidence, 0.92) : line.confidence,
    hasEmailPattern: true,
    tokenCount: line.text.split(/\s+/).filter(Boolean).length,
  };
}

function makeCandidate(
  email: string,
  sourceLineIndices: number[],
  rawText: string,
  features: FeatureVector
): Candidate<string> {
  return {
    value: email.toLowerCase(),
    sourceLineIndices,
    extractor: EXTRACTOR,
    rawText,
    features,
  };
}

function findLineIndicesForEmail(lines: NormalizedInput['lines'], email: string): number[] {
  const needle = email.toLowerCase();
  const indices = lines
    .filter((line) => {
      const raw = line.text.toLowerCase();
      const repaired = repairOcrContactText(line.text).toLowerCase();
      return raw.includes(needle) || repaired.includes(needle) || line.text.match(EMAIL_SINGLE)?.[0]?.toLowerCase() === needle;
    })
    .map((line) => line.lineIndex);
  return indices.length > 0 ? indices : [];
}

function collectEmailsFromText(
  text: string,
  seen: Set<string>,
  candidates: Candidate<string>[],
  lines: NormalizedInput['lines'],
  lineCount: number,
  sourceLine?: { text: string; confidence: number; lineIndex: number },
  repairedSource?: string
) {
  const matches = text.match(EMAIL_REGEX) ?? [];
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);

    if (sourceLine) {
      candidates.push(
        makeCandidate(
          email,
          [sourceLine.lineIndex],
          sourceLine.text,
          emailFeatures(sourceLine, lineCount, repairedSource ?? sourceLine.text)
        )
      );
      continue;
    }

    const sourceLineIndices = findLineIndicesForEmail(lines, email);
    const matchedLine = lines.find((l) => sourceLineIndices.includes(l.lineIndex));
    const repairedLine = matchedLine ? repairOcrContactText(matchedLine.text) : '';
    candidates.push(
      makeCandidate(
        email,
        sourceLineIndices,
        matchedLine?.text ?? raw,
        matchedLine
          ? emailFeatures(matchedLine, lineCount, repairedLine)
          : { hasEmailPattern: true, confidenceOcr: 0.75 }
      )
    );
  }
}

/**
 * Estrae candidati email da righe (raw + riparate OCR) e testo aggregato riparato.
 * Non seleziona né ordina: produce tutti i match trovati.
 */
export function extractEmailCandidates(input: NormalizedInput): Candidate<string>[] {
  const { lines, repairedText } = input;
  const lineCount = lines.length;
  const seen = new Set<string>();
  const candidates: Candidate<string>[] = [];

  for (const line of lines) {
    const repairedLine = repairOcrContactText(line.text);
    collectEmailsFromText(line.text, seen, candidates, lines, lineCount, line, repairedLine);
    if (repairedLine !== line.text) {
      collectEmailsFromText(repairedLine, seen, candidates, lines, lineCount, line, repairedLine);
    }
  }

  collectEmailsFromText(repairedText, seen, candidates, lines, lineCount);

  return candidates;
}

/** True se la local-part è una casella condivisa (info, sales, …). */
export function isGenericEmailLocalPart(email: string): boolean {
  const local = email.split('@')[0] ?? '';
  return GENERIC_LOCAL_PART.test(local);
}

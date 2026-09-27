import type { Candidate, FeatureVector, NormalizedInput } from '../types';
import { isAllCaps, isTitleCase, tokenize } from '../normalize/tokens';
import {
  containsFuzzyRoleWord,
  DEPARTMENT_REGEX,
  EMAIL_SINGLE_REGEX,
  isCompanyNoiseLine,
  ITALIAN_ROLE_WORDS,
  ROLE_KEYWORD_REGEX,
  TAX_LABEL_REGEX,
} from '../validators/dictionaries';
import { isLikelyActivityRoleLine, isPlausiblePersonNameLine } from '../validators/name';
import {
  isCompanySloganClaimLine,
  roleProximityToNameLine,
} from '../validators/role';
import { looksLikeAddressOrLocationLine, looksLikePhoneOrNumericLine } from '../scoring/features';

const EXTRACTOR = 'role';

function positionRank(lineIndex: number, lineCount: number): number {
  if (lineCount <= 1) return 0.5;
  return 1 - lineIndex / (lineCount - 1);
}

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

function looksLikeDomainLine(text: string): boolean {
  return /^(?:https?:\/\/)?(?:www\.|ww\.)([a-z0-9-]+\.[a-z]{2,})/i.test(text.trim());
}

function isRoleContinuationLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 45) return false;
  if (isCompanySloganClaimLine(t)) return false;
  if (EMAIL_SINGLE_REGEX.test(t)) return false;
  if (digitCount(t) >= 6) return false;
  if (looksLikeAddressOrLocationLine(t)) return false;
  if (looksLikePhoneOrNumericLine(t)) return false;
  if (isPlausiblePersonNameLine(t)) return false;
  if (ROLE_KEYWORD_REGEX.test(t)) return true;
  if (containsFuzzyRoleWord(t)) return true;
  if (DEPARTMENT_REGEX.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3 && words.every((w) => /^[A-Za-zÀ-ü'`.-]+$/.test(w))) {
    return ROLE_KEYWORD_REGEX.test(t) || containsFuzzyRoleWord(t);
  }
  return false;
}

function lineFeatures(
  line: { text: string; confidence: number; lineIndex: number },
  lineCount: number,
  extra: FeatureVector = {}
): FeatureVector {
  return {
    positionRank: positionRank(line.lineIndex, lineCount),
    lineLength: line.text.length,
    confidenceOcr: line.confidence,
    hasRoleKeyword: ROLE_KEYWORD_REGEX.test(line.text),
    tokenCount: tokenize(line.text).length,
    isTitleCase: isTitleCase(line.text),
    hasEmailPattern: /@/.test(line.text),
    hasPhonePattern: digitCount(line.text) >= 6,
    ...extra,
  };
}

function makeCandidate(
  value: string,
  sourceLineIndices: number[],
  rawText: string,
  features: FeatureVector
): Candidate<string> {
  return {
    value,
    sourceLineIndices,
    extractor: EXTRACTOR,
    rawText,
    features,
  };
}

function isLikelyRoleLine(text: string): boolean {
  const t = text.trim().replace(/^ruolo\s*[:\-]\s*/i, '');
  if (!t || t.length < 3 || t.length > 80) return false;
  if (isCompanySloganClaimLine(t)) return false;
  if (EMAIL_SINGLE_REGEX.test(t)) return false;
  if (digitCount(t) >= 6) return false;
  if (isCompanyNoiseLine(t)) return false;
  if (isPlausiblePersonNameLine(t)) return false;
  if (looksLikeDomainLine(t)) return false;
  if (looksLikeAddressOrLocationLine(t)) return false;
  if (looksLikePhoneOrNumericLine(t)) return false;
  if (TAX_LABEL_REGEX.test(t)) return false;
  if (/^(via|viale|piazza|corso|galleria|tel\.?|fax\.?|phone|mobile|cell\.?)\b/i.test(t)) return false;
  if (ROLE_KEYWORD_REGEX.test(t)) return true;
  if (containsFuzzyRoleWord(t)) return true;
  if (DEPARTMENT_REGEX.test(t)) return true;

  const word = t.replace(/[.,]/g, '').trim();
  if (word.length >= 4 && word.length <= 28 && ITALIAN_ROLE_WORDS.has(word.toLowerCase())) {
    return true;
  }

  if (/^(responsabile|capo|head\s+of|chief|senior|junior|vice|ass\.?|assistente)\b/i.test(t)) {
    return true;
  }

  if (isLikelyActivityRoleLine(t) && !isCompanySloganClaimLine(t)) return true;

  return false;
}

function mergeAdjacentRoleLines(
  lines: NormalizedInput['lines']
): Array<{ text: string; indices: number[]; confidence: number }> {
  const merged: Array<{ text: string; indices: number[]; confidence: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.text.trim();
    if (!isLikelyRoleLine(t)) continue;

    let combined = t;
    const indices = [line.lineIndex];
    let confidence = line.confidence;

    while (i + 1 < lines.length) {
      const next = lines[i + 1].text.trim();
      if (!next) break;
      if (!isRoleContinuationLine(next)) break;
      combined = `${combined} ${next}`.replace(/\s+/g, ' ').trim();
      indices.push(lines[i + 1].lineIndex);
      confidence = Math.max(confidence, lines[i + 1].confidence);
      i++;
    }

    merged.push({ text: combined, indices, confidence });
  }

  return merged;
}

/**
 * Estrae candidati ruolo da righe OCR (incluso merge di righe adiacenti correlate).
 */
export function extractRoleCandidates(input: NormalizedInput): Candidate<string>[] {
  const { lines } = input;
  const lineCount = lines.length;
  const seen = new Set<string>();
  const candidates: Candidate<string>[] = [];

  const nameLineIndices = lines
    .filter((line) => isPlausiblePersonNameLine(line.text))
    .map((line) => line.lineIndex);

  for (const block of mergeAdjacentRoleLines(lines)) {
    const key = block.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const pseudoLine = {
      text: block.text,
      confidence: block.confidence,
      lineIndex: block.indices[0] ?? 0,
    };
    const nearName = roleProximityToNameLine(pseudoLine.lineIndex, nameLineIndices);
    const hasRoleKeyword = ROLE_KEYWORD_REGEX.test(block.text) || containsFuzzyRoleWord(block.text);
    candidates.push(
      makeCandidate(block.text, block.indices, block.text, {
        ...lineFeatures(pseudoLine, lineCount),
        hasRoleKeyword,
        hasCatalogKeyword: isCompanySloganClaimLine(block.text),
        isAllCaps: isAllCaps(block.text),
        crossPageAgreement: nearName,
        confidenceOcr: nearName > 0.7 ? Math.max(block.confidence, 0.88) : block.confidence,
      })
    );
  }

  return candidates;
}

/** Preferisce ruolo vicino al nome (entro 3 righe sotto). */
export function rankRoleNearName(
  candidate: Candidate<string>,
  nameLineIndex: number | undefined
): number {
  if (nameLineIndex === undefined || nameLineIndex < 0) return 0;
  const roleLine = candidate.sourceLineIndices[0] ?? -1;
  if (roleLine < 0) return 0;
  const distance = roleLine - nameLineIndex;
  if (distance >= 1 && distance <= 3) return 0.35 - (distance - 1) * 0.08;
  return 0;
}

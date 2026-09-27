import type { Phone } from '../../../types';
import type { Candidate, FeatureVector, NormalizedInput } from '../types';

const EMAIL_SINGLE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const EXTRACTOR = 'phone';

function positionRank(lineIndex: number, lineCount: number): number {
  if (lineCount <= 1) return 0.5;
  return 1 - lineIndex / (lineCount - 1);
}

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

/** Corregge O/0 e I/l solo in porzioni prevalentemente numeriche. */
function fixOcrDigitsInLine(line: string): string {
  const trimmed = line.trim();
  const labelMatch = trimmed.match(
    /^((?:cell|mob|mobile|telefono|telefax|tel|fax)\.?\s*:?\s*)(.*)$/i
  );
  if (labelMatch) {
    const numeric = labelMatch[2]
      .replace(/[oO]/g, '0')
      .replace(/(?<=\d)[Il]|[Il](?=\d)/g, '1');
    return labelMatch[1] + numeric;
  }
  return trimmed.replace(/[0-9oOIl][0-9oOIl\s()./:-]*[0-9oOIl]/g, (token) => {
    const digits = (token.match(/\d/g) ?? []).length;
    const confusables = (token.match(/[oOIl]/g) ?? []).length;
    if (digits >= 5 && confusables >= 1) {
      return token.replace(/[oO]/g, '0').replace(/[Il]/g, '1');
    }
    return token;
  });
}

/** Normalizza prefissi IT comuni senza alterare la cifra significativa. */
export function normalizePhoneDigits(raw: string): string {
  let p = raw.replace(/\s+/g, ' ').trim();
  if (/^439[\s.-]/.test(p)) {
    p = '+39 ' + p.replace(/^439[\s.-]?/, '');
  } else if (/^0039[\s.-]?\d/.test(p)) {
    p = '+39 ' + p.replace(/^0039[\s.-]?/, '');
  } else if (/^39[\s.-]?\d/.test(p) && !p.startsWith('+')) {
    p = '+39 ' + p.replace(/^39[\s.-]?/, '');
  } else if (/^0\d[\d\s()./-]{6,}$/.test(p)) {
    p = '+39 ' + p;
  } else if (/^3\d{2}[\s()./.-]?\d/.test(p)) {
    p = '+39 ' + p;
  }
  return p;
}

function phoneTypeFromContext(line: string, index: number): Phone['type'] {
  const before = line.slice(Math.max(0, index - 4), index).toLowerCase();
  if (/\bf[\s.:]?$/.test(before) || /\bfax\b/i.test(line)) return 'fax';
  if (/\b(mob|cell|mobile|^[pm]\b)/i.test(line)) return 'mobile';
  return 'work';
}

function phoneFeatures(
  line: { text: string; confidence: number; lineIndex: number },
  lineCount: number
): FeatureVector {
  return {
    positionRank: positionRank(line.lineIndex, lineCount),
    lineLength: line.text.length,
    confidenceOcr: line.confidence,
    hasPhonePattern: true,
    hasEmailPattern: EMAIL_SINGLE.test(line.text),
  };
}

function makeCandidate(
  phone: Phone,
  sourceLineIndices: number[],
  rawText: string,
  features: FeatureVector
): Candidate<Phone> {
  return {
    value: phone,
    sourceLineIndices,
    extractor: EXTRACTOR,
    rawText,
    features,
  };
}

function tryPushPhone(
  found: Map<string, Candidate<Phone>>,
  raw: string,
  type: Phone['type'],
  line: { text: string; confidence: number; lineIndex: number },
  lineCount: number
): void {
  const normalized = normalizePhoneDigits(raw.replace(/:/g, '.'));
  const digits = digitCount(normalized);
  if (digits < 9 || digits > 15) return;

  const key = normalized.replace(/\D/g, '');
  if (!key || found.has(key)) return;

  found.set(
    key,
    makeCandidate(
      { number: normalized, type },
      [line.lineIndex],
      line.text,
      phoneFeatures(line, lineCount)
    )
  );
}

function extractFromLine(
  line: { text: string; confidence: number; lineIndex: number },
  lineCount: number,
  found: Map<string, Candidate<Phone>>
): void {
  const trimmed = fixOcrDigitsInLine(line.text).trim();
  if (!trimmed || EMAIL_SINGLE.test(trimmed)) return;

  for (const m of trimmed.matchAll(
    /(?:Telefono|Telefax|Tel\.?|Fax\.?)\s*:?\s*(0\d{2,4}[/\s.\-:]*\d{2}[/\s.\-:]*\d{2}(?:[/\s.\-:]*\d{2}){0,2})/gi
  )) {
    tryPushPhone(found, m[1], /fax/i.test(m[0]) ? 'fax' : 'work', line, lineCount);
  }

  for (const m of trimmed.matchAll(
    /\b([PTF])\s*[.:]?\s*((?:0039|\+39|0)[\d\s()./:-]{8,20})/gi
  )) {
    const kind = m[1].toUpperCase();
    tryPushPhone(
      found,
      m[2],
      kind === 'F' ? 'fax' : kind === 'P' ? 'mobile' : 'work',
      line,
      lineCount
    );
  }

  for (const m of trimmed.matchAll(
    /(?:Telephone|Telefono|Telefax|Cellulare|Mobile|Phone|M\.|P\.|T\.|F\.|Tel\.?|Fax\.?|Mob\.?|Cell\.?|Cell\s+No\.?|PH\s+No\.?)\s*[.:]?\s*((?:0039|\+39|\+?\d)[\d\s()./:-]{8,20})/gi
  )) {
    tryPushPhone(
      found,
      m[1],
      /fax/i.test(m[0]) ? 'fax' : /mobile|cell|mob|telephone/i.test(m[0]) ? 'mobile' : 'work',
      line,
      lineCount
    );
  }

  for (const m of trimmed.matchAll(
    /(?:cell|mob|mobile|ce?ll|11|l{1,2})\.?\s*:?\s*((?:\+39\s*)?3\d{2}[\s.-]?\d{2,3}[\s.-]?\d{2,3}[\s.-]?\d{2,3})\b/gi
  )) {
    const raw = m[1].trim();
    tryPushPhone(found, raw.startsWith('+') ? raw : `+39 ${raw}`, 'mobile', line, lineCount);
  }

  for (const m of trimmed.matchAll(/\b(0039[\s.-]?\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d+)?)\b/g)) {
    tryPushPhone(found, m[1], phoneTypeFromContext(trimmed, m.index ?? 0), line, lineCount);
  }

  for (const m of trimmed.matchAll(/\b(\+39[\s.-]?\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d+)?)\b/g)) {
    tryPushPhone(found, m[1], 'work', line, lineCount);
  }

  const mobile = trimmed.match(
    /(?:M\.?\s*)?(?:\+39|439)[\s.-]?(\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/i
  );
  if (mobile) {
    tryPushPhone(found, `+39 ${mobile[1]}`, 'mobile', line, lineCount);
  }

  const letters = trimmed.replace(/[^A-Za-zÀ-ü]/g, '').length;
  const digits = digitCount(trimmed);
  if (
    letters <= 2 &&
    digits >= 9 &&
    digits <= 15 &&
    /^\+?[\d\s()./-]+$/.test(trimmed.replace(/^[A-Za-z]{0,2}[.:]?\s*/, ''))
  ) {
    const numberPart = trimmed.replace(/^[A-Za-z]{0,2}[.:]?\s*/, '').trim();
    if (numberPart && /\d{5,}/.test(numberPart.replace(/[\s()./-]/g, ''))) {
      tryPushPhone(found, numberPart, phoneTypeFromContext(trimmed, 0), line, lineCount);
    }
  }
}

/**
 * Estrae candidati telefono da righe normalizzate.
 * Deduplica per cifre significative; non seleziona il set finale.
 */
export function extractPhoneCandidates(input: NormalizedInput): Candidate<Phone>[] {
  const { lines, repairedText } = input;
  const lineCount = lines.length;
  const found = new Map<string, Candidate<Phone>>();

  const parsedLines = lines.map((line) => ({
    ...line,
    text: fixOcrDigitsInLine(line.text),
  }));

  for (const line of parsedLines) {
    extractFromLine(line, lineCount, found);
  }

  for (const m of repairedText.matchAll(/\b(\+?\d{8,15})\b/g)) {
    tryPushPhone(found, m[1], 'work', { text: m[1], confidence: 0.5, lineIndex: 0 }, lineCount);
  }

  const fixedText = fixOcrDigitsInLine(repairedText);
  for (const m of fixedText.matchAll(/\b(0039[\s.-]?\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d+)?)\b/g)) {
    const idx = m.index ?? 0;
    const lineStart = fixedText.lastIndexOf('\n', idx) + 1;
    const lineEnd = fixedText.indexOf('\n', idx);
    const lineText = fixedText.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    const lineIndex =
      lines.find((l) => l.text.includes(lineText.trim()) || lineText.includes(l.text))?.lineIndex ?? 0;
    const pseudoLine = {
      text: lineText,
      confidence: 0.7,
      lineIndex,
    };
    tryPushPhone(found, m[1], phoneTypeFromContext(lineText, idx - lineStart), pseudoLine, lineCount);
  }

    // Fallback: extract any remaining phone-like sequences from the entire repaired text
  const fallbackMatches = repairedText.matchAll(/(?:\+39\s*)?\d{9,15}/g);
  for (const m of fallbackMatches) {
    tryPushPhone(found, m[0], 'work', { text: m[0], confidence: 0.5, lineIndex: 0 }, lineCount);
  }
      // Additional fallback: capture phone‑like sequences that may contain spaces, dots or hyphens
    const permissiveMatches = repairedText.matchAll(/(?:\\+39\\s*)?[0-9\s.\-\/]{9,15}/g);
    for (const m of permissiveMatches) {
      const rawNum = m[0];
      const normalized = normalizePhoneDigits(rawNum);
      if (normalized) {
        tryPushPhone(found, normalized, 'work', { text: rawNum, confidence: 0.5, lineIndex: 0 }, lineCount);
      }
    }
    return [...found.values()];
}

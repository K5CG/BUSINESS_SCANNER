import type { OcrLine } from '../../../types';
import { filterCardRelevantLines, isCardBackgroundNoise } from '../../ocr-filter';
import type { NormalizedInput, RawLine } from '../types';
import {
  LINE_SORT_Y_TOLERANCE,
  MAX_CARD_LINE_LEN,
  MAX_CARD_LINES,
  MAX_CARD_TEXT_LEN,
} from '../types';
import { repairOcrContactText } from './ocr-repair';

/** Riordina dall'alto in basso, sinistra→destra, se tutte le righe hanno `boundingBox.y`. */
export function sortLinesTopToBottom(lines: OcrLine[]): OcrLine[] {
  if (lines.length < 2) return lines;
  if (!lines.every((l) => l.boundingBox && typeof l.boundingBox.y === 'number')) {
    return lines;
  }
  return [...lines].sort((a, b) => {
    const ay = a.boundingBox?.y ?? 0;
    const by = b.boundingBox?.y ?? 0;
    if (Math.abs(ay - by) > LINE_SORT_Y_TOLERANCE) return ay - by;
    return (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0);
  });
}

/** Applica limiti di lunghezza su righe e testo grezzo. */
export function clampOcrLines(lines: OcrLine[], rawText: string): { lines: OcrLine[]; rawText: string } {
  const ordered = sortLinesTopToBottom(lines);
  const clampedLines = ordered.slice(0, MAX_CARD_LINES).map((line) => ({
    ...line,
    text: (line.text ?? '').slice(0, MAX_CARD_LINE_LEN),
  }));
  return {
    lines: clampedLines,
    rawText: (rawText ?? '').slice(0, MAX_CARD_TEXT_LEN),
  };
}

function toRawLine(line: OcrLine, lineIndex: number): RawLine {
  return {
    text: (line.text ?? '').trim(),
    confidence: line.confidence ?? 0.7,
    boundingBox: line.boundingBox,
    lineIndex,
  };
}

/**
 * Seleziona le righe utili al parsing con fallback progressivi
 * (stessa strategia del legacy, senza logica per biglietto).
 */
export function selectParsingLines(lines: OcrLine[], rawText: string): RawLine[] {
  const trimmed = lines.map((line) => ({
    ...line,
    text: (line.text ?? '').trim(),
  }));

  const fromOcr = trimmed
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.text.length >= 1 && !isCardBackgroundNoise(line.text));
  if (fromOcr.length >= 1) {
    return fromOcr.map(({ line, index }) => toRawLine(line, index));
  }

  const filtered = filterCardRelevantLines(lines);
  if (filtered.length >= 1) {
    return filtered.map((line, index) => toRawLine(line, index));
  }

  const relaxed = trimmed
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.text.length >= 2 && !isCardBackgroundNoise(line.text));
  if (relaxed.length >= 1) {
    return relaxed.map(({ line, index }) => toRawLine(line, index));
  }

  return rawText
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text.length >= 2)
    .map((text, index) => ({
      text,
      confidence: 0.7,
      lineIndex: index,
    }));
}

/** Testo aggregato dalle righe selezionate, con fallback su filtro legacy. */
export function buildParsingText(lines: RawLine[], rawText: string): string {
  const fromLines = lines.map((l) => l.text).join('\n').trim();
  if (fromLines.length >= 8) return fromLines;

  const ocrLines: OcrLine[] = lines.map((l) => ({
    text: l.text,
    confidence: l.confidence,
    boundingBox: l.boundingBox,
  }));
  const filtered = filterCardRelevantLines(ocrLines);
  const fromFilter = filtered.map((l) => l.text).join('\n').trim();
  return fromFilter || rawText.trim() || fromLines;
}

/** Normalizza righe OCR in `RawLine[]` (ordinate, clampate, filtrate). */
export function normalizeLines(lines: OcrLine[], rawText: string): RawLine[] {
  const { lines: clamped, rawText: clampedText } = clampOcrLines(lines, rawText);
  return selectParsingLines(clamped, clampedText);
}

/** Output completo della fase normalize per una pagina. */
export function buildNormalizedInput(lines: OcrLine[], rawText: string): NormalizedInput {
  const { lines: clamped, rawText: clampedText } = clampOcrLines(lines, rawText);
  const rawLines = selectParsingLines(clamped, clampedText);
  const parsingText = buildParsingText(rawLines, clampedText);
  return {
    lines: rawLines,
    rawText: clampedText,
    repairedText: repairOcrContactText(parsingText),
  };
}

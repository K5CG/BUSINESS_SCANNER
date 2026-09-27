import type { RawLine } from '../types';
import {
  areLinesInSameGraphicBlock,
  estimateAverageLineHeight,
  normalizeRect,
  shouldSplitLines,
} from './geometry';
import type { LayoutBlock, LayoutLine } from './types';

type OcrLikeLine = {
  text?: string;
  confidence?: number;
  lineIndex?: number;
  boundingBox?: { x?: number; y?: number; width?: number; height?: number };
};

export function toLayoutLine(input: RawLine | OcrLikeLine, pageIndex = 0, fallbackIndex = 0): LayoutLine {
  const text = String(input.text ?? '').trim();
  const confidence = Number.isFinite(input.confidence) ? Number(input.confidence) : 0.5;
  const lineIndex = Number.isInteger(input.lineIndex) ? Number(input.lineIndex) : fallbackIndex;
  const rect = normalizeRect(input.boundingBox);
  const digits = text.replace(/\D/g, '').length;
  const letters = text.replace(/[^A-Za-z]/g, '').length;
  const upper = text.replace(/[^A-Z]/g, '').length;

  return {
    text,
    confidence,
    lineIndex,
    pageIndex,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    centerX: rect.x + rect.width / 2,
    centerY: rect.y + rect.height / 2,
    numericDensity: text.length > 0 ? digits / text.length : 0,
    uppercaseRatio: letters > 0 ? upper / letters : 0,
  };
}

function sortLinesTopToBottom(lines: LayoutLine[]): LayoutLine[] {
  return [...lines].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    if (Math.abs(a.y - b.y) > 4) return a.y - b.y;
    return a.x - b.x;
  });
}

function createBlockFromLines(id: string, lines: LayoutLine[]): LayoutBlock {
  const sorted = sortLinesTopToBottom(lines);
  const x = Math.min(...sorted.map((l) => l.x));
  const y = Math.min(...sorted.map((l) => l.y));
  const right = Math.max(...sorted.map((l) => l.right));
  const bottom = Math.max(...sorted.map((l) => l.bottom));
  const sourceLineIndices = [...new Set(sorted.map((l) => l.lineIndex))].sort((a, b) => a - b);
  const avgConfidence =
    sorted.reduce((acc, cur) => acc + (Number.isFinite(cur.confidence) ? cur.confidence : 0), 0) /
    Math.max(1, sorted.length);
  const avgNumericDensity =
    sorted.reduce((acc, cur) => acc + cur.numericDensity, 0) / Math.max(1, sorted.length);
  const avgUppercaseRatio =
    sorted.reduce((acc, cur) => acc + cur.uppercaseRatio, 0) / Math.max(1, sorted.length);

  return {
    id,
    pageIndex: sorted[0]?.pageIndex ?? 0,
    lines: sorted,
    sourceLineIndices,
    x,
    y,
    width: right - x,
    height: bottom - y,
    right,
    bottom,
    kind: 'unknown',
    confidence: 0,
    reasons: [],
    features: {
      lineCount: sorted.length,
      avgConfidence,
      avgNumericDensity,
      avgUppercaseRatio,
      hasEmail: false,
      hasPhone: false,
      hasWebsite: false,
      hasAddressHints: false,
      hasPostalCode: false,
      hasProvinceHint: false,
      hasLegalForm: false,
      hasRoleHints: false,
      hasCatalogNoise: false,
      verticalRank: 0,
    },
  };
}

export function groupLinesIntoBlocks(lines: LayoutLine[]): LayoutBlock[] {
  const ordered = sortLinesTopToBottom(lines).filter((l) => l.text.length > 0);
  if (!ordered.length) return [];

  const avgHeight = estimateAverageLineHeight(ordered);
  const groups: LayoutLine[][] = [];
  let current: LayoutLine[] = [ordered[0]];

  for (let i = 1; i < ordered.length; i++) {
    const line = ordered[i];
    const prev = current[current.length - 1];
    const semanticSplit = shouldSplitLines(prev, line, avgHeight);
    const sameGraphic = areLinesInSameGraphicBlock(prev, line, avgHeight);

    if (semanticSplit || !sameGraphic) {
      groups.push(current);
      current = [line];
      continue;
    }

    current.push(line);
  }
  groups.push(current);

  return groups.map((g, idx) => createBlockFromLines(`block-${idx + 1}`, g));
}

export function sortBlocksTopToBottom(blocks: LayoutBlock[]): LayoutBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    if (Math.abs(a.y - b.y) > 6) return a.y - b.y;
    return a.x - b.x;
  });
}

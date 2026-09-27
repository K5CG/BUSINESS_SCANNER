import { classifyBlocks } from './block-classifier';
import { groupLinesIntoBlocks, sortBlocksTopToBottom, toLayoutLine } from './blocks';
import type { BlockDetectionResult, LayoutBlock } from './types';
import type { RawLine } from '../types';
import { runtimeLogger } from '../../safe-runtime-logger';

function formatReasons(reasons: string[]): string {
  if (!reasons.length) return '-';
  return reasons.map((r) => `- ${r}`).join('\n');
}

function formatBlock(block: LayoutBlock): string {
  const header = `[${block.id}] kind=${block.kind} confidence=${block.confidence.toFixed(2)} lines=${block.lines.length}`;
  const bbox = `  bbox: x=${block.x.toFixed(1)} y=${block.y.toFixed(1)} w=${block.width.toFixed(1)} h=${block.height.toFixed(1)}`;
  const indices = `  sourceLineIndices: [${block.sourceLineIndices.join(', ')}]`;
  const lineDump = block.lines.map((l) => `  - (${l.lineIndex}) ${l.text}`).join('\n');
  const reasons = `  reasons:\n${formatReasons(block.reasons)
    .split('\n')
    .map((r) => `    ${r}`)
    .join('\n')}`;
  return `${header}\n${bbox}\n${indices}\n${lineDump}\n${reasons}`;
}

export function renderBlocksDebug(result: BlockDetectionResult): string {
  const sections: string[] = [];
  sections.push(`Blocks detected: ${result.blocks.length}`);
  for (const block of result.blocks) {
    sections.push(formatBlock(block));
  }
  sections.push(`possibleCompanyBlockId: ${result.possibleCompanyBlockId ?? '(none)'}`);
  sections.push(`possibleIdentityBlockId: ${result.possibleIdentityBlockId ?? '(none)'}`);
  sections.push(`possibleContactBlockId: ${result.possibleContactBlockId ?? '(none)'}`);
  return sections.join('\n\n');
}

export function printBlocksDebug(result: BlockDetectionResult): void {
  if (!__DEV__) return;
  runtimeLogger.debug(
    'PARSER_LAYOUT_DIAGNOSTIC',
    {
      status: 'completed',
      stage: 'parse',
      source: 'local',
      count: result.blocks.length,
    },
    renderBlocksDebug(result)
  );
}

type PageLike = {
  lines: Array<{
    text?: string;
    confidence?: number;
    lineIndex?: number;
    boundingBox?: { x?: number; y?: number; width?: number; height?: number };
  }>;
};

/** Esegue il layout detector su righe OCR con indici globali (multi-pagina). */
export function detectLayoutFromPages(pages: PageLike[]): BlockDetectionResult {
  let offset = 0;
  const layoutLines = pages.flatMap((page, pageIndex) => {
    const remapped = page.lines.map((line, idx) => {
      const lineIndex = Number.isInteger(line.lineIndex) ? Number(line.lineIndex) + offset : offset + idx;
      return toLayoutLine({ ...line, lineIndex }, pageIndex, lineIndex);
    });
    offset += page.lines.length;
    return remapped;
  });
  const blocks = sortBlocksTopToBottom(groupLinesIntoBlocks(layoutLines));
  return classifyBlocks(blocks);
}

/** Layout detector su singola pagina già normalizzata. */
export function detectLayoutFromRawLines(lines: RawLine[], pageIndex = 0): BlockDetectionResult {
  const layoutLines = lines.map((line) => toLayoutLine(line, pageIndex, line.lineIndex));
  const blocks = sortBlocksTopToBottom(groupLinesIntoBlocks(layoutLines));
  return classifyBlocks(blocks);
}

export function listCompanyLayoutBlocks(result: BlockDetectionResult): LayoutBlock[] {
  return result.blocks.filter((block) => block.kind === 'company');
}

export function renderLayoutCompanyCandidatesDebug(
  result: BlockDetectionResult,
  candidates: Array<{ value: string; sourceLineIndices: number[]; extractor: string }>
): string {
  const companyBlocks = listCompanyLayoutBlocks(result);
  const sections: string[] = [
    `Layout company blocks: ${companyBlocks.length}`,
    ...companyBlocks.map((block) => formatBlock(block)),
    `Layout-assisted company candidates: ${candidates.length}`,
    ...candidates.map(
      (c) =>
        `  - [${c.extractor}] "${c.value}" lines=[${c.sourceLineIndices.join(', ')}]`
    ),
  ];
  return sections.join('\n\n');
}

import type { Phone } from '../../types';
import type { CardPageV5 } from './engine';
import type {
  PageCoherenceDecision,
  PageCoherenceResult,
} from './page-coherence';

export type PageDisposition = 'included' | 'excluded' | 'pending';

export interface IncludedPagesContext<TLine extends { page: number; text: string }> {
  includedPageIndexes: number[];
  excludedPageIndexes: number[];
  pendingPageIndexes: number[];
  includedPages: CardPageV5[];
  includedLines: TLine[];
  includedRawText: string;
  /**
   * Input effettivo del parser. Per una decisione ambiguous resta limitato a
   * una sola pagina primaria, senza alterare la partizione pending.
   */
  extractionPageIndexes: number[];
  extractionLines: TLine[];
  extractionRawText: string;
  includedEmails: string[];
  includedPhones: Phone[];
  includedWebsites: string[];
  includedVatCandidates: string[];
  includedTaxCodeCandidates: string[];
  decision: PageCoherenceDecision;
  reason: string;
  decisionReasons: string[];
  confidence: number;
  requiresReview: boolean;
}

export interface IncludedStructuredCandidates {
  emails: string[];
  phones: Phone[];
  websites: Iterable<string>;
  vatCandidates: string[];
  taxCodeCandidates: string[];
}

function orderedUniqueIndexes(indexes: number[], pageCount: number): number[] {
  return [...new Set(indexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < pageCount)
    .sort((a, b) => a - b);
}

function partitionPages(
  pageCount: number,
  coherence: PageCoherenceResult
): {
  included: number[];
  excluded: number[];
  pending: number[];
} {
  const all = Array.from({ length: pageCount }, (_, index) => index);
  if (coherence.decision === 'ambiguous') {
    return { included: [], excluded: [], pending: all };
  }

  const requestedIncluded = coherence.includedPages.length
    ? coherence.includedPages
    : coherence.activePages;
  const included = orderedUniqueIndexes(requestedIncluded, pageCount);
  const includedSet = new Set(included);
  const requestedExcluded = orderedUniqueIndexes(coherence.excludedPages, pageCount)
    .filter((index) => !includedSet.has(index));
  const excluded = coherence.decision === 'mismatch'
    ? orderedUniqueIndexes(
        [...requestedExcluded, ...all.filter((index) => !includedSet.has(index))],
        pageCount
      )
    : [];

  return { included, excluded, pending: [] };
}

function pageText<TLine extends { page: number; text: string }>(
  page: CardPageV5,
  pageIndex: number,
  includedLines: TLine[]
): string {
  const rawText = page.rawText?.trim() ?? '';
  if (rawText) return rawText;
  return includedLines
    .filter((line) => line.page === pageIndex)
    .map((line) => line.text)
    .join('\n')
    .trim();
}

function extractionPageIndexes<TLine extends { page: number; text: string }>(
  pages: CardPageV5[],
  allLines: TLine[],
  coherence: PageCoherenceResult,
  includedPageIndexes: number[]
): number[] {
  if (coherence.decision !== 'ambiguous') {
    return [...includedPageIndexes];
  }

  const nonEmptyPageIndexes = pages
    .map((page, pageIndex) =>
      pageText(page, pageIndex, allLines) ? pageIndex : null
    )
    .filter((pageIndex): pageIndex is number => pageIndex !== null);
  if (!nonEmptyPageIndexes.length) return [];

  const reasonsText = coherence.decisionReasons.join(' ').toLocaleLowerCase();
  const hasConflictReason = /(?:incompatibil|contradditt|persone\s+distinte|identit[aà]\s+personali)/iu.test(reasonsText);
  const insufficiencyOnly = /evidenze\s+insufficienti/iu.test(reasonsText) && !hasConflictReason;
  const substantivePendingPages = nonEmptyPageIndexes.every((pageIndex) => {
    const text = pageText(pages[pageIndex], pageIndex, allLines);
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length >= 2;
  });

  // Se la coerenza è ambigua solo perché mancano prove di collegamento, ma
  // tutte le facciate contengono contenuto sostanziale e NON c'è conflitto,
  // il parser può usare le pagine come evidenza complementare mantenendo
  // comunque decision='ambiguous' e requiresReview=true. Questo evita di
  // perdere il fronte di un biglietto solo perché il retro contiene contatti.
  if (insufficiencyOnly && substantivePendingPages && nonEmptyPageIndexes.length >= 2) {
    return nonEmptyPageIndexes;
  }

  return [
    nonEmptyPageIndexes.includes(coherence.primaryPage)
      ? coherence.primaryPage
      : nonEmptyPageIndexes[0],
  ];
}

export function createIncludedPagesContext<TLine extends { page: number; text: string }>(
  pages: CardPageV5[],
  allLines: TLine[],
  coherence: PageCoherenceResult
): IncludedPagesContext<TLine> {
  const partition = partitionPages(pages.length, coherence);
  const includedSet = new Set(partition.included);
  const includedLines = allLines.filter((line) => includedSet.has(line.page));
  const includedPages = partition.included.map((index) => pages[index]).filter(Boolean);
  const includedRawText = partition.included
    .map((index) => pageText(pages[index], index, includedLines))
    .filter(Boolean)
    .join('\n\n');
  const parserPageIndexes = extractionPageIndexes(
    pages,
    allLines,
    coherence,
    partition.included
  );
  const parserPageSet = new Set(parserPageIndexes);
  const extractionLines = allLines.filter((line) =>
    parserPageSet.has(line.page)
  );
  const extractionRawText = parserPageIndexes
    .map((index) => pageText(pages[index], index, extractionLines))
    .filter(Boolean)
    .join('\n\n');
  const decisionReasons = [...coherence.decisionReasons];

  return {
    includedPageIndexes: partition.included,
    excludedPageIndexes: partition.excluded,
    pendingPageIndexes: partition.pending,
    includedPages,
    includedLines,
    includedRawText,
    extractionPageIndexes: parserPageIndexes,
    extractionLines,
    extractionRawText,
    includedEmails: [],
    includedPhones: [],
    includedWebsites: [],
    includedVatCandidates: [],
    includedTaxCodeCandidates: [],
    decision: coherence.decision,
    reason: decisionReasons.join('; '),
    decisionReasons,
    confidence: coherence.confidence,
    requiresReview: coherence.requiresReview || coherence.decision === 'ambiguous',
  };
}

export function setIncludedStructuredCandidates<TLine extends { page: number; text: string }>(
  context: IncludedPagesContext<TLine>,
  candidates: IncludedStructuredCandidates
): void {
  context.includedEmails = [...candidates.emails];
  context.includedPhones = [...candidates.phones];
  context.includedWebsites = [...candidates.websites];
  context.includedVatCandidates = [...candidates.vatCandidates];
  context.includedTaxCodeCandidates = [...candidates.taxCodeCandidates];
}

export function pageDisposition<TLine extends { page: number; text: string }>(
  context: IncludedPagesContext<TLine>,
  pageIndex: number
): PageDisposition {
  if (context.includedPageIndexes.includes(pageIndex)) return 'included';
  if (context.excludedPageIndexes.includes(pageIndex)) return 'excluded';
  return 'pending';
}

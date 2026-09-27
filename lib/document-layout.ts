import type { OcrLine } from '../types';
import type {
  DocumentBoundingBox,
  DocumentLayoutLine,
  DocumentLayoutZone,
  DocumentZoneClassification,
  StructuredDocumentPage,
} from './document-structure';
import { detectDocumentTableColumn, detectDocumentTableColumnFast, parseDocumentAmount } from './document-items-totals';
import { yieldToOperationEventLoop } from './scan-operation-lifecycle';
import {
  CLASSIFY_LINES_CHECK_EVERY,
  createLayoutDeadline,
  layoutDeadlineExceeded,
  logClassifyPerf,
  logRegionPerf,
  logStructuredLayout,
  MAX_CLUSTER_ITERATIONS,
  MAX_GEOMETRIC_GROUPS,
  MAX_GEOMETRIC_SIGNALS,
  MAX_LAYOUT_LINES,
  MAX_PAIR_COMPARISONS,
  logStructuredLayoutPerf,
  logTableBandPerf,
  REGIONS_BUDGET_MS,
  resolveEffectiveDeadline,
  StructuredLayoutTimeoutError,
  STRUCTURED_LAYOUT_DEADLINE_MS,
  TABLE_BAND_BUDGET_MS,
  TABLE_PRECHECK_BUDGET_MS,
} from './structured-layout-runtime';
import { layoutBudgetForPage } from './structured-extraction-budget';

interface LayoutPageLabelCache {
  tableColumn: Map<string, ReturnType<typeof detectDocumentTableColumn>>;
}

function createLayoutPageLabelCache(): LayoutPageLabelCache {
  return { tableColumn: new Map() };
}

export interface DocumentLayoutPageInput {
  pageIndex: number;
  lines: readonly OcrLine[];
  rawText: string;
  width?: number;
  height?: number;
  rotationDegrees?: 0 | 90 | 180 | 270;
  ocrCanvasWidth?: number;
  ocrCanvasHeight?: number;
}

function normalizedPageDimensions(input: DocumentLayoutPageInput): { width?: number; height?: number } {
  let width = input.ocrCanvasWidth ?? input.width;
  let height = input.ocrCanvasHeight ?? input.height;
  if (!width || !height) return { width, height };
  const boxes = input.lines.flatMap((line) => finiteBox(line.boundingBox) ? [finiteBox(line.boundingBox)!] : []);
  const maxRight = Math.max(0, ...boxes.map((box) => box.x + box.width));
  const maxBottom = Math.max(0, ...boxes.map((box) => box.y + box.height));
  const requiredScale = Math.max(maxRight / width, maxBottom / height);
  if (requiredScale > 1.03) {
    const rounded = Math.round(requiredScale);
    const scale = rounded >= 2 && Math.abs(requiredScale - rounded) <= 0.15
      ? Math.min(4, rounded)
      : Math.min(4, requiredScale);
    width *= scale;
    height *= scale;
  }
  return { width: Math.max(width, maxRight), height: Math.max(height, maxBottom) };
}

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/\s+/g, ' ')
    .trim();
}

function finiteBox(value: OcrLine['boundingBox']): DocumentBoundingBox | undefined {
  if (!value) return undefined;
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite)) return undefined;
  if (value.width < 0 || value.height < 0) return undefined;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function readingOrder(lines: readonly OcrLine[]): OcrLine[] {
  const withIndex = lines.map((line, index) => ({ line, index }));
  if (!withIndex.some(({ line }) => finiteBox(line.boundingBox))) return withIndex.map(({ line }) => line);
  return withIndex
    .sort((a, b) => {
      const aa = finiteBox(a.line.boundingBox);
      const bb = finiteBox(b.line.boundingBox);
      if (!aa && !bb) return a.index - b.index;
      if (!aa) return 1;
      if (!bb) return -1;
      const rowTolerance = Math.max(8, Math.min(aa.height || 8, bb.height || 8) * 0.7);
      if (Math.abs(aa.y - bb.y) > rowTolerance) return aa.y - bb.y;
      return aa.x - bb.x;
    })
    .map(({ line }) => line);
}

export function buildDocumentLayoutLines(input: DocumentLayoutPageInput): DocumentLayoutLine[] {
  // scanBestAtAngles ruota fisicamente il bitmap prima di ML Kit: box ed
  // elementi sono quindi gia nel canvas leggibile dell'OCR. Ruotarli ancora
  // qui li portava fuori pagina (in particolare quando Android esponeva una
  // dimensione RN pari a meta del bitmap nativo).
  const normalizedLines = input.lines.map((line) => ({ ...line }));
  const source: OcrLine[] = input.lines.length > 0
    ? readingOrder(normalizedLines)
    : input.rawText.split(/\r?\n/).filter((line) => line.trim()).map((text) => ({ text, confidence: 0 }));
  return source
    .map((line, readingIndex) => ({
      id: `p${input.pageIndex + 1}-l${readingIndex + 1}`,
      pageIndex: input.pageIndex,
      readingOrder: readingIndex,
      text: line.text.trim(),
      ...(finiteBox(line.boundingBox) ? { boundingBox: finiteBox(line.boundingBox) } : {}),
      ...(line.blockIndex !== undefined ? { blockIndex: line.blockIndex } : {}),
      ...(line.lineIndex !== undefined ? { lineIndex: line.lineIndex } : {}),
      ...(line.elements ? { elements: line.elements } : {}),
    }))
    .filter((line) => line.text.length > 0);
}

function tableHeaderScore(text: string): number {
  if (/\b(?:p\.?\s*iva|partita\s+iva|cod(?:ice)?\s+fisc|cap\s+soc|registro\s+imprese)\b/i.test(text)) {
    return 0;
  }
  const labels = [
    /\b(?:codice|cod\.?|articolo|code|sku)\b/,
    /\b(?:descrizione|description|desc\.?)\b/,
    /\b(?:q\.?ta|qta|quantita|quantity|menge)\b/,
    /\b(?:um|u\.?m\.?|unita|unit|einheit)\b/,
    /\b(?:prezzo|price|precio|unit price)\b/,
    /\b(?:sconto|discount|descuento)\b/,
    /\b(?:iva|vat|tva|mwst)\b/,
    /\b(?:importo|totale|amount|line total|totale riga)\b/,
  ];
  return labels.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
}

function cheapTableSignalPrecheck(
  lines: readonly DocumentLayoutLine[],
  deadline?: number,
): { sufficient: boolean; signalCount: number; kindCount: number } {
  const started = Date.now();
  const precheckDeadline = resolveEffectiveDeadline({
    started,
    processDeadline: deadline,
    localBudgetMs: TABLE_PRECHECK_BUDGET_MS,
  });
  const kinds = new Set<NonNullable<ReturnType<typeof detectDocumentTableColumnFast>>>();
  let signalCount = 0;
  for (const line of lines) {
    if (layoutDeadlineExceeded(precheckDeadline)) break;
    if (line.text.length > 36) continue;
    const kind = detectDocumentTableColumnFast(line.text);
    if (!kind) continue;
    signalCount += 1;
    kinds.add(kind);
    if (kinds.size >= 2 && signalCount >= 4) {
      return { sufficient: true, signalCount, kindCount: kinds.size };
    }
  }
  return { sufficient: kinds.size >= 2 && signalCount >= 2, signalCount, kindCount: kinds.size };
}

interface GeometricTableBand {
  headerLineIds: Set<string>;
  startY: number;
  endY: number;
}

function clusterByYBucket<T extends { line: DocumentLayoutLine }>(
  items: readonly T[],
  tolerance: number,
  maxGroups: number,
): T[][] {
  const buckets = new Map<number, T[]>();
  for (const item of items) {
    const y = item.line.boundingBox!.y;
    const key = Math.round(y / tolerance);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(item);
      continue;
    }
    if (buckets.size >= maxGroups) continue;
    buckets.set(key, [item]);
  }
  return [...buckets.values()];
}

function clusterLinesByX(
  lines: readonly DocumentLayoutLine[],
  tolerance: number,
  maxGroups: number,
): DocumentLayoutLine[][] {
  const buckets = new Map<number, DocumentLayoutLine[]>();
  for (const line of lines) {
    if (!line.boundingBox) continue;
    const key = Math.round(line.boundingBox.x / tolerance);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(line);
      continue;
    }
    if (buckets.size >= maxGroups) continue;
    buckets.set(key, [line]);
  }
  return [...buckets.values()];
}

function clusterLinesByY(
  lines: readonly DocumentLayoutLine[],
  tolerance: number,
  maxGroups: number,
): DocumentLayoutLine[][] {
  const buckets = new Map<number, DocumentLayoutLine[]>();
  for (const line of lines) {
    if (!line.boundingBox) continue;
    const key = Math.round(line.boundingBox.y / tolerance);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(line);
      continue;
    }
    if (buckets.size >= maxGroups) continue;
    buckets.set(key, [line]);
  }
  return [...buckets.values()];
}

function cachedTableColumnFast(cache: LayoutPageLabelCache, text: string) {
  const hit = cache.tableColumn.get(`fast:${text}`);
  if (hit !== undefined) return hit;
  const value = detectDocumentTableColumnFast(text) ?? detectDocumentTableColumn(text);
  cache.tableColumn.set(`fast:${text}`, value);
  cache.tableColumn.set(text, value);
  return value;
}

function geometricTableBand(
  lines: readonly DocumentLayoutLine[],
  pageHeight: number,
  cache: LayoutPageLabelCache,
  deadline?: number,
): GeometricTableBand | undefined {
  const started = Date.now();
  const tableBandDeadline = resolveEffectiveDeadline({
    started,
    processDeadline: deadline,
    localBudgetMs: TABLE_BAND_BUDGET_MS,
  });
  const timedOut = () => layoutDeadlineExceeded(tableBandDeadline);
  logTableBandPerf('start', { lines: lines.length });

  const precheck = cheapTableSignalPrecheck(lines, tableBandDeadline);
  logTableBandPerf('precheck', {
    sufficient: precheck.sufficient,
    signals: precheck.signalCount,
    kinds: precheck.kindCount,
    ms: Date.now() - started,
  });
  if (!precheck.sufficient || timedOut()) {
    logTableBandPerf('done', { ms: Date.now() - started, result: 'insufficient_signals' });
    return undefined;
  }

  const signals: Array<{ line: DocumentLayoutLine; kind: NonNullable<ReturnType<typeof detectDocumentTableColumn>> }> = [];
  for (const line of lines) {
    if (timedOut() || signals.length >= MAX_GEOMETRIC_SIGNALS) break;
    if (line.text.length > 36 || !line.boundingBox) continue;
    const kind = cachedTableColumnFast(cache, line.text);
    if (kind) signals.push({ line, kind });
  }
  logTableBandPerf('candidate_lines', { signals: signals.length });
  if (signals.length < 2 || timedOut()) {
    logTableBandPerf('done', { ms: Date.now() - started, result: 'insufficient_signals' });
    return undefined;
  }

  const tolerance = Math.max(55, pageHeight * 0.035);
  const groups = clusterByYBucket(
    [...signals].sort((left, right) => left.line.boundingBox!.y - right.line.boundingBox!.y),
    tolerance,
    MAX_GEOMETRIC_GROUPS,
  );
  logTableBandPerf('y_clusters', { groups: groups.length });

  const amountLines = lines.filter((line) =>
    line.boundingBox && parseDocumentAmount(line.text) !== undefined);
  logTableBandPerf('row_candidates', { amountLines: amountLines.length });

  const candidates = groups
    .filter((group) => new Set(group.map((signal) => signal.kind)).size >= 2)
    .sort((left, right) =>
      new Set(right.map((signal) => signal.kind)).size - new Set(left.map((signal) => signal.kind)).size)
    .slice(0, 3);
  logTableBandPerf('header_candidates', { candidates: candidates.length });

  const xTolerance = Math.max(30, pageHeight * 0.012);
  const yTolerance = Math.max(35, pageHeight * 0.018);
  let pairComparisons = 0;

  for (const header of candidates) {
    if (timedOut()) break;
    const headerY = Math.min(...header.map((signal) => signal.line.boundingBox!.y));
    const headerBottom = Math.max(...header.map((signal) =>
      signal.line.boundingBox!.y + signal.line.boundingBox!.height));
    const numeric = amountLines.filter((line) => {
      pairComparisons += 1;
      return line.boundingBox!.y >= headerY - tolerance * 0.5 &&
        line.boundingBox!.y <= headerBottom + pageHeight * 0.22;
    });
    if (numeric.length === 0) continue;

    const xClusters = clusterLinesByX(
      numeric,
      xTolerance,
      MAX_GEOMETRIC_GROUPS,
    );
    const yGroups = clusterLinesByY(
      numeric,
      yTolerance,
      MAX_GEOMETRIC_GROUPS,
    );
    logTableBandPerf('x_clusters', { xClusters: xClusters.length, pairComparisons });
    const numericColumns = xClusters.filter((cluster) => cluster.length >= 2).length;
    const dataRows = yGroups.filter((group) => group.length >= 2).length;
    if (numericColumns < 2 || dataRows < 2) continue;

    let firstBoundaryY: number | undefined;
    for (const line of lines) {
      if (timedOut()) break;
      if (!line.boundingBox || line.boundingBox.y <= headerBottom) continue;
      if (
        /\b(?:condizioni|note|terms|total\s+ttc|total\s+ht|totale|payment|delivery)\b/i.test(line.text)
      ) {
        firstBoundaryY = line.boundingBox.y;
        break;
      }
    }
    logTableBandPerf('done', {
      ms: Date.now() - started,
      result: 'band_found',
      pairComparisons,
      cluster_iterations: xClusters.length + yGroups.length,
    });
    return {
      headerLineIds: new Set(header.map((signal) => signal.line.id)),
      startY: Math.max(0, headerY - tolerance),
      endY: firstBoundaryY ?? Math.min(pageHeight * 0.84, headerBottom + pageHeight * 0.35),
    };
  }

  logTableBandPerf('done', { ms: Date.now() - started, result: 'none', pairComparisons });
  return undefined;
}

interface Classification {
  kind: DocumentZoneClassification;
  reasons: string[];
  requiresReview: boolean;
}

const RE_PAYMENT = /\b(?:iban|bic|swift|coordinate bancarie|bank details)\b/i;
const RE_TOTAL = /\b(?:totale|total|importo totale|amount due|total due|grand total)\b/i;
const RE_CUSTOMER =
  /(?:fatturare\s+a|bill\s+to|ship\s+to|sold\s+to|billed\s+to|spett\.?\s*le|datos\s+del\s+cliente|dati\s+(?:del\s+)?cliente)|^(?:cliente|customer|destinatario)\s*[:\/]/i;
const RE_SUBJECT = /\b(?:oggetto|0ggetto|subject)\s*:/i;
const RE_ISSUER = /\b(?:s\.?r\.?l|s\.?p\.?a|partita iva|p\.?\s*iva|vat\s*(?:no|number|id)|www\.|@)\b/i;
const RE_TAX = /\b(?:imponibile|taxable|subtotal|subtotale|iva|vat|tva|mwst|aliquota|tax amount|vat amount|esente|non imponibile|reverse charge)\b/i;
const RE_METADATA = /\b(?:n[°º.]?\s*(?:preventivo|fattura|ordine|invoice|order|quote|offerta|documento|document)|numero|number|nr\.?|data|date|datum|fecha|emissione|issue date|due date|scadenza|validit[aà]|valid until|due|fattura|invoice|preventivo|quotation|ordine|order|angebot|presupuesto)\b/i;
const RE_NOTES = /\b(?:condizioni|note|terms|annotazioni|payment terms|delivery terms|lieferbedingungen|condizioni di pagamento)\b/i;

interface LayoutLineFeatures {
  line: DocumentLayoutLine;
  normalizedText: string;
  centerY?: number;
  inHeaderBand: boolean;
  inTableBody: boolean;
}

function buildLayoutLineFeatures(context: LayoutPageClassificationContext): LayoutLineFeatures[] {
  const headerBandTolerance = Math.max(45, context.pageHeight * 0.04);
  const pageHeight = context.dimensions.height ?? context.pageHeight;
  const summaryCap = context.summaryY ?? (context.dimensions.height ?? Number.POSITIVE_INFINITY) * 0.82;
  return context.lines.map((line) => {
    const box = line.boundingBox;
    const centerY = box && pageHeight > 0 ? (box.y + box.height / 2) / pageHeight : undefined;
    const inHeaderBand = context.strongTableBand?.headerLineIds.has(line.id)
      || (context.tableHeaderY !== undefined && !!box
        && Math.abs(box.y - context.tableHeaderY) <= headerBandTolerance
        && context.headerCandidateIds.has(line.id));
    const inTableBody = !!box && (context.strongTableBand
      ? box.y >= context.strongTableBand.startY && box.y < context.strongTableBand.endY
      : context.tableHeaderBottom !== undefined
        && box.y > context.tableHeaderBottom
        && box.y < summaryCap);
    return {
      line,
      normalizedText: normalized(line.text),
      centerY,
      inHeaderBand,
      inTableBody,
    };
  });
}

function explicitClassificationFast(
  text: string,
  headerScoreCache: Map<string, number>,
): Classification | undefined {
  let headerScore = headerScoreCache.get(text);
  if (headerScore === undefined) {
    headerScore = tableHeaderScore(text);
    headerScoreCache.set(text, headerScore);
  }
  if (headerScore >= 2) {
    return { kind: 'items_table', reasons: ['table_header_labels'], requiresReview: false };
  }
  if (RE_PAYMENT.test(text)) {
    return { kind: 'payment', reasons: ['payment_anchor'], requiresReview: false };
  }
  if (RE_TOTAL.test(text)) {
    return { kind: 'totals', reasons: ['total_anchor'], requiresReview: false };
  }
  if (RE_CUSTOMER.test(text)) {
    return { kind: 'customer', reasons: ['customer_anchor'], requiresReview: false };
  }
  if (RE_SUBJECT.test(text)) {
    return { kind: 'subject', reasons: ['subject_anchor'], requiresReview: false };
  }
  if (RE_ISSUER.test(text)) {
    return { kind: 'issuer', reasons: ['issuer_identity_signal'], requiresReview: true };
  }
  if (RE_TAX.test(text)) {
    return { kind: 'tax_summary', reasons: ['tax_anchor'], requiresReview: false };
  }
  if (RE_METADATA.test(text)) {
    return { kind: 'metadata', reasons: ['metadata_anchor'], requiresReview: false };
  }
  if (RE_NOTES.test(text)) {
    return { kind: 'notes', reasons: ['notes_anchor'], requiresReview: false };
  }
  return undefined;
}

function geometryClassificationFromFeatures(features: LayoutLineFeatures): Classification | undefined {
  if (features.centerY === undefined) return undefined;
  if (features.centerY <= 0.16) return { kind: 'header', reasons: ['upper_page_geometry'], requiresReview: true };
  if (features.centerY >= 0.84) return { kind: 'footer', reasons: ['lower_page_geometry'], requiresReview: true };
  return undefined;
}

function unionBoxes(lines: readonly DocumentLayoutLine[]): DocumentBoundingBox | undefined {
  const boxes = lines.flatMap((line) => line.boundingBox ? [line.boundingBox] : []);
  if (boxes.length === 0) return undefined;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

export class LayoutClassificationAbortedError extends Error {
  constructor() {
    super('LAYOUT_CLASSIFICATION_ABORTED');
    this.name = 'LayoutClassificationAbortedError';
  }
}

interface LayoutPageClassificationContext {
  input: DocumentLayoutPageInput;
  lines: DocumentLayoutLine[];
  dimensions: ReturnType<typeof normalizedPageDimensions>;
  pageInput: DocumentLayoutPageInput;
  pageHeight: number;
  strongTableBand: ReturnType<typeof geometricTableBand>;
  tableHeaderY: number | undefined;
  tableHeaderBottom: number | undefined;
  summaryY: number | undefined;
  headerCandidateIds: Set<string>;
  labelCache: LayoutPageLabelCache;
}

interface LayoutLineClassificationState {
  tableActive: boolean;
  customerContext: number;
}

interface RegionHints {
  headerCandidateIds: Set<string>;
  tableHeaderY: number | undefined;
  tableHeaderBottom: number | undefined;
  summaryY: number | undefined;
  timedOut: boolean;
}

const SUMMARY_LABEL_RE = /\b(?:subtotale|subtotal|imponibile|taxable|totale|total|netto|net amount|total ht|total ttc)\b/i;

function computeRegionHints(
  lines: readonly DocumentLayoutLine[],
  pageHeight: number,
  deadline?: number,
): RegionHints {
  const started = Date.now();
  const regionsDeadline = resolveEffectiveDeadline({
    started,
    processDeadline: deadline,
    localBudgetMs: REGIONS_BUDGET_MS,
  });
  const timedOut = () => layoutDeadlineExceeded(regionsDeadline);
  logRegionPerf('start', { lines: lines.length });

  const buildStarted = Date.now();
  const headerCandidates: DocumentLayoutLine[] = [];
  for (const line of lines) {
    if (timedOut()) break;
    if (!line.boundingBox || line.text.length > 36) continue;
    if (detectDocumentTableColumnFast(line.text)) headerCandidates.push(line);
  }
  logRegionPerf('buildCandidates', {
    count: headerCandidates.length,
    ms: Date.now() - buildStarted,
  });

  const headerCandidateIds = new Set(headerCandidates.map((line) => line.id));
  const tableHeaderY = headerCandidates.length >= 4
    ? Math.min(...headerCandidates.map((line) => line.boundingBox?.y ?? Number.POSITIVE_INFINITY))
    : undefined;
  const headerBandTolerance = Math.max(45, pageHeight * 0.04);

  const mergeStarted = Date.now();
  let tableHeaderBottom: number | undefined;
  if (tableHeaderY !== undefined) {
    let bottom = tableHeaderY;
    for (const line of headerCandidates) {
      if (timedOut()) break;
      const y = line.boundingBox?.y ?? 0;
      if (Math.abs(y - tableHeaderY) > headerBandTolerance) continue;
      bottom = Math.max(bottom, y + (line.boundingBox?.height ?? 0));
    }
    tableHeaderBottom = bottom;
  }
  logRegionPerf('mergeRegions', {
    before: headerCandidates.length,
    after: tableHeaderBottom === undefined ? 0 : 1,
    ms: Date.now() - mergeStarted,
  });

  const classifyStarted = Date.now();
  let summaryY: number | undefined;
  if (tableHeaderBottom !== undefined) {
    const summaryThreshold = tableHeaderBottom + Math.max(70, pageHeight * 0.06);
    let minY = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      if (timedOut()) break;
      const y = line.boundingBox?.y ?? 0;
      if (y <= summaryThreshold) continue;
      if (!SUMMARY_LABEL_RE.test(line.text)) continue;
      minY = Math.min(minY, y);
    }
    if (Number.isFinite(minY)) summaryY = minY;
  }
  logRegionPerf('classify', { count: summaryY === undefined ? 0 : 1, ms: Date.now() - classifyStarted });
  logRegionPerf('done', { ms: Date.now() - started, timedOut: timedOut() });

  return {
    headerCandidateIds,
    tableHeaderY,
    tableHeaderBottom,
    summaryY,
    timedOut: timedOut(),
  };
}

function partialLayoutPage(
  input: DocumentLayoutPageInput,
  lines: DocumentLayoutLine[],
  startedMs: number,
  reason = 'structured_layout_timeout',
): StructuredDocumentPage {
  logStructuredLayout('done', { partial: true, reason, ms: Date.now() - startedMs, lines: lines.length });
  const dimensions = normalizedPageDimensions(input);
  return {
    pageIndex: input.pageIndex,
    ...(dimensions.width !== undefined ? { width: dimensions.width } : {}),
    ...(dimensions.height !== undefined ? { height: dimensions.height } : {}),
    lines,
    zones: [],
    status: 'partial',
    complete: false,
    requiresRescan: false,
    reasons: [reason],
  };
}

function prepareLayoutPageClassificationContext(
  input: DocumentLayoutPageInput,
  preparedLines?: readonly DocumentLayoutLine[],
  deadline?: number,
): LayoutPageClassificationContext {
  const started = Date.now();
  const labelCache = createLayoutPageLabelCache();
  const buildStarted = Date.now();
  const lines = (preparedLines ?? buildDocumentLayoutLines(input)).slice(0, MAX_LAYOUT_LINES);
  logStructuredLayoutPerf('build_lines', Date.now() - buildStarted, { lines: lines.length });
  if (layoutDeadlineExceeded(deadline)) {
    throw new StructuredLayoutTimeoutError();
  }
  const normalizeStarted = Date.now();
  const dimensions = normalizedPageDimensions(input);
  const pageInput = { ...input, ...dimensions };
  const pageHeight = dimensions.height ?? input.height ?? 1400;
  logStructuredLayoutPerf('normalize', Date.now() - normalizeStarted);
  const tableBandStarted = Date.now();
  const tableBandDeadline = resolveEffectiveDeadline({
    started: tableBandStarted,
    processDeadline: deadline,
    localBudgetMs: TABLE_BAND_BUDGET_MS,
  });
  const tablePrecheck = cheapTableSignalPrecheck(lines, tableBandDeadline);
  const strongTableBand = tablePrecheck.sufficient
    ? geometricTableBand(lines, pageHeight, labelCache, deadline)
    : undefined;
  logStructuredLayoutPerf('table_band', Date.now() - tableBandStarted, {
    signals: tablePrecheck.signalCount,
    sufficient: tablePrecheck.sufficient,
  });
  if (layoutDeadlineExceeded(deadline)) {
    throw new StructuredLayoutTimeoutError();
  }
  const regionsStarted = Date.now();
  const regionHints = computeRegionHints(lines, pageHeight, deadline);
  if (regionHints.timedOut && layoutDeadlineExceeded(deadline)) {
    throw new StructuredLayoutTimeoutError();
  }
  logStructuredLayoutPerf('regions', Date.now() - regionsStarted, { timedOut: regionHints.timedOut });
  logStructuredLayoutPerf('total', Date.now() - started, { lines: lines.length });
  return {
    input,
    lines,
    dimensions,
    pageInput,
    pageHeight,
    strongTableBand,
    tableHeaderY: regionHints.tableHeaderY,
    tableHeaderBottom: regionHints.tableHeaderBottom,
    summaryY: regionHints.summaryY,
    headerCandidateIds: regionHints.headerCandidateIds,
    labelCache,
  };
}

function classifyLayoutFeature(
  features: LayoutLineFeatures,
  state: LayoutLineClassificationState,
  explicitCache: Map<string, Classification | undefined>,
  headerScoreCache: Map<string, number>,
): Classification {
  const detected = features.inHeaderBand || features.inTableBody
    ? { kind: 'items_table' as const, reasons: [features.inHeaderBand ? 'geometric_table_header' : 'within_geometric_table_bounds'], requiresReview: !features.inHeaderBand }
    : (() => {
      const cached = explicitCache.get(features.normalizedText);
      if (cached !== undefined) return cached;
      const value = explicitClassificationFast(features.normalizedText, headerScoreCache);
      explicitCache.set(features.normalizedText, value);
      return value;
    })();
  if (detected && ['metadata', 'items_table', 'tax_summary', 'totals', 'payment', 'notes'].includes(detected.kind)) {
    state.customerContext = 0;
  }
  const explicit = state.customerContext > 0 && (!detected || ['issuer', 'tax_summary'].includes(detected.kind))
    ? { kind: 'customer' as const, reasons: ['party_field_near_customer_anchor'], requiresReview: true }
    : detected;
  if (explicit?.kind === 'items_table') state.tableActive = true;
  if (explicit && ['totals', 'tax_summary', 'payment', 'notes'].includes(explicit.kind)) state.tableActive = false;
  if (explicit?.kind === 'customer') state.customerContext = 4;

  let classification = explicit;
  if (!classification && state.tableActive) {
    classification = { kind: 'items_table', reasons: ['within_table_bounds'], requiresReview: true };
  } else if (!classification && state.customerContext > 0) {
    classification = { kind: 'customer', reasons: ['near_customer_anchor'], requiresReview: true };
  }
  classification ??= geometryClassificationFromFeatures(features);
  classification ??= { kind: 'unknown', reasons: ['no_universal_zone_signal'], requiresReview: true };
  if (state.customerContext > 0) state.customerContext -= 1;
  return classification;
}

function classifyLayoutLines(
  context: LayoutPageClassificationContext,
  deadline?: number,
): Array<{ line: DocumentLayoutLine; classification: Classification }> {
  const started = Date.now();
  logClassifyPerf('start', { lines: context.lines.length });

  const featureStarted = Date.now();
  const features = buildLayoutLineFeatures(context);
  logClassifyPerf('featureExtraction', { count: features.length, ms: Date.now() - featureStarted });

  const state: LayoutLineClassificationState = { tableActive: false, customerContext: 0 };
  const explicitCache = new Map<string, Classification | undefined>();
  const headerScoreCache = new Map<string, number>();
  const classified: Array<{ line: DocumentLayoutLine; classification: Classification }> = [];

  const roleStarted = Date.now();
  for (let index = 0; index < features.length; index += 1) {
    if (index > 0 && index % CLASSIFY_LINES_CHECK_EVERY === 0 && layoutDeadlineExceeded(deadline)) {
      logClassifyPerf('done', { ms: Date.now() - started, timedOut: true, classified: classified.length });
      throw new StructuredLayoutTimeoutError();
    }
    const feature = features[index];
    classified.push({
      line: feature.line,
      classification: classifyLayoutFeature(feature, state, explicitCache, headerScoreCache),
    });
  }
  logClassifyPerf('lineTypeDetection', {
    count: classified.length,
    uniqueExplicit: explicitCache.size,
    ms: Date.now() - roleStarted,
  });
  logClassifyPerf('done', { ms: Date.now() - started, timedOut: false });
  return classified;
}

function finalizeLayoutPageClassification(
  context: LayoutPageClassificationContext,
  classified: Array<{ line: DocumentLayoutLine; classification: Classification }>,
): StructuredDocumentPage {
  const { input, lines, dimensions } = context;
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const zones: DocumentLayoutZone[] = [];
  for (const entry of classified) {
    const previous = zones.at(-1);
    if (previous?.classification === entry.classification.kind) {
      previous.lineIds.push(entry.line.id);
      previous.rawLines.push(entry.line.text);
      previous.reasons = [...new Set([...previous.reasons, ...entry.classification.reasons])];
      previous.requiresReview ||= entry.classification.requiresReview;
      const zoneLines = previous.lineIds
        .map((id) => lineById.get(id))
        .filter((line): line is DocumentLayoutLine => line != null);
      previous.boundingBox = unionBoxes(zoneLines);
      continue;
    }
    const zoneLines = [entry.line];
    zones.push({
      id: `p${input.pageIndex + 1}-z${zones.length + 1}`,
      pageIndex: input.pageIndex,
      ...(unionBoxes(zoneLines) ? { boundingBox: unionBoxes(zoneLines) } : {}),
      lineIds: [entry.line.id],
      rawLines: [entry.line.text],
      classification: entry.classification.kind,
      reasons: [...entry.classification.reasons],
      requiresReview: entry.classification.requiresReview,
    });
  }

  return {
    pageIndex: input.pageIndex,
    ...(dimensions.width !== undefined ? { width: dimensions.width } : {}),
    ...(dimensions.height !== undefined ? { height: dimensions.height } : {}),
    lines,
    zones,
    status: 'partial',
    complete: false,
    requiresRescan: false,
    reasons: ['completeness_not_evaluated'],
  };
}

export function classifyDocumentLayoutPage(
  input: DocumentLayoutPageInput,
  deadline?: number,
): StructuredDocumentPage {
  const context = prepareLayoutPageClassificationContext(input, undefined, deadline);
  let classified: Array<{ line: DocumentLayoutLine; classification: Classification }>;
  try {
    classified = classifyLayoutLines(context, deadline);
  } catch (error) {
    if (error instanceof StructuredLayoutTimeoutError) {
      return partialLayoutPage(input, context.lines, Date.now(), 'structured_layout_timeout');
    }
    throw error;
  }
  return finalizeLayoutPageClassification(context, classified);
}

export async function classifyDocumentLayoutPageAsync(
  input: DocumentLayoutPageInput,
  options?: {
    isActive?: () => boolean;
    yieldEvery?: number;
    layoutDeadlineMs?: number;
    processDeadline?: number;
  },
): Promise<StructuredDocumentPage> {
  const started = Date.now();
  const deadline = resolveEffectiveDeadline({
    started,
    layoutBudgetMs: options?.layoutDeadlineMs,
    processDeadline: options?.processDeadline,
  });
  logStructuredLayout('start', {
    pageIndex: input.pageIndex,
    blocks: input.lines.length,
  });

  await yieldToOperationEventLoop();
  if (options?.isActive && !options.isActive()) {
    throw new LayoutClassificationAbortedError();
  }
  if (layoutDeadlineExceeded(deadline)) {
    return partialLayoutPage(
      input,
      buildDocumentLayoutLines(input).slice(0, MAX_LAYOUT_LINES),
      started,
    );
  }

  logStructuredLayout('step_build_lines');
  const lines = buildDocumentLayoutLines(input).slice(0, MAX_LAYOUT_LINES);
  logStructuredLayout('step_build_lines_done', {
    lines: lines.length,
    ms: Date.now() - started,
  });

  await yieldToOperationEventLoop();
  if (layoutDeadlineExceeded(deadline)) {
    return partialLayoutPage(input, lines, started);
  }

  logStructuredLayout('step_prepare_context', { lines: lines.length });
  let context: LayoutPageClassificationContext;
  try {
    context = prepareLayoutPageClassificationContext(input, lines, deadline);
  } catch (error) {
    if (error instanceof StructuredLayoutTimeoutError) {
      return partialLayoutPage(input, lines, started);
    }
    throw error;
  }
  logStructuredLayout('step_prepare_context_done', { ms: Date.now() - started });

  logStructuredLayout('step_classify_lines', { lines: context.lines.length });
  const classifyStarted = Date.now();
  let classified: Array<{ line: DocumentLayoutLine; classification: Classification }>;
  try {
    classified = classifyLayoutLines(context, deadline);
  } catch (error) {
    if (error instanceof StructuredLayoutTimeoutError) {
      return partialLayoutPage(input, context.lines, started);
    }
    throw error;
  }
  logStructuredLayoutPerf('classify_lines', Date.now() - classifyStarted, { lines: context.lines.length });
  await yieldToOperationEventLoop();
  if (options?.isActive && !options.isActive()) {
    throw new LayoutClassificationAbortedError();
  }
  const page = finalizeLayoutPageClassification(context, classified);
  logStructuredLayout('done', { ms: Date.now() - started, zones: page.zones.length });
  return page;
}

export function classifyDocumentLayoutPages(
  inputs: readonly DocumentLayoutPageInput[],
): StructuredDocumentPage[] {
  return [...inputs]
    .sort((a, b) => a.pageIndex - b.pageIndex)
    .map((input) => classifyDocumentLayoutPage(input));
}

export async function classifyDocumentLayoutPagesAsync(
  inputs: readonly DocumentLayoutPageInput[],
  options?: {
    isActive?: () => boolean;
    yieldEvery?: number;
    layoutDeadlineMs?: number;
    processDeadline?: number;
    tableSignalCount?: number;
  },
): Promise<StructuredDocumentPage[]> {
  const sorted = [...inputs].sort((a, b) => a.pageIndex - b.pageIndex);
  const pages: StructuredDocumentPage[] = [];
  let skipRemainingLayout = false;
  for (const input of sorted) {
    if (options?.isActive && !options.isActive()) {
      throw new LayoutClassificationAbortedError();
    }
    const remainingMs = options?.processDeadline === undefined
      ? undefined
      : Math.max(0, options.processDeadline - Date.now());
    if (
      skipRemainingLayout
      || (options?.processDeadline !== undefined && Date.now() >= options.processDeadline)
      || (remainingMs !== undefined && remainingMs < 900)
    ) {
      const lines = buildDocumentLayoutLines(input).slice(0, MAX_LAYOUT_LINES);
      pages.push(partialLayoutPage(input, lines, Date.now(), 'structured_layout_timeout'));
      skipRemainingLayout = true;
      continue;
    }
    const computedPageBudgetMs = layoutBudgetForPage({
      pageLineCount: input.lines.length,
      pageCount: sorted.length,
      tableSignalCount: options?.tableSignalCount,
      processDeadline: options?.processDeadline,
      remainingProcessMs: remainingMs,
    });
    const pageBudgetMs = options?.layoutDeadlineMs === undefined
      ? computedPageBudgetMs
      : Math.min(computedPageBudgetMs, options.layoutDeadlineMs);
    const page = await classifyDocumentLayoutPageAsync(input, {
      ...options,
      layoutDeadlineMs: pageBudgetMs,
      processDeadline: options?.processDeadline,
    });
    pages.push(page);
    if (page.reasons.includes('structured_layout_timeout')) {
      skipRemainingLayout = true;
    }
    await yieldToOperationEventLoop();
  }
  return pages;
}

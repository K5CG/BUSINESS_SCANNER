/**
 * Distinct commercial table levels must not be mixed into one item list.
 * Headings are a semantic class, not a single hardcoded phrase.
 */

export type TableBlockRole =
  | 'primary_line_items'
  | 'configuration_detail'
  | 'summary'
  | 'aggregate_summary'
  | 'recap'
  | 'logistics_charges'
  | 'totals_only'
  | 'unknown';

export interface HierarchicalLineItem {
  description?: string;
  sourceLines: readonly string[];
  quantity?: number;
  unitPrice?: number;
  lineTotal?: number;
}

const SUMMARY_HEADING =
  /\b(?:riepilogo|summary|recap|totali|totaux|r[ée]sum[eé]|resumen(?:\s+de\s+cantidades)?|zusammenfassung|quantit[aà]\s+triennale|triennal[e]?|trienal|annual\s+total|total\s+quantity|totale\s+triennale|vat\s+summary|vat\s+recap|riepilogo\s+iva|total\s+unidades\s+a[nñ]o|total\s+3\s+a[nñ]os|historical|previous\s+orders|statistics)\b/i;

const AGGREGATE_QTY =
  /\b(?:\d{1,3}(?:[.\s]\d{3})+|\d{4,})\s*(?:pz|pcs|cf|nr|n)\b/i;

export function isSummaryOrAggregateHeading(text: string): boolean {
  return SUMMARY_HEADING.test(text);
}

export function classifyTableHeading(text: string): TableBlockRole | undefined {
  const folded = text.replace(/\s+/g, ' ').trim();
  if (!folded) return undefined;
  if (/\b(?:riepilogo\s+iva|vat\s+summary|totale\s+imposta)\b/i.test(folded)) return 'totals_only';
  if (/\b(?:quantit[aà]\s+triennale|annual\s+total|total\s+quantity|totale\s+triennale|resumen\s+de\s+cantidades|total\s+unidades\s+a[nñ]o|total\s+3\s+a[nñ]os|triennal[e]?|trienal)\b/i.test(folded)) {
    return 'aggregate_summary';
  }
  if (/\b(?:riepilogo|summary|recap|totali|totaux|r[ée]sum[eé]|resumen|zusammenfassung)\b/i.test(folded)) return 'summary';
  return undefined;
}

function itemText(item: HierarchicalLineItem): string {
  return [item.description, ...item.sourceLines].filter(Boolean).join(' ');
}

function looksLikeAggregateRow(item: HierarchicalLineItem): boolean {
  const text = itemText(item);
  if (isSummaryOrAggregateHeading(text)) return true;
  if (AGGREGATE_QTY.test(text) && (item.unitPrice === undefined || item.unitPrice === 0)) return true;
  return false;
}

function descriptionTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\u00c0-\u024f\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4),
  );
}

function descriptionsOverlap(left: HierarchicalLineItem[], right: HierarchicalLineItem[]): boolean {
  const leftTokens = left.flatMap((item) => [...descriptionTokens(item.description ?? '')]);
  if (leftTokens.length === 0) return false;
  return right.some((item) => {
    const tokens = descriptionTokens(item.description ?? '');
    const shared = leftTokens.filter((token) => tokens.has(token)).length;
    return shared >= 2;
  });
}

function blockScore(
  items: HierarchicalLineItem[],
  documentTotal: number | undefined,
  role: TableBlockRole,
): number {
  if (items.length === 0) return -100;
  const complete = items.filter((item) =>
    item.lineTotal !== undefined && (item.unitPrice !== undefined || item.quantity !== undefined)).length;
  const sum = items.reduce((acc, item) => acc + (item.lineTotal ?? 0), 0);
  let score = complete * 4 + items.length;
  if (role === 'summary' || role === 'aggregate_summary') score -= 2;
  if (documentTotal !== undefined && documentTotal > 0) {
    const delta = Math.abs(sum - documentTotal);
    if (delta <= Math.max(0.05, documentTotal * 0.02)) score += 20;
    else score -= Math.min(12, delta / Math.max(1, documentTotal) * 10);
  }
  return score;
}

/**
 * Keep one commercial level when detail and summary/aggregate blocks overlap.
 * Additive independent tables are preserved.
 */
export function selectCoherentCommercialLevel<T extends HierarchicalLineItem>(
  items: readonly T[],
  pageLines: readonly string[],
  documentTotal?: number,
): T[] {
  if (items.length < 2) return [...items];
  const headingIndex = pageLines.findIndex((line) => isSummaryOrAggregateHeading(line));
  if (headingIndex < 0) {
    const detail = items.filter((item) => !looksLikeAggregateRow(item));
    const aggregate = items.filter((item) => looksLikeAggregateRow(item));
    if (detail.length > 0 && aggregate.length > 0 && descriptionsOverlap(detail, aggregate)) {
      return pickOneLevel(detail, aggregate, documentTotal);
    }
    return [...items];
  }

  const headingRole = classifyTableHeading(pageLines[headingIndex] ?? '') ?? 'summary';
  if (headingRole === 'totals_only') {
    return items.filter((item) => !isSummaryOrAggregateHeading(itemText(item)));
  }
  const before = pageLines.slice(0, headingIndex);
  const after = pageLines.slice(headingIndex);
  const summary: T[] = [];
  const detail: T[] = [];
  for (const item of items) {
    const joined = itemText(item);
    const afterHits = item.sourceLines.filter((line) => after.includes(line)).length;
    const beforeHits = item.sourceLines.filter((line) => before.includes(line)).length;
    const afterBlock = looksLikeAggregateRow(item)
      || isSummaryOrAggregateHeading(joined)
      || afterHits > beforeHits;
    if (afterBlock) summary.push(item);
    else detail.push(item);
  }

  if (summary.length === 0 || detail.length === 0) return [...items];
  const summaryLooksAggregate = summary.every((item) => looksLikeAggregateRow(item) || item.unitPrice === undefined);
  const bothAdditive = detail.every((item) => item.unitPrice !== undefined)
    && summary.every((item) => item.unitPrice !== undefined)
    && !descriptionsOverlap(detail, summary);
  if (bothAdditive) return [...items];
  if (
    descriptionsOverlap(detail, summary)
    || summaryLooksAggregate
    || (documentTotal !== undefined && Math.abs(summary.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0) - documentTotal) <= 0.05)
  ) {
    return pickOneLevel(detail, summary, documentTotal);
  }
  return pickOneLevel(detail, summary, documentTotal);
}

function pickOneLevel<T extends HierarchicalLineItem>(
  detail: T[],
  summary: T[],
  documentTotal?: number,
): T[] {
  const detailScore = blockScore(detail, documentTotal, 'primary_line_items');
  const summaryScore = blockScore(summary, documentTotal, 'aggregate_summary');
  return summaryScore > detailScore + 2 ? summary : detail;
}

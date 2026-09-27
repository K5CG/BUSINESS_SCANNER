import type { DocumentLayoutLine } from './document-structure';
import { parseInternationalAmount } from './document-international-values';
import { logQaDocument } from './qa-document-logging';

export type OrphanColumnKind =
  | 'quantity'
  | 'unitPrice'
  | 'discount'
  | 'vatRate'
  | 'lineTotal';

export interface OrphanRowBand {
  pageIndex: number;
  y: number;
  lines: DocumentLayoutLine[];
}

const NUMERIC_KINDS: readonly OrphanColumnKind[] = [
  'quantity',
  'unitPrice',
  'discount',
  'vatRate',
  'lineTotal',
];

function lineY(line: DocumentLayoutLine): number {
  return line.boundingBox?.y ?? 0;
}

function lineX(line: DocumentLayoutLine): number {
  const box = line.boundingBox;
  return box ? box.x + box.width / 2 : line.readingOrder;
}

function parsedAmount(line: DocumentLayoutLine): number | undefined {
  return parseInternationalAmount(line.text).normalizedValue;
}

function isNumericToken(line: DocumentLayoutLine): boolean {
  return parsedAmount(line) !== undefined;
}

function forbiddenOrphanRegion(line: DocumentLayoutLine): boolean {
  const region = line.semanticRegion;
  return region === 'document_totals'
    || region === 'tax_recap'
    || region === 'historical_recap'
    || region === 'table_subtotal'
    || region === 'header'
    || region === 'footer'
    || region === 'notes';
}

function looksLikeWeakPlaceholder(line: DocumentLayoutLine, kind: OrphanColumnKind): boolean {
  if (kind === 'quantity' || kind === 'vatRate' || kind === 'discount') return false;
  const value = parsedAmount(line);
  if (value === undefined) return true;
  if (/[.,]\d{2}/.test(line.text) || /\s\d{3}/.test(line.text)) return false;
  return Number.isInteger(value) && value > 0 && value <= 100 && !/[.,]/.test(line.text.trim());
}

function looksLikeCurrencyToken(text: string): boolean {
  return /^\s*[€$£]\s*$/.test(text) || /^(?:EUR|USD|GBP|CHF)\s*$/i.test(text.trim());
}

function compatibleSplitToken(existing: DocumentLayoutLine, candidate: DocumentLayoutLine): boolean {
  if (looksLikeCurrencyToken(existing.text) || looksLikeCurrencyToken(candidate.text)) return true;
  const joined = `${existing.text} ${candidate.text}`.replace(/\s+/g, ' ').trim();
  const parsed = parseInternationalAmount(joined).normalizedValue;
  if (parsed === undefined) return false;
  const left = parsedAmount(existing);
  const right = parsedAmount(candidate);
  if (left !== undefined && right !== undefined && Math.abs(parsed - left) > 0.001 && Math.abs(parsed - right) > 0.001) {
    return true;
  }
  return left === undefined || right === undefined;
}

const SUMMARY_OR_RECAP_LABEL =
  /\b(?:base imponible|subtotal|subtotale|imponibile|totale|total(?:e)?(?:\s+documento|\s+ttc|\s+offerta)?|taxable|grand total|gesamtbetrag|resumen|neta|riepilogo|carry(?:ed)?(?:\s|-)forward)\b/i;

function rowHasLeftAnchor(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  return row.lines.some((line) => {
    const kind = assignColumn(line);
    if (kind === 'description' || kind === 'itemCode') return true;
    if (isNumericToken(line)) return false;
    return /[A-Za-zÀ-ÿ]{4,}/.test(line.text);
  });
}

function isSummaryOrRecapRowOwner(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): boolean {
  for (const line of row.lines) {
    const region = line.semanticRegion;
    if (
      region === 'document_totals'
      || region === 'tax_recap'
      || region === 'historical_recap'
      || region === 'statistical_recap'
      || region === 'table_subtotal'
    ) {
      return true;
    }
    const kind = assignColumn(line);
    if ((kind === 'description' || kind === 'itemCode') && SUMMARY_OR_RECAP_LABEL.test(line.text)) {
      return true;
    }
  }
  return false;
}

function commercialRowAnchorY(
  row: OrphanRowBand,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): number | undefined {
  const anchors = row.lines.filter((line) => {
    const kind = assignColumn(line);
    return kind === 'description' || kind === 'itemCode' || (
      !isNumericToken(line) && /[A-Za-zÀ-ÿ]{4,}/.test(line.text)
    );
  });
  if (anchors.length === 0) return undefined;
  return anchors.reduce((sum, line) => sum + lineY(line), 0) / anchors.length;
}

function fieldLines(
  row: OrphanRowBand,
  kind: OrphanColumnKind,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): DocumentLayoutLine[] {
  return row.lines.filter((line) => assignColumn(line) === kind);
}

function parsedField(
  row: OrphanRowBand,
  kind: OrphanColumnKind,
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
): number | undefined {
  for (const line of fieldLines(row, kind, assignColumn)) {
    const value = parsedAmount(line);
    if (value !== undefined) return value;
  }
  return undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function columnAwareDrift(
  kind: OrphanColumnKind,
  owners: readonly OrphanRowBand[],
  assignColumn: (line: DocumentLayoutLine) => string | undefined,
  fallback: number,
): number {
  const observed = owners.flatMap((row) =>
    fieldLines(row, kind, assignColumn).map((line) => Math.abs(lineY(line) - row.y)));
  const typical = median(observed.filter((value) => value > 0));
  const bias = kind === 'lineTotal' ? 1.25 : 1;
  if (typical === undefined) return fallback * bias;
  return Math.max(fallback, typical * 1.35 + fallback * 0.25) * bias;
}

export function reattachOrphanNumericCells(input: {
  rows: OrphanRowBand[];
  body: readonly DocumentLayoutLine[];
  assignColumn: (line: DocumentLayoutLine) => string | undefined;
  pageIndex: number;
  medianLineHeight: number;
  medianRowSpacing: number;
}): { rows: OrphanRowBand[]; attached: number; durationMs: number } {
  const started = Date.now();
  const rows = input.rows.map((row) => ({ ...row, lines: row.lines.slice() }));
  const assigned = new Set(rows.flatMap((row) => row.lines.map((line) => line.id)));
  const orphans: DocumentLayoutLine[] = [];
  for (const row of rows) {
    if (rowHasLeftAnchor(row, input.assignColumn)) continue;
    for (const line of row.lines) {
      if (isNumericToken(line) && NUMERIC_KINDS.includes(input.assignColumn(line) as OrphanColumnKind)) {
        orphans.push(line);
      }
    }
  }
  for (const line of input.body) {
    if (assigned.has(line.id) || orphans.includes(line)) continue;
    if (line.pageIndex !== input.pageIndex) continue;
    if (!isNumericToken(line) || forbiddenOrphanRegion(line)) continue;
    const kind = input.assignColumn(line);
    if (!kind || !NUMERIC_KINDS.includes(kind as OrphanColumnKind)) continue;
    orphans.push(line);
  }

  const owners = rows.filter((row) => rowHasLeftAnchor(row, input.assignColumn));
  const baseDrift = Math.max(
    input.medianLineHeight * 1.8,
    Math.min(input.medianRowSpacing * 0.55, input.medianLineHeight * 4),
  );
  let attached = 0;
  const ownerByCell = new Map<string, OrphanRowBand>();

  for (const cell of orphans) {
    if (ownerByCell.has(cell.id)) continue;
    const kind = input.assignColumn(cell) as OrphanColumnKind | undefined;
    if (!kind || !NUMERIC_KINDS.includes(kind)) {
      logQaDocument('OrphanCellReattach', {
        page: input.pageIndex,
        rawText: cell.text.slice(0, 24),
        parsedValue: parsedAmount(cell),
        semanticColumn: kind ?? 'unknown',
        cellX: lineX(cell),
        cellY: lineY(cell),
        candidateRowCount: owners.length,
        status: 'rejected',
        reason: 'column_not_numeric',
      });
      continue;
    }
    if (cell.pageIndex !== input.pageIndex) {
      logQaDocument('OrphanCellReattach', {
        page: input.pageIndex,
        rawText: cell.text.slice(0, 24),
        parsedValue: parsedAmount(cell),
        semanticColumn: kind,
        cellX: lineX(cell),
        cellY: lineY(cell),
        candidateRowCount: 0,
        status: 'rejected',
        reason: 'page_boundary',
      });
      continue;
    }
    if (forbiddenOrphanRegion(cell)) {
      logQaDocument('OrphanCellReattach', {
        page: input.pageIndex,
        rawText: cell.text.slice(0, 24),
        parsedValue: parsedAmount(cell),
        semanticColumn: kind,
        cellX: lineX(cell),
        cellY: lineY(cell),
        candidateRowCount: 0,
        status: 'rejected',
        reason: 'totals_or_recap_region',
      });
      continue;
    }
    const drift = columnAwareDrift(kind, owners, input.assignColumn, baseDrift);
    const commercialOwners = owners.filter((row) => !isSummaryOrRecapRowOwner(row, input.assignColumn));
    const ownerPool = kind === 'quantity' && commercialOwners.length > 0 ? commercialOwners : owners;
    const scored = ownerPool.map((row, index) => {
      const poolIndex = owners.indexOf(row);
      const prev = ownerPool[index - 1];
      const next = ownerPool[index + 1];
      const lo = prev ? (prev.y + row.y) / 2 : row.y - input.medianRowSpacing;
      const hi = next ? (row.y + next.y) / 2 : row.y + input.medianRowSpacing;
      const y = lineY(cell);
      const anchorY = commercialRowAnchorY(row, input.assignColumn) ?? row.y;
      const dy = kind === 'quantity' ? Math.abs(y - anchorY) : Math.abs(y - row.y);
      const inBand = y >= lo - drift && y < hi + drift;
      const existing = fieldLines(row, kind, input.assignColumn)
        .filter((line) => !ownerByCell.has(line.id) || ownerByCell.get(line.id) === row);
      const splitOk = existing.length > 0 && existing.every((line) => compatibleSplitToken(line, cell));
      const candidateValue = parsedAmount(cell);
      const positiveReplacesFalseZero =
        (kind === 'unitPrice' || kind === 'lineTotal')
        && candidateValue !== undefined
        && candidateValue > 0
        && existing.length > 0
        && existing.every((line) => parsedAmount(line) === 0);
      const vacant = existing.length === 0
        || existing.every((line) => looksLikeWeakPlaceholder(line, kind))
        || splitOk
        || positiveReplacesFalseZero;
      const normDy = dy / Math.max(8, drift);
      let score = 48 - normDy * 28;
      if (!inBand) score -= 400;
      if (!vacant) score -= 250;
      if (kind === 'lineTotal') {
        const qty = parsedField(row, 'quantity', input.assignColumn);
        const price = parsedField(row, 'unitPrice', input.assignColumn);
        const value = parsedAmount(cell);
        if (qty !== undefined && price !== undefined && value !== undefined
          && Math.abs(qty * price - value) <= Math.max(0.05, Math.abs(value) * 0.01)) {
          score += 8;
        }
      }
      if (kind === 'quantity' && isSummaryOrRecapRowOwner(row, input.assignColumn)) {
        score -= 500;
      } else if (kind === 'quantity') {
        score += Math.max(0, 12 - (dy / Math.max(8, drift)) * 12);
      }
      return { row, index: poolIndex, score, dy, vacant, splitOk, inBand };
    }).sort((left, right) => right.score - left.score);

    const best = scored[0];
    const second = scored[1];
    const unique = !!best
      && best.inBand
      && best.vacant
      && best.score > 0
      && (!second || best.score >= second.score + 8);

    if (!best || !unique) {
      logQaDocument('OrphanCellReattach', {
        page: input.pageIndex,
        rawText: cell.text.slice(0, 24),
        parsedValue: parsedAmount(cell),
        semanticColumn: kind,
        cellX: lineX(cell),
        cellY: lineY(cell),
        candidateRowCount: owners.length,
        chosenRow: best?.index,
        chosenRowY: best?.row.y,
        score: best?.score,
        status: best && second && Math.abs(best.score - second.score) < 8 ? 'ambiguous' : 'rejected',
        reason: !best?.vacant ? 'field_already_owned' : !best?.inBand ? 'outside_row_band' : 'no_unique_owner',
      });
      continue;
    }

    const candidateValue = parsedAmount(cell);
    const existing = fieldLines(best.row, kind, input.assignColumn).filter((line) =>
      looksLikeWeakPlaceholder(line, kind)
      || (
        (kind === 'unitPrice' || kind === 'lineTotal')
        && candidateValue !== undefined
        && candidateValue > 0
        && parsedAmount(line) === 0
      ));
    if (existing.length > 0 && !best.splitOk) {
      best.row.lines = best.row.lines.filter((line) => !existing.includes(line));
    }
    if (!best.row.lines.includes(cell)) best.row.lines.push(cell);
    ownerByCell.set(cell.id, best.row);
    attached += 1;
    logQaDocument('OrphanCellReattach', {
      page: input.pageIndex,
      rawText: cell.text.slice(0, 24),
      parsedValue: parsedAmount(cell),
      semanticColumn: kind,
      cellX: lineX(cell),
      cellY: lineY(cell),
      candidateRowCount: owners.length,
      chosenRow: best.index,
      chosenRowY: best.row.y,
      score: best.score,
      status: 'attached',
      reason: 'nearest_compatible_row_band',
    });
  }

  for (const row of rows) {
    row.lines = row.lines.filter((line) => {
      const owner = ownerByCell.get(line.id);
      if (!owner) return true;
      return owner === row;
    });
  }
  const durationMs = Date.now() - started;
  logQaDocument('OrphanCellReattachPerf', {
    page: input.pageIndex,
    orphans: orphans.length,
    attached,
    ms: durationMs,
  });
  return { rows, attached, durationMs };
}

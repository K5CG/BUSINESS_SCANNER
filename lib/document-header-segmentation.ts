import type { DocumentLayoutLine } from './document-structure';

export type TableColumnKind =
  | 'itemCode'
  | 'description'
  | 'quantity'
  | 'unit'
  | 'unitPrice'
  | 'discount'
  | 'vatRate'
  | 'lineTotal';

export interface HeaderSegment {
  kind: TableColumnKind;
  x: number;
  text: string;
  line: DocumentLayoutLine;
}

const HEADER_ATOMS: Array<{ kind: TableColumnKind; pattern: RegExp }> = [
  { kind: 'itemCode', pattern: /codice|artikel|item(?:\s*code)?|sku|r[eé]f(?:[ée]rence)?|c[oó]digo|art(?:icolo|\.?\s*nr)/i },
  { kind: 'description', pattern: /descriz|description|d[eé]signation|bezeichnung|descripci/i },
  { kind: 'quantity', pattern: /q\.?\s*t[aàeé]|quantit|menge|cantidad|cant\.?|anzahl/i },
  { kind: 'unit', pattern: /(?:^|\s)(?:u\.?m\.?|udm|einheit|unit[eéà])(?:\s|$)/i },
  { kind: 'unitPrice', pattern: /prezz|unit(?:ario)?\s*price|pu\s*ht|prix|precio|einzelpreis|st[uü]ckpreis|(?:^|\s)preis(?:\s|$)/i },
  { kind: 'discount', pattern: /sconto|discount|remise|rabatt|descuento|desc\.?/i },
  { kind: 'vatRate', pattern: /(?:iva|vat|tva|mwst\.?|ust\.?|aliq(?:uota)?)/i },
  { kind: 'lineTotal', pattern: /importo|importe|totale(?:\s+riga)?|amount|gesamt|betrag|montant|line\s+total/i },
];

const COLUMN_ORDER: TableColumnKind[] = [
  'itemCode',
  'description',
  'unit',
  'quantity',
  'unitPrice',
  'discount',
  'vatRate',
  'lineTotal',
];

function syntheticHeaderLine(source: DocumentLayoutLine, text: string, x: number, width: number): DocumentLayoutLine {
  const box = source.boundingBox;
  return {
    ...source,
    text,
    boundingBox: {
      x,
      y: box?.y ?? 0,
      width: Math.max(24, width),
      height: box?.height ?? 16,
    },
  };
}

function interpolateX(box: { x: number; width: number } | undefined, start: number, length: number, textLength: number): number {
  if (!box || textLength <= 0) return box?.x ?? 0;
  return box.x + (box.width * start) / textLength;
}

function interpolateWidth(box: { width: number } | undefined, tokenLength: number, textLength: number): number {
  if (!box || textLength <= 0) return Math.max(24, tokenLength * 8);
  return Math.max(24, (box.width * tokenLength) / textLength);
}

interface AtomHit {
  kind: TableColumnKind;
  text: string;
  start: number;
  end: number;
}

function atomHitsInText(text: string): AtomHit[] {
  const hits: AtomHit[] = [];
  for (const atom of HEADER_ATOMS) {
    const match = text.match(atom.pattern);
    if (!match || match.index === undefined) continue;
    const start = match.index;
    let end = start + match[0].length;
    const trailing = text.slice(end).match(/^\s*%/);
    if (trailing) end += trailing[0].length;
    hits.push({ kind: atom.kind, text: text.slice(start, end).trim(), start, end });
  }
  hits.sort((left, right) => left.start - right.start || left.end - right.end);
  const unique: AtomHit[] = [];
  for (const hit of hits) {
    if (unique.some((existing) => existing.kind === hit.kind)) continue;
    if (unique.some((existing) => hit.start < existing.end && hit.end > existing.start)) continue;
    unique.push(hit);
  }
  return unique;
}

function segmentsFromElements(
  line: DocumentLayoutLine,
  resolveKind: (text: string) => TableColumnKind | undefined,
): HeaderSegment[] {
  const elements = line.elements ?? [];
  if (elements.length < 2) return [];
  const segments: HeaderSegment[] = [];
  let index = 0;
  while (index < elements.length) {
    let consumed = 0;
    let kind: TableColumnKind | undefined;
    let text = '';
    for (let take = 1; take <= 3 && index + take <= elements.length; take += 1) {
      const slice = elements.slice(index, index + take);
      const joined = slice.map((entry) => entry.text).join(' ').replace(/\s+/g, ' ').trim();
      const resolved = resolveKind(joined);
      if (resolved) {
        kind = resolved;
        text = joined;
        consumed = take;
        break;
      }
    }
    if (!kind || consumed === 0) {
      index += 1;
      continue;
    }
    const used = elements.slice(index, index + consumed);
    const xs = used.flatMap((entry) => (entry.boundingBox ? [entry.boundingBox.x] : []));
    const x = xs.length > 0 ? Math.min(...xs) : interpolateX(line.boundingBox, index, 1, elements.length);
    const width = used.reduce((sum, entry) => sum + (entry.boundingBox?.width ?? 24), 0);
    if (!segments.some((entry) => entry.kind === kind)) {
      segments.push({
        kind,
        x,
        text,
        line: syntheticHeaderLine(line, text, x, width),
      });
    }
    index += consumed;
  }
  return segments.length >= 2 ? segments : [];
}

function segmentsFromCompoundText(
  line: DocumentLayoutLine,
  resolveKind: (text: string) => TableColumnKind | undefined,
): HeaderSegment[] {
  const text = line.text.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const hits = atomHitsInText(text);
  if (hits.length < 2) return [];
  const kinds = new Set(hits.map((hit) => hit.kind));
  if (kinds.size < 2) return [];
  return hits.map((hit) => {
    const x = interpolateX(line.boundingBox, hit.start, hit.end - hit.start, text.length);
    const width = interpolateWidth(line.boundingBox, hit.end - hit.start, text.length);
    const resolved = resolveKind(hit.text) ?? hit.kind;
    return {
      kind: resolved,
      x,
      text: hit.text,
      line: syntheticHeaderLine(line, hit.text, x, width),
    };
  });
}

export function segmentHeaderLine(
  line: DocumentLayoutLine,
  resolveKind: (text: string) => TableColumnKind | undefined,
): HeaderSegment[] {
  const fromElements = segmentsFromElements(line, resolveKind);
  if (fromElements.length >= 2) return fromElements;
  const fromText = segmentsFromCompoundText(line, resolveKind);
  if (fromText.length >= 2) return fromText;
  const kind = resolveKind(line.text);
  if (!kind) return [];
  return [{
    kind,
    x: line.boundingBox?.x ?? line.readingOrder,
    text: line.text,
    line,
  }];
}

export type TableSchemaConfidence = 'strong' | 'medium' | 'weak';

export function columnOrderRank(kind: TableColumnKind): number {
  return COLUMN_ORDER.indexOf(kind);
}

export function tableSchemaViolations(columns: ReadonlyArray<{ kind: TableColumnKind; x: number }>): string[] {
  const violations: string[] = [];
  const sorted = [...columns].sort((left, right) => left.x - right.x);
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (columnOrderRank(current.kind) < columnOrderRank(previous.kind)) {
      if (previous.kind === 'unit' && current.kind === 'quantity') continue;
      if (previous.kind === 'quantity' && current.kind === 'unit') continue;
      violations.push(`${previous.kind}_after_${current.kind}`);
    }
  }
  const qty = sorted.find((entry) => entry.kind === 'quantity');
  const price = sorted.find((entry) => entry.kind === 'unitPrice');
  const total = sorted.find((entry) => entry.kind === 'lineTotal');
  if (qty && total && qty.x > total.x + 8) violations.push('quantity_right_of_lineTotal');
  if (price && total && price.x > total.x + 8) violations.push('unitPrice_right_of_lineTotal');
  const kinds = sorted.map((entry) => entry.kind);
  if (new Set(kinds).size !== kinds.length) violations.push('duplicate_column_role');
  return violations;
}

export function scoreTableSchema(columns: ReadonlyArray<{ kind: TableColumnKind; x: number }>): {
  confidence: TableSchemaConfidence;
  violations: string[];
} {
  const kinds = new Set(columns.map((entry) => entry.kind));
  const violations = tableSchemaViolations(columns);
  const hasCore = kinds.has('description') && kinds.has('lineTotal') && (kinds.has('quantity') || kinds.has('unitPrice'));
  if (!hasCore) return { confidence: 'weak', violations: [...violations, 'missing_core_columns'] };
  const fatalOrder = violations.some((entry) =>
    /right_of_lineTotal|duplicate_column_role/.test(entry)
    || /(quantity|unitPrice|discount|vatRate|lineTotal)_after_(description|itemCode)/.test(entry));
  if (fatalOrder) return { confidence: 'weak', violations };
  if (violations.length > 0) return { confidence: 'medium', violations };
  if (kinds.has('quantity') && kinds.has('unitPrice') && kinds.has('lineTotal')) {
    return { confidence: 'strong', violations };
  }
  return { confidence: 'medium', violations };
}

function schemaConfidenceRank(confidence: TableSchemaConfidence): number {
  if (confidence === 'strong') return 3;
  if (confidence === 'medium') return 2;
  return 1;
}

export function scoreTableSchemaWithMirror(
  columns: ReadonlyArray<{ kind: TableColumnKind; x: number }>,
  pageWidth: number,
): {
  confidence: TableSchemaConfidence;
  violations: string[];
  mirrored: boolean;
} {
  const direct = scoreTableSchema(columns);
  const mirrored = scoreTableSchema(columns.map((column) => ({
    ...column,
    x: pageWidth - column.x,
  })));
  if (schemaConfidenceRank(mirrored.confidence) > schemaConfidenceRank(direct.confidence)) {
    return { ...mirrored, mirrored: true };
  }
  return { ...direct, mirrored: false };
}

export function looksLikeCompoundHeaderText(text: string): boolean {
  return atomHitsInText(text.replace(/\s+/g, ' ').trim()).length >= 2;
}

function headerBandY(columns: ReadonlyArray<{ line?: { boundingBox?: { y?: number } } }>): number | undefined {
  const ys = columns
    .map((entry) => entry.line?.boundingBox?.y)
    .filter((value): value is number => value !== undefined);
  if (ys.length === 0) return undefined;
  return [...ys].sort((left, right) => left - right)[Math.floor(ys.length / 2)];
}

export function looksLikeBodyTextHeader(text: string): boolean {
  const folded = text.replace(/\s+/g, ' ').trim();
  if (!folded) return true;
  const headerHit = HEADER_ATOMS.find((atom) => atom.pattern.test(folded));
  if (headerHit && folded.length <= 28) {
    const stripped = folded.replace(headerHit.pattern, ' ').replace(/[%:.\-]/g, ' ').replace(/\s+/g, ' ').trim();
    const extraWords = stripped.split(/\s+/).filter((word) => word.length >= 4);
    if (extraWords.length >= 2) return true;
    return false;
  }
  if (folded.length > 32) return true;
  if (/\d/.test(folded) && !/%/.test(folded)) return true;
  return false;
}

export function repairTableSchemaColumns<T extends {
  kind: TableColumnKind;
  x: number;
  line?: { text: string; boundingBox?: { y?: number }; semanticRegion?: string };
}>(columns: readonly T[]): { columns: T[]; durationMs: number } {
  const started = Date.now();
  const bandY = headerBandY(columns);
  const filtered = columns.filter((column) => {
    const region = column.line?.semanticRegion;
    const text = column.line?.text ?? '';
    const y = column.line?.boundingBox?.y;
    if (region === 'commercial_table_body' && looksLikeBodyTextHeader(text)) return false;
    if (bandY !== undefined && y !== undefined && Math.abs(y - bandY) > 48) {
      if (region === 'commercial_table_body' || looksLikeBodyTextHeader(text)) return false;
    }
    return true;
  });
  const unique: T[] = [];
  for (const column of [...filtered].sort((left, right) => left.x - right.x)) {
    const existing = unique.findIndex((entry) => entry.kind === column.kind);
    if (existing < 0) {
      unique.push(column);
      continue;
    }
    const previous = unique[existing]!;
    const previousDy = bandY === undefined ? 0 : Math.abs((previous.line?.boundingBox?.y ?? bandY) - bandY);
    const nextDy = bandY === undefined ? 0 : Math.abs((column.line?.boundingBox?.y ?? bandY) - bandY);
    if (nextDy + 4 < previousDy) unique[existing] = column;
  }
  return { columns: unique, durationMs: Date.now() - started };
}

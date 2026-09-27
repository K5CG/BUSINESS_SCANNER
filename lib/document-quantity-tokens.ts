/**
 * Quantity candidates from raw geometric numeric tokens — not from the
 * money-value list. Default 1 is last resort.
 */
import type { DocumentLayoutLine } from './document-structure';

export type QuantityProvenance =
  | 'explicit_column'
  | 'geometry_token'
  | 'unit_token'
  | 'arithmetic_ranked'
  | 'arithmetic_derived_missing_ocr'
  | 'unknown_missing'
  | 'default_missing';

export interface GeometricNumericToken {
  value: number;
  raw: string;
  isInteger: boolean;
  unit?: string;
  centerX: number;
  centerY: number;
  pageIndex: number;
  line: DocumentLayoutLine;
  source: 'line_text' | 'element' | 'element_pair';
}

export interface ResolvedRowQuantity {
  value?: number;
  raw: string;
  provenance: QuantityProvenance;
  line?: DocumentLayoutLine;
}

const QTY_UNIT =
  /^(?:ud|un|uds|pz|pcs|pc|nr|n\.?\s*r\.?|m|mt|h|hr|ore|kg|ml|lt|cf|mq|udm)$/i;
const QTY_WITH_UNIT =
  /^(-?\d{1,6}(?:[.,]\d{1,3})?)\s*(ud|un|uds|pz|pcs|pc|nr|n\.?\s*r\.?|m|mt|h|hr|ore|kg|ml|lt|cf|mq|udm)\b/i;
const BARE_NUMBER = /^(-?\d{1,6}(?:[.,]\d{1,3})?)$/;
const COMMON_VAT = new Set([4, 5, 10, 19, 20, 21, 22, 23]);
const PRODUCT_CODE = /^(?=[A-Z0-9-]{3,20}$)[A-Z0-9]*-?[A-Z0-9-]*\d[A-Z0-9-]*$/i;

function parseQtyNumber(raw: string): number | undefined {
  const normalized = raw.replace(/\s/g, '').replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0 || value > 10_000) return undefined;
  return value;
}

function tokenCenter(line: DocumentLayoutLine, box?: { x: number; y: number; width?: number; height?: number }) {
  const fallback = line.boundingBox;
  const used = box ?? fallback;
  if (!used) return { x: line.readingOrder, y: 0 };
  return {
    x: used.x + (used.width ?? 0) / 2,
    y: used.y + (used.height ?? 0) / 2,
  };
}

function pushToken(
  out: GeometricNumericToken[],
  line: DocumentLayoutLine,
  raw: string,
  value: number,
  source: GeometricNumericToken['source'],
  unit?: string,
  box?: { x: number; y: number; width?: number; height?: number },
): void {
  const center = tokenCenter(line, box);
  out.push({
    value,
    raw,
    isInteger: Number.isInteger(value) || Math.abs(value - Math.round(value)) < 1e-6,
    unit,
    centerX: center.x,
    centerY: center.y,
    pageIndex: line.pageIndex,
    line,
    source,
  });
}

export function collectRawNumericTokens(lines: readonly DocumentLayoutLine[]): GeometricNumericToken[] {
  const out: GeometricNumericToken[] = [];
  for (const line of lines) {
    const trimmed = line.text.trim();
    if (!trimmed || PRODUCT_CODE.test(trimmed)) continue;
    const withUnit = trimmed.match(QTY_WITH_UNIT);
    if (withUnit) {
      const value = parseQtyNumber(withUnit[1]);
      if (value !== undefined) {
        pushToken(out, line, withUnit[0], value, 'line_text', withUnit[2]);
      }
    } else {
      const bare = trimmed.match(BARE_NUMBER);
      if (bare) {
        const value = parseQtyNumber(bare[1]);
        if (value !== undefined) pushToken(out, line, bare[1], value, 'line_text');
      }
    }
    const proseDescription = /[A-Za-z\u00c0-\u024f]{4,}/.test(trimmed) && trimmed.length > 24;
    if (proseDescription) continue;
    const elements = line.elements ?? [];
    for (let index = 0; index < elements.length; index += 1) {
      const current = elements[index];
      const next = elements[index + 1];
      const currentText = current.text.trim();
      const nextText = next?.text.trim() ?? '';
      if (QTY_UNIT.test(currentText) && BARE_NUMBER.test(nextText)) {
        const value = parseQtyNumber(nextText);
        if (value !== undefined) {
          pushToken(out, line, `${nextText} ${currentText}`, value, 'element_pair', currentText, next.boundingBox);
        }
        continue;
      }
      if (BARE_NUMBER.test(currentText) && QTY_UNIT.test(nextText)) {
        const value = parseQtyNumber(currentText);
        if (value !== undefined) {
          pushToken(out, line, `${currentText} ${nextText}`, value, 'element_pair', nextText, current.boundingBox);
        }
        continue;
      }
      const elementUnit = currentText.match(QTY_WITH_UNIT);
      if (elementUnit) {
        const value = parseQtyNumber(elementUnit[1]);
        if (value !== undefined) {
          pushToken(out, line, elementUnit[0], value, 'element', elementUnit[2], current.boundingBox);
        }
        continue;
      }
      if (BARE_NUMBER.test(currentText) && !PRODUCT_CODE.test(currentText)) {
        const value = parseQtyNumber(currentText);
        if (value !== undefined) pushToken(out, line, currentText, value, 'element', undefined, current.boundingBox);
      }
    }
  }
  return out;
}

export function parseQuantityCell(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const withUnit = trimmed.match(QTY_WITH_UNIT);
  if (withUnit) return parseQtyNumber(withUnit[1]);
  if (BARE_NUMBER.test(trimmed)) return parseQtyNumber(trimmed);
  return undefined;
}

function amountsClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.05, Math.abs(right) * 0.025);
}

function qtyReconciles(
  quantity: number,
  unitPrice?: number,
  lineTotal?: number,
  discount?: number,
): boolean {
  if (unitPrice === undefined || lineTotal === undefined || !(unitPrice > 0)) return false;
  const factors = [1];
  if (discount !== undefined && discount > 0 && discount < 100 && !(discount >= 19 && discount <= 23)) {
    factors.push(1 - discount / 100);
  }
  return factors.some((factor) => amountsClose(quantity * unitPrice * factor, lineTotal));
}

function inRowBand(token: GeometricNumericToken, rowTop: number, rowBottom: number): boolean {
  return token.centerY >= rowTop && token.centerY <= rowBottom;
}

export function resolveRowQuantity(input: {
  rowLines: readonly DocumentLayoutLine[];
  quantityColumnLines?: readonly DocumentLayoutLine[];
  quantityHeaderX?: number;
  unitPrice?: number;
  lineTotal?: number;
  discount?: number;
  observedQuantity?: number;
  hasExplicitOcrQuantity?: boolean;
  hasCountUnit?: boolean;
}): ResolvedRowQuantity {
  const tokens = collectRawNumericTokens(input.rowLines);
  const boxes = input.rowLines.flatMap((line) => (line.boundingBox ? [line.boundingBox] : []));
  const rowTop = boxes.length > 0 ? Math.min(...boxes.map((box) => box.y)) - 8 : Number.NEGATIVE_INFINITY;
  const rowBottom = boxes.length > 0
    ? Math.max(...boxes.map((box) => box.y + box.height)) + 8
    : Number.POSITIVE_INFINITY;
  const band = tokens.filter((token) => inRowBand(token, rowTop, rowBottom));

  const explicitColumn = (input.quantityColumnLines ?? []).flatMap((line) => {
    const value = parseQuantityCell(line.text);
    return value === undefined ? [] : [{ value, raw: line.text, line }];
  });
  if (explicitColumn.length > 0) {
    const chosen = pickBest(explicitColumn.map((entry) => ({
      value: entry.value,
      raw: entry.raw,
      line: entry.line,
      provenance: 'explicit_column' as const,
    })), input);
    if (chosen) {
      if (
        chosen.value !== undefined
        && input.unitPrice !== undefined
        && input.lineTotal !== undefined
        && !qtyReconciles(chosen.value, input.unitPrice, input.lineTotal, input.discount)
        && COMMON_VAT.has(chosen.value)
      ) {
        const derived = deriveUniqueQuantity(input.unitPrice, input.lineTotal, input.discount, {
          hasExplicitOcrQuantity: input.hasExplicitOcrQuantity,
          hasCountUnit: input.hasCountUnit,
        });
        if (derived !== undefined && derived !== chosen.value) {
          return {
            value: derived,
            raw: String(derived),
            provenance: 'arithmetic_derived_missing_ocr',
          };
        }
      }
      return chosen;
    }
  }

  const aligned = input.quantityHeaderX === undefined
    ? []
    : band.filter((token) => Math.abs(token.centerX - input.quantityHeaderX!) <= 70);
  const alignedPick = pickBest(aligned.map((token) => ({
    value: token.value,
    raw: token.raw,
    line: token.line,
    provenance: 'geometry_token' as const,
  })), input);
  if (alignedPick) return alignedPick;

  const unitAssociated = band.filter((token) => !!token.unit);
  const unitPick = pickBest(unitAssociated.map((token) => ({
    value: token.value,
    raw: token.raw,
    line: token.line,
    provenance: 'unit_token' as const,
  })), input);
  if (unitPick) return unitPick;

  const arithmetic = band.filter((token) =>
    token.isInteger
    && !COMMON_VAT.has(token.value)
    && qtyReconciles(token.value, input.unitPrice, input.lineTotal, input.discount),
  );
  const arithmeticPick = pickBest(arithmetic.map((token) => ({
    value: token.value,
    raw: token.raw,
    line: token.line,
    provenance: 'arithmetic_ranked' as const,
  })), input);
  if (arithmeticPick) return arithmeticPick;

  if (
    input.observedQuantity !== undefined
    && input.observedQuantity > 0
    && (input.observedQuantity !== 1
      || qtyReconciles(1, input.unitPrice, input.lineTotal, input.discount)
      || (input.unitPrice === undefined && input.lineTotal === undefined))
  ) {
    return {
      value: input.observedQuantity,
      raw: String(input.observedQuantity),
      provenance: 'explicit_column',
    };
  }

  const derived = deriveUniqueQuantity(input.unitPrice, input.lineTotal, input.discount, {
    hasExplicitOcrQuantity: input.hasExplicitOcrQuantity,
    hasCountUnit: input.hasCountUnit,
  });
  if (derived !== undefined) {
    return {
      value: derived,
      raw: String(derived),
      provenance: 'arithmetic_derived_missing_ocr',
    };
  }

  return { raw: '', provenance: 'unknown_missing' };
}

function deriveUniqueQuantity(
  unitPrice?: number,
  lineTotal?: number,
  discount?: number,
  options?: {
    hasExplicitOcrQuantity?: boolean;
    hasCountUnit?: boolean;
    maxDerivedQuantity?: number;
  },
): number | undefined {
  if (unitPrice === undefined || lineTotal === undefined || !(unitPrice > 0) || !(lineTotal > 0)) {
    return undefined;
  }
  const plausibleDiscount = discount !== undefined
    && discount > 0
    && discount < 80
    && !(discount >= 19 && discount <= 23);
  const factors = plausibleDiscount ? [1 - discount / 100] : [1];
  const matches = new Set<number>();
  const maxDerived = options?.maxDerivedQuantity
    ?? (options?.hasCountUnit ? 99 : 999);
  for (const factor of factors) {
    const raw = lineTotal / (unitPrice * factor);
    if (!(raw >= 0.01) || raw > 10_000) continue;
    const integer = Math.round(raw);
    if (Number.isInteger(integer) && integer >= 2 && amountsClose(integer * unitPrice * factor, lineTotal)) {
      matches.add(integer);
    }
  }
  if (matches.size !== 1) return undefined;
  const [value] = matches;
  if (value > maxDerived) return undefined;
  if (!options?.hasExplicitOcrQuantity && value >= 100) return undefined;
  return value;
}

function pickBest(
  candidates: Array<{ value: number; raw: string; line?: DocumentLayoutLine; provenance: QuantityProvenance }>,
  input: { unitPrice?: number; lineTotal?: number; discount?: number },
): ResolvedRowQuantity | undefined {
  const plausible = candidates.filter((candidate) => {
    if (!(candidate.value > 0) || candidate.value > 10_000) return false;
    if (COMMON_VAT.has(candidate.value) && candidate.provenance !== 'explicit_column' && !/\b(?:ud|pz|nr|m|h)\b/i.test(candidate.raw)) {
      return false;
    }
    return true;
  });
  if (plausible.length === 0) return undefined;
  const ranked = [...plausible].sort((left, right) => {
    const leftFits = qtyReconciles(left.value, input.unitPrice, input.lineTotal, input.discount) ? 1 : 0;
    const rightFits = qtyReconciles(right.value, input.unitPrice, input.lineTotal, input.discount) ? 1 : 0;
    if (leftFits !== rightFits) return rightFits - leftFits;
    const leftDefault = left.value === 1 ? 0 : 1;
    const rightDefault = right.value === 1 ? 0 : 1;
    if (leftDefault !== rightDefault && (leftFits || rightFits)) return rightDefault - leftDefault;
    return 0;
  });
  const winner = ranked[0];
  return {
    value: winner.value,
    raw: winner.raw,
    provenance: winner.provenance,
    line: winner.line,
  };
}

export function quantityProvenanceReason(provenance: QuantityProvenance): string {
  return `quantity_provenance_${provenance}`;
}

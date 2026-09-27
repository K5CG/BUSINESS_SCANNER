import { parseInternationalAmount } from './document-international-values';

export interface StructuredNumericInput {
  quantity?: number;
  unitPrice?: number;
  total?: number;
  discount?: number;
  vatRate?: number;
  quantityRaw?: unknown;
  unitPriceRaw?: unknown;
  lineTotalRaw?: unknown;
  sourceLines?: readonly string[];
}

export interface RepairedLineItemNumbers {
  quantity: number;
  unitPrice: number;
  total: number;
  reason: string;
}

const CENT = 0.05;
const ABSURD_MAGNITUDE = 1_000_000;
const PERCENT_LINE = /^\d+(?:[.,]\d+)?\s*%$/;
const AMOUNT_ONLY_LINE =
  /^-?\d{1,3}(?:[ \u00a0.']\d{3})*(?:[.,]\d{1,2})?$|^-?\d+[.,]\d{1,2}$|^-?\d+$/;
const THOUSANDS_FRAGMENT = /^\d{3}[.,]\d{2}[oO]?$/;

const LEADING_ZERO_THOUSANDS = /^0\d{2}[.,]\d{2}$/;
const TECHNICAL_MEASURE =
  /\b(?:DN|PT|PN)\s*\d+\b|\bM\d{2,4}\b|\d+\s*m[²³3](?:\s*\/\s*h)?|\d+\s*mCE\b|\b\d{2,4}L\b/i;

export function looksLikeTechnicalMeasure(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^-?\d/.test(trimmed) && /[€$£]|\b(?:EUR|USD|GBP|CHF)\b/i.test(trimmed) && trimmed.length <= 32) {
    return false;
  }
  if (/^-?\d+[.,]\d{2,4}[A-Za-z]?\s*(?:€|EUR)?\s*$/i.test(trimmed)) return false;
  if (TECHNICAL_MEASURE.test(trimmed) && !/[.,]\d{2}/.test(trimmed)) return true;
  if (/\d+\s*m[^\d,.]{0,3}\/\s*h/i.test(trimmed)) return true;
  if (/[A-Za-z]/.test(trimmed) && (trimmed.match(/\d+/g) ?? []).length >= 2) return true;
  return false;
}

export function coalesceFrenchNumericTokens(texts: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const current = texts[index].trim();
    const next = texts[index + 1]?.trim() ?? '';
    if (/^\d{1,3}$/.test(current) && THOUSANDS_FRAGMENT.test(next) && !/^(?:19|20|21|22|23)$/.test(current)) {
      out.push(`${current} ${next.replace(/[oO]$/, '0')}`);
      index += 1;
      continue;
    }
    out.push(current);
  }
  return out;
}

function parseAmount(raw: string): number | undefined {
  if (looksLikeTechnicalMeasure(raw)) return undefined;
  if (LEADING_ZERO_THOUSANDS.test(raw.trim())) return undefined;
  const unitLike = raw.trim().match(/^(-?\d{1,6})([.,])(\d{3,4})[A-Za-z]?\s*(?:€|EUR)?\s*$/i);
  if (unitLike && (unitLike[3].length === 4 || unitLike[2] === ',')) {
    const unitValue = Number(`${unitLike[1]}.${unitLike[3]}`);
    if (Number.isFinite(unitValue)) return unitValue;
  }
  const value = parseInternationalAmount(raw.replace(/\u00a0/g, ' ')).normalizedValue;
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function amountsClose(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(CENT, Math.abs(right) * 0.025);
}

function plausibleQty(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 10_000 && value < ABSURD_MAGNITUDE;
}

function plausibleMoney(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value < ABSURD_MAGNITUDE;
}

function looksConcatenatedRaw(raw: unknown): boolean {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  const parsed = parseInternationalAmount(text);
  if (
    parsed.localeEvidence.includes('multiple_decimal_amounts_in_cell') ||
    parsed.localeEvidence.includes('invalid_thousands_grouping')
  ) {
    return true;
  }
  if (/\d+[.,]\d{2}\s+\d+[.,]\d{2}/.test(text)) return true;
  if ((text.match(/\d+/g) ?? []).length >= 3 && /[A-Za-z]/.test(text)) return true;
  return false;
}

function looksAbsurdAssigned(value: number | undefined, raw?: unknown): boolean {
  if (value === undefined || !Number.isFinite(value)) return false;
  if (Math.abs(value) >= ABSURD_MAGNITUDE) return true;
  if (looksConcatenatedRaw(raw) && Math.abs(value) >= 1_000) return true;
  return false;
}

function discountFactors(input: StructuredNumericInput, percents: readonly number[]): number[] {
  const factors = [1];
  const pushDiscount = (rate: number | undefined) => {
    if (rate === undefined || !(rate > 0) || rate >= 100) return;
    // 19–23% are VAT rates, not commercial discounts on HT lines.
    if (rate >= 19 && rate <= 23) return;
    factors.push(1 - rate / 100);
  };
  pushDiscount(input.discount);
  pushDiscount(input.vatRate);
  for (const percent of percents) pushDiscount(percent);
  return [...new Set(factors)];
}

function recoverInflatedLineTotal(
  quantity: number,
  unitPrice: number,
  total: number,
  factors: readonly number[],
): number | undefined {
  const expectedValues = (factors.length > 0 ? factors : [1])
    .map((factor) => quantity * unitPrice * factor)
    .filter((value) => value > 0.009);
  if (expectedValues.length === 0 || total <= Math.min(...expectedValues) * 8) return undefined;
  for (const expected of expectedValues) {
    for (const scale of [10, 100, 1000, 10000]) {
      if (amountsClose(total / scale, expected)) {
        return Math.round(expected * 100) / 100;
      }
    }
    const expectedCents = String(Math.round(expected * 100));
    const totalDigits = String(Math.round(total));
    if (expectedCents.length >= 3 && totalDigits.startsWith(expectedCents) && total > expected * 20) {
      return Math.round(expected * 100) / 100;
    }
  }
  return undefined;
}

function qtyReconciles(
  quantity: number,
  unitPrice: number,
  total: number,
  factors: readonly number[],
): boolean {
  if (!(unitPrice > 0) || !plausibleQty(quantity) || !plausibleMoney(total)) return false;
  return factors.some((factor) => amountsClose(quantity * unitPrice * factor, total));
}

function collectPercentRates(lines: readonly string[]): number[] {
  return lines.flatMap((line) => {
    const match = line.trim().match(/^(\d+(?:[.,]\d+)?)\s*%$/);
    if (!match) return [];
    const value = Number(match[1].replace(',', '.'));
    return Number.isFinite(value) ? [value] : [];
  });
}

function collectAmountTexts(lines: readonly string[]): string[] {
  return lines.flatMap((line) => {
    const text = line.trim().replace(/\u00a0/g, ' ');
    if (!text || PERCENT_LINE.test(text)) return [];
    if (looksLikeTechnicalMeasure(text)) return [];
    if (/^(?:122|I22|22)$/i.test(text)) return [];
    if (AMOUNT_ONLY_LINE.test(text)) return [text];
    if (/^-?\d+[.,]\d{2,4}[A-Za-z]?\s*(?:€|EUR)?\s*$/i.test(text)) return [text];
    if (/^-?\d{1,3}(?:[.\s]\d{3})*,\d{2}\s*(?:€|E|EUR)?\s*$/i.test(text)) return [text];
    return [];
  });
}

function uniqueAmountLists(lists: readonly number[][]): number[][] {
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const list of lists) {
    const key = list.map((value) => value.toFixed(4)).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(list);
  }
  return out;
}

/** Expand OCR fragments such as `5` + `450,00` into `5450` without concatenating distinct amounts. */
export function expandFrenchAmountFragments(texts: readonly string[]): number[][] {
  const parsed = texts.map((text) => parseAmount(text));
  const lists: number[][] = [];
  const walk = (index: number, acc: number[]) => {
    if (index >= texts.length) {
      lists.push(acc);
      return;
    }
    const value = parsed[index];
    if (value === undefined) {
      walk(index + 1, acc);
      return;
    }
    walk(index + 1, [...acc, value]);
    if (
      index + 1 < texts.length &&
      /^\d{1,3}$/.test(texts[index].trim()) &&
      THOUSANDS_FRAGMENT.test(texts[index + 1].trim()) &&
      !/^(?:19|20|21|22|23)$/.test(texts[index].trim())
    ) {
      const merged = parseInternationalAmount(`${texts[index]} ${texts[index + 1]}`).normalizedValue;
      if (merged !== undefined && Number.isFinite(merged)) walk(index + 2, [...acc, merged]);
    }
  };
  walk(0, []);
  return uniqueAmountLists(lists);
}

interface ScoredAssignment {
  quantity: number;
  unitPrice: number;
  total: number;
  score: number;
}

function scoreAssignment(
  quantity: number,
  unitPrice: number,
  total: number,
  amounts: readonly number[],
  usedCount: number,
  factor: number,
): number {
  let score = 8 + usedCount * 4;
  const qtyIsInteger = Number.isInteger(quantity) || Math.abs(quantity - Math.round(quantity)) < 1e-6;
  const priceIsInteger = Number.isInteger(unitPrice) || Math.abs(unitPrice - Math.round(unitPrice)) < 1e-6;
  if (qtyIsInteger) score += 5;
  else score -= 4;
  if (qtyIsInteger && !priceIsInteger) score += 6;
  if (!qtyIsInteger && priceIsInteger) score -= 6;
  if (quantity <= 100) score += 3;
  if (qtyIsInteger && quantity <= 20) score += 2;
  if (quantity <= 10 && unitPrice >= quantity) score += 1;
  if (quantity === 1 && amountsClose(unitPrice, total) && amounts.some((value) => value > 1 && value !== unitPrice && value !== total)) {
    score -= 12;
  }
  if (factor !== 1) score += 2;
  if (unitPrice >= 100) score += 3;
  if (unitPrice < 100 && total >= 200) score -= 8;
  for (const leftover of amounts) {
    if (leftover > 50 && leftover !== quantity && leftover !== unitPrice && leftover !== total) {
      score -= 3;
    }
  }
  return score;
}

function inferIntegerQty(total: number, unitPrice: number, factor: number, sourceLines: readonly string[] = []): number | undefined {
  if (!(unitPrice > 0) || !(factor > 0)) return undefined;
  const candidate = total / (unitPrice * factor);
  const rounded = Math.round(candidate);
  if (!(rounded > 0) || !plausibleQty(rounded)) return undefined;
  const mentioned = sourceLines.some((line) => new RegExp(`(?:^|[^0-9.,])${rounded}(?:[^0-9.,]|$)`).test(line));
  const tolerance = mentioned ? 0.12 : 0.03;
  if (Math.abs(candidate - rounded) <= tolerance) return rounded;
  return undefined;
}

function searchAssignment(
  amounts: readonly number[],
  factors: readonly number[],
  sourceLines: readonly string[] = [],
): ScoredAssignment | undefined {
  const scored: ScoredAssignment[] = [];
  const n = amounts.length;
  const hasBareOne = sourceLines.some((line) => line.trim() === '1');
  for (let qi = 0; qi < n; qi += 1) {
    for (let pi = 0; pi < n; pi += 1) {
      if (pi === qi) continue;
      for (let ti = 0; ti < n; ti += 1) {
        if (ti === qi || ti === pi) continue;
        const quantity = amounts[qi];
        const unitPrice = amounts[pi];
        const total = amounts[ti];
        if (!plausibleQty(quantity) || !plausibleMoney(unitPrice) || !plausibleMoney(total) || !(unitPrice > 0)) {
          continue;
        }
        if (unitPrice === 1 && amountsClose(quantity, total) && quantity > 1) continue;
        if (quantity === 1 && unitPrice === 1 && total === 1 && amounts.some((value) => value > 10)) continue;
        const factor = factors.find((candidate) => amountsClose(quantity * unitPrice * candidate, total));
        if (factor === undefined) continue;
        scored.push({
          quantity,
          unitPrice,
          total,
          score: scoreAssignment(quantity, unitPrice, total, amounts, 3, factor),
        });
      }
    }
  }
  for (let pi = 0; pi < n; pi += 1) {
    for (let ti = 0; ti < n; ti += 1) {
      if (ti === pi) continue;
      const unitPrice = amounts[pi];
      const total = amounts[ti];
      if (!plausibleMoney(unitPrice) || !plausibleMoney(total) || !(unitPrice > 0)) continue;
      for (const factor of factors) {
        const quantity = inferIntegerQty(total, unitPrice, factor, sourceLines);
        if (quantity === undefined) continue;
        if (!qtyReconciles(quantity, unitPrice, total, [factor])) continue;
        if (unitPrice === 1 && amountsClose(quantity, total) && quantity > 1) continue;
        if (quantity === 1 && unitPrice === 1 && total === 1 && amounts.some((value) => value > 10)) continue;
        const qtyPresent = amounts.some((value) => amountsClose(value, quantity));
        if (!qtyPresent && !(quantity === 1 && hasBareOne)) continue;
        if (unitPrice <= 1 && quantity >= 100) continue;
        scored.push({
          quantity,
          unitPrice,
          total,
          score: scoreAssignment(quantity, unitPrice, total, amounts, qtyPresent ? 2 : 1, factor),
        });
      }
    }
  }
  scored.sort((left, right) => right.score - left.score);
  return scored[0];
}

function parseColumnMoney(raw: unknown): number | undefined {
  const text = String(raw ?? '').trim();
  if (!text || looksLikeTechnicalMeasure(text)) return undefined;
  const direct = parseInternationalAmount(text);
  if (direct.normalizedValue !== undefined && !looksConcatenatedRaw(text)) return direct.normalizedValue;
  const coalesced = coalesceFrenchNumericTokens(text.split(/\s+/).filter(Boolean));
  if (coalesced.length === 1) {
    const value = parseInternationalAmount(coalesced[0]).normalizedValue;
    return value !== undefined && Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function looksLikeSplitFrenchThousands(input: StructuredNumericInput): boolean {
  const coalesced = coalesceFrenchNumericTokens((input.sourceLines ?? []).map((line) => line.trim()));
  return coalesced.some((token) => {
    if (!/\s\d{3}[.,]/.test(token) && !/^\d{1,3}[ \u00a0]\d{3}/.test(token)) return false;
    const value = parseAmount(token);
    if (value === undefined || value < 100) return false;
    const assigned = input.unitPrice ?? input.total;
    if (assigned === undefined || assigned >= 100) return false;
    const prefix = String(Math.floor(value)).slice(0, String(Math.floor(assigned)).length);
    return prefix === String(Math.floor(assigned));
  });
}


function recoverSplitCentTotal(
  input: StructuredNumericInput,
  factors: readonly number[],
): { quantity: number; unitPrice: number; total: number } | undefined {
  const unitPrice = input.unitPrice;
  if (unitPrice === undefined || !plausibleMoney(unitPrice) || unitPrice <= 0) return undefined;
  const lines = (input.sourceLines ?? []).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!/^\d{2,7}$/.test(lines[index]) || !/^\d{2}$/.test(lines[index + 1])) continue;
    const total = Number(`${lines[index]}.${lines[index + 1]}`);
    if (!plausibleMoney(total) || total <= 0) continue;
    for (const factor of factors) {
      if (!(factor > 0)) continue;
      const rawQty = total / (unitPrice * factor);
      const quantity = Math.round(rawQty);
      if (!(quantity > 0 && quantity <= 1000)) continue;
      const expected = quantity * unitPrice * factor;
      if (Math.abs(expected - total) <= Math.max(CENT, Math.abs(total) * 0.001)) {
        return { quantity, unitPrice, total };
      }
    }
  }
  return undefined;
}

function peelQuantityFromPriceColumn(raw: unknown): { quantity?: number; unitPrice?: number } {
  const tokens = coalesceFrenchNumericTokens(String(raw ?? '').trim().split(/\s+/).filter(Boolean));
  if (tokens.length === 2) {
    const quantity = parseInternationalAmount(tokens[0]).normalizedValue;
    const unitPrice = parseInternationalAmount(tokens[1]).normalizedValue;
    if (
      quantity !== undefined &&
      unitPrice !== undefined &&
      plausibleQty(quantity) &&
      plausibleMoney(unitPrice) &&
      unitPrice >= quantity
    ) {
      return { quantity, unitPrice };
    }
  }
  const unitPrice = parseColumnMoney(raw);
  return unitPrice !== undefined ? { unitPrice } : {};
}

/**
 * Recover qty / unitPrice / total from structured evidence.
 * Column geometry wins over description/SKU digits; concatenated OCR fragments
 * are split using French space-thousands + discount-aware arithmetic.
 */
export function repairStructuredLineItemNumerics(
  input: StructuredNumericInput,
): RepairedLineItemNumbers | undefined {
  const factors = discountFactors(input, collectPercentRates(input.sourceLines ?? []));
  const assignedOk =
    input.quantity !== undefined &&
    input.unitPrice !== undefined &&
    input.total !== undefined &&
    !looksAbsurdAssigned(input.quantity, input.quantityRaw) &&
    !looksAbsurdAssigned(input.unitPrice, input.unitPriceRaw) &&
    !looksAbsurdAssigned(input.total, input.lineTotalRaw) &&
    !looksLikeTechnicalMeasure(String(input.quantityRaw ?? '')) &&
    !looksLikeTechnicalMeasure(String(input.unitPriceRaw ?? '')) &&
    qtyReconciles(input.quantity, input.unitPrice, input.total, factors) &&
    !looksLikeSplitFrenchThousands(input);

  if (assignedOk) {
    return {
      quantity: input.quantity!,
      unitPrice: input.unitPrice!,
      total: input.total!,
      reason: 'structured_numeric_unchanged',
    };
  }

  // OCR can split the cents of a line total into the next token (e.g. whole
  // amount + two cent digits). Recover it only when the merged amount gives an
  // almost exact integer quantity x unit price reconciliation.
  const splitCent = recoverSplitCentTotal(input, factors);
  if (splitCent) {
    return { ...splitCent, reason: 'split_cent_line_total_recovered' };
  }

  if (
    input.quantity !== undefined &&
    input.unitPrice !== undefined &&
    input.total !== undefined
  ) {
    const recoveredTotal = recoverInflatedLineTotal(
      input.quantity,
      input.unitPrice,
      input.total,
      factors,
    );
    if (recoveredTotal !== undefined) {
      return {
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        total: recoveredTotal,
        reason: 'inflated_line_total_rescaled_from_qty_price',
      };
    }
  }

  const peeled = peelQuantityFromPriceColumn(input.unitPriceRaw);
  const columnQty = parseColumnMoney(input.quantityRaw) ?? peeled.quantity;
  const columnPrice = peeled.unitPrice ?? parseColumnMoney(input.unitPriceRaw) ?? input.unitPrice;
  const columnTotal = parseColumnMoney(input.lineTotalRaw) ?? input.total;
  if (columnPrice !== undefined && columnTotal !== undefined) {
    const inferredQty = inferIntegerQty(columnTotal, columnPrice, factors.find((factor) => {
      const qty = inferIntegerQty(columnTotal, columnPrice, factor, input.sourceLines ?? []);
      return qty !== undefined && qtyReconciles(qty, columnPrice, columnTotal, [factor]);
    }) ?? 1, input.sourceLines ?? []);
    const inferredPresent = inferredQty !== undefined && (input.sourceLines ?? []).some((line) => {
      const parsed = parseAmount(line);
      if (parsed !== undefined && amountsClose(parsed, inferredQty)) return true;
      return new RegExp(`(?:^|[^0-9.,])${inferredQty}(?:[^0-9.,]|$)`).test(line);
    });
    const assignedOneBroken = input.quantity === 1
      && inferredQty !== undefined
      && inferredQty > 1
      && !qtyReconciles(1, columnPrice, columnTotal, factors);
    const quantity = columnQty
      ?? (inferredPresent ? inferredQty : undefined)
      ?? (assignedOneBroken && inferredPresent ? inferredQty : undefined);
    const swapped = quantity !== undefined && quantity > columnPrice && quantity >= 100 && columnPrice <= 20;
    const trivial =
      quantity !== undefined &&
      ((columnPrice <= 1 && quantity === columnTotal) ||
        (columnPrice < 10 && columnTotal < 50) ||
        swapped);
    if (quantity !== undefined && !trivial && qtyReconciles(quantity, columnPrice, columnTotal, factors)) {
      return {
        quantity,
        unitPrice: columnPrice,
        total: columnTotal,
        reason: 'column_geometry_discount_aware',
      };
    }
  }

  const amountTexts = collectAmountTexts(input.sourceLines ?? []);
  const discountPercents = collectPercentRates(input.sourceLines ?? []);
  const preferredQty =
    input.quantity !== undefined &&
    input.quantity !== 1 &&
    plausibleQty(input.quantity) &&
    input.quantity <= 100 &&
    !looksAbsurdAssigned(input.quantity, input.quantityRaw) &&
    !discountPercents.some((rate) => Math.abs(rate - input.quantity!) < 0.01)
      ? input.quantity
      : undefined;
  const assignments = expandFrenchAmountFragments(amountTexts)
    .map((amounts) => searchAssignment(amounts, factors, input.sourceLines ?? []))
    .filter((assignment): assignment is ScoredAssignment => assignment !== undefined)
    .sort((left, right) => {
      if (preferredQty !== undefined) {
        const leftPref = amountsClose(left.quantity, preferredQty) ? 1 : 0;
        const rightPref = amountsClose(right.quantity, preferredQty) ? 1 : 0;
        if (leftPref !== rightPref) {
          if (leftPref && right.score > left.score + 6) return 1;
          if (rightPref && left.score > right.score + 6) return -1;
          return rightPref - leftPref;
        }
      }
      return right.score - left.score;
    });

  const repaired = assignments[0];
  if (repaired) {
    const recoveredTotal = recoverInflatedLineTotal(
      repaired.quantity,
      repaired.unitPrice,
      repaired.total,
      factors,
    ) ?? (
      input.quantity !== undefined && input.unitPrice !== undefined
        ? recoverInflatedLineTotal(input.quantity, input.unitPrice, repaired.total, factors)
        : undefined
    );
    return {
      quantity: repaired.quantity,
      unitPrice: repaired.unitPrice,
      total: recoveredTotal ?? repaired.total,
      reason: recoveredTotal ? 'inflated_line_total_rescaled_from_qty_price' : 'source_lines_discount_aware_repair',
    };
  }

  if (
    input.quantity !== undefined &&
    input.unitPrice !== undefined &&
    input.total !== undefined &&
    plausibleQty(input.quantity) &&
    plausibleMoney(input.unitPrice) &&
    plausibleMoney(input.total) &&
    !looksAbsurdAssigned(input.unitPrice, input.unitPriceRaw)
  ) {
    return {
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      total: input.total,
      reason: 'structured_numeric_kept_unreconciled',
    };
  }

  return undefined;
}

export function concatenatedAmountRejected(value: number | undefined, raw?: unknown): boolean {
  return looksAbsurdAssigned(value, raw);
}

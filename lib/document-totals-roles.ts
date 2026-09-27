import type { DocumentEvidence, DocumentLayoutLine } from './document-structure';
import { logSemanticRoleViolation } from './document-field-evidence';

const CENT = 0.05;

export function amountsClose(left?: number, right?: number): boolean {
  if (left === undefined || right === undefined) return false;
  return Math.abs(left - right) <= CENT;
}

export function isPlausibleDocumentDiscountAmount(value: number, goodsSubtotal?: number): boolean {
  const magnitude = Math.abs(value);
  if (!(magnitude > 0)) return false;
  if (goodsSubtotal === undefined || goodsSubtotal <= 0) return magnitude < 1_000_000;
  if (amountsClose(magnitude, goodsSubtotal)) return false;
  return magnitude <= goodsSubtotal * 0.2 + CENT;
}

export function grandTotalCannotEqualTaxable(input: {
  taxable?: number;
  subtotal?: number;
  vatAmount?: number;
  grandTotal?: number;
}): boolean {
  const total = input.grandTotal;
  if (total === undefined) return false;
  const vat = input.vatAmount;
  const taxable = input.taxable ?? input.subtotal;
  if (taxable === undefined) return false;
  if (!amountsClose(total, taxable)) return false;
  if (vat !== undefined && vat > CENT) return true;
  return false;
}

function looksLikeMoneyToken(text: string, value: number | undefined): boolean {
  if (value === undefined || !Number.isFinite(value)) return false;
  if (value <= CENT) return false;
  return /[.,]\d{2}/.test(text) || /(?:€|EUR|USD|GBP|CHF)/i.test(text);
}

export function recoverGrandTotalAboveTaxable(input: {
  lines: readonly DocumentLayoutLine[];
  taxable?: number;
  parseAmount: (text: string) => number | undefined;
  toEvidence: (raw: string, line: DocumentLayoutLine, reason: string) => DocumentEvidence<number> | undefined;
}): DocumentEvidence<number> | undefined {
  const taxable = input.taxable;
  if (taxable === undefined || taxable <= CENT) return undefined;
  const blocked = new Set(['historical_recap', 'commercial_table_body', 'commercial_table_header', 'header']);
  let best: { evidence: DocumentEvidence<number>; value: number } | undefined;
  for (const line of input.lines) {
    if (line.semanticRegion && blocked.has(line.semanticRegion)) continue;
    const value = input.parseAmount(line.text);
    if (!looksLikeMoneyToken(line.text, value) || value === undefined) continue;
    if (!(value > taxable + CENT)) continue;
    const evidence = input.toEvidence(line.text, line, 'grand_total_strictly_above_taxable');
    if (!evidence) continue;
    if (!best || value > best.value) best = { evidence, value };
  }
  return best?.evidence;
}

export function rejectTaxablePromotedToGrandTotal<T extends { normalizedValue?: number }>(input: {
  total?: T;
  taxable?: number;
  subtotal?: number;
  vatAmount?: number;
  stage: string;
}): T | undefined {
  const totalValue = input.total?.normalizedValue;
  if (!grandTotalCannotEqualTaxable({
    taxable: input.taxable,
    subtotal: input.subtotal,
    vatAmount: input.vatAmount,
    grandTotal: totalValue,
  })) {
    return input.total;
  }
  logSemanticRoleViolation({
    field: 'grandTotal',
    fromRole: 'taxable',
    toRole: 'grandTotal',
    value: totalValue,
    stage: input.stage,
    reason: 'taxable_cannot_become_grand_total',
  });
  return undefined;
}

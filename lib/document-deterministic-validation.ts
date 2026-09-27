import type { AiLineItem, AiStructuredDocumentExtract } from './document-ai-contract';

export type DeterministicValidationStatus = 'valid' | 'conflict' | 'invalid' | 'not_applicable';

export interface DeterministicValidationIssue {
  fieldPath: string;
  code: string;
  status: DeterministicValidationStatus;
  blocking: boolean;
  expected?: number | string;
  actual?: number | string;
}

export interface DeterministicDocumentValidation {
  issues: DeterministicValidationIssue[];
  blocking: boolean;
  requiresReview: boolean;
}

const amountTolerance = (value: number): number => Math.max(0.02, Math.abs(value) * 0.001);
const close = (left: number, right: number): boolean => Math.abs(left - right) <= amountTolerance(right);

function numericEvidence(text: string): number[] {
  const comparableText = text.replace(/\b\d+\s+color[ei]\b/gi, '');
  return [...comparableText.matchAll(/(?<![A-Za-z])[-+]?\d[\d.]*([,]\d+)?/g)].flatMap((match) => {
    const raw = match[0];
    const normalized = raw.includes(',')
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw;
    const value = Number(normalized);
    return Number.isFinite(value) ? [value] : [];
  });
}

function evidenceContains(value: number, numbers: readonly number[]): boolean {
  return numbers.some((candidate) => close(candidate, value));
}

function validateItem(item: AiLineItem, index: number): DeterministicValidationIssue[] {
  const issues: DeterministicValidationIssue[] = [];
  const quantity = item.quantity?.value;
  const unitPrice = item.unitPrice?.value;
  const total = item.lineTotal?.value;
  if (quantity !== undefined && unitPrice !== undefined && total !== undefined) {
    const base = quantity * unitPrice;
    const discount = item.discount?.value;
    const discountCandidates = discount === undefined
      ? [base]
      : item.discountType?.value === 'percentage'
        ? [base * (1 - discount / 100)]
        : item.discountType?.value === 'amount'
          ? [base - discount]
          : [base * (1 - discount / 100), base - discount];
    const vatRate = item.vatRate?.value;
    const candidates = [...discountCandidates];
    if (item.vatIncluded?.value === true && vatRate !== undefined) {
      candidates.push(...discountCandidates.map((net) => net * (1 + vatRate / 100)));
    }
    if (!candidates.some((expected) => close(expected, total))) {
      issues.push({ fieldPath: `items.${index}.lineTotal`, code: 'quantity_times_unit_price_mismatch', status: 'conflict', blocking: true, expected: candidates[0], actual: total });
    }
  }
  const numbers = numericEvidence(item.evidenceText);
  for (const [name, value] of [['quantity', quantity], ['unitPrice', unitPrice], ['lineTotal', total]] as const) {
    if (value !== undefined && numbers.length > 0 && !evidenceContains(value, numbers)) {
      issues.push({ fieldPath: `items.${index}.${name}`, code: 'value_not_observed_in_line_evidence', status: 'conflict', blocking: true, actual: value });
    }
  }
  return issues;
}

export function isValidIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

export function isPlausibleDocumentNumber(value: string, exclusions: readonly string[] = []): boolean {
  const normalized = value.replace(/[\s.-]/g, '').toUpperCase();
  if (normalized.length < 3 || normalized.length > 32 || !/\d/.test(normalized)) return false;
  return !exclusions.some((candidate) => candidate && candidate.replace(/[\s.-]/g, '').toUpperCase() === normalized);
}

export function isPlausibleIban(value: string): boolean {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function validateStructuredAiDocument(
  document: AiStructuredDocumentExtract,
): DeterministicDocumentValidation {
  const issues = document.items.flatMap(validateItem);
  const lineTotals = document.items.map((item) => {
    const value = item.lineTotal?.value;
    const vatRate = item.vatRate?.value;
    return value !== undefined && item.vatIncluded?.value === true && vatRate !== undefined
      ? value / (1 + vatRate / 100)
      : value;
  });
  if (lineTotals.length > 0 && lineTotals.every((value): value is number => value !== undefined)) {
    const lineSum = lineTotals.reduce((sum, value) => sum + value, 0);
    const shipping = document.summary.shippingCost?.value ?? 0;
    const charges = document.summary.additionalCharges?.value ?? 0;
    const discount = document.summary.discountTotal?.value ?? 0;
    const taxable = document.summary.taxableAmount?.value ?? document.summary.subtotal?.value;
    const taxableCandidates = [lineSum, lineSum - discount + shipping + charges];
    if (taxable !== undefined && !taxableCandidates.some((expected) => close(expected, taxable))) {
      issues.push({ fieldPath: 'summary.taxableAmount', code: 'line_sum_mismatch', status: 'conflict', blocking: true, expected: taxableCandidates[1], actual: taxable });
    }
  }
  const subtotal = document.summary.subtotal?.value ?? document.summary.taxableAmount?.value;
  const vat = document.summary.vatAmount?.value;
  const total = document.summary.total?.value;
  if (subtotal !== undefined && vat !== undefined && total !== undefined) {
    const discount = document.summary.discountTotal?.value ?? 0;
    const shipping = document.summary.shippingCost?.value ?? 0;
    const charges = document.summary.additionalCharges?.value ?? 0;
    const candidates = [subtotal + vat, subtotal - discount + shipping + charges + vat];
    if (!candidates.some((expected) => close(expected, total))) {
      issues.push({ fieldPath: 'summary.total', code: 'subtotal_plus_vat_mismatch', status: 'conflict', blocking: true, expected: candidates[0], actual: total });
    }
  }
  const deposit = document.summary.deposit?.value;
  const balance = document.summary.balance?.value;
  if (total !== undefined && deposit !== undefined && balance !== undefined && !close(total - deposit, balance)) {
    issues.push({ fieldPath: 'summary.balance', code: 'total_minus_deposit_mismatch', status: 'conflict', blocking: true, expected: total - deposit, actual: balance });
  }
  for (const key of ['issueDate', 'dueDate', 'validityDate'] as const) {
    const value = document.document[key]?.value;
    if (value && !isValidIsoDate(value)) issues.push({ fieldPath: `document.${key}`, code: 'invalid_calendar_date', status: 'invalid', blocking: true, actual: value });
  }
  const ibanFields = [document.issuer?.iban, document.customer?.iban, document.conditions.iban];
  ibanFields.forEach((field, index) => {
    if (field && !isPlausibleIban(field.value)) issues.push({ fieldPath: `iban.${index}`, code: 'invalid_iban_checksum', status: 'invalid', blocking: true, actual: field.value });
  });
  const currency = document.document.currency?.value ?? document.summary.currency?.value;
  if (currency && !/^[A-Z]{3}$/.test(currency)) issues.push({ fieldPath: 'document.currency', code: 'invalid_currency_code', status: 'invalid', blocking: true, actual: currency });
  return { issues, blocking: issues.some((issue) => issue.blocking), requiresReview: issues.length > 0 };
}

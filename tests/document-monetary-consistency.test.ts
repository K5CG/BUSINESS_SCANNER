import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentEvidence, StructuredDocumentSummary, StructuredLineItem } from '../lib/document-structure';
import { validateDocumentMonetaryConsistency } from '../lib/document-monetary-consistency';

function evidence(value: number, rawValue: unknown = value): DocumentEvidence<number> {
  return {
    rawValue,
    normalizedValue: value,
    pageIndex: 0,
    sourceLineIds: ['p1-l1'],
    sourceLines: [String(rawValue)],
    validationStatus: 'valid',
    confidenceType: 'heuristic',
    reasons: ['test_evidence'],
    requiresReview: false,
    alternatives: [],
  };
}

function item(quantity: number, price: number, total: number): StructuredLineItem {
  return {
    quantity: evidence(quantity), unitPrice: evidence(price), lineTotal: evidence(total),
    pageIndex: 0, sourceLineIds: ['p1-l1'], sourceLines: [`${quantity} x ${price} = ${total}`], requiresReview: false,
  };
}

function summary(subtotal?: number, vat?: number, total?: number): StructuredDocumentSummary {
  return {
    ...(subtotal !== undefined ? { subtotal: evidence(subtotal), taxableAmount: evidence(subtotal) } : {}),
    ...(vat !== undefined ? { vatAmount: evidence(vat) } : {}),
    taxSummaries: [],
    ...(total !== undefined ? { total: evidence(total) } : {}),
    conflicts: [],
    requiresReview: false,
  };
}

test('25 per 20 uguale 500 resta coerente', () => {
  const result = validateDocumentMonetaryConsistency([item(25, 20, 500)], summary(500, 110, 610));
  assert.equal(result.consistent, true);
  assert.deepEqual(result.conflicts, []);
});

test('conflitto matematico marca la riga senza correggere il totale', () => {
  const result = validateDocumentMonetaryConsistency([item(25, 20, 490)], summary());
  assert.equal(result.consistent, false);
  assert.equal(result.items[0].lineTotal?.normalizedValue, 490);
  assert.equal(result.items[0].lineTotal?.conflict, true);
  assert.equal(result.items[0].requiresReview, true);
});

test('somma righe coerente con imponibile', () => {
  const result = validateDocumentMonetaryConsistency([item(1, 100, 100), item(2, 50, 100)], summary(200));
  assert.equal(result.conflicts.includes('line_sum_subtotal_mismatch'), false);
});

test('somma righe incoerente conserva imponibile raw e richiede review', () => {
  const source = summary(250);
  source.subtotal = evidence(250, '250,00');
  const result = validateDocumentMonetaryConsistency([item(1, 100, 100), item(2, 50, 100)], source);
  assert.equal(result.summary.subtotal?.rawValue, '250,00');
  assert.equal(result.summary.subtotal?.normalizedValue, 250);
  assert.equal(result.summary.subtotal?.conflict, true);
});

test('imponibile piu IVA coerente con totale', () => {
  const result = validateDocumentMonetaryConsistency([], summary(100, 22, 122));
  assert.equal(result.conflicts.includes('subtotal_vat_total_mismatch'), false);
});

test('imponibile piu IVA incoerente non viene corretto silenziosamente', () => {
  const result = validateDocumentMonetaryConsistency([], summary(100, 22, 120));
  assert.equal(result.summary.total?.normalizedValue, 120);
  assert.equal(result.summary.total?.conflict, true);
  assert.ok(result.conflicts.includes('subtotal_vat_total_mismatch'));
});

test('aliquote multiple devono sommare all IVA riepilogativa', () => {
  const source = summary(100, 20, 120);
  source.taxSummaries = [
    { vatAmount: evidence(10), pageIndex: 0, requiresReview: false },
    { vatAmount: evidence(8), pageIndex: 0, requiresReview: false },
  ];
  const result = validateDocumentMonetaryConsistency([], source);
  assert.ok(result.conflicts.includes('tax_summary_vat_mismatch'));
});

test('campi mancanti restano mancanti e non diventano zero', () => {
  const result = validateDocumentMonetaryConsistency([], summary());
  assert.equal(result.summary.subtotal, undefined);
  assert.equal(result.summary.vatAmount, undefined);
  assert.equal(result.summary.total, undefined);
});

test('sconto percentuale viene considerato nel prodotto', () => {
  const discounted = item(2, 100, 180);
  discounted.discount = evidence(10, '10%');
  const result = validateDocumentMonetaryConsistency([discounted], summary());
  assert.equal(result.consistent, true);
});

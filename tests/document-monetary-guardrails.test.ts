import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeDocumentMonetaryFields } from '../lib/document-monetary-guardrails';

test('scarta imponibile > totale (Pendingomme QA)', () => {
  const result = sanitizeDocumentMonetaryFields({
    total: 1400,
    subtotal: 483473.6422,
  });
  assert.equal(result.subtotal, undefined);
  assert.equal(result.total, 1400);
  assert.ok(result.rejected.includes('subtotal_exceeds_total'));
});

test('scarta totale 15 e imponibile assurdo (Künzi QA)', () => {
  const result = sanitizeDocumentMonetaryFields({
    total: 15,
    subtotal: 1451.65,
    items: [{ total: 422.95 }, { total: 75 }],
  });
  assert.equal(result.total, undefined);
  assert.equal(result.subtotal, undefined);
  assert.ok(result.rejected.includes('subtotal_exceeds_total'));
});

test('conserva totali coerenti', () => {
  const result = sanitizeDocumentMonetaryFields({
    total: 680.7,
    subtotal: 557.95,
    vatAmount: 122.75,
  });
  assert.equal(result.total, 680.7);
  assert.equal(result.subtotal, 557.95);
  assert.equal(result.vatAmount, 122.75);
  assert.equal(result.rejected.length, 0);
});

test('preserves coherent subtotal+VAT+total when line items exceed total', () => {
  const result = sanitizeDocumentMonetaryFields({
    total: 47578.8,
    subtotal: 39649,
    vatAmount: 7929.8,
    items: [
      { total: 20000 },
      { total: 20000 },
      { total: 10000 },
    ],
  });
  assert.equal(result.total, 47578.8);
  assert.equal(result.subtotal, 39649);
  assert.equal(result.vatAmount, 7929.8);
  assert.ok(result.rejected.includes('line_items_exceed_total_ignored_coherent_triplet'));
});

test('still rejects line items exceeding total when monetary triplet is incoherent', () => {
  const result = sanitizeDocumentMonetaryFields({
    total: 100,
    subtotal: 50,
    vatAmount: 10,
    items: [{ total: 200 }, { total: 200 }],
  });
  assert.equal(result.total, undefined);
  assert.ok(result.rejected.includes('line_items_exceed_total'));
});

test('scarta P.IVA interpretata come importo IVA', () => {
  const result = sanitizeDocumentMonetaryFields({
    total: 1400,
    vatAmount: 12345678901,
  });
  assert.equal(result.vatAmount, undefined);
  assert.ok(result.rejected.includes('vat_amount_looks_like_fiscal_id'));
});

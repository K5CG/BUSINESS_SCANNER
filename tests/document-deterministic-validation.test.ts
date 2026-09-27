import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlausibleDocumentNumber, isPlausibleIban, isValidIsoDate, validateStructuredAiDocument } from '../lib/document-deterministic-validation';
import type { AiField, AiStructuredDocumentExtract } from '../lib/document-ai-contract';

const field = <T>(value: T, evidenceText = String(value)): AiField<T> => ({ value, pageIndex: 0, evidenceText, confidenceType: 'unknown', requiresReview: true, alternatives: [] });
const base = (): AiStructuredDocumentExtract => ({ schemaVersion: 2, document: { documentType: field('order'), currency: field('EUR') }, items: [], summary: {}, conditions: {}, conflicts: [], requiresReview: true });

test('quadratura generale valida', () => {
  const doc = base();
  doc.items = [{ description: field('Riga'), quantity: field(2, '2'), unitPrice: field(50, '50,00'), lineTotal: field(100, '100,00'), pageIndex: 0, evidenceText: 'Riga 2 50,00 100,00', requiresReview: true }];
  doc.summary = { subtotal: field(100), vatAmount: field(22), total: field(122), currency: field('EUR') };
  assert.equal(validateStructuredAiDocument(doc).blocking, false);
});

test('KÜNZI marca la terza riga e la somma articoli incoerente', () => {
  const doc = base();
  doc.items = [
    { description: field('Multiuso'), quantity: field(50), unitPrice: field(8.46), lineTotal: field(422.95), pageIndex: 0, evidenceText: 'Multiuso 50 8,46 422,95', requiresReview: true },
    { description: field('Impianto'), quantity: field(1), unitPrice: field(75), lineTotal: field(75), pageIndex: 0, evidenceText: 'Impianto 1 75,00 75,00', requiresReview: true },
    { description: field('Tampografia'), quantity: field(1), unitPrice: field(0.9), lineTotal: field(0.9), pageIndex: 0, evidenceText: 'Tampografia 50 0,90 45,00', requiresReview: true },
    { description: field('Logo'), quantity: field(1), unitPrice: field(0), lineTotal: field(0), pageIndex: 0, evidenceText: 'Logo 1 0,00 0,00', requiresReview: true },
  ];
  doc.summary = { subtotal: field(557.95), shippingCost: field(15), vatAmount: field(122.75), total: field(680.7), currency: field('EUR') };
  const result = validateStructuredAiDocument(doc);
  assert.equal(result.blocking, true);
  assert.ok(result.issues.some((issue) => issue.fieldPath === 'items.2.quantity'));
  assert.ok(result.issues.some((issue) => issue.code === 'line_sum_mismatch'));
  assert.ok(!result.issues.some((issue) => issue.fieldPath === 'summary.total'));
});

test('date, numero e IBAN usano guardie formali', () => {
  assert.equal(isValidIsoDate('2026-03-27'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isPlausibleDocumentNumber('2026002581', ['39029']), true);
  assert.equal(isPlausibleDocumentNumber('39029', ['39029']), false);
  assert.equal(isPlausibleIban('IT60X0542811101000000123456'), true);
  assert.equal(isPlausibleIban('IT00X0542811101000000123456'), false);
});

test('missing resta missing e non viene trasformato in zero', () => {
  const doc = base();
  const result = validateStructuredAiDocument(doc);
  assert.equal(result.issues.length, 0);
  assert.equal(doc.summary.total, undefined);
});

test('sconto, IVA inclusa, spese e acconto usano formule dichiarate', () => {
  const doc = base();
  doc.items = [{ description: field('Riga'), quantity: field(2, '2'), unitPrice: field(50, '50,00'), vatRate: field(22, '22%'), vatIncluded: field(true, 'IVA inclusa'), lineTotal: field(122, '122,00'), pageIndex: 0, evidenceText: 'Riga 2 50,00 22% 122,00', requiresReview: true }];
  doc.summary = { subtotal: field(100), discountTotal: field(10), shippingCost: field(5), additionalCharges: field(5), vatAmount: field(22), total: field(122), deposit: field(20), balance: field(102) };
  assert.equal(validateStructuredAiDocument(doc).blocking, false);
});

test('sconto ambiguo accetta sia percentuale sia importo senza inventarne il tipo', () => {
  const amount = base();
  amount.items = [{ description: field('Riga'), quantity: field(2, '2'), unitPrice: field(100, '100'), discount: field(10, '10'), lineTotal: field(190, '190'), pageIndex: 0, evidenceText: 'Riga 2 100 10 190', requiresReview: true }];
  assert.equal(validateStructuredAiDocument(amount).blocking, false);
  const percentage = base();
  percentage.items = [{ description: field('Riga'), quantity: field(2, '2'), unitPrice: field(100, '100'), discount: field(10, '10'), lineTotal: field(180, '180'), pageIndex: 0, evidenceText: 'Riga 2 100 10 180', requiresReview: true }];
  assert.equal(validateStructuredAiDocument(percentage).blocking, false);
});

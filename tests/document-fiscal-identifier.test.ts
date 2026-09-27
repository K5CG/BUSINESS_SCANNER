import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentItemsAndTotals } from '../lib/document-items-totals';
import { classifyFiscalIdentifierAmount } from '../lib/document-fiscal-identifier';
import { reconcileVatWithExistingTotals } from '../lib/document-monetary-guardrails';

function cell(text: string, x: number, y: number, page = 0): OcrLine & { page: number } {
  return { text, confidence: 0.9, boundingBox: { x, y, width: 220, height: 22 }, page };
}

function page(pageIndex: number, lines: OcrLine[]) {
  return { pageIndex, width: 1000, height: 1400, lines, rawText: lines.map((line) => line.text).join('\n') };
}

function summaryOf(lines: OcrLine[]) {
  return extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)])).summary;
}

test('identificativo IVA non diventa un importo', () => {
  assert.equal(classifyFiscalIdentifierAmount('01908170614', 'VAT 01908170614').fiscal, true);
  assert.equal(classifyFiscalIdentifierAmount('VAT 01908170614').fiscal, true);
  assert.equal(classifyFiscalIdentifierAmount('IT01908170614').fiscal, true);
  assert.equal(classifyFiscalIdentifierAmount('123456789', 'VAT ID DE123456789').fiscal, true);
  assert.equal(classifyFiscalIdentifierAmount('03468110246', 'P.IVA 03468110246').fiscal, true);
  assert.equal(classifyFiscalIdentifierAmount('12345678901', 'TVA FR12345678901').fiscal, true);
});

test('importi con valuta o decimali restano importi', () => {
  assert.equal(classifyFiscalIdentifierAmount('122.75', 'VAT 22% 122.75 EUR').fiscal, false);
  assert.equal(classifyFiscalIdentifierAmount('€ 79,78', 'IVA 22% € 79,78').fiscal, false);
  assert.equal(classifyFiscalIdentifierAmount('0', 'VAT 0').fiscal, false);
  assert.equal(classifyFiscalIdentifierAmount('12.345.678,90', 'Totale 12.345.678,90').fiscal, false);
  assert.equal(classifyFiscalIdentifierAmount('491,26', 'IVA 22% 491,26').fiscal, false);
  assert.equal(classifyFiscalIdentifierAmount('2.233,00', 'Imponibile 2.233,00').fiscal, false);
});

test('riga con solo identificativo IVA non produce importo ne riepilogo imposta', () => {
  const summary = summaryOf([
    cell('Totale imponibile 1.000,00', 600, 900),
    cell('VAT 01908170614', 600, 940),
    cell('Totale documento 1.000,00', 600, 1000),
  ]);
  assert.notEqual(summary.vatAmount?.normalizedValue, 1908170614);
  assert.equal(summary.taxSummaries.some((entry) => entry.vatAmount?.normalizedValue === 1908170614), false);
  assert.equal(summary.subtotal?.normalizedValue, 1000);
  assert.equal(summary.total?.normalizedValue, 1000);
});

test('etichetta VAT ID non genera un riepilogo imposta', () => {
  const summary = summaryOf([
    cell('Totale imponibile 1.000,00', 600, 900),
    cell('VAT ID: IT01908170614', 600, 940),
    cell('Totale documento 1.000,00', 600, 1000),
  ]);
  assert.equal(summary.taxSummaries.length, 0);
  assert.equal(summary.vatAmount?.normalizedValue, undefined);
});

test('reverse charge azzera l IVA invece di lasciarla mancante', () => {
  const summary = summaryOf([
    cell('Totale imponibile 1.000,00', 600, 900),
    cell('Reverse Charge 0%', 600, 940),
    cell('Totale documento 1.000,00', 600, 1000),
  ]);
  assert.equal(summary.vatAmount?.normalizedValue, 0);
  const entry = summary.taxSummaries.find((item) => item.vatNature);
  assert.match(entry?.vatNature?.normalizedValue ?? '', /reverse charge/i);
  assert.equal(entry?.vatRate?.normalizedValue, 0);
});

test('IVA monetaria continua a essere estratta', () => {
  const summary = summaryOf([
    cell('Imponibile 2.233,00', 600, 900),
    cell('IVA 22% 491,26', 600, 940),
    cell('Totale documento 2.724,26', 600, 1000),
  ]);
  assert.equal(summary.subtotal?.normalizedValue, 2233);
  assert.equal(summary.vatAmount?.normalizedValue, 491.26);
  assert.equal(summary.total?.normalizedValue, 2724.26);
});

test('IVA locale non sovrascrive totali gia coerenti senza imposta', () => {
  assert.deepEqual(reconcileVatWithExistingTotals(1908170614, { subtotal: 1000, total: 1000 }), {
    rejected: 'vat_conflicts_with_zero_vat_totals',
  });
  assert.deepEqual(reconcileVatWithExistingTotals(0, { subtotal: 1000, total: 1000 }), { vatAmount: 0 });
  assert.deepEqual(reconcileVatWithExistingTotals(491.26, { subtotal: 2233, total: 2724.26 }), {
    vatAmount: 491.26,
  });
  assert.deepEqual(reconcileVatWithExistingTotals(491.26, { subtotal: 2233 }), { vatAmount: 491.26 });
});

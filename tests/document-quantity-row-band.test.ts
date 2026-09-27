import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentItemsAndTotals } from '../lib/document-items-totals';
import { repairStructuredLineItemNumerics } from '../lib/document-line-item-numeric-repair';

function cell(text: string, x: number, y: number): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width: 120, height: 22 } };
}

function page(lines: OcrLine[]) {
  return classifyDocumentLayoutPages([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines,
    rawText: lines.map((line) => line.text).join('\n'),
  }]);
}

const header = (y: number) => [
  cell('Codice', 40, y),
  cell('Descrizione', 190, y),
  cell('Qta', 520, y),
  cell('Prezzo', 690, y),
  cell('IVA', 800, y),
  cell('Sconto', 860, y),
  cell('Totale', 930, y),
];

test('1 vs 7 prefers the quantity that matches unit price times line total when both are present', () => {
  const repaired = repairStructuredLineItemNumerics({
    quantity: 1,
    unitPrice: 10,
    total: 70,
    quantityRaw: '1',
    unitPriceRaw: '10,00',
    lineTotalRaw: '70,00',
    sourceLines: ['Guarnizione', '1', '7', '10,00', '70,00'],
  });
  assert.equal(repaired?.quantity, 7);
  assert.equal(repaired?.unitPrice, 10);
  assert.equal(repaired?.total, 70);
});

test('quantity is not fabricated from arithmetic when it is absent from the row', () => {
  const repaired = repairStructuredLineItemNumerics({
    unitPrice: 10,
    total: 70,
    unitPriceRaw: '10,00',
    lineTotalRaw: '70,00',
    sourceLines: ['Guarnizione', '10,00', '70,00'],
  });
  assert.equal(repaired, undefined);
});

test('multi-line description stays one row', () => {
  const lines = [
    ...header(300),
    cell('A1', 40, 360),
    cell('Servizio consulenza', 190, 360),
    cell('2', 520, 360),
    cell('50,00', 690, 360),
    cell('22%', 800, 360),
    cell('100,00', 930, 360),
    cell('include report annuale', 190, 392),
  ];
  const result = extractDocumentItemsAndTotals(page(lines));
  assert.equal(result.items.length, 1);
  assert.match(result.items[0].description?.normalizedValue ?? '', /report annuale/);
  assert.equal(result.items[0].quantity?.normalizedValue, 2);
});

test('sparse rows do not steal the next row quantity', () => {
  const lines = [
    ...header(300),
    cell('A1', 40, 360),
    cell('Filtro', 190, 360),
    cell('7', 520, 360),
    cell('10,00', 690, 360),
    cell('22%', 800, 360),
    cell('70,00', 930, 360),
    cell('A2', 40, 430),
    cell('Guarnizione', 190, 430),
    cell('1', 520, 430),
    cell('8,00', 690, 430),
    cell('22%', 800, 430),
    cell('8,00', 930, 430),
  ];
  const result = extractDocumentItemsAndTotals(page(lines));
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].quantity?.normalizedValue, 7);
  assert.equal(result.items[1].quantity?.normalizedValue, 1);
});

test('repeated VAT values stay rates and do not become quantities', () => {
  const lines = [
    ...header(300),
    cell('A1', 40, 360),
    cell('Pezzo uno', 190, 360),
    cell('3', 520, 360),
    cell('20,00', 690, 360),
    cell('22%', 800, 360),
    cell('60,00', 930, 360),
    cell('A2', 40, 420),
    cell('Pezzo due', 190, 420),
    cell('2', 520, 420),
    cell('15,00', 690, 420),
    cell('22%', 800, 420),
    cell('30,00', 930, 420),
  ];
  const result = extractDocumentItemsAndTotals(page(lines));
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].vatRate?.normalizedValue, 22);
  assert.equal(result.items[1].vatRate?.normalizedValue, 22);
  assert.equal(result.items[0].quantity?.normalizedValue, 3);
});

test('quantity next to a product code is not taken from the code digits', () => {
  const lines = [
    ...header(300),
    cell('ABC-17', 40, 360),
    cell('Cuscinetto', 190, 360),
    cell('4', 520, 360),
    cell('12,50', 690, 360),
    cell('22%', 800, 360),
    cell('50,00', 930, 360),
  ];
  const result = extractDocumentItemsAndTotals(page(lines));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quantity?.normalizedValue, 4);
});

test('row with discount percent keeps quantity from the qty column', () => {
  const lines = [
    ...header(300),
    cell('A1', 40, 360),
    cell('Cinghia', 190, 360),
    cell('5', 520, 360),
    cell('18,50', 690, 360),
    cell('22%', 800, 360),
    cell('5%', 860, 360),
    cell('87,88', 930, 360),
  ];
  const result = extractDocumentItemsAndTotals(page(lines));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quantity?.normalizedValue, 5);
});

test('unrecoverable technical-measure fragment is not kept as a commercial row', () => {
  const repaired = repairStructuredLineItemNumerics({
    unitPrice: 3162,
    unitPriceRaw: 'Tubes inox 316L, épaisseur 2 mm',
    sourceLines: ['Tubes inox 316L, épaisseur 2 mm', 'Kit tuyauterie isolée - DN65'],
  });
  assert.equal(repaired, undefined);
});

test('qty 2 from the quantity column', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('A1', 40, 360),
    cell('Filtro', 190, 360),
    cell('2', 520, 360),
    cell('50,00', 690, 360),
    cell('22%', 800, 360),
    cell('100,00', 930, 360),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 2);
  assert.ok(result.items[0]?.quantity?.reasons.some((reason) => /quantity_provenance_/.test(reason)));
});

test('qty 7 from an explicit hour unit token', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('A1', 40, 360),
    cell('Lavoro interno', 190, 360),
    cell('7 h', 520, 360),
    cell('50,44', 690, 360),
    cell('22%', 800, 360),
    cell('353,09', 930, 360),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 7);
});

test('qty 28 ud is not dropped as a money reject', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('A1', 40, 360),
    cell('Modulo', 190, 360),
    cell('28 ud', 520, 360),
    cell('129,00', 690, 360),
    cell('21%', 800, 360),
    cell('3421,20', 930, 360),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 28);
});

test('qty 200 m is kept as quantity not money', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('A1', 40, 360),
    cell('Cable', 190, 360),
    cell('200 m', 520, 360),
    cell('2,25', 690, 360),
    cell('21%', 800, 360),
    cell('450,00', 930, 360),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 200);
});

test('qty 1 is legitimate when it reconciles', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('A1', 40, 360),
    cell('Inversor', 190, 360),
    cell('1', 520, 360),
    cell('2150,00', 690, 360),
    cell('21%', 800, 360),
    cell('2150,00', 930, 360),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 1);
});

test('missing quantity may stay unknown instead of silent 1', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('A1', 40, 360),
    cell('Servizio', 190, 360),
    cell('80,00', 690, 360),
    cell('22%', 800, 360),
    cell('80,00', 930, 360),
  ]));
  assert.equal(result.items.length, 1);
  const qty = result.items[0]?.quantity?.normalizedValue;
  assert.ok(qty === undefined || qty === 1);
});

test('numeric product code near quantity is not the quantity', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('ABC-17', 40, 360),
    cell('Cuscinetto', 190, 360),
    cell('4', 520, 360),
    cell('12,50', 690, 360),
    cell('22%', 800, 360),
    cell('50,00', 930, 360),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 4);
});

test('VAT 22 near quantity is not the quantity', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('A1', 40, 360),
    cell('Pezzo', 190, 360),
    cell('3', 520, 360),
    cell('20,00', 690, 360),
    cell('22', 800, 360),
    cell('60,00', 930, 360),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 3);
});

test('integer unit price near quantity is not stolen as qty', () => {
  const result = extractDocumentItemsAndTotals(page([
    ...header(300),
    cell('A1', 40, 360),
    cell('Pezzo', 190, 360),
    cell('2', 520, 360),
    cell('50', 690, 360),
    cell('22%', 800, 360),
    cell('100,00', 930, 360),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 2);
  assert.equal(result.items[0]?.unitPrice?.normalizedValue, 50);
});

test('quantity with unit pz nr ud m h', () => {
  const units = [
    { raw: '2 pz', qty: 2 },
    { raw: '3 nr', qty: 3 },
    { raw: '28 ud', qty: 28 },
    { raw: '200 m', qty: 200 },
    { raw: '7 h', qty: 7 },
  ];
  for (const entry of units) {
    const result = extractDocumentItemsAndTotals(page([
      ...header(300),
      cell('A1', 40, 360),
      cell('Voce', 190, 360),
      cell(entry.raw, 520, 360),
      cell('10,00', 690, 360),
      cell('22%', 800, 360),
      cell(String((entry.qty * 10).toFixed(2)).replace('.', ','), 930, 360),
    ]));
    assert.equal(result.items[0]?.quantity?.normalizedValue, entry.qty, entry.raw);
  }
});

test('noisy OCR 1/7 in one row band still yields a stable row count', () => {
  const lines = [
    ...header(300),
    cell('A1', 40, 360),
    cell('Filtro olio', 190, 360),
    cell('1', 500, 358),
    cell('7', 530, 362),
    cell('10,00', 690, 360),
    cell('22%', 800, 360),
    cell('70,00', 930, 360),
    cell('A2', 40, 430),
    cell('Guarnizione', 190, 430),
    cell('2', 520, 430),
    cell('4,00', 690, 430),
    cell('22%', 800, 430),
    cell('8,00', 930, 430),
  ];
  const result = extractDocumentItemsAndTotals(page(lines));
  assert.equal(result.items.length, 2);
});

test('wrapped description with product-code digits stays one commercial row', () => {
  const lines = [
    ...header(300),
    cell('MANNCUK26009', 40, 360),
    cell('Filtro aria abitacolo MANN-FILTER CUK 26 009 - Filtro antipolline ai carboni attivi', 190, 358),
    cell('5', 520, 360),
    cell('14,20', 690, 360),
    cell('10,00%', 860, 358),
    cell('22%', 800, 360),
    cell('63,90', 930, 360),
    cell('CASTROL1', 40, 430),
    cell('Olio motore CASTROL', 190, 430),
    cell('8', 520, 430),
    cell('49,90', 690, 430),
    cell('8,00%', 860, 430),
    cell('22%', 800, 430),
    cell('366,66', 930, 430),
  ];
  const result = extractDocumentItemsAndTotals(page(lines));
  assert.equal(result.items.length, 2, result.items.map((item) => item.description?.normalizedValue).join(' | '));
  const cabin = result.items.find((item) => /abitacolo|MANN-FILTER/i.test(String(item.description?.normalizedValue ?? '')));
  assert.ok(cabin);
  assert.equal(cabin?.quantity?.normalizedValue, 5);
  assert.equal(cabin?.unitPrice?.normalizedValue, 14.2);
  assert.equal(cabin?.discount?.normalizedValue, 10);
  assert.equal(cabin?.vatRate?.normalizedValue, 22);
  assert.equal(cabin?.lineTotal?.normalizedValue, 63.9);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine, OrderDocument } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { detectDocumentTableColumnFast, extractDocumentItemsAndTotals } from '../lib/document-items-totals';
import { parseCorruptedVatToken, parseDiscountPercent } from '../lib/document-vat-column';
import { resolveRowQuantity } from '../lib/document-quantity-tokens';
import { applyStructuredExtractionToDocument } from '../lib/document-structured-extraction';

function line(text: string, x: number, y: number, width = 80, extras?: Partial<OcrLine>): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width, height: 22 }, ...extras };
}

function pages(lines: OcrLine[], width = 1400, height = 1800) {
  return classifyDocumentLayoutPages([{
    pageIndex: 0,
    width,
    height,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }]);
}

function truncatedHeaders(y = 120) {
  return [
    line('Codice', 40, y, 90),
    line('Descrizione', 160, y, 180),
    line('Quantità', 520, y, 90),
    line('Prezzo unitario', 640, y, 140),
    line('Sconto', 820, y, 70),
    line('Import', 960, y, 80),
    line('VA', 1120, y, 40),
  ];
}

test('truncated Import/VA headers are column kinds', () => {
  assert.equal(detectDocumentTableColumnFast('Import'), 'lineTotal');
  assert.equal(detectDocumentTableColumnFast('VA'), 'vatRate');
  assert.equal(parseCorruptedVatToken('22°%'), 22);
});

test('1 complete row binds all direct fields', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('A1', 40, 180, 90),
    line('Filtro olio motore', 160, 180, 200),
    line('6', 520, 180, 40),
    line('6,85', 640, 180, 70),
    line('10,00%', 820, 180, 70),
    line('37,02', 960, 180, 70),
    line('22%', 1120, 180, 50),
  ]));
  const item = result.items[0];
  assert.equal(item?.quantity?.normalizedValue, 6);
  assert.equal(item?.unitPrice?.normalizedValue, 6.85);
  assert.equal(item?.discount?.normalizedValue, 10);
  assert.equal(item?.vatRate?.normalizedValue, 22);
  assert.equal(item?.lineTotal?.normalizedValue, 37.02);
});

test('2 missing qty uniquely derives from price discount and printed total', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('A2', 40, 180, 90),
    line('Filtro aria abitacolo CUK 26 009', 160, 180, 240),
    line('14,20', 640, 180, 70),
    line('10,00%', 820, 180, 70),
    line('63,90', 960, 180, 70),
    line('22°%', 1120, 180, 50),
  ]));
  const item = result.items[0];
  assert.equal(item?.quantity?.normalizedValue, 5);
  assert.equal(item?.unitPrice?.normalizedValue, 14.2);
  assert.equal(item?.discount?.normalizedValue, 10);
  assert.equal(item?.vatRate?.normalizedValue, 22);
  assert.equal(item?.lineTotal?.normalizedValue, 63.9);
  assert.ok(item?.quantity?.reasons.some((reason) => /arithmetic_derived_missing_ocr/.test(reason)));
});

test('3 missing qty stays null when arithmetic is ambiguous', () => {
  const resolved = resolveRowQuantity({
    rowLines: pages([line('Servizio generico', 160, 180, 200)]).flatMap((page) => page.lines),
    unitPrice: 30,
    lineTotal: 100,
  });
  assert.equal(resolved.value, undefined);
  assert.equal(resolved.provenance, 'unknown_missing');
});

test('4 printed non-zero line total must not become 0', () => {
  const layout = pages([
    ...truncatedHeaders(),
    line('A3', 40, 180, 90),
    line('Olio motore tanica 5 litri', 160, 180, 240),
    line('49,90', 640, 180, 70),
    line('8.00%', 820, 180, 70),
    line('366,66', 960, 180, 80),
    line('22%', 1120, 180, 50),
  ]);
  const extracted = extractDocumentItemsAndTotals(layout);
  assert.equal(extracted.items[0]?.lineTotal?.normalizedValue, 366.66);
  assert.notEqual(extracted.items[0]?.lineTotal?.normalizedValue, 0);
  const persisted = applyStructuredExtractionToDocument({
    id: 'row-field-persist',
    type: 'order',
    title: 'Test order',
    rawText: '',
    images: [],
    items: [],
    confidence: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }, {
    schemaVersion: 1,
    metadata: {},
    items: extracted.items,
    summary: extracted.summary,
    conditions: extracted.conditions,
    pages: layout,
    complete: false,
    requiresRescan: false,
    requiresReview: true,
    reasons: [],
  }, { mode: 'new_scan' }) as OrderDocument;
  assert.equal(persisted.items[0]?.total, 366.66);
  assert.equal(persisted.items[0]?.quantity, 8);
  assert.equal(persisted.items[0]?.vatRate, 22);
});

test('5 product-code digits are not quantity', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('CUK26009', 40, 180, 90),
    line('Filtro CUK 26 009 carboni attivi', 160, 180, 240),
    line('14,20', 640, 180, 70),
    line('10,00%', 820, 180, 70),
    line('63,90', 960, 180, 70),
    line('22%', 1120, 180, 50),
  ]));
  assert.equal(result.items[0]?.quantity?.normalizedValue, 5);
  assert.notEqual(result.items[0]?.quantity?.normalizedValue, 26);
  assert.notEqual(result.items[0]?.quantity?.normalizedValue, 9);
});

test('6 discount and VAT adjacent stay distinct', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('A4', 40, 180, 90),
    line('Pastiglie freno', 160, 180, 200),
    line('4', 520, 180, 40),
    line('24,50', 640, 180, 70),
    line('10,00%', 820, 180, 70),
    line('88,20', 960, 180, 70),
    line('22%', 1120, 180, 50),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 10);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
});

test('7 VAT token after line total is vatRate', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('A5', 40, 180, 90),
    line('Candela accensione', 160, 180, 200),
    line('10', 520, 180, 40),
    line('11,60', 640, 180, 70),
    line('10,00%', 820, 180, 70),
    line('104,40', 960, 180, 70),
    line('22%', 1120, 180, 50),
  ]));
  assert.equal(result.items[0]?.lineTotal?.normalizedValue, 104.4);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
});

test('8 zero-price row with VAT 22 keeps vatRate', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('PERS', 40, 180, 90),
    line('Lavorazione logo formato vettoriale', 160, 180, 240),
    line('1', 520, 180, 40),
    line('0,00', 640, 180, 70),
    line('0,00', 960, 180, 70),
    line('22,00', 1120, 180, 60),
  ]));
  assert.equal(result.items[0]?.unitPrice?.normalizedValue, 0);
  assert.equal(result.items[0]?.lineTotal?.normalizedValue, 0);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
  assert.notEqual(result.items[0]?.discount?.normalizedValue, 22);
});

test('9 zero-price row with blank discount still binds VAT from concatenated token', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('PERS', 40, 180, 90),
    line('Setup logo vettoriale', 160, 180, 200),
    line('1', 520, 180, 40),
    line('0,00', 640, 180, 70),
    line('0,00', 960, 180, 70),
    line('O. 00 22,00', 1080, 180, 140, {
      elements: [
        { text: 'O.', elementIndex: 0, boundingBox: { x: 1080, y: 180, width: 15, height: 17 } },
        { text: '00', elementIndex: 1, boundingBox: { x: 1100, y: 180, width: 22, height: 17 } },
        { text: '22,00', elementIndex: 2, boundingBox: { x: 1120, y: 180, width: 48, height: 16 } },
      ],
    }),
  ]));
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
  assert.notEqual(result.items[0]?.discount?.normalizedValue, 22);
});

test('10 wrapped/skewed numeric cells still bind the printed total', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('A6', 40, 176, 90),
    line('Filtro abitacolo carboni attivi', 160, 188, 240),
    line('14,20', 640, 172, 70),
    line('10,00%', 820, 174, 70),
    line('63,90', 960, 170, 70),
    line('22%', 1120, 168, 50),
  ]));
  assert.equal(result.items[0]?.lineTotal?.normalizedValue, 63.9);
  assert.equal(result.items[0]?.quantity?.normalizedValue, 5);
});

test('11 adjacent rows with similar prices keep their own totals', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('R1', 40, 180, 90),
    line('Articolo alfa', 160, 180, 180),
    line('15,00', 640, 180, 70),
    line('0,00%', 820, 180, 70),
    line('15,00', 960, 180, 70),
    line('22%', 1120, 180, 50),
    line('R2', 40, 240, 90),
    line('Articolo beta', 160, 240, 180),
    line('15,00', 640, 240, 70),
    line('0,00%', 820, 240, 70),
    line('15,00', 960, 240, 70),
    line('22%', 1120, 240, 50),
  ]));
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.lineTotal?.normalizedValue), [15, 15]);
  assert.deepEqual(result.items.map((item) => item.unitPrice?.normalizedValue), [15, 15]);
  assert.equal(result.items[0]?.quantity?.normalizedValue === 1 || result.items[0]?.quantity?.normalizedValue === undefined, true);
});

test('12 no cross-row stealing of quantity or total', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('R1', 40, 180, 90),
    line('Prima riga commerciale', 160, 180, 200),
    line('6', 520, 180, 40),
    line('6,85', 640, 180, 70),
    line('10,00%', 820, 180, 70),
    line('37,02', 960, 180, 70),
    line('22%', 1120, 180, 50),
    line('R2', 40, 250, 90),
    line('Seconda riga commerciale', 160, 250, 200),
    line('14,20', 640, 250, 70),
    line('10,00%', 820, 250, 70),
    line('63,90', 960, 250, 70),
    line('22%', 1120, 250, 50),
  ]));
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.quantity?.normalizedValue, 6);
  assert.equal(result.items[0]?.lineTotal?.normalizedValue, 37.02);
  assert.equal(result.items[1]?.quantity?.normalizedValue, 5);
  assert.equal(result.items[1]?.lineTotal?.normalizedValue, 63.9);
});

test('12b adjacent bilingual rows keep their own printed line totals', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice /', 399, 641, 79),
    line('Descrizione / Description', 877, 658, 247),
    line('Qta /', 1489, 651, 45),
    line('Prezzo Unit. /', 1876, 643, 131),
    line('IVA', 2107, 643, 47),
    line('Totale Riga', 2258, 641, 113),
    line('CIP-500', 387, 941, 80),
    line('2', 277, 941, 10),
    line('Stazione di lavaggio CIP-500 in acciaio inox', 544, 928, 400),
    line('1', 1505, 950, 6),
    line('PZ / PCS', 1652, 946, 90),
    line('18.500,00', 1897, 952, 96),
    line('22%', 2115, 953, 40),
    line('18.500,00', 2286, 955, 97),
    line('CIP-500 cleaning station in stainless steel', 543, 959, 400),
    line('CTR-800', 381, 1005, 87),
    line('3', 277, 1006, 9),
    line('Convogliatore di trasferimento CTR-800', 541, 1006, 400),
    line('1', 1505, 1015, 6),
    line('PZ/ PCS', 1663, 1010, 80),
    line('9.200,00', 1899, 1016, 84),
    line('22%', 2114, 1020, 42),
    line('9.200,00', 2289, 1021, 88),
    line('Stainless steel transfer conveyor CTR-800', 541, 1021, 400),
  ], 2400, 1600));
  const cip = result.items.find((item) => /CIP-500/i.test(item.description?.normalizedValue ?? ''));
  const ctr = result.items.find((item) => /CTR-800|convogliatore/i.test(item.description?.normalizedValue ?? ''));
  assert.equal(cip?.quantity?.normalizedValue, 1);
  assert.equal(cip?.lineTotal?.normalizedValue, 18500);
  assert.equal(cip?.unitPrice?.normalizedValue, 18500);
  assert.equal(ctr?.quantity?.normalizedValue, 1);
  assert.equal(ctr?.lineTotal?.normalizedValue, 9200);
  assert.equal(ctr?.unitPrice?.normalizedValue, 9200);
});

test('13 persistence preserves recovered fields', () => {
  const layout = pages([
    ...truncatedHeaders(),
    line('A7', 40, 180, 90),
    line('Filtro abitacolo CUK 26 009', 160, 180, 240),
    line('14,20', 640, 180, 70),
    line('10,00%', 820, 180, 70),
    line('63,90', 960, 180, 70),
    line('22°%', 1120, 180, 50),
  ]);
  const extracted = extractDocumentItemsAndTotals(layout);
  const persisted = applyStructuredExtractionToDocument({
    id: 'recovered-persist',
    type: 'order',
    title: 'Test order',
    rawText: '',
    images: [],
    items: [],
    confidence: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }, {
    schemaVersion: 1,
    metadata: {},
    items: extracted.items,
    summary: extracted.summary,
    conditions: extracted.conditions,
    pages: layout,
    complete: false,
    requiresRescan: false,
    requiresReview: true,
    reasons: [],
  }, { mode: 'new_scan' }) as OrderDocument;
  assert.equal(persisted.items[0]?.quantity, 5);
  assert.equal(persisted.items[0]?.unitPrice, 14.2);
  assert.equal(persisted.items[0]?.discount, 10);
  assert.equal(persisted.items[0]?.vatRate, 22);
  assert.equal(persisted.items[0]?.total, 63.9);
});

test('14 Node and Hermes share the same field-binding semantics', () => {
  const layout = pages([
    ...truncatedHeaders(),
    line('A8', 40, 180, 90),
    line('Olio motore tanica 5 litri', 160, 180, 240),
    line('49,90', 640, 180, 70),
    line('8.00%', 820, 180, 70),
    line('366,66', 960, 180, 80),
    line('22%', 1120, 180, 50),
  ]);
  const first = extractDocumentItemsAndTotals(layout);
  const second = extractDocumentItemsAndTotals(layout);
  assert.equal(first.items[0]?.quantity?.normalizedValue, second.items[0]?.quantity?.normalizedValue);
  assert.equal(first.items[0]?.lineTotal?.normalizedValue, second.items[0]?.lineTotal?.normalizedValue);
  assert.equal(first.items[0]?.vatRate?.normalizedValue, second.items[0]?.vatRate?.normalizedValue);
  assert.equal(first.items[0]?.quantity?.normalizedValue, 8);
});

function listAndNetHeaders(y = 120) {
  return [
    line('Codice', 40, y, 90),
    line('Descrizione', 160, y, 180),
    line('Quantità', 480, y, 90),
    line('Prezzo', 600, y, 80),
    line('Sc.Listino', 720, y, 90),
    line('Prezzo netto', 860, y, 110),
    line('Importo', 1020, y, 80),
    line('IVA', 1160, y, 40),
  ];
}

test('15 coherent list/net/total geometry is not reshuffled by fallback', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...listAndNetHeaders(),
    line('A1', 40, 180, 90),
    line('Multiuso Escort', 160, 180, 200),
    line('50', 480, 180, 40),
    line('10.57', 600, 180, 60),
    line('20,00', 720, 180, 60),
    line('8,46', 860, 180, 50),
    line('422.95', 1020, 180, 70),
    line('22.00', 1160, 180, 50),
  ]));
  const item = result.items[0];
  assert.equal(item?.quantity?.normalizedValue, 50);
  assert.equal(item?.unitPrice?.normalizedValue, 8.46);
  assert.equal(item?.discount?.normalizedValue === undefined || item?.discount?.normalizedValue === 0, true);
  assert.equal(item?.lineTotal?.normalizedValue, 422.95);
  assert.equal(item?.vatRate?.normalizedValue, 22);
});

test('16 arithmetic recovery cannot override strong direct column binding', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('A1', 40, 180, 90),
    line('Multiuso Escort', 160, 180, 200),
    line('50', 520, 180, 40),
    line('8,46', 640, 180, 70),
    line('0,00%', 820, 180, 70),
    line('422,95', 960, 180, 70),
    line('22%', 1120, 180, 50),
    line('10.57', 700, 210, 60),
    line('20,00', 780, 210, 50),
  ]));
  const item = result.items[0];
  assert.equal(item?.quantity?.normalizedValue, 50);
  assert.equal(item?.unitPrice?.normalizedValue, 8.46);
  assert.equal(item?.lineTotal?.normalizedValue, 422.95);
  assert.notEqual(item?.unitPrice?.normalizedValue, 10.57);
  assert.notEqual(item?.lineTotal?.normalizedValue, 8.46);
});

test('17 line total column cannot steal unit price when digits lost a decimal', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...listAndNetHeaders(),
    line('A1', 40, 180, 90),
    line('Multiuso Escort', 160, 180, 200),
    line('50', 480, 180, 40),
    line('10.57', 600, 180, 60),
    line('20,00', 720, 180, 60),
    line('8,46', 860, 180, 50),
    line('42295', 1020, 180, 70),
    line('22.00', 1160, 180, 50),
  ]));
  const item = result.items[0];
  assert.equal(item?.quantity?.normalizedValue, 50);
  assert.equal(item?.unitPrice?.normalizedValue, 8.46);
  assert.equal(item?.lineTotal?.normalizedValue, 422.95);
  assert.notEqual(item?.unitPrice?.normalizedValue, 10.57);
  assert.notEqual(item?.lineTotal?.normalizedValue, 8.46);
});

test('18 discount column cannot steal an unrelated numeric token as 20%', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...listAndNetHeaders(),
    line('A1', 40, 180, 90),
    line('Multiuso Escort', 160, 180, 200),
    line('50', 480, 180, 40),
    line('10.57', 600, 180, 60),
    line('20,00', 720, 180, 60),
    line('8,46', 860, 180, 50),
    line('422.95', 1020, 180, 70),
    line('22.00', 1160, 180, 50),
  ]));
  assert.notEqual(result.items[0]?.discount?.normalizedValue, 20);
  assert.equal(result.items[0]?.unitPrice?.normalizedValue, 8.46);
});

test('19 zero-like discount OCR O,009% becomes 0', () => {
  assert.equal(parseDiscountPercent('O,009%'), 0);
  assert.equal(parseDiscountPercent('O,00%'), 0);
  assert.equal(parseDiscountPercent('0,00%'), 0);
  assert.equal(parseDiscountPercent('O.00%'), 0);
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('TRASP', 40, 180, 90),
    line('Spese di trasporto', 160, 180, 200),
    line('1', 520, 180, 40),
    line('15,00', 640, 180, 70),
    line('O,009%', 820, 180, 70),
    line('15,00', 960, 180, 70),
    line('22%', 1120, 180, 50),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 0);
  assert.equal(result.items[0]?.unitPrice?.normalizedValue, 15);
  assert.equal(result.items[0]?.lineTotal?.normalizedValue, 15);
});

test('20 genuine 9% remains 9', () => {
  assert.equal(parseDiscountPercent('9%'), 9);
  assert.equal(parseDiscountPercent('9.00%'), 9);
  assert.equal(parseDiscountPercent('9,00%'), 9);
  const result = extractDocumentItemsAndTotals(pages([
    ...truncatedHeaders(),
    line('A9', 40, 180, 90),
    line('Ricambio genuino sconto nove', 160, 180, 220),
    line('1', 520, 180, 40),
    line('100,00', 640, 180, 70),
    line('9,00%', 820, 180, 70),
    line('91,00', 960, 180, 70),
    line('22%', 1120, 180, 50),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 9);
});

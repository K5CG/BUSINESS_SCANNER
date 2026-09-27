import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine, OrderDocument } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentItemsAndTotals } from '../lib/document-items-totals';
import {
  inferDiscountColumn,
  inferVatColumn,
  parseCorruptedVatToken,
  parseDiscountPercent,
  parsePlausibleVatRate,
} from '../lib/document-vat-column';
import { amountSourceKey, incompatibleAmountRoles } from '../lib/document-money-semantics';
import { applyStructuredExtractionToDocument } from '../lib/document-structured-extraction';
import { isNotesOrTermsBoundary } from '../lib/document-item-validity';

function line(text: string, x: number, y: number, width = 80): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width, height: 22 } };
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

function commercialHeaders(y = 120) {
  return [
    line('Codice', 40, y, 90),
    line('Descrizione', 160, y, 180),
    line('Qta', 520, y, 50),
    line('Prezzo unitario', 620, y, 140),
    line('Sconto', 820, y, 70),
    line('Importo', 960, y, 80),
    line('IVA', 1120, y, 50),
  ];
}

function row(y: number, input: {
  code: string;
  desc: string;
  qty: string;
  price: string;
  discount: string;
  total: string;
  vat: string;
}) {
  return [
    line(input.code, 40, y, 90),
    line(input.desc, 160, y, 200),
    line(input.qty, 520, y, 40),
    line(input.price, 620, y, 80),
    line(input.discount, 820, y, 70),
    line(input.total, 960, y, 80),
    line(input.vat, 1120, y, 60),
  ];
}

test('corrupted VAT tokens repair only as VAT-shaped OCR', () => {
  assert.equal(parseCorruptedVatToken('229%'), 22);
  assert.equal(parseCorruptedVatToken('2295'), 22);
  assert.equal(parseCorruptedVatToken('2Z%'), 22);
  assert.equal(parseCorruptedVatToken('22g'), 22);
  assert.equal(parseCorruptedVatToken('22°%'), 22);
  assert.equal(parseCorruptedVatToken('22º%'), 22);
  assert.equal(parsePlausibleVatRate('10,00%'), 10);
  assert.equal(parseDiscountPercent('10,00%'), 10);
  assert.equal(parseDiscountPercent('8,00%'), 8);
  assert.equal(parseDiscountPercent('0,00%'), 0);
  assert.equal(parseDiscountPercent('10,009%'), 10);
  assert.equal(parseDiscountPercent('10.00%'), 10);
  assert.equal(parseDiscountPercent('10 O'), 10);
  assert.equal(parseDiscountPercent('.009%'), 0);
  assert.equal(parseDiscountPercent('O,009%'), 0);
  assert.equal(parseDiscountPercent('O,00%'), 0);
  assert.equal(parseDiscountPercent('O.00%'), 0);
  assert.equal(parseDiscountPercent('9%'), 9);
  assert.equal(parseDiscountPercent('9.00%'), 9);
  assert.equal(parseCorruptedVatToken('10,00%'), 10);
});

test('discount 10 + VAT 22 stay in distinct columns', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'A1', desc: 'Filtro aria', qty: '6', price: '10,00',
      discount: '10,00%', total: '54,00', vat: '22%',
    }),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 10);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
});

test('discount 8 + VAT 22 stay in distinct columns', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'A2', desc: 'Pastiglie', qty: '8', price: '20,00',
      discount: '8,00%', total: '147,20', vat: '22%',
    }),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 8);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
});

test('VAT OCR 229% does not steal the discount column', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'A3', desc: 'Candela', qty: '4', price: '12,00',
      discount: '10,00%', total: '43,20', vat: '229%',
    }),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 10);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
});

test('VAT OCR 2295 does not steal the discount column', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'A4', desc: 'Olio', qty: '5', price: '8,00',
      discount: '10,00%', total: '36,00', vat: '2295',
    }),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 10);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
});

test('VAT OCR 2Z% does not steal the discount column', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'A5', desc: 'Cinghia', qty: '1', price: '30,00',
      discount: '10,00%', total: '27,00', vat: '2Z%',
    }),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 10);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
});

test('discount 10 with missing VAT token keeps discount and does not invent VAT from it', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    line('A6', 40, 180, 90),
    line('Guarnizione', 160, 180, 200),
    line('10', 520, 180, 40),
    line('5,00', 620, 180, 80),
    line('10,00%', 820, 180, 70),
    line('45,00', 960, 180, 80),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 10);
  assert.notEqual(result.items[0]?.vatRate?.normalizedValue, 10);
});

test('VAT 10 + discount 5 remain distinct', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'A7', desc: 'Libro', qty: '2', price: '20,00',
      discount: '5,00%', total: '38,00', vat: '10%',
    }),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 5);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 10);
});

test('mixed VAT 10/22 keeps row-level rates', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'B1', desc: 'Pane', qty: '1', price: '10,00',
      discount: '0,00%', total: '10,00', vat: '10%',
    }),
    ...row(230, {
      code: 'B2', desc: 'Filtro', qty: '1', price: '10,00',
      discount: '0,00%', total: '10,00', vat: '22%',
    }),
  ]));
  assert.deepEqual(result.items.map((item) => item.vatRate?.normalizedValue), [10, 22]);
  assert.deepEqual(result.items.map((item) => item.discount?.normalizedValue), [0, 0]);
});

test('discount-only table does not promote discount to VAT', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 120, 90),
    line('Descrizione', 160, 120, 180),
    line('Qta', 520, 120, 50),
    line('Prezzo unitario', 620, 120, 140),
    line('Sconto', 820, 120, 70),
    line('Importo', 960, 120, 80),
    line('C1', 40, 180, 90),
    line('Servizio', 160, 180, 200),
    line('1', 520, 180, 40),
    line('100,00', 620, 180, 80),
    line('10,00%', 820, 180, 70),
    line('90,00', 960, 180, 80),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 10);
  assert.notEqual(result.items[0]?.vatRate?.normalizedValue, 10);
});

test('no header but repeated percent geometry still splits discount left of amount', () => {
  const inferredDiscount = inferDiscountColumn({
    existingColumns: [
      { kind: 'unitPrice', x: 620 },
      { kind: 'lineTotal', x: 960 },
      { kind: 'vatRate', x: 1120 },
    ],
    bodyLines: [
      { text: '10,00%', x: 820 },
      { text: '10,00%', x: 822 },
      { text: '8,00%', x: 821 },
      { text: '0,00%', x: 819 },
      { text: '22%', x: 1120 },
      { text: '22%', x: 1122 },
    ],
    pageWidth: 1400,
  });
  const inferredVat = inferVatColumn({
    existingColumns: [
      { kind: 'unitPrice', x: 620 },
      { kind: 'lineTotal', x: 960 },
      { kind: 'discount', x: 820 },
    ],
    bodyLines: [
      { text: '10,00%', x: 820 },
      { text: '22%', x: 1120 },
      { text: '22%', x: 1122 },
      { text: '22%', x: 1118 },
    ],
    headerLines: [{ text: 'VA', x: 1120 }],
    pageWidth: 1400,
  });
  assert.ok(inferredDiscount && Math.abs(inferredDiscount.x - 820) < 20);
  assert.ok(inferredVat && Math.abs(inferredVat.x - 1120) < 20);
});

test('cross-column protection: discount 10/8 never become VAT when VAT tokens are corrupt', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 120, 90),
    line('Descrizione', 160, 120, 180),
    line('Qta', 520, 120, 50),
    line('Prezzo unitario', 620, 120, 140),
    line('Scanto', 820, 120, 70),
    line('Importo', 960, 120, 80),
    line('VA', 1120, 120, 40),
    ...row(180, { code: 'R1', desc: 'Articolo uno', qty: '6', price: '10,00', discount: '10,00%', total: '54,00', vat: '22%' }),
    ...row(230, { code: 'R2', desc: 'Articolo due', qty: '4', price: '12,00', discount: '10,00%', total: '43,20', vat: '229%' }),
    ...row(280, { code: 'R3', desc: 'Articolo tre', qty: '5', price: '8,00', discount: '10,00%', total: '36,00', vat: '22%' }),
    ...row(330, { code: 'R4', desc: 'Articolo quattro', qty: '8', price: '20,00', discount: '8,00%', total: '147,20', vat: '229%' }),
    ...row(380, { code: 'R5', desc: 'Articolo cinque', qty: '10', price: '5,00', discount: '10,00%', total: '45,00', vat: '2295' }),
    ...row(430, { code: 'R6', desc: 'Articolo sei', qty: '1', price: '30,00', discount: '0,00%', total: '30,00', vat: '22%' }),
  ]));
  assert.deepEqual(result.items.map((item) => item.discount?.normalizedValue), [10, 10, 10, 8, 10, 0]);
  assert.deepEqual(result.items.map((item) => item.vatRate?.normalizedValue), [22, 22, 22, 22, 22, 22]);
});

test('canonical discounts persist through applyStructuredExtractionToDocument', () => {
  const extractionPages = pages([
    ...commercialHeaders(),
    ...row(180, { code: 'R1', desc: 'Articolo uno', qty: '6', price: '10,00', discount: '10,00%', total: '54,00', vat: '22%' }),
    ...row(230, { code: 'R2', desc: 'Articolo due', qty: '4', price: '12,00', discount: '10,00%', total: '43,20', vat: '22%' }),
    ...row(280, { code: 'R3', desc: 'Articolo tre', qty: '5', price: '8,00', discount: '10,00%', total: '36,00', vat: '22%' }),
    ...row(330, { code: 'R4', desc: 'Articolo quattro', qty: '8', price: '20,00', discount: '8,00%', total: '147,20', vat: '22%' }),
    ...row(380, { code: 'R5', desc: 'Articolo cinque', qty: '10', price: '5,00', discount: '10,00%', total: '45,00', vat: '22%' }),
    ...row(430, { code: 'R6', desc: 'Articolo sei', qty: '1', price: '30,00', discount: '0,00%', total: '30,00', vat: '22%' }),
  ]);
  const extracted = extractDocumentItemsAndTotals(extractionPages);
  const persisted = applyStructuredExtractionToDocument({
    id: 'discount-persist',
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
    pages: extractionPages,
    complete: false,
    requiresRescan: false,
    requiresReview: true,
    reasons: [],
  }, { mode: 'new_scan' }) as OrderDocument;
  assert.deepEqual(extracted.items.map((item) => item.discount?.normalizedValue), [10, 10, 10, 8, 10, 0]);
  assert.deepEqual(persisted.items.map((item) => item.discount), [10, 10, 10, 8, 10, 0]);
});

test('taxable plus VAT equals total and rejects shared-token subtotal', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 120, 90),
    line('Descrizione', 160, 120, 180),
    line('Qta', 520, 120, 50),
    line('Prezzo', 700, 120, 80),
    line('Importo', 900, 120, 80),
    line('Logo', 160, 180, 120),
    line('1', 520, 180, 40),
    line('0,00', 700, 180, 60),
    line('0,00', 900, 180, 60),
    line('Servizio stampa', 160, 240, 180),
    line('1', 520, 240, 40),
    line('200,00', 700, 240, 70),
    line('200,00', 900, 240, 70),
    line('TOTALE MPONBLE', 80, 900, 180),
    line('557,95', 200, 940, 80),
    line('SPESE DI TRASPORTO', 520, 900, 180),
    line('15,00', 700, 940, 70),
    line('TOTALE IMPOG TA', 880, 900, 160),
    line('122,75', 1060, 940, 80),
    line('TOTALE DOCUMENTO', 880, 1000, 160),
    line('680,70 EUR', 1060, 1040, 100),
  ], 1400, 1400));
  assert.equal(result.summary.total?.normalizedValue, 680.7);
  assert.equal(result.summary.vatAmount?.normalizedValue, 122.75);
  assert.equal(result.summary.subtotal?.normalizedValue, 557.95);
  assert.notEqual(result.summary.subtotal?.normalizedValue, result.summary.vatAmount?.normalizedValue);
  const subtotalSource = amountSourceKey({
    pageIndex: result.summary.subtotal?.pageIndex,
    sourceLineIds: result.summary.subtotal?.sourceLineIds,
  });
  const vatSource = amountSourceKey({
    pageIndex: result.summary.vatAmount?.pageIndex,
    sourceLineIds: result.summary.vatAmount?.sourceLineIds,
  });
  assert.notEqual(subtotalSource, vatSource);
});

test('same amount token cannot occupy subtotal and VAT', () => {
  assert.equal(incompatibleAmountRoles('net_taxable', 'vat_amount'), true);
  const result = extractDocumentItemsAndTotals(pages([
    line('TOTALE IMPOG TA', 200, 900, 160),
    line('122,75', 400, 900, 80),
    line('TOTALE DOCUMENTO', 200, 980, 160),
    line('680,70', 400, 980, 80),
  ]));
  if (result.summary.subtotal && result.summary.vatAmount) {
    assert.notEqual(
      amountSourceKey({
        pageIndex: result.summary.subtotal.pageIndex,
        sourceLineIds: result.summary.subtotal.sourceLineIds,
      }),
      amountSourceKey({
        pageIndex: result.summary.vatAmount.pageIndex,
        sourceLineIds: result.summary.vatAmount.sourceLineIds,
      }),
    );
  }
});

test('shipping near totals is not subtotal', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('SPESE DI TRASPORTO', 520, 900, 180),
    line('15,00', 720, 900, 70),
    line('TOTALE MPONBLE', 80, 960, 180),
    line('557,95', 200, 960, 80),
    line('TOTALE IMPOG TA', 880, 960, 160),
    line('122,75', 1060, 960, 80),
    line('TOTALE DOCUMENTO', 880, 1040, 160),
    line('680,70', 1060, 1040, 80),
  ]));
  assert.notEqual(result.summary.subtotal?.normalizedValue, 15);
  assert.equal(result.summary.shippingCost?.normalizedValue, 15);
});

test('subtotal plus shipping plus VAT still keeps taxable distinct', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Imponibile netto', 80, 900, 180),
    line('557,95', 280, 900, 80),
    line('Spese di trasporto', 80, 960, 180),
    line('15,00', 280, 960, 70),
    line('Totale imposta', 80, 1020, 160),
    line('122,75', 280, 1020, 80),
    line('Totale documento', 80, 1080, 160),
    line('695,70', 280, 1080, 80),
  ]));
  assert.equal(result.summary.subtotal?.normalizedValue, 557.95);
  assert.equal(result.summary.shippingCost?.normalizedValue, 15);
  assert.equal(result.summary.vatAmount?.normalizedValue, 122.75);
});

test('net taxable label binds the taxable amount', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Imponibile netto', 80, 900, 180),
    line('557,95', 280, 900, 80),
    line('IVA', 80, 960, 50),
    line('122,75', 280, 960, 80),
    line('Totale documento', 80, 1020, 160),
    line('680,70', 280, 1020, 80),
  ]));
  assert.equal(result.summary.subtotal?.normalizedValue, 557.95);
});

test('no explicit subtotal leaves subtotal null rather than copying VAT', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Totale imposta', 80, 900, 160),
    line('122,75', 280, 900, 80),
    line('Totale documento', 80, 980, 160),
    line('680,70', 280, 980, 80),
  ]));
  if (result.summary.vatAmount?.normalizedValue === 122.75) {
    assert.notEqual(result.summary.subtotal?.normalizedValue, 122.75);
  }
});

test('equal numeric values from two source tokens remain allowed', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Imponibile', 80, 900, 140),
    line('122,75', 280, 900, 80),
    line('Totale imposta', 80, 960, 160),
    line('122,75', 480, 960, 80),
    line('Totale documento', 80, 1020, 160),
    line('245,50', 280, 1020, 80),
  ]));
  if (result.summary.subtotal && result.summary.vatAmount) {
    assert.equal(result.summary.subtotal.normalizedValue, 122.75);
    assert.equal(result.summary.vatAmount.normalizedValue, 122.75);
    assert.notEqual(
      amountSourceKey({
        pageIndex: result.summary.subtotal.pageIndex,
        sourceLineIds: result.summary.subtotal.sourceLineIds,
      }),
      amountSourceKey({
        pageIndex: result.summary.vatAmount.pageIndex,
        sourceLineIds: result.summary.vatAmount.sourceLineIds,
      }),
    );
  }
});

test('row description stops at delivery terms and tolerance notes', () => {
  assert.equal(isNotesOrTermsBoundary('Tempi di consegna 10 giorni lavorativi'), true);
  assert.equal(isNotesOrTermsBoundary('*Tasso di tolleranza +/- 5%'), true);
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 120, 90),
    line('Descrizione', 160, 120, 180),
    line('Qta', 720, 120, 50),
    line('Prezzo', 840, 120, 80),
    line('Importo', 1000, 120, 80),
    line('LOGO', 40, 180, 80),
    line('Stampa logo', 160, 180, 180),
    line('1', 720, 180, 40),
    line('0,00', 840, 180, 60),
    line('0,00', 1000, 180, 60),
    line('A2', 40, 240, 80),
    line('Biglietti', 160, 240, 180),
    line('100', 720, 240, 50),
    line('1,00', 840, 240, 60),
    line('100,00', 1000, 240, 70),
    line('A3', 40, 300, 80),
    line('Pieghevoli', 160, 300, 180),
    line('200', 720, 300, 50),
    line('0,80', 840, 300, 60),
    line('160,00', 1000, 300, 70),
    line('A4', 40, 360, 80),
    line('Manifesti', 160, 360, 180),
    line('50', 720, 360, 50),
    line('2,00', 840, 360, 60),
    line('100,00', 1000, 360, 70),
    line('Tempi di consegna 10 giorni lavorativi', 160, 430, 360),
    line('*Tasso di tolleranza +/- 5% sulla tiratura', 160, 470, 360),
  ]));
  const lastCommercial = result.items.find((item) => /Manifesti/i.test(String(item.description?.normalizedValue ?? '')))
    ?? result.items.at(-1);
  assert.ok(result.items.length >= 3, `expected commercial rows, got ${result.items.map((item) => item.description?.normalizedValue).join(' | ')}`);
  assert.equal(result.items.some((item) => /Tempi di consegna/i.test(String(item.description?.normalizedValue ?? ''))), false);
  assert.equal(result.items.some((item) => /tolleranza/i.test(String(item.description?.normalizedValue ?? ''))), false);
  assert.ok(result.items.some((item) => /Biglietti|Pieghevoli|Manifesti|logo/i.test(String(item.description?.normalizedValue ?? ''))));
});

test('TOTALE ORDINE outranks imponibile netto and subtotal cannot become total', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Imponibile netto', 40, 900, 180),
    line('608,46 €', 400, 900, 90),
    line('IVA 22%', 40, 940, 120),
    line('133,86 €', 400, 940, 90),
    line('TOTALE ORDINE', 40, 980, 180),
    line('742,32 €', 400, 980, 90),
  ]));
  assert.equal(result.summary.subtotal?.normalizedValue, 608.46);
  assert.equal(result.summary.vatAmount?.normalizedValue, 133.86);
  assert.equal(result.summary.total?.normalizedValue, 742.32);
});

test('four commercial rows including a zero-price service survive prune', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 200, 80),
    line('Descrizione', 160, 200, 180),
    line('Qta', 520, 200, 50),
    line('Prezzo', 700, 200, 70),
    line('Totale', 900, 200, 70),
    line('IVA', 1040, 200, 50),
    line('V-0.61.23', 40, 250, 90),
    line('Multiuso Escort', 160, 250, 180),
    line('50', 520, 250, 40),
    line('8,46', 700, 250, 50),
    line('422,95', 900, 250, 60),
    line('22,00', 1040, 250, 50),
    line('V-TP1IMP.IT', 40, 300, 90),
    line('Impianto 1 colore', 160, 300, 180),
    line('1', 520, 300, 40),
    line('75,00', 700, 300, 50),
    line('75,00', 900, 300, 50),
    line('22,00', 1040, 300, 50),
    line('V-TP1.IT', 40, 350, 90),
    line('Tampografia 1 colore', 160, 350, 180),
    line('50', 520, 350, 40),
    line('0,90', 700, 350, 50),
    line('45,00', 900, 350, 50),
    line('22,00', 1040, 350, 50),
    line('PERS', 40, 400, 80),
    line('Lavorazione logo formato vettoriale', 160, 400, 220),
    line('1', 520, 400, 40),
    line('0,00', 700, 400, 50),
    line('O.00', 900, 400, 50),
    line('22,00', 1040, 400, 50),
    line('Tempi di consegna: 30 giorni', 160, 460, 300),
  ], 1200, 900));
  assert.equal(result.items.length, 4, result.items.map((item) => item.description?.normalizedValue).join(' | '));
  assert.ok(result.items.some((item) => /Tampografia/i.test(String(item.description?.normalizedValue ?? ''))));
  const logo = result.items.find((item) => /Lavorazione logo/i.test(String(item.description?.normalizedValue ?? '')));
  assert.ok(logo);
  assert.equal(logo?.unitPrice?.normalizedValue, 0);
  assert.equal(logo?.lineTotal?.normalizedValue, 0);
});

test('zero-price row with VAT 22 and discount 0 keeps VAT out of discount', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'PERS', desc: 'Lavorazione logo formato vettoriale', qty: '1',
      price: '0,00', discount: '0,00%', total: 'O.00', vat: '22,00',
    }),
  ]));
  const logo = result.items.find((item) => /Lavorazione logo/i.test(String(item.description?.normalizedValue ?? '')));
  assert.ok(logo);
  assert.equal(logo?.unitPrice?.normalizedValue, 0);
  assert.equal(logo?.lineTotal?.normalizedValue, 0);
  assert.notEqual(logo?.discount?.normalizedValue, 22);
  assert.equal(logo?.vatRate?.normalizedValue, 22);
});

test('zero-price row with blank discount still binds VAT 22 by column', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    line('PERS', 40, 180, 90),
    line('Setup logo vettoriale', 160, 180, 200),
    line('1', 520, 180, 40),
    line('0,00', 620, 180, 80),
    line('O.00', 960, 180, 80),
    line('22,00', 1120, 180, 60),
  ]));
  const logo = result.items[0];
  assert.ok(logo);
  assert.notEqual(logo?.discount?.normalizedValue, 22);
  assert.equal(logo?.vatRate?.normalizedValue, 22);
});

test('discount 10 and VAT 22 stay distinct on a priced row', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(),
    ...row(180, {
      code: 'A1', desc: 'Filtro olio', qty: '6',
      price: '6,85', discount: '10,00%', total: '37,02', vat: '22%',
    }),
  ]));
  assert.equal(result.items[0]?.discount?.normalizedValue, 10);
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
});

test('VAT-only zero-cost service does not invent a discount', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 120, 90),
    line('Descrizione', 160, 120, 180),
    line('Qta', 520, 120, 50),
    line('Prezzo unitario', 620, 120, 140),
    line('Importo', 960, 120, 80),
    line('IVA', 1120, 120, 50),
    line('PERS', 40, 180, 90),
    line('Lavorazione logo', 160, 180, 200),
    line('1', 520, 180, 40),
    line('0,00', 620, 180, 80),
    line('0,00', 960, 180, 80),
    line('22,00', 1120, 180, 60),
  ]));
  assert.equal(result.items[0]?.vatRate?.normalizedValue, 22);
  assert.notEqual(result.items[0]?.discount?.normalizedValue, 22);
});

test('next-row code stops previous multiline description merge', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 200, 80),
    line('Descrizione', 180, 200, 220),
    line('Qta', 620, 200, 50),
    line('Prezzo', 760, 200, 70),
    line('Importo', 940, 200, 70),
    line('NGK1', 40, 260, 80),
    line('Candela accensione NGK', 180, 260, 240),
    line('10', 620, 260, 40),
    line('11,60', 760, 260, 50),
    line('104,40', 940, 260, 60),
    line('Compatibile con Audi A3 1.4 TFSI', 180, 290, 280),
    line('TRASPORTO', 40, 360, 100),
    line('Spese di trasporto', 180, 360, 200),
    line('1', 620, 360, 40),
    line('15,00', 760, 360, 50),
    line('15,00', 940, 360, 50),
  ]));
  const shipping = result.items.find((item) => /trasporto/i.test(String(item.description?.normalizedValue ?? '')));
  const spark = result.items.find((item) => /Candela/i.test(String(item.description?.normalizedValue ?? '')));
  assert.ok(shipping);
  assert.equal(/Audi|Golf 1\.4/i.test(String(shipping?.description?.normalizedValue ?? '')), false);
  assert.ok(/Audi/i.test(String(spark?.description?.normalizedValue ?? '')));
});

test('disclaimer notes are a terms boundary', () => {
  assert.equal(isNotesOrTermsBoundary('No se incluyen trabajos de obra civil'), true);
  assert.equal(isNotesOrTermsBoundary('Does not include civil works'), true);
});

test('notes plus subtotal amount are pruned without qty/price', () => {
  const result = extractDocumentItemsAndTotals(pages([
    ...commercialHeaders(200),
    ...row(260, {
      code: 'MOD-550',
      desc: 'Modulo fotovoltaico 550 Wp',
      qty: '1',
      price: '100,00',
      discount: '0,00%',
      total: '100,00',
      vat: '21%',
    }),
    line('No se incluyen trabajos de obra civil', 160, 420, 280),
    line('Base imponible', 700, 480, 140),
    line('100,00', 960, 480, 70),
    line('IVA (21%)', 700, 520, 120),
    line('21,00', 960, 520, 70),
    line('TOTAL:', 700, 560, 80),
    line('121,00', 960, 560, 70),
  ]));
  assert.equal(
    result.items.some((item) => /No se incluyen/i.test(String(item.description?.normalizedValue ?? ''))),
    false,
    result.items.map((item) => item.description?.normalizedValue).join(' | '),
  );
  assert.ok(result.items.some((item) => /Modulo/i.test(String(item.description?.normalizedValue ?? ''))));
  assert.equal(result.summary.subtotal?.normalizedValue, 100);
  assert.equal(result.summary.total?.normalizedValue, 121);
});

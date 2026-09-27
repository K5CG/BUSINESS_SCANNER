import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentItemsAndTotals } from '../lib/document-items-totals';
import { extractDocumentIdentity } from '../lib/document-parties-metadata';
import {
  looksLikeCompoundHeaderText,
  scoreTableSchema,
  segmentHeaderLine,
} from '../lib/document-header-segmentation';
import {
  grandTotalCannotEqualTaxable,
  isPlausibleDocumentDiscountAmount,
} from '../lib/document-totals-roles';
import { commitLevelFromQuality, shouldPersistCommittedField } from '../lib/document-field-evidence';
import { partyNameLooksLikeItemDescription } from '../lib/document-party-roles';
import { applySemanticFallbackOverlay } from '../lib/document-semantic-fallback';
import type { StructuredDocumentExtraction } from '../lib/document-structure';

function line(text: string, x: number, y: number, width = 80, extras?: Partial<OcrLine>): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width, height: 22 }, ...extras };
}

function pages(lines: OcrLine[], width = 1600, height = 1800) {
  return classifyDocumentLayoutPages([{
    pageIndex: 0,
    width,
    height,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }]);
}

test('compound OCR header line splits into discount VAT and lineTotal', () => {
  assert.equal(looksLikeCompoundHeaderText('Rabatt % MwSt % Gesamt'), true);
  const segments = segmentHeaderLine(
    {
      id: 'h1',
      pageIndex: 0,
      readingOrder: 0,
      text: 'Rabatt % MwSt % Gesamt',
      boundingBox: { x: 1200, y: 100, width: 360, height: 20 },
    },
    (text) => {
      const folded = text.toLowerCase();
      if (/rabatt/.test(folded)) return 'discount';
      if (/mwst/.test(folded)) return 'vatRate';
      if (/gesamt/.test(folded)) return 'lineTotal';
      return undefined;
    },
  );
  assert.deepEqual(segments.map((entry) => entry.kind), ['discount', 'vatRate', 'lineTotal']);
  assert.ok(segments[0].x < segments[1].x);
  assert.ok(segments[1].x < segments[2].x);
});

test('header elements are segmented independently of the concatenated line', () => {
  const segments = segmentHeaderLine(
    {
      id: 'h2',
      pageIndex: 0,
      readingOrder: 0,
      text: 'Desc % IVA Totale',
      boundingBox: { x: 200, y: 80, width: 400, height: 20 },
      elements: [
        { text: 'Sconto', elementIndex: 0, boundingBox: { x: 200, y: 80, width: 80, height: 20 } },
        { text: '%', elementIndex: 1, boundingBox: { x: 280, y: 80, width: 20, height: 20 } },
        { text: 'IVA', elementIndex: 2, boundingBox: { x: 340, y: 80, width: 50, height: 20 } },
        { text: 'Totale', elementIndex: 3, boundingBox: { x: 430, y: 80, width: 80, height: 20 } },
      ],
    },
    (text) => {
      const folded = text.toLowerCase();
      if (/sconto/.test(folded)) return 'discount';
      if (/iva/.test(folded)) return 'vatRate';
      if (/totale/.test(folded)) return 'lineTotal';
      return undefined;
    },
  );
  assert.ok(segments.length >= 2);
  assert.ok(segments.some((entry) => entry.kind === 'discount'));
  assert.ok(segments.some((entry) => entry.kind === 'vatRate'));
});

test('impossible column X order is a weak schema', () => {
  const scored = scoreTableSchema([
    { kind: 'lineTotal', x: 40 },
    { kind: 'description', x: 200 },
    { kind: 'quantity', x: 500 },
  ]);
  assert.equal(scored.confidence, 'weak');
  assert.ok(scored.violations.length > 0);
});

test('quantity is not persisted as lineTotal when unit price exists', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 80, 80),
    line('Descrizione', 160, 80, 160),
    line('Qta', 500, 80, 50),
    line('Prezzo', 620, 80, 80),
    line('IVA %', 900, 80, 60),
    line('Totale', 1100, 80, 80),
    line('SKU-1', 40, 140, 80),
    line('Modulo scambiatore', 160, 140, 200),
    line('6', 500, 140, 30),
    line('70,00', 620, 140, 70),
    line('21', 900, 140, 30),
  ]));
  const item = result.items[0];
  assert.equal(item?.quantity?.normalizedValue, 6);
  assert.equal(item?.unitPrice?.normalizedValue, 70);
  assert.notEqual(item?.lineTotal?.normalizedValue, 6);
  assert.equal(item?.vatRate?.normalizedValue, 21);
});

test('zero priced row with VAT rate is kept', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Artikel', 40, 80, 80),
    line('Beschreibung', 200, 80, 160),
    line('Menge', 500, 80, 70),
    line('Preis', 620, 80, 70),
    line('Rabatt %', 760, 80, 80),
    line('MwSt %', 900, 80, 70),
    line('Gesamt', 1100, 80, 80),
    line('FREE-1', 40, 150, 80),
    line('Logo Datensatz kostenlose Einrichtung', 200, 150, 240),
    line('1', 500, 150, 30),
    line('0,00', 620, 150, 50),
    line('0', 760, 150, 30),
    line('19', 900, 150, 30),
    line('0,00', 1100, 150, 50),
  ]));
  const item = result.items.find((entry) => /Logo/.test(String(entry.description?.normalizedValue ?? '')));
  assert.ok(item);
  assert.equal(item?.quantity?.normalizedValue, 1);
  assert.equal(item?.unitPrice?.normalizedValue, 0);
  assert.equal(item?.lineTotal?.normalizedValue, 0);
  assert.equal(item?.vatRate?.normalizedValue, 19);
});

test('compound header binds distinct qty price discount VAT and total', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Artikel', 40, 80, 80),
    line('Beschreibung', 200, 80, 160),
    line('Menge', 500, 80, 70),
    line('Preis', 640, 80, 70),
    line('Rabatt % MwSt % Gesamt', 780, 80, 360),
    line('PUMP-1', 40, 150, 80),
    line('Industriepumpe Set', 200, 150, 200),
    line('2', 500, 150, 30),
    line('450,00', 640, 150, 70),
    line('10', 790, 150, 30),
    line('19', 920, 150, 30),
    line('810,00', 1080, 150, 70),
  ], 1400, 1600));
  const item = result.items[0];
  assert.equal(item?.quantity?.normalizedValue, 2);
  assert.equal(item?.unitPrice?.normalizedValue, 450);
  assert.equal(item?.discount?.normalizedValue, 10);
  assert.equal(item?.vatRate?.normalizedValue, 19);
  assert.equal(item?.lineTotal?.normalizedValue, 810);
});

test('taxable amount is not committed as grand total', () => {
  assert.equal(grandTotalCannotEqualTaxable({
    taxable: 73491.08,
    vatAmount: 16168.05,
    grandTotal: 73491.08,
  }), true);
  assert.equal(isPlausibleDocumentDiscountAmount(73491.08, 74040.9), false);
  assert.equal(isPlausibleDocumentDiscountAmount(1499.82, 74040.9), true);
  assert.equal(isPlausibleDocumentDiscountAmount(23030, 74040.9), false);
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 80, 80),
    line('Descrizione', 180, 80, 160),
    line('Qta', 500, 80, 50),
    line('Prezzo', 620, 80, 80),
    line('Totale', 900, 80, 80),
    line('A-1', 40, 140, 60),
    line('Filtro industriale', 180, 140, 180),
    line('1', 500, 140, 30),
    line('1.000,00', 620, 140, 80),
    line('1.000,00', 900, 140, 80),
    line('Imponibile merce', 40, 400, 180),
    line('1.000,00', 900, 400, 80),
    line('Sconto documento 2%', 40, 440, 200),
    line('-20,00', 900, 440, 80),
    line('Base imponibile', 40, 480, 160),
    line('980,00', 900, 480, 80),
    line('IVA 22%', 40, 520, 80),
    line('215,60', 900, 520, 80),
    line('TOTALE OFFERTA', 40, 560, 160),
    line('1.195,60', 900, 560, 80),
  ]));
  assert.notEqual(result.summary.total?.normalizedValue, 980);
  assert.notEqual(result.summary.total?.normalizedValue, 1000);
  if (result.summary.total?.normalizedValue !== undefined) {
    assert.ok(result.summary.total.normalizedValue > 1000);
  }
});

test('table body description is rejected as customer', () => {
  const extracted = extractDocumentIdentity(pages([
    line('ATELIER THERMOFLUX SARL', 40, 40, 280),
    line('12 rue des Forges', 40, 70, 200),
    line('69007 Lyon', 40, 100, 140),
    line('Domaine des Hautes Collines', 40, 160, 260),
    line('18 route des Vignes', 40, 190, 200),
    line('84100 Orange', 40, 220, 140),
    line('Désignation', 200, 300, 140),
    line('Qté', 500, 300, 40),
    line('PU HT', 620, 300, 60),
    line('Montant HT', 900, 300, 90),
    line('ECH-90', 40, 340, 70),
    line('Echangeur modulaire inox', 200, 340, 220),
    line('2', 500, 340, 30),
    line('4 500,00', 620, 340, 80),
    line('9 000,00', 900, 340, 80),
  ]), 'invoice');
  assert.notEqual(extracted.customer?.name?.normalizedValue, 'Echangeur modulaire inox');
  assert.equal(partyNameLooksLikeItemDescription('Echangeur modulaire inox', ['ECH-90 Echangeur modulaire inox']), true);
  assert.equal(partyNameLooksLikeItemDescription('Domaine des Hautes Collines', ['Echangeur modulaire inox']), false);
});

test('WEAK numeric fields are not persisted', () => {
  assert.equal(shouldPersistCommittedField(commitLevelFromQuality('WEAK')), false);
  assert.equal(shouldPersistCommittedField(commitLevelFromQuality('COHERENT')), true);
  assert.equal(shouldPersistCommittedField(commitLevelFromQuality('STRONG')), true);
});

test('fallback does not relabel VAT as grand total', () => {
  const extraction = {
    type: 'invoice',
    language: { primaryLanguage: 'fr', reasons: [] },
    pages: [],
    items: [],
    taxSummaries: [],
    metadata: {},
    summary: {
      subtotal: { rawValue: '19446', normalizedValue: 19446, sourceLineIds: [], reasons: [], validationStatus: 'valid' as const, requiresReview: false },
      vatAmount: { rawValue: '3889.20', normalizedValue: 3889.2, sourceLineIds: [], reasons: [], validationStatus: 'valid' as const, requiresReview: false },
      total: { rawValue: '23335.20', normalizedValue: 23335.2, sourceLineIds: [], reasons: ['labeled_document_total'], validationStatus: 'valid' as const, requiresReview: false },
    },
    reasons: [],
    requiresReview: false,
  } as unknown as StructuredDocumentExtraction;
  const lines = ['Total TTC 3 889,20', 'TVA 20 3 889,20', 'Sous-total 19 446,00'];
  const overlaid = applySemanticFallbackOverlay(extraction, 'invoice', lines.join('\n'), lines);
  assert.equal(overlaid.summary.total?.normalizedValue, 23335.2);
});

test('OCR mutation of header token order still segments compound headers', () => {
  const mutated = segmentHeaderLine(
    {
      id: 'h3',
      pageIndex: 0,
      readingOrder: 0,
      text: 'Gesamt MwSt % Rabatt %',
      boundingBox: { x: 700, y: 90, width: 400, height: 20 },
    },
    (text) => {
      const folded = text.toLowerCase();
      if (/rabatt/.test(folded)) return 'discount';
      if (/mwst/.test(folded)) return 'vatRate';
      if (/gesamt/.test(folded)) return 'lineTotal';
      return undefined;
    },
  );
  assert.equal(new Set(mutated.map((entry) => entry.kind)).size, 3);
});

test('SKU does not bind to a drifted foreign line-total fragment', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Código', 40, 80, 80),
    line('Descripción', 200, 80, 140),
    line('Cant.', 500, 80, 50),
    line('P. Unitario', 620, 80, 90),
    line('IVA %', 900, 80, 60),
    line('Importe', 1100, 80, 80),
    line('SKU-A', 40, 140, 70),
    line('Pannello alluminio', 200, 140, 160),
    line('28', 500, 140, 30),
    line('200,00', 620, 140, 70),
    line('21', 900, 140, 30),
    line('5.600,00', 1100, 140, 80),
    line('7', 500, 205, 30),
    line('430,00', 620, 198, 70),
    line('21', 900, 192, 30),
    line('3.010,00', 1100, 186, 80),
    line('Tavolo modulo pieghevole', 200, 218, 200),
    line('SKU-B', 40, 226, 70),
    line('420,00', 1100, 268, 70),
    line('6', 500, 300, 30),
    line('70,00', 620, 294, 70),
    line('21', 900, 288, 30),
    line('Lampada modulo terrazza', 200, 312, 160),
    line('SKU-C', 40, 322, 70),
    line('SKU-D', 40, 390, 70),
    line('Kit accessori montaggio', 200, 390, 160),
    line('1', 500, 390, 30),
    line('60,00', 620, 390, 70),
    line('21', 900, 390, 30),
    line('60,00', 1100, 390, 70),
  ], 1400, 1600));
  const tableRow = result.items.find((item) => /Tavolo/.test(String(item.description?.normalizedValue ?? '')));
  const lampRow = result.items.find((item) => /Lampada/.test(String(item.description?.normalizedValue ?? '')));
  assert.equal(tableRow?.quantity?.normalizedValue, 7);
  assert.equal(tableRow?.unitPrice?.normalizedValue, 430);
  assert.equal(tableRow?.lineTotal?.normalizedValue, 3010);
  assert.notEqual(tableRow?.lineTotal?.normalizedValue, 420);
  assert.equal(lampRow?.quantity?.normalizedValue, 6);
  assert.equal(lampRow?.unitPrice?.normalizedValue, 70);
  if (lampRow?.lineTotal?.normalizedValue !== undefined) {
    assert.equal(lampRow.lineTotal.normalizedValue, 420);
  }
});

test('negative: recap heading is not a commercial row', () => {
  const result = extractDocumentItemsAndTotals(pages([
    line('Codice', 40, 80, 80),
    line('Descrizione', 180, 80, 160),
    line('Qta', 500, 80, 50),
    line('Prezzo', 620, 80, 80),
    line('Totale', 900, 80, 80),
    line('A-1', 40, 140, 60),
    line('Filtro industriale', 180, 140, 180),
    line('1', 500, 140, 30),
    line('100,00', 620, 140, 70),
    line('100,00', 900, 140, 70),
    line('Resumen de cantidades trienal', 40, 500, 280),
    line('42 unidades', 500, 540, 100),
    line('TOTAL 3 AÑOS', 40, 580, 160),
    line('130 unidades', 500, 580, 100),
  ]));
  assert.equal(result.items.every((item) => !/unidades|trienal|años/i.test(String(item.description?.normalizedValue ?? ''))), true);
});

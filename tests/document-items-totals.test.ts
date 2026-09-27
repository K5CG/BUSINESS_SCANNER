import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentItemsAndTotals, parseDocumentAmount } from '../lib/document-items-totals';

function cell(text: string, x: number, y: number, page = 0): OcrLine & { page: number } {
  return { text, confidence: 0.9, boundingBox: { x, y, width: 130, height: 22 }, page };
}

function page(pageIndex: number, lines: OcrLine[]) {
  return { pageIndex, width: 1000, height: 1400, lines, rawText: lines.map((line) => line.text).join('\n') };
}

const header = (y: number) => [
  cell('Codice', 40, y), cell('Descrizione', 190, y), cell('Qta', 520, y),
  cell('UM', 610, y), cell('Prezzo', 690, y), cell('IVA', 800, y), cell('Totale', 890, y),
];

test('una riga articolo usa colonne X e riga Y', () => {
  const lines = [...header(300), cell('A1', 40, 360), cell('Servizio', 190, 360), cell('2', 520, 360), cell('pz', 610, 360), cell('20,00', 690, 360), cell('22%', 800, 360), cell('40,00', 890, 360)];
  const result = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)]));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].description?.normalizedValue, 'Servizio');
  assert.equal(result.items[0].lineTotal?.normalizedValue, 40);
});

test('piu righe restano separate', () => {
  const lines = [...header(300),
    cell('A', 40, 360), cell('Uno', 190, 360), cell('1', 520, 360), cell('10,00', 690, 360), cell('10,00', 890, 360),
    cell('B', 40, 420), cell('Due', 190, 420), cell('2', 520, 420), cell('15,00', 690, 420), cell('30,00', 890, 420)];
  const result = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)]));
  assert.deepEqual(result.items.map((item) => item.description?.normalizedValue), ['Uno', 'Due']);
});

test('descrizione multilinea viene unita alla riga precedente', () => {
  const lines = [...header(300),
    cell('A', 40, 360), cell('Servizio di consulenza', 190, 360), cell('1', 520, 360), cell('100,00', 690, 360), cell('100,00', 890, 360),
    cell('con assistenza annuale', 190, 400)];
  const result = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)]));
  assert.equal(result.items[0].description?.normalizedValue, 'Servizio di consulenza con assistenza annuale');
});

test('quantita prezzo e totale sono distinti', () => {
  const lines = [...header(300), cell('A', 40, 360), cell('Lampada', 190, 360), cell('25', 520, 360), cell('20,00', 690, 360), cell('500,00', 890, 360)];
  const item = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)])).items[0];
  assert.equal(item.quantity?.normalizedValue, 25);
  assert.equal(item.unitPrice?.normalizedValue, 20);
  assert.equal(item.lineTotal?.normalizedValue, 500);
});

test('IVA per riga viene estratta soltanto dalla colonna IVA', () => {
  const lines = [...header(300), cell('A', 40, 360), cell('Lampada', 190, 360), cell('1', 520, 360), cell('100,00', 690, 360), cell('22%', 800, 360), cell('100,00', 890, 360)];
  const item = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)])).items[0];
  assert.equal(item.vatRate?.normalizedValue, 22);
});

test('esenzione conserva natura IVA senza inventare aliquota', () => {
  const lines = [...header(300), cell('A', 40, 360), cell('Servizio', 190, 360), cell('1', 520, 360), cell('100,00', 690, 360), cell('Esente N.2', 800, 360), cell('100,00', 890, 360)];
  const item = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)])).items[0];
  assert.match(item.vatNature?.normalizedValue ?? '', /Esente/);
  assert.equal(item.vatRate, undefined);
});

test('imponibile IVA e totale sono separati', () => {
  const lines = [cell('Imponibile 2.233,00', 600, 900), cell('IVA 22% 491,26', 600, 940), cell('Totale documento 2.724,26', 600, 1000)];
  const summary = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)])).summary;
  assert.equal(summary.subtotal?.normalizedValue, 2233);
  assert.equal(summary.vatAmount?.normalizedValue, 491.26);
  assert.equal(summary.total?.normalizedValue, 2724.26);
});

test('normalizza formati monetari italiani e internazionali', () => {
  assert.equal(parseDocumentAmount('2.724,26'), 2724.26);
  assert.equal(parseDocumentAmount('2724,26'), 2724.26);
  assert.equal(parseDocumentAmount('2,724.26'), 2724.26);
  assert.equal(parseDocumentAmount('€ 2.724,26'), 2724.26);
  assert.equal(parseDocumentAmount('20,00 €'), 20);
});

test('candidato con valuta isola l importo senza concatenare percentuale IVA', () => {
  const lines = [
    cell('Totale', 600, 900),
    cell('IVA 22% - EUR 220,00', 820, 900),
  ];
  const summary = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)])).summary;
  assert.equal(summary.total?.normalizedValue, 220);
});

test('tabella multipagina ignora intestazioni ripetute', () => {
  const first = [...header(300), cell('A', 40, 360), cell('Uno', 190, 360), cell('1', 520, 360), cell('10,00', 690, 360), cell('10,00', 890, 360)];
  const second = [...header(120), cell('B', 40, 180), cell('Due', 190, 180), cell('2', 520, 180), cell('15,00', 690, 180), cell('30,00', 890, 180), cell('Totale 40,00', 700, 900)];
  const result = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, first), page(1, second)]));
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map((item) => item.pageIndex), [0, 1]);
});

test('celle insufficienti generano riga parziale in review', () => {
  const lines = [...header(300), cell('solo descrizione', 190, 360), cell('10,00', 890, 360)];
  const result = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)]));
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].requiresReview, true);
});

test('missing numerico non viene trasformato in zero', () => {
  const lines = [...header(300), cell('A', 40, 360), cell('Servizio', 190, 360), cell('20,00', 690, 360), cell('20,00', 890, 360)];
  const item = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)])).items[0];
  assert.equal(item.quantity, undefined);
  assert.notEqual(item.unitPrice?.normalizedValue, 0);
});

test('note e condizioni restano evidenze separate', () => {
  const lines = [cell('Pagamento: bonifico 30 giorni', 40, 1000), cell('Consegna: entro 10 giorni', 40, 1050), cell('Note: imballo incluso', 40, 1100)];
  const conditions = extractDocumentItemsAndTotals(classifyDocumentLayoutPages([page(0, lines)])).conditions;
  assert.match(conditions.paymentTerms?.normalizedValue ?? '', /bonifico/);
  assert.match(conditions.deliveryTerms?.normalizedValue ?? '', /10 giorni/);
  assert.match(conditions.notes?.normalizedValue ?? '', /imballo/);
});

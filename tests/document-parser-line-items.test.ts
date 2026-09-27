import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQuoteDocument } from '../lib/document-parser';
import { findCustomerName } from '../lib/ocr-normalize';

test('parseQuoteDocument estrae righe tabella Udm Qtà Prezzo officina', () => {
  const lines = [
    'Preventivo n. P-99',
    'Destinatario',
    'SPETT. LE CHIOZZA TOMMASO',
    'Dettaglio Documento',
    'Udm Qtà Prezzo',
    'NR 1 216,9770 €',
    'NR 1 110,1416 €',
    'NR 2 42,7000 €',
    'Totale 1.234,56',
  ];
  const rawText = lines.join('\n');
  const ocrLines = lines.map((text) => ({ text, confidence: 0.9 }));
  const doc = parseQuoteDocument(ocrLines, rawText);
  assert.ok(doc.items.length >= 3, `items=${doc.items.length}`);
  assert.ok(doc.items.some((item) => Math.abs(item.unitPrice - 216.977) < 0.001));
  assert.match(doc.customerName ?? '', /chiozza tommaso/i);
});

test('findCustomerName riconosce SPETT. LE dopo destinatario', () => {
  const lines = ['Destinatario:', 'SPETT. LE CHIOZZA TOMMASO', 'Immatricolazione 20/12/2016'];
  assert.match(findCustomerName(lines.join('\n'), lines), /chiozza tommaso/i);
});

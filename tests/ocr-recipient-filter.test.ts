import assert from 'node:assert/strict';
import test from 'node:test';
import { findCustomerName, isDocumentTypeHeaderText, isTaxOrFiscalLabelText } from '../lib/ocr-normalize';

test('isTaxOrFiscalLabelText rifiuta etichette fiscali OCR', () => {
  assert.equal(isTaxOrFiscalLabelText('Codice Fiecale'), true);
  assert.equal(isTaxOrFiscalLabelText('Codice Fiscale'), true);
  assert.equal(isTaxOrFiscalLabelText('Codice Fiscae'), true);
  assert.equal(isTaxOrFiscalLabelText('Partite VA'), true);
  assert.equal(isTaxOrFiscalLabelText('Partite Va'), true);
  assert.equal(isDocumentTypeHeaderText('CONFERMA ORDINE'), true);
  assert.equal(isTaxOrFiscalLabelText('Beta S.r.l.'), false);
});

test('findCustomerName ignora destinatario con etichetta fiscale OCR', () => {
  const lines = [
    'Preventivo n. P-123',
    'Destinatario',
    'Codice Fiecale',
    'ACME S.r.l.',
    'Via Roma 1',
  ];
  const rawText = lines.join('\n');
  assert.match(findCustomerName(rawText, lines), /acme s\.r\.l\./i);
});

test('findCustomerName QA Künzi 1020 preferisce associazione su riferimento cliente', () => {
  const lines = [
    'CONFERMA ORDINE',
    'Spettabile',
    'Destinatario',
    'N. 2026002581 del 27103/2026',
    'Associazione "Amicl Trafol"',
    'Associazione "Amici Trafor',
    'Via Trafol, 6',
    'N. Rifterimento clente',
  ];
  const name = findCustomerName(lines.join('\n'), lines);
  assert.match(name, /Amici Trafo/i);
  assert.doesNotMatch(name, /riferimento/i);
});

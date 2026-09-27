import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';
import { collectNumericEvidence } from '../lib/parser-v5/numeric-evidence';

function page(lines: readonly string[]): CardPageV5 {
  return {
    lines: lines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.96,
        boundingBox: { x: 4, y: index * 28, width: 280, height: 20 },
      })
    ),
    rawText: lines.join('\n'),
  };
}

function digits(value: string): string {
  return value.replace(/\D/g, '');
}

test('Tel e Fax sulla stessa riga mantengono tipi distinti', () => {
  const result = extractCardV5([
    page(['NORTH LAB LTD.', 'Nora Vale', 'Tel. 0032-11-54.9696 - Fax 0032-11-54.9697']),
  ]);
  assert.deepEqual(result.phones.value?.map((phone) => phone.type), ['work', 'fax']);
});

test('IVA e CF combinati classificano lo stesso valore senza farne un telefono', () => {
  const result = extractCardV5([
    page(['MERIDIAN S.R.L.', 'Andrea Vale', 'P. IVA e CF 03481480238']),
  ]);
  assert.equal(result.vatNumber.value, '03481480238');
  assert.equal(result.taxCode.value, '03481480238');
  assert.equal(result.phones.value?.some((phone) => digits(phone.number) === '03481480238'), false);
});

test('prefisso condiviso con separatore dash espande il secondo telefono', () => {
  const result = extractCardV5([
    page(['NORTH LAB', 'Alberto Vale', 'TEL. 02/66.98.11.66 - 66.98.15.88']),
  ]);
  assert.deepEqual(
    result.phones.value?.map((phone) => digits(phone.number)),
    ['0266981166', '0266981588']
  );
});

test('prefisso internazionale osservato con slash espande solo il numero abbreviato', () => {
  const result = extractCardV5([
    page(['ATLAS GEAR', 'Asim Vale', 'O92-52-6523488 / 6523499']),
  ]);
  assert.deepEqual(
    result.phones.value?.map((phone) => digits(phone.number)),
    ['092526523488', '092526523499']
  );
});

test('badge affiliato adiacente non entra nel ruolo composto', () => {
  const result = extractCardV5([
    page(['NORTH HOMES S.R.L.', 'Lorena Vale', 'Responsabile Ufficio', 'AFFILIATO']),
  ]);
  assert.equal(result.role.value, 'Responsabile Ufficio');
});

test('badge Partner separato non prevale su un ruolo personale esplicito', () => {
  const result = extractCardV5([
    page(['GOLD', 'Partner', 'NORTH CONSULTING S.R.L.', 'Andrea Vale', 'Amministratore Unico']),
  ]);
  assert.equal(result.role.value, 'Amministratore Unico');
});

test('VAT belga etichettata resta fiscale e non telefonica', () => {
  const result = extractCardV5([
    page(['TECHNICAL NORTH BVBA', 'Nora Vale', 'BTW BE 0446.450.220']),
  ]);
  assert.equal(result.vatNumber.value, 'BE0446450220');
  assert.equal(result.phones.value?.length, 0);
});

test('WhatsApp duplicato di un mobile non emette due numeri', () => {
  const result = extractCardV5([
    page(['NORTH LAB', 'Nora Vale', 'Mobile +39 333 555 0101', 'WhatsApp +39 333 555 0101']),
  ]);
  assert.equal(result.phones.value?.length, 1);
});

test('identificativo numerico ambiguo non diventa telefono o VAT', () => {
  const evidence = collectNumericEvidence([
    { lineId: 1, pageIndex: 0, text: 'Codice pratica 12345678' },
  ]);
  assert.equal(evidence.some((item) => item.evidenceType === 'phone' || item.evidenceType === 'vat'), false);
});

test('etichetta OCR F consente O/0 soltanto nel fax numerico', () => {
  const result = extractCardV5([
    page(['NORTH LAB', 'Fabio Vale', 'F +39 045 21 O00 85']),
  ]);
  assert.equal(result.phones.value?.[0]?.type, 'fax');
  assert.equal(digits(result.phones.value?.[0]?.number ?? ''), '390452100085');
});

test('Tel Fax e Cell sulla stessa riga producono tre segmenti indipendenti', () => {
  const result = extractCardV5([
    page([
      'NORTH LAB',
      'Nora Vale',
      'Tel: +92-52-3615224 Fax: +92-52-3611781 Cell: 0321-6150001',
    ]),
  ]);
  assert.deepEqual(result.phones.value?.map((phone) => phone.type), ['work', 'fax', 'mobile']);
});

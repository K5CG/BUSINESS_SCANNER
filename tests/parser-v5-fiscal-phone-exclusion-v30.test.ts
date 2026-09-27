import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCardV5 } from '../lib/parser-v5/engine';
import type { OcrLine } from '../types';

function parse(texts: string[]) {
  const lines: OcrLine[] = texts.map((text, index) => ({
    text,
    confidence: 0.96,
    boundingBox: { x: 20, y: index * 34, width: Math.max(140, text.length * 8), height: 22 },
  }));
  return extractCardV5([{ lines, rawText: texts.join('\n') }]);
}

const fiscalLabels = [
  'Codice Fiscale O0255760241',
  'Cod. Fisc. O0255760241',
  'C.F. O0255760241',
  'C/F O0255760241',
  'Partita IVA 00255760241',
  'P.IVA 00255760241',
  'P IVA 00255760241',
  'VAT ID IT00255760241',
];

for (const fiscalLine of fiscalLabels) {
  test(`V30: ${fiscalLine} non diventa telefono`, () => {
    const result = parse([
      'DANTE CHIERICO',
      'PERITO INDUSTRIALE',
      'S.A.GE. MA, s.n.e.',
      fiscalLine,
      'Telefono (0445) 671155',
    ]);
    assert.deepEqual(
      (result.phones.value ?? []).map((phone) => phone.number),
      ['0445 671155'],
    );
  });
}

test('V30: riga mista fiscale + telefono conserva soltanto il vero telefono', () => {
  const result = parse([
    'ACME S.r.l.',
    'P.IVA 00255760241 - Tel. (0445) 671155',
  ]);
  assert.deepEqual(
    (result.phones.value ?? []).map((phone) => phone.number),
    ['0445 671155'],
  );
  assert.equal(result.vatNumber.value, '00255760241');
});

test('V30: OCR reale Dante conserva CF/P.IVA e un solo telefono', () => {
  const result = parse([
    'DANTE CHIERICO',
    'PERITO INDUSTRIALE',
    'S.A.GE. MA, s.n.e.',
    'SISTEMI AUTOMATICI GENERALI E MACCHINE',
    'AUTOMATISMI ELETTRONICI PER MACCHINE',
    'ED IMPIANTI INDUS TRIALI',
    '36015 SCHIO (Vicenza) ITALY',
    'Via Molise, 12- Z. I.',
    'Codice Fiscale O0255760241',
    'Telefono (0445) 671155',
    'Partita lVA 00255760241',
  ]);
  assert.equal(result.taxCode.value, '00255760241');
  assert.equal(result.vatNumber.value, '00255760241');
  assert.deepEqual(result.phones.value, [{ number: '0445 671155', type: 'work' }]);
  assert.equal(result.company.value, 'S.A.GE.MA. S.n.c.');
});

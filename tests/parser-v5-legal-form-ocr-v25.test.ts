import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

function page(specs: Array<[string, number, number]>): CardPageV5 {
  const lines = specs.map(
    ([text, y, height]): OcrLine => ({
      text,
      confidence: 0.96,
      boundingBox: {
        x: 10,
        y,
        width: Math.max(120, text.length * 7),
        height,
      },
    })
  );
  return {
    lines,
    rawText: specs.map(([text]) => text).join('\n'),
  };
}

test('V25 legal OCR: una forma valida S.n.c. resta invariata', () => {
  const result = extractCardV5([
    page([
      ['S.A. GE. MA, s. n.c.', 0, 48],
      ['SISTEMI AUTOMATICI GENERALI E MACCHINE', 52, 26],
      ['DANTE CHIERICO', 95, 22],
      ['PERITO INDUSTRIALE', 122, 18],
      ['Via Molise 12 Z.I.', 160, 14],
      ['36015 SCHIO (VI)', 180, 14],
      ['Telefono (0445) 671155', 200, 14],
      ['Partita IVA 00255760241', 220, 14],
    ]),
  ]);
  assert.equal(result.company.value, 'S.A.GE.MA. S.n.c.');
});

test('V25 legal OCR: s.n.e. non viene mai esposta come forma giuridica valida', () => {
  const result = extractCardV5([
    page([
      ['S. A. GE. A, s.n.e', 0, 48],
      ['SISTEMI AUTOMATICI GENERALI E MACCHINE', 52, 26],
      ['DANTE CHIERICO', 95, 22],
      ['PERITO INDUSTRIALE', 122, 18],
      ['Via Molise 12 Z.I.', 160, 14],
      ['36015 SCHIO (VI)', 180, 14],
      ['Telefono (0445) 671155', 200, 14],
      ['Partita IVA 00255760241', 220, 14],
    ]),
  ]);
  assert.equal(result.company.value, 'S.A.GE.A. S.n.c.');
  assert.ok(result.company.score <= 0.43);
  assert.match(result.company.reasons.join(' '), /dizionario chiuso/i);
});

test('V25 legal OCR: un prefisso raw OCR osservato piu completo viene preferito senza inventare lettere', () => {
  const result = extractCardV5([
    page([
      ['S. A. GE. A, s.n.e', 0, 48],
      ['S. A.GE. MA, . n.e', 50, 12],
      ['SISTEMI AUTOMATICI GENERALI E MACCHINE', 70, 26],
      ['DANTE CHIERICO', 105, 22],
      ['PERITO INDUSTRIALE', 132, 18],
      ['Via Molise 12 Z.I.', 160, 14],
      ['36015 SCHIO (VI)', 180, 14],
      ['Telefono (0445) 671155', 200, 14],
      ['Partita IVA 00255760241', 220, 14],
    ]),
  ]);
  assert.equal(result.company.value, 'S.A.GE.MA. S.n.c.');
  assert.ok(result.company.score <= 0.43);
});

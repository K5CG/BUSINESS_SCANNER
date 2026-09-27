import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

function page(texts: string[]): CardPageV5 {
  const lines = texts.map((text, index): OcrLine => ({
    text,
    confidence: 0.96,
    boundingBox: {
      x: 20,
      y: index * 34,
      width: Math.max(140, text.length * 8),
      height: index === 0 ? 42 : 22,
    },
  }));
  return { lines, rawText: texts.join('\n') };
}

test('V27: forma giuridica OCR corrotta da virgola viene canonicalizzata solo da candidato univoco', () => {
  const result = extractCardV5([
    page([
      'DANTE CHIERICO',
      'PERITO INDUSTRIALE',
      'S. A.GE. MA, s.n,G',
      'SISTEMI AUTOMATICI GENERALI E MACCHINE',
      'Tel. (0445) 671155',
    ]),
  ]);
  assert.equal(result.company.value, 'S.A.GE.MA. S.n.c.');
  assert.ok(result.company.score <= 0.69);
});

test('V27: forma giuridica valida osservata resta invariata', () => {
  const result = extractCardV5([
    page(['A.B.C. S.n.c.', 'Mario Rossi', 'Direttore', 'mario@abc.it']),
  ]);
  assert.match(result.company.value ?? '', /A\.B\.C\.?\s+S\.n\.c\./i);
});

test('V27: parola normale dopo acronimo non viene scambiata per forma giuridica', () => {
  const result = extractCardV5([
    page(['A.B.C. STORE', 'Mario Rossi', 'Direttore', 'mario@abcstore.it']),
  ]);
  assert.match(result.company.value ?? '', /STORE/i);
});

test('V27: DERGA recupera CONSULTING da riga OCR letter-spaced separata e corregge il glifo logo', () => {
  const result = extractCardV5([
    page([
      'DERGAE',
      'CONS ULT ING',
      'Fabrizio Lorigiola',
      'Account Manager',
      'fabrizio.lorigiola a derga. it',
      'www.derga.it',
    ]),
  ]);
  assert.equal(result.company.value, 'DERGA Consulting');
  assert.ok(result.company.score <= 0.69);
});

test('V27: letter-spacing costante completo viene ricomposto con autorita business indipendente', () => {
  const result = extractCardV5([
    page([
      'DERGAE',
      'C O N S U L T I N G',
      'Fabrizio Lorigiola',
      'Account Manager',
      'fabrizio.lorigiola@derga.it',
      'www.derga.it',
    ]),
  ]);
  assert.equal(result.company.value, 'DERGA Consulting');
});

test('V27: riga frammentata senza autorita business indipendente non viene inventata nella company', () => {
  const result = extractCardV5([
    page(['XYZART', 'C O N S U L T I N G', 'Jane Doe', 'Designer']),
  ]);
  assert.ok(!result.company.value || !/Consulting/i.test(result.company.value));
});

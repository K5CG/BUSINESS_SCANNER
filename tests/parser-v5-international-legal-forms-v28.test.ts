import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';
import {
  matchTerminalLegalFormSuffix,
  hasTerminalLegalFormSuffix,
} from '../lib/parser-engine/validators/dictionaries';
import {
  LEGAL_FORM_CATALOG,
  canonicalizeKnownLegalForm,
  repairUniqueLegalFormOcr,
} from '../lib/parser-engine/validators/legal-form-catalog';

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

test('V28: tutte le forme societarie del catalogo sono riconosciute come suffisso terminale', () => {
  const failed: string[] = [];
  for (const entry of LEGAL_FORM_CATALOG) {
    const candidate = `ACMEBRAND ${entry.canonical}`;
    const match = matchTerminalLegalFormSuffix(candidate);
    if (!match || !match.suffix) failed.push(entry.canonical);
  }
  assert.deepEqual(failed, []);
});

test('V28: grafie equivalenti SRL e SPA con punti/spazi/case sono riconosciute', () => {
  const variants = [
    'ACME S.r.l.',
    'ACME SRL',
    'ACME S R L',
    'ACME S.R.L.',
    'ACME S.p.A.',
    'ACME SpA',
    'ACME SPA',
    'ACME S P A',
  ];
  for (const value of variants) {
    assert.ok(matchTerminalLegalFormSuffix(value), value);
  }
});

test('V28: forme internazionali composte tollerano spaziatura OCR', () => {
  const variants = [
    'ACME P t e L t d',
    'ACME S de R L de C V',
    'ACME G m b H',
    'ACME L L C',
    'ACME Sp z o o',
  ];
  for (const value of variants) {
    assert.ok(matchTerminalLegalFormSuffix(value), value);
  }
});

test('V28: forme CJK/Hangul terminali sono riconosciute anche attaccate al brand', () => {
  assert.ok(matchTerminalLegalFormSuffix('北京科技有限公司'));
  assert.ok(matchTerminalLegalFormSuffix('上海股份有限公司'));
  assert.ok(matchTerminalLegalFormSuffix('서울테크유한회사'));
});

test('V28: repair OCR internazionale richiede un candidato unico a distanza <= 1', () => {
  assert.equal(repairUniqueLegalFormOcr('s.n,G'), 'S.n.c.');
  assert.equal(repairUniqueLegalFormOcr('GmbN'), 'GmbH');
  assert.equal(repairUniqueLegalFormOcr('Pte Ltc'), 'Pte. Ltd.');
  assert.equal(repairUniqueLegalFormOcr('S.A. de C.VX'), 'S.A. de C.V.');
});

test('V28: una forma non societaria lontana non viene inventata', () => {
  assert.equal(repairUniqueLegalFormOcr('STORE'), null);
  assert.equal(repairUniqueLegalFormOcr('CONSULTING'), null);
});

test('V28: pipeline completa normalizza S R L senza perdere il brand', () => {
  const result = extractCardV5([
    page(['ACME S R L', 'Mario Rossi', 'Direttore', 'mario.rossi@acme.it']),
  ]);
  assert.match(result.company.value ?? '', /^ACME\s+S\.r\.l\.$/i);
});

test('V28: pipeline completa ripara una forma estera OCR corrotta in modo univoco', () => {
  const result = extractCardV5([
    page(['ACME GmbN', 'John Doe', 'Director', 'john.doe@acme.de', 'www.acme.de']),
  ]);
  assert.match(result.company.value ?? '', /^ACME\s+GmbH$/i);
  assert.ok(result.company.score <= 0.82);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine, OcrQualityMetadata } from '../types';
import {
  chooseMultiAngleEmailConsensus,
  mergeMissingEmailIdentityLines,
  reconcileBusinessCardAngleConsensus,
  type OcrAngleAttempt,
  type OcrScanResult,
} from '../lib/ocr';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

const QUALITY: OcrQualityMetadata = {
  confidenceType: 'unknown',
  qualityReasons: [],
  requiresReview: false,
};

function scan(texts: string[], rotationDegrees: 0 | 90 | 180 | 270 = 0): OcrScanResult {
  const lines = texts.map((text, index): OcrLine => ({
    text,
    confidence: 0.96,
    boundingBox: { x: 20, y: index * 32, width: Math.max(120, text.length * 9), height: 24 },
  }));
  return { lines, text: texts.join('\n'), quality: QUALITY, rotationDegrees };
}

function attempts(variants: string[][]): OcrAngleAttempt[] {
  const angles = [0, 90, 180, 270] as const;
  return variants.map((texts, index) => ({ angle: angles[index], result: scan(texts, angles[index]) }));
}

test('V31: il consenso 3/4 reale recupera S.A.GE.MA. senza inventare testo', () => {
  const primary = scan([
    'DANTE CHIERICO',
    'PERITO INDUSTRIALE',
    'S.A. GE. A, s.n.c.',
    'SISTEMI AUTOMATICI GENERALI E MACCHINE',
  ]);
  const allAttempts = attempts([
    primary.lines.map((line) => line.text),
    ['DANTE CHIERICO', 'PERITO INDUSTRIALE', 'S.A.GE. MA, s. n.c.', 'SISTEMI AUTOMATICI GENERALI E MACCHINE'],
    ['DANTE CHIERICO', 'PERITO INDUSTRIALE', 'S.A.GE. MA, s. n.c.', 'SISTEMI AUTOMATICI GENERALI E MACCHINE'],
    ['DANTE CHIERICO', 'PERITO INDUSTRIALE', 'S.A.GE. MA, s.n.c.', 'SISTEMI AUTOMATICI GENERALI E MACCHINE'],
  ]);

  const reconciled = reconcileBusinessCardAngleConsensus(primary, allAttempts);
  assert.match(reconciled.text, /S\.A\.GE\. MA, s\. ?n\.c\./);
  assert.ok(allAttempts.some((attempt) => attempt.result.text.includes('S.A.GE. MA, s.n.c.')));

  const page: CardPageV5 = { lines: reconciled.lines, rawText: reconciled.text };
  const parsed = extractCardV5([page]);
  assert.equal(parsed.company.value, 'S.A.GE.MA. S.n.c.');
});

test('V38: una seconda lettura recupera una riga identità assente solo se confermata dalla email', () => {
  const primary = scan(['Example Industries Ltd.', 'General Manager', 'alex@example-industries.com']);
  const extra = scan(['Alex Johnson', 'Example Industries Ltd.', 'General Manager']);
  const merged = mergeMissingEmailIdentityLines(primary, extra);
  assert.match(merged.text, /^Alex Johnson\n/m);
});

test('V38: una seconda lettura non aggiunge un nome non collegato alla email osservata', () => {
  const primary = scan(['Example Industries Ltd.', 'General Manager', 'alex@example-industries.com']);
  const extra = scan(['Jordan Smith', 'Example Industries Ltd.', 'General Manager']);
  const merged = mergeMissingEmailIdentityLines(primary, extra);
  assert.equal(merged.text, primary.text);
});

test('V31: funziona su acronimi aziendali generici, non su un nome hard-coded', () => {
  const primary = scan(['MARIO ROSSI', 'A.B.D. s.r.l.', 'Tel. 02 1234567']);
  const reconciled = reconcileBusinessCardAngleConsensus(primary, attempts([
    ['MARIO ROSSI', 'A.B.D. s.r.l.', 'Tel. 02 1234567'],
    ['MARIO ROSSI', 'A.B.CD. s.r.l.', 'Tel. 02 1234567'],
    ['MARIO ROSSI', 'A.B.CD. s.r.l.', 'Tel. 02 1234567'],
    ['MARIO ROSSI', 'A.B.CD. s.r.l.', 'Tel. 02 1234567'],
  ]));
  assert.match(reconciled.text, /A\.B\.CD\. s\.r\.l\./);
});

test('V31: senza maggioranza stretta conserva la lettura selezionata', () => {
  const primary = scan(['OMEGA SERVICE', 'Via Roma 10']);
  const reconciled = reconcileBusinessCardAngleConsensus(primary, attempts([
    ['OMEGA SERVICE', 'Via Roma 10'],
    ['OMFGA SERVICE', 'Via Roma 10'],
    ['OM3GA SERVICE', 'Via Roma 10'],
    ['OMECA SERVICE', 'Via Roma 10'],
  ]));
  assert.equal(reconciled.lines[0].text, 'OMEGA SERVICE');
});

test('V31: il consenso vale anche per un recapito, ma solo con voto 3/4', () => {
  const primary = scan(['ALFA SRL', 'Tel. 0445 671155']);
  const reconciled = reconcileBusinessCardAngleConsensus(primary, attempts([
    ['ALFA SRL', 'Tel. 0445 671155'],
    ['ALFA SRL', 'Tel. 0445 671156'],
    ['ALFA SRL', 'Tel. 0445 671156'],
    ['ALFA SRL', 'Tel. 0445 671156'],
  ]));
  assert.match(reconciled.text, /671156/);
});

test('V31: righe non corrispondenti non vengono sostituite', () => {
  const primary = scan(['ALFA INDUSTRIA', 'Via Roma 10']);
  const reconciled = reconcileBusinessCardAngleConsensus(primary, attempts([
    ['ALFA INDUSTRIA', 'Via Roma 10'],
    ['BETA CONSULTING', 'Milano'],
    ['BETA CONSULTING', 'Milano'],
    ['BETA CONSULTING', 'Milano'],
  ]));
  assert.equal(reconciled.text, primary.text);
});

test('V31: matrice open-set di acronimi ripristina sempre la maggioranza osservata', () => {
  const brands = ['A.B.C.D. S.r.l.', 'X.Y.ZETA S.n.c.', 'Q.R.ST. S.p.A.', 'M.N.OP. GmbH'];
  for (const brand of brands) {
    const mutated = brand.replace(/[A-Z](?=[^.]*\.)/, '8');
    const primary = scan(['JANE DOE', mutated]);
    const variants = attempts([
      ['JANE DOE', mutated],
      ['JANE DOE', brand],
      ['JANE DOE', brand],
      ['JANE DOE', brand],
    ]);
    const reconciled = reconcileBusinessCardAngleConsensus(primary, variants);
    assert.equal(reconciled.lines[1].text, brand);
    assert.ok(variants.some((attempt) => attempt.result.lines.some((line) => line.text === brand)));
  }
});

test('V32: CORIUM usa il quorum email 2/4 e non la singola lettura errata', () => {
  const primary = scan(['E-mail: tagliabue@eoriumn-srl.it']);
  const allAttempts = attempts([
    ['B-mail: tagliabue@eoriumn-srl.it'],
    ['E-mail: tagliabue Ocorium-srl.it'],
    ['E-mail: tagliabue @corium-srl.it'],
    ['B-mail: tagliabue @corium-srl.it'],
  ]);
  const reconciled = reconcileBusinessCardAngleConsensus(primary, allAttempts);
  assert.match(reconciled.text, /tagliabue@corium-srl\.it/i);
  assert.deepEqual(reconciled.multiAngleConfirmedEmails, ['tagliabue@corium-srl.it']);
  const parsed = extractCardV5([{ lines: reconciled.lines, rawText: reconciled.text }]);
  assert.deepEqual(parsed.emails.value, ['tagliabue@corium-srl.it']);
  assert.doesNotMatch(parsed.emails.reasons.join(' '), /repair|repaired/i);
});

test('V32: ONLY TYPE normalizza e conferma la stessa email letta in 4 angoli', () => {
  const primary = scan(['onlytype @ libero.it']);
  const allAttempts = attempts([
    ['onlytype @ libero.it'],
    ['onlytype @libero.it'],
    ['onlytype @ libero.it'],
    ['onlytype@libero.it'],
  ]);
  const reconciled = reconcileBusinessCardAngleConsensus(primary, allAttempts);
  assert.equal(reconciled.lines[0].text, 'onlytype@libero.it');
  assert.deepEqual(reconciled.multiAngleConfirmedEmails, ['onlytype@libero.it']);
});

test('V32: due alternative email a pari quorum restano fail-closed', () => {
  const primary = scan(['Email: user@alpha-srl.it']);
  const allAttempts = attempts([
    ['Email: user@alpha-srl.it'],
    ['Email: user@alpha-srl.it'],
    ['Email: user@alphb-srl.it'],
    ['Email: user@alphb-srl.it'],
  ]);
  const decision = chooseMultiAngleEmailConsensus('user@alpha-srl.it', allAttempts);
  assert.equal(decision.confirmed, false);
  assert.equal(decision.selected, 'user@alpha-srl.it');
});

test('V32: una mailbox con local-part diverso non vota sulla email primaria', () => {
  const primary = scan(['Email: mario@azienda.it']);
  const allAttempts = attempts([
    ['Email: luigi@aziendb.it'],
    ['Email: luigi@aziendb.it'],
    ['Email: mario@azienda.it'],
  ]);
  const reconciled = reconcileBusinessCardAngleConsensus(primary, allAttempts);
  assert.equal(reconciled.lines[0].text, primary.lines[0].text);
  assert.deepEqual(reconciled.multiAngleConfirmedEmails, undefined);
});

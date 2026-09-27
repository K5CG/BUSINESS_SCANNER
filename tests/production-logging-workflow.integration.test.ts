import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import {
  parseCardFromPagesV5,
  type CardPageV5,
} from '../lib/parser-v5';

const SYNTHETIC_LINES = [
  'ALPHA ISOLATION S.R.L.',
  'Mario Rossi',
  'Direttore Commerciale',
  'mario.rossi@alpha-isolation.it',
  'www.alpha-isolation.it',
  'P.IVA 12345678901',
  'Tel: +39 02 1234 5678',
  'Via Roma 10',
  '20100 Milano (MI)',
] as const;

function ocrLine(text: string, index: number): OcrLine {
  return {
    text,
    confidence: 0.95,
    boundingBox: {
      x: 4,
      y: index * 24,
      width: Math.max(80, text.length * 7),
      height: 20,
    },
  };
}

function syntheticPage(): CardPageV5 {
  return {
    lines: SYNTHETIC_LINES.map(ocrLine),
    rawText: SYNTHETIC_LINES.join('\n'),
  };
}

test('7A-20 il parser conserva il risultato senza dati nei log produzione', () => {
  const captured: unknown[][] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...values) => captured.push(values);
  console.info = (...values) => captured.push(values);
  console.warn = (...values) => captured.push(values);
  console.error = (...values) => captured.push(values);

  try {
    const result = parseCardFromPagesV5([syntheticPage()]);

    assert.equal(result.firstName, 'Mario');
    assert.equal(result.lastName, 'Rossi');
    assert.equal(result.company, 'Alpha Isolation S.r.l.');
    assert.equal(result.role, 'Direttore Commerciale');
    assert.deepEqual(result.emails, [
      'mario.rossi@alpha-isolation.it',
    ]);
    assert.ok(result.phones.some((phone) => phone.number.includes('1234')));
    assert.equal(result.website, 'www.alpha-isolation.it');
    assert.equal(result.address?.city, 'Milano');
    assert.equal(result.vatNumber, '12345678901');
    assert.equal(typeof result.confidence.firstName, 'number');
    assert.equal(typeof result.confidence.company, 'number');
    assert.equal(result.rawText, SYNTHETIC_LINES.join('\n'));

    const logs = JSON.stringify(captured);
    const sensitiveValues = [
      ...SYNTHETIC_LINES,
      result.firstName,
      result.lastName,
      result.company,
      result.role,
      ...result.emails,
      ...result.phones.map((phone) => phone.number),
      result.website,
      result.address?.full,
      result.address?.street,
      result.address?.civicNumber,
      result.address?.postalCode,
      result.address?.city,
      result.address?.region,
      result.address?.country,
      result.vatNumber,
      result.taxCode,
      result.rawText,
    ].filter((value): value is string => Boolean(value && value.length >= 3));
    for (const value of new Set(sensitiveValues)) {
      assert.equal(logs.includes(value), false);
    }
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
});

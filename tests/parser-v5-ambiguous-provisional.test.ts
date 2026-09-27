import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import {
  extractCardV5,
  type CardPageV5,
  type V5Field,
  type V5Result,
} from '../lib/parser-v5/engine';

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

function page(lines: readonly string[]): CardPageV5 {
  return {
    lines: lines.map(ocrLine),
    rawText: lines.join('\n'),
  };
}

function semanticValues(result: V5Result): string {
  return JSON.stringify({
    firstName: result.firstName.value,
    lastName: result.lastName.value,
    company: result.company.value,
    role: result.role.value,
    emails: result.emails.value,
    phones: result.phones.value,
    website: result.website.value,
    address: result.address.value,
    vatNumber: result.vatNumber.value,
    taxCode: result.taxCode.value,
  });
}

function assertEmptyField<T>(field: V5Field<T>): void {
  assert.equal(field.value, null);
  assert.equal(field.score, 0);
}

test('ambiguous con OCR non vuoto estrae provvisoriamente dalla primaryPage', () => {
  const pages = [
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'mario.rossi@alpha.it',
      'Via Roma 10',
    ]),
    page(['Via Roma 10']),
  ];

  const result = extractCardV5(pages);
  const repeated = extractCardV5(pages);

  assert.equal(result.pageCoherence.decision, 'ambiguous');
  assert.equal(result.pageCoherence.primaryPage, 0);
  assert.equal(result.rawText, pages[0].rawText);
  assert.ok(semanticValues(result) !== semanticValues(extractCardV5([])));
  assert.deepEqual(result, repeated);
});

test('due identità conflittuali ambiguous non vengono fuse', () => {
  const pages = [
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'Tel: +39 02 1234 5678',
      'Via Roma 10',
    ]),
    page([
      'ALPHA S.R.L.',
      'Giulia Bianchi',
      'Tel: +39 02 1234 5678',
      'Via Roma 10',
    ]),
  ];

  const result = extractCardV5(pages);
  const primaryPage = result.pageCoherence.primaryPage;

  assert.equal(result.pageCoherence.decision, 'ambiguous');
  assert.equal(primaryPage, 0);
  assert.equal(result.rawText, pages[primaryPage].rawText);
  assert.doesNotMatch(semanticValues(result), /Giulia|Bianchi/i);

  const pageByLineId = new Map(
    result.debugLines.map((line) => [line.id, line.page])
  );
  const tracedLineIds = [
    result.firstName,
    result.lastName,
    result.company,
    result.role,
    result.address,
    result.vatNumber,
    result.taxCode,
  ].flatMap((field) => field.lineIds ?? []);
  assert.ok(
    tracedLineIds.every((lineId) => pageByLineId.get(lineId) === primaryPage)
  );
});

test('OCR davvero vuoto non genera un contatto provvisorio', () => {
  const result = extractCardV5([
    { lines: [], rawText: '' },
    { lines: [], rawText: ' \n ' },
  ]);

  assert.equal(result.rawText, '');
  assert.equal(result.pageCoherence.primaryPage, null);
  assertEmptyField(result.firstName);
  assertEmptyField(result.lastName);
  assertEmptyField(result.company);
  assertEmptyField(result.role);
  assertEmptyField(result.website);
  assertEmptyField(result.address);
  assertEmptyField(result.vatNumber);
  assertEmptyField(result.taxCode);
  assert.deepEqual(result.emails.value, []);
  assert.deepEqual(result.phones.value, []);
});

test('estrazione provvisoria preserva decision, review, pending e disposition', () => {
  const result = extractCardV5([
    page([
      'ALPHA S.R.L.',
      'Mario Rossi',
      'mario.rossi@alpha.it',
      'Tel: +39 02 1234 5678',
    ]),
    page(['Tel: +39 02 1234 5678']),
  ]);

  assert.equal(result.pageCoherence.decision, 'ambiguous');
  assert.equal(result.pageCoherence.requiresReview, true);
  assert.deepEqual(result.pageCoherence.includedPageIndexes, []);
  assert.deepEqual(result.pageCoherence.excludedPageIndexes, []);
  assert.deepEqual(result.pageCoherence.pendingPageIndexes, [0, 1]);
  assert.ok(result.pageCoherence.decisionReasons.length > 0);
  assert.ok(
    result.debugLines.every((line) => line.pageDisposition === 'pending')
  );
});

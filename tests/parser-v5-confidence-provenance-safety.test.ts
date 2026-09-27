import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import {
  extractBusinessCardV5,
  parseCardFromPagesV5,
} from '../lib/parser-v5';
import type { BusinessCardExtractionResult } from '../lib/parser-engine/card-extraction-result';
import type { CardPageV5 } from '../lib/parser-v5/engine';

interface PageOptions {
  confidence?: number;
  measuredConfidence?: number;
  heuristicQuality?: number;
  confidenceType?: OcrLine['confidenceType'];
}

function page(
  textLines: readonly string[],
  options: PageOptions = {}
): CardPageV5 {
  return {
    lines: textLines.map(
      (text, index): OcrLine => ({
        text,
        confidence: options.confidence ?? 0.96,
        measuredConfidence: options.measuredConfidence,
        heuristicQuality: options.heuristicQuality,
        confidenceType: options.confidenceType,
        boundingBox: {
          x: 10,
          y: 20 + index * 28,
          width: Math.max(180, text.length * 8),
          height: 22,
        },
      })
    ),
    rawText: textLines.join('\n'),
  };
}

function assertReviewedFieldsAreNotHigh(
  result: BusinessCardExtractionResult
): void {
  const reviewable = new Set([
    'firstName',
    'lastName',
    'company',
    'role',
    'emails',
    'phones',
    'website',
    'address',
    'vatNumber',
    'taxCode',
  ]);
  for (const key of result.reviewFields) {
    if (!reviewable.has(key)) continue;
    const field = result[key as keyof BusinessCardExtractionResult] as
      | { confidence?: string }
      | undefined;
    assert.notEqual(
      field?.confidence,
      'high',
      `${key} è in review ma mostra ancora confidence HIGH`
    );
  }
}

test('confidence: campo in review non può mostrare HIGH nei due adapter V5', () => {
  const source = page(
    [
      'dr. Aurelio Vardinl',
      'Independent Advisor',
      'Tel: +39 02 5555 0188',
    ],
    {
      confidence: 0.75,
      heuristicQuality: 0.75,
      confidenceType: 'heuristic',
    }
  );

  const direct = extractBusinessCardV5([source]);
  const savedCard = parseCardFromPagesV5([source]);
  const saved = savedCard.extractionReview;

  assert.ok(saved);
  assert.ok(savedCard.confidence.firstName <= 0.73);
  assert.ok(savedCard.confidence.lastName <= 0.73);
  for (const result of [direct, saved!]) {
    assert.ok(result.reviewFields.includes('firstName'));
    assert.ok(result.reviewFields.includes('lastName'));
    assertReviewedFieldsAreNotHigh(result);
    assert.notEqual(result.firstName.confidence, 'high');
    assert.notEqual(result.lastName.confidence, 'high');
  }
});

test('confidence: email riparata resta review e non diventa HIGH', () => {
  const source = page([
    'Jane Doe',
    'Technical Director',
    'ACME S.r.l.',
    'jane.doe@ example.com',
  ]);

  const direct = extractBusinessCardV5([source]);
  const saved = parseCardFromPagesV5([source]).extractionReview;

  assert.ok(saved);
  for (const result of [direct, saved!]) {
    assert.deepEqual(result.emails.value, ['jane.doe@example.com']);
    assert.equal(result.emails.source, 'repaired');
    assert.ok(result.reviewFields.includes('emails'));
    assert.notEqual(result.emails.confidence, 'high');
    assertReviewedFieldsAreNotHigh(result);
  }
});

test('confidence: prova osservata pulita non viene declassata artificialmente', () => {
  const source = page(
    [
      'Jane Doe',
      'Technical Director',
      'ACME S.r.l.',
      'jane.doe@acme.com',
    ],
    {
      confidence: 0.98,
      measuredConfidence: 0.98,
      confidenceType: 'measured',
    }
  );

  const direct = extractBusinessCardV5([source]);
  const saved = parseCardFromPagesV5([source]).extractionReview;

  assert.ok(saved);
  for (const result of [direct, saved!]) {
    assert.equal(result.company.confidence, 'high');
    assert.equal(result.role.confidence, 'high');
    assert.equal(result.emails.confidence, 'high');
    assert.equal(result.reviewFields.includes('company'), false);
    assert.equal(result.reviewFields.includes('role'), false);
    assert.equal(result.reviewFields.includes('emails'), false);
  }
});

test('confidence: i due adapter espongono la stessa politica di review', () => {
  const cases: CardPageV5[] = [
    page(['Jane Doe', 'Sales Manager', 'ACME', 'jane@acme.com']),
    page(['Jane Doe', 'CONSULTING', 'jane@example.com']),
    page(['Jane Doe', 'jane.doe@ example.com']),
  ];

  for (const source of cases) {
    const direct = extractBusinessCardV5([source]);
    const saved = parseCardFromPagesV5([source]).extractionReview;
    assert.ok(saved);
    assert.deepEqual(saved!.reviewFields, direct.reviewFields);
    for (const key of [
      'firstName',
      'lastName',
      'company',
      'role',
      'emails',
      'address',
    ] as const) {
      assert.equal(
        saved![key].confidence,
        direct[key].confidence,
        `${key}: policy confidence divergente tra adapter`
      );
    }
  }
});

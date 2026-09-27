import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5, type V5BusinessEvidenceProposal } from '../lib/parser-v5/engine';

function page(lines: readonly string[]): CardPageV5 {
  return {
    lines: lines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.96,
        boundingBox: { x: 4, y: index * 28, width: 300, height: index === 0 ? 30 : 20 },
      })
    ),
    rawText: lines.join('\n'),
  };
}

function proposal(lines: readonly string[], value: RegExp): V5BusinessEvidenceProposal {
  const result = extractCardV5([page(lines)]);
  const found = result.businessEvidenceProposals?.find((item) => value.test(item.normalizedValue));
  assert.ok(found, JSON.stringify(result.businessEvidenceProposals));
  return found;
}

test('logo ed email business concordi producono consenso tracciato', () => {
  const item = proposal(['NORTHLAB', 'Nora Vale', 'nora@northlab.com'], /northlab/i);
  assert.ok(item.evidenceTypes.includes('logo'));
  assert.ok(item.evidenceTypes.includes('email-domain'));
  assert.equal(item.requiresReview, false);
});

test('logo e sito osservato concordi conservano righe e pagine sorgente', () => {
  const item = proposal(['NORTHLAB', 'www.northlab.com'], /northlab/i);
  assert.ok(item.evidenceTypes.includes('logo'));
  assert.ok(item.evidenceTypes.includes('website-domain'));
  assert.deepEqual(item.sourcePages, [0]);
  assert.equal(item.sourceLineIds.length, 2);
});

test('email e sito concordi sono due fonti indipendenti', () => {
  const item = proposal(['nora@northlab.com', 'www.northlab.com'], /northlab/i);
  assert.ok(item.evidenceTypes.includes('email-domain'));
  assert.ok(item.evidenceTypes.includes('website-domain'));
  assert.ok(item.confidence >= 0.9);
});

test('una sola fonte forte resta proposta da revisionare', () => {
  const item = proposal(['www.northlab.com'], /northlab/i);
  assert.equal(item.requiresReview, true);
  assert.ok(item.confidence < 0.8);
});

test('provider email generico non conta come evidenza aziendale', () => {
  const result = extractCardV5([page(['Nora Vale', 'nora@gmail.com'])]);
  assert.equal(result.businessEvidenceProposals?.some((item) => /gmail/i.test(item.normalizedValue)), false);
});

test('due domini business divergenti restano proposte separate', () => {
  const result = extractCardV5([page(['nora@northlab.com', 'www.southworks.com'])]);
  const domainItems = result.businessEvidenceProposals?.filter((item) =>
    item.evidenceTypes.some((type) => type === 'email-domain' || type === 'website-domain')
  ) ?? [];
  assert.equal(domainItems.length, 2);
  assert.ok(domainItems.every((item) => item.requiresReview));
});

test('variante OCR limitata conserva raw e richiede review', () => {
  const item = proposal(['N0RTHLAB', 'nora@northlab.com'], /northlab/i);
  assert.match(item.rawValue, /N0RTHLAB/);
  assert.equal(item.requiresReview, true);
  assert.match(item.reason, /variante limitata/i);
});

test('fonti concordi su pagine diverse conservano entrambe le pagine', () => {
  const result = extractCardV5([
    page(['NORTHLAB', 'Nora Vale']),
    page(['www.northlab.com']),
  ]);
  const item = result.businessEvidenceProposals?.find((entry) => /northlab/i.test(entry.normalizedValue));
  assert.ok(item);
  assert.deepEqual(item.sourcePages, [0, 1]);
});

test('claim concorrente non entra nel consenso del brand osservato', () => {
  const item = proposal(['QUALITY FOR EVERYONE S.A.', 'NORTHLAB', 'www.northlab.com'], /northlab/i);
  assert.doesNotMatch(item.rawValue, /QUALITY FOR EVERYONE/i);
  assert.ok(item.evidenceTypes.includes('logo'));
});

test('assenza di evidenza business sufficiente non crea una proposta', () => {
  const result = extractCardV5([page(['Nora Vale', 'Regional Director', 'Call me tomorrow'])]);
  assert.deepEqual(result.businessEvidenceProposals, []);
});

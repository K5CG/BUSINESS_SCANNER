import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentIdentity } from '../lib/document-parties-metadata';
import {
  isPaymentSectionContext,
  isRejectedIssuerName,
  scoreIssuerCandidate,
} from '../lib/document-issuer-model';

function line(text: string, x: number, y: number): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width: 700, height: 24 } };
}

function identity(lines: OcrLine[], type: 'quote' | 'order' | 'free_document' = 'quote') {
  const pages = classifyDocumentLayoutPages([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }]);
  return extractDocumentIdentity(pages, type);
}

test('rejects IBAN, VAT-only, email, and field headings as issuer names', () => {
  assert.equal(isRejectedIssuerName('IT60X0542811101000000123456'), true);
  assert.equal(isRejectedIssuerName('P.IVA 00112233445'), true);
  assert.equal(isRejectedIssuerName('info@example.com'), true);
  assert.equal(isRejectedIssuerName('Emittente:'), true);
  assert.equal(isRejectedIssuerName('Alfa S.p.A.'), false);
  assert.equal(isRejectedIssuerName('Srl.'), true);
  assert.equal(isRejectedIssuerName('GmbH'), true);
  assert.equal(isRejectedIssuerName('Intesa Sanpaolo S.p.A - Filiale di Vicenza'), true);
});

test('payment-section bank fragments are not issuer evidence', () => {
  assert.equal(isPaymentSectionContext('Intesa Sa', ['IBAN IT60X0542811101000000123456', 'BIC BCITITMM']), true);
  const decision = scoreIssuerCandidate({
    name: 'Intesa Sa',
    yRatio: 0.85,
    inHeaderZone: false,
    inSenderBlock: false,
    hasStrongLegalForm: false,
    hasWeakSaOnly: true,
    nearbyVat: false,
    nearbyAddress: false,
    nearbyWebsite: false,
    inPaymentZone: true,
    nearbyPaymentContext: true,
  });
  assert.equal(decision.accept, false);
});

test('header organization with legal form and VAT is accepted', () => {
  const decision = scoreIssuerCandidate({
    name: 'Alfa Componenti S.r.l.',
    yRatio: 0.08,
    inHeaderZone: true,
    inSenderBlock: true,
    hasStrongLegalForm: true,
    hasWeakSaOnly: false,
    nearbyVat: true,
    nearbyAddress: true,
    nearbyWebsite: false,
    inPaymentZone: false,
    nearbyPaymentContext: false,
  });
  assert.equal(decision.accept, true);
});

test('issuer from payment IBAN block is dropped', () => {
  const result = identity([
    line('Preventivo n. P-9 Data 01/02/2026', 40, 80),
    line('Spett.le Cliente Beta S.r.l.', 40, 360),
    line('IBAN IT60X0542811101000000123456', 40, 1100),
    line('Intesa Sa', 40, 1140),
    line('BIC BCITITMM', 40, 1180),
  ]);
  assert.notEqual(result.issuer?.name?.normalizedValue, 'Intesa Sa');
  assert.equal(result.customer?.name?.normalizedValue, 'Cliente Beta S.r.l.');
});

test('bank branch line is not accepted as issuer even with a legal form', () => {
  const result = identity([
    line('Intesa Sanpaolo S.p.A - Filiale di Vicenza', 40, 80),
    line('IBAN IT60X0542811101000000123456', 40, 120),
    line('Spett.le Autofficina Cliente S.r.l.', 40, 360),
    line('Ordine 2025/0874', 40, 200),
  ]);
  assert.equal(result.issuer?.name?.normalizedValue, undefined);
});

test('missing issuer stays empty instead of copying the only customer', () => {
  const result = identity([
    line('Preventivo n. P-1 Data 01/01/2026', 40, 80),
    line('Spett.le Solo Cliente S.r.l.', 40, 360),
  ]);
  assert.equal(result.customer?.name?.normalizedValue, 'Solo Cliente S.r.l.');
  assert.notEqual(result.issuer?.name?.normalizedValue, result.customer?.name?.normalizedValue);
});

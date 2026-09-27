import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuoteDocument } from '../types';
import type { StructuredDocumentExtraction } from '../lib/document-structure';
import type { GeminiDocumentExtract } from '../lib/gemini-document-extract';
import { documentStageSnapshot, geminiStageSnapshot } from '../lib/pdf-stage-trace';

const extraction = {
  issuer: { role: 'issuer', name: { normalizedValue: 'Idee Business Srl' } },
  customer: { role: 'customer', name: { normalizedValue: 'ACME Spa' } },
  metadata: { subject: { normalizedValue: 'Fornitura arredi' } },
} as unknown as StructuredDocumentExtraction;

function quote(overrides: Partial<QuoteDocument> = {}): QuoteDocument {
  return {
    id: 'doc-1',
    type: 'quote',
    title: 'Preventivo AN-1002',
    rawText: 'Preventivo AN-1002',
    images: [],
    createdAt: new Date('2026-02-06T10:00:00Z'),
    items: [],
    ...overrides,
  } as QuoteDocument;
}

test('la fotografia di Gemini legge i campi piatti e quelli strutturati', () => {
  const extract: GeminiDocumentExtract = {
    rawText: 'testo',
    documentNumber: 'AN-1002',
    customerName: 'ACME Spa',
    date: '2025-02-06',
    subtotal: 1000,
    vatAmount: 0,
    total: 1000,
    items: [{ description: 'Servizio', total: 1000 }],
    structured: {
      issuer: { name: { value: 'Idee Business Srl' } },
      document: {
        subject: { value: 'Fornitura arredi' },
        documentType: { value: 'quotation' },
        currency: { value: 'EUR' },
      },
      items: [],
      summary: {},
    },
  } as unknown as GeminiDocumentExtract;

  assert.deepEqual(geminiStageSnapshot(extract), {
    documentType: 'quotation',
    currency: 'EUR',
    issuer: 'Idee Business Srl',
    customer: 'ACME Spa',
    documentNumber: 'AN-1002',
    date: '2025-02-06',
    subject: 'Fornitura arredi',
    items: 1,
    subtotal: 1000,
    vat: 0,
    total: 1000,
  });
});

test('la fotografia del documento distingue i campi assenti', () => {
  const snapshot = documentStageSnapshot(quote({ quoteNumber: 'AN-1002' }));
  assert.equal(snapshot.documentNumber, 'AN-1002');
  assert.equal(snapshot.issuer, null);
  assert.equal(snapshot.subject, null);
  assert.equal(snapshot.customer, null);
  assert.equal(snapshot.items, 0);
  assert.equal(snapshot.total, null);
});

test('dopo la parita strutturata compaiono emittente e oggetto', () => {
  const snapshot = documentStageSnapshot(quote({
    quoteNumber: 'AN-1002',
    quoteDate: new Date('2025-02-06T00:00:00Z'),
    customerName: 'ACME Spa',
    items: [{ description: 'Servizio', quantity: 1, unitPrice: 1000, total: 1000 }],
    subtotal: 1000,
    vatAmount: 0,
    total: 1000,
    structuredExtraction: extraction,
  }));

  assert.deepEqual(snapshot, {
    documentType: 'quote',
    currency: null,
    issuer: 'Idee Business Srl',
    customer: 'ACME Spa',
    documentNumber: 'AN-1002',
    date: '2025-02-06',
    subject: 'Fornitura arredi',
    items: 1,
    subtotal: 1000,
    vat: 0,
    total: 1000,
  });
});

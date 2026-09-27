import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { OrderDocument, QuoteDocument } from '../types';
import {
  BACKGROUND_STRUCTURED_ENRICHMENT_ENABLED,
  documentNeedsStructuredEnrichment,
  layoutInputsFromDocument,
} from '../lib/document-scan-enrichment';
import { createScanDeferredStructuredExtraction } from '../lib/document-structured-extraction';

test('documento deferred richiede arricchimento strutturato', () => {
  const extraction = createScanDeferredStructuredExtraction([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines: [{ text: 'Preventivo n. P-1', confidence: 0.9 }],
    rawText: 'Preventivo n. P-1',
  }]);
  const doc: QuoteDocument = {
    id: 'd1',
    type: 'quote',
    title: 'Preventivo',
    images: ['p.jpg'],
    rawText: 'Preventivo n. P-1',
    confidence: {},
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    structuredExtraction: extraction,
  };
  assert.equal(documentNeedsStructuredEnrichment(doc), BACKGROUND_STRUCTURED_ENRICHMENT_ENABLED);
});

test('layoutInputsFromDocument usa linee OCR con bounding box dal deferred shell', () => {
  const extraction = createScanDeferredStructuredExtraction([{
    pageIndex: 0,
    width: 1300,
    height: 919,
    lines: [
      { text: 'CONFERMA ORDINE', confidence: 0.9, boundingBox: { x: 40, y: 50, width: 200, height: 22 } },
      { text: 'Cliente: Beta S.r.l.', confidence: 0.9, boundingBox: { x: 40, y: 120, width: 220, height: 22 } },
    ],
    rawText: 'CONFERMA ORDINE\nCliente: Beta S.r.l.',
  }]);
  const doc: OrderDocument = {
    id: 'o1',
    type: 'order',
    title: 'Ordine',
    images: ['p.jpg'],
    rawText: extraction.pages[0].lines.map((line) => line.text).join('\n'),
    confidence: {},
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    structuredExtraction: extraction,
  };
  const inputs = layoutInputsFromDocument(doc);
  assert.equal(inputs.length, 1);
  assert.ok(inputs[0].lines.some((line) => line.text.includes('CONFERMA ORDINE')));
  assert.equal(inputs[0].width, 1300);
});

test('detail screen non avvia arricchimento post-scan automatico', () => {
  const screen = fs.readFileSync(path.join(process.cwd(), 'app/document/[id].tsx'), 'utf8');
  assert.doesNotMatch(screen, /enrichDocumentStructuredExtraction/);
  assert.doesNotMatch(screen, /documentNeedsStructuredEnrichment/);
  assert.match(screen, /resolveDocumentAiCreditState/);
});

test('enrichment post-scan resta disattivato', async () => {
  const extraction = createScanDeferredStructuredExtraction([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines: [{ text: 'Preventivo n. P-1', confidence: 0.9 }],
    rawText: 'Preventivo n. P-1',
  }]);
  const doc: QuoteDocument = {
    id: 'd-enrich-off',
    type: 'quote',
    title: 'Preventivo',
    images: ['p.jpg'],
    rawText: 'Preventivo n. P-1',
    confidence: {},
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    structuredExtraction: extraction,
  };
  const { enrichDocumentStructuredExtraction } = await import('../lib/document-scan-enrichment');
  assert.equal(await enrichDocumentStructuredExtraction(doc), null);
});

test('QA export landscape ordine conserva metadati utili al parser geometrico', () => {
  const qaPath = path.join(process.cwd(), 'test-data/qa-export-2026-08-06-2230/documents.json');
  if (!fs.existsSync(qaPath)) return;
  const docs = JSON.parse(fs.readFileSync(qaPath, 'utf8')) as OrderDocument[];
  const order = docs.find((doc) => doc.type === 'order');
  assert.ok(order, 'ordine QA mancante');
  assert.equal(order!.pageCaptureMetadata?.[0]?.selectedCaptureMode, 'landscape-left');
  assert.ok(documentNeedsStructuredEnrichment(order!) === BACKGROUND_STRUCTURED_ENRICHMENT_ENABLED);
  const inputs = layoutInputsFromDocument(order!);
  assert.ok(inputs[0]?.lines.length > 20, 'linee OCR geometriche disponibili');
});

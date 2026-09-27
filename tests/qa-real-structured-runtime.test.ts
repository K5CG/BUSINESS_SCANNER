import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { InvoiceDocument, OcrLine, OrderDocument, QuoteDocument } from '../types';
import type { DocumentLayoutPageInput } from '../lib/document-layout';
import type { StructuredDocumentType } from '../lib/document-structure';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocument,
  extractStructuredDocumentAsync,
  isDeferredStructuredExtraction,
} from '../lib/document-structured-extraction';

type QaCommercialDocument = QuoteDocument | OrderDocument | InvoiceDocument;

const qaRoot = path.join(process.cwd(), 'test-data', 'qa-export-2026-08-08-real');
const qaJsonPath = path.join(qaRoot, 'documents.json');

const BAD_CUSTOMER_LABELS = [
  /^payment terms$/i,
  /^unit price$/i,
  /^partita$/i,
  /^descripci[oó]n del suministro/i,
];

function loadAug8Documents(): QaCommercialDocument[] {
  assert.equal(fs.existsSync(qaJsonPath), true, 'QA export 2026-08-08 mancante');
  const docs = JSON.parse(fs.readFileSync(qaJsonPath, 'utf8')) as QaCommercialDocument[];
  return docs.filter((doc) => String(doc.createdAt).startsWith('2026-08-08'));
}

function layoutInputsFromQaDocument(doc: QaCommercialDocument): DocumentLayoutPageInput[] {
  const pages = doc.structuredExtraction?.pages ?? [];
  return pages.map((page) => ({
    pageIndex: page.pageIndex,
    lines: page.lines.map((line): OcrLine => ({
      text: line.text,
      confidence: 0.9,
      ...(line.boundingBox ? { boundingBox: line.boundingBox } : {}),
      ...(line.elements ? { elements: line.elements } : {}),
    })),
    rawText: page.lines.map((line) => line.text).join('\n'),
    width: page.width,
    height: page.height,
  }));
}

function documentNumber(doc: QaCommercialDocument): string | undefined {
  if (doc.type === 'quote') return doc.quoteNumber;
  if (doc.type === 'order') return doc.orderNumber;
  if (doc.type === 'invoice') return doc.invoiceNumber;
  return undefined;
}

function runCanonicalPipeline(doc: QaCommercialDocument) {
  const extraction = extractStructuredDocument(
    doc.type as StructuredDocumentType,
    layoutInputsFromQaDocument(doc),
  );
  const applied = applyStructuredExtractionToDocument(
    { ...doc, items: doc.items ?? [] },
    extraction,
    { mode: 'new_scan' },
  ) as QaCommercialDocument;
  return { extraction, applied };
}

test('QA 2026-08-08: 9 documenti benchmark presenti', () => {
  assert.equal(loadAug8Documents().length, 9);
});

test('QA 2026-08-08: structured runtime non usa piu deferred_on_scan', () => {
  for (const doc of loadAug8Documents()) {
    const { extraction } = runCanonicalPipeline(doc);
    assert.equal(
      isDeferredStructuredExtraction(extraction),
      false,
      `${doc.id} still deferred`,
    );
    assert.equal(
      extraction.reasons.includes('structured_extraction_deferred_on_scan'),
      false,
      `${doc.id} deferred reason`,
    );
  }
});

test('ThermoFlux multipagina: identity, customer e total canonici', () => {
  const doc = loadAug8Documents().find((entry) => entry.id.startsWith('21359f33'));
  assert.ok(doc);
  const started = Date.now();
  const { extraction, applied } = runCanonicalPipeline(doc!);
  const ms = Date.now() - started;
  assert.equal(extraction.pages.length, 2);
  assert.equal(documentNumber(applied), 'DEV-2025-0612');
  assert.match(applied.customerName ?? '', /Domaine Viticole des Hautes Collines/i);
  assert.equal(applied.total, 47578.8);
  assert.ok(ms < 15000, `structured extraction troppo lenta: ${ms}ms`);
  console.warn(`[QA-TIMING] ThermoFlux structured=${ms}ms pages=${extraction.pages.length}`);
});

test('Tecnoforniture: total canonico non confonde IVA con totale', () => {
  const doc = loadAug8Documents().find((entry) => entry.id.startsWith('b82a4053'));
  assert.ok(doc);
  const { applied } = runCanonicalPipeline(doc!);
  assert.equal(documentNumber(applied), 'PV/2025/0478');
  assert.equal(applied.total, 540.86);
  assert.notEqual(applied.total, 79.78);
});

test('Northbridge: total canonico e document number da OCR', () => {
  const doc = loadAug8Documents().find((entry) => entry.id.startsWith('28ff5440'));
  assert.ok(doc);
  const { applied } = runCanonicalPipeline(doc!);
  assert.match(documentNumber(applied) ?? '', /OTN-26-0527/i);
  assert.equal(applied.total, 27261);
});

test('Medisupply: invoice number canonico; customer non e Payment Terms', () => {
  const doc = loadAug8Documents().find((entry) => entry.id.startsWith('2adb6bb0'));
  assert.ok(doc);
  const { applied } = runCanonicalPipeline(doc!);
  assert.equal(documentNumber(applied), 'INV-2025-05678');
  assert.doesNotMatch(applied.customerName ?? '', /^payment terms$/i);
});

test('scan workflow esegue extractStructuredDocumentAsync nel percorso Elabora', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), 'lib/scan-process-workflow.ts'), 'utf8');
  assert.match(workflow, /extractStructuredDocumentAsync/);
  assert.match(workflow, /workflow:structured_timing/);
  assert.doesNotMatch(workflow, /createScanDeferredStructuredExtraction/);
  assert.doesNotMatch(workflow, /structured_extraction_deferred_on_scan/);
});

test('extractStructuredDocumentAsync ThermoFlux completa entro soglia ragionevole', async () => {
  const doc = loadAug8Documents().find((entry) => entry.id.startsWith('21359f33'));
  assert.ok(doc);
  const started = Date.now();
  const extraction = await extractStructuredDocumentAsync(
    doc!.type as StructuredDocumentType,
    layoutInputsFromQaDocument(doc!),
  );
  const ms = Date.now() - started;
  assert.equal(isDeferredStructuredExtraction(extraction), false);
  assert.ok(extraction.summary.total?.normalizedValue === 47578.8);
  console.warn(`[QA-TIMING] ThermoFlux async structured=${ms}ms items=${extraction.items.length}`);
});

test('customer canonico non usa label tabella o agente ove structured ha party', () => {
  const checks: Array<{ idPrefix: string; expectCustomer?: RegExp; forbid?: RegExp }> = [
    { idPrefix: '21359f33', expectCustomer: /Domaine Viticole/i },
    { idPrefix: 'b82a4053', expectCustomer: /Officine Maraldi/i },
    { idPrefix: '960e93ce', forbid: /^(payment terms|unit price)$/i },
  ];
  for (const check of checks) {
    const doc = loadAug8Documents().find((entry) => entry.id.startsWith(check.idPrefix));
    assert.ok(doc, check.idPrefix);
    const { applied } = runCanonicalPipeline(doc!);
    if (check.expectCustomer) assert.match(applied.customerName ?? '', check.expectCustomer);
    if (check.forbid) assert.doesNotMatch(applied.customerName ?? '', check.forbid);
    for (const bad of BAD_CUSTOMER_LABELS) {
      if (check.idPrefix === '2adb6bb0' || check.idPrefix === '28ff5440') continue;
      assert.doesNotMatch(applied.customerName ?? '', bad);
    }
  }
});

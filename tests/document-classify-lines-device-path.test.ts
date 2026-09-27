import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { InvoiceDocument, OcrLine, OrderDocument, QuoteDocument } from '../types';
import type { DocumentLayoutPageInput } from '../lib/document-layout';
import { classifyDocumentLayoutPageAsync } from '../lib/document-layout';
import type { StructuredDocumentType } from '../lib/document-structure';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocumentAsync,
} from '../lib/document-structured-extraction';
import { createScanProcessDeadline } from '../lib/scan-process-deadline';

type QaDoc = QuoteDocument | OrderDocument | InvoiceDocument;

const qaRoot = path.join(process.cwd(), 'test-data', 'qa-export-2026-08-08-real-full');

const KEY_FIXTURES = [
  {
    name: 'Tecnoforniture',
    idPrefix: 'b82a4053',
    docNumber: 'PV/2025/0478',
    total: 540.86,
    minItems: 1,
  },
  {
    name: 'Motorparts',
    idPrefix: 'a13fa9a4',
    docNumber: /2025\/0874/i,
    customer: /Autofficina Chiozza/i,
    minItems: 1,
  },
  {
    name: 'ThermoFlux',
    idPrefix: '21359f33',
    docNumber: 'DEV-2025-0612',
    customer: /Domaine Viticole/i,
    net: 39649,
    vat: 7929.8,
    total: 47578.8,
    minItems: 1,
    maxItems: 19,
  },
] as const;

function loadDoc(idPrefix: string): QaDoc {
  const docs = JSON.parse(fs.readFileSync(path.join(qaRoot, 'documents.json'), 'utf8')) as QaDoc[];
  const doc = docs.find((entry) => entry.id.startsWith(idPrefix));
  assert.ok(doc, idPrefix);
  return doc!;
}

function layoutInputs(doc: QaDoc): DocumentLayoutPageInput[] {
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

function docNumber(applied: QaDoc): string | undefined {
  if (applied.type === 'quote') return applied.quoteNumber;
  if (applied.type === 'order') return applied.orderNumber;
  if (applied.type === 'invoice') return applied.invoiceNumber;
  return undefined;
}

for (const fixture of KEY_FIXTURES) {
  test(`${fixture.name}: device-path async layout + full extraction`, async () => {
    const doc = loadDoc(fixture.idPrefix);
    const inputs = layoutInputs(doc);
    const ocrLines = inputs.reduce((sum, page) => sum + page.lines.length, 0);
    const layoutStarted = Date.now();
    for (const input of inputs) {
      const page = await classifyDocumentLayoutPageAsync(input, {
        layoutDeadlineMs: 5_000,
        yieldEvery: 8,
      });
      assert.ok(!page.reasons.includes('structured_layout_timeout'), `${fixture.name} layout timeout`);
    }
    const layoutMs = Date.now() - layoutStarted;

    const started = Date.now();
    const extraction = await extractStructuredDocumentAsync(
      doc.type as StructuredDocumentType,
      inputs,
      { processDeadline: createScanProcessDeadline(inputs.length), yieldEvery: 8 },
    );
    const structuredMs = Date.now() - started;
    const applied = applyStructuredExtractionToDocument(
      { ...doc, items: doc.items ?? [] },
      extraction,
      { mode: 'new_scan' },
    ) as QaDoc;

    const timedOut = extraction.reasons.includes('structured_layout_timeout')
      || extraction.reasons.includes('structured_process_timeout');
    const fallback = timedOut;

    console.warn(`[ClassifyDevicePath] ${JSON.stringify({
      document: fixture.name,
      pages: inputs.length,
      ocrLines,
      layoutMs,
      structuredMs,
      timeout: timedOut,
      fallback,
      items: extraction.items.length,
      requiresReview: extraction.requiresReview,
    })}`);

    assert.equal(timedOut, false, `${fixture.name} structured timeout`);
    assert.equal(fallback, false);
    assert.ok(extraction.items.length >= fixture.minItems, `${fixture.name} items=${extraction.items.length}`);
    if ('maxItems' in fixture && fixture.maxItems !== undefined) {
      assert.ok(extraction.items.length <= fixture.maxItems, `${fixture.name} too many items`);
    }

    const number = docNumber(applied);
    if (fixture.docNumber instanceof RegExp) assert.match(number ?? '', fixture.docNumber);
    else assert.equal(number, fixture.docNumber);
    if ('customer' in fixture && fixture.customer) assert.match(applied.customerName ?? '', fixture.customer);
    if ('total' in fixture && fixture.total !== undefined) assert.equal(applied.total, fixture.total);
    if ('net' in fixture && fixture.net !== undefined) assert.equal(applied.subtotal, fixture.net);
    if ('vat' in fixture && fixture.vat !== undefined) assert.equal(applied.vatAmount, fixture.vat);

    assert.ok(structuredMs < (inputs.length <= 1 ? 10_000 : 15_000));
    assert.ok(layoutMs < 3_000, `${fixture.name} layout classify too slow: ${layoutMs}ms`);
  });
}

test('Tecnoforniture: 3 consecutive full-path runs (cold/warm stability)', async () => {
  const doc = loadDoc('b82a4053');
  const inputs = layoutInputs(doc);
  for (let run = 1; run <= 3; run += 1) {
    const started = Date.now();
    const extraction = await extractStructuredDocumentAsync(
      doc.type as StructuredDocumentType,
      inputs,
      { processDeadline: createScanProcessDeadline(inputs.length), yieldEvery: 8 },
    );
    const structuredMs = Date.now() - started;
    const timedOut = extraction.reasons.includes('structured_process_timeout');
    console.warn(`[TecnofornitureRun${run}] ${JSON.stringify({
      run,
      structuredMs,
      items: extraction.items.length,
      complete: extraction.complete,
      timeout: timedOut,
      fallback: timedOut,
      itemRows: extraction.items.map((item, index) => ({
        index,
        code: item.itemCode?.normalizedValue,
        description: item.description?.normalizedValue?.slice(0, 48),
        qty: item.quantity?.normalizedValue,
        unitPrice: item.unitPrice?.normalizedValue,
        lineTotal: item.lineTotal?.normalizedValue,
        sourceLineIds: item.sourceLineIds,
      })),
    })}`);
    assert.equal(timedOut, false, `run ${run} timeout`);
    assert.ok(extraction.items.length > 0, `run ${run} items`);
    assert.ok(structuredMs <= 10_000, `run ${run} structuredMs=${structuredMs}`);
  }
});

test('fixture vs device discrepancy: simplified boxes bypassed real classify cost', () => {
  const boundsTest = fs.readFileSync(
    path.join(process.cwd(), 'tests', 'document-layout-runtime-bounds.test.ts'),
    'utf8',
  );
  const matrixTest = fs.readFileSync(
    path.join(process.cwd(), 'tests', 'qa-structured-fixture-matrix.test.ts'),
    'utf8',
  );
  assert.match(boundsTest, /boundingBox: \{ x: 80 \+ \(i % 4\) \* 90/);
  assert.match(matrixTest, /qa-export-2026-08-08-real-full/);
});

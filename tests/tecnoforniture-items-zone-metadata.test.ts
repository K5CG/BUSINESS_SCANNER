import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { InvoiceDocument, OrderDocument, QuoteDocument, OcrLine } from '../types';
import type { DocumentLayoutPageInput } from '../lib/document-layout';
import { classifyDocumentLayoutPagesAsync } from '../lib/document-layout';
import { extractStructuredDocumentAsync, applyStructuredExtractionToDocument } from '../lib/document-structured-extraction';
import type { StructuredDocumentType } from '../lib/document-structure';
import { createScanProcessDeadline } from '../lib/scan-process-deadline';

type QaDocument = QuoteDocument | OrderDocument | InvoiceDocument;

const qaRoot = path.join(process.cwd(), 'test-data', 'qa-export-2026-08-08-real-full');

function loadTecnoforniture(): QaDocument {
  const documents = JSON.parse(fs.readFileSync(path.join(qaRoot, 'documents.json'), 'utf8')) as QaDocument[];
  const document = documents.find((entry) => entry.id.startsWith('b82a4053'));
  assert.ok(document, 'Tecnoforniture fixture');
  return document;
}

function inputsFrom(document: QaDocument): DocumentLayoutPageInput[] {
  return (document.structuredExtraction?.pages ?? []).map((page) => ({
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

test('Tecnoforniture consumes its items_table zone without timeout', async () => {
  const document = loadTecnoforniture();
  const inputs = inputsFrom(document);
  const deadline = createScanProcessDeadline(inputs.length);
  const pages = await classifyDocumentLayoutPagesAsync(inputs, { processDeadline: deadline, yieldEvery: 8 });
  const tableZones = pages.flatMap((page) => page.zones.filter((zone) => zone.classification === 'items_table'));
  assert.ok(tableZones.length > 0, 'items_table zone');
  assert.ok(tableZones.some((zone) => zone.lineIds.length > 0), 'items_table lines');

  for (let run = 1; run <= 3; run += 1) {
    const started = Date.now();
    const extraction = await extractStructuredDocumentAsync(
      document.type as StructuredDocumentType,
      inputs,
      { processDeadline: createScanProcessDeadline(inputs.length), yieldEvery: 8 },
    );
    const applied = applyStructuredExtractionToDocument(
      { ...document, items: document.items ?? [] },
      extraction,
      { mode: 'new_scan' },
    ) as QaDocument;
    const rows = extraction.items.map((item) => ({
      article: item.itemCode?.normalizedValue,
      description: item.description?.normalizedValue,
      quantity: item.quantity?.normalizedValue,
      unitPrice: item.unitPrice?.normalizedValue,
      discount: item.discount?.normalizedValue,
      vat: item.vatRate?.normalizedValue,
      lineTotal: item.lineTotal?.normalizedValue,
      requiresReview: item.requiresReview,
    }));

    console.warn(`[TecnofornitureZoneRun${run}] ${JSON.stringify({
      structuredMs: Date.now() - started,
      items: extraction.items.length,
      documentNumber: extraction.metadata.documentNumber?.normalizedValue,
      total: applied.total,
      complete: extraction.complete,
      timeout: extraction.reasons.includes('structured_process_timeout'),
    })}`);
    console.warn(`[TecnofornitureRowsRun${run}] ${JSON.stringify(rows)}`);
    assert.equal(extraction.reasons.includes('structured_process_timeout'), false);
    assert.equal(extraction.items.length, 6);
    assert.equal((applied as QaDocument & { items: unknown[] }).items.length, 6);
    assert.equal(extraction.metadata.documentNumber?.normalizedValue, 'PV/2025/0478');
    assert.equal(applied.type === 'quote' ? applied.quoteNumber : undefined, 'PV/2025/0478');
    assert.equal(applied.total, 540.86);
    const bearing = rows.find((row) => row.article === 'CUSC-6205-2RS');
    assert.deepEqual(
      { quantity: bearing?.quantity, unitPrice: bearing?.unitPrice, discount: bearing?.discount, vat: bearing?.vat, lineTotal: bearing?.lineTotal },
      { quantity: 20, unitPrice: 6.8, discount: 5, vat: 22, lineTotal: 129.2 },
    );
    const coupling = rows.find((row) => row.article?.startsWith('GIUNTO-ELAST-ROTEX-24'));
    assert.deepEqual(
      { vat: coupling?.vat, lineTotal: coupling?.lineTotal },
      { vat: 10, lineTotal: 180.5 },
    );
    const partial = { ...extraction, reasons: [...extraction.reasons, 'structured_process_timeout'] };
    const preserved = applyStructuredExtractionToDocument(
      { ...document, items: [] },
      partial,
      { mode: 'new_scan' },
    ) as QaDocument;
    assert.equal(preserved.items.length, 6);
  }
});

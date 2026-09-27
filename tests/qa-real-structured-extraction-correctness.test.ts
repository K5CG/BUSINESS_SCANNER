import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { InvoiceDocument, OrderDocument, QuoteDocument } from '../types';
import type { DocumentLayoutPageInput } from '../lib/document-layout';
import type { StructuredDocumentType } from '../lib/document-structure';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocument,
} from '../lib/document-structured-extraction';

type QaDoc = QuoteDocument | OrderDocument | InvoiceDocument;
type ResultClass = 'PASS' | 'REVIEW' | 'FAIL';

interface FieldExpectation {
  field: string;
  expected: string | number | RegExp | undefined;
  actual: unknown;
  result: ResultClass;
}

const UPSIDE_DOWN = new Set(['9cb5aef5', '2adb6bb0', 'a13fa9a4']);

const GATE_DOCS: Record<string, {
  documentType?: string;
  documentNumber?: string | RegExp;
  issuer?: RegExp;
  customer?: RegExp;
  minItems?: number;
  total?: number;
  vat?: number;
  currency?: string;
}> = {
  '21359f33': {
    documentType: 'quote',
    documentNumber: 'DEV-2025-0612',
    customer: /Domaine Viticole des Hautes Collines/i,
    minItems: 15,
    total: 47578.8,
    vat: 7929.8,
    currency: 'EUR',
  },
  '7b8fc549': {
    documentType: 'quote',
    documentNumber: 'PRES-2025.0478',
    customer: /Comunidad Residencial Mirador del Mar/i,
    minItems: 5,
    currency: 'EUR',
  },
  '960e93ce': {
    documentType: 'invoice',
    documentNumber: /AN-2025(?:-0457)?/i,
    minItems: 4,
    total: 2122.37,
    currency: 'EUR',
  },
  '28ff5440': {
    documentType: 'quote',
    documentNumber: /OTN-26-0527/i,
    minItems: 4,
    total: 27261,
    currency: 'GBP',
  },
  'f7938d5e': {
    documentType: 'order',
    documentNumber: 'OC-2025-0547',
    minItems: 5,
    total: 206790,
    vat: 37290,
    currency: 'EUR',
  },
  'b82a4053': {
    documentType: 'quote',
    documentNumber: 'PV/2025/0478',
    customer: /Officine Maraldi/i,
    minItems: 6,
    total: 540.86,
    vat: 79.78,
    currency: 'EUR',
  },
};

function loadDocs(): QaDoc[] {
  return (JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'test-data/qa-export-2026-08-08-real/documents.json'), 'utf8'),
  ) as QaDoc[]).filter((doc) => String(doc.createdAt).startsWith('2026-08-08'));
}

function layoutInputs(doc: QaDoc): DocumentLayoutPageInput[] {
  return (doc.structuredExtraction?.pages ?? []).map((page) => ({
    pageIndex: page.pageIndex,
    lines: page.lines.map((line) => ({
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

function docNumber(doc: QaDoc): string | undefined {
  if (doc.type === 'quote') return doc.quoteNumber;
  if (doc.type === 'order') return doc.orderNumber;
  return doc.invoiceNumber;
}

function classify(actual: unknown, expected: unknown): ResultClass {
  if (expected === undefined) return actual === undefined || actual === '' ? 'PASS' : 'REVIEW';
  if (expected instanceof RegExp) return expected.test(String(actual ?? '')) ? 'PASS' : 'FAIL';
  if (typeof expected === 'number') {
    const value = Number(actual);
    return Number.isFinite(value) && Math.abs(value - expected) <= 0.02 ? 'PASS' : 'FAIL';
  }
  return String(actual ?? '') === expected ? 'PASS' : 'FAIL';
}

function evaluateDoc(doc: QaDoc): FieldExpectation[] {
  const extraction = extractStructuredDocument(doc.type as StructuredDocumentType, layoutInputs(doc));
  const applied = applyStructuredExtractionToDocument({ ...doc, items: doc.items ?? [] }, extraction, { mode: 'new_scan' }) as QaDoc;
  const prefix = doc.id.slice(0, 8);
  const spec = GATE_DOCS[prefix];
  if (!spec) return [];

  const rows: FieldExpectation[] = [
    { field: 'documentType', expected: spec.documentType, actual: applied.type, result: classify(applied.type, spec.documentType) },
    { field: 'documentNumber', expected: spec.documentNumber, actual: docNumber(applied), result: classify(docNumber(applied), spec.documentNumber) },
    { field: 'issuer', expected: spec.issuer, actual: extraction.issuer?.name?.normalizedValue, result: classify(extraction.issuer?.name?.normalizedValue, spec.issuer) },
    { field: 'customer', expected: spec.customer, actual: applied.customerName, result: classify(applied.customerName, spec.customer) },
    { field: 'item count', expected: spec.minItems, actual: applied.items?.length ?? 0, result: (applied.items?.length ?? 0) >= (spec.minItems ?? 0) ? 'PASS' : 'FAIL' },
    { field: 'total', expected: spec.total, actual: applied.total, result: classify(applied.total, spec.total) },
    { field: 'VAT', expected: spec.vat, actual: applied.vatAmount, result: classify(applied.vatAmount, spec.vat) },
    { field: 'currency', expected: spec.currency, actual: applied.currency, result: classify(applied.currency, spec.currency) },
  ];
  return rows;
}

for (const [prefix, spec] of Object.entries(GATE_DOCS)) {
  test(`correctness gate ${prefix}`, () => {
    const doc = loadDocs().find((entry) => entry.id.startsWith(prefix));
    assert.ok(doc, prefix);
    const rows = evaluateDoc(doc!);
    const fails = rows.filter((row) => row.result === 'FAIL');
    console.table(rows.map((row) => ({
      FIELD: row.field,
      EXPECTED: String(row.expected ?? ''),
      ACTUAL: String(row.actual ?? ''),
      RESULT: row.result,
    })));
    assert.equal(fails.length, 0, `${prefix} correctness failures: ${fails.map((f) => f.field).join(', ')}`);
  });
}

test('upside-down fixtures excluded from gate specs', () => {
  for (const prefix of UPSIDE_DOWN) {
    assert.equal(GATE_DOCS[prefix], undefined, `${prefix} must not be in gate`);
  }
});

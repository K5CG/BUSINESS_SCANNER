import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { AnyDocument, OcrLine, OrderDocument, QuoteDocument } from '../types';
import type { DocumentLayoutPageInput } from '../lib/document-layout';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocument,
} from '../lib/document-structured-extraction';
import { isDocumentTypeHeaderText } from '../lib/ocr-normalize';

const QA_ROOT = path.join(process.cwd(), 'test-data/qa-four-2026-08-14');

function loadDocs(): AnyDocument[] {
  return JSON.parse(fs.readFileSync(path.join(QA_ROOT, 'documents.json'), 'utf8')) as AnyDocument[];
}

function layoutInputs(doc: AnyDocument): DocumentLayoutPageInput[] {
  return (doc.structuredExtraction?.pages ?? []).map((page) => ({
    pageIndex: page.pageIndex,
    width: page.width,
    height: page.height,
    rawText: page.lines.map((line) => line.text).join('\n'),
    lines: page.lines.map((line): OcrLine => ({
      text: line.text,
      confidence: 0.9,
      ...(line.boundingBox ? { boundingBox: line.boundingBox } : {}),
    })),
  }));
}

function applyDoc(doc: AnyDocument) {
  const documentType = doc.type === 'business_card' ? 'free_document' : doc.type;
  const extraction = extractStructuredDocument(documentType, layoutInputs(doc));
  return {
    extraction,
    applied: applyStructuredExtractionToDocument(
      { ...doc, items: [], subtotal: undefined, vatAmount: undefined, total: undefined } as AnyDocument,
      extraction,
      { mode: 'new_scan' },
    ),
  };
}

function close(actual: number | undefined, expected: number, tol = 0.05): void {
  assert.ok(actual !== undefined, `expected ${expected}, got undefined`);
  assert.ok(Math.abs(actual! - expected) <= tol, `expected ${expected}, got ${actual}`);
}

test('Baltic OC-2025-0547 maps VAT amount to VAT, not subtotal', () => {
  const doc = loadDocs().find((entry) => /OC-2025-0547/i.test(String(entry.title ?? '')));
  assert.ok(doc);
  const { applied } = applyDoc(doc!);
  const order = applied as OrderDocument;
  close(order.subtotal, 169500, 1);
  close(order.vatAmount, 37290, 1);
  close(order.total, 206790, 1);
  assert.notEqual(order.subtotal, 37290);
  assert.ok((order.items?.length ?? 0) >= 6);
  assert.equal(order.structuredExtraction?.complete, true);
  assert.equal(order.structuredExtraction?.requiresReview, true);
});

test('O-00 does not persist CONFERMA ORDINE and recovers commercial rows', () => {
  const doc = loadDocs().find((entry) => /O-00/i.test(String(entry.title ?? '')) && entry.type === 'order');
  assert.ok(doc);
  const { applied } = applyDoc(doc!);
  const order = applied as OrderDocument;
  assert.ok(!order.customerName || !isDocumentTypeHeaderText(order.customerName));
  assert.notEqual((order.customerName ?? '').trim().toUpperCase(), 'CONFERMA ORDINE');
  assert.ok((order.items?.length ?? 0) >= 3, `expected commercial rows, got ${order.items?.length ?? 0}`);
  close(order.subtotal, 557.95);
  close(order.vatAmount, 122.75);
  close(order.total, 680.7);
  assert.ok(order.structuredExtraction?.reasons.includes('zero_items_with_table') === false
    || (order.items?.length ?? 0) > 0);
});

test('812/Z recovers distinct workshop rows without inventing the total', () => {
  const doc = loadDocs().find((entry) => /812\/Z/i.test(String(entry.title ?? '')));
  assert.ok(doc);
  const { applied } = applyDoc(doc!);
  const quote = applied as QuoteDocument;
  close(quote.total, 1400, 0.05);
  const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
  const descriptions = (quote.items ?? []).map((item) => fold(item.description));
  const expected = [
    /TENDICINGHIA/,
    /WATER\s*PUMP/,
    /CINGHIE/,
    /SCATOLA\s+STERZO/,
    /TESTINE/,
    /ANTIGELO/,
    /CONVERGENZA/,
    /MANODOPERA/,
    /SMALTIMENTO/,
    /CONSUMO/,
  ];
  for (const pattern of expected) {
    assert.ok(descriptions.some((text) => pattern.test(text)), `missing ${pattern} in ${descriptions.join(' | ')}`);
  }
  assert.ok(!descriptions.some((text) => /SCATOLA/.test(text) && /CINGHIE/.test(text)));
  assert.ok(!descriptions.some((text) => /CONVERGENZA/.test(text) && /ANTIGELO/.test(text)));
  assert.ok(!descriptions.some((text) => /SMALTIMENTO/.test(text) && /CONSUMO/.test(text)));
  const lineSum = (quote.items ?? []).reduce((sum, item) => sum + item.total, 0);
  assert.ok(Math.abs(lineSum - 1400) < 2, `line sum ${lineSum}`);
  assert.ok((quote.items?.length ?? 0) >= 9);
});

test('DEV-2025-0612 keeps labeled HT/TVA/TTC and does not treat 5% as unit price', () => {
  const doc = loadDocs().find((entry) => /DEV-2025-0612/i.test(String(entry.title ?? '')));
  assert.ok(doc);
  const { applied, extraction } = applyDoc(doc!);
  const quote = applied as QuoteDocument;
  close(quote.subtotal, 39649, 1);
  close(quote.vatAmount, 7929.8, 0.5);
  close(quote.total, 47578.8, 0.5);
  const first = quote.items?.[0];
  assert.ok(first);
  assert.notEqual(first!.unitPrice, 5);
  assert.notEqual(first!.total, 10);
  const discounted = extraction.items.filter((item) => item.discount?.normalizedValue === 5);
  assert.ok(discounted.length >= 8, `expected persisted structured discounts, got ${discounted.length}`);
  assert.ok(
    (quote.items ?? []).some((item) => item.discount === 5),
    'discount must survive canonical persistence',
  );
});

test('saved documents without discount remain valid after optional-field persist', () => {
  const docs = loadDocs();
  for (const doc of docs) {
    const { applied } = applyDoc(doc);
    const items = (applied as QuoteDocument | OrderDocument).items ?? [];
    for (const [index, item] of items.entries()) {
  console.log('[ITEM_CHECK]', {
    title: doc.title,
    type: doc.type,
    index,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    total: item.total,
    discount: item.discount,
  });

  assert.equal('description' in item, true);

assert.ok(
  item.quantity === undefined || Number.isFinite(item.quantity),
  `invalid quantity in ${doc.title}: ${String(item.quantity)}`,
);

assert.ok(
  item.unitPrice === undefined || Number.isFinite(item.unitPrice),
  `invalid unitPrice in ${doc.title}: ${String(item.unitPrice)}`,
);

assert.ok(
  item.total === undefined || Number.isFinite(item.total),
  `invalid total in ${doc.title}: ${String(item.total)}`,
);

assert.ok(
  item.discount === undefined || Number.isFinite(item.discount),
);
 }
  }
  const legacy: {
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
  discount?: number;
} = {
  description: 'Legacy row',
  quantity: 1,
  unitPrice: 10,
  total: 10,
};
  assert.equal(legacy.discount, undefined);
});

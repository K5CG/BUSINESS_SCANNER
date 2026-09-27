import fs from 'node:fs';
import path from 'node:path';
import type { InvoiceDocument, OrderDocument, QuoteDocument } from '../types';
import type { DocumentLayoutPageInput } from '../lib/document-layout';
import type { StructuredDocumentType } from '../lib/document-structure';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocument,
} from '../lib/document-structured-extraction';

type QaDoc = QuoteDocument | OrderDocument | InvoiceDocument;

const UPSIDE_DOWN = new Set(['9cb5aef5', '2adb6bb0', 'a13fa9a4']);

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

function run(doc: QaDoc) {
  const extraction = extractStructuredDocument(doc.type as StructuredDocumentType, layoutInputs(doc));
  const applied = applyStructuredExtractionToDocument(
    { ...doc, items: doc.items ?? [] },
    extraction,
    { mode: 'new_scan' },
  ) as QaDoc;
  const prefix = doc.id.slice(0, 8);
  return {
    id: prefix,
    upsideDown: UPSIDE_DOWN.has(prefix),
    items: applied.items?.length ?? 0,
    number: doc.type === 'quote'
      ? (applied as QuoteDocument).quoteNumber
      : doc.type === 'order'
        ? (applied as OrderDocument).orderNumber
        : (applied as InvoiceDocument).invoiceNumber,
    customer: applied.customerName,
    total: applied.total,
    vat: applied.vatAmount,
    currency: applied.currency,
    pages: extraction.pages.length,
    structuredItems: extraction.items.length,
  };
}

for (const doc of loadDocs()) {
  console.log(JSON.stringify(run(doc)));
}

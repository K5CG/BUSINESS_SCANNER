/**
 * Read-only audit of the 4 real QA documents from
 * qa-documents-export_all_2026-08-14T17-44-51-489Z.
 * Does not modify production parser code.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AnyDocument, OcrLine } from '../types';
import { classifyDocumentLayoutPages, type DocumentLayoutPageInput } from '../lib/document-layout';
import { extractDocumentItemsAndTotals, parseDocumentAmount } from '../lib/document-items-totals';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocument,
} from '../lib/document-structured-extraction';
import { isDocumentTypeHeaderText } from '../lib/ocr-normalize';

const ROOT = path.join(process.cwd(), '.tmp-qa/qa-export-2026-08-14-1744');
const docs = JSON.parse(fs.readFileSync(path.join(ROOT, 'documents.json'), 'utf8')) as AnyDocument[];

function ev<T>(evidence: { normalizedValue?: T; rawValue?: unknown; reasons?: string[] } | undefined) {
  if (!evidence) return undefined;
  return {
    value: evidence.normalizedValue,
    raw: evidence.rawValue,
    reasons: evidence.reasons ?? [],
  };
}

function layoutInputsFromStored(doc: AnyDocument): DocumentLayoutPageInput[] {
  const pages = doc.structuredExtraction?.pages ?? [];
  if (pages.length === 0) {
    const raw = doc.rawText ?? '';
    const lines = raw.split(/\n/).map((text, lineIndex) => ({
      text,
      confidence: 0.9,
      lineIndex,
    }));
    return [{ pageIndex: 0, lines, rawText: raw }];
  }
  return pages.map((page) => ({
    pageIndex: page.pageIndex,
    width: page.width,
    height: page.height,
    rawText: page.lines.map((line) => line.text).join('\n'),
    lines: page.lines.map((line, lineIndex): OcrLine => ({
      text: line.text,
      confidence: line.confidence ?? 0.9,
      lineIndex,
      ...(line.boundingBox ? { boundingBox: line.boundingBox } : {}),
      ...(line.elements ? { elements: line.elements } : {}),
    })),
  }));
}

function commercialHeuristic(lines: Array<{ text: string; boundingBox?: { x: number; y: number; width: number; height: number } }>) {
  const descLike = /[A-Za-zÀ-ÿ]{4,}/;
  const headerLike = /^(?:descrizione|articolo|udm|qt[aà]|quantit[aà]|prezzo|sconto|iva|importo|totale|description|qty|quantity|unit\s*price|discount|vat|amount|total|désignation|qt[eé]|prix|remise|tva|montant)$/i;
  const footerLike = /^(?:imponibile|subtotale|totale(?:\s+(?:documento|iva|imposta))?|iva(?:\s+\d+)?|vat|grand\s+total)$/i;
  const udm = /^(?:nr|n\.?r\.?|pz|pcs|kg|m|ml|lt|cad|n)$/i;
  const withBox = lines.filter((line) => line.boundingBox);
  const bands = new Map<number, typeof lines>();
  for (const line of withBox) {
    const y = Math.round((line.boundingBox!.y + line.boundingBox!.height / 2) / 18) * 18;
    const bucket = bands.get(y) ?? [];
    bucket.push(line);
    bands.set(y, bucket);
  }
  const rows: Array<{ y: number; texts: string[]; hasDesc: boolean; hasNumeric: boolean; hasUdm: boolean }> = [];
  for (const [y, group] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
    const texts = group.map((entry) => entry.text.trim()).filter(Boolean);
    if (texts.length === 0) continue;
    if (texts.every((text) => headerLike.test(text) || footerLike.test(text))) continue;
    const joined = texts.join(' ');
    if (footerLike.test(joined) && !descLike.test(joined.replace(footerLike, ''))) continue;
    const hasDesc = texts.some((text) => descLike.test(text) && !headerLike.test(text) && !/^\d/.test(text));
    const hasNumeric = texts.some((text) => parseDocumentAmount(text) !== undefined || /\d+[.,]\d{2}/.test(text));
    const hasUdm = texts.some((text) => udm.test(text));
    if (hasDesc && (hasNumeric || hasUdm)) {
      rows.push({ y, texts, hasDesc, hasNumeric, hasUdm });
    }
  }
  return rows;
}

function itemBrief(item: {
  description?: { normalizedValue?: string };
  quantity?: { normalizedValue?: number };
  unitPrice?: { normalizedValue?: number };
  lineTotal?: { normalizedValue?: number };
  discount?: { normalizedValue?: number };
  vatRate?: { normalizedValue?: number };
  sourceLines?: string[];
}) {
  return {
    description: item.description?.normalizedValue,
    qty: item.quantity?.normalizedValue,
    unitPrice: item.unitPrice?.normalizedValue,
    lineTotal: item.lineTotal?.normalizedValue,
    discount: item.discount?.normalizedValue,
    vatRate: item.vatRate?.normalizedValue,
    sourceLines: item.sourceLines?.slice(0, 12),
  };
}

const reports = docs.map((doc) => {
  const persistedItems = 'items' in doc ? (doc.items ?? []) : [];
  const storedPages = doc.structuredExtraction?.pages ?? [];
  const storedLines = storedPages.flatMap((page) => page.lines);
  const boxed = storedLines.filter((line) => line.boundingBox).length;
  const inputs = layoutInputsFromStored(doc);
  const layoutPages = classifyDocumentLayoutPages(inputs);
  const itemsTotals = extractDocumentItemsAndTotals(layoutPages);
  const extraction = extractStructuredDocument(doc.type === 'free_document' ? 'free_document' : doc.type, inputs);
  const applied = applyStructuredExtractionToDocument(
    { ...doc, items: [], subtotal: undefined, vatAmount: undefined, total: undefined } as AnyDocument,
    extraction,
    { mode: 'new_scan' },
  );
  const appliedItems = 'items' in applied ? (applied.items ?? []) : [];
  const appliedLineSum = appliedItems.reduce((sum, item) => sum + (item.total ?? 0), 0);
  const persistedLineSum = persistedItems.reduce((sum, item) => sum + (item.total ?? 0), 0);
  const ocrRows = commercialHeuristic(storedLines);
  const zones = layoutPages.flatMap((page) =>
    page.zones.map((zone) => ({ page: page.pageIndex, class: zone.classification, lines: zone.lineIds.length })),
  );
  const summaryLabels = storedLines
    .filter((line) => /\b(?:imponibile|subtotale|subtotal|iva|vat|tva|totale|total|taxable|ht|ttc)\b/i.test(line.text))
    .map((line) => ({
      text: line.text,
      y: line.boundingBox?.y,
      x: line.boundingBox?.x,
      amount: parseDocumentAmount(line.text),
    }));
  const appliedCustomer = 'customerName' in applied ? applied.customerName : undefined;
  return {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    persisted: {
      documentNumber: 'quoteNumber' in doc ? doc.quoteNumber : 'orderNumber' in doc ? doc.orderNumber : undefined,
      customerName: 'customerName' in doc ? doc.customerName : undefined,
      date: 'quoteDate' in doc ? doc.quoteDate : 'orderDate' in doc ? doc.orderDate : undefined,
      itemCount: persistedItems.length,
      items: persistedItems.map((item) => ({
        description: item.description,
        qty: item.quantity,
        unitPrice: item.unitPrice,
        total: item.total,
        vatRate: item.vatRate,
        discount: 'discount' in item ? item.discount : undefined,
      })),
      subtotal: 'subtotal' in doc ? doc.subtotal : undefined,
      vatAmount: 'vatAmount' in doc ? doc.vatAmount : undefined,
      total: 'total' in doc ? doc.total : undefined,
      currency: 'currency' in doc ? doc.currency : undefined,
      lineSum: Math.round(persistedLineSum * 100) / 100,
      structuredComplete: doc.structuredExtraction?.complete,
      structuredRequiresReview: doc.structuredExtraction?.requiresReview,
      structuredReasons: doc.structuredExtraction?.reasons,
      storedStructuredItems: doc.structuredExtraction?.items?.length,
      storedStructuredTotals: {
        subtotal: ev(doc.structuredExtraction?.summary?.subtotal),
        vatAmount: ev(doc.structuredExtraction?.summary?.vatAmount),
        total: ev(doc.structuredExtraction?.summary?.total),
      },
      storedCustomer: ev(doc.structuredExtraction?.customer?.name),
      storedDiscounts: (doc.structuredExtraction?.items ?? [])
        .filter((item) => item.discount?.normalizedValue !== undefined)
        .map((item) => ({
          description: item.description?.normalizedValue,
          discount: item.discount?.normalizedValue,
        })),
    },
    geometry: {
      pages: storedPages.length,
      lines: storedLines.length,
      boxed,
      width: storedPages[0]?.width,
      height: storedPages[0]?.height,
      zones,
    },
    ocrCommercialRows: ocrRows.length,
    ocrCommercialSample: ocrRows.map((row) => row.texts.join(' | ')),
    summaryLabels,
    replay: {
      layoutTimeout: layoutPages.flatMap((page) => page.reasons),
      itemsTotalsCount: itemsTotals.items.length,
      itemsTotalsReasons: itemsTotals.reasons,
      itemsTotalsReview: itemsTotals.requiresReview,
      itemsTotalsSummary: {
        subtotal: ev(itemsTotals.summary.subtotal),
        vatAmount: ev(itemsTotals.summary.vatAmount),
        total: ev(itemsTotals.summary.total),
        currency: ev(itemsTotals.summary.currency),
      },
      itemsTotals: itemsTotals.items.map(itemBrief),
      extractionItems: extraction.items.length,
      extractionSummary: {
        subtotal: ev(extraction.summary.subtotal),
        vatAmount: ev(extraction.summary.vatAmount),
        total: ev(extraction.summary.total),
      },
      extractionCustomer: ev(extraction.customer?.name),
      extractionRecipient: ev(extraction.recipient?.name),
      extractionReasons: extraction.reasons,
      extractionComplete: extraction.complete,
      extractionRequiresReview: extraction.requiresReview,
      extractionDiscounts: extraction.items
        .filter((item) => item.discount?.normalizedValue !== undefined)
        .map((item) => ({
          description: item.description?.normalizedValue,
          discount: item.discount?.normalizedValue,
        })),
      applied: {
        customerName: appliedCustomer,
        customerIsHeader: appliedCustomer ? isDocumentTypeHeaderText(appliedCustomer) : false,
        itemCount: appliedItems.length,
        items: appliedItems,
        subtotal: 'subtotal' in applied ? applied.subtotal : undefined,
        vatAmount: 'vatAmount' in applied ? applied.vatAmount : undefined,
        total: 'total' in applied ? applied.total : undefined,
        lineSum: Math.round(appliedLineSum * 100) / 100,
        reasons: applied.structuredExtraction?.reasons,
        complete: applied.structuredExtraction?.complete,
        requiresReview: applied.structuredExtraction?.requiresReview,
      },
    },
  };
});

const outDir = path.join(process.cwd(), '.tmp-qa');
fs.writeFileSync(path.join(outDir, 'p0-audit-four-qa.json'), JSON.stringify(reports, null, 2));

for (const report of reports) {
  console.log('\n========== ' + report.title + ' ==========');
  console.log(JSON.stringify({
    persisted: {
      customer: report.persisted.customerName,
      items: report.persisted.itemCount,
      subtotal: report.persisted.subtotal,
      vat: report.persisted.vatAmount,
      total: report.persisted.total,
      lineSum: report.persisted.lineSum,
      complete: report.persisted.structuredComplete,
      review: report.persisted.structuredRequiresReview,
      reasons: report.persisted.structuredReasons,
      discounts: report.persisted.storedDiscounts,
    },
    geometry: report.geometry,
    ocrCommercialRows: report.ocrCommercialRows,
    replay: {
      itemsTotals: report.replay.itemsTotalsCount,
      extractionItems: report.replay.extractionItems,
      appliedItems: report.replay.applied.itemCount,
      appliedCustomer: report.replay.applied.customerName,
      appliedTotals: {
        subtotal: report.replay.applied.subtotal,
        vat: report.replay.applied.vatAmount,
        total: report.replay.applied.total,
        lineSum: report.replay.applied.lineSum,
      },
      extractionTotals: report.replay.extractionSummary,
      itemsTotalsSummary: report.replay.itemsTotalsSummary,
      reasons: report.replay.extractionReasons,
      discounts: report.replay.extractionDiscounts,
    },
    ocrRows: report.ocrCommercialSample,
    persistedItems: report.persisted.items,
    replayItems: report.replay.applied.items,
    summaryLabels: report.summaryLabels,
  }, null, 2));
}

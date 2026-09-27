import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { FreeDocument, OcrLine, OrderDocument, QuoteDocument } from '../types';
import { extractStructuredDocument, applyStructuredExtractionToDocument, createScanDeferredStructuredExtraction } from '../lib/document-structured-extraction';

function cell(text: string, x: number, y: number, width = 120): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width, height: 22 } };
}

function input(lines: OcrLine[], pageIndex = 0, height = 1400) {
  return { pageIndex, width: 1000, height, lines, rawText: lines.map((line) => line.text).join('\n') };
}

function quoteBase(): QuoteDocument {
  return {
    id: 'q1', type: 'quote', title: 'Preventivo', images: ['page.jpg'], rawText: '', confidence: {},
    items: [], createdAt: new Date('2026-08-02T10:00:00Z'), updatedAt: new Date('2026-08-02T10:00:00Z'),
  };
}

test('pagina completa con header tabella e totale viene marcata complete', () => {
  const lines = [
    cell('ACME S.p.A.', 40, 50), cell('Preventivo n. P-1 Data 18/07/2026', 40, 220),
    cell('Descrizione', 180, 400), cell('Qta', 520, 400), cell('Prezzo', 680, 400), cell('Totale', 880, 400),
    cell('Servizio', 180, 460), cell('2', 520, 460), cell('20,00', 680, 460), cell('40,00', 880, 460),
    cell('Totale documento 40,00', 600, 1000),
  ];
  const extraction = extractStructuredDocument('quote', [input(lines)]);
  assert.equal(extraction.complete, true);
  assert.equal(extraction.pages[0].status, 'complete');
  assert.equal(extraction.requiresRescan, false);
});

test('fotografia della sola parte inferiore richiede nuova acquisizione', () => {
  const lines = [cell('Imponibile 100,00', 600, 900), cell('IVA 22,00', 600, 980), cell('Totale 122,00', 600, 1060)];
  const extraction = extractStructuredDocument('quote', [input(lines)]);
  assert.equal(extraction.pages[0].status, 'incomplete');
  assert.equal(extraction.requiresRescan, true);
  assert.ok(extraction.reasons.some((reason) => reason.includes('only_lower_document_section_visible')));
});

test('pagina vuota e pagina tagliata non inventano campi', () => {
  const empty = extractStructuredDocument('quote', [input([])]);
  const cropped = extractStructuredDocument('quote', [input([cell('Totale 10,00', 600, 900)], 0, 1000)]);
  assert.equal(empty.metadata.documentNumber, undefined);
  assert.equal(empty.summary.total, undefined);
  assert.equal(empty.requiresRescan, true);
  assert.equal(cropped.requiresRescan, true);
});

test('tabella rilevata senza righe supportate resta partial', () => {
  const lines = [cell('Preventivo n. P-1', 40, 200), cell('Descrizione Qta Prezzo Totale', 40, 400), cell('testo illeggibile', 40, 460), cell('Totale 10,00', 600, 1000)];
  const extraction = extractStructuredDocument('quote', [input(lines)]);
  assert.equal(extraction.pages[0].status, 'partial');
  assert.equal(extraction.items.length, 0);
});

test('multipagina conserva tutte le pagine e righe articolo', () => {
  const page1 = [cell('Preventivo n. P-1', 40, 180), cell('Descrizione', 180, 400), cell('Qta', 520, 400), cell('Prezzo', 680, 400), cell('Totale', 880, 400), cell('Uno', 180, 460), cell('1', 520, 460), cell('10,00', 680, 460), cell('10,00', 880, 460)];
  const page2 = [cell('Descrizione', 180, 120), cell('Qta', 520, 120), cell('Prezzo', 680, 120), cell('Totale', 880, 120), cell('Due', 180, 180), cell('2', 520, 180), cell('15,00', 680, 180), cell('30,00', 880, 180), cell('Totale documento 40,00', 600, 1000)];
  const extraction = extractStructuredDocument('quote', [input(page1, 0), input(page2, 1)]);
  assert.equal(extraction.pages.length, 2);
  assert.equal(extraction.items.length, 2);
  assert.deepEqual(extraction.items.map((item) => item.pageIndex), [0, 1]);
});

test('applicazione legacy valorizza soltanto evidenze complete e non sovrascrive dati esistenti', () => {
  const lines = [cell('Preventivo n. P-1 Data 18/07/2026', 40, 200), cell('Spett.le Cliente Uno S.r.l.', 40, 300), cell('Descrizione', 180, 400), cell('Qta', 520, 400), cell('Prezzo', 680, 400), cell('Totale', 880, 400), cell('Servizio', 180, 460), cell('2', 520, 460), cell('20,00', 680, 460), cell('40,00', 880, 460), cell('Totale documento 40,00 EUR', 600, 1000)];
  const extraction = extractStructuredDocument('quote', [input(lines)]);
  const applied = applyStructuredExtractionToDocument({ ...quoteBase(), quoteNumber: 'MANUALE' }, extraction);
  assert.equal(applied.quoteNumber, 'MANUALE');
  assert.equal(applied.customerName, 'Cliente Uno S.r.l.');
  assert.equal(applied.items.length, 1);
  assert.equal(applied.total, 40);
  assert.equal(applied.structuredExtraction?.schemaVersion, 1);
});

test('salvataggio e riapertura JSON conservano provenance e missing', () => {
  const extraction = extractStructuredDocument('free_document', [input([cell('Verbale riunione', 40, 200)])]);
  const source: FreeDocument = {
    id: 'f1', type: 'free_document', title: 'Verbale', images: ['p.jpg'], rawText: 'Verbale riunione',
    confidence: {}, extractedFields: {}, createdAt: new Date(), updatedAt: new Date(),
  };
  const applied = applyStructuredExtractionToDocument(source, extraction);
  const reopened = JSON.parse(JSON.stringify(applied)) as typeof applied;
  assert.equal(reopened.structuredExtraction?.pages[0].lines[0].id, 'p1-l1');
  assert.equal(reopened.structuredExtraction?.summary.total, undefined);
});

test('storage mantiene l intero payload del documento', () => {
  const storage = fs.readFileSync(path.join(process.cwd(), 'lib/storage.ts'), 'utf8');
  assert.match(storage, /serializeRecord\(document as unknown as Record<string, unknown>\)/);
  assert.match(storage, /reviveDocument\(JSON\.parse\(row\.data\)/);
});

test('scan deferred in merge mode non rilancia canonicalGeometryExtraction', () => {
  const lines = [
    cell('Preventivo n. P-99 Data 18/07/2026', 40, 200),
    cell('Spett.le Cliente Uno S.r.l.', 40, 300),
    cell('Totale documento 40,00 EUR', 600, 1000),
  ];
  const deferred = createScanDeferredStructuredExtraction([input(lines)]);
  const source: QuoteDocument = {
    ...quoteBase(),
    quoteNumber: 'P-99',
    customerName: 'Cliente Uno S.r.l.',
    total: 40,
  };
  const applied = applyStructuredExtractionToDocument(source, deferred, { mode: 'merge' });
  assert.equal(applied.quoteNumber, 'P-99');
  assert.equal(applied.customerName, 'Cliente Uno S.r.l.');
  assert.equal(applied.total, 40);
  assert.ok(applied.structuredExtraction?.reasons.includes('structured_extraction_deferred_on_scan'));
});

test('workflow locale esegue layout bounded durante Elabora', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), 'lib/scan-process-workflow.ts'), 'utf8');
  const layout = fs.readFileSync(path.join(process.cwd(), 'lib/document-layout.ts'), 'utf8');
  assert.match(workflow, /resolveStructuredExtractionForScan/);
  assert.match(workflow, /extractStructuredDocumentAsync/);
  assert.match(workflow, /logDocumentProcess\('page_results_start'\)/);
  assert.match(layout, /layoutDeadlineMs/);
  assert.match(layout, /structured_layout_timeout/);
  assert.match(workflow, /buildDocumentProcessingShell/);
  assert.doesNotMatch(workflow, /parseOrderDocument|parseQuoteDocument|parseInvoiceDocument/);
  assert.doesNotMatch(workflow, /createScanDeferredStructuredExtraction/);
  assert.doesNotMatch(workflow, /extractDocumentWithGemini|callSupabaseFunction/);
});

test('new scan ordine sostituisce i falsi positivi legacy con evidenza layout', () => {
  const lines = [
    cell('Ordine n. O-77 Data 18/07/2026', 40, 200),
    cell('Cliente: Beta S.r.l.', 40, 300),
    cell('Descrizione', 180, 400), cell('Qta', 520, 400), cell('Prezzo', 680, 400), cell('Totale', 880, 400),
    cell('Servizio', 180, 460), cell('2', 520, 460), cell('20,00', 680, 460), cell('40,00', 880, 460),
    cell('Totale documento 40,00 EUR', 600, 1000),
  ];
  const extraction = extractStructuredDocument('order', [input(lines)]);
  const source: OrderDocument = {
    id: 'o1', type: 'order', title: 'Ordine falso', images: ['p.jpg'], rawText: '', confidence: {},
    orderNumber: '34121', customerName: 'Via Roma', items: [], total: 20,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const applied = applyStructuredExtractionToDocument(source, extraction, { mode: 'new_scan' });
  assert.equal(applied.orderNumber, 'O-77');
  assert.equal(applied.customerName, 'Beta S.r.l.');
  assert.equal(applied.total, 40);
  assert.equal(applied.items.length, 1);
});

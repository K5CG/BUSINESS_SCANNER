import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard, QuoteDocument } from '../types';
import type { GeminiDocumentExtract } from '../lib/gemini-document-extract';
import { buildDocumentFromExtract } from '../lib/document-from-extract';
import {
  applyPdfStructuredParity,
  pdfLayoutInputsFromRawText,
  withoutCameraFramingSignals,
  PDF_TEXT_ONLY_REASON,
} from '../lib/pdf-structured-parity';

const PDF_TEXT = [
  'ACME SOFTWARE S.R.L.',
  'Via Roma 10, 36100 Vicenza (VI)',
  'PREVENTIVO',
  'Preventivo n. 2025/0042 del 06/02/2025',
  'Spett.le',
  'CIRA SCpA',
  'Via Maiorise, 81043 Capua (CE)',
  'Partita IVA 01908170614',
  'Descrizione Q.ta Prezzo Totale',
  'Manutenzione software 1 3.250,00 3.250,00',
  'Imponibile 3.250,00',
  'IVA 0,00',
  'Totale documento 3.250,00 EUR',
].join('\n');

function geminiExtract(overrides: Partial<GeminiDocumentExtract> = {}): GeminiDocumentExtract {
  return {
    rawText: PDF_TEXT,
    documentNumber: '2025/0042',
    customerName: 'CIRA SCpA',
    date: '2025-02-06',
    subtotal: 3250,
    vatAmount: 0,
    total: 3250,
    items: [
      { description: 'Manutenzione software', quantity: 1, unitPrice: 3250, total: 3250 },
    ],
    ...overrides,
  };
}

async function importedQuote(
  extract: GeminiDocumentExtract = geminiExtract()
): Promise<QuoteDocument> {
  const document = buildDocumentFromExtract('quote', extract) as QuoteDocument;
  return (await applyPdfStructuredParity(document, extract)) as QuoteDocument;
}

test('il testo del PDF diventa pagine senza coordinate inventate', () => {
  const inputs = pdfLayoutInputsFromRawText(PDF_TEXT);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].pageIndex, 0);
  assert.equal(inputs[0].width, undefined);
  assert.equal(inputs[0].height, undefined);
  assert.ok(inputs[0].lines.length > 5);
  for (const line of inputs[0].lines) {
    assert.equal(line.boundingBox, undefined);
    assert.equal(line.text, line.text.trim());
  }
});

test('un testo vuoto non produce pagine finte', () => {
  assert.deepEqual(pdfLayoutInputsFromRawText('   \n\n  '), []);
});

test('il documento importato riceve la struttura come uno scatto', async () => {
  const document = await importedQuote();
  assert.ok(document.structuredExtraction, 'structuredExtraction mancante');
  assert.ok(document.structuredExtraction!.pages.length > 0);
  assert.equal(document.structuredExtraction!.schemaVersion, 1);
});

test('immagini assenti non impediscono la struttura', async () => {
  const document = await importedQuote();
  assert.deepEqual(document.images, []);
  assert.ok(document.structuredExtraction);
});

test('i campi del servizio AI restano quelli salvati', async () => {
  const document = await importedQuote();
  assert.equal(document.quoteNumber, '2025/0042');
  assert.equal(document.customerName, 'CIRA SCpA');
});

test('gli articoli del servizio AI non vengono mai ridotti', async () => {
  const extract = geminiExtract();
  const before = buildDocumentFromExtract('quote', extract) as QuoteDocument;
  const after = await applyPdfStructuredParity(before, extract) as QuoteDocument;
  assert.ok(before.items.length > 0, 'il fixture deve avere articoli');
  assert.ok(after.items.length >= before.items.length);
  assert.equal(after.items[0].description, before.items[0].description);
});

test('un testo senza tabella riconoscibile non azzera gli articoli', async () => {
  const extract = geminiExtract({ rawText: 'PREVENTIVO\nDocumento inviato via email\nGrazie' });
  const before = buildDocumentFromExtract('quote', extract) as QuoteDocument;
  const after = await applyPdfStructuredParity(before, extract) as QuoteDocument;
  assert.equal(after.items.length, before.items.length);
  assert.equal(after.items[0].description, 'Manutenzione software');
});

test('i totali del servizio AI non vengono sovrascritti', async () => {
  const document = await importedQuote();
  assert.equal(document.subtotal, 3250);
  assert.equal(document.vatAmount, 0);
  assert.equal(document.total, 3250);
});

test('la passata locale aggiunge la partita IVA, che il servizio non restituisce', async () => {
  const extract = geminiExtract();
  const before = buildDocumentFromExtract('quote', extract) as QuoteDocument;
  assert.equal(before.customerVat, undefined, 'il percorso AI non compila questo campo');
  const after = await applyPdfStructuredParity(before, extract) as QuoteDocument;
  assert.equal(after.customerVat, '01908170614');
});

test('un PDF non chiede mai una nuova acquisizione', async () => {
  const poor = geminiExtract({
    rawText: 'Imponibile 100,00\nIVA 22,00\nTotale 122,00',
    items: [],
    documentNumber: undefined,
  });
  const document = await importedQuote(poor);
  assert.equal(document.structuredExtraction!.requiresRescan, false);
  for (const page of document.structuredExtraction!.pages) {
    assert.equal(page.requiresRescan, false);
    assert.notEqual(page.status, 'incomplete');
    assert.ok(!page.reasons.includes('only_lower_document_section_visible'));
    assert.ok(!page.reasons.includes('essential_sections_not_visible'));
  }
});

test('completezza e revisione sono presenti e motivate', async () => {
  const document = await importedQuote();
  const extraction = document.structuredExtraction!;
  assert.equal(typeof extraction.complete, 'boolean');
  assert.equal(typeof extraction.requiresReview, 'boolean');
  assert.ok(extraction.reasons.includes(PDF_TEXT_ONLY_REASON));
});

test('la neutralizzazione tocca solo i segnali di inquadratura', () => {
  const extraction = withoutCameraFramingSignals({
    schemaVersion: 1,
    metadata: {},
    items: [],
    summary: { taxSummaries: [], conflicts: [], requiresReview: false },
    conditions: {},
    pages: [
      {
        pageIndex: 0,
        lines: [],
        zones: [],
        status: 'incomplete',
        complete: false,
        requiresRescan: true,
        reasons: ['essential_sections_not_visible', 'document_total_missing'],
      },
    ],
    complete: false,
    requiresRescan: true,
    requiresReview: true,
    reasons: ['page_1:essential_sections_not_visible', 'page_1:document_total_missing'],
  });
  assert.equal(extraction.requiresRescan, false);
  assert.deepEqual(extraction.pages[0].reasons, ['document_total_missing']);
  assert.equal(extraction.pages[0].status, 'partial');
  assert.ok(extraction.reasons.includes('page_1:document_total_missing'));
  assert.ok(!extraction.reasons.includes('page_1:essential_sections_not_visible'));
  assert.equal(extraction.requiresReview, true);
});

test('il biglietto da visita resta fuori da questa passata', async () => {
  const card: BusinessCard = {
    id: 'c1',
    type: 'business_card',
    title: 'Mario Rossi',
    images: [],
    rawText: '',
    confidence: {},
    firstName: 'Mario',
    lastName: 'Rossi',
    role: '',
    company: '',
    emails: [],
    phones: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = await applyPdfStructuredParity(card, geminiExtract());
  assert.equal(result, card);
});

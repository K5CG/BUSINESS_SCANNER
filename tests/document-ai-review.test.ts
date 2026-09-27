import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AnyDocument,
  FreeDocument,
  QuoteDocument,
} from '../types';
import type { GeminiDocumentExtract } from '../lib/gemini-ocr';
import {
  mergeGeminiDocumentExtracts,
  runDocumentAiReview,
} from '../lib/document-ai-review';
import { scanPagesLocally } from '../lib/local-ocr-pages';

function extract(
  rawText: string,
  overrides: Partial<GeminiDocumentExtract> = {}
): GeminiDocumentExtract {
  return {
    rawText,
    documentNumber: '',
    customerName: '',
    date: '',
    subtotal: 0,
    vatAmount: 0,
    total: 0,
    items: [],
    ...overrides,
  };
}

function quoteDocument(images = ['page-1.jpg']): QuoteDocument {
  const createdAt = new Date('2026-07-20T10:00:00.000Z');
  const updatedAt = new Date('2026-07-21T10:00:00.000Z');
  return {
    id: 'local-document',
    type: 'quote',
    title: 'Preventivo locale',
    images,
    rawText: 'testo OCR locale',
    confidence: { total: 0.4 },
    createdAt,
    updatedAt,
    quoteNumber: 'LOCAL-1',
    quoteDate: new Date('2026-07-20T00:00:00.000Z'),
    customerName: 'Cliente locale',
    items: [],
    subtotal: 10,
    vatAmount: 2.2,
    total: 12.2,
    currency: 'EUR',
    notes: 'Nota da preservare',
  };
}

function rebuiltQuote(rawText: string): QuoteDocument {
  return {
    ...quoteDocument([]),
    id: 'generated-id',
    title: 'Preventivo AI',
    rawText,
    quoteNumber: 'AI-99',
    customerName: 'Cliente AI',
    total: 99,
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
    updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    notes: undefined,
  };
}

test('annullamento: zero estrazioni, zero parser e documento locale invariato', async () => {
  const local = quoteDocument();
  let extractionCalls = 0;
  let builderCalls = 0;

  const outcome = await runDocumentAiReview(
    'cancel',
    local,
    async () => {
      extractionCalls += 1;
      return { status: 'ok', extract: extract('non deve essere usato') };
    },
    () => {
      builderCalls += 1;
      return rebuiltQuote('non deve essere usato');
    }
  );

  assert.equal(outcome.status, 'cancelled');
  assert.strictEqual(outcome.document, local);
  assert.equal(extractionCalls, 0);
  assert.equal(builderCalls, 0);
});

test('successo: aggiorna solo il candidato e preserva identità, immagini e note locali', async () => {
  const local = {
    ...quoteDocument(),
    ocrQuality: {
      heuristicQuality: 0.95,
      confidenceType: 'heuristic' as const,
      qualityReasons: ['legacy_quality_estimate' as const],
      requiresReview: false,
    },
  };

  const outcome = await runDocumentAiReview(
    'confirm',
    local,
    async () => ({
      status: 'ok',
      extract: extract('testo AI', {
        documentNumber: 'AI-99',
        customerName: 'Cliente AI',
        total: 99,
      }),
    }),
    (_type, merged) => rebuiltQuote(merged.rawText),
    undefined,
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'ok');
  assert.notStrictEqual(outcome.document, local);
  assert.equal(outcome.document.id, local.id);
  assert.strictEqual(outcome.document.images, local.images);
  assert.strictEqual(outcome.document.createdAt, local.createdAt);
  assert.strictEqual(outcome.document.updatedAt, local.updatedAt);
  assert.equal((outcome.document as QuoteDocument).notes, local.notes);
  assert.equal((outcome.document as QuoteDocument).quoteNumber, 'AI-99');
  assert.equal((outcome.document as QuoteDocument).rawText, 'testo AI');
  assert.equal(outcome.document.ocrQuality?.confidenceType, 'unknown');
  assert.equal(outcome.document.ocrQuality?.measuredConfidence, undefined);
  assert.ok(
    outcome.document.ocrQuality?.qualityReasons.includes('cloud_result')
  );
  assert.notEqual(outcome.document.ocrQuality?.heuristicQuality, 0.95);
});

test('errore di rete: conserva esattamente il documento locale e non avvia il parser', async () => {
  const local = quoteDocument();
  let builderCalls = 0;

  const outcome = await runDocumentAiReview(
    'confirm',
    local,
    async () => ({ status: 'error', message: 'rete non disponibile' }),
    () => {
      builderCalls += 1;
      return rebuiltQuote('non deve essere usato');
    },
    undefined,
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'error');
  assert.strictEqual(outcome.document, local);
  assert.equal(builderCalls, 0);
});

test('multipagina: estrae in ordine, unisce testo e righe e conserva il record locale', async () => {
  const images = ['page-1.jpg', 'page-2.jpg'];
  const local = quoteDocument(images);
  const seenUris: string[] = [];
  const mergedByBuilder: GeminiDocumentExtract[] = [];

  const outcome = await runDocumentAiReview(
    'confirm',
    local,
    async (uri) => {
      seenUris.push(uri);
      return uri === images[0]
        ? {
            status: 'ok',
            extract: extract('PAGINA 1', {
              documentNumber: 'Q-2',
              customerName: 'Cliente multipagina',
              items: [
                { description: 'Riga 1', quantity: 1, unitPrice: 10, total: 10 },
              ],
            }),
          }
        : {
            status: 'ok',
            extract: extract('PAGINA 2', {
              subtotal: 10,
              vatAmount: 2.2,
              total: 12.2,
              items: [
                { description: 'Riga 2', quantity: 2, unitPrice: 5, total: 10 },
              ],
            }),
          };
    },
    (_type, merged) => {
      mergedByBuilder.push(merged);
      return rebuiltQuote(merged.rawText);
    },
    undefined,
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(seenUris, images);
  assert.equal(mergedByBuilder[0]?.rawText, 'PAGINA 1\n\nPAGINA 2');
  assert.equal(mergedByBuilder[0]?.documentNumber, 'Q-2');
  assert.equal(mergedByBuilder[0]?.customerName, 'Cliente multipagina');
  assert.equal(mergedByBuilder[0]?.total, 12.2);
  assert.equal(mergedByBuilder[0]?.items?.length, 2);
  assert.equal(outcome.document.id, local.id);
  assert.strictEqual(outcome.document.images, local.images);
});

test('fallimento su una pagina: nessun risultato parziale sostituisce il documento locale', async () => {
  const local = quoteDocument(['page-1.jpg', 'page-2.jpg']);
  let builderCalls = 0;

  const outcome = await runDocumentAiReview(
    'confirm',
    local,
    async (uri) =>
      uri.endsWith('1.jpg')
        ? { status: 'ok', extract: extract('PAGINA 1') }
        : { status: 'error', message: 'pagina 2 non leggibile' },
    () => {
      builderCalls += 1;
      return rebuiltQuote('non deve essere usato');
    },
    undefined,
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'error');
  assert.strictEqual(outcome.document, local);
  assert.equal(builderCalls, 0);
});

test('OCR multipagina locale: invoca soltanto lo scanner iniettato e conserva l’ordine', async () => {
  const calls: string[] = [];
  const result = await scanPagesLocally(
    ['locale-1.jpg', 'locale-2.jpg'],
    async (uri) => {
      calls.push(uri);
      return uri.endsWith('1.jpg')
        ? {
            text: 'Prima pagina',
            lines: [{ text: 'Prima pagina', confidence: 0.9 }],
          }
        : {
            text: '',
            lines: [{ text: 'Seconda pagina', confidence: 0.8 }],
          };
    }
  );

  assert.deepEqual(calls, ['locale-1.jpg', 'locale-2.jpg']);
  assert.equal(result.ocrWorked, true);
  assert.deepEqual(
    result.pages.map((page) => page.rawText),
    ['Prima pagina', 'Seconda pagina']
  );
});

test('merge puro: usa metadati iniziali, totali finali e concatena le righe', () => {
  const merged = mergeGeminiDocumentExtracts([
    extract('A', {
      documentNumber: 'DOC-7',
      customerName: 'Cliente',
      date: '24/07/2026',
      items: [{ description: 'A', quantity: 1, unitPrice: 1, total: 1 }],
    }),
    extract('B', {
      subtotal: 5,
      vatAmount: 1.1,
      total: 6.1,
      items: [{ description: 'B', quantity: 1, unitPrice: 4, total: 4 }],
    }),
  ]);

  assert.equal(merged.rawText, 'A\n\nB');
  assert.equal(merged.documentNumber, 'DOC-7');
  assert.equal(merged.customerName, 'Cliente');
  assert.equal(merged.total, 6.1);
  assert.deepEqual(
    (merged.items ?? []).map((item) => item.description),
    ['A', 'B']
  );
});

test('documento senza immagini: non chiama estrattore né parser', async () => {
  const local: FreeDocument = {
    id: 'free-local',
    type: 'free_document',
    title: 'Documento',
    images: [],
    rawText: 'locale',
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    extractedFields: {},
  };
  let calls = 0;

  const outcome = await runDocumentAiReview(
    'confirm',
    local as AnyDocument,
    async () => {
      calls += 1;
      return { status: 'not_configured' };
    },
    () => {
      calls += 1;
      return local;
    },
    undefined,
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'error');
  assert.strictEqual(outcome.document, local);
  assert.equal(calls, 0);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { QuoteDocument } from '../types';
import {
  extractCloudPagesWithLocalFallback,
  PAGE_WARNING_CLOUD_FALLBACK,
} from '../lib/document-page-extraction';
import { runDocumentAiReview } from '../lib/document-ai-review';

function quoteDocument(images = ['page-1.jpg']): QuoteDocument {
  const timestamp = new Date('2026-07-20T10:00:00.000Z');
  return {
    id: 'fixture-document',
    type: 'quote',
    title: 'Fixture locale',
    images,
    rawText: 'TESTO LOCALE ORIGINALE',
    confidence: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    quoteNumber: 'LOCAL-1',
    quoteDate: timestamp,
    customerName: 'FIXTURE CUSTOMER',
    items: [],
    subtotal: 10,
    vatAmount: 2.2,
    total: 12.2,
    currency: 'EUR',
  };
}

test('7B-27 consenso annullato: zero chiamate e documento invariato', async () => {
  const original = quoteDocument();
  let cloudCalls = 0;
  const outcome = await runDocumentAiReview(
    'cancel',
    original,
    async () => {
      cloudCalls += 1;
      return { status: 'error', message: 'MUST_NOT_RUN' };
    },
    () => {
      throw new Error('MUST_NOT_RUN');
    }
  );
  assert.equal(cloudCalls, 0);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.document, original);
});

test('7B-28 errore modello conserva fallback OCR locale reviewabile', async () => {
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['page-1.jpg'],
    async () => ({
      status: 'error',
      message: 'Servizio AI temporaneamente non disponibile',
    }),
    async () => ({
      text: 'TESTO OCR LOCALE PRESERVATO',
      lines: [{ text: 'TESTO OCR LOCALE PRESERVATO', confidence: 0.8 }],
    })
  );
  assert.equal(outcome.status, 'ok');
  const page = outcome.results[0];
  assert.equal(page?.processingMethod, 'local_fallback');
  assert.equal(page?.rawText, 'TESTO OCR LOCALE PRESERVATO');
  assert.equal(page?.requiresReview, true);
  assert.deepEqual(page?.warnings, [PAGE_WARNING_CLOUD_FALLBACK]);
});

test('7B-29 errore cloud resta visibile senza modificare il documento', async () => {
  const original = quoteDocument();
  const outcome = await runDocumentAiReview(
    'confirm',
    original,
    async () => ({
      status: 'error',
      message: 'Servizio AI temporaneamente non disponibile',
    }),
    () => {
      throw new Error('MUST_NOT_BUILD');
    },
    undefined,
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.document, original);
  assert.match(
    outcome.status === 'error' ? outcome.message ?? '' : '',
    /temporaneamente non disponibile/
  );
});

test('7B-30 multipagina mantiene ordine e fallback indipendente', async () => {
  const cloudCalls: string[] = [];
  const localCalls: string[] = [];
  const pages = ['page-1.jpg', 'page-2.jpg', 'page-3.jpg'];
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    pages,
    async (uri) => {
      cloudCalls.push(uri);
      return { status: 'error', message: 'AI_MODEL_NOT_CONFIGURED' };
    },
    async (uri) => {
      localCalls.push(uri);
      const text = `LOCALE ${uri}`;
      return { text, lines: [{ text, confidence: 0.8 }] };
    }
  );
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(cloudCalls, pages);
  assert.deepEqual(localCalls, pages);
  assert.deepEqual(
    outcome.results.map((page) => page.rawText),
    pages.map((uri) => `LOCALE ${uri}`)
  );
  assert.ok(
    outcome.results.every(
      (page) =>
        page.processingMethod === 'local_fallback' && page.requiresReview
    )
  );
});

test('7B-31 documenti cloud validi restano elaborati per pagina', async () => {
  const pages = ['page-1.jpg', 'page-2.jpg'];
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    pages,
    async (uri) => ({
      status: 'ok',
      extract: {
        rawText: `CLOUD ${uri}`,
        documentNumber: uri === pages[0] ? 'DOC-1' : 'DOC-2',
      },
    }),
    async () => {
      throw new Error('LOCAL_FALLBACK_NOT_EXPECTED');
    }
  );
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(
    outcome.results.map((page) => page.processingMethod),
    ['cloud', 'cloud']
  );
  assert.deepEqual(
    outcome.results.map((page) => page.rawText),
    ['CLOUD page-1.jpg', 'CLOUD page-2.jpg']
  );
});

test('7B-32 traduzioni IT/EN mantengono consenso e review coerenti', () => {
  const it = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'i18n/it.json'), 'utf8')
  ) as Record<string, string>;
  const en = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'i18n/en.json'), 'utf8')
  ) as Record<string, string>;
  for (const key of [
    'documentAiNotConfigured',
    'documentAiError',
    'geminiModalIntroImages',
    'geminiModalCancelButton',
    'geminiModalSendButton',
  ]) {
    assert.equal(typeof it[key], 'string', `traduzione IT mancante: ${key}`);
    assert.equal(typeof en[key], 'string', `traduzione EN mancante: ${key}`);
    assert.ok(it[key].trim());
    assert.ok(en[key].trim());
  }
  assert.match(it.geminiModalIntroImages, /supporto AI/i);
  assert.match(en.geminiModalIntroImages, /AI support/i);
  assert.doesNotMatch(
    `${it.geminiModalIntroImages}\n${en.geminiModalIntroImages}`,
    /Vertex AI/
  );
});

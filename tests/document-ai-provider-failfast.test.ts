import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCloudPagesWithLocalFallback } from '../lib/document-page-extraction';
import { runDocumentAiReview } from '../lib/document-ai-review';

test('supporto AI multipagina interrompe al primo errore cloud senza fallback locale', async () => {
  let cloudCalls = 0;
  let localCalls = 0;
  const outcome = await extractCloudPagesWithLocalFallback(
    'order',
    ['page-1.jpg', 'page-2.jpg', 'page-3.jpg'],
    async () => {
      cloudCalls += 1;
      return { status: 'error', message: 'network unavailable' } as const;
    },
    async () => {
      localCalls += 1;
      throw new Error('fallback locale non deve partire nel supporto AI esplicito');
    },
    undefined,
    { abortOnCloudError: true }
  );

  assert.equal(outcome.status, 'error');
  assert.equal(cloudCalls, 1);
  assert.equal(localCalls, 0);
  if (outcome.status === 'error') assert.equal(outcome.failedPageIndex, 0);
});

test('supporto AI esplicito restituisce provider_unavailable e conserva il documento', async () => {
  let cloudCalls = 0;
  let localCalls = 0;
  const document = {
    id: 'generic-doc',
    type: 'order',
    images: ['page-1.jpg', 'page-2.jpg', 'page-3.jpg'],
    title: 'Ordine locale',
    rawText: 'contenuto locale',
  } as any;

  const outcome = await runDocumentAiReview(
    'confirm',
    document,
    async () => {
      cloudCalls += 1;
      return { status: 'error', message: 'network unavailable' } as const;
    },
    () => {
      throw new Error('builder non deve essere chiamato su errore provider');
    },
    async () => {
      localCalls += 1;
      throw new Error('fallback locale non deve mascherare errore provider');
    },
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'error');
  assert.equal(cloudCalls, 1);
  assert.equal(localCalls, 0);
  assert.equal(outcome.document, document);
  if (outcome.status === 'error') assert.equal(outcome.reason, 'provider_unavailable');
});

test('crediti esauriti interrompono al primo tentativo senza pagine successive', async () => {
  let cloudCalls = 0;
  const outcome = await extractCloudPagesWithLocalFallback(
    'invoice',
    ['page-1.jpg', 'page-2.jpg'],
    async () => {
      cloudCalls += 1;
      return { status: 'credits_exhausted' } as const;
    },
    async () => {
      throw new Error('fallback non previsto');
    },
    undefined,
    { abortOnCloudError: true }
  );

  assert.equal(outcome.status, 'credits_exhausted');
  assert.equal(cloudCalls, 1);
});

test('provider OK con campo ambiguo resta reviewabile e non diventa errore connessione', async () => {
  let cloudCalls = 0;
  let localCalls = 0;
  const outcome = await extractCloudPagesWithLocalFallback(
    'invoice',
    ['page-ambiguous.jpg'],
    async () => {
      cloudCalls += 1;
      return {
        status: 'ok',
        extract: {
          rawText: 'Invoice AI-2026-001',
          documentNumber: 'AI-2026-001',
          // Data volutamente non osservata nel rawText: reliability ambiguous.
          date: '2026-09-01',
          subtotal: 100,
          vatAmount: 22,
          total: 122,
        },
        aiCreditsRemaining: 10,
      } as const;
    },
    async () => {
      localCalls += 1;
      throw new Error('fallback locale non deve partire dopo provider OK');
    },
    undefined,
    { abortOnCloudError: true }
  );

  assert.equal(outcome.status, 'ok');
  assert.equal(cloudCalls, 1);
  assert.equal(localCalls, 0);
  if (outcome.status === 'ok') {
    assert.equal(outcome.results.length, 1);
    assert.equal(outcome.results[0].processingMethod, 'cloud');
    assert.equal(outcome.results[0].requiresReview, true);
    assert.equal(
      outcome.results[0].fieldReliability?.date?.validationStatus,
      'ambiguous'
    );
  }
});

test('runDocumentAiReview non abortisce provider_unavailable dopo provider OK con ambiguità', async () => {
  let cloudCalls = 0;
  let localCalls = 0;
  const createdAt = new Date('2026-09-01T08:00:00.000Z');
  const updatedAt = new Date('2026-09-01T08:30:00.000Z');
  const document = {
    id: 'reviewable-doc',
    type: 'quote',
    images: ['page-reviewable.jpg'],
    title: 'Preventivo locale',
    rawText: 'Preventivo locale Q-LOCAL-1 Totale 100 EUR',
    confidence: { total: 0.5 },
    createdAt,
    updatedAt,
    quoteNumber: 'Q-LOCAL-1',
    quoteDate: new Date('2026-09-01T00:00:00.000Z'),
    customerName: 'Cliente locale',
    items: [],
    subtotal: 100,
    vatAmount: 22,
    total: 122,
    currency: 'EUR',
    notes: 'nota locale',
  } as any;

  const outcome = await runDocumentAiReview(
    'confirm',
    document,
    async () => {
      cloudCalls += 1;
      return {
        status: 'ok',
        extract: {
          rawText: 'Preventivo AI Q-AI-2026-002 Totale 122 EUR',
          documentNumber: 'Q-AI-2026-002',
          customerName: 'Cliente AI',
          date: '2026-09-01',
          subtotal: 100,
          vatAmount: 22,
          total: 122,
          items: [],
        },
        aiCreditsRemaining: 9,
      } as const;
    },
    (_type, extract) => ({
      ...document,
      title: extract.documentNumber || document.title,
      rawText: extract.rawText,
      quoteNumber: extract.documentNumber || document.quoteNumber,
      customerName: extract.customerName || document.customerName,
      subtotal: extract.subtotal ?? document.subtotal,
      vatAmount: extract.vatAmount ?? document.vatAmount,
      total: extract.total ?? document.total,
    }),
    async () => {
      localCalls += 1;
      throw new Error('fallback locale non deve partire dopo provider OK');
    },
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(cloudCalls, 1);
  assert.equal(localCalls, 0);
  assert.notEqual(
    outcome.status === 'error' ? outcome.reason : undefined,
    'provider_unavailable'
  );
  assert.equal(outcome.status, 'ok');
});

test('provider OK con payload inutilizzabile non viene etichettato come errore rete', async () => {
  const document = {
    id: 'invalid-ai-payload-doc',
    type: 'invoice',
    images: ['page-invalid.jpg'],
    title: 'Documento locale',
    rawText: 'Documento locale',
  } as any;

  const outcome = await runDocumentAiReview(
    'confirm',
    document,
    async () => ({
      status: 'ok',
      extract: { rawText: 'testo senza campi strutturati' },
      aiCreditsRemaining: 8,
    } as const),
    () => document,
    async () => {
      throw new Error('fallback locale non previsto nel supporto AI esplicito');
    },
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'error');
  if (outcome.status === 'error') {
    assert.equal(outcome.reason, 'invalid_request');
    assert.notEqual(outcome.reason, 'provider_unavailable');
  }
});

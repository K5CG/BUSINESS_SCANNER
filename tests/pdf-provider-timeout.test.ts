import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  createParseDocumentHandler,
  createParsePdfHandler,
} from '../supabase/functions/_shared/document-edge-handlers';
import { createEdgeTrafficControl } from '../supabase/functions/_shared/edge-request-guard';
import { countPdfPages } from '../supabase/functions/_shared/pdf-page-count';
import {
  GEMINI_PROVIDER_TIMEOUT_MS,
  PDF_GEMINI_TIMEOUT_MS,
  generateGeminiJson,
} from '../supabase/functions/_shared/gemini-provider';

const ALLOWED_ORIGIN = 'https://scanner.example.test';
const JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z';

function dependencies() {
  return {
    allowedOrigins: () => ALLOWED_ORIGIN,
    getApiKey: () => 'SYNTHETIC_SERVER_KEY',
    getModelConfiguration: () =>
      ({ ok: true, model: 'gemini-3.5-flash-lite' }) as const,
    traffic: createEdgeTrafficControl(
      {
        rateLimit: 100,
        rateWindowMs: 60_000,
        maxConcurrent: 3,
        maxBuckets: 100,
        leaseTtlSeconds: 55,
      },
      { salt: 'SYNTHETIC_TEST_SALT' }
    ),
  };
}

async function syntheticPdf(): Promise<string> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  return Buffer.from(await document.save()).toString('base64');
}

test('un PDF commerciale concede al modello piu tempo di una pagina fotografata', async () => {
  assert.ok(PDF_GEMINI_TIMEOUT_MS > GEMINI_PROVIDER_TIMEOUT_MS);
  assert.equal(PDF_GEMINI_TIMEOUT_MS, 20_000);
});

test('la richiesta PDF porta il proprio limite di tempo al provider', async () => {
  const seen: Array<number | undefined> = [];
  const handler = createParsePdfHandler({
    ...dependencies(),
    countPdfPages,
    extractPdf: async (_pdfBase64, _apiKey, _model, options) => {
      seen.push(options?.timeoutMs);
      return {
        ok: true as const,
        value: {
          extract: { rawText: 'SYNTHETIC OCR' },
          timings: { summaryMs: 1, itemsMs: 1, totalMs: 1 },
        },
      };
    },
  });
  const response = await handler(
    new Request('https://edge.example.test/parse-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({
        pdfBase64: await syntheticPdf(),
        mimeType: 'application/pdf',
      }),
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [PDF_GEMINI_TIMEOUT_MS]);
});

test('la pagina fotografata resta sul limite di tempo condiviso', async () => {
  const seen: Array<number | undefined> = [];
  const handler = createParseDocumentHandler({
    ...dependencies(),
    extract: async (_parts, _apiKey, _model, options) => {
      seen.push(options?.timeoutMs);
      return { ok: true as const, value: { rawText: 'SYNTHETIC OCR' } };
    },
  });
  const response = await handler(
    new Request('https://edge.example.test/parse-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({ imageBase64: JPEG_BASE64, mimeType: 'image/jpeg' }),
    })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [20_000]);
});

test('scaduto il tempo concesso la chiamata si chiude senza attendere oltre', async () => {
  const started = Date.now();
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [{ text: 'SYNTHETIC' }],
    timeoutMs: 50,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted'))
        );
      }),
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.errorCode, 'AI_PROVIDER_TIMEOUT');
  assert.ok(Date.now() - started < 2_000);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { QuoteDocument } from '../types';
import { MAX_CLOUD_DOCUMENT_PAGES } from '../lib/cloud-ai-limits';
import {
  DOCUMENT_CLOUD_PAGE_TIMEOUT_MS,
  extractCloudPagesWithLocalFallback,
  PAGE_WARNING_CLOUD_FALLBACK,
} from '../lib/document-page-extraction';
import { runDocumentAiReview } from '../lib/document-ai-review';
import {
  DEFAULT_EDGE_TRAFFIC_CONFIG,
  MAX_PDF_PAGES,
  REQUEST_BODY_TIMEOUT_MS,
} from '../supabase/functions/_shared/edge-request-guard';
import {
  GEMINI_PROVIDER_TIMEOUT_MS,
  generateGeminiJson,
} from '../supabase/functions/_shared/gemini-provider';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function runtimeSource(relativePath: string): string {
  const absolute = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(absolute)) return '';
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return fs.readFileSync(absolute, 'utf8');
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.name !== 'node_modules' &&
        entry.name !== 'build' &&
        entry.name !== 'backup'
    )
    .map((entry) => runtimeSource(path.join(relativePath, entry.name)))
    .join('\n');
}

function quoteDocument(images = ['page-1.jpg']): QuoteDocument {
  const timestamp = new Date('2026-07-20T10:00:00.000Z');
  return {
    id: 'phase7c-fixture',
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

test('7C-25 errore Edge mantiene fallback OCR locale e review', async () => {
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['page-1.jpg'],
    async () => ({
      status: 'error',
      message: 'Troppe richieste, riprova più tardi',
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

test('7C-26 consenso annullato conserva documento e fa zero richieste', async () => {
  const original = quoteDocument();
  let calls = 0;
  const outcome = await runDocumentAiReview(
    'cancel',
    original,
    async () => {
      calls += 1;
      return { status: 'error', message: 'MUST_NOT_RUN' };
    },
    () => {
      throw new Error('MUST_NOT_RUN');
    }
  );
  assert.equal(calls, 0);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.document, original);
});

test('7C-27 multipagina oltre limite usa solo fallback locale', async () => {
  const pages = Array.from(
    { length: MAX_CLOUD_DOCUMENT_PAGES + 1 },
    (_, index) => `page-${index + 1}.jpg`
  );
  let cloudCalls = 0;
  let localCalls = 0;
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    pages,
    async () => {
      cloudCalls += 1;
      return { status: 'error', message: 'MUST_NOT_RUN' };
    },
    async (uri) => {
      localCalls += 1;
      return {
        text: `LOCALE ${uri}`,
        lines: [{ text: `LOCALE ${uri}`, confidence: 0.8 }],
      };
    }
  );
  assert.equal(outcome.status, 'ok');
  assert.equal(cloudCalls, 0);
  assert.equal(localCalls, pages.length);
  assert.ok(
    outcome.results.every(
      (page) =>
        page.processingMethod === 'local_fallback' &&
        page.requiresReview
    )
  );
});

test('7C-28 workflow invia indice e conteggio pagina al client Edge', async () => {
  const seen: Array<[string, number | undefined, number | undefined]> = [];
  const pages = ['page-1.jpg', 'page-2.jpg'];
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    pages,
    async (uri, pageIndex, pageCount) => {
      seen.push([uri, pageIndex, pageCount]);
      return {
        status: 'ok',
        extract: {
          rawText: `CLOUD ${uri}`,
          documentNumber: `DOC-${Number(pageIndex) + 1}`,
        },
      };
    },
    async () => {
      throw new Error('LOCAL_NOT_EXPECTED');
    }
  );
  assert.equal(outcome.status, 'ok');
  assert.deepEqual(seen, [
    ['page-1.jpg', 0, 2],
    ['page-2.jpg', 1, 2],
  ]);
});

test('7C-29 limite pagine client/server resta coerente', () => {
  assert.equal(MAX_CLOUD_DOCUMENT_PAGES, MAX_PDF_PAGES);
  assert.equal(MAX_CLOUD_DOCUMENT_PAGES, 10);
});

test('7C-30 nessuna chiave o chiamata Gemini diretta nel client', () => {
  const client = [
    runtimeSource('lib'),
    runtimeSource('app'),
    runtimeSource('components'),
    source('app.config.js'),
  ].join('\n');
  assert.doesNotMatch(client, /GEMINI_API_KEY|EXPO_PUBLIC_GEMINI/);
  assert.doesNotMatch(client, /generativelanguage\.googleapis\.com/);
  assert.doesNotMatch(client, /x-goog-api-key/i);
});

test('7C-31 client non propaga body grezzo o dettagli eccezione', () => {
  const supabaseClient = source('lib/supabase-functions.ts');
  const documentResponseStart = supabaseClient.indexOf(
    'const responseBody = await readFunctionResponse'
  );
  const documentCatchStart = supabaseClient.indexOf(
    'const timedOut =',
    documentResponseStart
  );
  assert.ok(documentResponseStart >= 0);
  assert.ok(documentCatchStart > documentResponseStart);

  const documentClient = [
    supabaseClient.slice(documentResponseStart, documentCatchStart),
    source('lib/gemini-ocr.ts'),
    source('lib/card-ai-structure.ts'),
  ].join('\n');
  assert.doesNotMatch(documentClient, /\(text\s*\|\|\s*`HTTP/);
  assert.doesNotMatch(
    documentClient,
    /error:\s*String\s*\(\s*error\s*\)/
  );
  assert.doesNotMatch(
    source('lib/gemini-ocr.ts'),
    /message:\s*error\s+instanceof\s+Error/
  );
  assert.match(supabaseClient, /EDGE_RESPONSE_TOO_LARGE/);
  assert.match(supabaseClient, /EDGE_RESPONSE_INVALID/);
  assert.match(supabaseClient, /EDGE_SECURITY_UNAVAILABLE/);
});

test('7C-32 PDF client dichiara MIME e non inserisce filename nel prompt', () => {
  const client = source('lib/parse-pdf.ts');
  const handler = source(
    'supabase/functions/_shared/document-edge-handlers.ts'
  );
  assert.match(client, /mimeType:\s*'application\/pdf'/);
  assert.doesNotMatch(handler, /\$\{[^}]*fileName[^}]*\}/);
  assert.doesNotMatch(handler, /body\.fileName/);
});

test('7C-33 i tre endpoint mantengono verify_jwt esplicito', () => {
  const config = source('supabase/config.toml');
  for (const name of [
    'parse-document',
    'parse-pdf',
    'structure-business-card',
  ]) {
    assert.match(
      config,
      new RegExp(
        `\\[functions\\.${name.replace('-', '\\-')}\\]\\s+verify_jwt\\s*=\\s*true`
      )
    );
  }
});

test('7C-34 CORS wildcard legacy non viene usato dagli endpoint AI', () => {
  for (const endpoint of [
    'supabase/functions/parse-document/index.ts',
    'supabase/functions/parse-pdf/index.ts',
    'supabase/functions/structure-business-card/index.ts',
  ]) {
    const entrypoint = source(endpoint);
    assert.doesNotMatch(entrypoint, /\bcorsHeaders\b/);
    assert.match(entrypoint, /create(?:ParseDocument|ParsePdf|StructureCard)Handler/);
  }
  const handler = source(
    'supabase/functions/_shared/document-edge-handlers.ts'
  );
  assert.match(handler, /resolveDocumentCors/);
});

test('7C-35 nessun retry provider incontrollato', async () => {
  let calls = 0;
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [],
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}', { status: 429 });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(outcome, {
    ok: false,
    errorCode: 'AI_PROVIDER_RATE_LIMITED',
    httpStatus: 429,
  });
});

test('7C-36 quota tecnica fallisce chiusa su errore database', () => {
  const endpoint = source(
    'supabase/functions/structure-business-card/index.ts'
  );
  assert.match(endpoint, /if\s*\(\s*error\s*\)[\s\S]*?return false/);
  assert.match(endpoint, /catch\s*\{[\s\S]*?return false/);
  assert.match(endpoint, /withEdgeDatabaseDeadline/);
  assert.match(endpoint, /\.abortSignal\(signal\)/);
  assert.doesNotMatch(endpoint, /return true;\s*\/\/.*fail.open/i);
});

test('7C-37 RPC quota è privata e usa search_path sicuro', () => {
  const migration = source(
    'supabase/migrations/005_harden_edge_ai_guards.sql'
  );
  assert.match(migration, /SET search_path = ''/);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.increment_ai_usage\(integer\) FROM PUBLIC/
  );
  assert.match(migration, /FROM anon/);
  assert.match(migration, /FROM authenticated/);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public\.increment_ai_usage\(integer\) TO service_role/
  );
  assert.match(migration, /public\.ai_usage_daily/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.edge_ai_rate_windows/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.edge_ai_request_leases/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.acquire_edge_ai_request/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.release_edge_ai_request/);
  assert.match(migration, /pg_try_advisory_xact_lock/);
  assert.doesNotMatch(migration, /pg_catalog\.greatest/);
  assert.match(migration, /SET lock_timeout = '250ms'/);
  assert.ok(
    migration.indexOf('pg_try_advisory_xact_lock') <
      migration.indexOf('v_now := pg_catalog.clock_timestamp()')
  );
  for (const role of ['PUBLIC', 'anon', 'authenticated']) {
    assert.match(
      migration,
      new RegExp(
        `REVOKE ALL ON FUNCTION public\\.acquire_edge_ai_request\\([\\s\\S]*?FROM ${role}`
      )
    );
  }
});

test('7C-38 parser PDF Edge usa dipendenza fissata e isolata', () => {
  const denoConfig = JSON.parse(
    source('supabase/functions/parse-pdf/deno.json')
  ) as { imports?: Record<string, string> };
  assert.equal(denoConfig.imports?.['pdf-lib'], 'npm:pdf-lib@1.17.1');
  assert.match(source('package.json'), /"pdf-lib": "\^1\.17\.1"/);
});

test('7C-39 configurazione documenta limiti best-effort senza pseudo-auth', () => {
  const envExample = source('.env.example');
  assert.match(envExample, /EDGE_RATE_LIMIT_MAX_REQUESTS=10/);
  assert.match(envExample, /EDGE_RATE_LIMIT_WINDOW_MS=60000/);
  assert.match(envExample, /EDGE_MAX_CONCURRENT_REQUESTS=3/);
  assert.match(envExample, /EDGE_LEASE_TTL_SECONDS=55/);
  assert.match(envExample, /EDGE_RATE_LIMIT_SALT=/);
  assert.match(envExample, /almeno 32 caratteri/);
  assert.match(envExample, /CORS non è autenticazione/);
  assert.match(envExample, /difese sono tecniche e globali sul database/);
  assert.match(envExample, /005_harden_edge_ai_guards\.sql/);
  assert.match(envExample, /non applica migrazioni/);
  assert.doesNotMatch(envExample, /DEVICE_SECRET|APP_SECRET/);
});

test('7C-40 tutti gli entrypoint usano il gate PostgreSQL distribuito', () => {
  for (const endpoint of [
    'supabase/functions/parse-document/index.ts',
    'supabase/functions/parse-pdf/index.ts',
    'supabase/functions/structure-business-card/index.ts',
  ]) {
    const entrypoint = source(endpoint);
    assert.match(entrypoint, /createSupabaseEdgeTrafficControl\(getEnv\)/);
    assert.doesNotMatch(entrypoint, /createEdgeTrafficControl/);
  }

  const adapter = source(
    'supabase/functions/_shared/supabase-edge-traffic.ts'
  );
  assert.match(adapter, /EDGE_RATE_LIMIT_SALT/);
  assert.match(adapter, /acquire_edge_ai_request/);
  assert.match(adapter, /release_edge_ai_request/);
  assert.match(adapter, /\.abortSignal\(signal\)/);
});

test('7C-41 catena timeout lascia margine prima del fallback locale', () => {
  const databaseTimeout = Number(
    source('supabase/functions/_shared/edge-database-deadline.ts')
      .match(/EDGE_DATABASE_TIMEOUT_MS\s*=\s*([0-9_]+)/)?.[1]
      ?.replaceAll('_', '')
  );
  const functionTimeout = Number(
    source('lib/supabase-functions.ts')
      .match(/DOCUMENT_FUNCTION_TIMEOUT_MS\s*=\s*([0-9_]+)/)?.[1]
      ?.replaceAll('_', '')
  );
  const legacyFunctionTimeout = Number(
    source('lib/supabase-functions.ts')
      .match(/FUNCTION_TIMEOUT_MS\s*=\s*([0-9_]+)/)?.[1]
      ?.replaceAll('_', '')
  );
  assert.equal(databaseTimeout, 2_000);
  assert.equal(legacyFunctionTimeout, 15_000);
  assert.equal(functionTimeout, 45_000);
  assert.match(
    source('lib/supabase-functions.ts'),
    /DOCUMENT_FUNCTIONS\.has\(functionName\)[\s\S]*?DOCUMENT_FUNCTION_TIMEOUT_MS[\s\S]*?:\s*FUNCTION_TIMEOUT_MS/
  );
  assert.ok(
    databaseTimeout * 3 +
      REQUEST_BODY_TIMEOUT_MS +
      GEMINI_PROVIDER_TIMEOUT_MS <
      functionTimeout
  );
  assert.ok(functionTimeout < DOCUMENT_CLOUD_PAGE_TIMEOUT_MS);
  assert.ok(
    functionTimeout <=
      DEFAULT_EDGE_TRAFFIC_CONFIG.leaseTtlSeconds * 1_000
  );
});

test('7C-42 preflight PDF ricontrolla i byte letti, non solo metadata', () => {
  const pdfImport = source('lib/pdf-import.ts');
  assert.match(
    pdfImport,
    /const bytes = await file\.bytes\(\);[\s\S]*?bytes\.byteLength > MAX_CLOUD_PDF_BYTES/
  );
});

test('7C-43 hardening client non cambia il contratto delle funzioni licenza', () => {
  const client = source('lib/supabase-functions.ts');
  assert.match(client, /if\s*\(\s*!DOCUMENT_FUNCTIONS\.has\(functionName\)\s*\)/);
  assert.match(
    client,
    /const text = await response\.text\(\);[\s\S]*?errorPayload\?\.error \?\? \(text \|\| `HTTP \$\{response\.status\}`\)/
  );
  assert.match(
    client,
    /if\s*\(\s*!DOCUMENT_FUNCTIONS\.has\(functionName\)\s*\)\s*\{[\s\S]*?String\(error\)/
  );
});

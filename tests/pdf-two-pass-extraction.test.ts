import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  extractPdfWithGemini,
  mergePdfPasses,
  parsePdfItemsResponse,
} from '../supabase/functions/_shared/gemini-extract';
import { createParsePdfHandler } from '../supabase/functions/_shared/document-edge-handlers';
import { createEdgeTrafficControl } from '../supabase/functions/_shared/edge-request-guard';
import { countPdfPages } from '../supabase/functions/_shared/pdf-page-count';
import { PDF_GEMINI_TIMEOUT_MS } from '../supabase/functions/_shared/gemini-provider';
import { AiCreditGuard } from '../supabase/functions/_shared/ai-credit-ledger';
import { InMemoryAiCreditLedger } from '../lib/ai-credit/ledger';

const ALLOWED_ORIGIN = 'https://scanner.example.test';
const INSTALLATION = '11111111-1111-4111-8111-111111111111';

const SUMMARY_JSON = JSON.stringify({
  rawText: 'PREVENTIVO PV-2026-0811\nTecnoservice Veneto S.r.l.',
  documentNumber: 'PV-2026-0811',
  customerName: 'Officine Maraldi S.p.A.',
  date: '2026-08-11',
  subtotal: 9482.5,
  vatAmount: 2086.15,
  total: 11568.65,
  structured: {
    schemaVersion: 2,
    document: {
      documentType: { value: 'quotation' },
      documentNumber: { value: 'PV-2026-0811' },
      issueDate: { value: '2026-08-11' },
      currency: { value: 'EUR' },
      subject: {
        value:
          'Fornitura e installazione postazioni officina e software diagnostico',
      },
    },
    issuer: { name: { value: 'Tecnoservice Veneto S.r.l.' } },
    customer: { name: { value: 'Officine Maraldi S.p.A.' } },
    summary: {
      subtotal: { value: 9482.5 },
      vatAmount: { value: 2086.15 },
      total: { value: 11568.65 },
    },
  },
});

const ITEMS_JSON = JSON.stringify({
  items: Array.from({ length: 10 }, (_, index) => ({
    itemCode: `ART-${index + 1}`,
    description: `Riga ${index + 1}`,
    quantity: 1,
    unit: 'pz',
    unitPrice: 100 + index,
    vatRate: 22,
    total: 100 + index,
  })),
  structured: {
    schemaVersion: 2,
    items: Array.from({ length: 10 }, (_, index) => ({
      itemCode: { value: `ART-${index + 1}` },
      description: { value: `Riga ${index + 1}` },
      lineTotal: { value: 100 + index },
    })),
  },
});

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Riconosce quale passata sta chiedendo il modello guardando il prompt. */
function isItemsRequest(init: RequestInit): boolean {
  const body = typeof init.body === 'string' ? init.body : '';
  return body.includes('SOLO le righe commerciali');
}

async function syntheticPdf(): Promise<string> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  return Buffer.from(await document.save()).toString('base64');
}

test('una passata legge l intestazione, l altra le righe, e nessuna vede il prompt dell altra', async () => {
  const prompts: string[] = [];
  const outcome = await extractPdfWithGemini(
    'U1lOVEhFVElD',
    'SYNTHETIC_SERVER_KEY',
    'gemini-3.5-flash-lite',
    {
      expectedType: 'quotation',
      fetchImpl: (_url, init) => {
        const body = typeof init.body === 'string' ? init.body : '';
        prompts.push(body);
        return Promise.resolve(
          geminiResponse(isItemsRequest(init) ? ITEMS_JSON : SUMMARY_JSON)
        );
      },
    }
  );

  assert.equal(prompts.length, 2);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  const summaryRequest = prompts.find((body) => !body.includes('SOLO le righe commerciali'));
  const itemsRequest = prompts.find((body) => body.includes('SOLO le righe commerciali'));
  assert.ok(summaryRequest && itemsRequest);
  assert.ok(summaryRequest.includes("SOLO dell'intestazione commerciale"));
  assert.ok(!itemsRequest.includes("SOLO dell'intestazione commerciale"));

  const { extract, timings } = outcome.value;
  assert.equal(extract.documentNumber, 'PV-2026-0811');
  assert.equal(extract.customerName, 'Officine Maraldi S.p.A.');
  assert.equal(extract.date, '2026-08-11');
  assert.equal(extract.subtotal, 9482.5);
  assert.equal(extract.vatAmount, 2086.15);
  assert.equal(extract.total, 11568.65);
  assert.equal(extract.items?.length, 10);
  assert.equal(
    (extract.structured?.issuer as { name: { value: string } }).name.value,
    'Tecnoservice Veneto S.r.l.'
  );
  assert.equal((extract.structured?.items as unknown[]).length, 10);
  assert.ok(timings.totalMs >= 0);
  assert.ok(timings.summaryMs >= 0);
  assert.ok(timings.itemsMs >= 0);
});

test('le due passate viaggiano insieme: il totale non è la somma delle attese', async () => {
  const outcome = await extractPdfWithGemini(
    'U1lOVEhFVElD',
    'SYNTHETIC_SERVER_KEY',
    'gemini-3.5-flash-lite',
    {
      fetchImpl: (_url, init) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                geminiResponse(isItemsRequest(init) ? ITEMS_JSON : SUMMARY_JSON)
              ),
            120
          );
        }),
    }
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.ok(outcome.value.timings.totalMs < 240);
});

test('ogni passata riceve il limite di tempo dei PDF', async () => {
  const handler = createParsePdfHandler({
    allowedOrigins: () => ALLOWED_ORIGIN,
    getApiKey: () => 'SYNTHETIC_SERVER_KEY',
    getModelConfiguration: () => ({ ok: true, model: 'gemini-3.5-flash-lite' }),
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
    countPdfPages,
  });
  const seen: Array<number | undefined> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    seen.push(PDF_GEMINI_TIMEOUT_MS);
    return Promise.resolve(
      geminiResponse(isItemsRequest(init) ? ITEMS_JSON : SUMMARY_JSON)
    );
  }) as typeof fetch;
  try {
    const response = await handler(
      new Request('https://edge.example.test/parse-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({
          pdfBase64: await syntheticPdf(),
          mimeType: 'application/pdf',
          documentType: 'quote',
        }),
      })
    );
    assert.equal(response.status, 200);
    const body = JSON.parse(await response.text());
    assert.equal(body.items.length, 10);
    assert.equal(body.documentNumber, 'PV-2026-0811');
    assert.equal(typeof body.providerTimings.totalMs, 'number');
    assert.deepEqual(seen, [PDF_GEMINI_TIMEOUT_MS, PDF_GEMINI_TIMEOUT_MS]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un import PDF resta una sola operazione a credito', async () => {
  const ledger = new InMemoryAiCreditLedger();
  ledger.grant({
    installationId: INSTALLATION,
    licenseId: null,
    amount: 3,
    source: 'trial',
    referenceId: `trial:${INSTALLATION}`,
    operationId: `trial-grant:${INSTALLATION}`,
    transactionType: 'trial_grant',
  });
  const handler = createParsePdfHandler({
    allowedOrigins: () => ALLOWED_ORIGIN,
    getApiKey: () => 'SYNTHETIC_SERVER_KEY',
    getModelConfiguration: () => ({ ok: true, model: 'gemini-3.5-flash-lite' }),
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
    countPdfPages,
    creditGuard: new AiCreditGuard(ledger),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) =>
    Promise.resolve(
      geminiResponse(isItemsRequest(init) ? ITEMS_JSON : SUMMARY_JSON)
    )) as typeof fetch;
  try {
    const response = await handler(
      new Request('https://edge.example.test/parse-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({
          pdfBase64: await syntheticPdf(),
          mimeType: 'application/pdf',
          documentType: 'quote',
          installationId: INSTALLATION,
          operationId: '22222222-2222-4222-8222-222222222201',
          operationType: 'pdf_page_ai',
        }),
      })
    );
    assert.equal(response.status, 200);
    const body = JSON.parse(await response.text());
    assert.equal(body.aiCreditsRemaining, 2);
    assert.equal(ledger.getBalance(INSTALLATION), 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('se le righe non arrivano l intestazione resta valida', async () => {
  const outcome = await extractPdfWithGemini(
    'U1lOVEhFVElD',
    'SYNTHETIC_SERVER_KEY',
    'gemini-3.5-flash-lite',
    {
      fetchImpl: (_url, init) =>
        Promise.resolve(
          isItemsRequest(init)
            ? new Response('', { status: 503 })
            : geminiResponse(SUMMARY_JSON)
        ),
    }
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.itemsPassFailed, true);
  assert.equal(outcome.value.extract.documentNumber, 'PV-2026-0811');
  assert.equal(outcome.value.extract.items, undefined);
});

test('senza intestazione la richiesta fallisce anche con le righe presenti', async () => {
  const outcome = await extractPdfWithGemini(
    'U1lOVEhFVElD',
    'SYNTHETIC_SERVER_KEY',
    'gemini-3.5-flash-lite',
    {
      fetchImpl: (_url, init) =>
        Promise.resolve(
          isItemsRequest(init)
            ? geminiResponse(ITEMS_JSON)
            : new Response('', { status: 503 })
        ),
    }
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.errorCode, 'AI_PROVIDER_UNAVAILABLE');
});

test('la fusione è deterministica: intestazione dalla prima, righe dalla seconda', () => {
  const merged = mergePdfPasses(
    {
      rawText: 'INTESTAZIONE',
      documentNumber: 'PV-2026-0811',
      items: [{ description: 'RIGA FANTASMA' }],
      structured: { schemaVersion: 2, items: [{ description: { value: 'FANTASMA' } }] },
    },
    parsePdfItemsResponse(ITEMS_JSON)
  );
  assert.equal(merged.documentNumber, 'PV-2026-0811');
  assert.equal(merged.items?.length, 10);
  assert.equal(merged.items?.[0]?.description, 'Riga 1');
  assert.equal((merged.structured?.items as unknown[]).length, 10);
});

test('le righe della seconda passata non portano dati di intestazione', () => {
  const items = parsePdfItemsResponse(
    JSON.stringify({
      rawText: 'TESTO CHE NON DEVE PASSARE',
      documentNumber: 'ALTRO',
      total: 999,
      items: [{ description: 'Riga', quantity: 2, unitPrice: 50, lineTotal: 100 }],
    })
  );
  const merged = mergePdfPasses(
    { rawText: 'INTESTAZIONE', documentNumber: 'PV-2026-0811', total: 11568.65 },
    items
  );
  assert.equal(merged.rawText, 'INTESTAZIONE');
  assert.equal(merged.documentNumber, 'PV-2026-0811');
  assert.equal(merged.total, 11568.65);
  assert.deepEqual(merged.items, [
    { description: 'Riga', quantity: 2, unitPrice: 50, total: 100 },
  ]);
});

test('una tabella oltre il limite di righe viene rifiutata', () => {
  assert.equal(
    parsePdfItemsResponse(
      JSON.stringify({
        items: Array.from({ length: 251 }, () => ({ description: 'Riga' })),
      })
    ),
    null
  );
});

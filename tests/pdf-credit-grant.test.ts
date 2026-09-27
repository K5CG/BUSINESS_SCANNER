import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createParsePdfHandler } from '../supabase/functions/_shared/document-edge-handlers';
import { createEdgeTrafficControl } from '../supabase/functions/_shared/edge-request-guard';
import { countPdfPages } from '../supabase/functions/_shared/pdf-page-count';
import { AiCreditGuard } from '../supabase/functions/_shared/ai-credit-ledger';
import { InMemoryAiCreditLedger } from '../lib/ai-credit/ledger';

const ALLOWED_ORIGIN = 'https://scanner.example.test';
const INSTALLATION = '11111111-1111-4111-8111-111111111111';

function traffic() {
  return createEdgeTrafficControl(
    {
      rateLimit: 100,
      rateWindowMs: 60_000,
      maxConcurrent: 3,
      maxBuckets: 100,
      leaseTtlSeconds: 55,
    },
    { salt: 'SYNTHETIC_TEST_SALT' }
  );
}

async function syntheticPdf(): Promise<string> {
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  return Buffer.from(await document.save()).toString('base64');
}

/** Il registro vive nel processo: ogni test parte da un conto vuoto. */
function scenario(grantedCredits: number | null) {
  const ledger = new InMemoryAiCreditLedger();
  const grants: string[] = [];
  const handler = createParsePdfHandler({
    allowedOrigins: () => ALLOWED_ORIGIN,
    getApiKey: () => 'SYNTHETIC_SERVER_KEY',
    getModelConfiguration: () => ({ ok: true, model: 'gemini-3.5-flash-lite' }),
    traffic: traffic(),
    countPdfPages,
    creditGuard: new AiCreditGuard(ledger),
    extractPdf: () =>
      Promise.resolve({
        ok: true as const,
        value: {
          extract: { rawText: 'SYNTHETIC OCR' },
          timings: { summaryMs: 1, itemsMs: 1, totalMs: 1 },
        },
      }),
    ...(grantedCredits === null
      ? {}
      : {
          ensureCreditGrant: (installationId: string, licenseId: string | null) => {
            grants.push(installationId);
            if (ledger.getBalance(installationId) > 0) return;
            ledger.grant({
              installationId,
              licenseId,
              amount: grantedCredits,
              source: 'trial',
              referenceId: `trial:${installationId}`,
              operationId: `trial-grant:${installationId}`,
              transactionType: 'trial_grant',
            });
          },
        }),
  });
  return { handler, ledger, grants };
}

async function importPdf(
  handler: (request: Request) => Promise<Response>,
  operationId: string
) {
  const response = await handler(
    new Request('https://edge.example.test/parse-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
      body: JSON.stringify({
        pdfBase64: await syntheticPdf(),
        mimeType: 'application/pdf',
        pageCount: 1,
        documentType: 'quotation',
        installationId: INSTALLATION,
        operationId,
        operationType: 'pdf_page_ai',
      }),
    })
  );
  return { status: response.status, body: JSON.parse(await response.text()) };
}

test('senza dotazione iniziale ogni installazione viene respinta', async () => {
  const { handler } = scenario(null);
  const first = await importPdf(handler, '22222222-2222-4222-8222-222222222201');
  assert.equal(first.status, 402);
  assert.equal(first.body.errorCode, 'AI_CREDITS_INSUFFICIENT');
  assert.equal(first.body.aiCreditsRemaining, 0);
});

test('la dotazione iniziale sblocca la prima importazione', async () => {
  const { handler, grants } = scenario(5);
  const first = await importPdf(handler, '22222222-2222-4222-8222-222222222211');
  assert.equal(first.status, 200);
  assert.deepEqual(grants, [INSTALLATION]);
  assert.equal(first.body.aiCreditsRemaining, 4);
});

test('la dotazione non si ripete e il saldo cala a ogni importazione', async () => {
  const { handler, ledger } = scenario(2);
  const first = await importPdf(handler, '22222222-2222-4222-8222-222222222221');
  const second = await importPdf(handler, '22222222-2222-4222-8222-222222222222');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(ledger.getBalance(INSTALLATION), 0);
});

test('esaurita la dotazione la contabilita resta attiva', async () => {
  const { handler } = scenario(1);
  await importPdf(handler, '22222222-2222-4222-8222-222222222231');
  const exhausted = await importPdf(handler, '22222222-2222-4222-8222-222222222232');
  assert.equal(exhausted.status, 402);
  assert.equal(exhausted.body.errorCode, 'AI_CREDITS_INSUFFICIENT');
});

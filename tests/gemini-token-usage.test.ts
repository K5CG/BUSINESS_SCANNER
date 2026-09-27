import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateGeminiTokenUsage,
  buildGeminiTokenUsageReport,
  estimateGeminiCostUsd,
  parseGeminiUsageMetadata,
  toSafeTokenUsageDiagnostic,
} from '../supabase/functions/_shared/gemini-token-usage';
import { generateGeminiJson } from '../supabase/functions/_shared/gemini-provider';
import { extractPdfWithGemini } from '../supabase/functions/_shared/gemini-extract';

test('parseGeminiUsageMetadata reads standard Gemini fields', () => {
  const usage = parseGeminiUsageMetadata({
    candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
    usageMetadata: {
      promptTokenCount: 1200,
      candidatesTokenCount: 340,
      totalTokenCount: 1540,
      cachedContentTokenCount: 100,
      thoughtsTokenCount: 50,
    },
  });
  assert.deepEqual(usage, {
    promptTokenCount: 1200,
    candidatesTokenCount: 340,
    totalTokenCount: 1540,
    cachedContentTokenCount: 100,
    thoughtsTokenCount: 50,
  });
});

test('parseGeminiUsageMetadata ignores hostile / missing metadata', () => {
  assert.equal(parseGeminiUsageMetadata(null), undefined);
  assert.equal(parseGeminiUsageMetadata({ usageMetadata: { promptTokenCount: -1 } }), undefined);
  assert.equal(
    parseGeminiUsageMetadata({
      usageMetadata: { promptTokenCount: 'nope', secret: 'LEAK' },
    }),
    undefined
  );
});

test('aggregateGeminiTokenUsage sums PASS A + PASS B', () => {
  const aggregate = aggregateGeminiTokenUsage([
    { promptTokenCount: 10_000, candidatesTokenCount: 800, totalTokenCount: 10_800 },
    { promptTokenCount: 10_200, candidatesTokenCount: 1_200, totalTokenCount: 11_400 },
  ]);
  assert.deepEqual(aggregate, {
    promptTokenCount: 20_200,
    candidatesTokenCount: 2_000,
    totalTokenCount: 22_200,
  });
});

test('safe diagnostic never embeds document contents', () => {
  const report = buildGeminiTokenUsageReport({
    model: 'gemini-3.5-flash-lite',
    operationType: 'pdf_page_ai',
    pageCount: 2,
    creditsCharged: 2,
    calls: [
      {
        callType: 'pdf_summary',
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      },
      {
        callType: 'pdf_items',
        promptTokenCount: 110,
        candidatesTokenCount: 40,
        totalTokenCount: 150,
      },
    ],
  });
  const safe = JSON.stringify(toSafeTokenUsageDiagnostic(report));
  assert.equal(safe.includes('SECRET_CUSTOMER'), false);
  assert.equal(safe.includes('promptTokens'), true);
  assert.match(safe, /"creditsCharged":2/);
  assert.match(safe, /"pageCount":2/);
});

test('generateGeminiJson exposes usageMetadata passively', async () => {
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [{ text: 'x' }],
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: '{"rawText":"ok"}' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 7,
            totalTokenCount: 18,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.usage, {
    promptTokenCount: 11,
    candidatesTokenCount: 7,
    totalTokenCount: 18,
  });
  assert.equal(outcome.text.includes('ok'), true);
});

test('extractPdfWithGemini aggregates PASS A/B token usage', async () => {
  let calls = 0;
  const outcome = await extractPdfWithGemini(
    Buffer.from('%PDF-1.4').toString('base64'),
    'SYNTHETIC_SERVER_KEY',
    'gemini-3.5-flash-lite',
    {
      fetchImpl: async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init.body));
        const prompt = String(body.contents?.[0]?.parts?.[0]?.text ?? '');
        const isItems = /SOLO le righe commerciali|\"items\"/i.test(prompt);
        const text = isItems
          ? JSON.stringify({
              items: [
                {
                  description: 'Linea',
                  quantity: 1,
                  unitPrice: 1,
                  lineTotal: 1,
                },
              ],
            })
          : JSON.stringify({
              rawText: 'PREVENTIVO PV-1',
              documentNumber: 'PV-1',
            });
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text }] } }],
            usageMetadata: isItems
              ? {
                  promptTokenCount: 1100,
                  candidatesTokenCount: 200,
                  totalTokenCount: 1300,
                }
              : {
                  promptTokenCount: 1000,
                  candidatesTokenCount: 100,
                  totalTokenCount: 1100,
                },
          }),
          { status: 200 }
        );
      },
    }
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(calls, 2);
  assert.deepEqual(outcome.value.passTokenUsage?.summary, {
    promptTokenCount: 1000,
    candidatesTokenCount: 100,
    totalTokenCount: 1100,
  });
  assert.deepEqual(outcome.value.passTokenUsage?.items, {
    promptTokenCount: 1100,
    candidatesTokenCount: 200,
    totalTokenCount: 1300,
  });
  assert.deepEqual(outcome.value.passTokenUsage?.aggregate, {
    promptTokenCount: 2100,
    candidatesTokenCount: 300,
    totalTokenCount: 2400,
  });
  assert.deepEqual(outcome.usage, outcome.value.passTokenUsage?.aggregate);
});

test('estimateGeminiCostUsd uses paid flash-lite rates', () => {
  const cost = estimateGeminiCostUsd({
    model: 'gemini-3.5-flash-lite',
    promptTokenCount: 1_000_000,
    candidatesTokenCount: 1_000_000,
  });
  assert.ok(cost);
  assert.equal(cost.inputUsd, 0.3);
  assert.equal(cost.outputUsd, 2.5);
  assert.equal(cost.totalUsd, 2.8);
});

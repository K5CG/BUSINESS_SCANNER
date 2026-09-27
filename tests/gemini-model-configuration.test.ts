import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  resolveGeminiModelConfiguration,
  SUPPORTED_GEMINI_MODELS,
} from '../supabase/functions/_shared/gemini-model-config';
import {
  GEMINI_PROVIDER_TIMEOUT_MS,
  generateGeminiJson,
  geminiFailureHttpStatus,
  type GeminiFetch,
} from '../supabase/functions/_shared/gemini-provider';
import { extractWithGemini } from '../supabase/functions/_shared/gemini-extract';
import {
  structureCardWithGeminiVerbose,
} from '../supabase/functions/_shared/card-structure';

const VALID_RESPONSE = {
  candidates: [
    {
      content: {
        parts: [{ text: '{"rawText":"FIXTURE OCR"}' }],
      },
    },
  ],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('7B-01 modello Flash-Lite supportato e stabile', () => {
  assert.deepEqual(
    resolveGeminiModelConfiguration('gemini-3.5-flash-lite'),
    { ok: true, model: 'gemini-3.5-flash-lite' }
  );
});

test('7B-02 modello Flash supportato e stabile', () => {
  assert.deepEqual(
    resolveGeminiModelConfiguration('gemini-3.6-flash'),
    { ok: true, model: 'gemini-3.6-flash' }
  );
  assert.deepEqual(SUPPORTED_GEMINI_MODELS, [
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
  ]);
});

test('7B-03 modello assente fallisce esplicitamente', () => {
  assert.deepEqual(resolveGeminiModelConfiguration(undefined), {
    ok: false,
    errorCode: 'AI_MODEL_NOT_CONFIGURED',
  });
});

test('7B-04 modello vuoto fallisce esplicitamente', () => {
  assert.deepEqual(resolveGeminiModelConfiguration(' \r\n '), {
    ok: false,
    errorCode: 'AI_MODEL_NOT_CONFIGURED',
  });
});

test('7B-05 modello arbitrario non supportato', () => {
  assert.deepEqual(resolveGeminiModelConfiguration('gemini-custom'), {
    ok: false,
    errorCode: 'AI_MODEL_UNSUPPORTED',
  });
});

for (const [id, model] of [
  ['7B-06', 'gemini-1.5-flash'],
  ['7B-07', 'gemini-2.0-flash'],
  ['7B-08', 'gemini-2.5-flash'],
  ['7B-09', 'gemini-flash-latest'],
] as const) {
  test(`${id} modello obsoleto o alias mobile rifiutato: ${model}`, () => {
    assert.deepEqual(resolveGeminiModelConfiguration(model), {
      ok: false,
      errorCode: 'AI_MODEL_UNSUPPORTED',
    });
  });
}

test('7B-10 configurazione invalida non chiama il provider', async () => {
  let calls = 0;
  const fetchImpl: GeminiFetch = async () => {
    calls += 1;
    return jsonResponse(VALID_RESPONSE);
  };
  const config = resolveGeminiModelConfiguration('gemini-2.0-flash');
  if (config.ok) {
    await generateGeminiJson({
      model: config.model,
      apiKey: 'SYNTHETIC_SERVER_KEY',
      parts: [{ text: 'fixture' }],
      fetchImpl,
    });
  }
  assert.equal(calls, 0);
});

test('7B-11 richiesta valida usa modello e chiave solo server-side', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [{ text: 'fixture' }],
    fetchImpl: async (input, init) => {
      capturedUrl = input;
      capturedInit = init;
      return jsonResponse(VALID_RESPONSE);
    },
  });

  assert.deepEqual(outcome, {
    ok: true,
    text: '{"rawText":"FIXTURE OCR"}',
    httpStatus: 200,
  });
  assert.match(capturedUrl, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.doesNotMatch(capturedUrl, /[?&]key=/);
  assert.equal(
    new Headers(capturedInit?.headers).get('x-goog-api-key'),
    'SYNTHETIC_SERVER_KEY'
  );
});

test('7B-12 payload provider non usa parametri sampling deprecati', async () => {
  let requestBody = '';
  await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [{ text: 'fixture' }],
    fetchImpl: async (_input, init) => {
      requestBody = String(init.body);
      return jsonResponse(VALID_RESPONSE);
    },
  });
  const parsed = JSON.parse(requestBody) as Record<string, unknown>;
  assert.deepEqual(parsed.generationConfig, {
    responseMimeType: 'application/json',
  });
  assert.doesNotMatch(requestBody, /temperature|top_p|top_k/);
});

test('7B-13 errore rete classificato senza retry', async () => {
  let calls = 0;
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [],
    fetchImpl: async () => {
      calls += 1;
      throw new Error('SYNTHETIC_NETWORK_FAILURE');
    },
  });
  assert.deepEqual(outcome, {
    ok: false,
    errorCode: 'AI_PROVIDER_NETWORK_ERROR',
  });
  assert.equal(calls, 1);
});

test('7B-14 timeout provider classificato e richiesta abortita', async () => {
  let aborted = false;
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [],
    timeoutMs: 5,
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('ABORTED'));
        });
      }),
  });
  assert.equal(aborted, true);
  assert.deepEqual(outcome, {
    ok: false,
    errorCode: 'AI_PROVIDER_TIMEOUT',
  });
  assert.equal(geminiFailureHttpStatus('AI_PROVIDER_TIMEOUT'), 504);
});

test('7B-14b timeout copre anche un body JSON sospeso', async () => {
  let bodyAborted = false;
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [],
    timeoutMs: 5,
    fetchImpl: async (_input, init) => {
      const signal = init.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        json: async () =>
          new Promise<unknown>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              bodyAborted = true;
              reject(new Error('BODY_ABORTED'));
            });
          }),
      } as Response;
    },
  });
  assert.equal(bodyAborted, true);
  assert.deepEqual(outcome, {
    ok: false,
    errorCode: 'AI_PROVIDER_TIMEOUT',
  });
});

test('7B-14c timeout server termina prima del timeout client', () => {
  const clientSource = fs.readFileSync(
    path.join(process.cwd(), 'lib/supabase-functions.ts'),
    'utf8'
  );
  const clientTimeout = Number(
    clientSource.match(/DOCUMENT_FUNCTION_TIMEOUT_MS\s*=\s*([\d_]+)/)?.[1]
      ?.replaceAll('_', '')
  );
  assert.equal(GEMINI_PROVIDER_TIMEOUT_MS, 12_000);
  assert.ok(Number.isFinite(clientTimeout));
  assert.ok(GEMINI_PROVIDER_TIMEOUT_MS < clientTimeout);
});

for (const fixture of [
  {
    id: '7B-15',
    status: 404,
    errorCode: 'AI_MODEL_NOT_FOUND',
    clientStatus: 502,
  },
  {
    id: '7B-16',
    status: 429,
    errorCode: 'AI_PROVIDER_RATE_LIMITED',
    clientStatus: 429,
  },
  {
    id: '7B-17',
    status: 500,
    errorCode: 'AI_PROVIDER_UNAVAILABLE',
    clientStatus: 503,
  },
  {
    id: '7B-18',
    status: 403,
    errorCode: 'AI_PROVIDER_REJECTED',
    clientStatus: 502,
  },
] as const) {
  test(`${fixture.id} HTTP ${fixture.status} classificato senza fallback`, async () => {
    let calls = 0;
    const outcome = await generateGeminiJson({
      model: 'gemini-3.5-flash-lite',
      apiKey: 'SYNTHETIC_SERVER_KEY',
      parts: [],
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ error: 'BODY_MUST_NOT_ESCAPE' }, fixture.status);
      },
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.errorCode, fixture.errorCode);
    assert.equal(outcome.httpStatus, fixture.status);
    assert.equal(
      geminiFailureHttpStatus(outcome.errorCode),
      fixture.clientStatus
    );
    assert.equal(JSON.stringify(outcome).includes('BODY_MUST_NOT_ESCAPE'), false);
    assert.equal(calls, 1);
  });
}

test('7B-19 risposta non JSON è rifiutata', async () => {
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [],
    fetchImpl: async () => new Response('not-json', { status: 200 }),
  });
  assert.deepEqual(outcome, {
    ok: false,
    errorCode: 'AI_PROVIDER_RESPONSE_INVALID',
  });
});

test('7B-20 risposta senza testo candidato è rifiutata', async () => {
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [],
    fetchImpl: async () => jsonResponse({ candidates: [] }),
  });
  assert.deepEqual(outcome, {
    ok: false,
    errorCode: 'AI_PROVIDER_RESPONSE_INVALID',
  });
});

for (const [id, payload] of [
  ['7B-20b', null],
  [
    '7B-20c',
    { candidates: [{ content: { parts: [null] } }] },
  ],
  [
    '7B-20d',
    { candidates: [{ content: { parts: {} } }] },
  ],
] as const) {
  test(`${id} risposta JSON strutturalmente ostile è rifiutata`, async () => {
    const outcome = await generateGeminiJson({
      model: 'gemini-3.5-flash-lite',
      apiKey: 'SYNTHETIC_SERVER_KEY',
      parts: [],
      fetchImpl: async () => jsonResponse(payload),
    });
    assert.deepEqual(outcome, {
      ok: false,
      errorCode: 'AI_PROVIDER_RESPONSE_INVALID',
    });
  });
}

test('7B-21 estrazione documentale effettua una sola chiamata', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse(VALID_RESPONSE);
  };
  try {
    const outcome = await extractWithGemini(
      [{ text: 'fixture' }],
      'SYNTHETIC_SERVER_KEY',
      'gemini-3.5-flash-lite'
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.value.rawText, 'FIXTURE OCR');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('7B-22 strutturazione biglietto usa lo stesso modello centrale', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return jsonResponse({
      candidates: [
        {
          content: {
            parts: [{ text: '{"company":"FIXTURE COMPANY"}' }],
          },
        },
      ],
    });
  };
  try {
    const outcome = await structureCardWithGeminiVerbose(
      'FIXTURE COMPANY',
      'SYNTHETIC_SERVER_KEY',
      'gemini-3.6-flash'
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.value.company, 'FIXTURE COMPANY');
    assert.match(requestedUrl, /models\/gemini-3\.6-flash:generateContent$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function runtimeSource(relativePath: string): string {
  const absolute = path.join(process.cwd(), relativePath);
  if (!fs.existsSync(absolute)) return '';
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return fs.readFileSync(absolute, 'utf8');
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules')
    .map((entry) => runtimeSource(path.join(relativePath, entry.name)))
    .join('\n');
}

test('7B-23 nessun modello obsoleto o alias latest resta nel runtime', () => {
  const source = [
    runtimeSource('lib'),
    runtimeSource('app'),
    runtimeSource('components'),
    runtimeSource('supabase/functions'),
    runtimeSource('app.config.js'),
  ].join('\n');
  assert.doesNotMatch(
    source,
    /gemini-(?:1\.5|2\.0|2\.5)(?:[-'"]|$)|gemini-flash-latest/
  );
  assert.doesNotMatch(source, /AI_CARD_MODEL/);
});

test('7B-24 client senza chiave, modello o chiamata Gemini diretta', () => {
  const clientSource = [
    runtimeSource('lib'),
    runtimeSource('app'),
    runtimeSource('components'),
    runtimeSource('app.config.js'),
    runtimeSource('.env.example'),
  ].join('\n');
  assert.doesNotMatch(clientSource, /EXPO_PUBLIC_GEMINI/);
  assert.doesNotMatch(clientSource, /getGeminiApiKey|GEMINI_FALLBACK_MODELS/);
  assert.doesNotMatch(clientSource, /generativelanguage\.googleapis\.com/);
});

test('7B-25 il client parse-document non invia il modello', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'lib/gemini-ocr.ts'),
    'utf8'
  );
  assert.match(source, /callSupabaseFunction<unknown>\(\s*'parse-document'/);
  assert.doesNotMatch(source, /\bmodel\b/i);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test('7B-26 i tre endpoint usano solo GEMINI_MODEL server-side', () => {
  for (const endpoint of [
    'supabase/functions/parse-document/index.ts',
    'supabase/functions/parse-pdf/index.ts',
    'supabase/functions/structure-business-card/index.ts',
  ]) {
    const source = fs.readFileSync(path.join(process.cwd(), endpoint), 'utf8');
    assert.match(source, /Deno\.env\.get\('GEMINI_MODEL'\)/);
    assert.match(source, /resolveGeminiModelConfiguration/);
    assert.doesNotMatch(source, /body\.(?:model|geminiModel)/);
  }
});

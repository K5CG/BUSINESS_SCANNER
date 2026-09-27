import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import {
  createParseDocumentHandler,
  createParsePdfHandler,
  createStructureCardHandler,
  type ParseDocumentHandlerDependencies,
} from '../supabase/functions/_shared/document-edge-handlers';
import { withEdgeDatabaseDeadline } from '../supabase/functions/_shared/edge-database-deadline';
import {
  IMAGE_MIME_TYPES,
  MAX_CARD_OCR_CHARS,
  MAX_DOCUMENT_RAW_TEXT_CHARS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_REQUEST_BYTES,
  MAX_IMAGE_SIDE,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  MAX_PROVIDER_RESPONSE_BYTES,
  createDatabaseEdgeTrafficControl,
  createEdgeTrafficControl,
  decodeStrictBase64,
  isStructurallyValidImage,
  readBoundedJsonObject,
  type DatabaseTrafficAcquireParams,
  type EdgeTrafficConfig,
} from '../supabase/functions/_shared/edge-request-guard';
import { parseJsonResponse } from '../supabase/functions/_shared/gemini-extract';
import { generateGeminiJson } from '../supabase/functions/_shared/gemini-provider';
import { countPdfPages } from '../supabase/functions/_shared/pdf-page-count';

const ALLOWED_ORIGIN = 'https://scanner.example.test';
const JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z';
const PROGRESSIVE_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAAwAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAVAQEBAAAAAAAAAAAAAAAAAAAAA//aAAwDAQACEAMQAAABmYpMAAAAAAAAAAD/xAAUEAEAAAAAAAAAAAAAAAAAAABQ/9oACAEBAAEFAkP/xAAUEQEAAAAAAAAAAAAAAAAAAAAw/9oACAEDAQE/AU//xAAUEQEAAAAAAAAAAAAAAAAAAAAw/9oACAECAQE/AU//xAAUEAEAAAAAAAAAAAAAAAAAAABQ/9oACAEBAAY/AkP/xAAUEAEAAAAAAAAAAAAAAAAAAABQ/9oACAEBAAE/IUP/2gAMAwEAAgADAAAAEPffffffffffff/EABQRAQAAAAAAAAAAAAAAAAAAADD/2gAIAQMBAT8QT//EABQRAQAAAAAAAAAAAAAAAAAAADD/2gAIAQIBAT8QT//EABQQAQAAAAAAAAAAAAAAAAAAAFD/2gAIAQEAAT8QQ//Z';

const DEFAULT_TRAFFIC: EdgeTrafficConfig = {
  rateLimit: 100,
  rateWindowMs: 60_000,
  maxConcurrent: 3,
  maxBuckets: 100,
  leaseTtlSeconds: 55,
};

function traffic(
  overrides: Partial<EdgeTrafficConfig> = {}
) {
  return createEdgeTrafficControl(
    { ...DEFAULT_TRAFFIC, ...overrides },
    { salt: 'SYNTHETIC_TEST_SALT' }
  );
}

function successfulExtract() {
  return Promise.resolve({
    ok: true as const,
    value: { rawText: 'SYNTHETIC OCR' },
  });
}

/** L'import PDF chiama Gemini due volte: intestazione e righe. */
function successfulPdfExtract() {
  return Promise.resolve({
    ok: true as const,
    value: {
      extract: { rawText: 'SYNTHETIC OCR' },
      timings: { summaryMs: 1, itemsMs: 1, totalMs: 1 },
    },
  });
}

function documentDependencies(
  overrides: Partial<ParseDocumentHandlerDependencies> = {}
): ParseDocumentHandlerDependencies {
  return {
    allowedOrigins: () => ALLOWED_ORIGIN,
    getApiKey: () => 'SYNTHETIC_SERVER_KEY',
    getModelConfiguration: () => ({
      ok: true,
      model: 'gemini-3.5-flash-lite',
    }),
    traffic: traffic(),
    extract: successfulExtract,
    ...overrides,
  };
}

function imageRequest(
  body: Record<string, unknown> = {
    imageBase64: JPEG_BASE64,
    mimeType: 'image/jpeg',
    pageIndex: 0,
    pageCount: 1,
  },
  options: {
    method?: string;
    origin?: string | null;
    contentType?: string | null;
    headers?: Record<string, string>;
  } = {}
): Request {
  const method = options.method ?? 'POST';
  const headers = new Headers(options.headers);
  if (options.contentType !== null) {
    headers.set(
      'Content-Type',
      options.contentType ?? 'application/json'
    );
  }
  if (options.origin !== null) {
    headers.set('Origin', options.origin ?? ALLOWED_ORIGIN);
  }
  return new Request('https://edge.example.test/parse-document', {
    method,
    headers,
    ...(method === 'GET' || method === 'OPTIONS'
      ? {}
      : { body: JSON.stringify(body) }),
  });
}

async function responseBody(
  response: Response
): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function syntheticPdf(pageCount: number): Promise<string> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([100, 100]);
  }
  return Buffer.from(await document.save()).toString('base64');
}

async function waitForTestSignal(
  signal: Promise<void>,
  timeoutMs = 1_000
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('TEST_SIGNAL_TIMEOUT')),
      timeoutMs
    );
  });
  try {
    await Promise.race([signal, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test('7C-01 OPTIONS consentito non consuma provider o rate limit', async () => {
  let providerCalls = 0;
  const guard = traffic({ rateLimit: 1 });
  const handler = createParseDocumentHandler(
    documentDependencies({
      traffic: guard,
      extract: async () => {
        providerCalls += 1;
        return successfulExtract();
      },
    })
  );

  const response = await handler(
    imageRequest({}, { method: 'OPTIONS' })
  );
  assert.equal(response.status, 204);
  assert.equal(providerCalls, 0);
  assert.equal(guard.bucketCount(), 0);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    ALLOWED_ORIGIN
  );
});

test('7C-02 GET è rifiutato con 405 e Allow', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(imageRequest({}, { method: 'GET' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
  assert.equal((await responseBody(response)).errorCode, 'METHOD_NOT_ALLOWED');
});

test('7C-03 POST immagine valido chiama il provider una sola volta', async () => {
  let calls = 0;
  const handler = createParseDocumentHandler(
    documentDependencies({
      extract: async (parts) => {
        calls += 1;
        assert.match(parts[1]?.text ?? '', /pageIndex=0/);
        assert.equal(parts[2]?.inline_data?.mime_type, 'image/jpeg');
        assert.equal(parts[2]?.inline_data?.data, JPEG_BASE64);
        return successfulExtract();
      },
    })
  );
  const response = await handler(imageRequest());
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal((await responseBody(response)).rawText, 'SYNTHETIC OCR');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('7C-03b impone la provenienza pagina reale sul payload strutturato', async () => {
  const handler = createParseDocumentHandler(documentDependencies({
    extract: async (parts) => {
      assert.match(parts[1]?.text ?? '', /Pagina 2 di 3/);
      return {
        ok: true as const,
        value: {
          rawText: 'PAGINA DUE',
          structured: {
            document: { documentNumber: { value: 'K-1', pageIndex: 0, evidenceText: 'K-1' } },
            items: [{ description: { value: 'Riga', pageIndex: 0, evidenceText: 'Riga' }, pageIndex: 0, evidenceText: 'Riga' }],
            summary: { taxSummaries: [{ vatRate: { value: 22, pageIndex: 0, evidenceText: '22%' }, pageIndex: 0, requiresReview: true }] },
          },
        },
      };
    },
  }));
  const response = await handler(imageRequest({ imageBase64: JPEG_BASE64, mimeType: 'image/jpeg', pageIndex: 1, pageCount: 3 }));
  const body = await responseBody(response);
  const structured = body.structured as { document: { documentNumber: { pageIndex: number } }; items: Array<{ pageIndex: number; description: { pageIndex: number } }>; summary: { taxSummaries: Array<{ pageIndex: number; vatRate: { pageIndex: number } }> } };
  assert.equal(structured.document.documentNumber.pageIndex, 1);
  assert.equal(structured.items[0].pageIndex, 1);
  assert.equal(structured.items[0].description.pageIndex, 1);
  assert.equal(structured.summary.taxSummaries[0].pageIndex, 1);
  assert.equal(structured.summary.taxSummaries[0].vatRate.pageIndex, 1);
});

test('7C-04 Content-Type errato è rifiutato prima del provider', async () => {
  let calls = 0;
  const response = await createParseDocumentHandler(
    documentDependencies({
      extract: async () => {
        calls += 1;
        return successfulExtract();
      },
    })
  )(imageRequest(undefined, { contentType: 'text/plain' }));
  assert.equal(response.status, 415);
  assert.equal(calls, 0);
  assert.equal(
    (await responseBody(response)).errorCode,
    'CONTENT_TYPE_REQUIRED'
  );
});

test('7C-05 payload vuoto è rifiutato', async () => {
  const request = new Request('https://edge.example.test/parse-document', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ALLOWED_ORIGIN,
    },
    body: '',
  });
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(request);
  assert.equal(response.status, 400);
  assert.equal((await responseBody(response)).errorCode, 'EMPTY_PAYLOAD');
});

test('7C-05b JSON malformato è rifiutato come input, non come errore server', async () => {
  const request = new Request('https://edge.example.test/parse-document', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Origin: ALLOWED_ORIGIN,
    },
    body: '{"imageBase64":',
  });
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(request);
  assert.equal(response.status, 400);
  assert.equal((await responseBody(response)).errorCode, 'INVALID_JSON');
});

test('7C-06 Content-Length sopra il limite fallisce prima della lettura', async () => {
  const request = imageRequest(undefined, {
    headers: {
      'Content-Length': String(MAX_IMAGE_REQUEST_BYTES + 1),
    },
  });
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(request);
  assert.equal(response.status, 413);
  assert.equal((await responseBody(response)).errorCode, 'PAYLOAD_TOO_LARGE');
});

test('7C-06b stream senza Content-Length resta limitato', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  const request = new Request('https://edge.example.test/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const outcome = await readBoundedJsonObject(request, 12);
  assert.deepEqual(outcome, {
    ok: false,
    status: 413,
    errorCode: 'PAYLOAD_TOO_LARGE',
  });
});

test('7C-06c body sospeso scade lato server', async () => {
  const stream = new ReadableStream<Uint8Array>({ pull() {} });
  const request = new Request('https://edge.example.test/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  const outcome = await readBoundedJsonObject(request, 1024, 5);
  assert.deepEqual(outcome, {
    ok: false,
    status: 408,
    errorCode: 'REQUEST_BODY_TIMEOUT',
  });
});

test('7C-07 PDF oltre il limite pagine è rifiutato dal parser reale', async () => {
  let providerCalls = 0;
  const pdfBase64 = await syntheticPdf(MAX_PDF_PAGES + 1);
  const handler = createParsePdfHandler({
    ...documentDependencies(),
    countPdfPages,
    extractPdf: async () => {
      providerCalls += 1;
      return successfulPdfExtract();
    },
  });
  const response = await handler(
    new Request('https://edge.example.test/parse-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        pdfBase64,
        mimeType: 'application/pdf',
      }),
    })
  );
  assert.equal(response.status, 413);
  assert.equal(providerCalls, 0);
  assert.equal(
    (await responseBody(response)).errorCode,
    'PDF_PAGE_LIMIT_EXCEEDED'
  );
});

test('7C-07b PDF valido entro il limite raggiunge il provider', async () => {
  const pdfBase64 = await syntheticPdf(2);
  const handler = createParsePdfHandler({
    ...documentDependencies(),
    countPdfPages,
    extractPdf: successfulPdfExtract,
  });
  const response = await handler(
    new Request('https://edge.example.test/parse-pdf', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        pdfBase64,
        mimeType: 'application/pdf',
      }),
    })
  );
  assert.equal(response.status, 200);
});

test('7C-08 MIME non consentito è rifiutato', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(
    imageRequest({
      imageBase64: JPEG_BASE64,
      mimeType: 'image/gif',
    })
  );
  assert.equal(response.status, 415);
  assert.equal(
    (await responseBody(response)).errorCode,
    'UNSUPPORTED_MIME_TYPE'
  );
});

test('7C-09 campo obbligatorio mancante è rifiutato', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(imageRequest({ mimeType: 'image/jpeg' }));
  assert.equal(response.status, 400);
  assert.equal((await responseBody(response)).errorCode, 'INVALID_BASE64');
});

test('7C-10 base64 invalido è rifiutato', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(
    imageRequest({
      imageBase64: 'not-base64',
      mimeType: 'image/jpeg',
    })
  );
  assert.equal(response.status, 400);
  assert.equal((await responseBody(response)).errorCode, 'INVALID_BASE64');
});

test('7C-10b firma media non coerente col MIME è rifiutata', async () => {
  const pngHeader = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]).toString('base64');
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(
    imageRequest({
      imageBase64: pngHeader,
      mimeType: 'image/jpeg',
    })
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await responseBody(response)).errorCode,
    'MEDIA_SIGNATURE_MISMATCH'
  );
});

test('7C-10c immagine con soli magic byte è rifiutata come malformata', async () => {
  const truncatedJpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9,
  ]).toString('base64');
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(
    imageRequest({
      imageBase64: truncatedJpeg,
      mimeType: 'image/jpeg',
    })
  );
  assert.equal(response.status, 400);
  assert.equal(
    (await responseBody(response)).errorCode,
    'MEDIA_SIGNATURE_MISMATCH'
  );
});

test('7C-10d PNG con CRC falsi e WebP senza frame sono rifiutati', () => {
  const invalidPng = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x44, 0x41, 0x54,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const emptyWebp = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x0c, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    0x00, 0x00, 0x00, 0x00,
  ]);
  assert.equal(
    isStructurallyValidImage(invalidPng, 'image/png'),
    false
  );
  assert.equal(
    isStructurallyValidImage(emptyWebp, 'image/webp'),
    false
  );
});

test('7C-10e endpoint immagini ammette solo il JPEG prodotto dal client', async () => {
  assert.deepEqual(IMAGE_MIME_TYPES, ['image/jpeg']);
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(
    imageRequest({
      imageBase64: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).toString('base64'),
      mimeType: 'image/png',
    })
  );
  assert.equal(response.status, 415);
  assert.equal(
    (await responseBody(response)).errorCode,
    'UNSUPPORTED_MIME_TYPE'
  );
});

test('7C-10f JPEG richiede tabelle, riferimenti e marker coerenti', () => {
  const valid = Uint8Array.from(Buffer.from(JPEG_BASE64, 'base64'));
  assert.equal(isStructurallyValidImage(valid, 'image/jpeg'), true);
  assert.equal(MAX_IMAGE_SIDE, 2_600);
  assert.equal(MAX_IMAGE_PIXELS, 8_000_000);

  const withoutFirstQuantizationTable = valid.slice();
  const firstDqt = withoutFirstQuantizationTable.findIndex(
    (value, index) =>
      value === 0xff && withoutFirstQuantizationTable[index + 1] === 0xdb
  );
  withoutFirstQuantizationTable[firstDqt + 1] = 0xe1;
  assert.equal(
    isStructurallyValidImage(
      withoutFirstQuantizationTable,
      'image/jpeg'
    ),
    false
  );

  const withoutHuffmanTables = valid.slice();
  for (let index = 0; index < withoutHuffmanTables.length - 1; index += 1) {
    if (
      withoutHuffmanTables[index] === 0xff &&
      withoutHuffmanTables[index + 1] === 0xc4
    ) {
      withoutHuffmanTables[index + 1] = 0xe1;
    }
  }
  assert.equal(
    isStructurallyValidImage(withoutHuffmanTables, 'image/jpeg'),
    false
  );

  const undefinedScanTables = valid.slice();
  const scanMarker = undefinedScanTables.findIndex(
    (value, index) =>
      value === 0xff && undefinedScanTables[index + 1] === 0xda
  );
  undefinedScanTables[scanMarker + 6] = 0x22;
  assert.equal(
    isStructurallyValidImage(undefinedScanTables, 'image/jpeg'),
    false
  );

  const oversizedFrame = valid.slice();
  const frameMarker = oversizedFrame.findIndex(
    (value, index) =>
      value === 0xff && oversizedFrame[index + 1] === 0xc0
  );
  oversizedFrame[frameMarker + 7] = 0x0a;
  oversizedFrame[frameMarker + 8] = 0x29;
  assert.equal(
    isStructurallyValidImage(oversizedFrame, 'image/jpeg'),
    false
  );

  const invalidEntropyMarker = valid.slice();
  const scanLength =
    invalidEntropyMarker[scanMarker + 2] * 0x100 +
    invalidEntropyMarker[scanMarker + 3];
  const entropyStart = scanMarker + 2 + scanLength;
  invalidEntropyMarker[entropyStart] = 0xff;
  invalidEntropyMarker[entropyStart + 1] = 0x01;
  assert.equal(
    isStructurallyValidImage(invalidEntropyMarker, 'image/jpeg'),
    false
  );
});

test('7C-10g JPEG progressivo valido mantiene compatibilità', () => {
  assert.equal(
    isStructurallyValidImage(
      Uint8Array.from(Buffer.from(PROGRESSIVE_JPEG_BASE64, 'base64')),
      'image/jpeg'
    ),
    true
  );
});

for (const fixture of [
  {
    id: '7C-11',
    code: 'AI_PROVIDER_TIMEOUT' as const,
    expectedStatus: 504,
  },
  {
    id: '7C-12',
    code: 'AI_PROVIDER_RATE_LIMITED' as const,
    expectedStatus: 429,
  },
  {
    id: '7C-13',
    code: 'AI_PROVIDER_UNAVAILABLE' as const,
    expectedStatus: 503,
  },
]) {
  test(`${fixture.id} errore provider ${fixture.code} resta sanitizzato`, async () => {
    const response = await createParseDocumentHandler(
      documentDependencies({
        extract: async () => ({
          ok: false,
          errorCode: fixture.code,
          httpStatus:
            fixture.code === 'AI_PROVIDER_RATE_LIMITED' ? 429 : 500,
        }),
      })
    )(imageRequest());
    assert.equal(response.status, fixture.expectedStatus);
    const text = await response.text();
    assert.match(text, new RegExp(fixture.code));
    assert.doesNotMatch(text, /Google|Gemini|upstream|SYNTHETIC_SERVER_KEY/);
  });
}

test('7C-14 risposta provider oltre il limite è interrotta', async () => {
  const outcome = await generateGeminiJson({
    model: 'gemini-3.5-flash-lite',
    apiKey: 'SYNTHETIC_SERVER_KEY',
    parts: [],
    maxResponseBytes: 32,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"rawText":"TOO LARGE"}' }],
              },
            },
          ],
        })
      ),
  });
  assert.deepEqual(outcome, {
    ok: false,
    errorCode: 'AI_PROVIDER_RESPONSE_TOO_LARGE',
  });
});

test('7C-14b rawText oltre il limite non attraversa il parser', () => {
  const result = parseJsonResponse(
    JSON.stringify({
      rawText: 'x'.repeat(MAX_DOCUMENT_RAW_TEXT_CHARS + 1),
    })
  );
  assert.equal(result, null);
});

test('7C-14c risposta Edge serializzata rispetta il tetto client', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies({
      extract: async () => ({
        ok: true,
        value: {
          rawText: 'SYNTHETIC OCR',
          documentNumber: 'x'.repeat(MAX_PROVIDER_RESPONSE_BYTES),
        },
      }),
    })
  )(imageRequest());
  assert.equal(response.status, 502);
  assert.equal(
    (await responseBody(response)).errorCode,
    'AI_PROVIDER_RESPONSE_TOO_LARGE'
  );
});

test('7C-15 eccezione interna restituisce solo errore catalogato', async () => {
  const originalError = console.error;
  console.error = () => undefined;
  let response: Response;
  try {
    response = await createParseDocumentHandler(
      documentDependencies({
        extract: async () => {
          throw new Error(
            'PROVIDER_SECRET_DETAIL person@example.invalid'
          );
        },
      })
    )(imageRequest());
  } finally {
    console.error = originalError;
  }
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.match(text, /DOCUMENT_PARSE_FAILED/);
  assert.doesNotMatch(text, /PROVIDER_SECRET_DETAIL|example\.invalid/);
});

test('7C-16 i log di errore non contengono payload, prompt o secret', async () => {
  const captured: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    captured.push(values);
  };
  try {
    await createParseDocumentHandler(
      documentDependencies({
        extract: async () => {
          throw new Error('PRIVATE_PROVIDER_DETAIL');
        },
      })
    )(imageRequest());
  } finally {
    console.error = originalError;
  }
  const serialized = JSON.stringify(captured);
  assert.doesNotMatch(
    serialized,
    new RegExp(
      `${JPEG_BASE64}|PRIVATE_PROVIDER_DETAIL|SYNTHETIC_SERVER_KEY`
    )
  );
  assert.match(serialized, /DOCUMENT_PARSE_FAILED/);
});

test('7C-17 rate limit breve restituisce 429 e Retry-After', async () => {
  const guard = traffic({ rateLimit: 1 });
  const handler = createParseDocumentHandler(
    documentDependencies({ traffic: guard })
  );
  const headers = { 'X-Forwarded-For': '192.0.2.10' };
  assert.equal(
    (await handler(imageRequest(undefined, { headers }))).status,
    200
  );
  const limited = await handler(imageRequest(undefined, { headers }));
  assert.equal(limited.status, 429);
  assert.equal((await responseBody(limited)).errorCode, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('7C-18 concorrenza eccessiva è rifiutata e poi rilasciata', async () => {
  let resolveFirst:
    | ((value: Awaited<ReturnType<typeof successfulExtract>>) => void)
    | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let calls = 0;
  const handler = createParseDocumentHandler(
    documentDependencies({
      traffic: traffic({ maxConcurrent: 1 }),
      extract: async () => {
        calls += 1;
        if (calls > 1) return successfulExtract();
        markStarted?.();
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
    })
  );

  const first = handler(imageRequest());
  await waitForTestSignal(started);
  const busy = await handler(imageRequest());
  assert.equal(busy.status, 429);
  assert.equal(
    (await responseBody(busy)).errorCode,
    'CONCURRENCY_LIMITED'
  );
  resolveFirst?.(await successfulExtract());
  assert.equal((await first).status, 200);
  assert.equal((await handler(imageRequest())).status, 200);
});

test('7C-18b gate DB fallisce chiuso senza sale server valido', async () => {
  let acquireCalls = 0;
  const guard = createDatabaseEdgeTrafficControl(DEFAULT_TRAFFIC, {
    fingerprintSalt: 'too-short',
    acquire: async () => {
      acquireCalls += 1;
      return null;
    },
    release: async () => undefined,
  });
  const admission = await guard.enter(
    imageRequest(undefined, {
      headers: { 'X-Forwarded-For': '192.0.2.40' },
    })
  );
  assert.equal(admission.allowed, false);
  if (!admission.allowed) {
    assert.equal(admission.reason, 'security_unavailable');
  }
  assert.equal(acquireCalls, 0);

  const response = await createParseDocumentHandler(
    documentDependencies({ traffic: guard })
  )(imageRequest());
  assert.equal(response.status, 503);
  assert.equal(
    (await responseBody(response)).errorCode,
    'EDGE_SECURITY_UNAVAILABLE'
  );
});

test('7C-18c gate DB usa HMAC e rilascia la lease una sola volta', async () => {
  const seen: DatabaseTrafficAcquireParams[] = [];
  const released: string[] = [];
  const leaseId = '019f947e-a04f-47f1-abf3-e074b0cd9ba6';
  const guard = createDatabaseEdgeTrafficControl(DEFAULT_TRAFFIC, {
    fingerprintSalt: 'synthetic-server-secret-at-least-32-chars',
    acquire: async (params) => {
      seen.push(params);
      return [{
        allowed: true,
        reason: 'allowed',
        retry_after_seconds: 0,
        lease_id: leaseId,
      }];
    },
    release: async (value) => {
      released.push(value);
    },
  });
  const admission = await guard.enter(
    imageRequest(undefined, {
      headers: { 'X-Forwarded-For': '192.0.2.41' },
    })
  );
  assert.equal(admission.allowed, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.scope, 'gemini');
  assert.match(String(seen[0]?.fingerprint), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(String(seen[0]?.fingerprint), /192\.0\.2\.41/);
  assert.equal(seen[0]?.leaseSeconds, 55);
  if (admission.allowed) {
    await admission.release();
    await admission.release();
  }
  assert.deepEqual(released, [leaseId]);
});

test('7C-18d gate DB traduce rate e concorrenza e fallisce chiuso su RPC', async () => {
  for (const reason of ['rate_limited', 'concurrency_limited'] as const) {
    const guard = createDatabaseEdgeTrafficControl(DEFAULT_TRAFFIC, {
      fingerprintSalt: 'synthetic-server-secret-at-least-32-chars',
      acquire: async () => [{
        allowed: false,
        reason,
        retry_after_seconds: 7,
        lease_id: null,
      }],
      release: async () => undefined,
    });
    const admission = await guard.enter(imageRequest());
    assert.equal(admission.allowed, false);
    if (!admission.allowed) {
      assert.equal(admission.reason, reason);
      assert.equal(admission.retryAfterSeconds, 7);
    }
  }

  const unavailable = createDatabaseEdgeTrafficControl(DEFAULT_TRAFFIC, {
    fingerprintSalt: 'synthetic-server-secret-at-least-32-chars',
    acquire: async () => {
      throw new Error('SYNTHETIC_DATABASE_FAILURE');
    },
    release: async () => undefined,
  });
  const admission = await unavailable.enter(imageRequest());
  assert.equal(admission.allowed, false);
  if (!admission.allowed) {
    assert.equal(admission.reason, 'security_unavailable');
  }
});

test('7C-18e deadline DB abortisce e fallisce chiusa', async () => {
  let aborted = false;
  await assert.rejects(
    withEdgeDatabaseDeadline(
      (signal) =>
        new Promise<void>(() => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true }
          );
        }),
      5
    ),
    /EDGE_DATABASE_TIMEOUT/
  );
  assert.equal(aborted, true);
});

test('7C-19 CORS consente solo origine web in allowlist', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(imageRequest());
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('access-control-allow-origin'),
    ALLOWED_ORIGIN
  );
  assert.equal(response.headers.get('vary'), 'Origin');
});

test('7C-20 CORS nega origine web estranea', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(
    imageRequest(undefined, {
      origin: 'https://attacker.example.test',
    })
  );
  assert.equal(response.status, 403);
  assert.equal(
    (await responseBody(response)).errorCode,
    'CORS_ORIGIN_DENIED'
  );
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('7C-21 app nativa senza Origin è ammessa senza wildcard CORS', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(imageRequest(undefined, { origin: null }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('7C-22 schema stretto rifiuta scelta modello dal client', async () => {
  const response = await createParseDocumentHandler(
    documentDependencies()
  )(
    imageRequest({
      imageBase64: JPEG_BASE64,
      mimeType: 'image/jpeg',
      model: 'gemini-client-choice',
    })
  );
  assert.equal(response.status, 400);
  assert.equal((await responseBody(response)).errorCode, 'INVALID_REQUEST');
});

test('7C-23 limite OCR business card è applicato server-side', async () => {
  let calls = 0;
  const handler = createStructureCardHandler({
    ...documentDependencies(),
    isWithinDailyQuota: async () => true,
    structure: async () => {
      calls += 1;
      return { ok: true, value: { company: 'SYNTHETIC' } };
    },
  });
  const response = await handler(
    new Request('https://edge.example.test/structure-business-card', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({
        ocrText: 'x'.repeat(MAX_CARD_OCR_CHARS + 1),
      }),
    })
  );
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('7C-24 decodifica base64 impone il limite sui byte reali', () => {
  assert.deepEqual(decodeStrictBase64('AA==', 0), {
    ok: false,
    status: 413,
    errorCode: 'FILE_TOO_LARGE',
  });
  const accepted = decodeStrictBase64('AA==', 1);
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual([...accepted.value], [0]);
});

test('7C-24b base64 ai limiti 6/10 MiB usa validazione lineare', () => {
  for (const maxBytes of [MAX_IMAGE_BYTES, MAX_PDF_BYTES]) {
    const encoded = Buffer.alloc(maxBytes, 0x5a).toString('base64');
    const outcome = decodeStrictBase64(encoded, maxBytes);
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.value.byteLength, maxBytes);
  }
});

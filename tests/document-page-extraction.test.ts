import assert from 'node:assert/strict';
import test from 'node:test';
import type { QuoteDocument } from '../types';
import type { GeminiDocumentExtract } from '../lib/gemini-ocr';
import {
  PAGE_WARNING_CLOUD_FALLBACK,
  PAGE_WARNING_DUPLICATE,
  PAGE_WARNING_EMPTY_TEXT,
  aggregateToGeminiExtract,
  aggregatePageExtractionResults,
  alignPageExtractionImageUris,
  extractCloudPagesWithLocalFallback,
  failedPageResult,
  localSnapshotsToPageResults,
  pageResultFromCloudExtract,
  pageResultFromLocalSnapshot,
  sparseFieldsFromCloudExtract,
  type PageExtractionResult,
} from '../lib/document-page-extraction';
import { runDocumentAiReview } from '../lib/document-ai-review';
import { mergeDocumentPageFields } from '../lib/document-field-merge';
import { scanPagesLocally } from '../lib/local-ocr-pages';
import {
  normalizeGeminiDocumentExtract,
  parseGeminiDocumentJson,
} from '../lib/gemini-document-extract';

function cloudExtract(
  rawText: string,
  overrides: Partial<GeminiDocumentExtract> = {}
): GeminiDocumentExtract {
  return {
    rawText,
    ...overrides,
  };
}

function localPage(rawText: string) {
  return {
    rawText,
    lines: rawText
      ? rawText.split('\n').map((text) => ({ text, confidence: 0.8 }))
      : [],
  };
}

function quoteDocument(images: string[]): QuoteDocument {
  return {
    id: 'quote-phase-2a',
    type: 'quote',
    title: 'Preventivo',
    images,
    rawText: 'OCR locale precedente',
    confidence: {},
    createdAt: new Date('2026-07-24T08:00:00.000Z'),
    updatedAt: new Date('2026-07-24T08:00:00.000Z'),
    quoteNumber: '',
    quoteDate: new Date('2026-07-24T00:00:00.000Z'),
    customerName: '',
    items: [],
    subtotal: 0,
    vatAmount: 0,
    total: 0,
    currency: 'EUR',
  };
}

test('due pagine locali producono due risultati indipendenti', () => {
  const results = localSnapshotsToPageResults(
    'quote',
    ['local-1.jpg', 'local-2.jpg'],
    [localPage('Pagina locale 1'), localPage('Pagina locale 2')]
  );

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => ({
      index: result.pageIndex,
      uri: result.imageUri,
      method: result.processingMethod,
      rawText: result.rawText,
    })),
    [
      {
        index: 0,
        uri: 'local-1.jpg',
        method: 'local',
        rawText: 'Pagina locale 1',
      },
      {
        index: 1,
        uri: 'local-2.jpg',
        method: 'local',
        rawText: 'Pagina locale 2',
      },
    ]
  );
});

test('reject OCR sulla pagina centrale non interrompe le pagine 1 e 3', async () => {
  const calls: string[] = [];
  const scanned = await scanPagesLocally(
    ['page-1.jpg', 'page-2.jpg', 'page-3.jpg'],
    async (uri) => {
      calls.push(uri);
      if (uri === 'page-2.jpg') {
        throw new Error('OCR pagina 2 fallito');
      }
      const text = uri === 'page-1.jpg' ? 'PAGINA UNO' : 'PAGINA TRE';
      return {
        text,
        lines: [{ text, confidence: 0.8 }],
      };
    }
  );
  const results = localSnapshotsToPageResults(
    'quote',
    ['page-1.jpg', 'page-2.jpg', 'page-3.jpg'],
    scanned.pages
  );

  assert.deepEqual(calls, ['page-1.jpg', 'page-2.jpg', 'page-3.jpg']);
  assert.equal(scanned.ocrWorked, true);
  assert.deepEqual(
    scanned.pages.map((page) => page.completed),
    [true, false, true]
  );
  assert.deepEqual(
    results.map((page) => page.processingMethod),
    ['local', 'failed', 'local']
  );
  assert.equal(results[0]?.rawText, 'PAGINA UNO');
  assert.equal(results[1]?.error, 'OCR pagina 2 fallito');
  assert.equal(results[1]?.requiresReview, true);
  assert.equal(results[2]?.rawText, 'PAGINA TRE');
});

test('due pagine cloud dopo consenso fanno una sola chiamata per pagina', async () => {
  const cloudCalls: string[] = [];
  let localCalls = 0;
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['cloud-1.jpg', 'cloud-2.jpg'],
    async (uri) => {
      cloudCalls.push(uri);
      return {
        status: 'ok',
        extract: cloudExtract(`Cloud ${uri}`, {
          documentNumber: `DOC-${uri}`,
        }),
      };
    },
    async () => {
      localCalls += 1;
      return { text: 'non usato', lines: [] };
    }
  );

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(cloudCalls, ['cloud-1.jpg', 'cloud-2.jpg']);
  assert.equal(localCalls, 0);
  assert.deepEqual(
    outcome.results.map((result) => result.processingMethod),
    ['cloud', 'cloud']
  );
});

test('prima pagina cloud e seconda locale mantengono entrambi i testi', () => {
  const results = [
    pageResultFromCloudExtract(0, 'one.jpg', cloudExtract('TESTO CLOUD')),
    pageResultFromLocalSnapshot(
      'quote',
      1,
      'two.jpg',
      localPage('TESTO LOCALE')
    ),
  ];

  assert.equal(
    aggregatePageExtractionResults(results).rawText,
    'TESTO CLOUD\n\nTESTO LOCALE'
  );
});

test('prima pagina locale e seconda cloud mantengono entrambi i testi', () => {
  const results = [
    pageResultFromLocalSnapshot(
      'quote',
      0,
      'one.jpg',
      localPage('TESTO LOCALE')
    ),
    pageResultFromCloudExtract(1, 'two.jpg', cloudExtract('TESTO CLOUD')),
  ];

  assert.equal(
    aggregatePageExtractionResults(results).rawText,
    'TESTO LOCALE\n\nTESTO CLOUD'
  );
});

test('errore cloud seguito da OCR locale è local_fallback e richiede review', async () => {
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['fallback.jpg'],
    async () => ({ status: 'error', message: 'rete assente' }),
    async () => ({
      text: 'Testo recuperato localmente',
      lines: [{ text: 'Testo recuperato localmente', confidence: 0.75 }],
    })
  );

  assert.equal(outcome.status, 'ok');
  const page = outcome.results[0];
  assert.equal(page.processingMethod, 'local_fallback');
  assert.equal(page.rawText, 'Testo recuperato localmente');
  assert.equal(page.error, 'rete assente');
  assert.equal(page.completed, true);
  assert.equal(page.requiresReview, true);
  assert.deepEqual(page.warnings, [PAGE_WARNING_CLOUD_FALLBACK]);
});

test('il totale presente solo nell’ultima pagina non viene perso', () => {
  const aggregate = aggregatePageExtractionResults([
    pageResultFromCloudExtract(0, 'one.jpg', cloudExtract('Intestazione')),
    pageResultFromCloudExtract(
      1,
      'two.jpg',
      cloudExtract('Totale 122,00', { total: 122 })
    ),
  ]);

  assert.equal(aggregate.structuredFields.total, 122);
});

test('l’IVA presente solo nell’ultima pagina non viene persa', () => {
  const aggregate = aggregatePageExtractionResults([
    pageResultFromCloudExtract(0, 'one.jpg', cloudExtract('Intestazione')),
    pageResultFromCloudExtract(
      1,
      'two.jpg',
      cloudExtract('IVA 22,00', { vatAmount: 22 })
    ),
  ]);

  assert.equal(aggregate.structuredFields.vatAmount, 22);
});

test('il numero documento presente solo nell’ultima pagina non viene perso', () => {
  const aggregate = aggregatePageExtractionResults([
    pageResultFromCloudExtract(0, 'one.jpg', cloudExtract('Intestazione')),
    pageResultFromCloudExtract(
      1,
      'two.jpg',
      cloudExtract('Preventivo Q-204', { documentNumber: 'Q-204' })
    ),
  ]);

  assert.equal(aggregate.structuredFields.documentNumber, 'Q-204');
});

test('una pagina vuota resta completata ma visibile e non inventa campi', () => {
  const page = pageResultFromLocalSnapshot(
    'quote',
    0,
    'empty.jpg',
    localPage('')
  );

  assert.equal(page.processingMethod, 'local');
  assert.equal(page.completed, true);
  assert.equal(page.requiresReview, true);
  assert.deepEqual(page.warnings, [PAGE_WARNING_EMPTY_TEXT]);
  assert.deepEqual(page.structuredFields, {});
});

test('una pagina fallita è esplicita e richiede review', () => {
  const page = failedPageResult(2, 'failed.jpg', 'OCR non disponibile');

  assert.equal(page.pageIndex, 2);
  assert.equal(page.processingMethod, 'failed');
  assert.equal(page.completed, false);
  assert.equal(page.requiresReview, true);
  assert.equal(page.error, 'OCR non disponibile');
  assert.deepEqual(page.structuredFields, {});
});

test('tre pagine restano tre risultati distinti', () => {
  const results = localSnapshotsToPageResults(
    'free_document',
    ['1.jpg', '2.jpg', '3.jpg'],
    [localPage('Uno'), localPage('Due'), localPage('Tre')]
  );

  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((result) => result.rawText),
    ['Uno', 'Due', 'Tre']
  );
});

test('l’ordine delle pagine segue gli indici anche con input aggregato disordinato', () => {
  const aggregate = aggregatePageExtractionResults([
    pageResultFromCloudExtract(2, '3.jpg', cloudExtract('TRE')),
    pageResultFromCloudExtract(0, '1.jpg', cloudExtract('UNO')),
    pageResultFromCloudExtract(1, '2.jpg', cloudExtract('DUE')),
  ]);

  assert.equal(aggregate.rawText, 'UNO\n\nDUE\n\nTRE');
});

test('un URI duplicato accidentalmente non elimina né fonde una pagina', () => {
  const results = localSnapshotsToPageResults(
    'quote',
    ['duplicate.jpg', 'duplicate.jpg'],
    [localPage('Prima acquisizione'), localPage('Seconda acquisizione')]
  );

  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((result) => result.pageIndex),
    [0, 1]
  );
  assert.deepEqual(
    results.map((result) => result.imageUri),
    ['duplicate.jpg', 'duplicate.jpg']
  );
  assert.equal(results[1]?.duplicateOf, 0);
  assert.equal(results[1]?.requiresReview, true);
  assert.equal(
    results[1]?.warnings.includes(PAGE_WARNING_DUPLICATE),
    true
  );
  assert.equal(
    aggregatePageExtractionResults(results).rawText,
    'Prima acquisizione'
  );
});

test('i valori cloud mancanti restano proprietà assenti', () => {
  const sparse = sparseFieldsFromCloudExtract(cloudExtract('Solo testo'));

  assert.deepEqual(sparse, {});
  assert.equal('total' in sparse, false);
  assert.equal('documentNumber' in sparse, false);
  assert.equal('items' in sparse, false);
});

test('normalizzatore cloud accetta rawText-only e items assenti', () => {
  const normalized = normalizeGeminiDocumentExtract({
    rawText: '  Solo testo cloud  ',
  });

  assert.deepEqual(normalized, {
    rawText: 'Solo testo cloud',
  });
  const page = pageResultFromCloudExtract(
    0,
    'partial-cloud.jpg',
    { rawText: 'Solo testo cloud' }
  );
  assert.equal(page.processingMethod, 'cloud');
  assert.equal(page.rawText, 'Solo testo cloud');
  assert.deepEqual(page.structuredFields, {});
});

test('JSON cloud usa lo stesso normalizzatore e quantità assente non diventa uno', () => {
  const normalized = parseGeminiDocumentJson(
    '{"rawText":"Riga servizio","items":[{"description":"Servizio"}]}'
  );

  assert.equal(normalized?.items?.[0]?.quantity, undefined);
  assert.deepEqual(
    sparseFieldsFromCloudExtract(normalized).items,
    [{ description: 'Servizio' }]
  );
});

test('payload cloud malformed è defensive e ricorre al fallback senza fermare il batch', async () => {
  assert.deepEqual(sparseFieldsFromCloudExtract(null), {});
  assert.deepEqual(
    sparseFieldsFromCloudExtract({
      rawText: 'Testo valido',
      items: [null, 42, { description: 99, total: 'NaN' }],
    }),
    {}
  );

  const cloudCalls: string[] = [];
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['malformed.jpg', 'partial.jpg'],
    async (uri) => {
      cloudCalls.push(uri);
      return uri === 'malformed.jpg'
        ? ({
            status: 'ok',
            extract: { rawText: { unexpected: true }, items: 'invalid' },
          } as unknown as { status: 'ok'; extract: GeminiDocumentExtract })
        : ({
            status: 'ok',
            extract: {
              rawText: 'PAGINA PARZIALE VALIDA',
              documentNumber: 'DOC-2',
            },
          } as unknown as { status: 'ok'; extract: GeminiDocumentExtract });
    },
    async () => ({
      text: 'FALLBACK LOCALE',
      lines: [{ text: 'FALLBACK LOCALE', confidence: 0.7 }],
    })
  );

  assert.equal(outcome.status, 'ok');
  assert.deepEqual(cloudCalls, ['malformed.jpg', 'partial.jpg']);
  assert.deepEqual(
    outcome.results.map((page) => page.processingMethod),
    ['local_fallback', 'cloud']
  );
  assert.equal(outcome.results[0]?.rawText, 'FALLBACK LOCALE');
  assert.equal(outcome.results[1]?.rawText, 'PAGINA PARZIALE VALIDA');
});

test('un item cloud con sola descrizione resta sparse e non riceve zeri placeholder', () => {
  const sparse = sparseFieldsFromCloudExtract(
    cloudExtract('Riga descrittiva', {
      items: [
        {
          description: 'Consulenza',
        },
      ],
    })
  );

  assert.deepEqual(sparse.items, [{ description: 'Consulenza' }]);
  const legacy = aggregateToGeminiExtract({
    rawText: 'Riga descrittiva',
    structuredFields: sparse,
  });
  assert.equal(legacy.items, undefined);
});

test('errore di strutturazione resta isolato alla pagina e conserva il rawText', () => {
  const results = localSnapshotsToPageResults(
    'quote',
    ['good-1.jpg', 'bad.jpg', 'good-2.jpg'],
    [
      localPage('Pagina valida uno'),
      localPage('Pagina da preservare'),
      localPage('Pagina valida due'),
    ],
    (_type, _lines, rawText) => {
      if (rawText.includes('preservare')) {
        throw new Error('parser pagina KO');
      }
      return { documentNumber: rawText };
    }
  );

  assert.equal(results[0]?.processingMethod, 'local');
  assert.equal(results[1]?.processingMethod, 'failed');
  assert.equal(results[1]?.rawText, 'Pagina da preservare');
  assert.equal(results[1]?.requiresReview, true);
  assert.match(results[1]?.error ?? '', /parser pagina KO/);
  assert.equal(results[2]?.processingMethod, 'local');
  assert.equal(
    aggregatePageExtractionResults(results).rawText,
    'Pagina valida uno\n\nPagina da preservare\n\nPagina valida due'
  );
});

test('strutturazione fallita nel fallback non interrompe le pagine cloud successive', async () => {
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['fallback-bad.jpg', 'cloud-good.jpg'],
    async (uri) =>
      uri === 'fallback-bad.jpg'
        ? { status: 'error', message: 'cloud KO pagina 1' }
        : {
            status: 'ok',
            extract: cloudExtract('PAGINA CLOUD VALIDA', {
              documentNumber: 'DOC-CLOUD',
            }),
          },
    async () => ({
      text: 'RAW LOCALE DA PRESERVARE',
      lines: [{ text: 'RAW LOCALE DA PRESERVARE', confidence: 0.7 }],
    }),
    () => {
      throw new Error('struttura KO');
    }
  );

  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.results[0]?.processingMethod, 'failed');
  assert.equal(outcome.results[0]?.rawText, 'RAW LOCALE DA PRESERVARE');
  assert.equal(outcome.results[0]?.requiresReview, true);
  assert.match(outcome.results[0]?.error ?? '', /struttura KO/);
  assert.equal(outcome.results[1]?.processingMethod, 'cloud');
  assert.equal(
    aggregatePageExtractionResults(outcome.results).rawText,
    'RAW LOCALE DA PRESERVARE\n\nPAGINA CLOUD VALIDA'
  );
});

test('URI diagnostici seguono gli asset finali senza mutare gli esiti', () => {
  const original = localSnapshotsToPageResults(
    'quote',
    ['content://temp/one', 'content://temp/two'],
    [localPage('Uno'), localPage('Due')]
  );
  const finalUris = [
    'file:///scans/id/page-0-operation.jpg',
    'file:///scans/id/page-1-operation.jpg',
  ];

  const aligned = alignPageExtractionImageUris(original, finalUris);
  const roundTrip = JSON.parse(JSON.stringify(aligned)) as typeof aligned;

  assert.deepEqual(
    roundTrip.map((page) => page.imageUri),
    finalUris
  );
  assert.deepEqual(
    roundTrip.map((page) => page.rawText),
    ['Uno', 'Due']
  );
  assert.equal(original[0]?.imageUri, 'content://temp/one');
});

test('URI cloud duplicato viene elaborato una volta, marcato e aggregato una volta', async () => {
  let cloudCalls = 0;
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['same.jpg', 'same.jpg'],
    async () => {
      cloudCalls += 1;
      return {
        status: 'ok',
        extract: cloudExtract('UNICA PAGINA', { total: 10 }),
      };
    },
    async () => ({ text: '', lines: [] })
  );

  assert.equal(outcome.status, 'ok');
  assert.equal(cloudCalls, 1);
  assert.equal(outcome.results[1]?.duplicateOf, 0);
  assert.equal(
    aggregatePageExtractionResults(outcome.results).rawText,
    'UNICA PAGINA'
  );
  assert.equal(
    aggregatePageExtractionResults(outcome.results).structuredFields.total,
    10
  );
  const aligned = alignPageExtractionImageUris(outcome.results, [
    'file:///final/page-0.jpg',
    'file:///final/page-1.jpg',
  ]);
  assert.equal(aligned[1]?.duplicateOf, 0);
  assert.equal(
    aggregatePageExtractionResults(aligned).rawText,
    'UNICA PAGINA'
  );
});

test('review integrata usa il rawText canonico 2B con marker pagina ordinati e non duplicati', async () => {
  const current = quoteDocument(['one.jpg', 'two.jpg']);
  let builderExtract: GeminiDocumentExtract | undefined;
  const outcome = await runDocumentAiReview(
    'confirm',
    current,
    async (uri) =>
      uri === 'one.jpg'
        ? {
            status: 'ok',
            extract: cloudExtract('PAGINA CLOUD', {
              documentNumber: 'Q-2A',
            }),
          }
        : { status: 'error', message: 'cloud pagina 2 fallito' },
    (_type, extract) => {
      builderExtract = extract;
      return {
        ...current,
        id: 'id-generato-da-scartare',
        rawText: extract.rawText,
        quoteNumber: extract.documentNumber,
        total: extract.total,
      };
    },
    async () => ({
      text: 'PAGINA LOCALE\nTotale 122,00',
      lines: [
        { text: 'PAGINA LOCALE', confidence: 0.8 },
        { text: 'Totale 122,00', confidence: 0.8 },
      ],
    }),
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.document.id, current.id);
  assert.strictEqual(outcome.document.images, current.images);
  const canonicalRawText = [
    '=== PAGE 1 | cloud ===',
    'PAGINA CLOUD',
    '',
    '=== PAGE 2 | local_fallback ===',
    'PAGINA LOCALE',
    'Totale 122,00',
  ].join('\n');
  assert.equal(builderExtract?.rawText, canonicalRawText);
  assert.equal(outcome.document.rawText, canonicalRawText);
  const markers = canonicalRawText.match(/^=== PAGE [^\n]+ ===$/gm) ?? [];
  assert.deepEqual(markers, [
    '=== PAGE 1 | cloud ===',
    '=== PAGE 2 | local_fallback ===',
  ]);
  assert.equal(new Set(markers).size, markers.length);
  assert.doesNotMatch(canonicalRawText, /PAGINA CLOUD\nPAGINA LOCALE/);
  assert.doesNotMatch(canonicalRawText, /\n{3,}/);

  const mergePage = (
    pageIndex: number,
    rawText: string
  ): PageExtractionResult => ({
    pageIndex,
    imageUri: `file:///page-${pageIndex}.jpg`,
    processingMethod: 'local',
    rawText,
    structuredFields: {},
    warnings: rawText.trim() ? [] : [PAGE_WARNING_EMPTY_TEXT],
    completed: true,
    requiresReview: !rawText.trim(),
  });
  const emptyPageRawText = mergeDocumentPageFields([
    mergePage(1, 'SECONDA PAGINA'),
    mergePage(0, '   '),
  ]).rawText;
  assert.equal(
    emptyPageRawText,
    [
      '=== PAGE 1 | local ===',
      '',
      '=== PAGE 2 | local ===',
      'SECONDA PAGINA',
    ].join('\n')
  );
  assert.equal(
    (emptyPageRawText.match(/^=== PAGE [^\n]+ ===$/gm) ?? []).length,
    2
  );

  const singlePageText = 'RIGA UNO\nRIGA DUE';
  const singlePageRawText = mergeDocumentPageFields([
    mergePage(0, singlePageText),
  ]).rawText;
  assert.equal(
    singlePageRawText,
    `=== PAGE 1 | local ===\n${singlePageText}`
  );
  assert.equal(
    singlePageRawText.slice(singlePageRawText.indexOf('\n') + 1),
    singlePageText
  );
  assert.equal(
    (singlePageRawText.match(/^=== PAGE [^\n]+ ===$/gm) ?? []).length,
    1
  );
  assert.equal(builderExtract?.documentNumber, 'Q-2A');
  assert.deepEqual(
    outcome.document.pageExtractions?.map((page) => page.processingMethod),
    ['cloud', 'local_fallback']
  );
});

test('fallimento cloud e locale resta nel documento di review senza sostituire i campi', async () => {
  const current = quoteDocument(['failed.jpg']);
  let builderCalls = 0;
  const outcome = await runDocumentAiReview(
    'confirm',
    current,
    async () => ({ status: 'error', message: 'cloud KO' }),
    () => {
      builderCalls += 1;
      return current;
    },
    async () => ({ text: '', lines: [] }),
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'error');
  assert.equal(builderCalls, 0);
  assert.notStrictEqual(outcome.document, current);
  assert.equal(outcome.document.rawText, current.rawText);
  assert.equal(
    outcome.document.pageExtractions?.[0]?.processingMethod,
    'failed'
  );
  assert.equal(outcome.document.pageExtractions?.[0]?.requiresReview, true);
});

test('review con fallback locale conserva il payload AI strutturato', async () => {
  const current = quoteDocument(['structured.jpg']);
  const outcome = await runDocumentAiReview(
    'confirm',
    current,
    async () => ({
      status: 'ok',
      extract: cloudExtract('Ordine K-1', {
        structured: {
          schemaVersion: 2,
          document: { documentNumber: { value: 'K-1', pageIndex: 0, evidenceText: 'Ordine K-1', confidenceType: 'unknown', requiresReview: true, alternatives: [] } },
          items: [], summary: {}, conditions: {}, conflicts: [], requiresReview: true,
        },
      }),
    }),
    () => current,
    async () => ({ text: 'fallback non usato', lines: [{ text: 'fallback non usato', confidence: 0.8 }] }),
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.status === 'ok' ? outcome.aiExtract.structured?.document.documentNumber?.value : undefined, 'K-1');
});

test('review parziale non azzera i campi correnti assenti dal risultato', async () => {
  const current: QuoteDocument = {
    ...quoteDocument(['partial.jpg']),
    title: 'Preventivo esistente',
    quoteNumber: 'OLD-1',
    quoteDate: new Date('2026-06-10T00:00:00.000Z'),
    customerName: 'Cliente esistente',
    items: [
      {
        description: 'Riga esistente',
        quantity: 2,
        unitPrice: 50,
        vatRate: 22,
        total: 100,
      },
    ],
    subtotal: 100,
    vatAmount: 22,
    total: 122,
    currency: 'CHF',
    confidence: {
      quoteNumber: 0.8,
      date: 0.8,
      customerName: 0.8,
      total: 0.8,
    },
  };

  const outcome = await runDocumentAiReview(
    'confirm',
    current,
    async () => ({
      status: 'ok',
      extract: cloudExtract('Nuovo numero Q-NEW', {
        documentNumber: 'Q-NEW',
      }),
    }),
    (_type, extract) => ({
      ...quoteDocument([]),
      id: 'builder-id',
      title: 'Preventivo Q-NEW',
      rawText: extract.rawText,
      quoteNumber: extract.documentNumber,
      quoteDate: new Date('2030-01-01T00:00:00.000Z'),
      customerName: '',
      items: [],
      subtotal: 0,
      vatAmount: 0,
      total: 0,
      currency: 'EUR',
      confidence: {
        quoteNumber: 0.95,
        date: 0.3,
        customerName: 0.3,
        total: 0.2,
      },
    }),
    async () => ({ text: '', lines: [] }),
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'ok');
  const reviewed = outcome.document as QuoteDocument;
  assert.equal(reviewed.quoteNumber, 'Q-NEW');
  assert.equal(reviewed.customerName, 'Cliente esistente');
  assert.equal(
    reviewed.quoteDate?.toISOString(),
    current.quoteDate?.toISOString()
  );
  assert.deepEqual(reviewed.items, current.items);
  assert.equal(reviewed.subtotal, 100);
  assert.equal(reviewed.vatAmount, 22);
  assert.equal(reviewed.total, 122);
  assert.equal(reviewed.currency, 'CHF');
  assert.equal(reviewed.confidence.customerName, 0.8);
  assert.equal(reviewed.confidence.total, 0.8);
});

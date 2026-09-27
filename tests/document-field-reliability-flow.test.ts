import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnyDocument, QuoteDocument } from '../types';
import {
  normalizeGeminiDocumentExtract,
  parseGeminiDocumentJson,
} from '../lib/gemini-document-extract';
import {
  PAGE_WARNING_EMPTY_TEXT,
  PAGE_WARNING_PARTIAL_FIELDS,
  extractCloudPagesWithLocalFallback,
  pageResultFromCloudExtract,
  sparseFieldsFromCloudExtract,
} from '../lib/document-page-extraction';
import { mergeDocumentPageFields } from '../lib/document-field-merge';
import {
  applyDocumentFieldMerge,
  applyUserDocumentFieldEdit,
} from '../lib/document-field-merge-application';
import { buildDocumentReviewViewModel } from '../lib/document-review-view-model';
import { evaluateDocumentField } from '../lib/document-field-reliability';

function quote(overrides: Partial<QuoteDocument> = {}): QuoteDocument {
  return {
    id: 'quote-flow',
    type: 'quote',
    title: 'Preventivo test',
    images: [],
    rawText: 'OCR corrente',
    confidence: {},
    createdAt: new Date('2026-07-25T08:00:00.000Z'),
    updatedAt: new Date('2026-07-25T08:00:00.000Z'),
    items: [],
    ...overrides,
  };
}

function asQuote(document: AnyDocument): QuoteDocument {
  assert.equal(document.type, 'quote');
  return document as QuoteDocument;
}

test('rawText-only resta parziale, senza campi inventati e con review', () => {
  const normalized = normalizeGeminiDocumentExtract({
    rawText: '  SOLO TESTO OSSERVATO  ',
  });

  assert.deepEqual(normalized, { rawText: 'SOLO TESTO OSSERVATO' });
  const page = pageResultFromCloudExtract(
    0,
    'file:///raw-text-only.jpg',
    normalized
  );

  assert.deepEqual(page.structuredFields, {});
  assert.equal(page.completed, true);
  assert.equal(page.requiresReview, true);
  assert.equal(
    page.warnings.includes(PAGE_WARNING_PARTIAL_FIELDS),
    true
  );
  assert.equal(
    page.fieldReliability?.total?.validationStatus,
    'missing'
  );
  assert.equal(page.fieldReliability?.total?.value, undefined);
});

test('JSON AI parziale conserva zero e rawValue senza completare il DTO', () => {
  const parsed = parseGeminiDocumentJson(
    JSON.stringify({
      rawText: 'Totale: 0,00',
      documentNumber: null,
      total: 0,
    })
  );

  assert.ok(parsed);
  assert.equal(parsed.total, 0);
  assert.equal(parsed.documentNumber, undefined);
  assert.equal(parsed.items, undefined);
  assert.deepEqual(parsed.rawFields, {
    documentNumber: null,
    total: 0,
  });

  const page = pageResultFromCloudExtract(
    0,
    'file:///partial.json.jpg',
    parsed
  );
  assert.equal(page.structuredFields.total, 0);
  assert.equal(page.fieldReliability?.total?.rawValue, 0);
  assert.equal(page.fieldReliability?.total?.validationStatus, 'valid');
  assert.equal(
    page.fieldReliability?.documentNumber?.validationStatus,
    'missing'
  );
});

test('JSON vuoto non produce dati affidabili', () => {
  const empty = parseGeminiDocumentJson('{}');
  assert.deepEqual(empty, { rawText: '' });
  const emptyPage = pageResultFromCloudExtract(
    0,
    'file:///empty-json.jpg',
    empty
  );

  assert.deepEqual(emptyPage.structuredFields, {});
  assert.equal(emptyPage.requiresReview, true);
  assert.equal(emptyPage.warnings.includes(PAGE_WARNING_EMPTY_TEXT), true);
});

test('JSON malformato fallisce in modo conservativo', () => {
  assert.equal(parseGeminiDocumentJson('{"rawText":'), null);
});

test('risposta non JSON fallisce in modo conservativo', () => {
  assert.equal(parseGeminiDocumentJson('risposta priva di JSON'), null);
});

test('timeout cloud passa al fallback locale senza valori cloud residui', async () => {
  const startedAt = Date.now();
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['file:///timeout.jpg'],
    async () => new Promise(() => {}),
    async () => ({
      text: 'Preventivo LOCAL-1\nTotale 0,00',
      lines: [
        { text: 'Preventivo LOCAL-1', confidence: 0.8 },
        { text: 'Totale 0,00', confidence: 0.8 },
      ],
    }),
    () => ({
      documentNumber: 'LOCAL-1',
      total: 0,
    }),
    { cloudTimeoutMs: 5 }
  );

  assert.equal(outcome.status, 'ok');
  const page = outcome.results[0];
  assert.equal(page?.processingMethod, 'local_fallback');
  assert.equal(page?.structuredFields.documentNumber, 'LOCAL-1');
  assert.equal(page?.structuredFields.total, 0);
  assert.equal(page?.fieldReliability?.total?.source, 'local_ocr');
  assert.match(page?.error ?? '', /Timeout cloud/);
  assert.equal(Date.now() - startedAt < 1_000, true);
});

test('IVA, totale e articoli distinguono missing, vuoto e zero esplicito', () => {
  const missing = pageResultFromCloudExtract(
    0,
    'file:///missing-values.jpg',
    { rawText: 'Documento senza riepilogo' }
  );
  const emptyItems = pageResultFromCloudExtract(
    1,
    'file:///empty-items.jpg',
    { rawText: 'Nessuna riga articolo', items: [] }
  );
  const explicitZero = pageResultFromCloudExtract(
    2,
    'file:///explicit-zero.jpg',
    {
      rawText: 'IVA 0,00\nTotale 0,00\nOmaggio 0 0,00 0,00',
      vatAmount: 0,
      total: 0,
      items: [
        {
          description: 'Omaggio',
          quantity: 0,
          unitPrice: 0,
          total: 0,
        },
      ],
    }
  );

  assert.equal(
    missing.fieldReliability?.vatAmount?.validationStatus,
    'missing'
  );
  assert.equal(missing.fieldReliability?.total?.validationStatus, 'missing');
  assert.equal(missing.fieldReliability?.items?.validationStatus, 'missing');
  assert.equal(missing.fieldReliability?.items?.rawValue, undefined);

  assert.equal(
    emptyItems.fieldReliability?.items?.validationStatus,
    'missing'
  );
  assert.deepEqual(emptyItems.fieldReliability?.items?.rawValue, []);
  assert.equal(emptyItems.structuredFields.items, undefined);

  assert.equal(explicitZero.structuredFields.vatAmount, 0);
  assert.equal(explicitZero.structuredFields.total, 0);
  assert.deepEqual(explicitZero.structuredFields.items, [
    {
      description: 'Omaggio',
      quantity: 0,
      unitPrice: 0,
      total: 0,
    },
  ]);
  assert.equal(
    explicitZero.fieldReliability?.vatAmount?.validationStatus,
    'valid'
  );
  assert.equal(
    explicitZero.fieldReliability?.total?.validationStatus,
    'valid'
  );
  assert.equal(
    explicitZero.fieldReliability?.items?.validationStatus,
    'valid'
  );
  assert.deepEqual(sparseFieldsFromCloudExtract({
    rawText: 'IVA 0,00\nTotale 0,00\nOmaggio 0 0,00 0,00',
    ...explicitZero.structuredFields,
  }), {
    vatAmount: 0,
    total: 0,
    items: [
      {
        description: 'Omaggio',
        quantity: 0,
        unitPrice: 0,
        total: 0,
      },
    ],
  });
});

test('zero cloud non osservato resta ambiguo e non viene applicato', () => {
  const scalar = pageResultFromCloudExtract(
    0,
    'file:///unobserved-zero.jpg',
    {
      rawText: 'Totale non leggibile\nIVA 0%',
      total: 0,
      vatAmount: 0,
    }
  );
  assert.equal(scalar.structuredFields.total, undefined);
  assert.equal(scalar.structuredFields.vatAmount, undefined);
  assert.equal(
    scalar.fieldReliability?.total?.validationStatus,
    'ambiguous'
  );
  assert.equal(
    scalar.fieldReliability?.vatAmount?.validationStatus,
    'ambiguous'
  );

  const item = pageResultFromCloudExtract(
    1,
    'file:///unobserved-item-zero.jpg',
    {
      rawText: 'Omaggio quantità non leggibile',
      items: [
        {
          description: 'Omaggio',
          quantity: 0,
          unitPrice: 10,
          total: 0,
        },
      ],
    }
  );
  assert.equal(item.structuredFields.items, undefined);
  assert.equal(
    item.fieldReliability?.items?.validationStatus,
    'ambiguous'
  );

  const stringItem = pageResultFromCloudExtract(
    2,
    'file:///unobserved-string-item-zero.jpg',
    {
      rawText: 'Omaggio quantità non leggibile',
      items: [
        {
          description: 'Omaggio',
          quantity: '0',
          unitPrice: '10',
          total: '0',
        },
      ],
    }
  );
  assert.equal(stringItem.structuredFields.items, undefined);
  assert.equal(
    stringItem.fieldReliability?.items?.validationStatus,
    'ambiguous'
  );

  const shortDescription = pageResultFromCloudExtract(
    3,
    'file:///unrelated-short-description-zero.jpg',
    {
      rawText: 'IVA 0,00\nTotale 100,00',
      items: [
        {
          description: 'A',
          quantity: 0,
          unitPrice: 100,
          total: 100,
        },
      ],
    }
  );
  assert.equal(shortDescription.structuredFields.items, undefined);
  assert.equal(
    shortDescription.fieldReliability?.items?.validationStatus,
    'ambiguous'
  );

  const standaloneShortToken = pageResultFromCloudExtract(
    4,
    'file:///unrelated-standalone-short-token-zero.jpg',
    {
      rawText: 'Consegna a 0,00\nTotale 100,00',
      items: [
        {
          description: 'A',
          quantity: 0,
          unitPrice: 100,
          total: 100,
        },
      ],
    }
  );
  assert.equal(
    standaloneShortToken.structuredFields.items,
    undefined
  );
  assert.equal(
    standaloneShortToken.fieldReliability?.items?.validationStatus,
    'ambiguous'
  );

  const shortStopword = pageResultFromCloudExtract(
    5,
    'file:///unrelated-short-stopword-zero.jpg',
    {
      rawText: 'Sconto di 0,00\nTotale 100,00',
      items: [
        {
          description: 'DI',
          quantity: 0,
          unitPrice: 100,
          total: 100,
        },
      ],
    }
  );
  assert.equal(shortStopword.structuredFields.items, undefined);
  assert.equal(
    shortStopword.fieldReliability?.items?.validationStatus,
    'ambiguous'
  );
});

test('una data cloud normalizzata conserva il formato OCR ambiguo', () => {
  const page = pageResultFromCloudExtract(
    0,
    'file:///ambiguous-normalized-date.jpg',
    {
      rawText: 'Data 03/04/2026',
      date: '2026-04-03',
    }
  );

  assert.equal(page.structuredFields.date, undefined);
  assert.equal(page.fieldReliability?.date?.rawValue, '03/04/2026');
  assert.equal(page.fieldReliability?.date?.value, '2026-04-03');
  assert.equal(
    page.fieldReliability?.date?.validationStatus,
    'ambiguous'
  );
  assert.equal(page.fieldReliability?.date?.requiresReview, true);
});

test('una data cloud normalizzata non nasconde date OCR impossibili', () => {
  for (const [rawDate, providerDate] of [
    ['31/02/2026', '2026-03-03'],
    ['29/02/2025', '2025-03-01'],
  ] as const) {
    const page = pageResultFromCloudExtract(
      0,
      `file:///invalid-normalized-${rawDate}.jpg`,
      {
        rawText: `Data ${rawDate}`,
        date: providerDate,
      }
    );

    assert.equal(page.structuredFields.date, undefined);
    assert.equal(page.fieldReliability?.date?.rawValue, rawDate);
    assert.equal(
      page.fieldReliability?.date?.validationStatus,
      'invalid'
    );
  }
});

test('sentinel data osservati restano missing anche con proposta ISO cloud', () => {
  for (const [rawText, sentinel] of [
    ['Data: N/A', 'N/A'],
    ['Data: NA', 'NA'],
    ['Data: non disponibile', 'non disponibile'],
    ['Data: -', '-'],
    ['Data:', ''],
    ['Data fattura: N/A', 'N/A'],
    ['Data emissione: -', '-'],
    ['Data di emissione:', ''],
  ]) {
    const page = pageResultFromCloudExtract(
      0,
      `file:///missing-date-${sentinel}.jpg`,
      {
        rawText,
        date: '2026-03-03',
      }
    );

    assert.equal(page.structuredFields.date, undefined);
    assert.equal(page.fieldReliability?.date?.rawValue, sentinel);
    assert.equal(
      page.fieldReliability?.date?.validationStatus,
      'missing'
    );
  }
});

test('una scadenza non corrobora la data documento proposta dal cloud', () => {
  const dueDateOnly = pageResultFromCloudExtract(
    0,
    'file:///due-date-only.jpg',
    {
      rawText: 'Valido fino: 30/09/2026',
      date: '2026-09-30',
    }
  );
  assert.equal(dueDateOnly.structuredFields.date, undefined);
  assert.equal(
    dueDateOnly.fieldReliability?.date?.validationStatus,
    'ambiguous'
  );

  const invalidDocumentDate = pageResultFromCloudExtract(
    1,
    'file:///invalid-document-date-with-due-date.jpg',
    {
      rawText:
        'Data documento: 31/02/2026\nValido fino: 03/03/2026',
      date: '2026-03-03',
    }
  );
  assert.equal(invalidDocumentDate.structuredFields.date, undefined);
  assert.equal(
    invalidDocumentDate.fieldReliability?.date?.rawValue,
    '31/02/2026'
  );
  assert.equal(
    invalidDocumentDate.fieldReliability?.date?.validationStatus,
    'invalid'
  );
});

test('cloud invalido lascia spazio al valore locale valido', async () => {
  let localCalls = 0;
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['file:///invalid-cloud.jpg'],
    async () => ({
      status: 'ok' as const,
      extract: {
        rawText: 'Data 31/02/2026\nTotale -1,00',
        date: '31/02/2026',
        total: -1,
      },
    }),
    async () => {
      localCalls += 1;
      return {
        text: 'Data 2026-02-28\nTotale 0,00',
        lines: [
          { text: 'Data 2026-02-28', confidence: 0.8 },
          { text: 'Totale 0,00', confidence: 0.8 },
        ],
      };
    },
    () => ({
      date: '2026-02-28',
      total: 0,
    })
  );

  assert.equal(localCalls, 1);
  assert.equal(outcome.status, 'ok');
  const page = outcome.results[0];
  assert.equal(page?.processingMethod, 'local_fallback');
  assert.equal(page?.structuredFields.date, '2026-02-28');
  assert.equal(page?.structuredFields.total, 0);
  assert.equal(page?.fieldReliability?.date?.validationStatus, 'valid');
  assert.equal(page?.fieldReliability?.total?.validationStatus, 'valid');
});

test('cloud valido viene conservato quando il locale è mancante', async () => {
  let localCalls = 0;
  const outcome = await extractCloudPagesWithLocalFallback(
    'quote',
    ['file:///valid-cloud.jpg'],
    async () => ({
      status: 'ok' as const,
      extract: {
        rawText: 'Data 2026-02-28\nTotale 0,00',
        date: '2026-02-28',
        total: 0,
      },
    }),
    async () => {
      localCalls += 1;
      return { text: '', lines: [] };
    },
    () => ({})
  );

  assert.equal(localCalls, 0);
  assert.equal(outcome.status, 'ok');
  const page = outcome.results[0];
  assert.equal(page?.processingMethod, 'cloud');
  assert.equal(page?.structuredFields.date, '2026-02-28');
  assert.equal(page?.structuredFields.total, 0);
  assert.equal(page?.fieldReliability?.date?.source, 'cloud_ai');
  assert.equal(page?.fieldReliability?.date?.confidenceType, 'unknown');
});

test('due valori validi incompatibili non vengono applicati a un new_scan', () => {
  const first = pageResultFromCloudExtract(0, 'file:///one.jpg', {
    rawText: 'Totale 100,00',
    total: 100,
  });
  const second = pageResultFromCloudExtract(1, 'file:///two.jpg', {
    rawText: 'Totale 200,00',
    total: 200,
  });
  const merge = mergeDocumentPageFields([first, second]);

  assert.equal(merge.fields.total?.conflict?.reason, 'incompatible_values');
  assert.equal(merge.fieldReliability.total?.conflict, true);
  assert.equal(merge.fieldReliability.total?.value, undefined);
  assert.deepEqual(
    merge.fieldReliability.total?.alternatives.map((value) => value.value),
    [100, 200]
  );

  const applied = asQuote(
    applyDocumentFieldMerge(
      quote({ total: 999 }),
      merge,
      { mode: 'new_scan' }
    )
  );
  assert.equal(applied.total, undefined);
  assert.equal(applied.fieldReliability?.total?.conflict, true);
  assert.equal(
    applied.fieldMerge?.appliedFields?.total?.reason,
    'invalid_or_missing_not_applied'
  );
  assert.equal(
    applied.fieldMerge?.appliedFields?.total?.valueState,
    'absent'
  );
});

test('il conflitto resta visibile nel view-model della review', () => {
  const merge = mergeDocumentPageFields([
    pageResultFromCloudExtract(0, 'file:///review-one.jpg', {
      rawText: 'Totale 100,00',
      total: 100,
    }),
    pageResultFromCloudExtract(1, 'file:///review-two.jpg', {
      rawText: 'Totale 200,00',
      total: 200,
    }),
  ]);
  const viewModel = buildDocumentReviewViewModel(merge);
  const total = viewModel.fields.find((field) => field.field === 'total');

  assert.equal(viewModel.requiresReview, true);
  assert.equal(total?.conflict, true);
  assert.deepEqual(
    total?.alternatives.map((alternative) => alternative.value),
    [100, 200]
  );
  assert.deepEqual(
    total?.alternatives.map((alternative) => alternative.source),
    ['cloud_ai', 'cloud_ai']
  );
});

test('edit utente resta prioritario durante una review cloud successiva', () => {
  const edited = asQuote(
    applyUserDocumentFieldEdit(
      quote({ total: 100 }),
      'total',
      '125,00'
    )
  );
  assert.equal(edited.total, 125);
  assert.equal(edited.fieldReliability?.total?.source, 'user');
  assert.equal(edited.fieldReliability?.total?.validationStatus, 'valid');

  const cloudPage = pageResultFromCloudExtract(0, 'file:///review.jpg', {
    rawText: 'Totale 200,00',
    total: 200,
  });
  const merge = mergeDocumentPageFields([cloudPage]);
  const rebuilt = quote({
    ...edited,
    total: 200,
  });
  const reviewed = asQuote(
    applyDocumentFieldMerge(rebuilt, merge, {
      mode: 'preserve_existing',
      currentDocument: edited,
    })
  );

  assert.equal(reviewed.total, 125);
  assert.equal(reviewed.fieldReliability?.total?.source, 'user');
  assert.equal(reviewed.fieldReliability?.total?.conflict, true);
  assert.equal(reviewed.fieldReliability?.total?.requiresReview, true);
  assert.equal(
    reviewed.fieldReliability?.total?.alternatives.some(
      (candidate) =>
        candidate.source === 'cloud_ai' && candidate.value === 200
    ),
    true
  );
  assert.equal(
    reviewed.fieldMerge?.appliedFields?.total?.source,
    'user'
  );
  assert.equal(
    reviewed.fieldMerge?.appliedFields?.total?.reason,
    'preserved_user_value'
  );
});

test('una proposta singola non sovrascrive un valore valido già tracciato', () => {
  const current = quote({
    total: 90,
    fieldReliability: {
      total: evaluateDocumentField('total', 90, {
        source: 'local_ocr',
        confidenceType: 'measured',
        confidence: 0.8,
      }),
    },
  });
  const merge = mergeDocumentPageFields([
    pageResultFromCloudExtract(0, 'file:///tracked-conflict.jpg', {
      rawText: 'Totale 100,00',
      total: 100,
    }),
  ]);
  const reviewed = asQuote(
    applyDocumentFieldMerge(quote({ ...current, total: 100 }), merge, {
      mode: 'preserve_existing',
      currentDocument: current,
    })
  );

  assert.equal(reviewed.total, 90);
  assert.equal(reviewed.fieldReliability?.total?.conflict, true);
  assert.equal(reviewed.fieldReliability?.total?.requiresReview, true);
  assert.deepEqual(
    reviewed.fieldReliability?.total?.alternatives.map(
      (alternative) => alternative.value
    ),
    [90, 100]
  );
  assert.equal(
    reviewed.fieldMerge?.appliedFields?.total?.reason,
    'preserved_conflict'
  );
});

test('un edit utente invalido resta alternativa e non invalida il valore applicato', () => {
  const current = quote({
    total: 90,
    fieldReliability: {
      total: evaluateDocumentField('total', 90, {
        source: 'local_ocr',
        confidenceType: 'measured',
        confidence: 0.8,
      }),
    },
  });
  const edited = asQuote(
    applyUserDocumentFieldEdit(current, 'total', '12abc34')
  );

  assert.equal(edited.total, 90);
  assert.equal(edited.fieldReliability?.total?.source, 'local_ocr');
  assert.equal(edited.fieldReliability?.total?.validationStatus, 'valid');
  assert.equal(edited.fieldReliability?.total?.value, 90);
  assert.equal(
    edited.fieldReliability?.total?.alternatives.some(
      (alternative) =>
        alternative.source === 'user' &&
        alternative.validationStatus === 'invalid' &&
        alternative.rawValue === '12abc34'
    ),
    true
  );

  const merge = mergeDocumentPageFields([
    pageResultFromCloudExtract(0, 'file:///after-invalid-edit.jpg', {
      rawText: 'Totale 100,00',
      total: 100,
    }),
  ]);
  const reviewed = asQuote(
    applyDocumentFieldMerge(quote({ ...edited, total: 100 }), merge, {
      mode: 'preserve_existing',
      currentDocument: edited,
    })
  );
  assert.equal(reviewed.total, 90);
  assert.equal(reviewed.fieldReliability?.total?.validationStatus, 'valid');
  assert.equal(reviewed.fieldReliability?.total?.conflict, true);
});

test('edit utente aggiorna valore e traccia atomica, mentre un typo non altera la traccia applicata', () => {
  const merge = mergeDocumentPageFields([
    pageResultFromCloudExtract(0, 'file:///editable-trace.jpg', {
      rawText: 'Totale: 100,00',
      total: 100,
    }),
  ]);
  const scanned = asQuote(
    applyDocumentFieldMerge(quote(), merge, { mode: 'new_scan' })
  );
  assert.equal(scanned.total, 100);
  assert.equal(scanned.fieldMerge?.appliedFields?.total?.source, 'page');

  const validEdit = asQuote(
    applyUserDocumentFieldEdit(scanned, 'total', '125,00')
  );
  assert.equal(validEdit.total, 125);
  assert.equal(validEdit.fieldReliability?.total?.source, 'user');
  assert.equal(
    validEdit.fieldMerge?.appliedFields?.total?.source,
    'user'
  );
  assert.equal(validEdit.fieldMerge?.appliedFields?.total?.value, 125);

  const invalidEdit = asQuote(
    applyUserDocumentFieldEdit(scanned, 'total', '1O0,00')
  );
  assert.equal(invalidEdit.total, 100);
  assert.equal(
    invalidEdit.fieldMerge?.appliedFields?.total?.source,
    'page'
  );
  assert.equal(invalidEdit.fieldMerge?.appliedFields?.total?.value, 100);
  assert.equal(
    invalidEdit.fieldReliability?.total?.alternatives.some(
      (alternative) =>
        alternative.source === 'user' &&
        alternative.validationStatus === 'invalid'
    ),
    true
  );
});

test('una data corrente senza metadati resta tracciata quando la proposta manca', () => {
  const currentDate = new Date(2026, 0, 31);
  const current = quote({ quoteDate: currentDate });
  const merge = mergeDocumentPageFields([
    pageResultFromCloudExtract(0, 'file:///no-date-proposal.jpg', {
      rawText: 'Documento senza data leggibile',
    }),
  ]);
  const preserved = asQuote(
    applyDocumentFieldMerge(current, merge, {
      mode: 'preserve_existing',
      currentDocument: current,
    })
  );

  assert.equal(preserved.quoteDate?.getFullYear(), 2026);
  assert.equal(preserved.quoteDate?.getMonth(), 0);
  assert.equal(preserved.quoteDate?.getDate(), 31);
  assert.equal(
    preserved.fieldReliability?.date?.validationStatus,
    'unverified'
  );
  assert.equal(preserved.fieldReliability?.date?.value, '2026-01-31');
  assert.equal(preserved.fieldReliability?.date?.rawValue, '2026-01-31');
});

test('campi invalid e missing non vengono applicati né al record esistente né al new_scan', () => {
  const currentDate = new Date('2026-01-31T00:00:00.000Z');
  const current = quote({
    quoteDate: currentDate,
    total: 50,
  });
  const unsafePage = pageResultFromCloudExtract(
    0,
    'file:///unsafe.jpg',
    {
      rawText: 'Data 31/02/2026',
      date: '31/02/2026',
    }
  );
  const merge = mergeDocumentPageFields([unsafePage]);

  assert.equal(merge.fieldReliability.date?.validationStatus, 'invalid');
  assert.equal(merge.fieldReliability.total?.validationStatus, 'missing');

  const preserved = asQuote(
    applyDocumentFieldMerge(current, merge, {
      mode: 'preserve_existing',
      currentDocument: current,
    })
  );
  assert.equal(
    preserved.quoteDate?.toISOString(),
    currentDate.toISOString()
  );
  assert.equal(preserved.total, 50);
  assert.equal(
    preserved.fieldReliability?.date?.alternatives.some(
      (candidate) => candidate.validationStatus === 'invalid'
    ),
    true
  );

  const newScan = asQuote(
    applyDocumentFieldMerge(
      quote({ quoteDate: currentDate, total: 50 }),
      merge,
      { mode: 'new_scan' }
    )
  );
  assert.equal(newScan.quoteDate, undefined);
  assert.equal(newScan.total, undefined);
  assert.equal(
    newScan.fieldMerge?.appliedFields?.date?.reason,
    'invalid_or_missing_not_applied'
  );
});

test('record legacy e mappe parziali non simulano evidenza persistita', () => {
  const merge = mergeDocumentPageFields([
    pageResultFromCloudExtract(0, 'file:///legacy-total.jpg', {
      rawText: 'Totale 100,00',
      total: 100,
    }),
  ]);
  const variants = [
    quote({ total: 90 }),
    quote({
      total: 90,
      fieldReliability: {
        documentNumber: evaluateDocumentField(
          'documentNumber',
          'LEGACY-1',
          {
            source: 'local_ocr',
            confidenceType: 'heuristic',
          }
        ),
      },
    }),
  ];

  for (const current of variants) {
    const reviewed = asQuote(
      applyDocumentFieldMerge(
        quote({ ...current, total: 100 }),
        merge,
        {
          mode: 'preserve_existing',
          currentDocument: current,
        }
      )
    );
    assert.equal(reviewed.total, 100);
    assert.equal(reviewed.fieldReliability?.total?.value, 100);
    assert.equal(reviewed.fieldReliability?.total?.conflict, false);
  }
});

test('uno zero legacy senza evidenza non blocca una proposta valida osservata', () => {
  const current = quote({ total: 0 });
  const merge = mergeDocumentPageFields([
    pageResultFromCloudExtract(0, 'file:///legacy-zero-total.jpg', {
      rawText: 'Totale 100,00',
      total: 100,
    }),
  ]);
  const reviewed = asQuote(
    applyDocumentFieldMerge(quote({ ...current, total: 100 }), merge, {
      mode: 'preserve_existing',
      currentDocument: current,
    })
  );

  assert.equal(reviewed.total, 100);
  assert.equal(reviewed.fieldReliability?.total?.value, 100);
  assert.equal(reviewed.fieldReliability?.total?.conflict, false);
});

test('la reliability articoli segue gli articoli preservati nel record', () => {
  const currentItems = [
    {
      description: 'Riga corrente',
      quantity: 1,
      unitPrice: 10,
      total: 10,
    },
  ];
  const proposedItems = [
    {
      description: 'Riga nuova',
      quantity: 1,
      unitPrice: 20,
      total: 20,
    },
  ];
  const current = quote({
    items: currentItems,
    fieldReliability: {
      items: evaluateDocumentField('items', currentItems, {
        source: 'local_ocr',
        confidenceType: 'measured',
        confidence: 0.8,
      }),
    },
  });
  const merge = mergeDocumentPageFields([
    pageResultFromCloudExtract(0, 'file:///conflicting-items.jpg', {
      rawText: 'Riga nuova 1 20,00 20,00',
      items: proposedItems,
    }),
  ]);
  const reviewed = asQuote(
    applyDocumentFieldMerge(
      quote({ ...current, items: proposedItems }),
      merge,
      {
        mode: 'preserve_existing',
        currentDocument: current,
      }
    )
  );

  assert.deepEqual(reviewed.items, currentItems);
  assert.deepEqual(
    reviewed.fieldReliability?.items?.value,
    currentItems
  );
  assert.deepEqual(
    reviewed.fieldMerge?.fieldReliability.items?.value,
    proposedItems
  );
  assert.equal(reviewed.fieldReliability?.items?.conflict, true);
  assert.equal(reviewed.fieldReliability?.items?.requiresReview, true);
  assert.equal(
    reviewed.fieldReliability?.items?.alternatives.some(
      (alternative) =>
        Array.isArray(alternative.value) &&
        alternative.value.some(
          (item) =>
            !!item &&
            typeof item === 'object' &&
            'description' in item &&
            item.description === 'Riga nuova'
        )
    ),
    true
  );
});

test('la reliability dei campi liberi segue la mappa realmente salvata', () => {
  const currentFields = { page_1_code: 'OLD' };
  const current: AnyDocument = {
    id: 'free-reliability-current',
    type: 'free_document',
    title: 'Documento corrente',
    images: [],
    rawText: 'corrente',
    confidence: {},
    createdAt: new Date('2026-07-25T08:00:00.000Z'),
    updatedAt: new Date('2026-07-25T08:00:00.000Z'),
    extractedFields: currentFields,
    fieldReliability: {
      extractedFields: evaluateDocumentField(
        'extractedFields',
        currentFields,
        {
          source: 'local_ocr',
          confidenceType: 'heuristic',
        }
      ),
    },
  };
  const page = {
    pageIndex: 0,
    imageUri: 'file:///free-conflict.jpg',
    processingMethod: 'local' as const,
    rawText: 'Codice: NEW',
    structuredFields: {
      extractedFields: { code: 'NEW' },
    },
    fieldReliability: {
      extractedFields: evaluateDocumentField(
        'extractedFields',
        { code: 'NEW' },
        {
          source: 'local_ocr',
          pageIndex: 0,
          confidenceType: 'heuristic',
        }
      ),
    },
    warnings: [],
    completed: true,
    requiresReview: true,
  };
  const merge = mergeDocumentPageFields([page]);
  const reviewed = applyDocumentFieldMerge(current, merge, {
    mode: 'preserve_existing',
    currentDocument: current,
  });

  assert.equal(reviewed.type, 'free_document');
  if (reviewed.type !== 'free_document') return;
  assert.deepEqual(reviewed.extractedFields, currentFields);
  assert.deepEqual(
    reviewed.fieldReliability?.extractedFields?.value,
    currentFields
  );
  assert.deepEqual(
    reviewed.fieldMerge?.fieldReliability.extractedFields?.value,
    { page_1_code: 'NEW' }
  );
  assert.equal(
    reviewed.fieldReliability?.extractedFields?.validationStatus,
    'unverified'
  );
  assert.equal(
    reviewed.fieldReliability?.extractedFields?.conflict,
    true
  );
  assert.equal(
    reviewed.fieldReliability?.extractedFields?.alternatives.some(
      (alternative) =>
        !!alternative.value &&
        typeof alternative.value === 'object' &&
        !Array.isArray(alternative.value) &&
        (alternative.value as Record<string, string>)
          .page_1_code === 'NEW'
    ),
    true
  );
});

test('merge conserva review cloud degli articoli e non valida campi liberi', () => {
  const cloudItems = pageResultFromCloudExtract(
    0,
    'file:///cloud-items-review.jpg',
    {
      rawText: 'Servizio 1 10,00 10,00',
      items: [
        {
          description: 'Servizio',
          quantity: 1,
          unitPrice: 10,
          total: 10,
        },
      ],
    }
  );
  const itemMerge = mergeDocumentPageFields([cloudItems]);
  assert.equal(
    itemMerge.fieldReliability.items?.validationStatus,
    'valid'
  );
  assert.equal(itemMerge.fieldReliability.items?.requiresReview, true);
  assert.equal(
    itemMerge.fieldReliability.items?.validationReasons.includes(
      'provider_confidence_unavailable'
    ),
    true
  );

  const freePage = {
    pageIndex: 0,
    imageUri: 'file:///free-unverified.jpg',
    processingMethod: 'local' as const,
    rawText: 'Codice: ABC',
    structuredFields: {
      extractedFields: { code: 'ABC' },
    },
    fieldReliability: {
      extractedFields: evaluateDocumentField(
        'extractedFields',
        { code: 'ABC' },
        {
          source: 'local_ocr',
          pageIndex: 0,
          confidenceType: 'heuristic',
        }
      ),
    },
    warnings: [],
    completed: true,
    requiresReview: true,
  };
  const freeMerge = mergeDocumentPageFields([freePage]);
  assert.equal(
    freeMerge.fieldReliability.extractedFields?.validationStatus,
    'unverified'
  );
  assert.equal(
    freeMerge.fieldReliability.extractedFields?.requiresReview,
    true
  );
});

test('metadati di provenienza, alternative e conflitto sopravvivono al round-trip JSON', () => {
  const edited = asQuote(
    applyUserDocumentFieldEdit(
      quote({ total: 90 }),
      'total',
      125
    )
  );
  const cloudPage = pageResultFromCloudExtract(0, 'file:///roundtrip.jpg', {
    rawText: 'Totale 200,00',
    total: 200,
  });
  const merge = mergeDocumentPageFields([cloudPage]);
  const reviewed = asQuote(
    applyDocumentFieldMerge(
      quote({ ...edited, total: 200 }),
      merge,
      {
        mode: 'preserve_existing',
        currentDocument: edited,
      }
    )
  );

  const roundTrip = JSON.parse(JSON.stringify(reviewed)) as Record<
    string,
    unknown
  >;
  const expectedReliability = JSON.parse(
    JSON.stringify(reviewed.fieldReliability)
  ) as unknown;
  const expectedMergeReliability = JSON.parse(
    JSON.stringify(reviewed.fieldMerge?.fieldReliability)
  ) as unknown;
  const expectedAppliedFields = JSON.parse(
    JSON.stringify(reviewed.fieldMerge?.appliedFields)
  ) as unknown;
  assert.deepEqual(roundTrip.fieldReliability, expectedReliability);
  assert.deepEqual(
    (roundTrip.fieldMerge as { fieldReliability?: unknown })
      .fieldReliability,
    expectedMergeReliability
  );
  assert.deepEqual(
    (roundTrip.fieldMerge as { appliedFields?: unknown }).appliedFields,
    expectedAppliedFields
  );

  const total = (
    roundTrip.fieldReliability as {
      total?: {
        source?: string;
        rawValue?: unknown;
        conflict?: boolean;
        alternatives?: unknown[];
      };
    }
  ).total;
  assert.equal(total?.source, 'user');
  assert.equal(total?.rawValue, 125);
  assert.equal(total?.conflict, true);
  assert.equal((total?.alternatives?.length ?? 0) >= 2, true);
});

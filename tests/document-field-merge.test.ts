import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PageExtractionResult,
  DocumentPageStructuredFields,
} from '../lib/document-page-extraction';
import {
  mergeDocumentPageFields,
  parseDocumentAmount,
} from '../lib/document-field-merge';
import { applyDocumentFieldMerge } from '../lib/document-field-merge-application';
import { runDocumentAiReview } from '../lib/document-ai-review';
import type {
  AnyDocument,
  OrderDocument,
  QuoteDocument,
} from '../types';

function page(
  pageIndex: number,
  structuredFields: DocumentPageStructuredFields = {},
  overrides: Partial<PageExtractionResult> = {}
): PageExtractionResult {
  return {
    pageIndex,
    imageUri: `file:///page-${pageIndex}.jpg`,
    processingMethod: 'local',
    rawText: `TESTO PAGINA ${pageIndex + 1}`,
    structuredFields,
    warnings: [],
    completed: true,
    requiresReview: false,
    ...overrides,
  };
}

function quote(overrides: Partial<QuoteDocument> = {}): QuoteDocument {
  return {
    id: 'quote-2b',
    type: 'quote',
    title: 'Preventivo precedente',
    images: ['one.jpg', 'two.jpg'],
    rawText: 'testo globale precedente',
    confidence: {},
    createdAt: new Date('2026-07-24T08:00:00.000Z'),
    updatedAt: new Date('2026-07-24T08:00:00.000Z'),
    quoteNumber: 'OLD-1',
    quoteDate: new Date('2026-07-01T00:00:00.000Z'),
    customerName: 'Cliente precedente',
    customerVat: 'IT00000000000',
    items: [
      {
        description: 'Riga precedente',
        quantity: 1,
        unitPrice: 9,
        vatRate: 22,
        total: 9,
      },
    ],
    subtotal: 9,
    vatAmount: 1.98,
    total: 10.98,
    currency: 'CHF',
    ...overrides,
  };
}

test('seleziona il totale presente solo nell’ultima pagina', () => {
  const merged = mergeDocumentPageFields([
    page(0, { documentNumber: 'Q-100' }),
    page(1, { total: 122 }),
  ]);

  assert.equal(merged.fields.total?.value, 122);
  assert.equal(merged.fields.total?.sourcePageIndex, 1);
  assert.equal(merged.fields.total?.sourceMethod, 'local');
});

test('IVA e imponibile possono provenire da pagine differenti', () => {
  const merged = mergeDocumentPageFields([
    page(0, { subtotal: 100 }),
    page(1, { vatAmount: 22, vatNumber: 'IT12345678901' }),
  ]);

  assert.equal(merged.fields.subtotal?.sourcePageIndex, 0);
  assert.equal(merged.fields.vatAmount?.value, 22);
  assert.equal(merged.fields.vatAmount?.sourcePageIndex, 1);
  assert.equal(merged.fields.vatNumber?.value, 'IT12345678901');
});

test('lo stesso numero ripetuto non genera conflitto', () => {
  const merged = mergeDocumentPageFields([
    page(0, { documentNumber: 'Q-100' }),
    page(1, { documentNumber: ' q-100 ' }, { processingMethod: 'cloud' }),
  ]);

  assert.equal(merged.fields.documentNumber?.reason, 'same_value_repeated');
  assert.equal(merged.fields.documentNumber?.conflict, undefined);
  assert.equal(merged.requiresReview, false);
});

test('due numeri documento incompatibili registrano conflitto e review', () => {
  const merged = mergeDocumentPageFields([
    page(0, { documentNumber: 'Q-100' }),
    page(1, { documentNumber: 'Q-200' }),
  ]);

  assert.equal(merged.conflicts[0]?.field, 'documentNumber');
  assert.equal(merged.fields.documentNumber?.conflict?.reason, 'incompatible_values');
  assert.equal(
    merged.fields.documentNumber?.reason,
    'deterministic_conflict_tiebreak'
  );
  assert.equal(merged.requiresReview, true);
});

test('due totali incompatibili registrano entrambi i candidati', () => {
  const merged = mergeDocumentPageFields([
    page(0, { total: 100 }),
    page(1, { total: 122 }),
  ]);

  const conflict = merged.fields.total?.conflict;
  assert.equal(conflict?.field, 'total');
  assert.deepEqual(
    conflict?.candidates.map((candidate) => candidate.value),
    [100, 122]
  );
  assert.equal(merged.requiresReview, true);
});

test('un valore vuoto non sovrascrive quello valido della seconda pagina', () => {
  const merged = mergeDocumentPageFields([
    page(0, { documentNumber: '   ' }),
    page(1, { documentNumber: 'Q-VALIDO' }),
  ]);

  assert.equal(merged.fields.documentNumber?.value, 'Q-VALIDO');
  assert.equal(merged.fields.documentNumber?.sourcePageIndex, 1);
  assert.equal(merged.fields.documentNumber?.reason, 'single_candidate');
});

test('il valore locale completo prevale sul prefisso cloud incompleto', () => {
  const merged = mergeDocumentPageFields([
    page(
      0,
      { documentNumber: 'Q-20' },
      { processingMethod: 'cloud' }
    ),
    page(1, { documentNumber: 'Q-2026' }),
  ]);

  assert.equal(merged.fields.documentNumber?.value, 'Q-2026');
  assert.equal(merged.fields.documentNumber?.sourceMethod, 'local');
  assert.equal(merged.fields.documentNumber?.reason, 'more_complete_value');
  assert.equal(merged.fields.documentNumber?.conflict, undefined);
});

test('due prefissi locali restano in conflitto senza qualità esplicita', () => {
  const merged = mergeDocumentPageFields([
    page(0, { documentNumber: 'Q-20' }),
    page(1, { documentNumber: 'Q-2026' }),
  ]);

  assert.equal(merged.fields.documentNumber?.value, 'Q-2026');
  assert.equal(
    merged.fields.documentNumber?.reason,
    'deterministic_conflict_tiebreak'
  );
  assert.equal(
    merged.fields.documentNumber?.conflict?.reason,
    'incompatible_values'
  );
  assert.equal(merged.requiresReview, true);
});

test('il prefisso locale più lungo è accettato con qualità esplicita maggiore', () => {
  const merged = mergeDocumentPageFields([
    page(
      0,
      { documentNumber: 'Q-20' },
      { fieldConfidence: { documentNumber: 0.6 } }
    ),
    page(
      1,
      { documentNumber: 'Q-2026' },
      { fieldConfidence: { documentNumber: 0.9 } }
    ),
  ]);

  assert.equal(merged.fields.documentNumber?.value, 'Q-2026');
  assert.equal(merged.fields.documentNumber?.reason, 'more_complete_value');
  assert.equal(merged.fields.documentNumber?.conflict, undefined);
});

test('valute diverse non vengono conciliate silenziosamente', () => {
  const merged = mergeDocumentPageFields([
    page(0, { currency: 'EUR' }),
    page(1, { currency: 'USD' }, { processingMethod: 'cloud' }),
  ]);

  assert.equal(merged.fields.currency?.conflict?.field, 'currency');
  assert.equal(merged.requiresReview, true);
});

test('invertire l’array di input non cambia il risultato', () => {
  const pages = [
    page(0, { documentNumber: 'Q-7', subtotal: 100 }),
    page(1, { vatAmount: 22, total: 122 }),
    page(2, { currency: 'EUR' }),
  ];

  assert.deepEqual(
    mergeDocumentPageFields([...pages].reverse()),
    mergeDocumentPageFields(pages)
  );
});

test('il rawText conserva separatori espliciti e ordine pagina', () => {
  const merged = mergeDocumentPageFields([
    page(1, {}, { rawText: 'DUE', processingMethod: 'cloud' }),
    page(0, {}, { rawText: 'UNO' }),
  ]);

  assert.equal(
    merged.rawText,
    [
      '=== PAGE 1 | local ===',
      'UNO',
      '',
      '=== PAGE 2 | cloud ===',
      'DUE',
    ].join('\n')
  );
});

test('gli importi IT e US convergono allo stesso valore', () => {
  assert.equal(parseDocumentAmount('EUR 1.234,56'), 1234.56);
  assert.equal(parseDocumentAmount('$1,234.56'), 1234.56);
  assert.equal(parseDocumentAmount('1234.5'), 1234.5);
});

test('non inventa confidence e conserva gli item per gruppo pagina', () => {
  const merged = mergeDocumentPageFields([
    page(0, {
      items: [{ description: 'Riga A', quantity: 1 }],
    }),
    page(1, {
      items: [{ unitPrice: 10, total: 10 }],
    }),
  ]);

  assert.equal(merged.itemGroups.length, 2);
  assert.deepEqual(
    merged.itemGroups.map((group) => group.sourcePageIndex),
    [0, 1]
  );
  assert.equal('confidence' in merged.itemGroups[0], false);
});

test('pagina failed resta nel testo ma non contribuisce ai campi', () => {
  const merged = mergeDocumentPageFields([
    page(0, { total: 122 }, { rawText: 'Totale 122' }),
    page(
      1,
      { total: 999, documentNumber: 'NON-USARE' },
      {
        processingMethod: 'failed',
        rawText: 'testo conservato',
        completed: false,
        requiresReview: true,
      }
    ),
  ]);

  assert.equal(merged.fields.total?.value, 122);
  assert.equal(merged.fields.documentNumber, undefined);
  assert.match(merged.rawText, /testo conservato/);
  assert.equal(merged.requiresReview, true);
});

test('new scan applica solo evidenza tracciata e lascia missing i campi assenti', () => {
  const merged = mergeDocumentPageFields([
    page(0, {
      documentNumber: 'Q-NEW',
      vatNumber: 'IT12345678901',
      subtotal: 100,
    }),
    page(1, { vatAmount: 22, total: 122, currency: 'EUR' }),
  ]);
  const applied = applyDocumentFieldMerge(quote(), merged, {
    mode: 'new_scan',
  }) as QuoteDocument;

  assert.equal(applied.quoteNumber, 'Q-NEW');
  assert.equal(applied.customerName, undefined);
  assert.equal(
    applied.fieldReliability?.customerName?.validationStatus,
    'missing'
  );
  assert.equal(applied.customerVat, 'IT12345678901');
  assert.equal(applied.subtotal, 100);
  assert.equal(applied.vatAmount, 22);
  assert.equal(applied.total, 122);
  assert.equal(applied.currency, 'EUR');
  assert.deepEqual(applied.items, []);
  assert.equal(
    applied.fieldMerge?.appliedFields?.documentNumber?.value,
    'Q-NEW'
  );
  assert.equal(applied.rawText, merged.rawText);
});

test('new scan non salva date legacy quando manca evidenza strutturata', () => {
  const orderBase: OrderDocument = {
    id: 'order-date-2b',
    type: 'order',
    title: 'Ordine legacy',
    images: [],
    rawText: '',
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    orderNumber: '',
    orderDate: new Date('2026-07-21T00:00:00.000Z'),
    customerName: '',
    items: [],
    subtotal: 0,
    vatAmount: 0,
    total: 0,
    currency: '',
  };
  const freeWithoutDate: AnyDocument = {
    id: 'free-date-2b',
    type: 'free_document',
    title: 'Documento libero',
    images: [],
    rawText: '',
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    extractedFields: {},
  };
  const cases: Array<{
    name: string;
    document: AnyDocument;
    rawText: string;
  }> = [
    {
      name: 'quote senza data nel testo',
      document: quote(),
      rawText: 'PREVENTIVO SENZA DATA',
    },
    {
      name: 'quote con data soltanto nel raw',
      document: quote({
        quoteDate: new Date('2026-07-22T00:00:00.000Z'),
      }),
      rawText: 'Data 22/07/2026',
    },
    {
      name: 'order senza data nel testo',
      document: orderBase,
      rawText: 'ORDINE SENZA DATA',
    },
    {
      name: 'order con data soltanto nel raw',
      document: {
        ...orderBase,
        orderDate: new Date('2026-07-23T00:00:00.000Z'),
      },
      rawText: 'Data 23/07/2026',
    },
    {
      name: 'free senza data nel testo',
      document: freeWithoutDate,
      rawText: 'DOCUMENTO SENZA DATA',
    },
    {
      name: 'free con data soltanto nel raw',
      document: {
        ...freeWithoutDate,
        documentDate: new Date('2026-07-24T00:00:00.000Z'),
      },
      rawText: 'Data 24/07/2026',
    },
  ];

  for (const scenario of cases) {
    const merged = mergeDocumentPageFields([
      page(0, {}, { rawText: scenario.rawText }),
    ]);
    const applied = applyDocumentFieldMerge(
      scenario.document,
      merged,
      { mode: 'new_scan' }
    );
    const dateTrace = applied.fieldMerge?.appliedFields?.date;

    assert.equal(
      merged.fields.date,
      undefined,
      `${scenario.name}: nessuna proposta data`
    );
    assert.equal(
      dateTrace?.source,
      'page',
      `${scenario.name}: source missing`
    );
    assert.equal(
      dateTrace?.reason,
      'invalid_or_missing_not_applied',
      `${scenario.name}: reason missing`
    );
    assert.equal(dateTrace?.validation, 'invalid');
    assert.equal(dateTrace?.validationStatus, 'missing');
    assert.equal(dateTrace?.valueState, 'absent');
    assert.equal(
      applied.fieldReliability?.date?.validationStatus,
      'missing'
    );
    assert.equal(applied.fieldMerge?.requiresReview, true);
  }

  const freeAbsent = applyDocumentFieldMerge(
    freeWithoutDate,
    mergeDocumentPageFields([page(0)]),
    { mode: 'new_scan' }
  );
  assert.equal(
    freeAbsent.fieldMerge?.appliedFields?.date?.valueState,
    'absent'
  );
});

test('review con conflitto preserva il valore corrente e conserva la proposta', () => {
  const current = quote({ total: 90 });
  const merged = mergeDocumentPageFields([
    page(0, { total: 100 }),
    page(1, { total: 122 }),
  ]);
  const rebuilt = quote({ total: 122 });
  const applied = applyDocumentFieldMerge(rebuilt, merged, {
    mode: 'preserve_existing',
    currentDocument: current,
  }) as QuoteDocument;

  assert.equal(applied.total, 90);
  assert.equal(applied.fieldMerge?.fields.total?.value, 100);
  assert.equal(applied.fieldMerge?.requiresReview, true);
  assert.equal(applied.fieldMerge?.appliedFields?.total?.field, 'total');
  assert.equal(applied.fieldMerge?.appliedFields?.total?.value, 90);
  assert.equal(
    applied.fieldMerge?.appliedFields?.total?.source,
    'existing_record'
  );
  assert.equal(
    applied.fieldMerge?.appliedFields?.total?.reason,
    'preserved_conflict'
  );
  assert.equal(
    applied.fieldReliability?.total?.alternatives.length,
    3
  );
  assert.equal(applied.fieldReliability?.total?.conflict, true);
});

test('free document conserva extractedFields per pagina senza collisioni', () => {
  const merged = mergeDocumentPageFields([
    page(0, { extractedFields: { field_1: 'ALFA' } }),
    page(1, { extractedFields: { field_1: 'BETA' } }),
  ]);
  const applied = applyDocumentFieldMerge(
    {
      id: 'free-2b',
      type: 'free_document',
      title: 'ibrido',
      images: [],
      rawText: 'ibrido',
      confidence: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      extractedFields: { field_1: 'IBRIDO' },
    },
    merged,
    { mode: 'new_scan' }
  );

  assert.equal(applied.type, 'free_document');
  if (applied.type !== 'free_document') return;
  assert.deepEqual(applied.extractedFields, {
    page_1_field_1: 'ALFA',
    page_2_field_1: 'BETA',
  });
  assert.deepEqual(
    applied.fieldMerge?.extractedFieldGroups.map(
      (group) => group.sourcePageIndex
    ),
    [0, 1]
  );
});

test('il merge non inventa l’aliquota IVA degli item', () => {
  const merged = mergeDocumentPageFields([
    page(0, {
      items: [
        {
          description: 'Consulenza',
          quantity: 1,
          unitPrice: 100,
          total: 100,
        },
      ],
    }),
  ]);
  const applied = applyDocumentFieldMerge(quote(), merged, {
    mode: 'new_scan',
  }) as QuoteDocument;

  assert.equal(merged.itemGroups[0]?.value[0]?.vatRate, undefined);
  assert.equal(applied.items[0]?.vatRate, undefined);
});

test('review AI usa marker pagina e non applica un totale in conflitto', async () => {
  const current = quote({ total: 90 });
  let builderRawText = '';
  let exactMode = false;
  const outcome = await runDocumentAiReview(
    'confirm',
    current,
    async (uri) => ({
      status: 'ok',
      extract: {
        rawText: uri.endsWith('one.jpg') ? 'TOTALE 100' : 'TOTALE 122',
        total: uri.endsWith('one.jpg') ? 100 : 122,
      },
    }),
    (_type, extract, options) => {
      builderRawText = extract.rawText;
      exactMode = options?.exactStructuredFields === true;
      return quote({ total: extract.total, rawText: extract.rawText });
    },
    async () => {
      throw new Error('fallback locale inatteso');
    },
    undefined,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'ok');
  assert.equal((outcome.document as QuoteDocument).total, 90);
  assert.equal(outcome.document.fieldMerge?.fields.total?.conflict?.field, 'total');
  assert.equal(
    outcome.document.fieldMerge?.appliedFields?.total?.reason,
    'preserved_conflict'
  );
  assert.equal(outcome.document.fieldMerge?.requiresReview, true);
  assert.match(builderRawText, /=== PAGE 1 \| cloud ===/);
  assert.match(builderRawText, /=== PAGE 2 \| cloud ===/);
  assert.equal(exactMode, true);
  assert.equal(outcome.document.rawText, outcome.document.fieldMerge?.rawText);
});

test('review preserva item correnti se una pagina è fallita', () => {
  const current = quote();
  const merged = mergeDocumentPageFields([
    page(0, {
      items: [
        {
          description: 'Nuova riga',
          quantity: 1,
          unitPrice: 100,
          total: 100,
        },
      ],
    }),
    page(
      1,
      {},
      {
        processingMethod: 'failed',
        completed: false,
        requiresReview: true,
      }
    ),
  ]);
  const applied = applyDocumentFieldMerge(quote({ items: [] }), merged, {
    mode: 'preserve_existing',
    currentDocument: current,
  }) as QuoteDocument;

  assert.deepEqual(applied.items, current.items);
  assert.equal(
    applied.fieldMerge?.itemApplication?.source,
    'existing_record'
  );
  assert.equal(
    applied.fieldMerge?.itemApplication?.reason,
    'preserved_conflict'
  );
  assert.equal(
    applied.fieldMerge?.itemApplication?.conflict?.reason,
    'semantic_mismatch'
  );
  assert.deepEqual(merged.pageIntegrity, {
    complete: false,
    issuePageIndexes: [1],
  });
});

test('review preserva item equivalenti quando la proposta omette IVA legacy', () => {
  const current = quote();
  const merged = mergeDocumentPageFields([
    page(0, {
      items: [
        {
          description: '  RIGA   PRECEDENTE ',
          quantity: 1,
          unitPrice: 9,
          total: 9,
        },
      ],
    }),
  ]);
  const applied = applyDocumentFieldMerge(
    quote({ items: [] }),
    merged,
    {
      mode: 'preserve_existing',
      currentDocument: current,
    }
  ) as QuoteDocument;

  assert.equal(applied.items.length, 1);
  assert.equal(applied.items[0]?.vatRate, 22);
  assert.strictEqual(applied.items, current.items);
  assert.deepEqual(applied.fieldMerge?.itemApplication, {
    source: 'existing_record',
    reason: 'preserved_equivalent',
  });
  assert.equal(applied.fieldMerge?.itemApplication?.conflict, undefined);
  assert.equal(applied.fieldMerge?.requiresReview, false);
});

test('review applica proposta equivalente completa con la stessa IVA', () => {
  const current = quote();
  const merged = mergeDocumentPageFields([
    page(0, {
      items: [
        {
          description: 'Riga precedente',
          quantity: 1,
          unitPrice: 9,
          total: 9,
          vatRate: 22,
        },
      ],
    }),
  ]);
  const applied = applyDocumentFieldMerge(
    quote({ items: [] }),
    merged,
    {
      mode: 'preserve_existing',
      currentDocument: current,
    }
  ) as QuoteDocument;

  assert.deepEqual(applied.items, current.items);
  assert.notStrictEqual(applied.items, current.items);
  assert.deepEqual(applied.fieldMerge?.itemApplication, {
    source: 'page_groups',
    reason: 'complete_groups_applied',
  });
  assert.equal(applied.fieldMerge?.itemApplication?.conflict, undefined);
});

test('review tratta come conflitto una diversa IVA esplicita', () => {
  const current = quote();
  const merged = mergeDocumentPageFields([
    page(0, {
      items: [
        {
          description: 'Riga precedente',
          quantity: 1,
          unitPrice: 9,
          total: 9,
          vatRate: 10,
        },
      ],
    }),
  ]);
  const applied = applyDocumentFieldMerge(
    quote({ items: [] }),
    merged,
    {
      mode: 'preserve_existing',
      currentDocument: current,
    }
  ) as QuoteDocument;

  assert.strictEqual(applied.items, current.items);
  assert.equal(
    applied.fieldMerge?.itemApplication?.conflict?.reason,
    'semantic_mismatch'
  );
  assert.equal(applied.fieldMerge?.requiresReview, true);
});

test('review preserva item correnti e traccia proposta semanticamente diversa', () => {
  const current = quote();
  const merged = mergeDocumentPageFields([
    page(
      0,
      {
        items: [
          {
            description: 'Riga nuova',
            quantity: 1,
            unitPrice: 10,
            total: 10,
          },
        ],
      },
      { processingMethod: 'cloud' }
    ),
  ]);
  const applied = applyDocumentFieldMerge(
    quote({ items: [] }),
    merged,
    {
      mode: 'preserve_existing',
      currentDocument: current,
    }
  ) as QuoteDocument;
  const conflict = applied.fieldMerge?.itemApplication?.conflict;

  assert.deepEqual(applied.items, current.items);
  assert.equal(applied.fieldMerge?.itemApplication?.source, 'existing_record');
  assert.equal(
    applied.fieldMerge?.itemApplication?.reason,
    'preserved_conflict'
  );
  assert.equal(conflict?.reason, 'semantic_mismatch');
  assert.deepEqual(conflict?.currentItems, current.items);
  assert.equal(conflict?.proposedItems[0]?.description, 'Riga nuova');
  assert.deepEqual(conflict?.proposalSources, [
    {
      sourcePageIndex: 0,
      sourceMethod: 'cloud',
      validation: 'structural',
      reason: 'page_group_preserved',
    },
  ]);
  assert.equal(applied.fieldMerge?.requiresReview, true);
});

test('review applica item completi quando il record corrente è vuoto', () => {
  const current = quote({ items: [] });
  const merged = mergeDocumentPageFields([
    page(0, {
      items: [
        {
          description: 'Prima riga',
          quantity: 1,
          unitPrice: 15,
          total: 15,
        },
      ],
    }),
  ]);
  const applied = applyDocumentFieldMerge(current, merged, {
    mode: 'preserve_existing',
    currentDocument: current,
  }) as QuoteDocument;

  assert.equal(applied.items[0]?.description, 'Prima riga');
  assert.equal(
    applied.fieldMerge?.itemApplication?.source,
    'page_groups'
  );
  assert.equal(applied.fieldMerge?.itemApplication?.conflict, undefined);
});

test('free review conserva le chiavi correnti e aggiunge quelle namespaced', () => {
  const merged = mergeDocumentPageFields([
    page(0, {
      extractedFields: {
        field_1: 'NUOVO',
        field_2: 'AGGIUNTO',
      },
    }),
  ]);
  const current = {
    id: 'free-current',
    type: 'free_document' as const,
    title: 'Documento corrente',
    images: [],
    rawText: 'corrente',
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    extractedFields: {
      field_1: 'CORRENTE',
      page_1_field_1: 'GIÀ CONFERMATO',
    },
  };
  const applied = applyDocumentFieldMerge(current, merged, {
    mode: 'preserve_existing',
    currentDocument: current,
  });

  assert.equal(applied.type, 'free_document');
  if (applied.type !== 'free_document') return;
  assert.deepEqual(applied.extractedFields, {
    field_1: 'CORRENTE',
    page_1_field_1: 'GIÀ CONFERMATO',
    page_1_field_2: 'AGGIUNTO',
  });
  assert.equal(
    applied.fieldMerge?.extractedFieldsApplication?.source,
    'existing_record_and_page_groups'
  );
  assert.equal(
    applied.fieldMerge?.extractedFieldsApplication?.reason,
    'merged_namespaced_preserving_existing'
  );
  assert.deepEqual(
    applied.fieldMerge?.extractedFieldsApplication?.conflicts,
    [
      {
        key: 'page_1_field_1',
        reason: 'different_values',
        currentValue: 'GIÀ CONFERMATO',
        candidate: {
          value: 'NUOVO',
          sourcePageIndex: 0,
          sourceMethod: 'local',
          validation: 'unverified',
          reason: 'page_group_preserved',
        },
      },
    ]
  );
  assert.equal(applied.fieldMerge?.requiresReview, true);
});

test('free review non crea conflitto per la stessa chiave e valore', () => {
  const merged = mergeDocumentPageFields([
    page(0, { extractedFields: { field_1: 'STESSO' } }),
  ]);
  const current = {
    id: 'free-same-current',
    type: 'free_document' as const,
    title: 'Documento corrente',
    images: [],
    rawText: 'corrente',
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    extractedFields: {
      page_1_field_1: ' STESSO ',
    },
  };
  const applied = applyDocumentFieldMerge(current, merged, {
    mode: 'preserve_existing',
    currentDocument: current,
  });

  assert.equal(applied.type, 'free_document');
  if (applied.type !== 'free_document') return;
  assert.equal(
    applied.extractedFields.page_1_field_1,
    ' STESSO '
  );
  assert.equal(
    applied.fieldMerge?.extractedFieldsApplication?.conflicts,
    undefined
  );
  assert.equal(applied.fieldMerge?.requiresReview, false);
});

test('free review conserva la data corrente e rifiuta la proposta impossibile', () => {
  const merged = mergeDocumentPageFields([
    page(0, { date: '31/02/2026' }, { processingMethod: 'cloud' }),
  ]);
  const currentDate = new Date('2026-07-20T00:00:00.000Z');
  const current = {
    id: 'free-date-current',
    type: 'free_document' as const,
    title: 'Documento corrente',
    images: [],
    rawText: 'corrente',
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    documentDate: currentDate,
    extractedFields: {},
  };
  const rebuilt = {
    ...current,
    documentDate: undefined,
  };
  const applied = applyDocumentFieldMerge(rebuilt, merged, {
    mode: 'preserve_existing',
    currentDocument: current,
  });

  assert.equal(applied.type, 'free_document');
  if (applied.type !== 'free_document') return;
  assert.equal(applied.documentDate?.toISOString(), currentDate.toISOString());
  assert.equal(applied.fieldMerge?.fields.date, undefined);
  assert.equal(
    applied.fieldMerge?.fieldReliability.date?.rawValue,
    '31/02/2026'
  );
  assert.equal(
    applied.fieldMerge?.fieldReliability.date?.validationStatus,
    'invalid'
  );
  assert.equal(
    applied.fieldMerge?.appliedFields?.date?.value,
    '2026-07-20'
  );
  assert.equal(
    applied.fieldMerge?.appliedFields?.date?.reason,
    'preserved_absent'
  );
});

test('duplicato valido resta nel raw ma non contribuisce ai campi', () => {
  const merged = mergeDocumentPageFields([
    page(
      0,
      { documentNumber: 'Q-CANONICO', total: 100 },
      { imageUri: 'file:///same.jpg', rawText: 'ORIGINALE' }
    ),
    page(
      1,
      { documentNumber: 'Q-DUPLICATO', total: 999 },
      {
        imageUri: 'file:///same.jpg',
        duplicateOf: 0,
        rawText: 'COPIA',
        requiresReview: true,
      }
    ),
  ]);

  assert.equal(merged.fields.documentNumber?.value, 'Q-CANONICO');
  assert.equal(merged.fields.total?.value, 100);
  assert.deepEqual(merged.includedPageIndexes, [0]);
  assert.match(
    merged.rawText,
    /=== PAGE 2 \| local \| duplicate_of_page_1 ===\nCOPIA/
  );
});

test('rifiuta duplicateOf verso altra URI, avanti o a catena', () => {
  assert.throws(
    () =>
      mergeDocumentPageFields([
        page(0, {}, { imageUri: 'file:///one.jpg' }),
        page(1, {}, { imageUri: 'file:///two.jpg', duplicateOf: 0 }),
      ]),
    /duplicat|pagina|indice/i
  );
  assert.throws(
    () =>
      mergeDocumentPageFields([
        page(0, {}, { imageUri: 'file:///same.jpg', duplicateOf: 1 }),
        page(1, {}, { imageUri: 'file:///same.jpg' }),
      ]),
    /duplicat|pagina|indice/i
  );
  assert.throws(
    () =>
      mergeDocumentPageFields([
        page(0, {}, { imageUri: 'file:///same.jpg' }),
        page(1, {}, { imageUri: 'file:///same.jpg', duplicateOf: 0 }),
        page(2, {}, { imageUri: 'file:///same.jpg', duplicateOf: 1 }),
      ]),
    /duplicat|pagina|indice/i
  );
});

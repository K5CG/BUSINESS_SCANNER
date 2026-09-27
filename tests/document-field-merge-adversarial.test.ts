import assert from 'node:assert/strict';
import test from 'node:test';
import type { PageExtractionResult } from '../lib/document-page-extraction';
import {
  mergeDocumentPageFields,
  mergeResultToStructuredFields,
} from '../lib/document-field-merge';

function page(
  pageIndex: number,
  structuredFields: PageExtractionResult['structuredFields'] = {},
  overrides: Partial<PageExtractionResult> = {}
): PageExtractionResult {
  return {
    pageIndex,
    imageUri: `file:///page-${String(pageIndex)}.jpg`,
    processingMethod: 'local',
    rawText: `Pagina ${String(pageIndex + 1)}`,
    structuredFields,
    warnings: [],
    completed: true,
    requiresReview: false,
    ...overrides,
  };
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map(
      (tail) => [value, ...tail]
    )
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

test('il merge completo è deterministico per ogni permutazione delle pagine', () => {
  const pages = [
    page(
      0,
      {
        documentNumber: 'Q-100',
        total: 100,
        currency: 'EUR',
      },
      {
        rawText: 'Preventivo Q-100\nTotale EUR 100,00',
        fieldConfidence: { documentNumber: 0.82, total: 0.78 },
      }
    ),
    page(
      1,
      {
        documentNumber: ' q-100 ',
        vatAmount: 22,
        date: '31/02/2026',
      },
      {
        processingMethod: 'cloud',
        rawText: 'Q-100\nIVA 22\n31/02/2026',
      }
    ),
    page(
      2,
      {
        total: 101,
        items: [
          {
            description: 'Servizio',
            quantity: 1,
            unitPrice: 101,
            total: 101,
          },
        ],
      },
      {
        processingMethod: 'local_fallback',
        rawText: 'Servizio 1 101,00\nTotale 101,00',
        requiresReview: true,
      }
    ),
  ];

  const expected = mergeDocumentPageFields(pages);
  for (const candidateOrder of permutations(pages)) {
    assert.deepEqual(mergeDocumentPageFields(candidateOrder), expected);
  }
});

test('pageIndex negativo fallisce chiuso', () => {
  assert.throws(
    () => mergeDocumentPageFields([page(-1, { total: 10 })]),
    /pagina|page|indice|index/i
  );
});

test('pageIndex frazionario fallisce chiuso', () => {
  assert.throws(
    () => mergeDocumentPageFields([page(0.5, { total: 10 })]),
    /pagina|page|indice|index/i
  );
});

test('pageIndex NaN fallisce chiuso', () => {
  assert.throws(
    () => mergeDocumentPageFields([page(Number.NaN, { total: 10 })]),
    /pagina|page|indice|index/i
  );
});

test('due risultati con lo stesso pageIndex falliscono chiuso', () => {
  assert.throws(
    () =>
      mergeDocumentPageFields([
        page(0, { documentNumber: 'Q-ONE' }, { imageUri: 'file:///one.jpg' }),
        page(0, { documentNumber: 'Q-TWO' }, { imageUri: 'file:///two.jpg' }),
      ]),
    /pagina|page|indice|index|duplicat/i
  );
});

test('una pagina failed non contribuisce ai campi ma resta marcata nel rawText', () => {
  const merged = mergeDocumentPageFields([
    page(0, { total: 122 }, { rawText: 'Totale 122,00' }),
    page(
      1,
      { documentNumber: 'DA-NON-USARE', total: 999 },
      {
        processingMethod: 'failed',
        rawText: 'OCR conservato della pagina fallita',
        completed: false,
        requiresReview: true,
        error: 'strutturazione fallita',
      }
    ),
  ]);

  assert.equal(merged.fields.total?.value, 122);
  assert.equal(merged.fields.documentNumber, undefined);
  assert.match(merged.rawText, /=== PAGE 2 \| failed ===/);
  assert.match(merged.rawText, /OCR conservato della pagina fallita/);
  assert.equal(merged.requiresReview, true);
});

test('una pagina duplicata non aumenta evidenza, confidence o candidati', () => {
  const merged = mergeDocumentPageFields([
    page(
      0,
      { documentNumber: 'Q-100', total: 122 },
      {
        imageUri: 'file:///same.jpg',
        fieldConfidence: { documentNumber: 0.61, total: 0.62 },
      }
    ),
    page(
      1,
      { documentNumber: 'Q-100', total: 122 },
      {
        imageUri: 'file:///same.jpg',
        duplicateOf: 0,
        fieldConfidence: { documentNumber: 0.99, total: 0.99 },
        warnings: ['duplicate_page'],
        requiresReview: true,
      }
    ),
  ]);

  assert.deepEqual(merged.includedPageIndexes, [0]);
  assert.equal(merged.fields.documentNumber?.reason, 'single_candidate');
  assert.equal(merged.fields.documentNumber?.confidence, 0.61);
  assert.equal(merged.fields.total?.confidence, 0.62);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.requiresReview, true);
});

test('un campo cloud senza confidence non riceve confidence inventata', () => {
  const merged = mergeDocumentPageFields([
    page(
      0,
      { documentNumber: 'CLOUD-7', total: 77 },
      {
        processingMethod: 'cloud',
        rawText: 'Documento CLOUD-7\nTotale 77,00',
      }
    ),
  ]);

  const documentNumber = merged.fields.documentNumber;
  const total = merged.fields.total;
  assert.equal(documentNumber?.sourceMethod, 'cloud');
  assert.equal(total?.sourceMethod, 'cloud');
  assert.equal('confidence' in (documentNumber ?? {}), false);
  assert.equal('confidence' in (total ?? {}), false);
});

test('la provenienza local_fallback non viene promossa a cloud', () => {
  const merged = mergeDocumentPageFields([
    page(
      0,
      { total: 88 },
      {
        processingMethod: 'local_fallback',
        fieldConfidence: { total: 0.47 },
        warnings: ['cloud_fallback'],
        error: 'cloud non disponibile',
        requiresReview: true,
      }
    ),
  ]);

  assert.equal(merged.fields.total?.sourceMethod, 'local_fallback');
  assert.equal(merged.fields.total?.sourcePageIndex, 0);
  assert.equal(merged.fields.total?.confidence, 0.47);
  assert.equal(merged.requiresReview, true);
});

test('gli item parziali di pagine diverse non vengono fusi in un item ibrido', () => {
  const merged = mergeDocumentPageFields([
    page(0, {
      items: [{ description: 'Consulenza', quantity: 2 }],
    }),
    page(1, {
      items: [{ unitPrice: 50, total: 100 }],
    }),
  ]);

  assert.equal(merged.itemGroups.length, 2);
  assert.deepEqual(
    merged.itemGroups.map((group) => group.sourcePageIndex),
    [0, 1]
  );
  assert.deepEqual(merged.itemGroups[0]?.value, [
    { description: 'Consulenza', quantity: 2 },
  ]);
  assert.deepEqual(merged.itemGroups[1]?.value, [
    { unitPrice: 50, total: 100 },
  ]);
  assert.deepEqual(mergeResultToStructuredFields(merged).items, [
    { description: 'Consulenza', quantity: 2 },
    { unitPrice: 50, total: 100 },
  ]);
});

test('il merge non muta input e strutture annidate congelate', () => {
  const input = deepFreeze([
    page(
      1,
      {
        customerName: 'Cliente',
        items: [
          {
            description: 'Voce',
            quantity: 1,
            unitPrice: 10,
            total: 10,
          },
        ],
      },
      {
        warnings: ['warning_originale'],
        fieldConfidence: { customerName: 0.7, items: 0.6 },
      }
    ),
    page(0, { documentNumber: 'Q-FROZEN' }),
  ]);
  const before = JSON.stringify(input);

  assert.doesNotThrow(() => mergeDocumentPageFields(input));
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input[0]?.structuredFields.items), true);
});

test('la data impossibile viene classificata invalid e non diventa applicabile', () => {
  const merged = mergeDocumentPageFields([
    page(0, { date: '31/02/2026' }, { processingMethod: 'cloud' }),
  ]);

  assert.equal(merged.fields.date, undefined);
  assert.equal(merged.fieldReliability.date?.rawValue, '31/02/2026');
  assert.equal(
    merged.fieldReliability.date?.validationStatus,
    'invalid'
  );
  assert.equal(merged.fieldReliability.date?.requiresReview, true);
  assert.equal(merged.requiresReview, true);
});

test('rawText usa marker espliciti e ordinati con pagina e stato', () => {
  const merged = mergeDocumentPageFields([
    page(
      2,
      {},
      {
        processingMethod: 'failed',
        rawText: '',
        completed: false,
        requiresReview: true,
      }
    ),
    page(
      1,
      {},
      {
        processingMethod: 'local_fallback',
        rawText: 'DUE',
        requiresReview: true,
      }
    ),
    page(0, {}, { processingMethod: 'local', rawText: 'UNO' }),
  ]);

  assert.equal(
    merged.rawText,
    [
      '=== PAGE 1 | local ===',
      'UNO',
      '',
      '=== PAGE 2 | local_fallback ===',
      'DUE',
      '',
      '=== PAGE 3 | failed ===',
    ].join('\n')
  );
});

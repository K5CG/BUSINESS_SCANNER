import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPdfItemsPassParseDiagnostics,
  buildPdfItemsPassProviderDiagnostics,
  diagnoseFlatItemRejection,
  mergePdfPasses,
  parsePdfItemsResponse,
} from '../supabase/functions/_shared/gemini-extract';

/**
 * Forma reale osservata sulla sonda del PDF complesso: 10 righe con wrapper
 * structured nei campi top-level.
 */
function wrappedItemsResponse(count: number): string {
  return JSON.stringify({
    items: Array.from({ length: count }, (_, index) => ({
      itemCode: {
        value: `A-${index + 1}`,
        pageIndex: 0,
        evidenceText: `A-${index + 1}`,
        confidenceType: 'heuristic',
        requiresReview: false,
        alternatives: [],
      },
      description: {
        value: `Riga ${index + 1}`,
        pageIndex: 0,
        evidenceText: `Riga ${index + 1}`,
        confidenceType: 'heuristic',
        requiresReview: false,
        alternatives: [],
      },
      quantity: {
        value: 1,
        pageIndex: 0,
        evidenceText: '1',
        confidenceType: 'heuristic',
        requiresReview: false,
        alternatives: [],
      },
      unitPrice: {
        value: 100,
        pageIndex: 0,
        evidenceText: '100',
        confidenceType: 'heuristic',
        requiresReview: false,
        alternatives: [],
      },
      lineTotal: {
        value: 100,
        pageIndex: 0,
        evidenceText: '100',
        confidenceType: 'heuristic',
        requiresReview: false,
        alternatives: [],
      },
      pageIndex: 0,
      evidenceText: `A-${index + 1}`,
      requiresReview: false,
    })),
  });
}

test('la diagnostica vede 10 righe raw e 10 dopo l unwrap', () => {
  const text = wrappedItemsResponse(10);
  const provider = buildPdfItemsPassProviderDiagnostics(text, {
    httpStatus: 200,
    finishReason: 'STOP',
  });
  assert.equal(provider.jsonParsed, true);
  assert.equal(provider.itemsArrayPresent, true);
  assert.equal(provider.itemsArrayLength, 10);
  assert.deepEqual(provider.firstItemKeys?.slice(0, 3), [
    'itemCode',
    'description',
    'quantity',
  ]);

  const parsed = parsePdfItemsResponse(text);
  const afterParse = buildPdfItemsPassParseDiagnostics(text, parsed);
  assert.equal(afterParse.itemsBeforeNormalization, 10);
  assert.equal(afterParse.itemsAfterNormalization, 10);
  assert.equal(afterParse.structuredItemsCount, 10);
  assert.equal(afterParse.rejectedItems, 0);
  assert.deepEqual(afterParse.rejectionReasons, {});
});

test('un wrapper senza value resta rifiutato dalla diagnostica', () => {
  const reason = diagnoseFlatItemRejection({
    description: { pageIndex: 0, evidenceText: 'Banco' },
    quantity: { pageIndex: 0, evidenceText: '2' },
    unitPrice: { evidenceText: '780' },
  });
  assert.equal(reason, 'noUsableFlatScalars');
});

test('il merge conserva le dieci righe wrappate', () => {
  const text = wrappedItemsResponse(10);
  const items = parsePdfItemsResponse(text);
  const merged = mergePdfPasses(
    {
      rawText: 'INTESTAZIONE',
      documentNumber: 'PV-2026-0811',
      subtotal: 9482.5,
      vatAmount: 2086.15,
      total: 11568.65,
    },
    items
  );
  assert.equal(items?.rawItems && Array.isArray(items.rawItems) ? items.rawItems.length : 0, 10);
  assert.equal(items?.items?.length ?? 0, 10);
  assert.equal(merged.items?.length ?? 0, 10);
});

test('le righe piatte continuano a passare', () => {
  const text = JSON.stringify({
    items: [
      { description: 'Riga', quantity: 1, unitPrice: 10, total: 10 },
      { description: 'Altra', quantity: 2, unitPrice: 5, lineTotal: 10 },
    ],
  });
  const parsed = parsePdfItemsResponse(text);
  const afterParse = buildPdfItemsPassParseDiagnostics(text, parsed);
  assert.equal(afterParse.itemsBeforeNormalization, 2);
  assert.equal(afterParse.itemsAfterNormalization, 2);
  assert.deepEqual(afterParse.rejectionReasons, {});
});

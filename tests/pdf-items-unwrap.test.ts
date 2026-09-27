import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPdfItemsPassParseDiagnostics,
  mergePdfPasses,
  parsePdfItemsResponse,
} from '../supabase/functions/_shared/gemini-extract';

function wrap(value: unknown) {
  return {
    value,
    pageIndex: 0,
    evidenceText: String(value),
    confidenceType: 'heuristic',
    requiresReview: false,
    alternatives: [],
  };
}

test('A. riga piatta primitiva resta accettata', () => {
  const parsed = parsePdfItemsResponse(
    JSON.stringify({
      items: [
        {
          description: 'Banco da lavoro',
          quantity: 2,
          unitPrice: 780,
          total: 1482,
        },
      ],
    })
  );
  assert.deepEqual(parsed?.items, [
    {
      description: 'Banco da lavoro',
      quantity: 2,
      unitPrice: 780,
      total: 1482,
    },
  ]);
});

test('B. riga interamente wrappata viene accettata', () => {
  const parsed = parsePdfItemsResponse(
    JSON.stringify({
      items: [
        {
          itemCode: wrap('A-100'),
          description: wrap('Banco da lavoro'),
          quantity: wrap(2),
          unit: wrap('pz'),
          unitPrice: wrap(780),
          discount: wrap(5),
          vatRate: wrap(22),
          lineTotal: wrap(1482),
        },
      ],
    })
  );
  assert.deepEqual(parsed?.items, [
    {
      description: 'Banco da lavoro',
      quantity: 2,
      unitPrice: 780,
      total: 1482,
    },
  ]);
  assert.equal(parsed?.structuredItems?.length, 1);
});

test('C. riga mista wrappata e primitiva viene accettata', () => {
  const parsed = parsePdfItemsResponse(
    JSON.stringify({
      items: [
        {
          description: wrap('Cassettiera'),
          quantity: 2,
          unitPrice: wrap(425),
          total: 850,
        },
      ],
    })
  );
  assert.deepEqual(parsed?.items, [
    {
      description: 'Cassettiera',
      quantity: 2,
      unitPrice: 425,
      total: 850,
    },
  ]);
});

test('D. dieci righe wrappate restano dieci dopo la normalizzazione', () => {
  const text = JSON.stringify({
    items: Array.from({ length: 10 }, (_, index) => ({
      itemCode: wrap(`A-${index + 1}`),
      description: wrap(`Riga ${index + 1}`),
      quantity: wrap(1),
      unitPrice: wrap(100 + index),
      lineTotal: wrap(100 + index),
    })),
  });
  const parsed = parsePdfItemsResponse(text);
  const afterParse = buildPdfItemsPassParseDiagnostics(text, parsed);
  assert.equal(afterParse.itemsBeforeNormalization, 10);
  assert.equal(afterParse.itemsAfterNormalization, 10);
  assert.equal(parsed?.items?.length, 10);
  assert.equal(parsed?.structuredItems?.length, 10);
  assert.deepEqual(afterParse.rejectionReasons, {});
});

test('E. wrapper senza value viene scartato in sicurezza', () => {
  const parsed = parsePdfItemsResponse(
    JSON.stringify({
      items: [
        {
          description: { pageIndex: 0, evidenceText: 'senza valore' },
          quantity: { pageIndex: 0 },
          unitPrice: { evidenceText: 'x' },
        },
        {
          description: 'Riga valida',
          quantity: 1,
          unitPrice: 10,
          total: 10,
        },
      ],
    })
  );
  assert.deepEqual(parsed?.items, [
    {
      description: 'Riga valida',
      quantity: 1,
      unitPrice: 10,
      total: 10,
    },
  ]);
});

test('F. senza structured.items le righe top-level wrappate arrivano al merge', () => {
  const text = JSON.stringify({
    items: Array.from({ length: 10 }, (_, index) => ({
      description: wrap(`Riga ${index + 1}`),
      quantity: wrap(1),
      unitPrice: wrap(100),
      lineTotal: wrap(100),
    })),
  });
  const items = parsePdfItemsResponse(text);
  assert.equal(items?.structuredItems?.length, 10);
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
  assert.equal(merged.items?.length, 10);
  assert.equal((merged.structured?.items as unknown[] | undefined)?.length, 10);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDocumentFromExtract } from '../lib/document-from-extract';
import { withAiStructuredExtraction } from '../lib/pdf-ai-authority';
import type { GeminiDocumentExtract } from '../lib/gemini-document-extract';
import type { QuoteDocument } from '../types';

function quoteExtract(
  items: NonNullable<GeminiDocumentExtract['items']>,
  extras: Partial<GeminiDocumentExtract> = {}
): GeminiDocumentExtract {
  return {
    rawText:
      'PREVENTIVO PV-2026-0811\nTECNOSERVICE VENETO S.r.l.\nOFFICINE MARALDI S.p.A.\nEUR 9482.50',
    documentNumber: 'PV-2026-0811',
    customerName: 'OFFICINE MARALDI S.p.A.',
    date: '2026-08-11',
    subtotal: 9482.5,
    vatAmount: 2086.15,
    total: 11568.65,
    items,
    ...extras,
  };
}

function asQuote(extract: GeminiDocumentExtract): QuoteDocument {
  return withAiStructuredExtraction(
    buildDocumentFromExtract('quote', extract),
    extract
  ) as QuoteDocument;
}

test('un extract con 10 righe PDF normalizzate diventa un documento con 10 items', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({
    description: `Riga ${index + 1}`,
    quantity: 1,
    unitPrice: 100 + index,
    total: 100 + index,
  }));
  const document = asQuote(quoteExtract(items));
  assert.equal(document.items.length, 10);
});

test('una sola riga valida sopravvive al build', () => {
  const document = asQuote(
    quoteExtract([
      {
        description: 'Banco da lavoro',
        quantity: 2,
        unitPrice: 780,
        total: 1482,
      },
    ])
  );
  assert.equal(document.items.length, 1);
  assert.equal(document.items[0]?.description, 'Banco da lavoro');
});

test('code e discount assenti non cancellano la riga', () => {
  const document = asQuote(
    quoteExtract([
      {
        description: 'Servizio',
        quantity: 1,
        unitPrice: 95,
        total: 95,
      },
    ])
  );
  assert.equal(document.items.length, 1);
});

test('campi opzionali misti restano accettati', () => {
  const document = asQuote(
    quoteExtract([
      {
        description: 'PC industriale',
        quantity: 1,
        unitPrice: 1490,
        total: 1341,
      },
      {
        description: 'Licenza software',
        quantity: 1,
        unitPrice: 980,
        total: 980,
      },
    ])
  );
  assert.equal(document.items.length, 2);
});

test('IVA documento a zero esplicita non cancella le righe', () => {
  const document = asQuote(
    quoteExtract(
      [
        {
          description: 'Manutenzione',
          quantity: 1,
          unitPrice: 3250,
          total: 3250,
        },
      ],
      { vatAmount: 0, subtotal: 3250, total: 3250 }
    )
  );
  assert.equal(document.items.length, 1);
});

test('rawFields.items wrappati non devono cancellare items normalizzati', () => {
  const flat = Array.from({ length: 10 }, (_, index) => ({
    description: `Riga ${index + 1}`,
    quantity: 1,
    unitPrice: 100,
    total: 100,
  }));
  const wrapped = flat.map((item) => ({
    description: { value: item.description, evidenceText: item.description },
    quantity: { value: item.quantity, evidenceText: String(item.quantity) },
    unitPrice: { value: item.unitPrice, evidenceText: String(item.unitPrice) },
    lineTotal: { value: item.total, evidenceText: String(item.total) },
  }));
  const document = asQuote(
    quoteExtract(flat, {
      rawFields: { items: wrapped },
    })
  );
  assert.equal(document.items.length, 10);
});

test('una riga malformata non cancella le altre valide', () => {
  const document = asQuote(
    quoteExtract([
      { description: 'Valida', quantity: 1, unitPrice: 10, total: 10 },
      { description: 'Senza prezzi' },
      { description: 'Altra valida', quantity: 2, unitPrice: 5, total: 10 },
    ])
  );
  assert.equal(document.items.length, 2);
  assert.deepEqual(
    document.items.map((item) => item.description),
    ['Valida', 'Altra valida']
  );
});

test('lineTotal è accettato come alias di total in normalizzazione', async () => {
  const { normalizeGeminiDocumentExtract } = await import(
    '../lib/gemini-document-extract'
  );
  const normalized = normalizeGeminiDocumentExtract({
    rawText: 'PREVENTIVO\nEUR',
    items: [
      {
        description: 'Trasporto',
        quantity: 1,
        unitPrice: 140,
        lineTotal: 140,
      },
    ],
  });
  assert.equal(normalized?.items?.[0]?.total, 140);
  const document = asQuote(normalized!);
  assert.equal(document.items.length, 1);
  assert.equal(document.items[0]?.total, 140);
});

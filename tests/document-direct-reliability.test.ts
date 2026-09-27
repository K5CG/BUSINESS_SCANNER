import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderDocument, QuoteDocument } from '../types';
import { buildDocumentFromExtract } from '../lib/document-from-extract';
import { buildDocumentReviewViewModel } from '../lib/document-review-view-model';
import { parseSparseDocumentPageFields } from '../lib/document-parser';

function asQuote(document: ReturnType<typeof buildDocumentFromExtract>): QuoteDocument {
  assert.equal(document.type, 'quote');
  return document as QuoteDocument;
}

function asOrder(document: ReturnType<typeof buildDocumentFromExtract>): OrderDocument {
  assert.equal(document.type, 'order');
  return document as OrderDocument;
}

test('un documento PDF con sola reliability espone comunque la review', () => {
  const document = buildDocumentFromExtract('quote', {
    rawText: 'Solo testo PDF senza campi strutturati',
  });
  const viewModel = buildDocumentReviewViewModel(
    document.fieldMerge,
    document.fieldReliability
  );

  assert.equal(document.fieldMerge, undefined);
  assert.equal(document.pageExtractions, undefined);
  assert.equal(viewModel.requiresReview, true);
  assert.equal(viewModel.fields.length > 0, true);
  assert.equal(
    viewModel.fields.every(
      (field) => field.validationStatus === 'missing'
    ),
    true
  );
});

test('enrichment PDF discordante conserva entrambe le alternative senza applicarle', () => {
  const document = asQuote(
    buildDocumentFromExtract('quote', {
      rawText: 'Preventivo Q-1\nTotale: 1.400,00',
      total: 1.4,
    })
  );

  assert.equal(document.total, undefined);
  assert.equal(document.fieldReliability?.total?.source, 'merged');
  assert.equal(document.fieldReliability?.total?.conflict, true);
  assert.equal(document.fieldReliability?.total?.requiresReview, true);
  assert.deepEqual(
    document.fieldReliability?.total?.alternatives.map(
      (alternative) => alternative.value
    ),
    [1.4, 1400]
  );
});

test('item PDF misti non vengono applicati parzialmente e restano visibili in review', () => {
  const extract = {
    rawText:
      'Servizio completo 1 10,00 10,00\nServizio parziale',
    items: [
      {
        description: 'Servizio completo',
        quantity: 1,
        unitPrice: 10,
        total: 10,
      },
      {
        description: 'Servizio parziale',
        quantity: 1,
      },
    ],
  };

  for (const document of [
    asQuote(buildDocumentFromExtract('quote', extract)),
    asOrder(buildDocumentFromExtract('order', extract)),
  ]) {
    assert.deepEqual(document.items, []);
    assert.deepEqual(document.fieldReliability?.items?.value, []);
    assert.equal(
      document.fieldReliability?.items?.validationStatus,
      'missing'
    );
    assert.equal(document.fieldReliability?.items?.requiresReview, true);
    assert.equal(
      document.fieldReliability?.items?.alternatives.some(
        (alternative) =>
          alternative.validationStatus === 'unverified' &&
          Array.isArray(alternative.value) &&
          alternative.value.length === 2
      ),
      true
    );

    const viewModel = buildDocumentReviewViewModel(
      document.fieldMerge,
      document.fieldReliability
    );
    const items = viewModel.fields.find(
      (field) => field.field === 'items'
    );
    assert.equal(viewModel.requiresReview, true);
    assert.equal(items?.requiresReview, true);
    assert.equal(items?.alternatives.length, 1);
  }
});

test('una scadenza PDF non diventa data documento diretta o locale', () => {
  for (const rawText of [
    'Valido fino: 30/09/2026',
    'Data documento - Valido fino: 30/09/2026',
    'Data ordine consegna: 30/09/2026',
  ]) {
    const extract = {
      rawText,
      date: '2026-09-30',
    };
    const quote = asQuote(buildDocumentFromExtract('quote', extract));
    const order = asOrder(buildDocumentFromExtract('order', extract));

    assert.equal(quote.quoteDate, undefined);
    assert.equal(order.orderDate, undefined);
    assert.equal(
      quote.fieldReliability?.date?.validationStatus,
      'ambiguous'
    );
    assert.equal(
      order.fieldReliability?.date?.validationStatus,
      'ambiguous'
    );

    assert.equal(
      parseSparseDocumentPageFields(
        'quote',
        [{ text: rawText, confidence: 0.9 }],
        rawText
      ).date,
      undefined
    );
    assert.equal(
      parseSparseDocumentPageFields(
        'order',
        [{ text: rawText, confidence: 0.9 }],
        rawText
      ).date,
      undefined
    );
  }
});

test('campi derivati dal rawText PDF conservano provenienza cloud e review', () => {
  const quote = asQuote(
    buildDocumentFromExtract('quote', {
      rawText: 'Totale: 100,00 EUR',
    })
  );
  assert.equal(quote.total, 100);
  assert.equal(quote.fieldReliability?.total?.source, 'cloud_ai');
  assert.equal(
    quote.fieldReliability?.total?.confidenceType,
    'unknown'
  );
  assert.equal(quote.fieldReliability?.total?.requiresReview, true);
  assert.equal(quote.fieldReliability?.currency?.source, 'cloud_ai');
  assert.equal(quote.fieldReliability?.currency?.requiresReview, true);

  const free = buildDocumentFromExtract('free_document', {
    rawText:
      'Documento DOC-7\nData documento: 20/07/2026',
  });
  assert.equal(free.type, 'free_document');
  if (free.type !== 'free_document') return;
  assert.equal(
    free.fieldReliability?.documentNumber?.source,
    'cloud_ai'
  );
  assert.equal(
    free.fieldReliability?.documentNumber?.requiresReview,
    true
  );
  assert.equal(free.fieldReliability?.date?.source, 'cloud_ai');
  assert.equal(free.fieldReliability?.date?.requiresReview, true);

  for (const evidence of Object.values(
    quote.fieldReliability ?? {}
  )) {
    if (evidence?.value === undefined) continue;
    assert.notEqual(evidence.source, 'local_ocr');
  }
  for (const evidence of Object.values(
    free.fieldReliability ?? {}
  )) {
    if (evidence?.value === undefined) continue;
    assert.notEqual(evidence.source, 'local_ocr');
  }
});

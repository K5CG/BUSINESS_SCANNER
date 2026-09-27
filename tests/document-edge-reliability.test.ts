import assert from 'node:assert/strict';
import test from 'node:test';
import { pageResultFromCloudExtract } from '../lib/document-page-extraction';
import { parseJsonResponse } from '../supabase/functions/_shared/gemini-extract';

test('il confine Edge non converte stringhe numeriche permissive', () => {
  for (const rawAmount of ['0x10', '1e3']) {
    const parsed = parseJsonResponse(
      JSON.stringify({
        rawText: `Totale: ${rawAmount}`,
        total: rawAmount,
      })
    );

    assert.ok(parsed);
    assert.equal(parsed.total, undefined);
    assert.equal(parsed.rawFields?.total, rawAmount);

    const page = pageResultFromCloudExtract(
      0,
      `file:///edge-${rawAmount}.jpg`,
      parsed
    );
    assert.equal(page.structuredFields.total, undefined);
    assert.equal(page.fieldReliability?.total?.rawValue, rawAmount);
    assert.equal(
      page.fieldReliability?.total?.validationStatus,
      'invalid'
    );
  }
});

test('il confine Edge conserva zero numerico e rawFields originali', () => {
  const parsed = parseJsonResponse(
    JSON.stringify({
      rawText: 'Totale: 0,00',
      total: 0,
    })
  );

  assert.ok(parsed);
  assert.equal(parsed.total, 0);
  assert.equal(parsed.rawFields?.total, 0);
});

test('un numero item permissivo resta invalido senza completare la riga', () => {
  const rawItems = [
    {
      description: 'Servizio',
      quantity: '0x10',
      unitPrice: 10,
      total: 10,
    },
  ];
  const parsed = parseJsonResponse(
    JSON.stringify({
      rawText: 'Servizio quantità non leggibile 10,00 10,00',
      items: rawItems,
    })
  );

  assert.ok(parsed);
  assert.deepEqual(parsed.items, [
    {
      description: 'Servizio',
      unitPrice: 10,
      total: 10,
    },
  ]);
  assert.deepEqual(parsed.rawFields?.items, rawItems);

  const page = pageResultFromCloudExtract(
    0,
    'file:///edge-invalid-item-number.jpg',
    parsed
  );
  assert.equal(page.structuredFields.items, undefined);
  assert.equal(
    page.fieldReliability?.items?.validationStatus,
    'invalid'
  );
});

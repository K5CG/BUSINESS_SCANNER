import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectDocumentAssetUris,
  splitFinalDocumentAssetUris,
} from '../lib/document-asset-routing';

test('frame e originali entrano nello staging in ordine deterministico', () => {
  assert.deepEqual(
    collectDocumentAssetUris({
      images: ['frame-0', 'frame-1'],
      originalImages: ['original-0', 'original-1'],
    }),
    ['frame-0', 'frame-1', 'original-0', 'original-1'],
  );
});

test('asset promossi vengono risuddivisi senza scambiare frame e originali', () => {
  assert.deepEqual(
    splitFinalDocumentAssetUris(
      ['final-frame-0', 'final-frame-1', 'final-original-0', 'final-original-1'],
      2,
      true,
    ),
    {
      images: ['final-frame-0', 'final-frame-1'],
      originalImages: ['final-original-0', 'final-original-1'],
    },
  );
});

test('conteggio incompleto fallisce chiuso prima del commit DB', () => {
  assert.throws(
    () => splitFinalDocumentAssetUris(['frame-0', 'original-0', 'orphan'], 1, true),
    /non allineati/,
  );
});

test('record legacy senza originali conserva il routing storico', () => {
  assert.deepEqual(
    splitFinalDocumentAssetUris(['final-frame-0'], 1, false),
    { images: ['final-frame-0'] },
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ImageManipulationError,
  ImageOutputNotDistinctError,
  ImageUpscaleError,
  InvalidImageDimensionsError,
  MissingImageOutputUriError,
  dimensionsAfterExifRotation,
  imagePipelineUris,
  planImageActions,
  planLongSideResize,
  prepareImageOnce,
} from '../lib/image-preparation';
import { runAssetSaveSaga } from '../lib/asset-persistence-core';

const OCR_LIMIT = 2600;

test('4A-01 landscape 4000x2000 limita width e mantiene il rapporto', () => {
  const plan = planLongSideResize(4000, 2000, OCR_LIMIT);
  assert.equal(plan.orientation, 'landscape');
  assert.deepEqual(plan.output, { width: 2600, height: 1300 });
  assert.deepEqual(plan.action, { resize: { width: 2600 } });
  assert.equal(plan.scale, 0.65);
});

test('4A-02 portrait 2000x4000 limita height e mantiene il rapporto', () => {
  const plan = planLongSideResize(2000, 4000, OCR_LIMIT);
  assert.equal(plan.orientation, 'portrait');
  assert.deepEqual(plan.output, { width: 1300, height: 2600 });
  assert.deepEqual(plan.action, { resize: { height: 2600 } });
});

test('4A-03 landscape inferiore al limite non viene ingrandita', () => {
  const plan = planLongSideResize(2400, 1200, OCR_LIMIT);
  assert.equal(plan.shouldResize, false);
  assert.equal(plan.scale, 1);
  assert.equal(plan.action, null);
  assert.deepEqual(plan.output, { width: 2400, height: 1200 });
});

test('4A-04 portrait inferiore al limite non viene ingrandita', () => {
  const plan = planLongSideResize(1200, 2400, OCR_LIMIT);
  assert.equal(plan.shouldResize, false);
  assert.equal(plan.action, null);
  assert.deepEqual(plan.output, { width: 1200, height: 2400 });
});

test('4A-05 quadrata superiore al limite riduce entrambi i lati', () => {
  const plan = planLongSideResize(3200, 3200, OCR_LIMIT);
  assert.equal(plan.orientation, 'square');
  assert.deepEqual(plan.output, { width: 2600, height: 2600 });
  assert.deepEqual(plan.action, { resize: { width: 2600, height: 2600 } });
});

test('4A-06 quadrata inferiore al limite resta invariata', () => {
  const plan = planLongSideResize(1800, 1800, OCR_LIMIT);
  assert.equal(plan.shouldResize, false);
  assert.deepEqual(plan.output, { width: 1800, height: 1800 });
});

test('4A-07 larghezza esattamente al limite non genera trasformazione', () => {
  const plan = planLongSideResize(2600, 1300, OCR_LIMIT);
  assert.equal(plan.reason, 'within_limit');
  assert.equal(plan.action, null);
});

test('4A-08 altezza esattamente al limite non genera trasformazione', () => {
  const plan = planLongSideResize(1300, 2600, OCR_LIMIT);
  assert.equal(plan.reason, 'within_limit');
  assert.equal(plan.action, null);
});

test('4A-09 EXIF 90 viene applicato prima della scelta del lato lungo', () => {
  const normalized = dimensionsAfterExifRotation(4000, 2000, 90);
  const plan = planLongSideResize(normalized.width, normalized.height, OCR_LIMIT);
  assert.deepEqual(plan.oriented, { width: 2000, height: 4000 });
  assert.equal(plan.orientation, 'portrait');
  assert.deepEqual(plan.action, { resize: { height: 2600 } });
});

test('4A-10 EXIF 180 mantiene le dimensioni e limita la width', () => {
  const normalized = dimensionsAfterExifRotation(4000, 2000, 180);
  const plan = planLongSideResize(normalized.width, normalized.height, OCR_LIMIT);
  assert.deepEqual(plan.oriented, { width: 4000, height: 2000 });
  assert.deepEqual(plan.action, { resize: { width: 2600 } });
});

test('4A-11 EXIF 270 scambia le dimensioni una sola volta', () => {
  const normalized = dimensionsAfterExifRotation(4000, 2000, 270);
  assert.deepEqual(normalized, {
    width: 2000,
    height: 4000,
  });
  const plan = planLongSideResize(normalized.width, normalized.height, OCR_LIMIT);
  assert.deepEqual(plan.oriented, { width: 2000, height: 4000 });
  assert.deepEqual(plan.action, { resize: { height: 2600 } });
});

test('4A-12 dimensioni mancanti vengono rifiutate prima della libreria', () => {
  assert.throws(
    () => planLongSideResize(undefined, 2000, OCR_LIMIT),
    InvalidImageDimensionsError
  );
  assert.throws(
    () => planLongSideResize(2000, undefined, OCR_LIMIT),
    InvalidImageDimensionsError
  );
});

test('4A-13 dimensioni zero, negative o non finite vengono rifiutate', () => {
  for (const [width, height] of [
    [0, 100],
    [100, 0],
    [-1, 100],
    [100, Number.NaN],
    [Number.POSITIVE_INFINITY, 100],
  ]) {
    assert.throws(
      () => planLongSideResize(width, height, OCR_LIMIT),
      InvalidImageDimensionsError
    );
  }
});

test('4A-14 il pianificatore blocca esplicitamente ogni upscale', () => {
  assert.throws(
    () =>
      planImageActions(
        [{ resize: { width: 2600 } }],
        2000,
        1000
      ),
    ImageUpscaleError
  );
});

test('4A-15 aspect ratio resta invariato entro il solo arrotondamento pixel', () => {
  for (const [width, height] of [
    [4032, 3024],
    [3024, 4032],
    [5001, 1777],
    [1777, 5001],
    [3200, 3200],
  ]) {
    const plan = planLongSideResize(width, height, OCR_LIMIT);
    const before = width / height;
    const after = plan.output.width / plan.output.height;
    assert.ok(Math.abs(before - after) / before < 0.001);
  }
});

test('4A-16 immagine OCR distinta dall’originale quando serve una trasformazione', async () => {
  const prepared = await prepareImageOnce(
    'file:///cache/original.jpg',
    [{ resize: { width: 2600 } }],
    4000,
    2000,
    async () => ({
      uri: 'file:///cache/prepared.jpg',
      width: 2600,
      height: 1300,
    })
  );
  const uris = imagePipelineUris('file:///cache/original.jpg', prepared.preparedUri);

  assert.equal(prepared.transformed, true);
  assert.notEqual(uris.originalUri, uris.ocrPreparedUri);
  assert.equal(uris.previewUri, uris.ocrPreparedUri);
  assert.equal(uris.persistenceSourceUri, uris.ocrPreparedUri);
});

test('4A-17 crop, rotazioni e resize vengono inviati in una sola trasformazione', async () => {
  let calls = 0;
  let receivedActions = 0;
  const prepared = await prepareImageOnce(
    'file:///cache/source.jpg',
    [
      { rotate: 90 },
      { crop: { originX: 100, originY: 100, width: 2000, height: 3000 } },
      { rotate: 90 },
      { resize: { width: 2600 } },
    ],
    4000,
    3000,
    async (_uri, actions) => {
      calls += 1;
      receivedActions = actions.length;
      return {
        uri: 'file:///cache/prepared-once.jpg',
        width: 2600,
        height: 1733,
      };
    }
  );

  assert.equal(calls, 1);
  assert.equal(receivedActions, 4);
  assert.equal(prepared.transformCount, 1);
});

test('4A-18 errore della libreria viene propagato con causa', async () => {
  const nativeError = new Error('native resize failed');
  await assert.rejects(
    prepareImageOnce(
      'file:///cache/source.jpg',
      [{ resize: { width: 2600 } }],
      4000,
      2000,
      async () => {
        throw nativeError;
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof ImageManipulationError);
      assert.equal(error.cause, nativeError);
      return true;
    }
  );
});

test('4A-19 URI di output mancante viene rifiutato', async () => {
  await assert.rejects(
    prepareImageOnce(
      'file:///cache/source.jpg',
      [{ resize: { width: 2600 } }],
      4000,
      2000,
      async () => ({ uri: '', width: 2600, height: 1300 })
    ),
    MissingImageOutputUriError
  );
});

test('4A-20 la sorgente preparata resta compatibile con la saga atomica Fase 1', async () => {
  const uris = imagePipelineUris(
    'content://camera/original',
    'file:///cache/ocr-prepared.jpg'
  );
  const calls: string[] = [];
  let persistedUri = '';

  await runAssetSaveSaga({
    stage: async () => {
      calls.push(`stage:${uris.persistenceSourceUri}`);
    },
    promote: async () => {
      calls.push('promote');
    },
    persist: async () => {
      persistedUri = 'file:///documents/scans/id/page-0-operation.jpg';
      calls.push('persist');
    },
    isPersisted: async () => false,
    rollbackAssets: async () => {
      calls.push('rollback');
    },
  });

  assert.deepEqual(calls, [
    'stage:file:///cache/ocr-prepared.jpg',
    'promote',
    'persist',
  ]);
  assert.notEqual(persistedUri, uris.originalUri);
  assert.notEqual(persistedUri, uris.persistenceSourceUri);
});

test('4A-21 nessuna action evita manipolazione e ricompressione', async () => {
  let called = false;
  const result = await prepareImageOnce(
    'file:///cache/already-small.jpg',
    [],
    1200,
    800,
    async () => {
      called = true;
      return { uri: 'file:///cache/should-not-exist.jpg' };
    }
  );

  assert.equal(called, false);
  assert.equal(result.preparedUri, result.inputUri);
  assert.equal(result.transformCount, 0);
});

test('4A-22 resize dopo rotazione usa le dimensioni orientate', () => {
  const planned = planImageActions(
    [{ rotate: 90 }, { resize: { height: 2600 } }],
    4000,
    2000
  );
  assert.deepEqual(planned.output, { width: 1300, height: 2600 });
});

test('4A-23 una trasformazione non può sovrascrivere l’URI originale', async () => {
  await assert.rejects(
    prepareImageOnce(
      'file:///cache/source.jpg',
      [{ resize: { width: 2600 } }],
      4000,
      2000,
      async () => ({
        uri: 'file:///cache/source.jpg',
        width: 2600,
        height: 1300,
      })
    ),
    ImageOutputNotDistinctError
  );
});

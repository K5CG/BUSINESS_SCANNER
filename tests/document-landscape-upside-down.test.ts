import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  applyLandscapeReadingOrderCorrection,
  planCapturedDocumentOrientation,
} from '../lib/document-capture-orientation';
import {
  measureLandscapeInkBandsFromGray,
  mirroredLandscapeInkBands,
  needsLandscapeAspectMismatchProbe,
  needsLandscapeUpsideDownProbe,
  needsPortraitUpsideDownProbe,
  resolvePortraitUpsideDownCorrection,
  resolveLandscapeUpsideDownCorrection,
  scoreLandscapeHeaderAtTop,
} from '../lib/document-orientation-evidence';

const qaRoot = path.join(process.cwd(), 'test-data', 'qa-export-2026-08-08-real-full');

async function grayBandsFromImage(imagePath: string): Promise<ReturnType<typeof measureLandscapeInkBandsFromGray>> {
  const { data, info } = await sharp(imagePath)
    .resize({ width: 800 })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return measureLandscapeInkBandsFromGray(data, info.width, info.height);
}

const androidLandscapeBase = {
  platform: 'android' as const,
  cameraProcessingApplied: true,
  rawCapturePreserved: false,
  exifOrientation: null as number | null,
  deviceOrientationAtCapture: 'landscape-left' as const,
  previewOrientation: 'landscape' as const,
};

test('scoreLandscapeHeaderAtTop penalizza footer in cima', () => {
  assert.ok(scoreLandscapeHeaderAtTop({ topInk: 0.95, bottomInk: 0.37 }) < 0);
  assert.ok(scoreLandscapeHeaderAtTop({ topInk: 0.78, bottomInk: 0.89 }) > 0);
});

test('resolveLandscapeUpsideDownCorrection preferisce 180 solo con evidenza', () => {
  assert.equal(
    resolveLandscapeUpsideDownCorrection({ topInk: 0.95, bottomInk: 0.37 }),
    180,
  );
  assert.equal(
    resolveLandscapeUpsideDownCorrection({ topInk: 0.78, bottomInk: 0.89 }),
    0,
  );
  assert.equal(
    resolveLandscapeUpsideDownCorrection({ topInk: 0.67, bottomInk: 1.0 }),
    0,
  );
});


test('portrait processed Android corregge 180 solo con evidenza forte', () => {
  assert.equal(
    resolvePortraitUpsideDownCorrection({ topInk: 0.95, bottomInk: 0.37 }),
    180,
  );
  assert.equal(
    resolvePortraitUpsideDownCorrection({ topInk: 0.78, bottomInk: 0.89 }),
    0,
  );
  // Header/documento denso ma non abbastanza asimmetrico: fail closed.
  assert.equal(
    resolvePortraitUpsideDownCorrection({ topInk: 0.86, bottomInk: 0.60 }),
    0,
  );
});

test('portrait processed Android entra nel probe 180 senza riaprire quarter-turn', () => {
  const input = {
    platform: 'android' as const,
    cameraProcessingApplied: true,
    rawCapturePreserved: false,
    exifOrientation: null as number | null,
    deviceOrientationAtCapture: 'portrait' as const,
    previewOrientation: 'portrait' as const,
    captureMode: 'portrait' as const,
    width: 3060,
    height: 4080,
  };
  const plan = planCapturedDocumentOrientation(input);
  assert.equal(plan.rotationRequired, 0);
  assert.equal(needsPortraitUpsideDownProbe(input, plan), true);
});

test('mirroredLandscapeInkBands scambia le bande', () => {
  const bands = { topInk: 0.9, bottomInk: 0.3 };
  assert.deepEqual(mirroredLandscapeInkBands(bands), { topInk: 0.3, bottomInk: 0.9 });
});

test('needsLandscapeUpsideDownProbe blocked when deterministic capture key applies', () => {
  const landscapeBitmap = planCapturedDocumentOrientation({
    ...androidLandscapeBase,
    width: 4080,
    height: 3060,
    captureMode: 'landscape-left',
    cameraFacing: 'back',
  });
  assert.equal(landscapeBitmap.rotationRequired, 0);
  assert.equal(needsLandscapeUpsideDownProbe(
    {
      ...androidLandscapeBase,
      width: 4080,
      height: 3060,
      captureMode: 'landscape-left',
      cameraFacing: 'back',
    },
    landscapeBitmap,
  ), false);

  const portraitSensor = planCapturedDocumentOrientation({
    ...androidLandscapeBase,
    width: 3060,
    height: 4080,
    captureMode: 'landscape-left',
    cameraFacing: 'back',
  });
  assert.equal(portraitSensor.rotationRequired, 0);
  assert.equal(needsLandscapeUpsideDownProbe(
    {
      ...androidLandscapeBase,
      width: 3060,
      height: 4080,
      captureMode: 'landscape-left',
      cameraFacing: 'back',
    },
    portraitSensor,
  ), false);
  assert.equal(needsLandscapeAspectMismatchProbe(
    {
      ...androidLandscapeBase,
      width: 3060,
      height: 4080,
      captureMode: 'landscape-left',
      cameraFacing: 'back',
    },
    portraitSensor,
  ), false);
});

test('applyLandscapeReadingOrderCorrection aggiorna metadata rotazione', () => {
  const base = planCapturedDocumentOrientation({
    ...androidLandscapeBase,
    width: 4080,
    height: 3060,
  });
  const corrected = applyLandscapeReadingOrderCorrection(base, 180);
  assert.equal(corrected.rotationRequired, 180);
  assert.equal(corrected.rotationApplied, 180);
  assert.equal(corrected.normalizationReason, 'landscape_reading_order_correction');
  assert.deepEqual([corrected.normalizedWidth, corrected.normalizedHeight], [4080, 3060]);
});

test('QA 2026-08-08 Atelier Bureau: JPEG pre-landscape capovolto richiede 180', async () => {
  const imagePath = path.join(
    qaRoot,
    'original-images',
    '9cb5aef5-e441-46ce-9b1a-06acf77c7b97_1.jpg',
  );
  assert.equal(fs.existsSync(imagePath), true);
  const bands = await grayBandsFromImage(imagePath);
  assert.equal(resolveLandscapeUpsideDownCorrection(bands), 180);
});

test('QA 2026-08-08 Medisupply: JPEG pre-landscape capovolto richiede 180', async () => {
  const imagePath = path.join(
    qaRoot,
    'original-images',
    '2adb6bb0-85ed-4178-8da9-9d04a0743787_1.jpg',
  );
  assert.equal(fs.existsSync(imagePath), true);
  const bands = await grayBandsFromImage(imagePath);
  assert.equal(resolveLandscapeUpsideDownCorrection(bands), 180);
});

test('QA 2026-08-08 Motorparts: JPEG pre-landscape capovolto richiede 180', async () => {
  const imagePath = path.join(
    qaRoot,
    'original-images',
    'a13fa9a4-b89f-48df-9f51-8a3d48d5d318_1.jpg',
  );
  assert.equal(fs.existsSync(imagePath), true);
  const bands = await grayBandsFromImage(imagePath);
  assert.equal(resolveLandscapeUpsideDownCorrection(bands), 180);
});

test('QA 2026-08-08 Global Food: portrait sensor non entra nel probe upside-down', async () => {
  const originalPath = path.join(
    qaRoot,
    'original-images',
    'f7938d5e-5775-4db0-86c2-81abcf0be0c8_1.jpg',
  );
  assert.equal(fs.existsSync(originalPath), true);
  const meta = await sharp(originalPath).metadata();
  assert.deepEqual([meta.width, meta.height], [3060, 4080]);

  const plan = planCapturedDocumentOrientation({
    ...androidLandscapeBase,
    width: meta.width!,
    height: meta.height!,
    captureMode: 'landscape-left',
    cameraFacing: 'back',
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.equal(needsLandscapeUpsideDownProbe(
    {
      ...androidLandscapeBase,
      width: meta.width!,
      height: meta.height!,
      captureMode: 'landscape-left',
      cameraFacing: 'back',
    },
    plan,
  ), false);
});

test('H1 upright 4080x3060 pre-landscape NON richiede 180', async () => {
  const imagePath = path.join(
    process.cwd(),
    'test-data',
    'real-device-documents',
    'xiaomi-h1-landscape-20260804-083510',
    'export',
    'original-images',
    '66d9e451-04c2-4d6c-8126-fcdc744c621b_1.jpg',
  );
  assert.equal(fs.existsSync(imagePath), true);
  const bands = await grayBandsFromImage(imagePath);
  assert.equal(resolveLandscapeUpsideDownCorrection(bands), 0);

  const plan = planCapturedDocumentOrientation({
    ...androidLandscapeBase,
    width: 4080,
    height: 3060,
  });
  assert.equal(applyLandscapeReadingOrderCorrection(plan, 0).rotationRequired, 0);
});

test('portrait 3060x4080 non attiva probe', () => {
  const plan = planCapturedDocumentOrientation({
    platform: 'android',
    cameraProcessingApplied: true,
    rawCapturePreserved: false,
    exifOrientation: 1,
    width: 3060,
    height: 4080,
    deviceOrientationAtCapture: 'portrait',
    previewOrientation: 'portrait',
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(needsLandscapeUpsideDownProbe(
    {
      platform: 'android',
      cameraProcessingApplied: true,
      rawCapturePreserved: false,
      exifOrientation: 1,
      width: 3060,
      height: 4080,
      deviceOrientationAtCapture: 'portrait',
      previewOrientation: 'portrait',
    },
    plan,
  ), false);
});

test('orientation evidence module non importa OCR o parser', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'lib', 'document-orientation-evidence.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:parser|ocr|document-parser)/i);
});

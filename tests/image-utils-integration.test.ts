import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { detectBusinessCardBoundaryFromGray } from '../lib/business-card-boundary';
import {
  buildScanManipulatorActions,
  assessCardCropSafety,
  assessDocumentCropSafety,
  buildScanPlan,
  normalizeFullFrameScan,
  normalizeScannedImage,
  preparePersonPhoto,
  prepareScannedImageFromPlan,
  resolveCaptureBitmap,
  scanPlanOptionsFromDiag,
} from '../lib/image-utils';
import {
  imageManipulatorCalls,
  queueImageManipulatorResult,
  resetImageManipulatorStub,
} from './stubs/expo-image-manipulator-stub';
import {
  resetReactNativeImageStub,
  setStubImageSize,
} from './stubs/react-native-image-stub';

function resetStubs(): void {
  resetImageManipulatorStub();
  resetReactNativeImageStub();
}

test('4A-I01 il percorso reale invia crop, rotazioni e resize in una sola chiamata', async () => {
  resetStubs();
  const plan = buildScanManipulatorActions(
    8000,
    6000,
    'quote',
    'portrait',
    1080,
    2400
  );
  assert.equal(plan.cropApplied, true);
  assert.equal(plan.cropInvalid, false);
  assert.ok(plan.actions.some((action) => 'resize' in action));

  queueImageManipulatorResult({
    uri: 'file:///cache/document-prepared.jpg',
    width: 1640,
    height: 2600,
  });
  const output = await prepareScannedImageFromPlan(
    'file:///cache/document-original.jpg',
    plan
  );

  assert.equal(output, 'file:///cache/document-prepared.jpg');
  assert.equal(imageManipulatorCalls().length, 1);
  assert.equal(imageManipulatorCalls()[0]?.actions.length, plan.actions.length);
  assert.equal(imageManipulatorCalls()[0]?.options.compress, 1);
});

test('4A-I02 il piano production limita anche il biglietto ad alta risoluzione', () => {
  resetStubs();
  const plan = buildScanManipulatorActions(
    12000,
    9000,
    'business_card',
    'landscape',
    1080,
    2400
  );
  const resize = plan.actions.find((action) => 'resize' in action);
  assert.ok(resize && 'resize' in resize);
  assert.ok((resize.resize.width ?? resize.resize.height ?? Infinity) <= 2000);
});

test('4A-I03 stream col rapporto reciproco viene riallineato dopo normalizzazione EXIF', () => {
  const reciprocal = scanPlanOptionsFromDiag(
    { previewStreamSize: '1920x1440', updatedAt: 1 },
    3000,
    4000
  );
  const matching = scanPlanOptionsFromDiag(
    { previewStreamSize: '1920x1440', updatedAt: 1 },
    4000,
    3000
  );
  const sameOrientationDifferentFov = scanPlanOptionsFromDiag(
    { previewStreamSize: '1920x1080', updatedAt: 1 },
    4000,
    3000
  );
  assert.equal(reciprocal.previewStreamSize, '1440x1920');
  assert.equal(matching.previewStreamSize, '1920x1440');
  assert.equal(sameOrientationDifferentFov.previewStreamSize, '1920x1080');
});

test('4A-I03b il crop A4 centrato al 52 percento resta allineato alla cornice', () => {
  const plan = buildScanManipulatorActions(
    1530,
    2040,
    'quote',
    'portrait',
    1220,
    2712,
  );
  const safety = assessDocumentCropSafety(plan);
  assert.equal(safety.useCropForOcr, true);
  assert.equal(safety.cropDecision, 'applied_for_ocr');
  assert.ok((safety.cropAreaRatio ?? 1) > 0.2);
  assert.ok((safety.cropAreaRatio ?? 1) < 0.72);
});

test('4A-I03c crop decentrato in modo anomalo usa la sorgente completa', () => {
  const plan = buildScanManipulatorActions(
    1530,
    2040,
    'quote',
    'portrait',
    1220,
    2712,
  );
  assert.ok(plan.debug.cropRect);
  plan.debug.cropRect = { ...plan.debug.cropRect!, x: 0 };
  const safety = assessDocumentCropSafety(plan);
  assert.equal(safety.useCropForOcr, false);
  assert.equal(safety.cropDecision, 'rejected_anomalous_geometry');
});

test('4A-I03d matrice ruotata mantiene crop centrato per landscape e portrait-down', () => {
  const cases = [
    { width: 1530, height: 2040, orientation: 'portrait' as const, sw: 1220, sh: 2712, stream: '1920x1440' },
    { width: 2040, height: 1530, orientation: 'landscape' as const, sw: 2712, sh: 1220, stream: '1440x1920' },
    { width: 2040, height: 1530, orientation: 'landscape' as const, sw: 2712, sh: 1220, stream: '1920x1440' },
  ];
  for (const item of cases) {
    const options = scanPlanOptionsFromDiag(
      { previewStreamSize: item.stream, updatedAt: 1 },
      item.width,
      item.height,
    );
    const plan = buildScanManipulatorActions(
      item.width,
      item.height,
      'quote',
      item.orientation,
      item.sw,
      item.sh,
      undefined,
      options,
    );
    const safety = assessDocumentCropSafety(plan);
    assert.equal(plan.cropInvalid, false);
    assert.equal(safety.useCropForOcr, true);
    assert.equal(safety.cropDecision, 'applied_for_ocr');
  }
});

test('4A-I04 bitmap già normalizzato non viene ricodificato', async () => {
  resetStubs();
  setStubImageSize('file:///cache/capture.jpg', 3000, 4000);
  const bitmap = await resolveCaptureBitmap('file:///cache/capture.jpg', {
    width: 3000,
    height: 4000,
  });
  assert.deepEqual(bitmap, {
    uri: 'file:///cache/capture.jpg',
    width: 3000,
    height: 4000,
    exifNormalized: false,
  });
  assert.equal(imageManipulatorCalls().length, 0);
});

test('4A-I05 incoerenza dimensionale normalizza EXIF una sola volta prima del piano', async () => {
  resetStubs();
  setStubImageSize('file:///cache/raw-exif.jpg', 1500, 2000);
  queueImageManipulatorResult({
    uri: 'file:///cache/exif-normalized.jpg',
    width: 3000,
    height: 4000,
  });
  const bitmap = await resolveCaptureBitmap('file:///cache/raw-exif.jpg', {
    width: 3000,
    height: 4000,
  });
  assert.deepEqual(bitmap, {
    uri: 'file:///cache/exif-normalized.jpg',
    width: 3000,
    height: 4000,
    exifNormalized: true,
  });
  assert.equal(imageManipulatorCalls().length, 1);
  assert.deepEqual(imageManipulatorCalls()[0]?.actions, []);
});

test('4A-I05b documenti misurano i pixel del decoder anche quando Android concorda sulla meta dimezzata', async () => {
  resetStubs();
  setStubImageSize('file:///cache/xiaomi-a4.jpg', 1530, 2040);
  queueImageManipulatorResult({
    uri: 'file:///cache/xiaomi-a4-materialized.jpg',
    width: 3060,
    height: 4080,
  });
  const bitmap = await resolveCaptureBitmap(
    'file:///cache/xiaomi-a4.jpg',
    { width: 1530, height: 2040 },
    { forceManipulatorMeasurement: true },
  );
  assert.deepEqual(bitmap, {
    uri: 'file:///cache/xiaomi-a4-materialized.jpg',
    width: 3060,
    height: 4080,
    exifNormalized: true,
  });
  assert.equal(imageManipulatorCalls().length, 1);
  assert.deepEqual(imageManipulatorCalls()[0]?.actions, []);
});

test('4A-I05c biglietti misurano i pixel del decoder come i documenti', async () => {
  // Metadati dimezzati dal dispositivo: 1530x2040 contro 3060x4080 reali.
  // Il ritaglio deve nascere nelle coordinate del bitmap che verrà davvero
  // ritagliato, altrimenti finisce nel quarto in alto a sinistra della scena.
  resetStubs();
  setStubImageSize('file:///cache/card.jpg', 1530, 2040);
  queueImageManipulatorResult({
    uri: 'file:///cache/card-materialized.jpg',
    width: 3060,
    height: 4080,
  });
  const plan = await buildScanPlan(
    'file:///cache/card.jpg',
    1530,
    2040,
    'business_card',
    'landscape',
    375.385,
    548,
    CARD_INSETS,
  );
  assert.equal(plan.sourceUri, 'file:///cache/card-materialized.jpg');
  assert.equal(plan.cropInvalid, false);
  assert.equal(plan.debug.normalizedWidth, 3060);
  assert.equal(plan.debug.normalizedHeight, 4080);

  const crop = plan.debug.cropRect!;
  // La misura del decoder è già dimostrata da normalizedWidth/Height e sourceUri.
  // Qui verifichiamo proprietà geometriche invarianti, senza legare il test a
  // coordinate storiche della cornice che possono cambiare con la policy zoom.
  assert.ok(
    crop.x >= 0 && crop.y >= 0 &&
      crop.x + crop.width <= plan.debug.normalizedWidth &&
      crop.y + crop.height <= plan.debug.normalizedHeight,
    `ritaglio fuori dal bitmap misurato: ${crop.x}/${crop.y} ${crop.width}x${crop.height}`
  );
  assert.ok(
    crop.width > 1530 && crop.height > 1000,
    `ritaglio ancora compatibile con coordinate dimezzate: ${crop.width}x${crop.height}`
  );
  assert.ok(
    Math.abs(crop.x + crop.width / 2 - plan.debug.normalizedWidth / 2) <= 1,
    'il ritaglio deve restare centrato in orizzontale'
  );
});

test('4A-I06 immagine piccola non viene manipolata da normalizeScannedImage', async () => {
  resetStubs();
  setStubImageSize('file:///cache/small-landscape.jpg', 1200, 800);
  const output = await normalizeScannedImage(
    'file:///cache/small-landscape.jpg',
    'landscape'
  );
  assert.equal(output, 'file:///cache/small-landscape.jpg');
  assert.equal(imageManipulatorCalls().length, 0);
});

test('4A-I07 foto persona piccola non viene ingrandita', async () => {
  resetStubs();
  const output = await preparePersonPhoto(
    'file:///cache/person-small.jpg',
    900,
    1400,
    1080,
    2400
  );
  assert.equal(output, 'file:///cache/person-small.jpg');
  assert.equal(imageManipulatorCalls().length, 0);
});

test('4A-I08 documenti usano il JPEG orientato fisicamente dalla camera nativa', () => {
  const cardScanner = readFileSync(
    resolve('components/Camera/CardScanner.tsx'),
    'utf8'
  );
  const multiScanner = readFileSync(
    resolve('components/Camera/MultiPageScanner.tsx'),
    'utf8'
  );
  assert.match(cardScanner, /skipProcessing:\s*false/);
  assert.match(cardScanner, /imagePipelineUris\(/);
  assert.match(multiScanner, /exif:\s*true/);
  assert.match(multiScanner, /skipProcessing:\s*false/);
  assert.doesNotMatch(multiScanner, /resolveCaptureBitmap\(/);
  assert.match(multiScanner, /normalizeCapturedDocumentOrientation\(/);
  assert.match(multiScanner, /const canonicalUri = oriented\.normalizedUri/);
  assert.match(multiScanner, /imagePipelineUris\(/);
});

const CARD_INSETS = { top: 20, bottom: 100, horizontal: 16 };

test('4A-I10 buffer biglietto sugli assi del sensore riceve la sola rotazione fisica', () => {
  const plan = buildScanManipulatorActions(
    2040,
    1530,
    'business_card',
    'landscape',
    375.385,
    548,
    CARD_INSETS
  );
  // Schermo verticale e bitmap orizzontale: Android ha consegnato il buffer
  // non ruotato, quindi va riportato sugli assi di visualizzazione.
  assert.equal(plan.alignRotation, 90);
  assert.equal(plan.debug.normalizedWidth, 1530);
  assert.equal(plan.debug.normalizedHeight, 2040);
  // Nessuna rotazione di lettura derivata dall'etichetta del biglietto.
  assert.equal(plan.readingRotation, 0);
});

test('4A-I11 la cornice del biglietto viene sempre ritagliata, anche senza stream', () => {
  // Geometria reale del dispositivo di QA: la cornice cyan deve diventare
  // l'immagine finale senza dipendere da dimensioni native non pubblicate.
  const plan = buildScanManipulatorActions(
    2040,
    1530,
    'business_card',
    'landscape',
    375.385,
    548,
    CARD_INSETS
  );
  const safety = assessCardCropSafety(plan);
  assert.equal(safety.useCropForOcr, true);
  assert.equal(safety.cropDecision, 'applied_verified');
  assert.equal(plan.debug.cardMapping?.fovSource, 'sensor_default');
  assert.equal(plan.cropApplied, true);

  const crop = plan.debug.cropRect!;
  const overlay = plan.debug.overlayRect;
  const overlayAspect = overlay.width / overlay.height;
  const cropAspect = crop.width / crop.height;
  assert.ok(
    Math.abs(cropAspect - overlayAspect) / overlayAspect < 0.03,
    `forma del ritaglio incoerente con la cornice: ${cropAspect}`
  );
  // Il ritaglio è una porzione della foto, non il fotogramma intero.
  const area = (crop.width * crop.height) /
    (plan.debug.normalizedWidth * plan.debug.normalizedHeight);
  assert.ok(area < 0.35, `ritaglio troppo esteso: ${area}`);
});

test('4A-I12 con lo stream reale il biglietto ritaglia sulla cornice verificata', () => {
  const plan = buildScanManipulatorActions(
    2040,
    1530,
    'business_card',
    'landscape',
    375.385,
    548,
    CARD_INSETS,
    { previewStreamSize: '1600x1200' }
  );
  const safety = assessCardCropSafety(plan);
  assert.equal(safety.cropDecision, 'applied_verified');
  assert.equal(safety.useCropForOcr, true);
  const crop = plan.debug.cropRect!;
  // Il ritaglio resta dentro il bitmap normalizzato e centrato in orizzontale.
  assert.ok(crop.x >= 0 && crop.x + crop.width <= plan.debug.normalizedWidth);
  assert.ok(crop.y >= 0 && crop.y + crop.height <= plan.debug.normalizedHeight);
  assert.ok(
    Math.abs(crop.x + crop.width / 2 - plan.debug.normalizedWidth / 2) <= 0.5,
    'il ritaglio deve restare centrato in orizzontale entro l’arrotondamento pixel'
  );
});

test('4A-I13 il ripiego a fotogramma intero applica la rotazione fisica una sola volta', async () => {
  resetStubs();
  setStubImageSize('file:///cache/card-sensor-axes.jpg', 2040, 1530);
  queueImageManipulatorResult({
    uri: 'file:///cache/card-upright.jpg',
    width: 1500,
    height: 2000,
  });
  const output = await normalizeFullFrameScan(
    'file:///cache/card-sensor-axes.jpg',
    90
  );
  assert.equal(output, 'file:///cache/card-upright.jpg');
  const calls = imageManipulatorCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.actions[0], { rotate: 90 });
  // Una sola rotazione: nessuna forzatura semantica aggiuntiva.
  assert.equal(
    calls[0]?.actions.filter((action) => 'rotate' in action).length,
    1
  );
});

test('4A-I14 senza rotazione fisica il fotogramma intero conserva gli assi dello scatto', async () => {
  resetStubs();
  setStubImageSize('file:///cache/card-upright-small.jpg', 1200, 800);
  const output = await normalizeFullFrameScan(
    'file:///cache/card-upright-small.jpg',
    0
  );
  assert.equal(output, 'file:///cache/card-upright-small.jpg');
  assert.equal(imageManipulatorCalls().length, 0);
});

test('4A-I15 i documenti restano indipendenti dalle dimensioni di stream ritrovate', async () => {
  resetStubs();
  setStubImageSize('file:///cache/doc.jpg', 3060, 4080);
  queueImageManipulatorResult({
    uri: 'file:///cache/doc-normalized.jpg',
    width: 3060,
    height: 4080,
  });
  const withStream = await buildScanPlan(
    'file:///cache/doc.jpg',
    3060,
    4080,
    'quote',
    'portrait',
    1080,
    2400,
    undefined,
    { previewStreamSize: '1600x1200', updatedAt: 1 }
  );

  resetStubs();
  setStubImageSize('file:///cache/doc.jpg', 3060, 4080);
  queueImageManipulatorResult({
    uri: 'file:///cache/doc-normalized.jpg',
    width: 3060,
    height: 4080,
  });
  const withoutStream = await buildScanPlan(
    'file:///cache/doc.jpg',
    3060,
    4080,
    'quote',
    'portrait',
    1080,
    2400,
  );

  assert.deepEqual(withStream.debug.cropRect, withoutStream.debug.cropRect);
});

test('4A-I09 thumbnail orientamento e sharpness usano la policy del lato lungo', () => {
  const orientationFix = readFileSync(
    resolve('lib/card-orientation-fix.ts'),
    'utf8'
  );
  const sharpness = readFileSync(resolve('lib/image-sharpness.ts'), 'utf8');

  assert.match(
    orientationFix,
    /planLongSideResize\(size\.width,\s*size\.height,\s*480\)/
  );
  assert.doesNotMatch(orientationFix, /resize:\s*\{\s*width:\s*480/);
  assert.match(
    sharpness,
    /planLongSideResize\(\s*prePlan\.output\.width,\s*prePlan\.output\.height,\s*SHARPNESS_SAMPLE_WIDTH/
  );
  assert.doesNotMatch(
    sharpness,
    /resize:\s*\{\s*width:\s*SHARPNESS_SAMPLE_WIDTH/
  );
});


test('4A-P0-BC-01 boundary fisico: rettangolo grande con quattro bordi viene accettato', () => {
  const width = 240;
  const height = 150;
  const gray = new Uint8Array(width * height).fill(45);
  const left = 22;
  const right = 218;
  const top = 16;
  const bottom = 134;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      gray[y * width + x] = 225;
    }
  }
  const detection = detectBusinessCardBoundaryFromGray(gray, width, height);
  assert.ok(detection, 'il cartoncino rettangolare deve essere rilevato');
  assert.ok(detection.rect.x >= left && detection.rect.x <= left + 4);
  assert.ok(detection.rect.y >= top && detection.rect.y <= top + 4);
  assert.ok(detection.rect.x + detection.rect.width <= right + 1);
  assert.ok(detection.rect.y + detection.rect.height <= bottom + 1);
  assert.ok(detection.areaRatio > 0.5 && detection.areaRatio < 0.94);
});

test('4A-P0-BC-01 boundary fisico: scena senza quattro bordi forti fallisce chiuso', () => {
  const width = 240;
  const height = 150;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      gray[y * width + x] = (x * 3 + y * 5) % 48 + 90;
    }
  }
  assert.equal(detectBusinessCardBoundaryFromGray(gray, width, height), null);
});

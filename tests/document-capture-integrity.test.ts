import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import jpeg from 'jpeg-js';
import {
  assessDocumentCropSafety,
  buildScanManipulatorActions,
  scanPlanOptionsFromDiag,
} from '../lib/image-utils';
import { detectBusinessCardForegroundBoundsFromRgba } from '../lib/business-card-boundary';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const fixtureRoot = path.join(
  root,
  'test-data',
  'real-device-documents',
  'xiaomi-a4-destructive-crop-20260803',
);
const topLeftFixtureRoot = path.join(
  root,
  'test-data',
  'real-device-documents',
  'xiaomi-a4-top-left-crop-20260803',
  'imported',
);
const twoPageFixtureRoot = path.join(
  root,
  'test-data',
  'real-device-documents',
  'xiaomi-two-page-full-frame-20260803',
  'imported',
);

test('fixture reale riproduce la perdita tra sorgente normalizzata e JPEG persistito', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'capture-metadata.json'), 'utf8'));
  const jpegBytes = fs.readFileSync(path.join(fixtureRoot, 'images', 'page-01.jpg'));
  const decoded = jpeg.decode(jpegBytes, { useTArray: true, formatAsRGBA: false });

  assert.deepEqual([decoded.width, decoded.height], [1076, 1522]);
  assert.deepEqual(
    [metadata.pageCaptureMetadata.width, metadata.pageCaptureMetadata.height],
    [1530, 2040],
  );
  assert.ok(decoded.width * decoded.height < metadata.pageCaptureMetadata.width * metadata.pageCaptureMetadata.height * 0.6);
  assert.equal(metadata.pageCaptureMetadata.rotationApplied, 90);
});

test('fixture reale alto-sinistra prova il mismatch esatto 2x tra metadata e JPEG', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(topLeftFixtureRoot, 'manifest.json'), 'utf8'));
  const metadata = manifest.documents[0].pageCaptureMetadata[0];
  const original = jpeg.decode(
    fs.readFileSync(path.join(topLeftFixtureRoot, 'original-images', 'f8c95a12-059f-4bec-8054-bcc4289f5f7a_1.jpg')),
    { useTArray: true, formatAsRGBA: false },
  );
  const persisted = jpeg.decode(
    fs.readFileSync(path.join(topLeftFixtureRoot, 'images', 'f8c95a12-059f-4bec-8054-bcc4289f5f7a_1.jpg')),
    { useTArray: true, formatAsRGBA: false },
  );

  assert.deepEqual([metadata.width, metadata.height], [1530, 2040]);
  assert.deepEqual([original.width, original.height], [3060, 4080]);
  assert.deepEqual([persisted.width, persisted.height], [1076, 1522]);
  assert.equal(original.width / metadata.width, 2);
  assert.equal(original.height / metadata.height, 2);

  const viewportInsets = { top: 64, bottom: 20, horizontal: 16 };
  const reportedPlan = buildScanManipulatorActions(
    metadata.width,
    metadata.height,
    'quote',
    'portrait',
    metadata.previewWidth,
    metadata.previewHeight,
    viewportInsets,
  );
  const bitmapPlan = buildScanManipulatorActions(
    original.width,
    original.height,
    'quote',
    'portrait',
    metadata.previewWidth,
    metadata.previewHeight,
    viewportInsets,
  );
  assert.deepEqual(reportedPlan.debug.cropRect, metadata.cropRect);
  assert.equal(bitmapPlan.debug.cropRect?.x, metadata.cropRect.x * 2);
  assert.equal(bitmapPlan.debug.cropRect?.y, metadata.cropRect.y * 2);
  assert.ok(Math.abs((bitmapPlan.debug.cropRect?.width ?? 0) - metadata.cropRect.width * 2) <= 1);
  assert.ok(Math.abs((bitmapPlan.debug.cropRect?.height ?? 0) - metadata.cropRect.height * 2) <= 1);
});

test('fixture multipagina prova che il crop è corretto ma il full-frame era mostrato', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(twoPageFixtureRoot, 'manifest.json'), 'utf8'));
  const document = manifest.documents.find(
    (item: { id: string }) => item.id === '25b29f6c-b715-48ea-91c6-83a6ead22db4',
  );
  const metadata = document.pageCaptureMetadata[0];
  const persisted = jpeg.decode(
    fs.readFileSync(
      path.join(twoPageFixtureRoot, 'images', '25b29f6c-b715-48ea-91c6-83a6ead22db4_front_1.jpg'),
    ),
    { useTArray: true, formatAsRGBA: false },
  );

  assert.deepEqual([persisted.width, persisted.height], [3060, 4080]);
  assert.deepEqual([metadata.bitmapWidth, metadata.bitmapHeight], [3060, 4080]);
  assert.deepEqual(metadata.cropRect, { x: 454, y: 664, width: 2153, height: 3045 });
  assert.equal(metadata.cropDecision, 'applied_for_ocr');
  assert.equal(document.originalImageFiles.length, 0);
  assert.ok(metadata.cropAreaRatio > 0.48 && metadata.cropAreaRatio < 0.56);
});

test('fixture KÜNZI 2026-08-05 esclude lo sfondo sopra il foglio solo dalla copia OCR', () => {
  const fixture = path.join(
    root,
    'test-data',
    'real-device-documents',
    'runtime-kunzi-20260805-061314',
    'export',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'manifest.json'), 'utf8'));
  const metadata = manifest.documents[0].pageCaptureMetadata[0];
  const plan = buildScanManipulatorActions(
    metadata.canonicalWidth,
    metadata.canonicalHeight,
    'order',
    'landscape',
    metadata.previewContentRect.width,
    metadata.previewContentRect.height,
  );
  const safety = assessDocumentCropSafety(plan);

  assert.equal(metadata.captureOrientation, 'landscape-left');
  assert.equal(safety.useCropForOcr, true);
  assert.equal(safety.cropDecision, 'applied_for_ocr');
  assert.ok((plan.debug.cropRect?.y ?? 0) > 150);
  assert.ok((plan.debug.cropRect?.width ?? 0) < metadata.canonicalWidth);
  assert.ok((plan.debug.cropRect?.height ?? 0) < metadata.canonicalHeight);
});

test('documenti: anteprima WYSIWYG (crop o full-frame), originale e canonical in metadata', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const workflow = read('lib/scan-process-workflow.ts');
  assert.match(scanner, /ocrUri:/);
  assert.match(scanner, /originalUri:/);
  assert.match(scanner, /uri: persistedUri/);
  assert.match(scanner, /originalImageUris:\s*documentPages\.map/);
  assert.match(scanner, /const canonicalUri = oriented\.normalizedUri/);
  assert.match(scanner, /assessDocumentCropSafety\(ocrPlan\)/);
  assert.match(scanner, /prepareScannedImageFromPlan\([\s\S]*ocrPlan/);
  assert.match(scanner, /uri: persistedUri,[\s\S]*ocrUri,/);
  assert.doesNotMatch(scanner, /stripJpegExifOrientation/);
  assert.doesNotMatch(scanner, /prepareFullDocumentImage/);
  assert.match(scanner, /setPendingDocumentPhoto/);
  assert.match(workflow, /ocrImageUris/);
  assert.match(workflow, /originalImages/);
  assert.match(workflow, /scanPagesLocally\(\s*ocrImageUris/);
});

test('documenti non applicano rotazioni o listener instabili dopo lo scatto', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const orientation = read('lib/document-capture-orientation.ts');
  assert.doesNotMatch(scanner, /addOrientationChangeListener|DeviceMotion|Accelerometer/);
  const documentBlock = scanner.slice(
    scanner.indexOf("if (documentType !== 'business_card')"),
    scanner.indexOf("if (documentType === 'business_card' && businessMode === 'person')"),
  );
  assert.match(documentBlock, /normalizeCapturedDocumentOrientation/);
  assert.match(documentBlock, /const canonicalUri = oriented\.normalizedUri/);
  assert.doesNotMatch(documentBlock, /rotateImage|stripJpegExif|manipulateAsync/);
  assert.match(orientation, /'portrait-down'/);
});

test('stream preview reciproco viene riallineato agli assi del JPEG', () => {
  const options = scanPlanOptionsFromDiag(
    { previewStreamSize: '1920x1440', updatedAt: 1 },
    1530,
    2040,
  );
  assert.equal(options.previewStreamSize, '1440x1920');
});

test('metadati QA espongono sorgente, preview, crop e decisione di sicurezza', () => {
  const orientation = read('lib/document-capture-orientation.ts');
  const qaExport = read('lib/export-qa-documents.ts');
  for (const field of [
    'sourceWidth',
    'sourceHeight',
    'previewWidth',
    'previewHeight',
    'mappedPreviewStreamSize',
    'cropRect',
    'cropAreaRatio',
    'cropDecision',
    'ocrWidth',
    'ocrHeight',
    'persistedWidth',
    'persistedHeight',
    'originalPersistedWidth',
    'originalPersistedHeight',
    'bitmapWidth',
    'bitmapHeight',
    'overlayRect',
    'previewContentRect',
    'originalExif',
    'rotationRequested',
    'previewScaleMode',
  ]) {
    assert.match(orientation, new RegExp(`\\b${field}\\b`));
  }
  assert.match(qaExport, /pageCaptureMetadata:\s*doc\.pageCaptureMetadata/);
  assert.match(qaExport, /original-images/);
});


function makeSyntheticCardRgba(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const offset = (y * width + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

test('biglietti: supporto molto largo con grandi margini sopra e sotto resta ritagliabile', () => {
  const width = 300;
  const height = 190;
  const rgba = makeSyntheticCardRgba(width, height, (x, y) => {
    const texture = ((x * 17 + y * 13) % 19) - 9;
    const background = 92 + texture;
    const inside = x >= 24 && x < 276 && y >= 55 && y < 135;
    if (!inside) return [background, background + 3, background + 8];
    return y >= 112 ? [176, 42, 36] : [238, 228, 205];
  });

  const result = detectBusinessCardForegroundBoundsFromRgba(rgba, width, height);
  assert.ok(result, 'un biglietto ribassato non deve dipendere dal rapporto ISO standard');
  assert.ok(result.rect.width > 230);
  assert.ok(result.rect.height > 70);
  assert.ok(result.rect.y > 20);
});

test('biglietti: forma sagomata usa il foreground dominante senza richiedere quattro bordi', () => {
  const width = 220;
  const height = 320;
  const rgba = makeSyntheticCardRgba(width, height, (x, y) => {
    const texture = ((x * 11 + y * 7) % 23) - 11;
    const background = 96 + texture;
    const palm = x >= 58 && x < 158 && y >= 108 && y < 286;
    const thumb = x >= 150 && x < 194 && y >= 142 && y < 236;
    const finger1 = x >= 54 && x < 78 && y >= 38 && y < 130;
    const finger2 = x >= 80 && x < 104 && y >= 28 && y < 130;
    const finger3 = x >= 106 && x < 130 && y >= 24 && y < 130;
    const finger4 = x >= 132 && x < 156 && y >= 34 && y < 130;
    if (palm || thumb || finger1 || finger2 || finger3 || finger4) {
      return [224, 166, 48];
    }
    return [background, background + 2, background + 7];
  });

  const result = detectBusinessCardForegroundBoundsFromRgba(rgba, width, height);
  assert.ok(result, 'una forma non rettangolare non deve essere scartata');
  assert.ok(result.rect.width > 125);
  assert.ok(result.rect.height > 240);
});

test('biglietti: sfondo senza oggetto non inventa un crop foreground', () => {
  const width = 220;
  const height = 140;
  const rgba = makeSyntheticCardRgba(width, height, (x, y) => {
    const texture = ((x * 5 + y * 3) % 13) - 6;
    const base = 118 + texture;
    return [base, base + 1, base + 3];
  });
  assert.equal(detectBusinessCardForegroundBoundsFromRgba(rgba, width, height), null);
});

test('biglietti: oggetto che invade quasi tutto il bordo non attiva un crop foreground rischioso', () => {
  const width = 220;
  const height = 140;
  const rgba = makeSyntheticCardRgba(width, height, (x, y) => {
    const inside = x < 205 && y < 125;
    return inside ? [235, 225, 205] : [90, 94, 100];
  });
  assert.equal(detectBusinessCardForegroundBoundsFromRgba(rgba, width, height), null);
});

test('biglietti: un piccolo logo centrale non viene scambiato per il supporto intero', () => {
  const width = 220;
  const height = 140;
  const rgba = makeSyntheticCardRgba(width, height, (x, y) => {
    const logo = x >= 80 && x < 140 && y >= 50 && y < 90;
    return logo ? [230, 180, 40] : [110, 113, 118];
  });
  assert.equal(detectBusinessCardForegroundBoundsFromRgba(rgba, width, height), null);
});


test('biglietti: forma irregolare vicina a un solo bordo resta ammessa con componente dominante forte', () => {
  const width = 180;
  const height = 260;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const foreground = x >= 38 && x <= 145 && y <= 224 && (y < 70 || x >= 55);
    const v = foreground ? [214, 164, 62] : [48, 50, 52];
    rgba[i] = v[0]; rgba[i + 1] = v[1]; rgba[i + 2] = v[2]; rgba[i + 3] = 255;
  }
  const result = detectBusinessCardForegroundBoundsFromRgba(rgba, width, height);
  assert.ok(result);
  assert.ok((result?.density ?? 0) >= 0.65);
});

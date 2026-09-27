import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  pageCaptureMetadata,
  planCapturedDocumentOrientation,
  previewOrientationForDevice,
  readCapturedExifOrientation,
  readRawCapturedExifValue,
  rotationFromExifOrientation,
  staleProcessedExifRequiresRewrite,
  type DocumentOrientationNormalizationInput,
} from '../lib/document-capture-orientation';
import {
  getOverlayFrameRect,
  getScannerViewportInsets,
} from '../lib/overlay-geometry';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const base: DocumentOrientationNormalizationInput = {
  width: 3000,
  height: 4000,
  exifOrientation: 1,
  deviceOrientationAtCapture: 'portrait',
  previewOrientation: 'portrait',
  platform: 'android',
  cameraProcessingApplied: true,
};

test('documento portrait con telefono portrait resta portrait', () => {
  const plan = planCapturedDocumentOrientation(base);
  assert.equal(plan.rotationApplied, 0);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [3000, 4000]);
});

test('documento landscape-left con bitmap portrait ruota a sinistra', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    cameraProcessingApplied: false,
    deviceOrientationAtCapture: 'landscape-left',
    previewOrientation: 'landscape',
  });
  assert.equal(plan.rotationApplied, 90);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [4000, 3000]);
});

test('documento landscape-right con bitmap portrait ruota nel verso opposto', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    cameraProcessingApplied: false,
    deviceOrientationAtCapture: 'landscape-right',
    previewOrientation: 'landscape',
  });
  assert.equal(plan.rotationApplied, 270);
});

test('rotazione portrait a landscape aggiorna orientamento preview', () => {
  assert.equal(previewOrientationForDevice('portrait'), 'portrait');
  assert.equal(previewOrientationForDevice('landscape-left'), 'landscape');
});

test('portrait-down resta verticale ma distinto da portrait-up', () => {
  assert.equal(previewOrientationForDevice('portrait-down'), 'portrait');
  const plan = planCapturedDocumentOrientation({
    ...base,
    cameraProcessingApplied: false,
    width: 4000,
    height: 3000,
    deviceOrientationAtCapture: 'portrait-down',
  });
  assert.equal(plan.orientation, 'portrait-down');
  assert.equal(plan.rotationApplied, 270);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [3000, 4000]);
});

test('portrait upright processato non riceve rotazione', () => {
  const plan = planCapturedDocumentOrientation(base);
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [3000, 4000]);
});

test('bitmap processato non inventa un quarter-turn da UI portrait', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    width: 4080,
    height: 3060,
    deviceOrientationAtCapture: 'portrait',
    previewOrientation: 'portrait',
    cameraProcessingApplied: true,
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [4080, 3060]);
  assert.equal(plan.normalizationReason, 'camera_processing_applied');
});

test('fixture KÜNZI reale: portrait JPEG landscape-right processato resta 0', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    width: 3060,
    height: 4080,
    exifOrientation: 1,
    deviceOrientationAtCapture: 'landscape-right',
    previewOrientation: 'landscape',
    platform: 'android',
    cameraProcessingApplied: true,
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [3060, 4080]);
  assert.equal(plan.normalizationReason, 'camera_processing_applied');
});

test('QA 2026-08-06 landscape-left Android: portrait JPEG processato non va ruotato', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    width: 3060,
    height: 4080,
    exifOrientation: null,
    deviceOrientationAtCapture: 'landscape-left',
    previewOrientation: 'landscape',
    platform: 'android',
    cameraProcessingApplied: true,
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [3060, 4080]);
});

test('scanner conserva il JPEG camera come canonico e separa la derivata OCR', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const rawAt = scanner.indexOf('const canonicalUri = oriented.normalizedUri');
  const confirmAt = scanner.indexOf('withConfirmedDocumentImage(', rawAt);
  assert.ok(rawAt > 0 && confirmAt > rawAt);
  assert.match(scanner, /exif: true/);
  assert.match(scanner, /skipProcessing: false/);
  assert.match(scanner, /normalizeCapturedDocumentOrientation\(/);
  assert.doesNotMatch(scanner, /resolveCaptureBitmap|prepareFullDocumentImage|stripJpegExifOrientation/);
  assert.match(scanner, /canonicalWidth,/);
  assert.match(scanner, /uri: persistedUri,[\s\S]*ocrUri,/);
  assert.match(scanner, /assessDocumentCropSafety\(ocrPlan\)/);
  assert.match(scanner, /const preReadingUri = croppedUri \?\? canonicalUri/);
  assert.match(scanner, /const persistedUri = readingOriented\.normalizedUri/);
  assert.match(scanner, /const ocrUri = persistedUri/);
  assert.match(scanner, /if \(cropSafety\.useCropForOcr\)/);
  const orientationCore = read('lib/document-capture-orientation.ts');
  assert.match(orientationCore, /cropDecision: 'bypassed_full_frame'/);
});

test('portrait-down gia processato in verticale non riceve una doppia rotazione', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    deviceOrientationAtCapture: 'portrait-down',
  });
  assert.equal(plan.rotationApplied, 0);
  assert.equal(plan.orientation, 'portrait-down');
});

test('rotazione landscape a portrait aggiorna orientamento preview', () => {
  assert.equal(previewOrientationForDevice('landscape-right'), 'landscape');
  assert.equal(previewOrientationForDevice('portrait'), 'portrait');
});

test('frame landscape conserva la scala del frame portrait ruotato', () => {
  const portraitInsets = getScannerViewportInsets('quote', 'portrait', false);
  const landscapeInsets = getScannerViewportInsets('quote', 'landscape', false);
  const portrait = getOverlayFrameRect(407, 800, 'quote', 'portrait', portraitInsets);
  const landscape = getOverlayFrameRect(800, 407, 'quote', 'landscape', landscapeInsets);

  assert.ok(landscape.width >= portrait.height * 0.95);
  assert.ok(landscape.height >= portrait.width * 0.95);
});

test('safe area laterale non riduce di nuovo la preview tra le rail', () => {
  const safeRight = 47;
  const insets = getScannerViewportInsets(
    'quote',
    'landscape',
    false,
    { left: 0, right: safeRight }
  );
  assert.equal(insets.top, 8);
  assert.equal(insets.bottom, 8);
  assert.equal(insets.left, 0);
  assert.equal(insets.right, 0);
  const stageW = 520;
  const stageH = 360;
  const frame = getOverlayFrameRect(stageW, stageH, 'quote', 'landscape', insets);
  assert.ok(frame.width >= stageW * 0.85);
  assert.ok(frame.height >= stageH * 0.72);
});

test('landscape usa una barra laterale compatta senza riservare altezza', () => {
  assert.deepEqual(
    getScannerViewportInsets('quote', 'landscape', true),
    getScannerViewportInsets('quote', 'landscape', false)
  );
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const route = read('app/scan/[type].tsx');
  assert.doesNotMatch(scanner, /t\('a4ScanHint'\)/);
  assert.match(scanner, /horizontal=\{!isDocumentLandscape\}/);
  assert.match(scanner, /width: 96 \+ Math\.max\(insets\.right, 0\)/);
  assert.doesNotMatch(
    scanner.slice(
      scanner.indexOf('controlsDockLandscape:'),
      scanner.indexOf('landscapeActionButton:'),
    ),
    /position: 'absolute'/,
  );
  assert.match(scanner, /right: Math\.max\(insets\.right, 8\) \+ 8/);
  assert.match(
    route,
    /headerShown:[\s\S]*captureMode !== 'landscape-left'[\s\S]*!deviceLandscape/,
  );
  assert.doesNotMatch(scanner, /awaitingLandscapeRotation/);
  assert.match(scanner, /getOverlayFrameRectInView\(/);
  assert.match(scanner, /containerLandscape:[\s\S]*flexDirection: 'row'[\s\S]*backgroundColor: colors\.surface/);
  assert.match(scanner, /landscapeHeaderRail:[\s\S]*width: 80/);
  assert.match(scanner, /landscapeHeaderBack:[\s\S]*width: 44[\s\S]*height: 44/);
  assert.match(scanner, /landscapeModeGroup:[\s\S]*landscapeModeButton/);
  assert.match(scanner, /landscapeModeButton:[\s\S]*width: 52[\s\S]*height: 52/);
  assert.doesNotMatch(scanner, /landscapeModeTextRotated|transform:\s*\[\{\s*rotate:/);
  const railStyle = scanner.slice(
    scanner.indexOf('landscapeHeaderRail:'),
    scanner.indexOf('landscapeHeaderBack:'),
  );
  assert.doesNotMatch(railStyle, /height:/);
});

test('EXIF 1 non ruota', () => assert.equal(rotationFromExifOrientation(1), 0));
test('EXIF 3 ruota 180 gradi', () => assert.equal(rotationFromExifOrientation(3), 180));
test('EXIF 6 ruota 90 gradi', () => assert.equal(rotationFromExifOrientation(6), 90));
test('EXIF 8 ruota 270 gradi', () => assert.equal(rotationFromExifOrientation(8), 270));

test('bitmap non processato applica EXIF 6 una volta', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    cameraProcessingApplied: false,
    exifOrientation: 6,
    deviceOrientationAtCapture: 'landscape-left',
    previewOrientation: 'landscape',
  });
  assert.equal(plan.rotationApplied, 90);
  assert.equal(plan.rotationRequired, 90);
  assert.equal(plan.normalizationReason, 'exif_orientation_applied');
});

test('bitmap non processato applica EXIF 8 una volta', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    cameraProcessingApplied: false,
    exifOrientation: 8,
    deviceOrientationAtCapture: 'landscape-right',
    previewOrientation: 'landscape',
  });
  assert.equal(plan.rotationApplied, 270);
});

test('EXIF 3 dopo camera processing non ruota i pixel; richiede solo rewrite tag', () => {
  const input = {
    ...base,
    width: 4000,
    height: 3000,
    exifOrientation: 3,
    deviceOrientationAtCapture: 'landscape-left' as const,
    previewOrientation: 'landscape' as const,
    cameraProcessingApplied: true,
  };
  const plan = planCapturedDocumentOrientation(input);
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.equal(plan.normalizationReason, 'camera_processing_applied');
  assert.equal(staleProcessedExifRequiresRewrite(input, plan), true);
});

test('bitmap gia landscape non viene ruotato di nuovo', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    width: 4000,
    height: 3000,
    exifOrientation: 6,
    deviceOrientationAtCapture: 'landscape-left',
    previewOrientation: 'landscape',
    cameraProcessingApplied: true,
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.equal(plan.normalizationReason, 'camera_processing_applied');
});

test('bitmap con EXIF non applicato viene normalizzato prima del crop', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    cameraProcessingApplied: false,
    exifOrientation: 6,
    deviceOrientationAtCapture: 'landscape-left',
    previewOrientation: 'landscape',
  });
  assert.ok(plan.normalizedWidth > plan.normalizedHeight);
});

test('nessuna doppia rotazione quando camera ha gia processato EXIF', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    width: 4000,
    height: 3000,
    exifOrientation: 8,
    deviceOrientationAtCapture: 'landscape-right',
    previewOrientation: 'landscape',
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.equal(plan.normalizationReason, 'camera_processing_applied');
});

test('EXIF processato non riceve correzione residua dagli assi UI', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    width: 4000,
    height: 3000,
    exifOrientation: 6,
    deviceOrientationAtCapture: 'portrait',
    previewOrientation: 'portrait',
    cameraProcessingApplied: true,
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.equal(plan.normalizationReason, 'camera_processing_applied');
});

test('raw KÜNZI gia upright landscape non viene ruotato verso la UI portrait', () => {
  const plan = planCapturedDocumentOrientation({
    ...base,
    width: 4080,
    height: 3060,
    exifOrientation: 1,
    deviceOrientationAtCapture: 'portrait',
    previewOrientation: 'portrait',
    cameraProcessingApplied: true,
    rawCapturePreserved: true,
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(plan.rotationApplied, 0);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [4080, 3060]);
  assert.equal(plan.orientation, 'landscape-left');
  assert.equal(plan.normalizationReason, 'bitmap_already_oriented');
});

test('metadati pagina conservano landscape-left', () => {
  const input = {
    ...base,
    deviceOrientationAtCapture: 'landscape-left' as const,
    previewOrientation: 'landscape' as const,
  };
  const metadata = pageCaptureMetadata(input, planCapturedDocumentOrientation(input));
  assert.equal(metadata.captureOrientation, 'landscape-left');
  assert.equal(metadata.normalizedOrientation, 'landscape-left');
});

test('metadati pagina conservano landscape-right', () => {
  const input = {
    ...base,
    deviceOrientationAtCapture: 'landscape-right' as const,
    previewOrientation: 'landscape' as const,
  };
  const metadata = pageCaptureMetadata(input, planCapturedDocumentOrientation(input));
  assert.equal(metadata.captureOrientation, 'landscape-right');
});

test('normalizzazione preserva originale fino al completamento', () => {
  assert.equal(planCapturedDocumentOrientation(base).preserveOriginalUntilComplete, true);
});

test('normalizzazione vieta upscale', () => {
  assert.equal(planCapturedDocumentOrientation(base).allowUpscale, false);
});

test('dimensioni non valide producono errore ripetibile', () => {
  assert.throws(() => planCapturedDocumentOrientation({ ...base, width: 0 }));
});

test('multipagina mista conserva metadati indipendenti', () => {
  const portrait = pageCaptureMetadata(base, planCapturedDocumentOrientation(base));
  const landscapeInput = {
    ...base,
    width: 4000,
    height: 3000,
    deviceOrientationAtCapture: 'landscape-right' as const,
    previewOrientation: 'landscape' as const,
  };
  const landscape = pageCaptureMetadata(
    landscapeInput,
    planCapturedDocumentOrientation(landscapeInput),
  );
  assert.deepEqual(
    [portrait.normalizedOrientation, landscape.normalizedOrientation],
    ['portrait', 'landscape-right'],
  );
});

test('business card profile remains isolated from document orientation core', () => {
  const profile = read('lib/camera-capture-profile.ts');
  assert.match(profile, /documentType === 'business_card'/);
  assert.doesNotMatch(profile, /document-capture-orientation/);
});

test('scanner lifecycle owns pages independently from preview orientation', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /setDocumentPages\(\(previous\) => \[\.\.\.previous, pending\.page\]\)/);
});

test('review already exposes a manual rotation fallback', () => {
  const preview = read('components/DocumentImagesPreview.tsx');
  assert.match(preview, /rotateViewer/);
  assert.match(preview, /accessibilityLabel=\{t\('rotateImage'\)\}/);
});

test('preview e OCR usano gli stessi pixel corretti dal canonico', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /const canonicalUri = oriented\.normalizedUri/);
  assert.match(scanner, /const preReadingUri = croppedUri \?\? canonicalUri/);
  assert.match(scanner, /const persistedUri = readingOriented\.normalizedUri/);
  assert.match(scanner, /const ocrUri = persistedUri/);
  assert.match(scanner, /originalUri: photo\.uri/);
  assert.match(scanner, /canonicalUri,/);
});

test('preview e OCR usano gli stessi pixel corretti dal canonico', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /const canonicalUri = oriented\.normalizedUri/);
  assert.match(scanner, /const preReadingUri = croppedUri \?\? canonicalUri/);
  assert.match(scanner, /const persistedUri = readingOriented\.normalizedUri/);
  assert.match(scanner, /const ocrUri = persistedUri/);
  assert.match(scanner, /originalUri: photo\.uri/);
  assert.match(scanner, /canonicalUri,/);
});

test('camera documenti usa una sola materializzazione full-frame', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /exif: true/);
  assert.match(scanner, /skipProcessing: false/);
  assert.match(scanner, /normalizeCapturedDocumentOrientation\(/);
  assert.match(scanner, /const canonicalUri = oriented\.normalizedUri/);
  assert.doesNotMatch(scanner, /forceManipulatorMeasurement|resolveCaptureBitmap/);
  assert.doesNotMatch(scanner, /stripJpegExifOrientation/);
});

test('orientation core does not import parser, OCR or storage', () => {
  const source = read('lib/document-capture-orientation.ts');
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:parser|ocr|storage|supabase)/i);
});

test('normalizeCapturedDocumentOrientation applica probe reading-order su pre-landscape', () => {
  const imageUtils = read('lib/image-utils.ts');
  assert.match(imageUtils, /needsLandscapeUpsideDownProbe/);
  assert.match(imageUtils, /resolveLandscapeUpsideDownFromImage/);
  assert.match(imageUtils, /applyLandscapeReadingOrderCorrection/);
});

test('processed visual rotation 0 on locked 0/180 completes before 90/270 fallback', () => {
  const imageUtils = read('lib/image-utils.ts');
  const normalizeAt = imageUtils.indexOf('export async function normalizeCapturedDocumentOrientation');
  const deterministicAt = imageUtils.indexOf('resolveDeterministicCaptureOrientation', normalizeAt);
  const helperAt = imageUtils.indexOf('applyProcessedVisualOrientationDecision', normalizeAt);
  const probedAt = imageUtils.indexOf('visualProbed = applied.visualComplete', normalizeAt);
  const mismatchAt = imageUtils.indexOf(
    'if (!visualProbed && needsLandscapeAspectMismatchProbe',
    normalizeAt,
  );
  assert.ok(normalizeAt > 0);
  assert.ok(deterministicAt > normalizeAt && deterministicAt < helperAt);
  assert.ok(helperAt > normalizeAt && helperAt < mismatchAt);
  assert.ok(probedAt > helperAt && probedAt < mismatchAt);
});

test('deterministic capture orientation is applied before visual probes', () => {
  const capture = read('lib/document-capture-orientation.ts');
  assert.match(capture, /resolveDeterministicCaptureRotation/);
  assert.match(capture, /deterministic_capture_orientation/);
  const imageUtils = read('lib/image-utils.ts');
  assert.match(imageUtils, /resolveDeterministicCaptureOrientation\(input\)/);
  assert.match(imageUtils, /applyDeterministicCaptureOrientation/);
});

test('processed visual rotation 0 on locked 0/180 completes before 90/270 fallback', () => {
  const imageUtils = read('lib/image-utils.ts');
  const normalizeAt = imageUtils.indexOf('export async function normalizeCapturedDocumentOrientation');
  const deterministicAt = imageUtils.indexOf('resolveDeterministicCaptureOrientation', normalizeAt);
  const helperAt = imageUtils.indexOf('applyProcessedVisualOrientationDecision', normalizeAt);
  const probedAt = imageUtils.indexOf('visualProbed = applied.visualComplete', normalizeAt);
  const mismatchAt = imageUtils.indexOf(
    'if (!visualProbed && needsLandscapeAspectMismatchProbe',
    normalizeAt,
  );
  assert.ok(normalizeAt > 0);
  assert.ok(deterministicAt > normalizeAt && deterministicAt < helperAt);
  assert.ok(helperAt > normalizeAt && helperAt < mismatchAt);
  assert.ok(probedAt > helperAt && probedAt < mismatchAt);
});

test('deterministic capture orientation is applied before visual probes', () => {
  const capture = read('lib/document-capture-orientation.ts');
  assert.match(capture, /resolveDeterministicCaptureRotation/);
  assert.match(capture, /deterministic_capture_orientation/);
  const imageUtils = read('lib/image-utils.ts');
  assert.match(imageUtils, /resolveDeterministicCaptureOrientation\(input\)/);
  assert.match(imageUtils, /applyDeterministicCaptureOrientation/);
});

test('scanner documenti non mostra una cornice basata su geometria presunta', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.doesNotMatch(scanner, /useDocumentCaptureOrientation/);
  // Prefer pending-page capture mode when present; fall back to live captureMode.
  assert.match(
    scanner,
    /(?:displayedCaptureMode|captureMode) === 'landscape-left'[\s\S]*\? 'landscape'[\s\S]*: 'portrait'/,
  );
  assert.match(scanner, /showCardOverlay =\s*documentType === 'business_card' && businessMode === 'card'/);
  assert.match(scanner, /showOrientationInHeader =\s*documentType !== 'business_card' \|\| businessMode === 'card'/);
  assert.doesNotMatch(scanner, /documentModeSelector/);
});

test('documenti normalizzano il canonico solo se necessario e crop OCR resta derivato', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const captureAt = scanner.indexOf('const capturePhoto = useCallback');
  const documentAt = scanner.indexOf("if (documentType !== 'business_card')", captureAt);
  const returnAt = scanner.indexOf('return;', documentAt);
  const cropAt = scanner.indexOf('const ocrPlan = await buildScanPlan(', documentAt);
  assert.ok(captureAt > 0 && documentAt > captureAt && returnAt > documentAt && cropAt > returnAt);
  assert.match(scanner.slice(documentAt, returnAt), /normalizeCapturedDocumentOrientation\(/);
  assert.doesNotMatch(scanner.slice(documentAt, returnAt), /rotateImage\(canonicalUri, 180\)|resolveCaptureBitmap/);
});

test('metadati orientamento vengono passati al workflow persistente', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const workflow = read('lib/scan-process-workflow.ts');
  assert.match(scanner, /pageCaptureMetadata: documentPages\.map/);
  assert.match(workflow, /pageCaptureMetadata: \[\.\.\.pageCaptureMetadata\]/);
});

test('scanner congela captureMode materializzato allo shutter e logga CameraOrientation', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const captureAt = scanner.indexOf('const capturePhoto = useCallback');
  const takeAt = scanner.indexOf('takePictureAsync', captureAt);
  const shutterAt = scanner.indexOf('const shutterCaptureMode:', captureAt);
  assert.ok(shutterAt > captureAt && shutterAt < takeAt);
  const shutterSlice = scanner.slice(shutterAt, takeAt);
  assert.match(shutterSlice, /captureMode/);
  assert.match(shutterSlice, /isDocumentLandscape/);
  assert.match(scanner, /logCameraOrientation\('capture_begin'/);
  assert.match(scanner, /logCameraOrientation\('device_at_shutter'/);
  assert.match(scanner, /logCameraOrientation\('picture_result'/);
  assert.match(scanner, /logCameraOrientation\('exif'/);
  assert.match(scanner, /selectedCaptureMode: shutterCaptureMode/);
  assert.match(scanner, /screenOrientationAtCapture: shutterCaptureMode/);
});

test('scanner documenti applica soltanto il lock scelto esplicitamente', () => {
  const rootLayout = read('app/_layout.tsx');
  const scanRoute = read('app/scan/[type].tsx');
  const appConfig = JSON.parse(read('app.json')) as { expo: { orientation: string } };
  assert.equal(appConfig.expo.orientation, 'default');
  assert.match(rootLayout, /orientation: 'portrait_up'/);
  assert.match(scanRoute, /ScreenOrientation\.OrientationLock\.LANDSCAPE_RIGHT/);
  assert.match(scanRoute, /ScreenOrientation\.OrientationLock\.PORTRAIT_UP/);
  assert.match(scanRoute, /\? 'landscape_right'[\s\S]*: 'portrait_up'/);
  assert.doesNotMatch(scanRoute, /orientation:\s*'all'/);
});

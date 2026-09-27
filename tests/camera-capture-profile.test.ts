import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  BUSINESS_CARD_CAMERA_ZOOM,
  BUSINESS_CARD_CAMERA_ZOOM_PORTRAIT,
  BUSINESS_CARD_OVERLAY_WIDTH_RATIO,
  DOCUMENT_CAMERA_ZOOM,
  DOCUMENT_OVERLAY_WIDTH_RATIO,
  cameraAvailabilityStatus,
  cameraCaptureProfile,
  cameraCaptureProfileId,
  clampCameraZoom,
  resetCameraZoom,
  selectPrimaryBackLens,
  zoomFromPinch,
} from '../lib/camera-capture-profile';
import { dimensionsAfterExifRotation } from '../lib/image-preparation';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

test('business card usa il profilo business_card invariato', () => {
  const profile = cameraCaptureProfile('business_card', 'landscape', 'android');
  assert.equal(cameraCaptureProfileId('business_card'), 'business_card');
  assert.equal(profile.initialZoom, BUSINESS_CARD_CAMERA_ZOOM);
});

test('preventivo usa il profilo document', () => {
  assert.equal(cameraCaptureProfileId('quote'), 'document');
});

test('ordine usa il profilo document', () => {
  assert.equal(cameraCaptureProfileId('order'), 'document');
});

test('documento libero usa il profilo document', () => {
  assert.equal(cameraCaptureProfileId('free_document'), 'document');
});

test('zoom biglietto non viene trasferito al documento', () => {
  const card = cameraCaptureProfile('business_card', 'portrait', 'android');
  const document = cameraCaptureProfile('quote', 'portrait', 'android');
  assert.equal(card.initialZoom, BUSINESS_CARD_CAMERA_ZOOM_PORTRAIT);
  assert.equal(document.initialZoom, DOCUMENT_CAMERA_ZOOM);
});

test('business card uses neutral default zoom independently of document mode', () => {
  const document = cameraCaptureProfile('order', 'landscape', 'android');
  const card = cameraCaptureProfile('business_card', 'landscape', 'android');
  assert.equal(card.initialZoom, 0);
  assert.equal(document.initialZoom, DOCUMENT_CAMERA_ZOOM);
  assert.equal(card.initialDigitalCrop, false);
  assert.equal(card.maxZoom, 0);
});

test('ogni nuova sessione documento riparte dal default neutro', () => {
  const first = cameraCaptureProfile('quote', 'portrait', 'android');
  const second = cameraCaptureProfile('quote', 'portrait', 'android');
  assert.equal(resetCameraZoom(first), 0);
  assert.equal(resetCameraZoom(second), 0);
});

test('reset zoom ripristina il valore del profilo', () => {
  const profile = cameraCaptureProfile('business_card', 'portrait', 'ios');
  assert.equal(resetCameraZoom(profile), 0);
});

test('overlay biglietto mantiene la larghezza approvata', () => {
  assert.equal(BUSINESS_CARD_OVERLAY_WIDTH_RATIO, 0.92);
});

test('overlay documento e piu ampio di quello precedente', () => {
  assert.ok(DOCUMENT_OVERLAY_WIDTH_RATIO > 0.8);
  assert.ok(DOCUMENT_OVERLAY_WIDTH_RATIO > BUSINESS_CARD_OVERLAY_WIDTH_RATIO);
});

test('profilo portrait mantiene zoom documentale neutro', () => {
  assert.equal(cameraCaptureProfile('quote', 'portrait', 'android').initialZoom, 0);
});

test('profilo landscape mantiene zoom documentale neutro', () => {
  assert.equal(cameraCaptureProfile('quote', 'landscape', 'android').initialZoom, 0);
});

test('rotazione EXIF scambia correttamente gli assi immagine', () => {
  assert.deepEqual(dimensionsAfterExifRotation(3000, 4000, 90), {
    width: 4000,
    height: 3000,
  });
});

test('entrambi i profili usano la camera posteriore', () => {
  assert.equal(cameraCaptureProfile('business_card', 'landscape', 'android').facing, 'back');
  assert.equal(cameraCaptureProfile('quote', 'portrait', 'android').facing, 'back');
});

test('assenza camera e rappresentata esplicitamente', () => {
  assert.equal(cameraAvailabilityStatus(false), 'unavailable');
});

test('dispositivo con una sola lente usa la sola lente disponibile', () => {
  assert.equal(selectPrimaryBackLens(['singleBackCamera']), undefined);
});

test('dispositivo multi-lente lascia a Expo la wide principale nativa', () => {
  assert.equal(
    selectPrimaryBackLens([
      'builtInUltraWideCamera',
      'builtInTelephotoCamera',
      'builtInWideAngleCamera',
    ]),
    undefined,
  );
});

test('pinch zoom resta nei limiti del profilo', () => {
  const profile = cameraCaptureProfile('quote', 'portrait', 'android');
  assert.equal(zoomFromPinch(0, 100, profile), profile.maxZoom);
  assert.equal(zoomFromPinch(0.1, 0.01, profile), profile.minZoom);
  assert.equal(clampCameraZoom(Number.NaN, profile), profile.minZoom);
});

test('profilo documentale non applica crop digitale iniziale', () => {
  const profile = cameraCaptureProfile('free_document', 'portrait', 'ios');
  assert.equal(profile.initialDigitalCrop, false);
  assert.equal(profile.initialZoom, 0);
});

test('profilo documentale vieta upscale e mantiene qualita nativa', () => {
  const profile = cameraCaptureProfile('order', 'portrait', 'android');
  assert.equal(profile.allowUpscale, false);
  assert.equal(profile.pictureSize, undefined);
});

test('Android mantiene preview e crop nello stesso scale mode cover', () => {
  assert.equal(cameraCaptureProfile('quote', 'portrait', 'android').ratio, undefined);
  assert.equal(cameraCaptureProfile('business_card', 'portrait', 'android').ratio, undefined);
});

test('iOS documenti abilita orientamento responsive e usa la wide nativa', () => {
  const profile = cameraCaptureProfile('quote', 'landscape', 'ios');
  assert.equal(profile.responsiveOrientationWhenOrientationLocked, true);
  assert.equal(profile.selectedLens, undefined);
});

test('MultiPageScanner consuma il profilo e isola lo zoom della sessione', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /cameraCaptureProfile\(\s*documentType/);
  // Lo zoom resta confinato al ramo biglietto e ha una sola fonte: lo stato di
  // sessione, che il profilo risolto sul dispositivo aggiorna.
  assert.match(scanner, /zoom=\{showCardOverlay && cameraReady \? cameraZoom : 0\}/);
  assert.match(scanner, /setCameraZoom\(resetCameraZoom\(captureProfileRef\.current\)\)/);
  assert.match(scanner, /key=\{`camera-\$\{cameraSession\}-\$\{captureProfile\.id\}`\}/);
  // Il punto di misurazione AF vale anche per il biglietto: senza, la camera
  // nativa mette a fuoco l'angolo dell'anteprima invece del riquadro.
  assert.match(scanner, /const cameraViewFocusProps = stabilizeFocusProps\(cameraFocusProps\)/);
  assert.doesNotMatch(scanner, /zoomFromPinch\(|onTouchStart|pinchStartRef/);
  assert.match(scanner, /accessibilityLabel=\{t\('resetCameraFraming'\)\}/);
  assert.doesNotMatch(scanner, /targetCardZoom/);
});

test('integrazione mantiene pipeline multipagina e profilo locale senza cloud automatico', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const workflow = read('lib/scan-process-workflow.ts');
  assert.match(scanner, /imagePipelineUris\(photo\.uri, ocrPreparedUri\)/);
  assert.match(scanner, /persistDocument: async \(document, guard\)/);
  assert.match(scanner, /await addDocument\(document, guard\)/);
  assert.match(workflow, /scanPagesLocally\(/);
  assert.match(workflow, /mergeDocumentPageFields\(pageExtractions\)/);
  assert.match(workflow, /cloud è raggiungibile soltanto/);
  assert.doesNotMatch(scanner, /runDocumentAiReview|extractCloudPagesWithLocalFallback/);
});

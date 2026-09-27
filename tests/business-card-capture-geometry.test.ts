import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { getOverlayFrameRect } from '../lib/overlay-geometry';
import {
  CARD_FRAME_VIEWPORT_WIDTH_RATIO_1X,
  CARD_FRAME_VIEWPORT_WIDTH_RATIO_2X,
  resetActiveCardZoomPlan,
  resolveCardZoomPlan,
  setActiveCardZoomPlan,
} from '../lib/business-card-zoom-policy';
import {
  buildCropOverlaySvg,
  formatCardGeometryLog,
} from '../lib/card-capture-diagnostics';
import { createFocusGate } from '../lib/camera-focus-gate';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const VIEWPORT = { width: 393, height: 640 };
const CARD_INSETS = { top: 20, bottom: 100, horizontal: 16 };

test('1 la preview del biglietto non applica alcuna scala maggiore di 1', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const cameraStyle = /camera: \{ \.\.\.StyleSheet\.absoluteFillObject \}/;
  assert.match(scanner, cameraStyle);
  // Nessun transform/scale sullo stage della camera o sulla CameraView.
  assert.doesNotMatch(scanner, /camera(Stage)?: \{[^}]*transform/);
  assert.doesNotMatch(scanner, /scaleX|scaleY/);
});

test('2 il biglietto usa il modello esplicito anteprima→pixel', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /const cropSafety = assessCardCropSafety\(plan\)/);
  const imageUtils = read('lib/image-utils.ts');
  assert.match(
    imageUtils,
    /documentType === 'business_card'\s*\?\s*mapPreviewRectToPhotoRect\(/
  );
});

test('3 nessun margine empirico allarga il ritaglio del biglietto', () => {
  const imageUtils = read('lib/image-utils.ts');
  assert.doesNotMatch(imageUtils, /expandRectWithinBounds/);
  assert.doesNotMatch(imageUtils, /CARD_CROP_SAFETY_MARGIN/);
});

test('4 un ritaglio business-card non verificabile fallisce chiuso senza full-frame OCR', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /if \(!useOverlayCrop\) \{[\s\S]{0,700}?Scansione da ripetere/);
  const cardStart = scanner.indexOf('const cropSafety = assessCardCropSafety(plan)');
  const cardEnd = scanner.indexOf('return;\n      }', cardStart);
  const cardBlock = scanner.slice(cardStart, cardEnd > cardStart ? cardEnd : undefined);
  assert.doesNotMatch(cardBlock, /normalizeFullFrameScan\(fullFrameUri/);
});

test('5 il biglietto non viene mai ruotato in base alla sola etichetta di forma', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  // Il ritaglio coincide con la cornice, che ha già l'orientamento scelto:
  // nessuna forzatura di forma può entrare nel percorso biglietto.
  assert.doesNotMatch(scanner, /ensureCardReadingAspect/);
  const imageUtils = read('lib/image-utils.ts');
  assert.match(
    imageUtils,
    /documentType === 'business_card'\s*\?\s*0\s*:\s*readingOrientationRotate\(/
  );
  // Il ripiego non passa da readingOrientationRotate, che ruota in base
  // all'etichetta cardOrientation invece che al contenuto della scena.
  const fallback = imageUtils.slice(
    imageUtils.indexOf('export async function normalizeFullFrameScan'),
    imageUtils.indexOf('export async function prepareScannedImage')
  );
  assert.ok(fallback.length > 0);
  assert.doesNotMatch(fallback, /readingOrientationRotate|cardOrientation/);
});

test('9 la patch nativa crea l evento CAMERA_OPEN con le dimensioni degli stream', () => {
  const patch = read('scripts/patch-expo-camera-focus.mjs');
  // L'ancora storica assumeva un evento già presente nel sorgente expo-camera:
  // quel blocco non esiste più, quindi la patch deve crearlo.
  assert.match(patch, /if \(!next\.includes\('putString\("state", "CAMERA_OPEN"\)'\)\) \{/);
  assert.match(patch, /previewUseCase\?\.resolutionInfo\?\.resolution\?\.toString\(\)/);
  assert.match(patch, /imageCaptureUseCase\?\.resolutionInfo\?\.resolution\?\.toString\(\)/);

  // Una patch applicata a metà deve far fallire la build, non degradare.
  const rebuild = read('scripts/rebuild-android.mjs');
  assert.match(rebuild, /'previewStreamSize'/);
});

test('10 la build segnala quando la patch nativa non raggiunge l APK', () => {
  const rebuild = read('scripts/rebuild-android.mjs');
  // expo-camera 17 è distribuito come AAR precompilato: verificare i marker
  // nei sorgenti non basta a dimostrare che il codice patchato sia compilato.
  assert.match(rebuild, /local-maven-repo/);
  assert.match(rebuild, /buildFromSource/);
  assert.match(rebuild, /verifyPatchReachesBuild\(\)/);
});

test('17 la calibrazione visiva salva tutti gli stadi fino alla base OCR', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /saveCardCaptureArtifacts\(\{\s*rawUri: fullFrameUri/);
  assert.match(scanner, /overlayCropUri: useOverlayCrop \? overlayCropUri : undefined/);
  assert.match(scanner, /boundaryUri: boundaryOutputUri/);
  assert.match(scanner, /ocrInputUri: ocrPreparedUri/);
  assert.match(scanner, /boundaryMode: boundaryRefinement\.mode/);

  // La diagnostica deve avvenire dopo l'auto-orientamento, non prima.
  assert.ok(
    scanner.indexOf('ocrPreparedUri = await autoOrientBusinessCardImage') <
      scanner.indexOf('await saveCardCaptureArtifacts({')
  );

  // Il rettangolo va disegnato nelle coordinate del fotogramma salvato.
  const svg = buildCropOverlaySvg('card-1-raw.jpg', {
    photoWidth: 3060,
    photoHeight: 4080,
    cropX: 330,
    cropY: 986,
    cropWidth: 2400,
    cropHeight: 1514,
  });
  assert.match(svg, /viewBox="0 0 3060 4080"/);
  assert.match(svg, /xlink:href="card-1-raw\.jpg"/);
  assert.match(svg, /<rect x="330" y="986" width="2400" height="1514"/);

  const artifacts = read('lib/card-capture-artifacts.ts');
  assert.match(artifacts, /02-overlay-crop\.jpg/);
  assert.match(artifacts, /03-boundary-output\.jpg/);
  assert.match(artifacts, /04-ocr-base-input\.jpg/);
});

test('14 expo-camera viene compilato dai sorgenti, non dall AAR precompilato', () => {
  // Senza questo elenco il modulo arriva come AAR e qualunque patch nativa
  // resta inerte: le dimensioni degli stream tornerebbero nulle.
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.expo?.autolinking?.buildFromSource, ['expo-camera']);
});

test('15 la prop dell evento è collegata nel file compilato che l app carica', () => {
  // Metro risolve `build/CameraView.js`: patchare solo `src/CameraView.tsx`
  // lasciava l'evento nativo senza alcun ascoltatore sul lato JS.
  const patch = read('scripts/patch-expo-camera-focus.mjs');
  assert.match(patch, /patchFile\('build\/CameraView\.js', patchJsCameraViewBuild/);
  assert.match(patch, /onAutofocusStateChanged=\{this\.props\.onAutofocusStateChanged/);
});

test('16 la patch nativa compilata non altera inquadratura e scatto', () => {
  // Le modifiche a ViewPort, targetRotation, capture mode e durata del blocco
  // AF/AE/AWB cambiano inquadratura, rotazione ed esposizione: la camera
  // documenti è tarata sul comportamento di serie, quindi restano dietro un
  // interruttore esplicito. Il punto di messa a fuoco no: è un difetto del
  // sorgente di serie e non tocca la geometria.
  const patch = read('scripts/patch-expo-camera-focus.mjs');
  assert.match(patch, /const APPLY_CAPTURE_BEHAVIOR_PATCHES = process\.env\.EXPO_CAMERA_CAPTURE_PATCHES === '1'/);
  for (const mutator of [
    'patchAndroidViewPortSync',
    'patchAndroidCaptureRotationRace',
    'patchAndroidCaptureQuality',
    'patchAndroidFocusMetering',
    'patchAndroidFocusBeforeCapture',
  ]) {
    assert.match(
      patch,
      new RegExp(`gated\\(${mutator}\\)`),
      `${mutator} deve restare dietro l'interruttore`
    );
  }
  // Diagnostica e correzione del punto di fuoco restano sempre applicate.
  assert.match(patch, /patchAndroidCameraOpenDiagnostics\(\n/);
  assert.doesNotMatch(patch, /gated\(patchAndroidView\)/);
  assert.doesNotMatch(patch, /gated\(patchAndroidModule\)/);
});

test('6 le anteprime salvate sono mostrate per intero, non ritagliate', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(
    scanner,
    /source=\{\{ uri: item\.uri \}\}\s*style=\{styles\.previewImage\}\s*resizeMode="contain"/
  );
});

test('7 il cambio modalità non riusa la geometria del documento', () => {
  const cardFrame = getOverlayFrameRect(
    VIEWPORT.width,
    VIEWPORT.height,
    'business_card',
    'landscape',
    CARD_INSETS
  );
  const documentFrame = getOverlayFrameRect(
    VIEWPORT.width,
    VIEWPORT.height,
    'order',
    'landscape',
    {}
  );
  assert.notEqual(cardFrame.width, documentFrame.width);
  assert.notEqual(cardFrame.height, documentFrame.height);
  const cardAspect = cardFrame.width / cardFrame.height;
  assert.ok(Math.abs(cardAspect - 85.6 / 53.98) < 0.01);
});

const cardFrame = (
  orientation: 'landscape' | 'portrait',
  viewport: { width: number; height: number } = VIEWPORT
) => getOverlayFrameRect(viewport.width, viewport.height, 'business_card', orientation, CARD_INSETS);

// Geometria reale del dispositivo su cui si collauda.
const DEVICE_VIEWPORT = { width: 375.385, height: 548 };

test('7b con il profilo 2x la cornice riempie quasi tutta la larghezza visibile', () => {
  setActiveCardZoomPlan(resolveCardZoomPlan({ maxZoomRatio: 10 }));
  const wide = cardFrame('landscape', DEVICE_VIEWPORT);
  const share = wide.width / DEVICE_VIEWPORT.width;

  // Il requisito è sulla larghezza FINALE, non su una scala intermedia: la
  // versione precedente si fermava a 284 px (75,7%) componendo più rapporti.
  assert.ok(wide.width >= 352 && wide.width <= 360, `larghezza cornice: ${wide.width}`);
  assert.ok(share >= 0.94 && share <= 0.96, `quota larghezza: ${share}`);
  assert.ok(wide.x >= 0 && wide.x + wide.width <= DEVICE_VIEWPORT.width);
  assert.equal(CARD_FRAME_VIEWPORT_WIDTH_RATIO_2X, 0.95);
  resetActiveCardZoomPlan();
});

test('7b-bis il profilo cambia solo la scala, mai i rapporti della carta', () => {
  resetActiveCardZoomPlan();
  const narrowLandscape = cardFrame('landscape');
  const narrowPortrait = cardFrame('portrait');
  assert.equal(CARD_FRAME_VIEWPORT_WIDTH_RATIO_1X, 0.76);
  assert.ok(
    Math.abs(narrowLandscape.width / VIEWPORT.width - CARD_FRAME_VIEWPORT_WIDTH_RATIO_1X) < 0.01
  );

  setActiveCardZoomPlan(resolveCardZoomPlan({ maxZoomRatio: 10 }));
  const wideLandscape = cardFrame('landscape');
  const widePortrait = cardFrame('portrait');
  assert.ok(wideLandscape.width > narrowLandscape.width);

  for (const frame of [narrowLandscape, wideLandscape]) {
    assert.ok(Math.abs(frame.width / frame.height - 85.6 / 53.98) < 0.001);
  }
  // Verticale: la larghezza richiesta non entrerebbe in altezza, quindi vince
  // l'altezza utile e resta il riquadro più grande che ci sta davvero.
  for (const frame of [narrowPortrait, widePortrait]) {
    assert.ok(Math.abs(frame.width / frame.height - 53.98 / 85.6) < 0.001);
    assert.ok(frame.height <= (VIEWPORT.height - CARD_INSETS.top - CARD_INSETS.bottom) * 0.94 + 0.01);
  }
  resetActiveCardZoomPlan();

  // La cornice visibile e il ritaglio nascono dalla stessa funzione: cambiando
  // il profilo il secondo segue il primo senza calcoli paralleli.
  assert.match(read('components/Camera/Overlay.tsx'), /getOverlayFrameRectInView/);
  assert.match(read('lib/image-utils.ts'), /getOverlayFrameRectInView/);
});

test('7b-ter i documenti non risentono del profilo del biglietto', () => {
  const documentFrame = () =>
    getOverlayFrameRect(VIEWPORT.width, VIEWPORT.height, 'quote', 'portrait', CARD_INSETS);

  resetActiveCardZoomPlan();
  const before = documentFrame();
  setActiveCardZoomPlan(resolveCardZoomPlan({ maxZoomRatio: 10 }));
  const after = documentFrame();
  resetActiveCardZoomPlan();

  assert.deepEqual(before, after);
});

test('7c lo zoom del biglietto nasce dall intervallo reale del dispositivo', () => {
  // expo-camera calcola zoomRatio = clamp(zoom * maxZoomRatio, 1, maxZoomRatio):
  // la prop non è un ingrandimento ottico, va divisa per il massimo del device.
  const kotlin = read(
    'node_modules/expo-camera/android/src/main/java/expo/modules/camera/ExpoCameraView.kt'
  );
  assert.match(kotlin, /value\.coerceIn\(0f, 1f\) \* maxZoomRatio/);

  const wide = resolveCardZoomPlan({ maxZoomRatio: 10 });
  assert.equal(wide.effectiveMagnification, 2);
  assert.ok(Math.abs(wide.appliedZoomValue * 10 - 2) < 1e-9);
  assert.equal(wide.fallbackUsed, false);
  assert.equal(wide.frameViewportWidthRatio, CARD_FRAME_VIEWPORT_WIDTH_RATIO_2X);

  // Zoom massimo appena sufficiente: si usa il valore più vicino disponibile.
  const limited = resolveCardZoomPlan({ maxZoomRatio: 1.9 });
  assert.equal(limited.effectiveMagnification, 1.9);
  assert.equal(limited.appliedZoomValue, 1);
  assert.equal(limited.frameViewportWidthRatio, CARD_FRAME_VIEWPORT_WIDTH_RATIO_2X);

  // Sotto la soglia utile non si applica uno zoom parziale: si resta a 1x.
  const unsupported = resolveCardZoomPlan({ maxZoomRatio: 1.2 });
  assert.equal(unsupported.appliedZoomValue, 0);
  assert.equal(unsupported.frameViewportWidthRatio, CARD_FRAME_VIEWPORT_WIDTH_RATIO_1X);
  assert.equal(unsupported.fallbackReason, 'magnification_unsupported');

  // Un massimo pari a 1 è quasi sempre capacità non ancora arrivata, non una
  // camera senza zoom: resta 1x ma classificato come misura mancante, così un
  // valore successivo può ancora attivare il profilo.
  for (const range of [{}, { maxZoomRatio: null }, { maxZoomRatio: Number.NaN }, { maxZoomRatio: 1 }]) {
    const plan = resolveCardZoomPlan(range);
    assert.equal(plan.appliedZoomValue, 0);
    assert.equal(plan.frameViewportWidthRatio, CARD_FRAME_VIEWPORT_WIDTH_RATIO_1X);
    assert.equal(plan.fallbackReason, 'zoom_range_unknown');
  }

  // L'intervallo è osservato sulla LiveData di CameraX, non letto una volta
  // sola all'apertura quando può essere ancora nullo.
  const patch = read('scripts/patch-expo-camera-focus.mjs');
  assert.match(patch, /cameraInfo\.zoomState\.observe\(currentActivity\)/);
  assert.match(patch, /putString\("state", "CAMERA_ZOOM_RANGE"\)/);
  assert.match(patch, /putFloat\("zoomRatio", zoomState\.zoomRatio\)/);
  assert.match(read('lib/camera-focus-gate.ts'), /nativeEvent\.maxZoomRatio === 'number'/);
});

test('7c-bis le capacità di zoom non disturbano la macchina a stati del fuoco', () => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  const gate = createFocusGate();
  gate.onAutofocusStateChanged({ nativeEvent: { state: 'FOCUSED_LOCKED' } });
  gate.onAutofocusStateChanged({
    nativeEvent: { state: 'CAMERA_ZOOM_RANGE', minZoomRatio: 1, maxZoomRatio: 8, zoomRatio: 2 },
  });

  // Lo stato AF resta quello reale e la misura arriva comunque alla diagnostica.
  assert.equal(gate.getLastAfState(), 'FOCUSED_LOCKED');
  assert.equal(gate.getCameraResolutionDiag()?.maxZoomRatio, 8);
  assert.equal(gate.getCameraResolutionDiag()?.zoomRatio, 2);

  // Capacità arrivate dopo l'apertura: l'apertura non deve cancellarle.
  gate.onAutofocusStateChanged({
    nativeEvent: { state: 'CAMERA_OPEN', previewStreamSize: '1600x1200', maxZoomRatio: 1 },
  });
  assert.equal(gate.getCameraResolutionDiag()?.maxZoomRatio, 8);
});

test('7c-focus-fail un NOT_FOCUSED non autorizza lo scatto e termina a timeout', async () => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  const gate = createFocusGate();
  const waiting = gate.waitForFocusedLocked(10);
  gate.onAutofocusStateChanged({
    nativeEvent: { state: 'NOT_FOCUSED_LOCKED', focusSuccessful: false },
  });
  assert.equal(await waiting, 'TIMEOUT');
});

test('7c-ter il piano si ricalcola quando le capacità arrivano in ritardo', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  // Nessun aggancio al solo CAMERA_OPEN: si reagisce a ogni variazione della
  // misura, altrimenti un primo valore incompleto congelerebbe il ripiego.
  assert.doesNotMatch(scanner, /nativeEvent\?\.state !== 'CAMERA_OPEN'/);
  assert.match(scanner, /if \(maxZoomRatio === cardZoomRangeRef\.current\) return;/);
  assert.match(scanner, /setCameraZoom\(plan\.appliedZoomValue\)/);
  assert.match(scanner, /logCardCaptureProfile\(plan\)/);
  assert.match(scanner, /logCardZoomApplied\(\{/);

  // Le tracce di collaudo non dipendono da __DEV__: il bundle QA è --dev false.
  const policy = read('lib/business-card-zoom-policy.ts');
  assert.match(policy, /export const CARD_ZOOM_QA_DIAGNOSTICS = RELEASE_QA_DIAGNOSTICS;/);
  assert.doesNotMatch(policy, /if \(!?__DEV__\)/);
});

test('7c-quater lo scatto poco nitido avvisa sulla luce senza bloccare nulla', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');

  // L'avviso nasce dal giudizio di nitidezza già usato per i tentativi: nessuna
  // soglia nuova, nessuna misura aggiuntiva su ogni scatto.
  assert.match(
    scanner,
    /logFocusTimeline\('SHARPNESS_LAST_RETRY_ACCEPT'[\s\S]{0,320}?setLowLightNotice\(t\('lowLightRetryHint'\)\)/
  );

  // Non blocca, non forza un altro scatto, non accende la torcia da solo.
  assert.doesNotMatch(scanner, /setTorchEnabled\(true\)/);
  assert.doesNotMatch(scanner, /Alert\.alert\([^)]*lowLightRetryHint/);

  // Mai due suggerimenti insieme: l'inquadratura ha la precedenza.
  assert.match(scanner, /\{captureHint \?\? lowLightNotice\}/);
  assert.match(scanner, /if \(!lowLightNotice \|\| scanning \|\| isProcessingDoc \|\| captureHint\) return;/);

  for (const locale of ['en', 'it'] as const) {
    const messages = JSON.parse(read(`i18n/${locale}.json`)) as Record<string, string>;
    const text = messages.lowLightRetryHint;
    assert.ok(text && text.length <= 70, `testo mancante o troppo lungo in ${locale}`);
  }
});

test('7d lo zoom resta confinato al biglietto e non aggiunge un secondo ritaglio', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  // La prop zoom vive nel solo ramo biglietto: i documenti restano a 0.
  assert.match(scanner, /const showCardOverlay =\s*\n?\s*documentType === 'business_card'/);
  assert.match(scanner, /zoom=\{showCardOverlay && cameraReady \? cameraZoom : 0\}/);
  assert.match(scanner, /if \(documentType !== 'business_card'\) return;/);

  // Lo zoom è già nell'inquadratura: nessun ingrandimento digitale successivo.
  const imageUtils = read('lib/image-utils.ts');
  assert.doesNotMatch(imageUtils, /appliedZoomValue|cardZoomPlan|CARD_TARGET_MAGNIFICATION/);

  // Documenti invariati.
  const profile = read('lib/camera-capture-profile.ts');
  assert.match(profile, /export const DOCUMENT_CAMERA_ZOOM = 0/);
  assert.match(profile, /export const DOCUMENT_OVERLAY_WIDTH_RATIO = 0\.98/);
});

test('8 la diagnostica di inquadratura riporta solo misure geometriche', () => {
  const line = formatCardGeometryLog({
    stage: 'crop_plan',
    photoWidth: 3060,
    photoHeight: 4080,
    cropDecision: 'applied_verified',
    cropValidated: true,
    mappingMode: 'cover',
    uncertaintyReason: null,
  });
  assert.match(line, /^\[CardCameraGeometry\] /);
  const payload = JSON.parse(line.replace('[CardCameraGeometry] ', ''));
  assert.equal(payload.photoWidth, 3060);
  assert.equal(payload.cropDecision, 'applied_verified');
  assert.equal(payload.cropValidated, true);
  assert.ok(!('uri' in payload));
  assert.ok(!('text' in payload));
});

test('11 il biglietto non attraversa il workflow semantico dei documenti', () => {
  const workflow = read('lib/scan-process-workflow.ts');
  // Il ramo biglietto costruisce il contatto e non entra nell'estrazione
  // strutturata, che accetta solo tipi documentali.
  assert.match(workflow, /documentType: Exclude<DocumentType, 'business_card'>/);
  assert.match(
    workflow,
    /if \(documentType === 'business_card'\) \{[\s\S]{0,600}?buildBusinessCard\(/
  );

  const scanner = read('components/Camera/MultiPageScanner.tsx');
  // Nessun helper di orientamento documentale nel percorso biglietto.
  const cardCropStart = scanner.indexOf('const cropSafety = assessCardCropSafety(plan)');
  const cardBlock = scanner.slice(
    cardCropStart,
    scanner.indexOf('const imageUris = imagePipelineUris(', cardCropStart)
  );
  assert.ok(cardBlock.length > 0);
  assert.doesNotMatch(cardBlock, /normalizeCapturedDocumentOrientation/);
  assert.doesNotMatch(cardBlock, /ProcessingOrientation/);
});

test('12 la modalità biglietto non mostra le diciture del documento', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /t\(processingTitleKey\(isBusinessCardMode\)\)/);
  assert.match(scanner, /processingMessageKey\(\s*isBusinessCardMode,/);
  assert.doesNotMatch(scanner, /t\('processing\.title'\)/);

  const it = JSON.parse(read('i18n/it.json')) as Record<string, string>;
  const en = JSON.parse(read('i18n/en.json')) as Record<string, string>;
  assert.equal(it['processing.cardTitle'], 'Elaborazione biglietto');
  assert.equal(en['processing.cardTitle'], 'Processing business card');
  for (const key of ['processing.cardPrepare', 'processing.cardAnalyze', 'processing.cardPersist']) {
    assert.ok(it[key], `chiave italiana mancante: ${key}`);
    assert.ok(en[key], `chiave inglese mancante: ${key}`);
    assert.doesNotMatch(it[key], /documento/i);
    assert.doesNotMatch(en[key], /document/i);
  }
});

test('13 una sola immagine canonica alimenta OCR, contatto ed export', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /const imageUris = imagePipelineUris\(photo\.uri, ocrPreparedUri\)/);
  assert.match(scanner, /uri: imageUris\.persistenceSourceUri, kind: 'card'/);

  const preparation = read('lib/image-preparation.ts');
  // Anteprima, persistenza e OCR puntano tutti allo stesso file preparato.
  assert.match(preparation, /previewUri: prepared/);
  assert.match(preparation, /persistenceSourceUri: prepared/);
  assert.match(preparation, /ocrPreparedUri: prepared/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { planCapturedDocumentOrientation } from '../lib/document-capture-orientation';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const route = read('app/scan/[type].tsx');
const scanner = read('components/Camera/MultiPageScanner.tsx');
const cameraPatch = read('scripts/patch-expo-camera-focus.mjs');
const persistence = read('lib/persistence.ts');
const qa = read('lib/export-qa-documents.ts');
const documentImages = read('components/DocumentImagesPreview.tsx');

test('1 accesso diretto alla camera', () => assert.match(route, /<MultiPageScanner/));
test('2 nessuna schermata preliminare', () => assert.doesNotMatch(route, /modeChoiceContainer|documentCaptureModeQuestion|setCaptureMode\(selectedMode\)/));
test('3 selettore documenti compatto con icone nell header', () => {
  assert.match(scanner, /headerRight:[\s\S]*documentCapturePortrait[\s\S]*documentCaptureLandscape/);
  assert.match(scanner, /headerDocumentModeButton:[\s\S]*width: 44[\s\S]*height: 44/);
  assert.match(scanner, /DocumentModeGlyph/);
  assert.doesNotMatch(scanner, /documentModeSelector/);
});
test('4 portrait lock', () => assert.match(route, /OrientationLock\.PORTRAIT_UP/));
test('4b documenti partono a 1x senza pinch ereditato', () => {
  assert.match(scanner, /const \[cameraZoom, setCameraZoom\] = useState\(0\)/);
  assert.doesNotMatch(scanner, /zoomFromPinch|pinchStartRef|onTouchStart/);
});
test('4c documenti fanno materializzare fisicamente l orientamento dalla camera nativa', () => {
  assert.match(scanner, /exif: true/);
  assert.match(scanner, /skipProcessing: false/);
  assert.match(scanner, /normalizeCapturedDocumentOrientation\(/);
  assert.doesNotMatch(scanner, /resolveCaptureBitmap|forceManipulatorMeasurement/);
  assert.doesNotMatch(scanner, /prepareFullDocumentImage|stripJpegExifOrientation/);
});
test('4d CameraX conserva la rotazione ricevuta prima della creazione ImageCapture', () => {
  assert.match(cameraPatch, /private var latestDeviceRotation: Int\? = null/);
  assert.match(cameraPatch, /val captureRotation = previewView\.display\?\.rotation \?: rotation/);
  assert.match(cameraPatch, /latestDeviceRotation = captureRotation[\s\S]*imageCaptureUseCase\?\.targetRotation = captureRotation/);
  assert.match(cameraPatch, /setTargetRotation\(latestDeviceRotation \?: previewView\.display\?\.rotation \?: Surface\.ROTATION_0\)/);
});
test('5 landscape-left utente usa il lock nativo antiorario', () => {
  assert.match(route, /captureMode === 'landscape-left'[\s\S]*OrientationLock\.LANDSCAPE_RIGHT/);
  assert.doesNotMatch(route, /OrientationLock\.LANDSCAPE_LEFT/);
});
test('5b modalita orizzontale significa soltanto landscape-left', () => {
  const contract = read('lib/document-capture-orientation.ts');
  assert.match(contract, /DocumentCaptureMode = 'portrait' \| 'landscape-left'/);
  assert.doesNotMatch(contract, /DocumentCaptureMode = 'portrait' \| 'landscape';/);
});
test('5c selettore header registra landscape-left', () => {
  assert.match(scanner, /\['portrait', 'landscape-left'\]/);
  assert.match(scanner, /selectedCaptureMode: shutterCaptureMode/);
});
test('5d preview e bitmap condividono la scelta landscape-left', () => {
  assert.match(scanner, /const captureOrientation = shutterDeviceOrientation/);
  assert.match(scanner, /const previewOrientation = expectsLandscape \? 'landscape' : 'portrait'/);
});
test('5e landscape-left sopravvive alla ricreazione Android nella rotta', () => {
  assert.match(route, /useState<DocumentCaptureMode>/);
  assert.match(route, /setCaptureModeState\(mode\)[\s\S]*router\.setParams\(\{ captureMode: mode \}\)/);
  assert.match(route, /router\.setParams\(\{ captureMode: mode \}\)/);
  assert.doesNotMatch(route, /const captureMode: DocumentCaptureMode =/);
  assert.doesNotMatch(route, /setCaptureModeState\(captureModeParam\)/);
});
test('5f conferma usa la modalita registrata nello scatto anche se la rotta cambia', () => {
  assert.match(scanner, /pendingDocumentPhoto\?\.page\.metadata\.selectedCaptureMode \?\? captureMode/);
  assert.match(scanner, /displayedCaptureMode === 'landscape-left'/);
  assert.match(scanner, /displayedCaptureMode === mode/);
});
test('6 ripristino portrait in uscita', () => assert.match(route, /return \(\) => \{[\s\S]*OrientationLock\.PORTRAIT_UP/));
test('7 UI completa landscape senza rotate sui componenti', () => {
  assert.match(route, /orientation:[\s\S]*'landscape_right'/);
  assert.doesNotMatch(scanner, /landscapeModeTextRotated|transform:\s*\[\{\s*rotate:/);
  assert.match(route, /headerShown:[\s\S]*captureMode !== 'landscape-left'/);
  assert.match(scanner, /\{landscapeHeaderRail\}[\s\S]*styles\.cameraStage/);
  assert.match(scanner, /onRequestExit[\s\S]*scanBackLabel[\s\S]*scanBackHint/);
});
test('8 Scatta sul dock destro landscape', () => {
  assert.match(scanner, /width: 96 \+ Math\.max\(insets\.right, 0\)/);
  assert.match(scanner, /controlsDockLandscape:[\s\S]*backgroundColor: colors\.surface/);
  assert.match(scanner, /landscapeActionButton:[\s\S]*width: 76[\s\S]*minHeight: 48/);
  assert.doesNotMatch(
    scanner.slice(
      scanner.indexOf('controlsDockLandscape:'),
      scanner.indexOf('landscapeActionButton:'),
    ),
    /rgba\(0,0,0/,
  );
});
test('8b utility e pagine landscape restano nelle barre laterali', () => {
  assert.match(scanner, /landscapeUtilityButton:[\s\S]*width: 48[\s\S]*height: 44/);
  assert.match(scanner, /landscapePreviewList:[\s\S]*landscapePreviewImage/);
  assert.match(scanner, /previewCount > 0 && !isDocumentLandscape/);
});
test('8c barre laterali hanno un margine reale dalla preview', () => {
  assert.match(scanner, /containerLandscape:[\s\S]*backgroundColor: colors\.surface/);
  assert.match(scanner, /landscapeHeaderRail:[\s\S]*marginRight: 16/);
  assert.match(scanner, /controlsDockLandscape:[\s\S]*marginLeft: 16/);
  assert.match(scanner, /confirmationActionsLandscape:[\s\S]*marginLeft: 16/);
});
test('8e multi-photo Elabora è a sinistra e fotocamera a destra; prima foto invariata', () => {
  const dockStart = scanner.indexOf('const controlsBottom');
  const live = scanner.slice(dockStart, scanner.indexOf('{pdfConsentModal}', dockStart));
  const processIdx = live.indexOf("t('processCount'");
  const cameraIdx = live.indexOf('onPress={takePicture}');
  assert.ok(processIdx > 0 && cameraIdx > 0, 'process and camera controls exist');
  assert.ok(processIdx < cameraIdx, 'Elabora must render before camera once pages exist');
  assert.match(live, /previewCount > 0 && \([\s\S]*processCount/);
  assert.match(live, /previewCount === 0|cameraReady \? t\('captureShot'\)/);
});
test('8f striscia anteprime documenti non copre la preview con banda grigia', () => {
  assert.match(scanner, /previewContainerDocument:[\s\S]*backgroundColor: 'transparent'/);
  assert.match(scanner, /documentType !== 'business_card' && styles\.previewContainerDocument/);
  assert.match(scanner, /documentType === 'business_card'[\s\S]*getBusinessCardViewportInsets/);
  assert.doesNotMatch(
    scanner.slice(scanner.indexOf('const viewportInsets'), scanner.indexOf('overlayContextRef.current')),
    /getScannerViewportInsets/,
  );
});
test('8d pulsante fotocamera portrait e rettangolare e non circolare', () => {
  assert.match(scanner, /documentShutterButton:[\s\S]*width: 72[\s\S]*height: 56/);
  const shutterStyle = scanner.slice(
    scanner.indexOf('documentShutterButton:'),
    scanner.indexOf('landscapeActionText:'),
  );
  assert.match(shutterStyle, /borderRadius: radii\.md/);
  assert.match(shutterStyle, /alignItems: 'center'[\s\S]*justifyContent: 'center'/);
  assert.doesNotMatch(shutterStyle, /borderRadius: 2[8-9]|borderRadius: 3[0-9]/);
});
test('9 preview documenti usa il layout nativo senza rettangolo sintetico', () => {
  assert.doesNotMatch(scanner, /documentPreviewLayout|previewLayout=|ratio: '4:3'/);
});
test('10 la cornice documenti aspetta il viewport realmente materializzato e resta coerente col piano OCR', () => {
  assert.match(scanner, /const requestedDocumentLandscape = displayedCaptureMode === 'landscape-left'/);
  assert.match(scanner, /const windowIsLandscape = screenW > screenH/);
  assert.match(
    scanner,
    /const documentWindowModeMaterialized =[\s\S]*requestedDocumentLandscape === windowIsLandscape/,
  );
  assert.match(
    scanner,
    /const effectiveDocumentLandscape =[\s\S]*documentWindowModeMaterialized \? requestedDocumentLandscape : windowIsLandscape/,
  );
  assert.match(
    scanner,
    /const documentViewportModeMaterialized =[\s\S]*viewportHasLayout && viewportIsLandscape === effectiveDocumentLandscape/,
  );
  assert.match(
    scanner,
    /const documentOverlayReady =[\s\S]*cameraReady && documentViewportModeMaterialized/,
  );
  assert.doesNotMatch(scanner, /setTimeout\(\(\) => setDocumentOverlayReady/);
  assert.match(
    scanner,
    /showCardOverlay \|\| \(documentType !== 'business_card' && documentViewportModeMaterialized && documentOverlayReady\)/,
  );
  assert.match(scanner, /overlayRect: ocrPlan\.debug\.overlayRect/);
});
test('11 crop sicuro alimenta la normalizzazione di lettura; altrimenti usa il full-frame', () => {
  assert.match(scanner, /const canonicalUri = oriented\.normalizedUri/);
  assert.match(scanner, /const ocrPlan = await buildScanPlan\(/);
  assert.match(scanner, /const preReadingUri = croppedUri \?\? canonicalUri/);
  assert.match(scanner, /normalizeDocumentReadingOrientation\([\s\S]*preReadingUri/);
  assert.match(scanner, /const persistedUri = readingOriented\.normalizedUri/);
  assert.match(scanner, /const ocrUri = persistedUri/);
  assert.match(scanner, /uri: persistedUri,[\s\S]*ocrUri,/);
});
test('12 originale conservato', () => assert.match(scanner, /originalUri: photo\.uri/));
test('13 crop sicuro usato per anteprima e OCR; originale full-frame in metadata', () => {
  assert.match(scanner, /uri: persistedUri,[\s\S]*ocrUri,/);
  assert.match(scanner, /assessDocumentCropSafety\(ocrPlan\)/);
  assert.match(scanner, /canonicalUri,/);
});
test('14 JPEG portrait processato non inventa un quarter-turn', () => {
  const plan = planCapturedDocumentOrientation({ width: 4000, height: 3000, deviceOrientationAtCapture: 'portrait', previewOrientation: 'portrait', platform: 'android', cameraProcessingApplied: true, rawCapturePreserved: false });
  assert.equal(plan.rotationRequired, 0);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [4000, 3000]);
});
test('15 JPEG landscape-left processato conserva gli assi CameraX', () => {
  const plan = planCapturedDocumentOrientation({ width: 3000, height: 4000, deviceOrientationAtCapture: 'landscape-left', previewOrientation: 'landscape', platform: 'android', cameraProcessingApplied: true, rawCapturePreserved: false });
  assert.equal(plan.rotationRequired, 0);
  assert.deepEqual([plan.normalizedWidth, plan.normalizedHeight], [3000, 4000]);
});
test('16 pre-landscape pianifica rotazione 0; correzione 180 avviene post-probe', () => {
  const plan = planCapturedDocumentOrientation({ width: 4000, height: 3000, deviceOrientationAtCapture: 'landscape-left', previewOrientation: 'landscape', platform: 'android', cameraProcessingApplied: true, rawCapturePreserved: false });
  assert.equal(plan.rotationRequired, 0);
});
test('17 rotazione documento solo quando il piano la richiede', () => {
  const captureAt = scanner.indexOf('const capturePhoto = useCallback');
  const documentBlock = scanner.slice(
    captureAt,
    scanner.indexOf("if (documentType === 'business_card' && businessMode === 'person')", captureAt),
  );
  assert.match(documentBlock, /normalizeCapturedDocumentOrientation\(/);
  assert.match(documentBlock, /const canonicalUri = oriented\.normalizedUri/);
  assert.doesNotMatch(documentBlock, /rotateImage\(canonicalUri, 180\)|resolveCaptureBitmap/);
});
test('18 preview minimale senza controlli rotazione', () => {
  assert.match(scanner, /pendingDocumentPhoto[\s\S]*retakePhoto[\s\S]*usePhoto/);
  assert.match(scanner, /rotatePendingDocument180/);
  assert.doesNotMatch(scanner, /rotateLeft|rotateRight/);
  assert.match(
    scanner,
    /paddingBottom:[\s\S]*Math\.max\([\s\S]*insets\.bottom,[\s\S]*Platform\.OS === 'android' \? 48/,
  );
  assert.match(scanner, /confirmationActions:[\s\S]*backgroundColor:/);
  assert.match(scanner, /confirmationActionsLandscape:[\s\S]*flexDirection: 'column'/);
});
test('18b Usa foto resta realmente e visivamente attivo quando la canonical esiste', () => {
  const confirmStart = scanner.indexOf('const confirmPendingDocument');
  const processStart = scanner.indexOf('const processDocument', confirmStart);
  const confirmBlock = scanner.slice(confirmStart, processStart);
  assert.match(confirmBlock, /if \(!pending\) return/);
  assert.doesNotMatch(confirmBlock, /scanning/);
  assert.match(scanner, /onPress=\{confirmPendingDocument\}[\s\S]*disabled=\{false\}/);
  assert.match(scanner, /confirmationPrimaryButton:[\s\S]*backgroundColor: colors\.primary/);
  const sharedLandscapeButton = scanner.slice(
    scanner.indexOf('confirmationActionButtonLandscape:'),
    scanner.indexOf('confirmationSecondaryButtonLandscape:'),
  );
  assert.doesNotMatch(sharedLandscapeButton, /backgroundColor/);
  assert.match(scanner, /confirmationActionTextLandscape:[\s\S]*\.\.\.typography\.caption/);
});
test('18c selezione orientamento resta evidente anche durante la conferma', () => {
  assert.match(
    scanner,
    /styles\.headerDocumentModeButton,[\s\S]*modeControlsDisabled && styles\.headerBtnDisabled,[\s\S]*displayedCaptureMode === mode && styles\.headerDocumentModeButtonActive/,
  );
  assert.match(
    scanner,
    /styles\.landscapeModeButton,[\s\S]*modeControlsDisabled && styles\.headerBtnDisabled,[\s\S]*displayedCaptureMode === mode && styles\.headerDocumentModeButtonActive/,
  );
});
test('19 Ripeti', () => assert.match(scanner, /retakePendingDocument[\s\S]*setPendingDocumentPhoto\(null\)/));
test('20 Usa foto', () => assert.match(scanner, /confirmPendingDocument[\s\S]*setDocumentPages/));
test('21 OCR usa il crop solo quando la geometria è sicura e poi la stessa immagine normalizzata della preview', () => {
  assert.match(scanner, /let croppedUri: string \| null = null/);
  assert.match(scanner, /if \(cropSafety\.useCropForOcr\)/);
  assert.match(scanner, /const preReadingUri = croppedUri \?\? canonicalUri/);
  assert.match(scanner, /const persistedUri = readingOriented\.normalizedUri/);
  assert.match(scanner, /const ocrUri = persistedUri/);
});
test('22 review usa immagine persistita (crop o full-frame)', () => assert.match(scanner, /uri: persistedUri/));
test('23 persistenza usa canonicalUri', () => assert.match(persistence, /canonicalUri: routed\.images\[index\]/));
test('24 export QA usa canonicalUri', () => assert.match(qa, /pageCaptureMetadata/));
test('24b miniatura e visualizzatore risolvono la stessa canonical URI', () => {
  assert.match(documentImages, /const resolved = resolveImageUri\(uri\)/);
  assert.match(documentImages, /setDisplayUri\(viewerImages\[index\]\?\.uri \?\? null\)/);
  assert.match(documentImages, /images=\{\[\{ uri: activeUri \}\]\}/);
  assert.match(documentImages, /resizeMode="contain"/);
  assert.match(documentImages, /FooterComponent=\{rotationEnabled \?/);
});
test('25 Back protetto', () => assert.match(route, /hardwareBackPress[\s\S]*requestExit/));
test('26 multipagina conserva ogni pagina confermata', () => assert.match(scanner, /setDocumentPages\(\(previous\) => \[\.\.\.previous, pending\.page\]\)/));
test('27 nessuna regressione pipeline biglietti', () => {
  assert.match(scanner, /autoOrientBusinessCardImage/);
  assert.doesNotMatch(scanner, /ensureCardReadingAspect/);
  const captureAt = scanner.indexOf('const capturePhoto = useCallback');
  const cardBlock = scanner.slice(
    scanner.indexOf("if (documentType === 'business_card' && businessMode === 'person')", captureAt),
    scanner.indexOf('} catch (error)', captureAt),
  );
  assert.doesNotMatch(cardBlock, /normalizeCapturedDocumentOrientation/);
});
test('28 QA registra EXIF e rotazioni richieste e applicate', () => {
  const contract = read('lib/document-capture-orientation.ts');
  assert.match(contract, /originalExif: input\.exifOrientation \?\? null/);
  assert.match(contract, /rotationRequested: plan\.rotationRequired/);
  assert.match(contract, /rotationApplied: plan\.rotationApplied/);
});
test('29 preview documenti dichiara soltanto il rettangolo reale della CameraView', () => {
  assert.match(scanner, /previewContentRect:[\s\S]*x: 0,[\s\S]*y: 0,[\s\S]*width: screenWUsed,[\s\S]*height: screenHUsed/);
  assert.match(scanner, /overlayRect: ocrPlan\.debug\.overlayRect/);
});
test('30 elaborazione libera sempre l overlay', () => {
  assert.match(scanner, /setIsProcessingDoc\(false\)/);
  assert.match(scanner, /runTimedOperation/);
});

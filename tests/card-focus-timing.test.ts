import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createFocusTracker,
  formatFocusLog,
  type FocusLog,
} from '../lib/camera-focus-diagnostics';
import { createFocusHold } from '../lib/camera-focus-hold';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

test('1 il punto di messa a fuoco nativo non resta sull angolo dell anteprima', () => {
  // Il sorgente di serie costruisce la factory sui pixel della PreviewView e
  // poi chiede createPoint(1f, 1f): è il pixel (1,1), non il centro.
  const patch = read('scripts/patch-expo-camera-focus.mjs');
  assert.match(patch, /createPoint\(1f, 1f\)'\s*,\s*KT_SCALED_POINT/);
  assert.match(
    patch,
    /meteringPointX \* previewView\.width\.coerceAtLeast\(1\)\.toFloat\(\)/
  );
  // La correzione del punto non deve dipendere dall'interruttore che tiene
  // spente le patch di geometria e scatto.
  assert.match(patch, /gated\(patchAndroidCaptureRotationRace\)\(patchAndroidView\(s\)\)/);
  assert.match(patch, /patchAndroidModuleEvents\(patchAndroidModule\(s\)\)/);
});

test('2 ACTIVE_SCAN nasce solo dal rilancio della misurazione', (t) => {
  // Se l'unico punto di emissione è l'inizio di startFocusMetering, un
  // ACTIVE_SCAN durante lo scatto significa che qualcuno ha cambiato le prop
  // di misurazione: è la traccia che identifica la causa.
  const native =
    'node_modules/expo-camera/android/src/main/java/expo/modules/camera/ExpoCameraView.kt';
  if (!fs.existsSync(path.join(root, native))) {
    t.skip('expo-camera non installato');
    return;
  }
  const src = read(native);
  const emissions = src.match(/putString\("state", "ACTIVE_SCAN"\)/g) ?? [];
  assert.equal(emissions.length, 1, 'ACTIVE_SCAN deve avere un solo punto di emissione');
  const before = src.slice(0, src.indexOf('putString("state", "ACTIVE_SCAN")'));
  assert.match(
    before.slice(-800),
    /private fun startFocusMetering\(\)/,
    'ACTIVE_SCAN deve nascere dentro startFocusMetering'
  );
  // E startFocusMetering viene richiamata dai setter delle coordinate.
  assert.match(src, /var meteringPointX: Float[\s\S]{0,200}startFocusMetering\(\)/);
});

test('3 il biglietto riceve il punto di misurazione del proprio riquadro', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /const cameraViewFocusProps = stabilizeFocusProps\(cameraFocusProps\)/);
  assert.doesNotMatch(scanner, /documentType === 'business_card' \? \{\} : cameraFocusProps/);
});

test('4 il biglietto non riusa un verde appartenente al ciclo precedente', () => {
  const hook = read('components/Camera/useFocusPulse.ts');
  const cardBranch = hook.slice(hook.indexOf("if (mode === 'card')"));
  assert.match(cardBranch, /setAfState\('PASSIVE_SCAN'\)[\s\S]{0,160}?gate\.invalidateFocusLock\(\)/);
  assert.match(cardBranch, /gate\.waitForFocusedLocked\(CARD_AF_LOCK_WAIT_MS\)/);
});

test('5 la finestra di stabilizzazione del biglietto resta limitata', () => {
  const hook = read('components/Camera/useFocusPulse.ts');
  const match = hook.match(/const CARD_AF_LOCK_WAIT_MS = (\d+);/);
  assert.ok(match, 'la costante di attesa deve essere esplicita');
  assert.ok(Number(match![1]) <= 700, `attesa troppo lunga: ${match![1]}ms`);
  const cardBranch = hook.slice(
    hook.indexOf("if (mode === 'card')"),
    hook.indexOf('gate.invalidateFocusLock();')
  );
  assert.doesNotMatch(cardBranch, /FAST_AF_SETTLE_MS|RETRY_AF_SETTLE_MS/);
});

test('6 i documenti conservano la preparazione allo scatto attuale', () => {
  const hook = read('components/Camera/useFocusPulse.ts');
  const documentBranch = hook.slice(hook.indexOf('gate.invalidateFocusLock();'));
  assert.match(
    documentBranch,
    /const settleMs = mode === 'fast' \? FAST_AF_SETTLE_MS : RETRY_AF_SETTLE_MS/
  );
  assert.match(documentBranch, /mode === 'fast' \? FAST_AF_LOCK_WAIT_MS : RETRY_AF_LOCK_WAIT_MS/);

  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /documentType === 'business_card' && attempt === 0\s*\?\s*'card'/);
});

test('7 il fuoco tenuto congela le prop di misurazione', () => {
  const hold = createFocusHold<{ meteringPointX: number; meteringPointY: number }>();
  const beforeCapture = { meteringPointX: 0.5, meteringPointY: 0.45 };
  assert.equal(hold.stabilize(beforeCapture), beforeCapture);

  assert.equal(hold.hold(), true);
  assert.equal(hold.hold(), false, 'un secondo blocco non deve contare');
  // Il layout cambia durante lo scatto: le nuove coordinate non devono uscire.
  const duringCapture = { meteringPointX: 0.52, meteringPointY: 0.47 };
  assert.deepEqual(hold.stabilize(duringCapture), beforeCapture);
  assert.equal(hold.isHeld(), true);

  assert.equal(hold.release(), true);
  assert.equal(hold.release(), false, 'un secondo rilascio non deve contare');
  assert.deepEqual(hold.stabilize(duringCapture), duringCapture);
});

test('8 senza istantanea il blocco lascia passare le prop correnti', () => {
  const hold = createFocusHold<{ meteringPointX: number }>();
  hold.hold();
  const props = { meteringPointX: 0.3 };
  assert.equal(hold.stabilize(props), props);
});

test('9 le richieste di rimessa a fuoco tacciono durante la cattura', () => {
  const hook = read('components/Camera/useFocusPulse.ts');
  const pulse = hook.slice(
    hook.indexOf('const triggerFocusPulse'),
    hook.indexOf('const stabilizeFocusProps')
  );
  assert.match(pulse, /if \(focusHold\.isHeld\(\)\) return;/);
});

test('10 la sequenza di scatto tiene il fuoco fino al JPEG concluso', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const order = [
    'focusTracker.markCaptureRequested()',
    'holdFocusForCapture()',
    'focusTracker.markJpegStarted()',
    'camera.takePictureAsync(',
    'focusTracker.markJpegCompleted(afLock)',
    'releaseFocusAfterCapture()',
  ];
  let cursor = -1;
  for (const step of order) {
    const at = scanner.indexOf(step, cursor + 1);
    assert.ok(at > cursor, `fuori ordine o assente: ${step}`);
    cursor = at;
  }
  // Il rilascio deve avvenire anche se lo scatto fallisce o scade.
  const finallyBlock = scanner.slice(scanner.indexOf('} finally {'));
  assert.match(finallyBlock, /releaseFocusAfterCapture\(\)/);
});

test('11 la cattura è dichiarata eseguita solo a JPEG concluso', () => {
  const entries: FocusLog[] = [];
  const tracker = createFocusTracker((entry) => entries.push(entry));
  tracker.setEnabled(true);
  tracker.markCameraReady();
  tracker.markState('FOCUSED_LOCKED');
  tracker.markCaptureRequested();
  tracker.markFocusHeld();
  tracker.markJpegStarted();
  tracker.markJpegCompleted('FOCUSED_LOCKED');
  tracker.markFocusReleased();

  assert.deepEqual(
    entries.map((e) => e.state),
    [
      'CAMERA_READY',
      'FOCUSED_LOCKED',
      'CAPTURE_REQUESTED',
      'FOCUS_HELD',
      'JPEG_CAPTURE_STARTED',
      'JPEG_CAPTURE_COMPLETED',
      'FOCUSED_LOCKED',
      'FOCUS_RELEASED',
    ]
  );
  const held = entries.find((e) => e.state === 'FOCUS_HELD')!;
  assert.equal(held.captureRequested, true);
  assert.equal(held.jpegCaptureStarted, false);
  assert.equal(held.captureExecuted, false, 'nessuna cattura eseguita prima del JPEG');
  const started = entries.find((e) => e.state === 'JPEG_CAPTURE_STARTED')!;
  assert.equal(started.captureExecuted, false);
  const released = entries.find((e) => e.state === 'FOCUS_RELEASED')!;
  assert.equal(released.jpegCaptureCompleted, true);
  assert.equal(released.captureExecuted, true);

  // Nessuna nuova ricerca fra il blocco e la fine della cattura.
  const holdStart = entries.findIndex((e) => e.state === 'FOCUS_HELD');
  const jpegEnd = entries.findIndex((e) => e.state === 'JPEG_CAPTURE_COMPLETED');
  const inside = entries.slice(holdStart, jpegEnd).map((e) => e.state);
  assert.ok(!inside.includes('ACTIVE_SCAN'), 'ACTIVE_SCAN dentro la finestra di blocco');
});

test('12 una vecchia patch non può rilanciare AF dentro takePicture', () => {
  const patch = read('scripts/patch-expo-camera-focus.mjs');
  assert.match(patch, /function removeLegacyAndroidFocusBeforeCapture/);
  assert.match(patch, /removeLegacyAndroidFocusBeforeCapture\(patchAndroidCameraZoomStateEvents/);
  assert.match(patch, /fino a 4s/);
});

test('13 il verde AF ha una scadenza visiva esplicita', () => {
  const hook = read('components/Camera/useFocusPulse.ts');
  assert.match(hook, /const AF_GREEN_FRESHNESS_MS = 1500/);
  assert.match(hook, /state === 'FOCUSED_LOCKED'[\s\S]{0,220}?setAfState\('PASSIVE_SCAN'\)/);
});

test('12 il registro contiene solo stati e tempi', () => {
  const entries: FocusLog[] = [];
  const tracker = createFocusTracker((entry) => entries.push(entry));
  tracker.setEnabled(true);
  tracker.markCameraReady();
  const line = formatFocusLog('DocumentFocus', entries[0]);
  assert.match(line, /^\[DocumentFocus\] \{/);
  assert.deepEqual(Object.keys(JSON.parse(line.replace('[DocumentFocus] ', ''))).sort(), [
    'captureExecuted',
    'captureRequested',
    'jpegCaptureCompleted',
    'jpegCaptureStarted',
    'state',
    'timeSinceCameraReady',
    'timeSinceLastFocusChange',
    'timestamp',
  ]);
  assert.equal(entries[0].timeSinceCameraReady, 0);
  assert.equal(entries[0].timeSinceLastFocusChange, null);
});

test('13 il registro tace finché la modalità non è attiva', () => {
  const entries: FocusLog[] = [];
  const tracker = createFocusTracker((entry) => entries.push(entry));
  tracker.markCameraReady();
  tracker.markState('ACTIVE_SCAN');
  assert.equal(entries.length, 0);
});

test('14 biglietto e documenti hanno canali diagnostici separati', () => {
  const diagnostics = read('lib/camera-focus-diagnostics.ts');
  assert.match(diagnostics, /export const cardFocusTracker = createFocusTracker\(emitter\('CardFocus'\)\)/);
  assert.match(
    diagnostics,
    /export const documentFocusTracker = createFocusTracker\(emitter\('DocumentFocus'\)\)/
  );

  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(
    scanner,
    /documentType === 'business_card' \? cardFocusTracker : documentFocusTracker/
  );
  // Il livello condiviso riguarda solo il ciclo di vita del fuoco: ritaglio,
  // orientamento e semantica delle due modalità restano separati.
  const hold = read('lib/camera-focus-hold.ts');
  assert.doesNotMatch(hold, /crop|orientation|parser|documentType/i);
});

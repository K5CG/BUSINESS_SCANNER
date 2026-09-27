// Patch expo-camera (v3) — messa a fuoco reale sul centro del riquadro overlay.
//
// COSA CORREGGE la v3 rispetto alla patch attualmente nel progetto:
// - ANDROID: DisplayOrientedMeteringPointFactory è costruita con
//   previewView.width/height, quindi createPoint(x, y) vuole coordinate in
//   PIXEL della view, NON normalizzate 0–1. Passare 0.5/0.45 significava
//   mettere a fuoco il pixel (0.5, 0.45) = angolo alto-sinistra dello schermo.
//   Ora il punto viene scalato: nx * width, ny * height.
// - iOS: impostare focusPointOfInterest da solo NON attiva la rimessa a fuoco;
//   il punto viene applicato solo quando subito dopo si (ri)imposta focusMode.
//   Ora dopo il cambio di POI viene forzato .autoFocus (o .continuousAutoFocus),
//   e dopo il punto di esposizione .continuousAutoExposure.
// COSA CONSERVA: FLAG_AF|AE|AWB, autoCancelDuration 8s, white balance iOS.
//
// Lo script riconosce e AGGIORNA in-place una patch precedente già applicata,
// ma dopo un aggiornamento di expo-camera conviene ripartire puliti:
//   rimuovi node_modules/expo-camera, npm install (postinstall riapplica).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', 'node_modules', 'expo-camera');

// Fino a SDK 54 expo-camera veniva consumato come AAR prebuilt: tutte le
// modifiche qui sotto restavano inerti e la camera in esecuzione era quella di
// serie. Ora che il modulo viene compilato dai sorgenti vanno distinte due
// famiglie.
//
// Geometria e scatto (ViewPort, targetRotation, capture mode, durata del blocco
// AF/AE/AWB) cambiano inquadratura, rotazione ed esposizione: la camera
// documenti è tarata sul comportamento di serie, quindi restano disattivate.
//
// Il punto di messa a fuoco invece è un difetto conclamato del sorgente di
// serie: `createPoint(1f, 1f)` con una factory costruita sui pixel della
// PreviewView mette a fuoco il pixel (1,1), cioè l'angolo in alto a sinistra
// dell'anteprima, mai il soggetto. Quella correzione viene compilata: non
// tocca né inquadratura né rotazione, sposta solo dove la camera mette a fuoco.
const APPLY_CAPTURE_BEHAVIOR_PATCHES = process.env.EXPO_CAMERA_CAPTURE_PATCHES === '1';

/** Applica il mutator solo se le patch di geometria/scatto sono abilitate. */
const gated = (mutator) => (src) => (APPLY_CAPTURE_BEHAVIOR_PATCHES ? mutator(src) : src);

function patchFile(relPath, mutator, label) {
  const file = join(root, relPath);
  if (!existsSync(file)) {
    console.warn(`[patch-expo-camera-focus] ${label}: file non trovato, salto.`);
    return false;
  }
  const before = readFileSync(file, 'utf8');
  const after = mutator(before);
  if (after === before) return false;
  writeFileSync(file, after);
  console.log(`[patch-expo-camera-focus] ${label}: applicata/aggiornata.`);
  return true;
}

// ---------------------------------------------------------------------------
// ANDROID — ExpoCameraView.kt
// ---------------------------------------------------------------------------

// Punto AF in PIXEL della PreviewView (coerente con la factory).
const KT_SCALED_POINT =
  'meteringPointFactory.createPoint(meteringPointX * previewView.width.coerceAtLeast(1).toFloat(), meteringPointY * previewView.height.coerceAtLeast(1).toFloat())';

function patchAndroidView(src) {
  let next = src;

  // UPGRADE da patch precedente: coordinate normalizzate non scalate → bug angolo.
  next = next.replaceAll(
    'meteringPointFactory.createPoint(meteringPointX, meteringPointY)',
    KT_SCALED_POINT
  );

  // Stock expo-camera SDK 54: punto AF hardcoded.
  next = next.replaceAll('meteringPointFactory.createPoint(1f, 1f)', KT_SCALED_POINT);
  next = next.replaceAll('meteringPointFactory.createPoint(0.5f, 0.5f)', KT_SCALED_POINT);

  // Proprietà meteringPointX/Y: aggiungi solo se non già presenti.
  if (!next.includes('var meteringPointX: Float')) {
    const anchor = `  var zoom: Float = 0f
    set(value) {
      field = value
      setCameraZoom(value)
    }

  var autoFocus: FocusMode = FocusMode.OFF`;

    const replacement = `  var zoom: Float = 0f
    set(value) {
      field = value
      setCameraZoom(value)
    }

  var meteringPointX: Float = 0.5f
    set(value) {
      field = value.coerceIn(0f, 1f)
      if (autoFocus == FocusMode.ON) {
        startFocusMetering()
      }
    }

  var meteringPointY: Float = 0.5f
    set(value) {
      field = value.coerceIn(0f, 1f)
      if (autoFocus == FocusMode.ON) {
        startFocusMetering()
      }
    }

  var autoFocus: FocusMode = FocusMode.OFF`;

    if (!next.includes(anchor)) return src;
    next = next.replace(anchor, replacement);
  }

  return next;
}

// CameraX orientation race: l'OrientationEventListener puo ricevere la
// rotazione prima che ImageCapture sia stato creato. Expo stock in quel caso
// scarta il valore (imageCaptureUseCase e null) e il primo scatto usa una
// targetRotation predefinita, producendo JPEG casualmente a 90/180 gradi.
// Conserviamo sempre l'ultimo valore e lo applichiamo anche al builder.
function patchAndroidCaptureRotationRace(src) {
  let next = src;

  if (!next.includes('private var latestDeviceRotation: Int? = null')) {
    const activityAnchor = `  private val currentActivity
    get() = appContext.throwingActivity as AppCompatActivity

  private val orientationEventListener by lazy {`;
    const activityReplacement = `  private val currentActivity
    get() = appContext.throwingActivity as AppCompatActivity

  private var latestDeviceRotation: Int? = null

  private val orientationEventListener by lazy {`;
    if (!next.includes(activityAnchor)) return src;
    next = next.replace(activityAnchor, activityReplacement);
  }

  if (!next.includes('val captureRotation = previewView.display?.rotation ?: rotation')) {
    const listenerAnchor = `        imageAnalysisUseCase?.targetRotation = rotation
        imageCaptureUseCase?.targetRotation = rotation`;
    const previousPatchAnchor = `        latestDeviceRotation = rotation
        imageAnalysisUseCase?.targetRotation = rotation
        imageCaptureUseCase?.targetRotation = rotation`;
    const listenerReplacement = `        val captureRotation = previewView.display?.rotation ?: rotation
        latestDeviceRotation = captureRotation
        imageAnalysisUseCase?.targetRotation = captureRotation
        imageCaptureUseCase?.targetRotation = captureRotation`;
    if (next.includes(previousPatchAnchor)) {
      next = next.replace(previousPatchAnchor, listenerReplacement);
    } else if (next.includes(listenerAnchor)) {
      next = next.replace(listenerAnchor, listenerReplacement);
    } else {
      return src;
    }
  }

  if (!next.includes('.setTargetRotation(latestDeviceRotation ?: previewView.display?.rotation ?: Surface.ROTATION_0)')) {
    const captureAnchor = `    imageCaptureUseCase = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector)
      .setFlashMode(flashMode.mapToLens())
      .build()`;
    const captureReplacement = `    imageCaptureUseCase = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector)
      .setFlashMode(flashMode.mapToLens())
      .setTargetRotation(latestDeviceRotation ?: previewView.display?.rotation ?: Surface.ROTATION_0)
      .build()`;
    if (!next.includes(captureAnchor)) return src;
    next = next.replace(captureAnchor, captureReplacement);
  }

  return next;
}

// startFocusMetering potenziato: cancel + AF|AE|AWB + auto-cancel 8 s
// (identico a quello già in uso nel progetto, ma con il punto SCALATO).
function patchAndroidFocusMetering(src) {
  const stockBlock = `  private fun startFocusMetering() {
    camera?.let {
      val meteringPointFactory = DisplayOrientedMeteringPointFactory(
        previewView.display,
        it.cameraInfo,
        previewView.width.toFloat(),
        previewView.height.toFloat()
      )
      val action = FocusMeteringAction.Builder(
        ${KT_SCALED_POINT},
        FocusMeteringAction.FLAG_AF
      )
        .build()
      it.cameraControl.startFocusAndMetering(action)
    }
  }`;

  const enhancedBlock = `  private fun startFocusMetering() {
    camera?.let {
      it.cameraControl.cancelFocusAndMetering()
      val meteringPointFactory = DisplayOrientedMeteringPointFactory(
        previewView.display,
        it.cameraInfo,
        previewView.width.toFloat(),
        previewView.height.toFloat()
      )
      val meteringFlags =
        FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE or FocusMeteringAction.FLAG_AWB
      val action = FocusMeteringAction.Builder(
        ${KT_SCALED_POINT},
        meteringFlags
      )
        .setAutoCancelDuration(8, java.util.concurrent.TimeUnit.SECONDS)
        .build()
      it.cameraControl.startFocusAndMetering(action)
    }
  }`;

  if (src.includes(enhancedBlock)) return src;
  if (src.includes(stockBlock)) return src.replace(stockBlock, enhancedBlock);
  return src; // già potenziato da run precedente (il punto è stato scalato da patchAndroidView)
}

function patchAndroidModule(src) {
  if (src.includes('Prop("meteringPointX")')) return src;
  const anchor = `      Prop("autoFocus") { view, autoFocus: FocusMode? ->
        autoFocus?.let {
          if (view.autoFocus != it) {
            view.autoFocus = it
          }
        } ?: run {
          if (view.autoFocus != FocusMode.OFF) {
            view.autoFocus = FocusMode.OFF
          }
        }
      }

      Prop("ratio")`;

  const replacement = `      Prop("autoFocus") { view, autoFocus: FocusMode? ->
        autoFocus?.let {
          if (view.autoFocus != it) {
            view.autoFocus = it
          }
        } ?: run {
          if (view.autoFocus != FocusMode.OFF) {
            view.autoFocus = FocusMode.OFF
          }
        }
      }

      Prop("meteringPointX") { view, x: Float? ->
        x?.let { view.meteringPointX = it }
      }

      Prop("meteringPointY") { view, y: Float? ->
        y?.let { view.meteringPointY = it }
      }

      Prop("ratio")`;

  if (!src.includes(anchor)) return src;
  return src.replace(anchor, replacement);
}

// ---------------------------------------------------------------------------
// iOS — CameraView.swift / CameraSessionManager.swift / CameraViewModule.swift
// ---------------------------------------------------------------------------

function patchIosView(src) {
  if (src.includes('var focusPointX: CGFloat')) return src;
  const anchor = `  var autoFocus = AVCaptureDevice.FocusMode.continuousAutoFocus {
    didSet {
      sessionManager.setFocusMode()
    }
  }

  var pictureSize = PictureSize.high {`;

  const replacement = `  var autoFocus = AVCaptureDevice.FocusMode.continuousAutoFocus {
    didSet {
      sessionManager.setFocusMode()
    }
  }

  var focusPointX: CGFloat = 0.5 {
    didSet {
      sessionManager.setFocusMode()
    }
  }

  var focusPointY: CGFloat = 0.5 {
    didSet {
      sessionManager.setFocusMode()
    }
  }

  var pictureSize = PictureSize.high {`;

  if (!src.includes(anchor)) return src;
  return src.replace(anchor, replacement);
}

// Blocco della patch PRECEDENTE (POI impostato ma refocus mai attivato).
const IOS_PREV_BLOCK = `      let focusPoint = CGPoint(x: delegate.focusPointX, y: delegate.focusPointY)
      if device.isFocusPointOfInterestSupported, device.focusPointOfInterest != focusPoint {
        device.focusPointOfInterest = focusPoint
      }
      if device.isExposurePointOfInterestSupported, device.exposurePointOfInterest != focusPoint {
        device.exposurePointOfInterest = focusPoint
      }
      if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance),
        device.whiteBalanceMode != .continuousAutoWhiteBalance {
        device.whiteBalanceMode = .continuousAutoWhiteBalance
      }`;

// Blocco v3: dopo il cambio di POI si forza focusMode → refocus REALE sul punto.
const IOS_V3_BLOCK = `      let focusPoint = CGPoint(x: delegate.focusPointX, y: delegate.focusPointY)
      if device.isFocusPointOfInterestSupported, device.focusPointOfInterest != focusPoint {
        device.focusPointOfInterest = focusPoint
        if device.isFocusModeSupported(.autoFocus) {
          device.focusMode = .autoFocus
        } else if device.isFocusModeSupported(.continuousAutoFocus) {
          device.focusMode = .continuousAutoFocus
        }
      }
      if device.isExposurePointOfInterestSupported, device.exposurePointOfInterest != focusPoint {
        device.exposurePointOfInterest = focusPoint
        if device.isExposureModeSupported(.continuousAutoExposure) {
          device.exposureMode = .continuousAutoExposure
        }
      }
      if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance),
        device.whiteBalanceMode != .continuousAutoWhiteBalance {
        device.whiteBalanceMode = .continuousAutoWhiteBalance
      }`;

function patchIosSessionManager(src) {
  let next = src;

  if (!next.includes('var focusPointX: CGFloat { get }')) {
    const anchor = `  var autoFocus: AVCaptureDevice.FocusMode { get }
  var zoom: CGFloat { get }`;
    const replacement = `  var autoFocus: AVCaptureDevice.FocusMode { get }
  var focusPointX: CGFloat { get }
  var focusPointY: CGFloat { get }
  var zoom: CGFloat { get }`;
    if (!next.includes(anchor)) return src;
    next = next.replace(anchor, replacement);
  }

  if (next.includes(IOS_V3_BLOCK)) return next;
  // UPGRADE dalla patch precedente
  if (next.includes(IOS_PREV_BLOCK)) return next.replace(IOS_PREV_BLOCK, IOS_V3_BLOCK);

  const anchor = `      if device.isFocusModeSupported(delegate.autoFocus), device.focusMode != delegate.autoFocus {
        device.focusMode = delegate.autoFocus
      }`;
  const replacement = `      if device.isFocusModeSupported(delegate.autoFocus), device.focusMode != delegate.autoFocus {
        device.focusMode = delegate.autoFocus
      }
${IOS_V3_BLOCK}`;

  if (!next.includes(anchor)) return src;
  return next.replace(anchor, replacement);
}

function patchIosModule(src) {
  if (src.includes('Prop("focusPointX")')) return src;
  const anchor = `      Prop("autoFocus") { (view, focusMode: FocusMode?) in
        if let focusMode, view.autoFocus != focusMode.toAVCaptureFocusMode() {
          view.autoFocus = focusMode.toAVCaptureFocusMode()
          return
        }
        if focusMode == nil && view.autoFocus != .continuousAutoFocus {
          view.autoFocus = .continuousAutoFocus
        }
      }

      Prop("responsiveOrientationWhenOrientationLocked")`;

  const replacement = `      Prop("autoFocus") { (view, focusMode: FocusMode?) in
        if let focusMode, view.autoFocus != focusMode.toAVCaptureFocusMode() {
          view.autoFocus = focusMode.toAVCaptureFocusMode()
          return
        }
        if focusMode == nil && view.autoFocus != .continuousAutoFocus {
          view.autoFocus = .continuousAutoFocus
        }
      }

      Prop("focusPointX") { (view, x: Double?) in
        if let x {
          view.focusPointX = CGFloat(x)
        }
      }

      Prop("focusPointY") { (view, y: Double?) in
        if let y {
          view.focusPointY = CGFloat(y)
        }
      }

      Prop("responsiveOrientationWhenOrientationLocked")`;

  if (!src.includes(anchor)) return src;
  return src.replace(anchor, replacement);
}

// ---------------------------------------------------------------------------
// v5 — OFF non cancella AF; spread rilancia focus; AF all'apertura camera
// ---------------------------------------------------------------------------

function patchAndroidAfOffNoCancel(src) {
  const bad = `      camera?.cameraControl?.let {
        if (field == FocusMode.OFF) {
          it.cancelFocusAndMetering()
        } else {
          startFocusMetering()
        }
      }`;
  const good = `      if (field == FocusMode.ON) {
        camera?.cameraControl?.let { startFocusMetering() }
      }`;
  if (src.includes('if (field == FocusMode.ON) {\n        camera?.cameraControl?.let { startFocusMetering() }')) {
    return src;
  }
  if (src.includes(bad)) return src.replace(bad, good);
  return src;
}

function patchAndroidSpreadSetters(src) {
  const stock = `  var meteringSpreadX: Float = 0.2f
  var meteringSpreadY: Float = 0.12f`;
  const patched = `  var meteringSpreadX: Float = 0.2f
    set(value) {
      field = value.coerceIn(0.05f, 0.48f)
      if (autoFocus == FocusMode.ON) {
        startFocusMetering()
      }
    }
  var meteringSpreadY: Float = 0.12f
    set(value) {
      field = value.coerceIn(0.05f, 0.48f)
      if (autoFocus == FocusMode.ON) {
        startFocusMetering()
      }
    }`;
  if (src.includes('var meteringSpreadY: Float = 0.12f\n    set(value)')) return src;
  if (src.includes(stock)) return src.replace(stock, patched);
  return src;
}

function patchAndroidFocusOnOpen(src) {
  const needle = `          onCameraReady(Unit)
          setTorchEnabled(enableTorch)`;
  const replacement = `          onCameraReady(Unit)
          if (autoFocus == FocusMode.ON) {
            startFocusMetering()
          }
          setTorchEnabled(enableTorch)`;
  if (src.includes('if (autoFocus == FocusMode.ON) {\n            startFocusMetering()\n          }\n          setTorchEnabled')) {
    return src;
  }
  if (!src.includes(needle)) return src;
  return src.replace(needle, replacement);
}

// ---------------------------------------------------------------------------
// v4 — CAPTURE_MODE_MAXIMIZE_QUALITY, eventi AF, diagnostica risoluzioni
// ---------------------------------------------------------------------------

function patchAndroidCaptureQuality(src) {
  if (src.includes('CAPTURE_MODE_MAXIMIZE_QUALITY')) return src;

  const broken = `    val captureResolutionSelector = ResolutionSelector.Builder()
      .setResolutionStrategy(ResolutionStrategy.HIGHEST_AVAILABLE_STRATEGY)
      .build()
    imageCaptureUseCase = ImageCapture.Builder()
      .setResolutionSelector(captureResolutionSelector)
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setFlashMode(flashMode.mapToLens())
      .build()`;
  const fixed = `    imageCaptureUseCase = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector)
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setFlashMode(flashMode.mapToLens())
      .build()`;
  if (src.includes('captureResolutionSelector')) {
    return src.replace(broken, fixed);
  }

  const builders = [
    {
      needle: `    imageCaptureUseCase = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector)
      .setFlashMode(flashMode.mapToLens())
      .setTargetRotation(latestDeviceRotation ?: previewView.display?.rotation ?: Surface.ROTATION_0)
      .build()`,
      replacement: `    imageCaptureUseCase = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector)
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setFlashMode(flashMode.mapToLens())
      .setTargetRotation(latestDeviceRotation ?: previewView.display?.rotation ?: Surface.ROTATION_0)
      .build()`,
    },
    {
      needle: `    imageCaptureUseCase = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector)
      .setFlashMode(flashMode.mapToLens())
      .build()`,
      replacement: `    imageCaptureUseCase = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector)
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setFlashMode(flashMode.mapToLens())
      .build()`,
    },
  ];

  for (const { needle, replacement } of builders) {
    if (src.includes(needle)) return src.replace(needle, replacement);
  }

  return src;
}

function patchAndroidNoCancelAf(src) {
  if (src.includes('// patch: no cancel AF')) return src;
  return src.replace(
    '      it.cameraControl.cancelFocusAndMetering()\n      val pw = previewView.width.coerceAtLeast(1).toFloat()',
    '      // patch: no cancel AF — cancelFocusAndMetering lasciava la camera senza fuoco\n      val pw = previewView.width.coerceAtLeast(1).toFloat()'
  );
}

/** AF nativo obbligatorio prima dello scatto — non dipende da timer JS. */
function patchAndroidFocusBeforeCapture(src) {
  if (src.includes('private fun performTakePicture')) return src;

  const takePictureStart = `  fun takePicture(options: PictureOptions, promise: Promise, cacheDirectory: File, runtimeContext: RuntimeContext) {
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val volume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
    val hasShutterSound = options.shutterSound

    imageCaptureUseCase?.takePicture(`;

  const wrapped = `  private fun performTakePicture(
    options: PictureOptions,
    promise: Promise,
    cacheDirectory: File,
    runtimeContext: RuntimeContext
  ) {
    val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val volume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC)
    val hasShutterSound = options.shutterSound

    imageCaptureUseCase?.takePicture(`;

  if (!src.includes(takePictureStart)) return src;
  let next = src.replace(takePictureStart, wrapped);

  const takePictureFnEnd = `      }
    )
  }

  fun setCameraFlashMode(mode: FlashMode) {`;
  const takePictureFnEndReplacement = `      }
    )
  }

  private fun runAutofocusBeforeCapture(onReady: () -> Unit) {
    val cam = camera
    val action = buildFocusMeteringAction()
    if (cam == null || action == null || autoFocus != FocusMode.ON) {
      onReady()
      return
    }
    onAutofocusStateChanged(android.os.Bundle().apply {
      putString("state", "ACTIVE_SCAN")
      putInt("previewWidth", previewView.width)
      putInt("previewHeight", previewView.height)
    })
    var fired = false
    val shoot = {
      if (!fired) {
        fired = true
        onReady()
      }
    }
    previewView.postDelayed({ shoot() }, 4000L)
    val focusFuture = cam.cameraControl.startFocusAndMetering(action)
    focusFuture.addListener({
      try {
        val result = focusFuture.get()
        val state = if (result.isFocusSuccessful) "FOCUSED_LOCKED" else "NOT_FOCUSED_LOCKED"
        onAutofocusStateChanged(android.os.Bundle().apply {
          putString("state", state)
          putBoolean("focusSuccessful", result.isFocusSuccessful)
        })
      } catch (_: Exception) {
        onAutofocusStateChanged(android.os.Bundle().apply {
          putString("state", "NOT_FOCUSED_LOCKED")
          putBoolean("focusSuccessful", false)
        })
      }
      previewView.postDelayed({ shoot() }, 500L)
    }, ContextCompat.getMainExecutor(context))
  }

  private fun buildFocusMeteringAction(): FocusMeteringAction? {
    val cam = camera ?: return null
    val pw = previewView.width.coerceAtLeast(1).toFloat()
    val ph = previewView.height.coerceAtLeast(1).toFloat()
    if (pw <= 0f || ph <= 0f) return null
    val meteringPointFactory = DisplayOrientedMeteringPointFactory(
      previewView.display,
      cam.cameraInfo,
      pw,
      ph
    )
    val cx = meteringPointX * pw
    val cy = meteringPointY * ph
    val meteringFlags =
      FocusMeteringAction.FLAG_AF or FocusMeteringAction.FLAG_AE or FocusMeteringAction.FLAG_AWB
    val pt = meteringPointFactory.createPoint(cx.coerceIn(0f, pw - 1f), cy.coerceIn(0f, ph - 1f))
    return FocusMeteringAction.Builder(pt, meteringFlags)
      .setAutoCancelDuration(10, java.util.concurrent.TimeUnit.SECONDS)
      .build()
  }

  fun takePicture(options: PictureOptions, promise: Promise, cacheDirectory: File, runtimeContext: RuntimeContext) {
    runAutofocusBeforeCapture {
      performTakePicture(options, promise, cacheDirectory, runtimeContext)
    }
  }

  fun setCameraFlashMode(mode: FlashMode) {`;

  if (!next.includes('private fun performTakePicture')) return src;
  if (next.includes('runAutofocusBeforeCapture')) return next;
  return next.replace(takePictureFnEnd, takePictureFnEndReplacement);
}

/**
 * Migrazione V32: vecchie installazioni possono avere ancora la patch che
 * rilanciava un SECONDO autofocus dentro takePicture. Con le patch capture
 * disabilitate non basta smettere di applicarla: va rimossa da node_modules,
 * altrimenti puo' emettere un verde dopo l'inizio JPEG e aggiungere fino a 4s.
 */
function removeLegacyAndroidFocusBeforeCapture(src) {
  if (APPLY_CAPTURE_BEHAVIOR_PATCHES || !src.includes('private fun runAutofocusBeforeCapture')) {
    return src;
  }
  let next = src.replace(
    /  private fun performTakePicture\(\s*options: PictureOptions,\s*promise: Promise,\s*cacheDirectory: File,\s*runtimeContext: RuntimeContext\s*\) \{/,
    '  fun takePicture(options: PictureOptions, promise: Promise, cacheDirectory: File, runtimeContext: RuntimeContext) {'
  );
  next = next.replace(
    /\n  private fun runAutofocusBeforeCapture\(onReady: \(\) -> Unit\) \{[\s\S]*?\n  fun setCameraFlashMode\(mode: FlashMode\) \{/,
    '\n\n  fun setCameraFlashMode(mode: FlashMode) {'
  );
  return next;
}

/** Preview e capture stesso ViewPort 3:4 — il riquadro verde = il JPEG. */
function patchAndroidViewPortSync(src) {
  let next = src;
  if (!next.includes('import androidx.camera.core.ViewPort')) {
    next = next.replace(
      'import androidx.camera.core.UseCaseGroup',
      'import androidx.camera.core.UseCaseGroup\nimport androidx.camera.core.ViewPort\nimport android.util.Rational'
    );
  }

  const useCaseStock = `    val useCases = UseCaseGroup.Builder().apply {
      addUseCase(preview)
      if (cameraMode == CameraMode.PICTURE) {
        imageCaptureUseCase?.let {
          addUseCase(it)
        }
        imageAnalysisUseCase?.let {
          addUseCase(it)
        }
      } else {
        addUseCase(videoCapture)
      }
    }.build()`;

  const useCasePatched = `    val displayRotation = previewView.display?.rotation ?: Surface.ROTATION_0
    val viewPort = ViewPort.Builder(Rational(3, 4), displayRotation)
      .setScaleType(ViewPort.FILL_CENTER)
      .build()
    val useCases = UseCaseGroup.Builder().apply {
      setViewPort(viewPort)
      addUseCase(preview)
      if (cameraMode == CameraMode.PICTURE) {
        imageCaptureUseCase?.let {
          addUseCase(it)
        }
      } else {
        addUseCase(videoCapture)
      }
    }.build()`;

  if (next.includes('setViewPort(viewPort)')) return next;
  if (!next.includes(useCaseStock)) return src;
  return next.replace(useCaseStock, useCasePatched);
}

function patchAndroidPreviewUseCaseRef(src) {
  let next = src;
  if (!next.includes('private var previewUseCase: Preview?')) {
    next = next.replace(
      'private var imageCaptureUseCase: ImageCapture? = null\n  private var imageAnalysisUseCase: ImageAnalysis? = null',
      'private var imageCaptureUseCase: ImageCapture? = null\n  private var previewUseCase: Preview? = null\n  private var imageAnalysisUseCase: ImageAnalysis? = null'
    );
  }
  if (!next.includes('previewUseCase = it')) {
    next = next.replace(
      `      .also {
        it.surfaceProvider = previewView.surfaceProvider
      }`,
      `      .also {
        it.surfaceProvider = previewView.surfaceProvider
        previewUseCase = it
      }`
    );
  }
  return next;
}

function patchAndroidAfEvents(src) {
  let next = src;
  if (!next.includes('private val onAutofocusStateChanged')) {
    const anchor = `  private val onPictureSaved by EventDispatcher<PictureSavedEvent>(
    coalescingKey = { event ->
      val uriHash = event.data.getString("uri")?.hashCode() ?: -1
      (uriHash % Short.MAX_VALUE).toShort()
    }
  )`;
    const replacement = `  private val onAutofocusStateChanged by EventDispatcher<android.os.Bundle>()

  private val onPictureSaved by EventDispatcher<PictureSavedEvent>(
    coalescingKey = { event ->
      val uriHash = event.data.getString("uri")?.hashCode() ?: -1
      (uriHash % Short.MAX_VALUE).toShort()
    }
  )`;
    if (!next.includes(anchor)) return src;
    next = next.replace(anchor, replacement);
  }

  const afStart = `      it.cameraControl.startFocusAndMetering(action)`;
  const afEnhanced = `      onAutofocusStateChanged(android.os.Bundle().apply {
        putString("state", "ACTIVE_SCAN")
        putInt("previewWidth", previewView.width)
        putInt("previewHeight", previewView.height)
      })
      val focusFuture = it.cameraControl.startFocusAndMetering(action)
      focusFuture.addListener({
        try {
          val result = focusFuture.get()
          val state = if (result.isFocusSuccessful) "FOCUSED_LOCKED" else "NOT_FOCUSED_LOCKED"
          onAutofocusStateChanged(android.os.Bundle().apply {
            putString("state", state)
            putBoolean("focusSuccessful", result.isFocusSuccessful)
          })
        } catch (_: Exception) {
          onAutofocusStateChanged(android.os.Bundle().apply {
            putString("state", "NOT_FOCUSED_LOCKED")
            putBoolean("focusSuccessful", false)
          })
        }
      }, ContextCompat.getMainExecutor(context))`;

  // Gli stati AF sono l'unico modo che il lato JS ha per sapere se la messa a
  // fuoco è conclusa prima dello scatto: la chiamata resta identica, si
  // aggiunge solo l'ascolto del risultato.
  if (!next.includes('val focusFuture = it.cameraControl.startFocusAndMetering(action)')) {
    if (!next.includes(afStart)) return src;
    next = next.replace(afStart, afEnhanced);
  }

  // Le versioni recenti di expo-camera non emettono alcun evento all'apertura
  // della camera: senza questo blocco il lato JS non conosce le dimensioni
  // reali degli stream e la mappatura cornice→pixel resta indimostrabile.
  // I passi successivi si limitano ad arricchire un evento già esistente,
  // quindi qui va creato sull'ancora realmente presente nel sorgente.
  if (!next.includes('putString("state", "CAMERA_OPEN")')) {
    const stateAnchor = `        CameraState.Type.OPEN -> {
          onCameraReady(Unit)
          if (autoFocus == FocusMode.ON) {
            startFocusMetering()
          }
          setTorchEnabled(enableTorch)
        }`;
    const stateReplacement = `        CameraState.Type.OPEN -> {
          onCameraReady(Unit)
          if (autoFocus == FocusMode.ON) {
            startFocusMetering()
          }
          setTorchEnabled(enableTorch)
          val sizes = getAvailablePictureSizes()
          val previewStream = previewUseCase?.resolutionInfo?.resolution?.toString()
          val captureBound = imageCaptureUseCase?.resolutionInfo?.resolution?.toString()
          onAutofocusStateChanged(android.os.Bundle().apply {
            putString("state", "CAMERA_OPEN")
            putInt("previewWidth", previewView.width)
            putInt("previewHeight", previewView.height)
            putString("previewStreamSize", previewStream ?: "unknown")
            putString("imageCaptureSize", captureBound ?: "unknown")
            putString("captureSizes", sizes.take(8).joinToString(","))
          })
        }`;
    if (next.includes(stateAnchor)) next = next.replace(stateAnchor, stateReplacement);
  }

  if (!next.includes('onCameraDiagnostics')) {
    const openAnchor = `        CameraState.Type.OPEN -> {
          onCameraReady(Unit)
          setTorchEnabled(enableTorch)
          val sizes = getAvailablePictureSizes()
          onAutofocusStateChanged(android.os.Bundle().apply {
            putString("state", "CAMERA_OPEN")
            putInt("previewWidth", previewView.width)
            putInt("previewHeight", previewView.height)
            putString("captureSizes", sizes.take(8).joinToString(","))
          })
        }`;
    const openReplacement = `        CameraState.Type.OPEN -> {
          onCameraReady(Unit)
          setTorchEnabled(enableTorch)
          val sizes = getAvailablePictureSizes()
          val previewStream = previewUseCase?.resolutionInfo?.resolution?.toString()
          val captureBound = imageCaptureUseCase?.resolutionInfo?.resolution?.toString()
          onAutofocusStateChanged(android.os.Bundle().apply {
            putString("state", "CAMERA_OPEN")
            putInt("previewWidth", previewView.width)
            putInt("previewHeight", previewView.height)
            putString("previewStreamSize", previewStream ?: "unknown")
            putString("imageCaptureSize", captureBound ?: "unknown")
            putString("captureSizes", sizes.take(8).joinToString(","))
          })
        }`;
    if (next.includes(openAnchor)) next = next.replace(openAnchor, openReplacement);
    else if (next.includes('putString("state", "CAMERA_OPEN")') && !next.includes('previewStreamSize')) {
      next = next.replace(
        `          val sizes = getAvailablePictureSizes()
          onAutofocusStateChanged(android.os.Bundle().apply {
            putString("state", "CAMERA_OPEN")
            putInt("previewWidth", previewView.width)
            putInt("previewHeight", previewView.height)
            putString("captureSizes", sizes.take(8).joinToString(","))
          })`,
        `          val sizes = getAvailablePictureSizes()
          val previewStream = previewUseCase?.resolutionInfo?.resolution?.toString()
          val captureBound = imageCaptureUseCase?.resolutionInfo?.resolution?.toString()
          onAutofocusStateChanged(android.os.Bundle().apply {
            putString("state", "CAMERA_OPEN")
            putInt("previewWidth", previewView.width)
            putInt("previewHeight", previewView.height)
            putString("previewStreamSize", previewStream ?: "unknown")
            putString("imageCaptureSize", captureBound ?: "unknown")
            putString("captureSizes", sizes.take(8).joinToString(","))
          })`
      );
    }
  }

  return next;
}

/**
 * Emissione delle dimensioni reali degli stream all'apertura della camera.
 * Aggancia il gestore CameraState.Type.OPEN così com'è nel sorgente originale:
 * le varianti riconosciute altrove presuppongono patch di comportamento che
 * ora restano disattivate. È puramente additiva, non tocca le use case.
 */
function patchAndroidCameraOpenDiagnostics(src) {
  if (src.includes('putString("state", "CAMERA_OPEN")')) return src;
  const stockAnchor = `        CameraState.Type.OPEN -> {
          onCameraReady(Unit)
          setTorchEnabled(enableTorch)
        }`;
  if (!src.includes(stockAnchor)) return src;
  const replacement = `        CameraState.Type.OPEN -> {
          onCameraReady(Unit)
          setTorchEnabled(enableTorch)
          val previewStream = previewUseCase?.resolutionInfo?.resolution?.toString()
          val captureBound = imageCaptureUseCase?.resolutionInfo?.resolution?.toString()
          onAutofocusStateChanged(android.os.Bundle().apply {
            putString("state", "CAMERA_OPEN")
            putInt("previewWidth", previewView.width)
            putInt("previewHeight", previewView.height)
            putString("previewStreamSize", previewStream ?: "unknown")
            putString("imageCaptureSize", captureBound ?: "unknown")
            putString("captureSizes", getAvailablePictureSizes().take(8).joinToString(","))
          })
        }`;
  return src.replace(stockAnchor, replacement);
}

/**
 * Intervallo di zoom reale del dispositivo, osservato invece che letto una volta.
 *
 * Su Android expo-camera traduce la prop `zoom` (0–1) in
 * `zoomRatio = clamp(zoom * maxZoomRatio, 1, maxZoomRatio)`: senza conoscere
 * maxZoomRatio nessuno può chiedere un ingrandimento in unità ottiche.
 *
 * Leggerlo dentro il ramo CameraState.OPEN non basta: quando quell'evento parte
 * `zoomState.value` può essere ancora null e il `?: 1f` farebbe credere per
 * sempre che il dispositivo non zoomi. Osservando la LiveData si riceve il
 * valore corrente appena disponibile e ogni variazione successiva, quindi anche
 * il rapporto effettivamente applicato dopo aver impostato la prop: è la prova
 * di runtime di quanto sta zoomando davvero la camera. Puramente additivo: non
 * tocca use case, fuoco né scatto.
 */
function patchAndroidCameraZoomStateEvents(src) {
  if (src.includes('CAMERA_ZOOM_RANGE')) return src;
  const anchor = `  private fun observeCameraState(cameraInfo: CameraInfo) {
    cameraInfo.cameraState.observe(currentActivity) {`;
  if (!src.includes(anchor)) return src;
  return src.replace(
    anchor,
    `  private fun observeCameraState(cameraInfo: CameraInfo) {
    cameraInfo.zoomState.observe(currentActivity) { zoomState ->
      onAutofocusStateChanged(android.os.Bundle().apply {
        putString("state", "CAMERA_ZOOM_RANGE")
        putFloat("minZoomRatio", zoomState.minZoomRatio)
        putFloat("maxZoomRatio", zoomState.maxZoomRatio)
        putFloat("zoomRatio", zoomState.zoomRatio)
        putFloat("linearZoom", zoomState.linearZoom)
      })
    }
    cameraInfo.cameraState.observe(currentActivity) {`
  );
}

function patchAndroidCameraOpenZoomRange(src) {
  if (src.includes('putFloat("maxZoomRatio"')) return src;
  const anchor = 'putString("imageCaptureSize", captureBound ?: "unknown")';
  if (!src.includes(anchor)) return src;
  return src.replaceAll(
    anchor,
    `${anchor}
            putFloat("minZoomRatio", camera?.cameraInfo?.zoomState?.value?.minZoomRatio ?: 1f)
            putFloat("maxZoomRatio", camera?.cameraInfo?.zoomState?.value?.maxZoomRatio ?: 1f)`
  );
}

function patchAndroidModuleEvents(src) {
  if (src.includes('"onAutofocusStateChanged"')) return src;
  const anchor = `val cameraEvents = arrayOf(
  "onCameraReady",
  "onMountError",
  "onBarcodeScanned",
  "onFacesDetected",
  "onFaceDetectionError",
  "onPictureSaved",
  "onAvailableLensesChanged"
)`;
  const replacement = `val cameraEvents = arrayOf(
  "onCameraReady",
  "onMountError",
  "onBarcodeScanned",
  "onFacesDetected",
  "onFaceDetectionError",
  "onPictureSaved",
  "onAvailableLensesChanged",
  "onAutofocusStateChanged"
)`;
  if (!src.includes(anchor)) return src;
  return src.replace(anchor, replacement);
}

function patchJsCameraView(src) {
  if (src.includes('_onAutofocusStateChanged')) return src;
  const anchor = `  _onAvailableLensesChanged = ({ nativeEvent }: { nativeEvent: AvailableLenses }) => {
    if (this.props.onAvailableLensesChanged) {
      this.props.onAvailableLensesChanged(nativeEvent);
    }
  };

  _onMountError = ({ nativeEvent }: { nativeEvent: { message: string } }) => {`;
  const replacement = `  _onAvailableLensesChanged = ({ nativeEvent }: { nativeEvent: AvailableLenses }) => {
    if (this.props.onAvailableLensesChanged) {
      this.props.onAvailableLensesChanged(nativeEvent);
    }
  };

  _onAutofocusStateChanged = (event: { nativeEvent: Record<string, unknown> }) => {
    if (this.props.onAutofocusStateChanged) {
      this.props.onAutofocusStateChanged(event);
    }
  };

  _onMountError = ({ nativeEvent }: { nativeEvent: { message: string } }) => {`;
  if (!src.includes(anchor)) return src;
  let next = src.replace(anchor, replacement);
  const renderAnchor = `        onAvailableLensesChanged={this._onAvailableLensesChanged}
        onPictureSaved={_onPictureSaved}`;
  const renderReplacement = `        onAvailableLensesChanged={this._onAvailableLensesChanged}
        onAutofocusStateChanged={
          this.props.onAutofocusStateChanged ? this._onAutofocusStateChanged : undefined
        }
        onPictureSaved={_onPictureSaved}`;
  if (next.includes(renderAnchor)) next = next.replace(renderAnchor, renderReplacement);
  return next;
}

function patchJsCameraTypes(src) {
  if (src.includes('onAutofocusStateChanged?: (event: { nativeEvent: Record<string, unknown> })')) {
    return src;
  }
  let next = src.replace(
    `  onAvailableLensesChanged?: (event: AvailableLenses) => void;
};`,
    `  onAvailableLensesChanged?: (event: AvailableLenses) => void;
  /** Patch v4 — AF CameraX @platform android */
  onAutofocusStateChanged?: (event: { nativeEvent: Record<string, unknown> }) => void;
};`
  );
  next = next.replace(
    `  onAvailableLensesChanged?: AvailableLensesChangedListener;
  facing?: string;`,
    `  onAvailableLensesChanged?: AvailableLensesChangedListener;
  onAutofocusStateChanged?: (event: { nativeEvent: Record<string, unknown> }) => void;
  facing?: string;`
  );
  return next;
}

/**
 * Metro carica `build/CameraView.js` (package main), non `src/CameraView.tsx`:
 * patchare solo i sorgenti lasciava la prop non collegata e l'evento nativo non
 * raggiungeva mai il lato JS, qualunque cosa emettesse Android.
 */
function patchJsCameraViewBuild(src) {
  if (src.includes('_onAutofocusStateChanged')) return src;
  const handlerAnchor = `    _onResponsiveOrientationChanged = ({ nativeEvent, }) => {
        if (this.props.onResponsiveOrientationChanged) {
            this.props.onResponsiveOrientationChanged(nativeEvent);
        }
    };`;
  const renderAnchor = 'onResponsiveOrientationChanged={this._onResponsiveOrientationChanged}/>';
  if (!src.includes(handlerAnchor) || !src.includes(renderAnchor)) return src;
  return src
    .replace(
      handlerAnchor,
      `${handlerAnchor}
    _onAutofocusStateChanged = (event) => {
        if (this.props.onAutofocusStateChanged) {
            this.props.onAutofocusStateChanged(event);
        }
    };`
    )
    .replace(
      renderAnchor,
      'onResponsiveOrientationChanged={this._onResponsiveOrientationChanged} onAutofocusStateChanged={this.props.onAutofocusStateChanged ? this._onAutofocusStateChanged : undefined}/>'
    );
}

// ---------------------------------------------------------------------------

let changed = 0;
if (
  patchFile(
    'android/src/main/java/expo/modules/camera/ExpoCameraView.kt',
    (s) =>
      removeLegacyAndroidFocusBeforeCapture(patchAndroidCameraZoomStateEvents(
      patchAndroidCameraOpenZoomRange(
        patchAndroidCameraOpenDiagnostics(
        gated(patchAndroidFocusBeforeCapture)(
          gated(patchAndroidNoCancelAf)(
            gated(patchAndroidViewPortSync)(
              gated(patchAndroidFocusOnOpen)(
                gated(patchAndroidSpreadSetters)(
                  gated(patchAndroidAfOffNoCancel)(
                    patchAndroidAfEvents(
                      gated(patchAndroidCaptureQuality)(
                        gated(patchAndroidFocusMetering)(
                          patchAndroidPreviewUseCaseRef(
                            gated(patchAndroidCaptureRotationRace)(patchAndroidView(s))
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      ))
      )
      ),
    'Android ExpoCameraView'
  )
) {
  changed++;
}
if (
  patchFile(
    'android/src/main/java/expo/modules/camera/CameraViewModule.kt',
    (s) => patchAndroidModuleEvents(patchAndroidModule(s)),
    'Android CameraViewModule'
  )
) {
  changed++;
}
if (patchFile('ios/Current/CameraView.swift', patchIosView, 'iOS CameraView')) changed++;
if (
  patchFile('ios/Current/CameraSessionManager.swift', patchIosSessionManager, 'iOS CameraSessionManager')
) {
  changed++;
}
if (patchFile('ios/CameraViewModule.swift', patchIosModule, 'iOS CameraViewModule')) changed++;
if (patchFile('src/CameraView.tsx', patchJsCameraView, 'JS CameraView')) changed++;
if (patchFile('build/CameraView.js', patchJsCameraViewBuild, 'JS CameraView (build)')) changed++;
if (patchFile('src/Camera.types.ts', patchJsCameraTypes, 'JS Camera.types')) changed++;

if (changed === 0) {
  console.log('[patch-expo-camera-focus] già applicata (nessuna modifica).');
}

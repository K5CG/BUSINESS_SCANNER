export type DeviceCaptureOrientation =
  | 'portrait'
  | 'portrait-down'
  | 'landscape-left'
  | 'landscape-right';

export type DocumentPreviewOrientation = 'portrait' | 'landscape';
export type DocumentCaptureMode = 'portrait' | 'landscape-left';

export interface DocumentCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DocumentOrientationNormalizationReason =
  | 'bitmap_already_oriented'
  | 'camera_processing_applied'
  | 'deterministic_capture_orientation'
  | 'exif_orientation_applied'
  | 'device_orientation_alignment'
  | 'landscape_reading_order_correction'
  | 'landscape_aspect_mismatch_probe'
  | 'processed_visual_orientation_probe'
  | 'processed_visual_orientation_ambiguous'
  | 'normalization_failed_original_preserved';

export type CameraCaptureFacing = 'back' | 'front';
export type CapturedBitmapAspect = 'portrait' | 'landscape' | 'square';
export type SanitizedExifClass = 'null' | 'upright' | 'legacy';

export interface DocumentOrientationNormalizationInput {
  width: number;
  height: number;
  exifOrientation?: number | null;
  deviceOrientationAtCapture: DeviceCaptureOrientation;
  previewOrientation: DocumentPreviewOrientation;
  platform: 'android' | 'ios';
  cameraProcessingApplied: boolean;
  /** Lo scatto proviene da skipProcessing=true e conserva l'evidenza camera/EXIF raw. */
  rawCapturePreserved?: boolean;
  /** Shutter-time capture mode; defaults from previewOrientation when omitted. */
  captureMode?: DocumentCaptureMode;
  /** Camera lens at shutter; document scans default to back. */
  cameraFacing?: CameraCaptureFacing;
}

/** Stable capture-state key: same key always yields the same rotation. */
export interface CapturedOrientationKey {
  platform: DocumentOrientationNormalizationInput['platform'];
  cameraFacing: CameraCaptureFacing;
  captureMode: DocumentCaptureMode;
  deviceOrientation: DeviceCaptureOrientation;
  cameraProcessingApplied: boolean;
  rawCapturePreserved: boolean;
  sanitizedExif: SanitizedExifClass;
  bitmapAspect: CapturedBitmapAspect;
}

export interface DocumentOrientationNormalizationPlan {
  normalizedWidth: number;
  normalizedHeight: number;
  /** Rotazione ancora da applicare al bitmap decodificato. */
  rotationRequired: 0 | 90 | 180 | 270;
  /** Rotazione fisica complessiva, inclusa quella EXIF gia applicata dal decoder. */
  rotationApplied: 0 | 90 | 180 | 270;
  orientation: DeviceCaptureOrientation;
  normalizationReason: DocumentOrientationNormalizationReason;
  preserveOriginalUntilComplete: true;
  allowUpscale: false;
}

export interface DocumentPageCaptureMetadata {
  /** Immutable shutter-time evidence. Processing must never read live orientation for this page. */
  captureTimestamp: number;
  captureOrientation: DeviceCaptureOrientation;
  screenOrientationAtCapture: DocumentCaptureMode;
  cameraProcessingApplied: boolean;
  normalizedOrientation: DeviceCaptureOrientation;
  rotationRequested: 0 | 90 | 180 | 270;
  rotationApplied: 0 | 90 | 180 | 270;
  width: number;
  height: number;
  exifOrientation?: number;
  originalExif: number | null;
  previewOrientation: DocumentPreviewOrientation;
  normalizationReason: DocumentOrientationNormalizationReason;
  sourceWidth: number;
  sourceHeight: number;
  persistedWidth: number;
  persistedHeight: number;
  originalPersistedWidth: number;
  originalPersistedHeight: number;
  previewWidth?: number;
  previewHeight?: number;
  previewStreamSize?: string;
  mappedPreviewStreamSize?: string;
  imageCaptureSize?: string;
  imageCaptureSizeSource?: 'native' | 'bitmap_measurement';
  previewScaleMode?: 'cover' | 'contain';
  previewContentRect?: DocumentCaptureRect;
  overlayRect?: DocumentCaptureRect | null;
  bitmapWidth?: number;
  bitmapHeight?: number;
  cropRect?: { x: number; y: number; width: number; height: number };
  cropAreaRatio?: number;
  cropDecision:
    | 'not_evaluated'
    | 'applied_for_ocr'
    | 'applied_frame_aligned'
    | 'applied_verified'
    | 'bypassed_full_frame'
    | 'rejected_invalid'
    | 'rejected_low_coverage'
    | 'rejected_anomalous_geometry'
    | 'skipped_geometry_uncertain';
  ocrWidth: number;
  ocrHeight: number;
  selectedCaptureMode?: DocumentCaptureMode;
  originalWidth?: number;
  originalHeight?: number;
  canonicalWidth?: number;
  canonicalHeight?: number;
  originalUri?: string;
  canonicalUri?: string;
}

export function withConfirmedDocumentImage(
  metadata: DocumentPageCaptureMetadata,
  input: {
    selectedCaptureMode: DocumentCaptureMode;
    originalWidth: number;
    originalHeight: number;
    canonicalWidth: number;
    canonicalHeight: number;
    originalUri: string;
    canonicalUri: string;
    previewContentRect: DocumentCaptureRect;
    overlayRect: DocumentCaptureRect | null;
  },
): DocumentPageCaptureMetadata {
  assertDimensions(input.originalWidth, input.originalHeight);
  assertDimensions(input.canonicalWidth, input.canonicalHeight);
  if (!input.originalUri.trim() || !input.canonicalUri.trim()) {
    throw new Error('Missing confirmed document image URI');
  }
  return {
    ...metadata,
    selectedCaptureMode: input.selectedCaptureMode,
    originalWidth: input.originalWidth,
    originalHeight: input.originalHeight,
    canonicalWidth: input.canonicalWidth,
    canonicalHeight: input.canonicalHeight,
    originalUri: input.originalUri,
    canonicalUri: input.canonicalUri,
    previewContentRect: { ...input.previewContentRect },
    overlayRect: input.overlayRect ? { ...input.overlayRect } : null,
    cropDecision: 'bypassed_full_frame',
    ocrWidth: input.canonicalWidth,
    ocrHeight: input.canonicalHeight,
    persistedWidth: input.canonicalWidth,
    persistedHeight: input.canonicalHeight,
  };
}

export interface DocumentCaptureDiagnostics {
  previewWidth: number;
  previewHeight: number;
  previewStreamSize?: string;
  mappedPreviewStreamSize?: string;
  imageCaptureSize?: string;
  imageCaptureSizeSource?: 'native' | 'bitmap_measurement';
  previewScaleMode?: 'cover' | 'contain';
  overlayRect?: { x: number; y: number; width: number; height: number };
  bitmapWidth: number;
  bitmapHeight: number;
  cropRect?: { x: number; y: number; width: number; height: number };
  cropAreaRatio?: number;
  cropDecision: DocumentPageCaptureMetadata['cropDecision'];
  ocrWidth: number;
  ocrHeight: number;
  persistedWidth?: number;
  persistedHeight?: number;
  originalPersistedWidth?: number;
  originalPersistedHeight?: number;
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid captured document dimensions');
  }
}

function normalizeQuarterTurn(value: number): 0 | 90 | 180 | 270 {
  const normalized = ((value % 360) + 360) % 360;
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized;
  return 0;
}

export function rotationFromExifOrientation(exifOrientation?: number | null): 0 | 90 | 180 | 270 {
  switch (exifOrientation) {
    case 3:
      return 180;
    case 6:
      return 90;
    case 8:
      return 270;
    default:
      return 0;
  }
}

export function readRawCapturedExifValue(
  exif?: Record<string, unknown>,
): number | null {
  const raw = exif?.Orientation ?? exif?.orientation;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function readCapturedExifOrientation(
  exif?: Record<string, unknown>,
): number | null {
  const value = readRawCapturedExifValue(exif);
  return value != null && Number.isInteger(value) && value >= 1 && value <= 8
    ? value
    : null;
}

/** Leftover TIFF Orientation 2–8 after CameraX bake would make <Image> re-orient pixels. */
export function staleProcessedExifRequiresRewrite(
  input: DocumentOrientationNormalizationInput,
  plan: DocumentOrientationNormalizationPlan,
): boolean {
  if (!input.cameraProcessingApplied) return false;
  if (plan.rotationRequired !== 0) return false;
  const exif = input.exifOrientation;
  return exif != null && Number.isInteger(exif) && exif >= 2 && exif <= 8;
}

function dimensionsAfterRotation(
  width: number,
  height: number,
  rotation: 0 | 90 | 180 | 270,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

function wantsLandscape(input: DocumentOrientationNormalizationInput): boolean {
  return (
    input.deviceOrientationAtCapture === 'landscape-left' ||
    input.deviceOrientationAtCapture === 'landscape-right' ||
    input.previewOrientation === 'landscape'
  );
}

export function captureModeFromInput(
  input: DocumentOrientationNormalizationInput,
): DocumentCaptureMode {
  if (input.captureMode === 'landscape-left' || input.captureMode === 'portrait') {
    return input.captureMode;
  }
  return input.previewOrientation === 'landscape' ? 'landscape-left' : 'portrait';
}

export function cameraFacingFromInput(
  input: DocumentOrientationNormalizationInput,
): CameraCaptureFacing {
  return input.cameraFacing === 'front' ? 'front' : 'back';
}

const NEAR_SQUARE_ASPECT_TOLERANCE = 0.02;

export function bitmapAspectFromDimensions(
  width: number,
  height: number,
): CapturedBitmapAspect {
  if (width <= 0 || height <= 0) return 'portrait';
  const minSide = Math.min(width, height);
  const maxSide = Math.max(width, height);
  if (maxSide - minSide <= Math.max(2, Math.round(maxSide * NEAR_SQUARE_ASPECT_TOLERANCE))) {
    return 'square';
  }
  return width > height ? 'landscape' : 'portrait';
}

export function sanitizedExifClass(
  exifOrientation?: number | null,
): SanitizedExifClass {
  if (exifOrientation == null) return 'null';
  if (exifOrientation === 1) return 'upright';
  return 'legacy';
}

export function buildCapturedOrientationKey(
  input: DocumentOrientationNormalizationInput,
): CapturedOrientationKey {
  return {
    platform: input.platform,
    cameraFacing: cameraFacingFromInput(input),
    captureMode: captureModeFromInput(input),
    deviceOrientation: input.deviceOrientationAtCapture,
    cameraProcessingApplied: input.cameraProcessingApplied,
    rawCapturePreserved: input.rawCapturePreserved === true,
    sanitizedExif: sanitizedExifClass(input.exifOrientation),
    bitmapAspect: bitmapAspectFromDimensions(input.width, input.height),
  };
}

export function capturedOrientationKeyLabel(key: CapturedOrientationKey): string {
  return [
    key.platform,
    key.cameraFacing,
    key.captureMode,
    key.deviceOrientation,
    key.cameraProcessingApplied ? 'processed' : 'raw',
    key.rawCapturePreserved ? 'preserved' : 'baked',
    `exif-${key.sanitizedExif}`,
    `bitmap-${key.bitmapAspect}`,
  ].join('|');
}

/**
 * Capture-state rotation table. Returns null only when orientation cannot be
 * resolved without visual probing (e.g. landscape-right on this device class).
 *
 * Branches on abstract geometry classes (bitmap portrait/landscape/square, EXIF
 * class, capture mode) — never on exact width/height or sensor resolution.
 */
export function resolveDeterministicCaptureRotation(
  key: CapturedOrientationKey,
): 0 | 90 | 180 | 270 | null {
  if (key.platform !== 'android') return null;
  if (key.cameraFacing !== 'back') return null;
  if (!key.cameraProcessingApplied || key.rawCapturePreserved) return null;

  if (key.captureMode === 'portrait' || key.deviceOrientation === 'portrait' || key.deviceOrientation === 'portrait-down') {
    // Real-device multipage race (2026-08-29): between consecutive captures
    // CameraX can report a baked landscape bitmap while the React/native mode
    // still says portrait, with no usable EXIF orientation.  Treating that
    // combination as deterministically upright (0°) suppresses the visual probe
    // and can persist page 2 upside down.  Leave only this contradictory state
    // unresolved so the existing content-based orientation probe can decide.
    if (key.bitmapAspect === 'landscape' && key.sanitizedExif === 'null') {
      return null;
    }
    return 0;
  }

  if (key.captureMode !== 'landscape-left' || key.deviceOrientation !== 'landscape-left') {
    return null;
  }

  if (key.sanitizedExif === 'upright' || key.sanitizedExif === 'legacy') {
    return 0;
  }

  // Real-device closure: landscape-left + invalid EXIF + baked JPEG (portrait or landscape aspect).
  return 180;
}

export function resolveDeterministicCaptureOrientation(
  input: DocumentOrientationNormalizationInput,
): { key: CapturedOrientationKey; rotation: 0 | 90 | 180 | 270 } | null {
  const key = buildCapturedOrientationKey(input);
  const rotation = resolveDeterministicCaptureRotation(key);
  if (rotation == null) return null;
  return { key, rotation };
}

export function applyDeterministicCaptureOrientation(
  plan: DocumentOrientationNormalizationPlan,
  input: DocumentOrientationNormalizationInput,
  rotation: 0 | 90 | 180 | 270,
): DocumentOrientationNormalizationPlan {
  if (rotation === 0) {
    return {
      ...plan,
      rotationRequired: 0,
      rotationApplied: 0,
      normalizedWidth: input.width,
      normalizedHeight: input.height,
      normalizationReason: 'deterministic_capture_orientation',
    };
  }
  if (rotation === 180) {
    const corrected = applyLandscapeReadingOrderCorrection(plan, 180);
    return {
      ...corrected,
      normalizationReason: 'deterministic_capture_orientation',
    };
  }
  const normalized = {
    width: input.height,
    height: input.width,
  };
  return {
    ...plan,
    rotationRequired: rotation,
    rotationApplied: rotation,
    normalizedWidth: normalized.width,
    normalizedHeight: normalized.height,
    normalizationReason: 'deterministic_capture_orientation',
  };
}

function alignmentRotation(
  target: DeviceCaptureOrientation,
  width: number,
  height: number,
  input: DocumentOrientationNormalizationInput,
): 0 | 90 | 270 {
  const targetLandscape = target === 'landscape-left' || target === 'landscape-right';
  const bitmapLandscape = width >= height;
  if (targetLandscape === bitmapLandscape) return 0;
  // With skipProcessing:false, Expo/CameraX has already materialized JPEG
  // orientation. Device orientation cannot safely infer a quarter-turn here:
  // applying one caused a confirmed 180° inversion on Motorparts.
  if (input.cameraProcessingApplied) return 0;
  if (target === 'landscape-right' || target === 'portrait-down') return 270;
  return 90;
}

export function previewOrientationForDevice(
  orientation: DeviceCaptureOrientation,
): DocumentPreviewOrientation {
  return orientation === 'portrait' || orientation === 'portrait-down'
    ? 'portrait'
    : 'landscape';
}

export function applyLandscapeReadingOrderCorrection(
  plan: DocumentOrientationNormalizationPlan,
  correction: 0 | 180,
): DocumentOrientationNormalizationPlan {
  if (correction === 0) return plan;
  return {
    ...plan,
    rotationRequired: normalizeQuarterTurn(plan.rotationRequired + correction),
    rotationApplied: normalizeQuarterTurn(plan.rotationApplied + correction),
    normalizationReason: 'landscape_reading_order_correction',
  };
}

export function planCapturedDocumentOrientation(
  input: DocumentOrientationNormalizationInput,
): DocumentOrientationNormalizationPlan {
  assertDimensions(input.width, input.height);

  const decodedLandscape = input.width >= input.height;
  const targetOrientation: DeviceCaptureOrientation = input.rawCapturePreserved
    ? decodedLandscape
      ? input.deviceOrientationAtCapture === 'landscape-right'
        ? 'landscape-right'
        : 'landscape-left'
      : input.deviceOrientationAtCapture === 'portrait-down'
        ? 'portrait-down'
        : 'portrait'
    : wantsLandscape(input)
      ? input.deviceOrientationAtCapture === 'landscape-right'
        ? 'landscape-right'
        : 'landscape-left'
      : input.deviceOrientationAtCapture === 'portrait-down'
        ? 'portrait-down'
        : 'portrait';

  const exifRotation = rotationFromExifOrientation(input.exifOrientation);
  // skipProcessing:false already materializes pixels. Leftover EXIF (including
  // tag 3, or vendor logs that are not TIFF 1–8) must not drive another 180°.
  // Applying EXIF=3 after CameraX bake inverted the first portrait capture.
  const afterExif = input.cameraProcessingApplied
    ? { width: input.width, height: input.height }
    : dimensionsAfterRotation(input.width, input.height, exifRotation);
  const correction = input.rawCapturePreserved && input.cameraProcessingApplied
    ? 0
    : alignmentRotation(targetOrientation, afterExif.width, afterExif.height, input);
  const rotationRequired = input.cameraProcessingApplied
    ? normalizeQuarterTurn(correction)
    : normalizeQuarterTurn(exifRotation + correction);
  const totalRotation = rotationRequired;
  const normalized = dimensionsAfterRotation(input.width, input.height, rotationRequired);

  let normalizationReason: DocumentOrientationNormalizationReason;
  if (correction !== 0) {
    normalizationReason = 'device_orientation_alignment';
  } else if (exifRotation !== 0 && !input.cameraProcessingApplied) {
    normalizationReason = 'exif_orientation_applied';
  } else if (input.rawCapturePreserved) {
    normalizationReason = 'bitmap_already_oriented';
  } else if (input.cameraProcessingApplied) {
    normalizationReason = 'camera_processing_applied';
  } else {
    normalizationReason = 'bitmap_already_oriented';
  }

  return {
    normalizedWidth: normalized.width,
    normalizedHeight: normalized.height,
    rotationRequired,
    rotationApplied: totalRotation,
    orientation: targetOrientation,
    normalizationReason,
    preserveOriginalUntilComplete: true,
    allowUpscale: false,
  };
}

export function pageCaptureMetadata(
  input: DocumentOrientationNormalizationInput,
  plan: DocumentOrientationNormalizationPlan,
): DocumentPageCaptureMetadata {
  return {
    // Replaced with the shutter timestamp by MultiPageScanner before persistence.
    captureTimestamp: Date.now(),
    captureOrientation: input.deviceOrientationAtCapture,
    screenOrientationAtCapture:
      input.previewOrientation === 'landscape' ? 'landscape-left' : 'portrait',
    cameraProcessingApplied: input.cameraProcessingApplied,
    normalizedOrientation: plan.orientation,
    rotationRequested: plan.rotationRequired,
    rotationApplied: plan.rotationApplied,
    width: plan.normalizedWidth,
    height: plan.normalizedHeight,
    ...(input.exifOrientation == null ? {} : { exifOrientation: input.exifOrientation }),
    originalExif: input.exifOrientation ?? null,
    previewOrientation: input.previewOrientation,
    normalizationReason: plan.normalizationReason,
    sourceWidth: input.width,
    sourceHeight: input.height,
    persistedWidth: plan.normalizedWidth,
    persistedHeight: plan.normalizedHeight,
    originalPersistedWidth: plan.normalizedWidth,
    originalPersistedHeight: plan.normalizedHeight,
    cropDecision: 'not_evaluated',
    ocrWidth: plan.normalizedWidth,
    ocrHeight: plan.normalizedHeight,
  };
}

export function withDocumentCaptureDiagnostics(
  metadata: DocumentPageCaptureMetadata,
  diagnostics: DocumentCaptureDiagnostics,
): DocumentPageCaptureMetadata {
  return {
    ...metadata,
    previewWidth: diagnostics.previewWidth,
    previewHeight: diagnostics.previewHeight,
    ...(diagnostics.previewStreamSize ? { previewStreamSize: diagnostics.previewStreamSize } : {}),
    ...(diagnostics.mappedPreviewStreamSize
      ? { mappedPreviewStreamSize: diagnostics.mappedPreviewStreamSize }
      : {}),
    ...(diagnostics.imageCaptureSize ? { imageCaptureSize: diagnostics.imageCaptureSize } : {}),
    ...(diagnostics.imageCaptureSizeSource
      ? { imageCaptureSizeSource: diagnostics.imageCaptureSizeSource }
      : {}),
    ...(diagnostics.previewScaleMode ? { previewScaleMode: diagnostics.previewScaleMode } : {}),
    ...(diagnostics.overlayRect ? { overlayRect: { ...diagnostics.overlayRect } } : {}),
    bitmapWidth: diagnostics.bitmapWidth,
    bitmapHeight: diagnostics.bitmapHeight,
    ...(diagnostics.cropRect ? { cropRect: { ...diagnostics.cropRect } } : {}),
    ...(diagnostics.cropAreaRatio == null ? {} : { cropAreaRatio: diagnostics.cropAreaRatio }),
    cropDecision: diagnostics.cropDecision,
    ocrWidth: diagnostics.ocrWidth,
    ocrHeight: diagnostics.ocrHeight,
    persistedWidth: diagnostics.persistedWidth ?? diagnostics.ocrWidth,
    persistedHeight: diagnostics.persistedHeight ?? diagnostics.ocrHeight,
    width: diagnostics.bitmapWidth,
    height: diagnostics.bitmapHeight,
    originalPersistedWidth: diagnostics.originalPersistedWidth ?? diagnostics.bitmapWidth,
    originalPersistedHeight: diagnostics.originalPersistedHeight ?? diagnostics.bitmapHeight,
  };
}

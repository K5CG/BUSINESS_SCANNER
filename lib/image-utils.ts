import { Image, Dimensions, Platform } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { decode, encode } from 'jpeg-js';
import type { CardOrientation, DocumentType } from '../types';
import {
  getOverlayFrameRectInView,
  mapScreenRectToBuffer,
  mapScreenRectToPhoto,
  getOverlayAspectRatio,
  type MapScreenToPhotoOptions,
  type OverlayViewportInsets,
  type PreviewLayout,
  type ScreenRect,
} from './overlay-geometry';
import {
  CAMERA_PREVIEW_RATIO,
  parseStreamSize,
  previewScaleModeForRatio,
  type PreviewScaleMode,
} from './camera-preview';
import {
  mapPreviewRectToPhotoRect,
  type PreviewPhotoMapping,
} from './preview-photo-mapping';
import type { CameraResolutionDiag } from './camera-focus-gate';
import {
  InvalidCropPlanError,
  clampCropActionToBitmap,
  imagePipelineUris,
  planLongSideResize,
  prepareImageOnce,
  requireDistinctImageOutputUri,
  type LongSideResizePlan,
} from './image-preparation';
import { runtimeLogger } from './safe-runtime-logger';
import {
  detectBusinessCardBoundaryFromGray,
  detectBusinessCardForegroundBoundsFromRgba,
  type BusinessCardBoundaryDetection,
  type BusinessCardForegroundDetection,
} from './business-card-boundary';
import {
  pageCaptureMetadata,
  planCapturedDocumentOrientation,
  applyLandscapeReadingOrderCorrection,
  applyDeterministicCaptureOrientation,
  resolveDeterministicCaptureOrientation,
  capturedOrientationKeyLabel,
  staleProcessedExifRequiresRewrite,
  withDocumentCaptureDiagnostics,
  type DocumentCaptureDiagnostics,
  type DocumentOrientationNormalizationInput,
  type DocumentOrientationNormalizationPlan,
  type DocumentPageCaptureMetadata,
} from './document-capture-orientation';
import { setJpegExifOrientation } from './jpeg-exif-orientation';
import {
  needsLandscapeUpsideDownProbe,
  needsPortraitUpsideDownProbe,
  resolvePortraitUpsideDownCorrection,
  needsLandscapeAspectMismatchProbe,
  needsPortraitQuarterTurnProbe,
  needsProcessedVisualOrientationProbe,
  measureLandscapeInkBandsFromGray,
  measurePortraitQuarterTurnBandsFromGray,
  mirroredLandscapeInkBands,
  resolveLandscapeUpsideDownCorrection,
  resolvePortraitQuarterTurnRotation,
  resolveProcessedVisualOrientation,
  applyProcessedVisualOrientationDecision,
  scoreLandscapeHeaderAtTop,
  type DocumentOrientationSessionContext,
  type VisualOrientationDecision,
} from './document-orientation-evidence';
import {
  inkProbeLogFields,
  logCameraOrientation,
  logOrientationCapture,
  orientationSnapshotFromInput,
} from './orientation-capture-log';

/** Qualità JPEG finale — un solo passaggio di compressione nel pipeline. */
// jpeg-js usa Buffer durante l'encode. Hermes/React Native non espone
// Buffer come globale Node per default: il decode con useTArray funziona,
// ma l'encode della foreground mask fallisce senza questo bootstrap.
const jpegRuntimeGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!jpegRuntimeGlobal.Buffer) jpegRuntimeGlobal.Buffer = Buffer;

export const JPEG_QUALITY = 1;
export const OCR_MAX_LONG_SIDE = 2600;
export const NORMALIZED_SCAN_MAX_LONG_SIDE = 2000;
export const PERSON_PHOTO_MAX_LONG_SIDE = 1600;

export { InvalidCropPlanError, imagePipelineUris };
export { withDocumentCaptureDiagnostics };

export interface CropDebugInfo {
  photoWidth: number;
  photoHeight: number;
  previewWidth: number;
  previewHeight: number;
  overlayRect: ScreenRect;
  normalizedWidth: number;
  normalizedHeight: number;
  alignRotation: number;
  readingRotation: number;
  cropRect: ScreenRect | null;
  cropApplied: boolean;
  cropInvalid: boolean;
  documentType: DocumentType;
  cardOrientation: CardOrientation;
  /** Esito del modello anteprima→pixel, valorizzato solo per il biglietto. */
  cardMapping?: PreviewPhotoMapping | null;
}

export { CAMERA_PREVIEW_RATIO, previewScaleModeForRatio } from './camera-preview';

export interface ScanPlanOptions {
  previewScaleMode?: PreviewScaleMode;
  previewStreamSize?: string;
  imageCaptureSize?: string;
  previewLayout?: PreviewLayout;
  /** JPEG già normalizzato da resolveCaptureBitmap (EXIF applicato) — non ri-allineare. */
  exifNormalized?: boolean;
}

export interface ScanManipulatorPlan {
  actions: ImageManipulator.Action[];
  cropWidth: number;
  cropHeight: number;
  originalWidth: number;
  originalHeight: number;
  alignRotation: number;
  readingRotation: number;
  cropApplied: boolean;
  cropInvalid: boolean;
  debug: CropDebugInfo;
  /** JPEG normalizzato (EXIF + dimensioni reali manipolatore). */
  sourceUri?: string;
}

export interface DocumentCropSafety {
  useCropForOcr: boolean;
  cropAreaRatio?: number;
  cropDecision: DocumentCaptureDiagnostics['cropDecision'];
}

/**
 * Accetta il crop della cornice solo quando resta centrato, interno e con
 * copertura plausibile. Un A4 dentro una preview `cover` occupa normalmente
 * circa meta del JPEG 4:3: la sola percentuale non e quindi un'anomalia.
 */
export function assessDocumentCropSafety(plan: ScanManipulatorPlan): DocumentCropSafety {
  if (plan.cropInvalid || !plan.cropApplied || !plan.debug.cropRect) {
    return { useCropForOcr: false, cropDecision: 'rejected_invalid' };
  }
  const sourceArea = plan.debug.normalizedWidth * plan.debug.normalizedHeight;
  const cropArea = plan.debug.cropRect.width * plan.debug.cropRect.height;
  const cropAreaRatio = sourceArea > 0 ? cropArea / sourceArea : 0;
  if (!Number.isFinite(cropAreaRatio) || cropAreaRatio < 0.2) {
    return {
      useCropForOcr: false,
      cropAreaRatio,
      cropDecision: 'rejected_low_coverage',
    };
  }
  const crop = plan.debug.cropRect;
  const sourceCenterX = plan.debug.normalizedWidth / 2;
  const sourceCenterY = plan.debug.normalizedHeight / 2;
  const offsetX = Math.abs(crop.x + crop.width / 2 - sourceCenterX) / plan.debug.normalizedWidth;
  const offsetY = Math.abs(crop.y + crop.height / 2 - sourceCenterY) / plan.debug.normalizedHeight;
  const touchesBounds =
    crop.x < 0 || crop.y < 0 ||
    crop.x + crop.width > plan.debug.normalizedWidth ||
    crop.y + crop.height > plan.debug.normalizedHeight;
  if (touchesBounds || offsetX > 0.18 || offsetY > 0.18 || cropAreaRatio > 0.98) {
    return {
      useCropForOcr: false,
      cropAreaRatio,
      cropDecision: 'rejected_anomalous_geometry',
    };
  }
  return { useCropForOcr: true, cropAreaRatio, cropDecision: 'applied_for_ocr' };
}

/**
 * Il ritaglio del biglietto viene applicato solo quando la mappatura
 * anteprima→pixel è dimostrabile. Senza le dimensioni reali dello stream di
 * anteprima non è possibile provare che la cornice verde corrisponda alla
 * regione ritagliata, e un ritaglio sbagliato cancella il soggetto: in quel
 * caso si conserva il fotogramma intero.
 */
export function assessCardCropSafety(plan: ScanManipulatorPlan): DocumentCropSafety {
  const mapping = plan.debug.cardMapping;
  const cropAreaRatioOf = (): number | undefined => {
    const crop = plan.debug.cropRect;
    if (!crop) return undefined;
    const sourceArea = plan.debug.normalizedWidth * plan.debug.normalizedHeight;
    if (!(sourceArea > 0)) return undefined;
    return (crop.width * crop.height) / sourceArea;
  };

  if (!mapping || !mapping.cropValidated) {
    return {
      useCropForOcr: false,
      cropAreaRatio: cropAreaRatioOf(),
      cropDecision: 'skipped_geometry_uncertain',
    };
  }
  if (plan.cropInvalid || !plan.cropApplied || !plan.debug.cropRect) {
    return { useCropForOcr: false, cropDecision: 'rejected_invalid' };
  }
  return {
    useCropForOcr: true,
    cropAreaRatio: cropAreaRatioOf(),
    cropDecision: 'applied_verified',
  };
}

export function logCropDebug(info: CropDebugInfo): void {
  if (!__DEV__) return;
  runtimeLogger.debug(
    'CROP_DIAGNOSTIC',
    {
      status: 'completed',
      stage: 'capture',
      source: 'camera',
      width: info.normalizedWidth,
      height: info.normalizedHeight,
      documentType: info.documentType,
    },
    {
      photo: `${info.photoWidth}x${info.photoHeight}`,
      preview: `${info.previewWidth}x${info.previewHeight}`,
      overlay: info.overlayRect,
      normalized: `${info.normalizedWidth}x${info.normalizedHeight}`,
      alignRotation: info.alignRotation,
      readingRotation: info.readingRotation,
      cropRect: info.cropRect,
      cropApplied: info.cropApplied,
      cropInvalid: info.cropInvalid,
      documentType: info.documentType,
      cardOrientation: info.cardOrientation,
    }
  );
}

function logResizeDebug(context: string, plan: LongSideResizePlan): void {
  if (!__DEV__) return;
  runtimeLogger.debug(
    'IMAGE_RESIZE_DIAGNOSTIC',
    {
      status: 'completed',
      stage: 'capture',
      source: 'local',
      width: plan.output.width,
      height: plan.output.height,
    },
    {
      context,
      initial: `${plan.oriented.width}x${plan.oriented.height}`,
      final: `${plan.output.width}x${plan.output.height}`,
      scale: Number(plan.scale.toFixed(6)),
      orientation: plan.orientation,
      reason: plan.reason,
    }
  );
}

export async function getImageSize(
  uri: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      reject
    );
  });
}

/**
 * Dimensioni pixel reali per crop (ImageManipulator), non Image.getSize che su Android
 * può essere ~½ rispetto al JPEG (es. 1530×2040 vs 3060×4080) → crop fuori posto.
 */
export async function resolveCaptureBitmap(
  uri: string,
  meta?: { width?: number; height?: number },
  options: { forceManipulatorMeasurement?: boolean } = {},
): Promise<{ uri: string; width: number; height: number; exifNormalized: boolean }> {
  const metaW = meta?.width ?? 0;
  const metaH = meta?.height ?? 0;

  if (!options.forceManipulatorMeasurement && metaW > 0 && metaH > 0) {
    try {
      const rnSize = await getImageSize(uri);
      const driftW = Math.abs(rnSize.width - metaW) / metaW;
      const driftH = Math.abs(rnSize.height - metaH) / metaH;
      if (driftW < 0.03 && driftH < 0.03) {
        return { uri, width: metaW, height: metaH, exifNormalized: false };
      }
    } catch {
      /* serve pass manipolatore */
    }
  }

  const result = await ImageManipulator.manipulateAsync(uri, [], {
    compress: JPEG_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  const normalizedUri = requireDistinctImageOutputUri(uri, result.uri);

  const width = result.width || metaW || 0;
  const height = result.height || metaH || 0;
  if (width <= 0 || height <= 0) {
    const fallback = await getImageSize(normalizedUri);
    return {
      uri: normalizedUri,
      width: fallback.width,
      height: fallback.height,
      exifNormalized: true,
    };
  }

  if (__DEV__) {
    try {
      const rnSize = await getImageSize(uri);
      if (
        Math.abs(rnSize.width - width) > 2 ||
        Math.abs(rnSize.height - height) > 2
      ) {
        runtimeLogger.debug(
          'IMAGE_BITMAP_DIAGNOSTIC',
          {
            status: 'completed',
            stage: 'capture',
            source: 'local',
            width,
            height,
          },
          {
            reactNative: { width: rnSize.width, height: rnSize.height },
            manipulator: { width, height },
            metadata: metaW ? { width: metaW, height: metaH } : undefined,
          }
        );
      }
    } catch {
      /* opzionale */
    }
  }

  return { uri: normalizedUri, width, height, exifNormalized: true };
}

/** Ritaglia il crop ai pixel reali del JPEG (evita crash ImageManipulator su Android). */
export function clampCropAction(
  action: ImageManipulator.Action,
  bitmapWidth: number,
  bitmapHeight: number
): ImageManipulator.Action | null {
  return clampCropActionToBitmap(action, bitmapWidth, bitmapHeight);
}

export async function prepareFocusedOcrRegion(
  uri: string,
  box: { x: number; y: number; width: number; height: number },
  targetWidth = 1600,
): Promise<string> {
  const size = await getImageSize(uri);
  const padX = Math.max(6, Math.round(box.height * 0.45));
  const padY = Math.max(4, Math.round(box.height * 0.35));
  const originX = Math.max(0, Math.floor(box.x - padX));
  const originY = Math.max(0, Math.floor(box.y - padY));
  const width = Math.max(1, Math.min(size.width - originX, Math.ceil(box.width + padX * 2)));
  const height = Math.max(1, Math.min(size.height - originY, Math.ceil(box.height + padY * 2)));
  const upscaleWidth = Math.min(targetWidth, Math.max(width, Math.round(width * 6)));
  const actions: ImageManipulator.Action[] = [
    { crop: { originX, originY, width, height } },
  ];
  if (upscaleWidth > width) actions.push({ resize: { width: upscaleWidth } });
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: JPEG_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return result.uri;
}

/**
 * Variante ad alto contrasto per un piccolo crop OCR. E' usata soltanto come
 * terzo tentativo quando ML Kit confonde glifi molto simili (es. g/y) su testo
 * chiaro sopra sfondo scuro. Non modifica il contenuto semantico: trasforma
 * esclusivamente i pixel della stessa regione osservata.
 */
export async function prepareFocusedOcrHighContrastRegion(
  uri: string,
  box: { x: number; y: number; width: number; height: number },
  targetWidth = 2400,
): Promise<string> {
  const focusedUri = await prepareFocusedOcrRegion(uri, box, targetWidth);
  try {
    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) return focusedUri;
    const base64 = await FileSystem.readAsStringAsync(focusedUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const decoded = decode(base64ToUint8Array(base64), { useTArray: true });
    const data = decoded.data;
    let sum = 0;
    let samples = 0;
    const stride = Math.max(1, Math.floor((decoded.width * decoded.height) / 12000));
    for (let px = 0; px < decoded.width * decoded.height; px += stride) {
      const i = px * 4;
      sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      samples++;
    }
    const darkBackground = samples > 0 && sum / samples < 145;
    const output = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 4) {
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      let value = darkBackground ? 255 - lum : lum;
      value = Math.max(0, Math.min(255, Math.round((value - 128) * 1.9 + 128)));
      output[i] = value;
      output[i + 1] = value;
      output[i + 2] = value;
      output[i + 3] = 255;
    }
    const encoded = encode(
      { data: output, width: decoded.width, height: decoded.height },
      96,
    );
    const outputUri = `${cacheDir}focused-ocr-contrast-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    await FileSystem.writeAsStringAsync(outputUri, uint8ArrayToBase64(encoded.data), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return outputUri;
  } finally {
    // Il chiamante pulira' la variante finale. Il crop intermedio non serve piu'.
    void FileSystem.deleteAsync(focusedUri, { idempotent: true }).catch(() => undefined);
  }
}



function otsuThreshold(gray: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 127;
  let bestVariance = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

/**
 * Variante binaria del crop OCR. Usa soglia Otsu sui pixel della stessa riga
 * e serve soltanto come ulteriore lettura ottica di glifi piccoli. Nessuna
 * conoscenza di nomi, aziende o provider email entra nella trasformazione.
 */
export async function prepareFocusedOcrBinaryRegion(
  uri: string,
  box: { x: number; y: number; width: number; height: number },
  targetWidth = 2800,
  thresholdBias = 0,
  morphology: 'none' | 'thicken' | 'thin' = 'none',
): Promise<string> {
  const focusedUri = await prepareFocusedOcrRegion(uri, box, targetWidth);
  try {
    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) return focusedUri;
    const base64 = await FileSystem.readAsStringAsync(focusedUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const decoded = decode(base64ToUint8Array(base64), { useTArray: true });
    const pixels = decoded.width * decoded.height;
    const gray = new Uint8Array(pixels);
    let sum = 0;
    for (let px = 0; px < pixels; px++) {
      const i = px * 4;
      const lum = Math.round(decoded.data[i] * 0.299 + decoded.data[i + 1] * 0.587 + decoded.data[i + 2] * 0.114);
      gray[px] = lum;
      sum += lum;
    }
    const darkBackground = pixels > 0 && sum / pixels < 145;
    if (darkBackground) {
      for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
    }
    const threshold = Math.max(32, Math.min(223, otsuThreshold(gray) + thresholdBias));
    const binary = new Uint8Array(pixels);
    for (let px = 0; px < pixels; px++) binary[px] = gray[px] >= threshold ? 255 : 0;

    // Piccola morfologia 3x3, usata solo su crop OCR della stessa riga.
    // "thicken" espande leggermente i tratti neri, "thin" li assottiglia:
    // entrambe sono riletture dei pixel, non correzioni semantiche.
    const shaped = morphology === 'none' ? binary : new Uint8Array(pixels);
    if (morphology !== 'none') {
      for (let y = 0; y < decoded.height; y++) {
        for (let x = 0; x < decoded.width; x++) {
          let value = morphology === 'thicken' ? 255 : 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= decoded.height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= decoded.width) continue;
              const sample = binary[yy * decoded.width + xx];
              if (morphology === 'thicken') value = Math.min(value, sample);
              else value = Math.max(value, sample);
            }
          }
          shaped[y * decoded.width + x] = value;
        }
      }
    }

    const output = new Uint8Array(decoded.data.length);
    for (let px = 0; px < pixels; px++) {
      const value = shaped[px];
      const i = px * 4;
      output[i] = value;
      output[i + 1] = value;
      output[i + 2] = value;
      output[i + 3] = 255;
    }
    const encoded = encode({ data: output, width: decoded.width, height: decoded.height }, 100);
    const outputUri = `${cacheDir}focused-ocr-binary-${morphology}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    await FileSystem.writeAsStringAsync(outputUri, uint8ArrayToBase64(encoded.data), {
      encoding: FileSystem.EncodingType.Base64,
    });
    return outputUri;
  } finally {
    void FileSystem.deleteAsync(focusedUri, { idempotent: true }).catch(() => undefined);
  }
}

export async function rotateImage(uri: string, degrees: number): Promise<string> {
  if (degrees === 0) return uri;
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ rotate: degrees }],
    { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
  );
  return requireDistinctImageOutputUri(uri, result.uri);
}

export interface NormalizedCapturedDocumentOrientation {
  normalizedUri: string;
  normalizedWidth: number;
  normalizedHeight: number;
  rotationApplied: 0 | 90 | 180 | 270;
  orientation: DocumentPageCaptureMetadata['normalizedOrientation'];
  normalizationReason: DocumentPageCaptureMetadata['normalizationReason'];
  metadata: DocumentPageCaptureMetadata;
  normalizationFailed: boolean;
}

const LANDSCAPE_INK_BAND_SAMPLE_WIDTH = 480;

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return globalThis.btoa(binary);
}

async function neutralizeStaleProcessedJpegExif(uri: string): Promise<{
  uri: string;
  previous: number | null;
  changed: boolean;
}> {
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) {
    return { uri, previous: null, changed: false };
  }
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const rewritten = setJpegExifOrientation(base64ToUint8Array(base64), 1);
  if (!rewritten.changed) {
    return { uri, previous: rewritten.previous, changed: false };
  }
  const outputUri = `${cacheDir}orient-exif1-${Date.now()}.jpg`;
  await FileSystem.writeAsStringAsync(outputUri, uint8ArrayToBase64(rewritten.bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return { uri: outputUri, previous: rewritten.previous, changed: true };
}

function rgbaToGray(data: Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }
  return gray;
}

async function sampleLandscapeInkBandsFromUri(
  uri: string,
  width: number,
  height: number,
): Promise<ReturnType<typeof measureLandscapeInkBandsFromGray> | null> {
  const resizePlan = planLongSideResize(width, height, LANDSCAPE_INK_BAND_SAMPLE_WIDTH);
  const actions: ImageManipulator.Action[] = resizePlan.action ? [resizePlan.action] : [];
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: 1,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (!result.base64) return null;
  try {
    const decoded = decode(base64ToUint8Array(result.base64), { useTArray: true });
    const gray = rgbaToGray(decoded.data, decoded.width, decoded.height);
    return measureLandscapeInkBandsFromGray(gray, decoded.width, decoded.height);
  } catch {
    return null;
  }
}

async function resolveLandscapeUpsideDownFromImage(
  uri: string,
  width: number,
  height: number,
  input: DocumentOrientationNormalizationInput,
  planRotation: 0 | 90 | 180 | 270,
): Promise<{ correction: 0 | 180; probeEligible: boolean }> {
  const probeEligible = needsLandscapeUpsideDownProbe(input, {
    normalizedWidth: width,
    normalizedHeight: height,
    rotationRequired: 0,
    rotationApplied: planRotation,
    orientation: input.deviceOrientationAtCapture,
    normalizationReason: 'camera_processing_applied',
    preserveOriginalUntilComplete: true,
    allowUpscale: false,
  });
  if (!probeEligible) {
    return { correction: 0, probeEligible: false };
  }
  const bands = await sampleLandscapeInkBandsFromUri(uri, width, height);
  if (!bands) {
    return { correction: 0, probeEligible: true };
  }
  const score0 = scoreLandscapeHeaderAtTop(bands);
  const score180 = scoreLandscapeHeaderAtTop(mirroredLandscapeInkBands(bands));
  const correction = resolveLandscapeUpsideDownCorrection(bands);
  logOrientationCapture(
    orientationSnapshotFromInput(input, {
      plannedRotation: planRotation,
      probeEligible: true,
      finalReason: 'ink_probe',
      ...inkProbeLogFields(bands, score0, score180),
    }),
  );
  return { correction, probeEligible: true };
}


async function resolvePortraitUpsideDownFromImage(
  uri: string,
  width: number,
  height: number,
  input: DocumentOrientationNormalizationInput,
): Promise<{ correction: 0 | 180; probeEligible: boolean }> {
  const probePlan: DocumentOrientationNormalizationPlan = {
    normalizedWidth: width,
    normalizedHeight: height,
    rotationRequired: 0,
    rotationApplied: 0,
    orientation: input.deviceOrientationAtCapture,
    normalizationReason: 'camera_processing_applied',
    preserveOriginalUntilComplete: true,
    allowUpscale: false,
  };
  const probeEligible = needsPortraitUpsideDownProbe(input, probePlan);
  if (!probeEligible) return { correction: 0, probeEligible: false };

  const bands = await sampleLandscapeInkBandsFromUri(uri, width, height);
  if (!bands) return { correction: 0, probeEligible: true };

  const correction = resolvePortraitUpsideDownCorrection(bands);
  const score0 = scoreLandscapeHeaderAtTop(bands);
  const score180 = scoreLandscapeHeaderAtTop(mirroredLandscapeInkBands(bands));
  logOrientationCapture(
    orientationSnapshotFromInput(input, {
      plannedRotation: correction,
      probeEligible: true,
      finalReason: correction === 180
        ? 'portrait_reading_order_correction'
        : 'portrait_reading_order_unchanged',
      ...inkProbeLogFields(bands, score0, score180),
      orientationDecision: correction === 180 ? 'confident' : 'ambiguous',
    }),
  );
  return { correction, probeEligible: true };
}

async function samplePortraitQuarterTurnBandsFromUri(
  uri: string,
  width: number,
  height: number,
  rotation: 90 | 270,
): Promise<ReturnType<typeof measurePortraitQuarterTurnBandsFromGray> | null> {
  const resizePlan = planLongSideResize(width, height, LANDSCAPE_INK_BAND_SAMPLE_WIDTH);
  const actions: ImageManipulator.Action[] = resizePlan.action ? [resizePlan.action] : [];
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: 1,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (!result.base64) return null;
  try {
    const decoded = decode(base64ToUint8Array(result.base64), { useTArray: true });
    const gray = rgbaToGray(decoded.data, decoded.width, decoded.height);
    return measurePortraitQuarterTurnBandsFromGray(gray, decoded.width, decoded.height, rotation);
  } catch {
    return null;
  }
}

async function resolvePortraitQuarterTurnFromImage(
  uri: string,
  width: number,
  height: number,
  input: DocumentOrientationNormalizationInput,
  session?: DocumentOrientationSessionContext,
): Promise<import('./document-orientation-evidence').PortraitQuarterTurnDecision> {
  const [bands90, bands270] = await Promise.all([
    samplePortraitQuarterTurnBandsFromUri(uri, width, height, 90),
    samplePortraitQuarterTurnBandsFromUri(uri, width, height, 270),
  ]);
  if (!bands90 || !bands270) {
    return { rotation: 90, confidence: 'ambiguous' };
  }
  const decision = resolvePortraitQuarterTurnRotation(bands90, bands270, session);
  logOrientationCapture(
    orientationSnapshotFromInput(input, {
      plannedRotation: decision.rotation,
      probeEligible: true,
      finalReason: decision.confidence === 'ambiguous'
        ? 'portrait_quarter_turn_ambiguous'
        : 'portrait_quarter_turn_probe',
      ...inkProbeLogFields(bands90, scoreLandscapeHeaderAtTop(bands90), scoreLandscapeHeaderAtTop(bands270)),
      portraitQuarterTurnChosen: decision.rotation,
      orientationDecision: decision.confidence,
    }),
  );
  return decision;
}

async function sampleGrayFromUri(
  uri: string,
  width: number,
  height: number,
): Promise<{ gray: Uint8Array; width: number; height: number } | null> {
  const resizePlan = planLongSideResize(width, height, LANDSCAPE_INK_BAND_SAMPLE_WIDTH);
  const actions: ImageManipulator.Action[] = resizePlan.action ? [resizePlan.action] : [];
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: 1,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (!result.base64) return null;
  try {
    const decoded = decode(base64ToUint8Array(result.base64), { useTArray: true });
    return {
      gray: rgbaToGray(decoded.data, decoded.width, decoded.height),
      width: decoded.width,
      height: decoded.height,
    };
  } catch {
    return null;
  }
}

const BUSINESS_CARD_BOUNDARY_ANALYSIS_LONG_SIDE = 720;
const BUSINESS_CARD_FOREGROUND_OCR_LONG_SIDE = 900;

export interface BusinessCardBoundaryRefinementResult {
  uri: string;
  applied: boolean;
  detection: BusinessCardBoundaryDetection | null;
  mode: 'none' | 'rectangle_crop' | 'foreground_bbox';
}

async function writeForegroundBoundingBoxSample(
  data: Uint8Array,
  width: number,
  height: number,
  foreground: BusinessCardForegroundDetection,
): Promise<string | null> {
  const rect = foreground.tightRect ?? foreground.rect;
  const inset = Math.max(1, Math.round(Math.min(rect.width, rect.height) * 0.004));
  const x1 = Math.max(0, Math.floor(rect.x + inset));
  const y1 = Math.max(0, Math.floor(rect.y + inset));
  const x2 = Math.min(width, Math.ceil(rect.x + rect.width - inset));
  const y2 = Math.min(height, Math.ceil(rect.y + rect.height - inset));
  const outWidth = x2 - x1;
  const outHeight = y2 - y1;
  if (outWidth <= 0 || outHeight <= 0) return null;

  const output = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    const srcStart = ((y1 + y) * width + x1) * 4;
    const srcEnd = srcStart + outWidth * 4;
    output.set(data.subarray(srcStart, srcEnd), y * outWidth * 4);
  }
  const encoded = encode(
    { data: output, width: outWidth, height: outHeight },
    Math.max(80, Math.min(100, Math.round(JPEG_QUALITY * 100))),
  );
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) return null;
  const outputUri = `${cacheDir}card-foreground-box-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  await FileSystem.writeAsStringAsync(outputUri, uint8ArrayToBase64(encoded.data), {
    encoding: FileSystem.EncodingType.Base64,
  });
  return outputUri;
}

function canUseForegroundBoundingBox(foreground: BusinessCardForegroundDetection): boolean {
  // Il bbox e un fallback conservativo, ma deve comunque derivare da una
  // detection forte: un componente interno ampio non deve autorizzare crop.
  return foreground.confidence >= 0.86 && foreground.areaRatio >= 0.58;
}

/**
 * Il rettangolo fisico può includere 1-2 colonne di sfondo nero lungo il bordo.
 * Rifiliamo soltanto una fascia quasi uniforme e quasi nera se subito all'interno
 * torna il contenuto della carta: in questo modo una carta realmente nera non
 * viene mai accorciata.
 */
function trimUniformNearBlackRectangleEdges(
  gray: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  rect: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(imageWidth, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(imageHeight, Math.ceil(rect.y + rect.height));
  const maxTrim = Math.max(1, Math.min(18, Math.floor(Math.min(x1 - x0, y1 - y0) * 0.025)));
  const bandStats = (left: number, top: number, right: number, bottom: number) => {
    let dark = 0;
    let sum = 0;
    let count = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const value = gray[y * imageWidth + x] ?? 255;
      sum += value;
      if (value < 34) dark++;
      count++;
    }
    return { darkRatio: count ? dark / count : 0, mean: count ? sum / count : 255 };
  };
  const trimSide = (edge: 'left' | 'right' | 'top' | 'bottom') => {
    for (let amount = maxTrim; amount >= 1; amount--) {
      const band = edge === 'left' ? bandStats(x0, y0, x0 + amount, y1)
        : edge === 'right' ? bandStats(x1 - amount, y0, x1, y1)
        : edge === 'top' ? bandStats(x0, y0, x1, y0 + amount)
        : bandStats(x0, y1 - amount, x1, y1);
      const inner = edge === 'left' ? bandStats(x0 + amount, y0, Math.min(x1, x0 + amount * 2), y1)
        : edge === 'right' ? bandStats(Math.max(x0, x1 - amount * 2), y0, x1 - amount, y1)
        : edge === 'top' ? bandStats(x0, y0 + amount, x1, Math.min(y1, y0 + amount * 2))
        : bandStats(x0, Math.max(y0, y1 - amount * 2), x1, y1 - amount);
      if (band.darkRatio >= 0.94 && band.mean < 28 && (inner.darkRatio < 0.82 || inner.mean > 48)) return amount;
    }
    return 0;
  };
  const left = trimSide('left');
  const right = trimSide('right');
  const top = trimSide('top');
  const bottom = trimSide('bottom');
  return { x: x0 + left, y: y0 + top, width: Math.max(1, x1 - x0 - left - right), height: Math.max(1, y1 - y0 - top - bottom) };
}

/**
 * Secondo stadio del crop business-card: cerca i bordi fisici del cartoncino
 * dentro il crop della cornice. Se i quattro bordi non sono affidabili non
 * inventa coordinate e non autorizza OCR sul contenuto ambiguo.
 */
export async function refineBusinessCardBoundary(
  uri: string,
): Promise<BusinessCardBoundaryRefinementResult> {
  const sourceSize = await getImageSize(uri);
  const resizePlan = planLongSideResize(
    sourceSize.width,
    sourceSize.height,
    BUSINESS_CARD_BOUNDARY_ANALYSIS_LONG_SIDE,
  );
  const actions: ImageManipulator.Action[] = resizePlan.action ? [resizePlan.action] : [];
  const sampled = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: 1,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (!sampled.base64) {
    return { uri, applied: false, detection: null, mode: 'none' };
  }

  let refinementStage = 'analysis_decode';
  try {
    const decoded = decode(base64ToUint8Array(sampled.base64), { useTArray: true });
    const gray = rgbaToGray(decoded.data, decoded.width, decoded.height);
    const rectangleDetection = detectBusinessCardBoundaryFromGray(
      gray,
      decoded.width,
      decoded.height,
    );

    if (!rectangleDetection) {
      refinementStage = 'foreground_sample';
      // Supporti sagomati: la maschera deve essere generata PRIMA dell'OCR.
      // 900 px mantiene piu dettaglio del solo probe 720 px ma evita il costo
      // quadratico e i picchi memoria osservati sul telefono con l'encode JS a
      // 1200 px. Se l'encode a 900 fallisce, ritentiamo sul probe 720 gia in
      // memoria: non torniamo direttamente al crop overlay contaminato.
      const foregroundResize = planLongSideResize(
        sourceSize.width,
        sourceSize.height,
        BUSINESS_CARD_FOREGROUND_OCR_LONG_SIDE,
      );
      const foregroundActions: ImageManipulator.Action[] = foregroundResize.action
        ? [foregroundResize.action]
        : [];
      const foregroundSampled = await ImageManipulator.manipulateAsync(
        uri,
        foregroundActions,
        {
          compress: 1,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        },
      );
      refinementStage = 'foreground_decode';
      const foregroundDecoded = foregroundSampled.base64
        ? decode(base64ToUint8Array(foregroundSampled.base64), { useTArray: true })
        : decoded;
      refinementStage = 'foreground_detect';
      const foreground = detectBusinessCardForegroundBoundsFromRgba(
        foregroundDecoded.data,
        foregroundDecoded.width,
        foregroundDecoded.height,
      );

      if (!foreground) {
        return { uri, applied: false, detection: null, mode: 'none' };
      }

      const foregroundDetection: BusinessCardBoundaryDetection = {
        rect: foreground.rect,
        confidence: foreground.confidence,
        areaRatio: foreground.areaRatio,
        edgeScores: { top: 0, right: 0, bottom: 0, left: 0 },
      };

      try {
        // Una mask a blocchi può classificare la grafica chiara del biglietto
        // come sfondo e cancellare lettere/pixel in modo irreversibile. Il
        // bounding-box conserva invece ogni pixel interno al rettangolo.
        if (canUseForegroundBoundingBox(foreground)) {
          refinementStage = 'foreground_bbox_primary_write';
          const bboxUri = await writeForegroundBoundingBoxSample(
            foregroundDecoded.data,
            foregroundDecoded.width,
            foregroundDecoded.height,
            foreground,
          );
          if (bboxUri) {
            return {
              uri: bboxUri,
              applied: true,
              detection: foregroundDetection,
              mode: 'foreground_bbox',
            };
          }
        } else {
          console.warn('[BusinessCardBoundary] foreground_component_rejected', {
            density: foreground.density,
            areaRatio: foreground.areaRatio,
          });
          return { uri, applied: false, detection: null, mode: 'none' };
        }
      } catch (error) {
        console.warn('[BusinessCardBoundary] foreground_primary_write_failed', {
          mode: 'foreground_bbox',
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Fail-soft GENERICO: se il writer della maschera a risoluzione OCR ha
      // problemi di memoria/encode sul dispositivo, usa il campione 720 px che
      // abbiamo gia decodificato. La priorita P0 e non consegnare a ML Kit lo
      // sfondo esterno quando il supporto dominante e stato dimostrato.
      if (
        foregroundDecoded.width !== decoded.width ||
        foregroundDecoded.height !== decoded.height
      ) {
        refinementStage = 'foreground_fallback_detect';
        const fallbackForeground = detectBusinessCardForegroundBoundsFromRgba(
          decoded.data,
          decoded.width,
          decoded.height,
        );
        if (fallbackForeground) {
          try {
            if (!canUseForegroundBoundingBox(fallbackForeground)) {
              console.warn('[BusinessCardBoundary] foreground_fallback_component_rejected', {
                density: fallbackForeground.density,
                areaRatio: fallbackForeground.areaRatio,
              });
              return { uri, applied: false, detection: null, mode: 'none' };
            }
            refinementStage = 'foreground_bbox_fallback_write';
            const fallbackUri = await writeForegroundBoundingBoxSample(
              decoded.data,
              decoded.width,
              decoded.height,
              fallbackForeground,
            );
            if (fallbackUri) {
              return {
                uri: fallbackUri,
                applied: true,
                detection: {
                  rect: fallbackForeground.rect,
                  confidence: fallbackForeground.confidence,
                  areaRatio: fallbackForeground.areaRatio,
                  edgeScores: { top: 0, right: 0, bottom: 0, left: 0 },
                },
                mode: 'foreground_bbox',
              };
            }
          } catch (error) {
            console.warn('[BusinessCardBoundary] foreground_fallback_write_failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return { uri, applied: false, detection: null, mode: 'none' };
    }

    refinementStage = 'rectangle_crop';
    const trimmedRect = trimUniformNearBlackRectangleEdges(
      gray,
      decoded.width,
      decoded.height,
      rectangleDetection.rect,
    );
    const scaleX = sourceSize.width / decoded.width;
    const scaleY = sourceSize.height / decoded.height;
    const crop = {
      originX: Math.max(0, Math.round(trimmedRect.x * scaleX)),
      originY: Math.max(0, Math.round(trimmedRect.y * scaleY)),
      width: Math.max(1, Math.round(trimmedRect.width * scaleX)),
      height: Math.max(1, Math.round(trimmedRect.height * scaleY)),
    };
    crop.width = Math.min(crop.width, sourceSize.width - crop.originX);
    crop.height = Math.min(crop.height, sourceSize.height - crop.originY);

    const refinedUri = await manipulateJpeg(
      uri,
      [{ crop }],
      sourceSize.width,
      sourceSize.height,
    );
    return {
      uri: refinedUri,
      applied: true,
      detection: rectangleDetection,
      mode: 'rectangle_crop',
    };
  } catch (error) {
    runtimeLogger.warn('CROP_DIAGNOSTIC', {
      source: 'camera',
      stage: 'capture',
      status: 'failed',
    });
    console.warn('[BusinessCardBoundary] refinement_exception', { stage: refinementStage });
    return { uri, applied: false, detection: null, mode: 'none' };
  }
}

async function resolveProcessedVisualFromImage(
  uri: string,
  width: number,
  height: number,
  targetAspect: 'landscape' | 'portrait',
): Promise<VisualOrientationDecision> {
  const sampled = await sampleGrayFromUri(uri, width, height);
  if (!sampled) {
    return {
      rotation: 0,
      confidence: 'ambiguous',
      scores: { 0: 0, 90: 0, 180: 0, 270: 0 },
      lockSameAxis: false,
      sameAxisClear: false,
      eligibleAxis: '0-180',
    };
  }
  return resolveProcessedVisualOrientation(sampled.gray, sampled.width, sampled.height, targetAspect);
}

export interface NormalizedDocumentReadingOrientation {
  normalizedUri: string;
  normalizedWidth: number;
  normalizedHeight: number;
  rotationApplied: 0 | 90 | 180 | 270;
  confidence: VisualOrientationDecision['confidence'];
}

function visualDecisionStrength(decision: VisualOrientationDecision): number {
  const scores = Object.values(decision.scores).filter((value) => Number.isFinite(value));
  if (scores.length < 2) return 0;
  scores.sort((left, right) => right - left);
  return scores[0] - scores[1];
}

/**
 * Ultimo controllo sull'immagine realmente mostrata e usata per OCR.
 *
 * Il crop e' gia' concluso: qui viene verificato esclusivamente
 * l'ordine di lettura dei pixel, senza modificare il rettangolo di crop.
 * Una rotazione viene applicata solo quando l'evidenza visuale e'
 * sufficientemente affidabile; in caso ambiguo l'immagine resta invariata.
 */
export async function normalizeDocumentReadingOrientation(
  uri: string,
  width: number,
  height: number,
): Promise<NormalizedDocumentReadingOrientation> {
  const currentAspect: 'landscape' | 'portrait' = width >= height ? 'landscape' : 'portrait';
  const alternateAspect: 'landscape' | 'portrait' = currentAspect === 'landscape' ? 'portrait' : 'landscape';

  try {
    const [current, alternate] = await Promise.all([
      resolveProcessedVisualFromImage(uri, width, height, currentAspect),
      resolveProcessedVisualFromImage(uri, width, height, alternateAspect),
    ]);
    const candidates = [
      { decision: current, preferredAxis: true },
      { decision: alternate, preferredAxis: false },
    ].filter(({ decision }) => decision.confidence === 'confident');

    candidates.sort((left, right) => {
      const strengthDelta = visualDecisionStrength(right.decision) - visualDecisionStrength(left.decision);
      if (Math.abs(strengthDelta) > 0.0001) return strengthDelta;
      return Number(right.preferredAxis) - Number(left.preferredAxis);
    });

    const chosen = candidates[0]?.decision;
    if (!chosen || chosen.rotation === 0) {
      return {
        normalizedUri: uri,
        normalizedWidth: width,
        normalizedHeight: height,
        rotationApplied: 0,
        confidence: chosen?.confidence ?? 'ambiguous',
      };
    }

    const normalizedUri = await rotateImage(uri, chosen.rotation);
    const swapsAxis = chosen.rotation === 90 || chosen.rotation === 270;
    const normalizedWidth = swapsAxis ? height : width;
    const normalizedHeight = swapsAxis ? width : height;
    logCameraOrientation('reading_orientation_correction', {
      requestedRotation: chosen.rotation,
      pixelRotate: true,
      inputUri: uri,
      outputUri: normalizedUri,
      width: normalizedWidth,
      height: normalizedHeight,
      confidence: chosen.confidence,
      currentAspect,
      selectedStrength: visualDecisionStrength(chosen),
    });
    return {
      normalizedUri,
      normalizedWidth,
      normalizedHeight,
      rotationApplied: chosen.rotation,
      confidence: chosen.confidence,
    };
  } catch (error) {
    runtimeLogger.error('DOCUMENT_READING_ORIENTATION_PROBE_FAILED', error, {
      source: 'camera',
      stage: 'capture',
      status: 'failed',
      width,
      height,
    });
    return {
      normalizedUri: uri,
      normalizedWidth: width,
      normalizedHeight: height,
      rotationApplied: 0,
      confidence: 'ambiguous',
    };
  }
}

export async function normalizeCapturedDocumentOrientation(
  imageUri: string,
  input: DocumentOrientationNormalizationInput,
  snapshot: Partial<import('./orientation-capture-log').OrientationCaptureSnapshot> = {},
  session?: DocumentOrientationSessionContext,
): Promise<NormalizedCapturedDocumentOrientation> {
  let plan = planCapturedDocumentOrientation(input);
  let visualProbed = false;
  const deterministic = resolveDeterministicCaptureOrientation(input);
  if (deterministic) {
    plan = applyDeterministicCaptureOrientation(plan, input, deterministic.rotation);
    visualProbed = true;
    logOrientationCapture(
      orientationSnapshotFromInput(input, {
        ...snapshot,
        plannedRotation: plan.rotationRequired,
        probeEligible: false,
        finalRotation: plan.rotationRequired,
        finalReason: 'deterministic_capture_orientation',
        orientationDecision: 'confident',
        captureOrientationKey: capturedOrientationKeyLabel(deterministic.key),
      }),
    );
  }
  if (!visualProbed && needsProcessedVisualOrientationProbe(input, plan)) {
    try {
      const targetAspect =
        plan.orientation === 'landscape-left' || plan.orientation === 'landscape-right'
          ? 'landscape'
          : 'portrait';
      const decision = await resolveProcessedVisualFromImage(
        imageUri,
        input.width,
        input.height,
        targetAspect,
      );
      const applied = applyProcessedVisualOrientationDecision(plan, input, decision);
      visualProbed = applied.visualComplete;
      plan = applied.plan;
      logOrientationCapture(
        orientationSnapshotFromInput(input, {
          ...snapshot,
          plannedRotation: decision.rotation,
          probeEligible: true,
          finalRotation: applied.plan.rotationRequired,
          finalReason: applied.visualComplete
            ? 'processed_visual_orientation_probe'
            : 'processed_visual_orientation_ambiguous',
          orientationDecision: decision.confidence,
        }),
      );
    } catch (error) {
      runtimeLogger.error('PROCESSED_VISUAL_ORIENTATION_PROBE_FAILED', error, {
        source: 'camera',
        stage: 'capture',
        status: 'failed',
        width: input.width,
        height: input.height,
      });
    }
  }
  if (!visualProbed && needsLandscapeAspectMismatchProbe(input, plan)) {
    try {
      const decision = await resolvePortraitQuarterTurnFromImage(
        imageUri,
        input.width,
        input.height,
        input,
        session,
      );
      if (decision.confidence === 'confident') {
        const normalized = {
          width: input.height,
          height: input.width,
        };
        plan = {
          ...plan,
          rotationRequired: decision.rotation,
          rotationApplied: decision.rotation,
          normalizedWidth: normalized.width,
          normalizedHeight: normalized.height,
          normalizationReason: 'landscape_aspect_mismatch_probe',
        };
        logOrientationCapture(
          orientationSnapshotFromInput(input, {
            ...snapshot,
            plannedRotation: plan.rotationRequired,
            probeEligible: true,
            finalRotation: plan.rotationRequired,
            finalReason: 'landscape_aspect_mismatch_probe',
            portraitQuarterTurnChosen: decision.rotation,
            orientationDecision: decision.confidence,
          }),
        );
      }
    } catch (error) {
      runtimeLogger.error('LANDSCAPE_ASPECT_MISMATCH_PROBE_FAILED', error, {
        source: 'camera',
        stage: 'capture',
        status: 'failed',
        width: input.width,
        height: input.height,
      });
    }
  }
  if (!visualProbed && needsPortraitQuarterTurnProbe(input, plan)) {
    try {
      const decision = await resolvePortraitQuarterTurnFromImage(
        imageUri,
        input.width,
        input.height,
        input,
        session,
      );
      if (decision.confidence === 'confident' && (decision.rotation === 90 || decision.rotation === 270)) {
        const normalized = {
          width: input.height,
          height: input.width,
        };
        plan = {
          ...plan,
          rotationRequired: decision.rotation,
          rotationApplied: decision.rotation,
          normalizedWidth: normalized.width,
          normalizedHeight: normalized.height,
          normalizationReason: 'device_orientation_alignment',
        };
        visualProbed = true;
      }
    } catch (error) {
      runtimeLogger.error('PORTRAIT_QUARTER_TURN_PROBE_FAILED', error, {
        source: 'camera',
        stage: 'capture',
        status: 'failed',
        width: input.width,
        height: input.height,
      });
    }
  }
  if (!visualProbed && needsPortraitUpsideDownProbe(input, plan)) {
    try {
      const probe = await resolvePortraitUpsideDownFromImage(
        imageUri,
        input.width,
        input.height,
        input,
      );
      if (probe.correction === 180) {
        plan = {
          ...plan,
          rotationRequired: 180,
          rotationApplied: 180,
          normalizedWidth: input.width,
          normalizedHeight: input.height,
          normalizationReason: 'device_orientation_alignment',
        };
        visualProbed = true;
        logOrientationCapture(
          orientationSnapshotFromInput(input, {
            ...snapshot,
            plannedRotation: 180,
            probeEligible: probe.probeEligible,
            finalRotation: 180,
            finalReason: 'portrait_reading_order_correction',
            orientationDecision: 'confident',
          }),
        );
      }
    } catch (error) {
      runtimeLogger.error('DOCUMENT_READING_ORIENTATION_PROBE_FAILED', error, {
        source: 'camera',
        stage: 'capture',
        status: 'failed',
        width: input.width,
        height: input.height,
      });
    }
  }

  logOrientationCapture(
    orientationSnapshotFromInput(input, {
      ...snapshot,
      plannedRotation: plan.rotationRequired,
      probeEligible:
        needsPortraitUpsideDownProbe(input, plan) ||
        needsLandscapeUpsideDownProbe(input, plan),
      finalReason: plan.normalizationReason,
    }),
  );

  if (!visualProbed && needsLandscapeUpsideDownProbe(input, plan)) {
    try {
      const probe = await resolveLandscapeUpsideDownFromImage(
        imageUri,
        input.width,
        input.height,
        input,
        plan.rotationApplied,
      );
      plan = applyLandscapeReadingOrderCorrection(plan, probe.correction);
      logOrientationCapture(
        orientationSnapshotFromInput(input, {
          ...snapshot,
          plannedRotation: plan.rotationRequired,
          probeEligible: probe.probeEligible,
          finalRotation: plan.rotationRequired,
          finalReason: probe.correction === 180
            ? 'landscape_reading_order_correction'
            : plan.normalizationReason,
        }),
      );
    } catch (error) {
      runtimeLogger.error('LANDSCAPE_READING_ORDER_PROBE_FAILED', error, {
        source: 'camera',
        stage: 'capture',
        status: 'failed',
        width: input.width,
        height: input.height,
      });
    }
  }
  if (plan.rotationRequired === 0) {
    let normalizedUri = imageUri;
    if (staleProcessedExifRequiresRewrite(input, plan)) {
      try {
        const rewritten = await neutralizeStaleProcessedJpegExif(imageUri);
        logCameraOrientation('manipulation', {
          requestedRotation: 0,
          pixelRotate: false,
          exifRewriteTo: 1,
          previousExif: rewritten.previous,
          changed: rewritten.changed,
          inputUri: imageUri,
          outputUri: rewritten.uri,
          width: plan.normalizedWidth,
          height: plan.normalizedHeight,
        });
        if (rewritten.changed) normalizedUri = rewritten.uri;
      } catch (error) {
        runtimeLogger.error('CAMERA_CAPTURE_DIAGNOSTIC', error, {
          source: 'camera',
          stage: 'capture',
          status: 'failed',
          width: input.width,
          height: input.height,
        });
      }
    } else {
      logCameraOrientation('manipulation', {
        requestedRotation: 0,
        pixelRotate: false,
        exifRewriteTo: null,
        inputUri: imageUri,
        outputUri: imageUri,
        width: plan.normalizedWidth,
        height: plan.normalizedHeight,
      });
    }
    return {
      normalizedUri,
      normalizedWidth: plan.normalizedWidth,
      normalizedHeight: plan.normalizedHeight,
      rotationApplied: plan.rotationApplied,
      orientation: plan.orientation,
      normalizationReason: plan.normalizationReason,
      metadata: pageCaptureMetadata(input, plan),
      normalizationFailed: false,
    };
  }

  try {
    const normalizedUri = await rotateImage(imageUri, plan.rotationRequired);
    logCameraOrientation('manipulation', {
      requestedRotation: plan.rotationRequired,
      pixelRotate: true,
      inputUri: imageUri,
      outputUri: normalizedUri,
      width: plan.normalizedWidth,
      height: plan.normalizedHeight,
    });
    return {
      normalizedUri,
      normalizedWidth: plan.normalizedWidth,
      normalizedHeight: plan.normalizedHeight,
      rotationApplied: plan.rotationApplied,
      orientation: plan.orientation,
      normalizationReason: plan.normalizationReason,
      metadata: pageCaptureMetadata(input, plan),
      normalizationFailed: false,
    };
  } catch (error) {
    runtimeLogger.error('DOCUMENT_ORIENTATION_NORMALIZATION_FAILED', error, {
      source: 'camera',
      stage: 'capture',
      status: 'failed',
      width: input.width,
      height: input.height,
    });
    const fallbackPlan = {
      ...plan,
      normalizedWidth: input.width,
      normalizedHeight: input.height,
      rotationRequired: 0 as const,
      rotationApplied: 0 as const,
      normalizationReason: 'normalization_failed_original_preserved' as const,
    };
    return {
      normalizedUri: imageUri,
      normalizedWidth: input.width,
      normalizedHeight: input.height,
      rotationApplied: 0,
      orientation: fallbackPlan.orientation,
      normalizationReason: fallbackPlan.normalizationReason,
      metadata: pageCaptureMetadata(input, fallbackPlan),
      normalizationFailed: true,
    };
  }
}

/**
 * Allinea l'orientamento foto alla preview (EXIF Android).
 * Ritorna 90° solo quando schermo portrait e sensore landscape.
 */
export function getPreviewAlignRotation(
  photoWidth: number,
  photoHeight: number,
  screenWidth: number,
  screenHeight: number
): number {
  const screenPortrait = screenHeight >= screenWidth;
  const photoLandscape = photoWidth > photoHeight;
  if (Platform.OS === 'android' && screenPortrait && photoLandscape) {
    return 90;
  }
  return 0;
}

function buildPhotoMappingOptions(
  planOptions?: ScanPlanOptions
): MapScreenToPhotoOptions {
  const stream = parseStreamSize(planOptions?.previewStreamSize);
  return {
    scaleMode: planOptions?.previewScaleMode ?? previewScaleModeForRatio(CAMERA_PREVIEW_RATIO),
    previewStreamWidth: stream?.width,
    previewStreamHeight: stream?.height,
  };
}

export function scanPlanOptionsFromDiag(
  diag: CameraResolutionDiag | null,
  photoWidth?: number,
  photoHeight?: number
): ScanPlanOptions {
  const stream = parseStreamSize(diag?.previewStreamSize);
  let previewStreamSize = diag?.previewStreamSize;

  if (stream && photoWidth && photoHeight && photoWidth > 0 && photoHeight > 0) {
    // Uno stream col rapporto reciproco usa gli assi del sensore, mentre il
    // bitmap è già normalizzato EXIF: il mapper non ruota quegli assi.
    // Manteniamo invece rapporti diversi ma con lo stesso orientamento
    // (es. preview 16:9 e capture 4:3), necessari alla compensazione FOV.
    const photoLandscape = photoWidth >= photoHeight;
    const streamLandscape = stream.width >= stream.height;
    if (photoLandscape !== streamLandscape) {
      previewStreamSize = `${stream.height}x${stream.width}`;
    }
  }

  return {
    previewScaleMode: previewScaleModeForRatio(CAMERA_PREVIEW_RATIO),
    previewStreamSize,
    imageCaptureSize: diag?.imageCaptureSize,
  };
}

function getScreenSize(screenWidth?: number, screenHeight?: number) {
  const screen = Dimensions.get('window');
  return {
    width: screenWidth ?? screen.width,
    height: screenHeight ?? screen.height,
  };
}

function getBitmapAlignRotation(
  photoWidth: number,
  photoHeight: number,
  screenWidth: number,
  screenHeight: number,
  exifNormalized: boolean
): number {
  if (Platform.OS !== 'android') return 0;
  const screenPortrait = screenHeight >= screenWidth;
  const photoLandscape = photoWidth > photoHeight;
  const screenLandscape = screenWidth > screenHeight;
  const photoPortrait = photoHeight > photoWidth;

  if (exifNormalized) {
    // ImageManipulator ha applicato EXIF; ruota solo se i pixel non coincidono col telefono.
    if (screenPortrait && photoLandscape) return 90;
    if (screenLandscape && photoPortrait) return 90;
    return 0;
  }
  return getPreviewAlignRotation(photoWidth, photoHeight, screenWidth, screenHeight);
}

function readingOrientationRotate(
  imageWidth: number,
  imageHeight: number,
  cardOrientation: CardOrientation
): number {
  const cropIsLandscape = imageWidth > imageHeight;
  const wantLandscape = cardOrientation === 'landscape';
  if (wantLandscape === cropIsLandscape) return 0;
  return 90;
}

function swapDimensionsAfterRotation(
  width: number,
  height: number,
  degrees: number
): [number, number] {
  if (degrees === 90 || degrees === 270) return swapDimensions(width, height);
  return [width, height];
}

function swapDimensions(width: number, height: number): [number, number] {
  return [height, width];
}

async function manipulateJpeg(
  uri: string,
  actions: ImageManipulator.Action[],
  bitmapWidth?: number,
  bitmapHeight?: number
): Promise<string> {
  if (actions.length === 0) return uri;
  let bw = bitmapWidth ?? 0;
  let bh = bitmapHeight ?? 0;

  if (bw <= 0 || bh <= 0) {
    const measured = await getImageSize(uri);
    bw = measured.width;
    bh = measured.height;
  }

  const prepared = await prepareImageOnce(
    uri,
    actions,
    bw,
    bh,
    (source, safeActions) =>
      ImageManipulator.manipulateAsync(source, safeActions, {
        compress: JPEG_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      })
  );
  return prepared.preparedUri;
}

/**
 * Pipeline: 1) rotazione allineamento preview  2) crop riquadro  3) rotazione lettura.
 * Il crop è obbligatorio: nessun fallback a foto intera.
 */
export function buildScanManipulatorActions(
  photoWidth: number,
  photoHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  screenWidth?: number,
  screenHeight?: number,
  viewportInsets?: OverlayViewportInsets,
  planOptions?: ScanPlanOptions
): ScanManipulatorPlan {
  const { width: sw, height: sh } = getScreenSize(screenWidth, screenHeight);
  const frame = getOverlayFrameRectInView(
    sw,
    sh,
    documentType,
    cardOrientation,
    viewportInsets,
    planOptions?.previewLayout
  );
  const mappingOptions = buildPhotoMappingOptions(planOptions);

  let normalizedWidth = photoWidth;
  let normalizedHeight = photoHeight;
  const actions: ImageManipulator.Action[] = [];

  const alignRotation = getBitmapAlignRotation(
    photoWidth,
    photoHeight,
    sw,
    sh,
    Boolean(planOptions?.exifNormalized)
  );
  if (alignRotation !== 0) {
    actions.push({ rotate: alignRotation });
    [normalizedWidth, normalizedHeight] = swapDimensions(normalizedWidth, normalizedHeight);
  }

  // Il biglietto usa il modello esplicito anteprima→pixel, che dichiara anche
  // quando la mappatura non è dimostrabile; il percorso documentale resta
  // invariato sul mapper storico.
  const cardMapping =
    documentType === 'business_card'
      ? mapPreviewRectToPhotoRect({
          previewWidth: sw,
          previewHeight: sh,
          photoWidth: normalizedWidth,
          photoHeight: normalizedHeight,
          overlayX: frame.x,
          overlayY: frame.y,
          overlayWidth: frame.width,
          overlayHeight: frame.height,
          fitMode: mappingOptions.scaleMode ?? 'cover',
          previewStreamWidth: mappingOptions.previewStreamWidth,
          previewStreamHeight: mappingOptions.previewStreamHeight,
          expectedAspectRatio: getOverlayAspectRatio(documentType, cardOrientation),
        })
      : null;

  const overlayCrop = cardMapping
    ? cardMapping.rect
    : mapScreenRectToPhoto(
        frame,
        normalizedWidth,
        normalizedHeight,
        sw,
        sh,
        mappingOptions
      );

  const cropRect = overlayCrop;
  if (!cropRect) {
    const debug: CropDebugInfo = {
      photoWidth,
      photoHeight,
      previewWidth: sw,
      previewHeight: sh,
      overlayRect: frame,
      normalizedWidth,
      normalizedHeight,
      alignRotation,
      readingRotation: 0,
      cropRect: null,
      cropApplied: false,
      cropInvalid: true,
      documentType,
      cardOrientation,
      cardMapping,
    };
    logCropDebug(debug);
    return {
      actions: [],
      cropWidth: 0,
      cropHeight: 0,
      originalWidth: photoWidth,
      originalHeight: photoHeight,
      alignRotation,
      readingRotation: 0,
      cropApplied: false,
      cropInvalid: true,
      debug,
    };
  }

  const expectedAspect = getOverlayAspectRatio(documentType, cardOrientation);
  const cropAspect = cropRect.width / cropRect.height;
  const aspectDrift = Math.abs(cropAspect - expectedAspect) / expectedAspect;
  if (aspectDrift > 0.18) {
    if (__DEV__) {
      runtimeLogger.debug(
        'IMAGE_ASPECT_MISMATCH',
        {
          status: 'rejected',
          stage: 'capture',
          source: 'camera',
          documentType,
        },
        { cropAspect, expectedAspect }
      );
    }
    const debug: CropDebugInfo = {
      photoWidth,
      photoHeight,
      previewWidth: sw,
      previewHeight: sh,
      overlayRect: frame,
      normalizedWidth,
      normalizedHeight,
      alignRotation,
      readingRotation: 0,
      cropRect,
      cropApplied: false,
      cropInvalid: true,
      documentType,
      cardOrientation,
      cardMapping,
    };
    logCropDebug(debug);
    return {
      actions: [],
      cropWidth: 0,
      cropHeight: 0,
      originalWidth: photoWidth,
      originalHeight: photoHeight,
      alignRotation,
      readingRotation: 0,
      cropApplied: false,
      cropInvalid: true,
      debug,
    };
  }

  actions.push({
    crop: {
      originX: cropRect.x,
      originY: cropRect.y,
      width: cropRect.width,
      height: cropRect.height,
    },
  });

  let cropW = cropRect.width;
  let cropH = cropRect.height;

  // Il biglietto non viene mai ruotato in base all'etichetta di orientamento:
  // il ritaglio coincide con la cornice inquadrata dall'utente e ne eredita
  // già la forma. La regola resta attiva per i documenti.
  const readingRotation =
    documentType === 'business_card'
      ? 0
      : readingOrientationRotate(cropW, cropH, cardOrientation);
  if (readingRotation !== 0) {
    actions.push({ rotate: readingRotation });
    [cropW, cropH] = swapDimensionsAfterRotation(cropW, cropH, readingRotation);
  }

  const resizeLimit =
    documentType === 'business_card'
      ? NORMALIZED_SCAN_MAX_LONG_SIDE
      : OCR_MAX_LONG_SIDE;
  const resizePlan = planLongSideResize(cropW, cropH, resizeLimit);
  logResizeDebug(
    documentType === 'business_card' ? 'scan_business_card' : 'scan_document',
    resizePlan
  );
  if (resizePlan.action) actions.push(resizePlan.action);

  const debug: CropDebugInfo = {
    photoWidth,
    photoHeight,
    previewWidth: sw,
    previewHeight: sh,
    overlayRect: frame,
    normalizedWidth,
    normalizedHeight,
    alignRotation,
    readingRotation,
    cropRect,
    cropApplied: true,
    cropInvalid: false,
    documentType,
    cardOrientation,
    cardMapping,
  };

  logCropDebug(debug);

  return {
    actions,
    cropWidth: cropW,
    cropHeight: cropH,
    originalWidth: photoWidth,
    originalHeight: photoHeight,
    alignRotation,
    readingRotation,
    cropApplied: true,
    cropInvalid: false,
    debug,
  };
}

/** Piano crop: riquadro verde → pixel reali del JPEG (stessa logica per biglietti e A4). */
export async function buildScanPlan(
  uri: string,
  photoWidth: number,
  photoHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  screenWidth?: number,
  screenHeight?: number,
  viewportInsets?: OverlayViewportInsets,
  diag?: CameraResolutionDiag | null
): Promise<ScanManipulatorPlan> {
  // Il biglietto misura il bitmap con lo stesso decoder che applicherà il
  // ritaglio. Su questo hardware Android i metadati dello scatto valgono
  // esattamente metà dei pixel reali del JPEG (1530x2040 contro 3060x4080):
  // un rettangolo calcolato sui metadati finisce nel quarto in alto a sinistra
  // dell'immagine vera, cioè sullo sfondo invece che sul biglietto.
  if (documentType === 'business_card') {
    const cardBitmap = await resolveCaptureBitmap(
      uri,
      { width: photoWidth, height: photoHeight },
      { forceManipulatorMeasurement: true }
    );
    const plan = buildScanManipulatorActions(
      cardBitmap.width,
      cardBitmap.height,
      documentType,
      cardOrientation,
      screenWidth,
      screenHeight,
      viewportInsets,
      {
        ...scanPlanOptionsFromDiag(diag ?? null, cardBitmap.width, cardBitmap.height),
        exifNormalized: cardBitmap.exifNormalized,
      }
    );
    return { ...plan, sourceUri: cardBitmap.uri };
  }

  const bitmap = await resolveCaptureBitmap(uri, {
    width: photoWidth,
    height: photoHeight,
  }, {
    // Su alcuni Android sia photo.width/height sia Image.getSize riportano
    // esattamente meta dei pixel su cui ImageManipulator applica il crop.
    // I documenti richiedono quindi la misura del medesimo decoder operativo.
    forceManipulatorMeasurement: true,
  });
  const plan = buildScanManipulatorActions(
    bitmap.width,
    bitmap.height,
    documentType,
    cardOrientation,
    screenWidth,
    screenHeight,
    viewportInsets,
    {
      ...scanPlanOptionsFromDiag(diag ?? null, bitmap.width, bitmap.height),
      // Le dimensioni degli stream sono tornate disponibili solo ora, dopo il
      // ripristino dell'evento nativo CAMERA_OPEN. La compensazione di campo
      // visivo che abiliterebbero cambierebbe ogni ritaglio documentale senza
      // validazione su dispositivo: i documenti restano sul comportamento
      // odierno e solo il biglietto consuma la geometria reale.
      previewStreamSize: undefined,
      exifNormalized: bitmap.exifNormalized,
    }
  );
  return { ...plan, sourceUri: bitmap.uri };
}

/** @deprecated Usa buildScanPlan */
export async function buildBusinessCardScanPlan(
  uri: string,
  photoWidth: number,
  photoHeight: number,
  cardOrientation: CardOrientation,
  screenWidth?: number,
  screenHeight?: number,
  viewportInsets?: OverlayViewportInsets,
  diag?: CameraResolutionDiag | null
): Promise<ScanManipulatorPlan> {
  return buildScanPlan(
    uri,
    photoWidth,
    photoHeight,
    'business_card',
    cardOrientation,
    screenWidth,
    screenHeight,
    viewportInsets,
    diag
  );
}

/** Ritaglia la foto al riquadro di inquadratura visibile in camera. */
export async function cropToOverlayFrame(
  uri: string,
  photoWidth: number,
  photoHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  screenWidth?: number,
  screenHeight?: number,
  viewportInsets?: OverlayViewportInsets
): Promise<string> {
  const plan = buildScanManipulatorActions(
    photoWidth,
    photoHeight,
    documentType,
    cardOrientation,
    screenWidth,
    screenHeight,
    viewportInsets
  );
  return manipulateJpeg(uri, plan.actions, photoWidth, photoHeight);
}

/** Verifica aspect ratio finale biglietto (landscape → w>h). */
export async function ensureCardReadingAspect(
  uri: string,
  cardOrientation: CardOrientation
): Promise<string> {
  const { width, height } = await getImageSize(uri);
  const wantLandscape = cardOrientation === 'landscape';
  const isLandscape = width > height;
  if (wantLandscape === isLandscape) return uri;
  return rotateImage(uri, wantLandscape ? 90 : 270);
}

/** Ruota l'immagine ritagliata per la lettura (verticale/orizzontale scelta in scansione). */
export async function orientForReading(
  uri: string,
  cardOrientation: CardOrientation
): Promise<string> {
  const { width, height } = await getImageSize(uri);
  const degrees = readingOrientationRotate(width, height, cardOrientation);
  if (degrees === 0) return uri;
  return manipulateJpeg(uri, [{ rotate: degrees }], width, height);
}

/** Prepara l'immagine per OCR: ritaglio riquadro, rotazione, ridimensionamento. */
export async function normalizeScannedImage(
  uri: string,
  cardOrientation: CardOrientation = 'landscape'
): Promise<string> {
  const { width, height } = await getImageSize(uri);
  const degrees = readingOrientationRotate(width, height, cardOrientation);
  const actions: ImageManipulator.Action[] = [];
  let preparedWidth = width;
  let preparedHeight = height;
  if (degrees !== 0) actions.push({ rotate: degrees });
  if (degrees === 90 || degrees === 270) {
    [preparedWidth, preparedHeight] = swapDimensions(preparedWidth, preparedHeight);
  }
  const resizePlan = planLongSideResize(
    preparedWidth,
    preparedHeight,
    NORMALIZED_SCAN_MAX_LONG_SIDE
  );
  logResizeDebug('normalize_scan', resizePlan);
  if (resizePlan.action) actions.push(resizePlan.action);
  return manipulateJpeg(uri, actions, width, height);
}

/**
 * Ripiego del biglietto quando il ritaglio non è dimostrabile: conserva
 * l'inquadratura completa e ne riduce il lato lungo.
 *
 * L'unica rotazione ammessa è `alignRotation`, che riporta il bitmap dagli
 * assi del sensore a quelli della visualizzazione quando Android consegna il
 * buffer non ruotato. È la stessa correzione fisica che il percorso col
 * ritaglio applica come prima azione del piano: senza di essa l'immagine
 * salvata resta coricata di 90°. Nessuna rotazione semantica derivata da
 * `cardOrientation`: la scena mantiene l'orientamento dello scatto.
 */
export async function normalizeFullFrameScan(
  uri: string,
  alignRotation = 0
): Promise<string> {
  const { width, height } = await getImageSize(uri);
  const actions: ImageManipulator.Action[] = [];
  let preparedWidth = width;
  let preparedHeight = height;

  if (alignRotation === 90 || alignRotation === 180 || alignRotation === 270) {
    actions.push({ rotate: alignRotation });
    if (alignRotation !== 180) {
      [preparedWidth, preparedHeight] = swapDimensions(preparedWidth, preparedHeight);
    }
  }

  const resizePlan = planLongSideResize(
    preparedWidth,
    preparedHeight,
    NORMALIZED_SCAN_MAX_LONG_SIDE
  );
  logResizeDebug('normalize_full_frame_scan', resizePlan);
  if (resizePlan.action) actions.push(resizePlan.action);
  if (actions.length === 0) return uri;
  return manipulateJpeg(uri, actions, width, height);
}

export async function prepareScannedImage(
  uri: string,
  photoWidth: number,
  photoHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  screenWidth?: number,
  screenHeight?: number,
  viewportInsets?: OverlayViewportInsets
): Promise<string> {
  let width = photoWidth;
  let height = photoHeight;
  if (!width || !height) {
    const size = await getImageSize(uri);
    width = size.width;
    height = size.height;
  }

  const plan = buildScanManipulatorActions(
    width,
    height,
    documentType,
    cardOrientation,
    screenWidth,
    screenHeight,
    viewportInsets
  );

  return manipulateJpeg(uri, plan.actions, width, height);
}

export async function prepareScannedImageFromPlan(
  uri: string,
  plan: ScanManipulatorPlan
): Promise<string> {
  if (plan.cropInvalid || !plan.cropApplied) {
    throw new InvalidCropPlanError();
  }
  const source = plan.sourceUri ?? uri;
  return manipulateJpeg(source, plan.actions, plan.originalWidth, plan.originalHeight);
}


/**
 * Recovery leggero business-card: riusa LO STESSO JPEG gia acquisito e amplia
 * una sola volta il crop della cornice prima di riprovare il boundary fisico.
 * Non avvia una nuova cattura e non esegue OCR aggiuntivo.
 */
export async function prepareBusinessCardBoundaryRecoveryImage(
  uri: string,
  plan: ScanManipulatorPlan,
  marginRatio = 0.16,
): Promise<string> {
  const crop = plan.debug.cropRect;
  if (plan.cropInvalid || !plan.cropApplied || !crop) {
    throw new InvalidCropPlanError();
  }

  const safeMargin = Math.max(0, Math.min(0.25, marginRatio));
  const padX = Math.round(crop.width * safeMargin);
  const padY = Math.round(crop.height * safeMargin);
  const x1 = Math.max(0, crop.x - padX);
  const y1 = Math.max(0, crop.y - padY);
  const x2 = Math.min(plan.debug.normalizedWidth, crop.x + crop.width + padX);
  const y2 = Math.min(plan.debug.normalizedHeight, crop.y + crop.height + padY);
  const recoveryCrop = {
    originX: x1,
    originY: y1,
    width: Math.max(1, x2 - x1),
    height: Math.max(1, y2 - y1),
  };

  let replacedCrop = false;
  const recoveryActions: ImageManipulator.Action[] = plan.actions.map((action) => {
    if (!replacedCrop && 'crop' in action) {
      replacedCrop = true;
      return { crop: recoveryCrop };
    }
    return action;
  });
  if (!replacedCrop) throw new InvalidCropPlanError();

  const source = plan.sourceUri ?? uri;
  return manipulateJpeg(
    source,
    recoveryActions,
    plan.originalWidth,
    plan.originalHeight,
  );
}

/** Prepara l'intero documento per OCR senza crop e senza upscale. */
export async function prepareFullDocumentImage(
  uri: string,
  width: number,
  height: number,
): Promise<{ uri: string; width: number; height: number }> {
  const resizePlan = planLongSideResize(width, height, OCR_MAX_LONG_SIDE);
  if (!resizePlan.action) return { uri, width, height };
  return {
    uri: await manipulateJpeg(uri, [resizePlan.action], width, height),
    width: resizePlan.output.width,
    height: resizePlan.output.height,
  };
}

/** Foto persona: allineamento EXIF, senza crop biglietto. */
export async function preparePersonPhoto(
  uri: string,
  photoWidth: number,
  photoHeight: number,
  screenWidth?: number,
  screenHeight?: number
): Promise<string> {
  let width = photoWidth;
  let height = photoHeight;
  if (!width || !height) {
    const size = await getImageSize(uri);
    width = size.width;
    height = size.height;
  }

  const initialWidth = width;
  const initialHeight = height;
  const { width: sw, height: sh } = getScreenSize(screenWidth, screenHeight);
  const actions: ImageManipulator.Action[] = [];

  const alignRotation = getPreviewAlignRotation(width, height, sw, sh);
  if (alignRotation !== 0) {
    actions.push({ rotate: alignRotation });
    [width, height] = swapDimensions(width, height);
  }

  if (__DEV__) {
    logCropDebug({
      photoWidth,
      photoHeight,
      previewWidth: sw,
      previewHeight: sh,
      overlayRect: { x: 0, y: 0, width: sw, height: sh },
      normalizedWidth: width,
      normalizedHeight: height,
      alignRotation,
      readingRotation: 0,
      cropRect: null,
      cropApplied: false,
      cropInvalid: true,
      documentType: 'business_card',
      cardOrientation: 'portrait',
    });
  }

  const resizePlan = planLongSideResize(width, height, PERSON_PHOTO_MAX_LONG_SIDE);
  logResizeDebug('person_photo', resizePlan);
  if (resizePlan.action) actions.push(resizePlan.action);

  return manipulateJpeg(uri, actions, initialWidth, initialHeight);
}

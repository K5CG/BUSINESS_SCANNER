import type { DocumentOrientationNormalizationInput } from './document-capture-orientation';
import type { LandscapeInkBands } from './document-orientation-evidence';

export interface OrientationCaptureSnapshot {
  deviceRotation?: string | number | null;
  displayRotation?: string | number | null;
  screenOrientation?: string | null;
  captureMode?: string | null;
  sensorOrientation?: string | number | null;
  cameraFacing?: string | null;
  photoWidth?: number | null;
  photoHeight?: number | null;
  exifOrientation?: number | null;
  cameraProcessingApplied?: boolean;
  plannedRotation?: number;
  probeEligible?: boolean;
  probeTopInk?: number | null;
  probeBottomInk?: number | null;
  score0?: number | null;
  score180?: number | null;
  finalRotation?: number;
  finalReason?: string | null;
  captureOrientationKey?: string | null;
  portraitQuarterTurnChosen?: 90 | 270;
  orientationDecision?: 'confident' | 'ambiguous';
}

declare const __DEV__: boolean | undefined;

export function logOrientationCapture(
  snapshot: OrientationCaptureSnapshot,
): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__ === false) return;
  console.warn(`[Orientation] ${JSON.stringify(snapshot)}`);
}

export function logCameraOrientation(
  step:
    | 'capture_begin'
    | 'device_at_shutter'
    | 'picture_result'
    | 'exif'
    | 'manipulation'
    | 'preview'
    | 'ocr_input'
    | 'reading_orientation_correction',
  detail: Record<string, unknown>,
): void {
  console.warn(`[CameraOrientation] ${step} ${JSON.stringify(detail)}`);
}

export function orientationSnapshotFromInput(
  input: DocumentOrientationNormalizationInput,
  extras: Partial<OrientationCaptureSnapshot> = {},
): OrientationCaptureSnapshot {
  return {
    photoWidth: input.width,
    photoHeight: input.height,
    exifOrientation: input.exifOrientation ?? null,
    cameraProcessingApplied: input.cameraProcessingApplied,
    deviceRotation: input.deviceOrientationAtCapture,
    screenOrientation: input.previewOrientation,
    ...extras,
  };
}

export function inkProbeLogFields(
  bands: LandscapeInkBands,
  score0: number,
  score180: number,
): Pick<
  OrientationCaptureSnapshot,
  'probeTopInk' | 'probeBottomInk' | 'score0' | 'score180'
> {
  return {
    probeTopInk: Number(bands.topInk.toFixed(4)),
    probeBottomInk: Number(bands.bottomInk.toFixed(4)),
    score0,
    score180,
  };
}

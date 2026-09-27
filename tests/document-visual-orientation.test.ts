import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDeterministicCaptureOrientation,
  planCapturedDocumentOrientation,
  resolveDeterministicCaptureOrientation,
  type DocumentOrientationNormalizationInput,
} from '../lib/document-capture-orientation';
import {
  needsLandscapeAspectMismatchProbe,
  needsProcessedVisualOrientationProbe,
  resolveProcessedVisualOrientation,
} from '../lib/document-orientation-evidence';

function paintGray(
  width: number,
  height: number,
  dark: (x: number, y: number) => boolean,
): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gray[y * width + x] = dark(x, y) ? 20 : 240;
    }
  }
  return gray;
}

const androidLandscapeLeft = {
  platform: 'android' as const,
  cameraProcessingApplied: true,
  rawCapturePreserved: false,
  cameraFacing: 'back' as const,
  captureMode: 'landscape-left' as const,
  exifOrientation: null as number | null,
  deviceOrientationAtCapture: 'landscape-left' as const,
  previewOrientation: 'landscape' as const,
};

test('deterministic landscape-left invalid EXIF portrait bitmap skips visual probe', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...androidLandscapeLeft,
    width: 3060,
    height: 4080,
    exifOrientation: null,
  };
  const plan = applyDeterministicCaptureOrientation(
    planCapturedDocumentOrientation(input),
    input,
    180,
  );
  assert.equal(plan.rotationRequired, 180);
  assert.equal(plan.normalizationReason, 'deterministic_capture_orientation');
  assert.equal(needsProcessedVisualOrientationProbe(input, plan), false);
  assert.equal(needsLandscapeAspectMismatchProbe(input, plan), false);
});

test('deterministic true landscape bitmap still skips content probes', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...androidLandscapeLeft,
    width: 4080,
    height: 3060,
    exifOrientation: 1,
  };
  const deterministic = resolveDeterministicCaptureOrientation(input);
  assert.ok(deterministic);
  assert.equal(deterministic.rotation, 0);
  const plan = applyDeterministicCaptureOrientation(
    planCapturedDocumentOrientation(input),
    input,
    deterministic.rotation,
  );
  assert.equal(needsProcessedVisualOrientationProbe(input, plan), false);
});

test('visual probe function remains available for unresolved capture classes only', () => {
  const gray = paintGray(80, 60, (_x, y) => y >= 48);
  const decision = resolveProcessedVisualOrientation(gray, 80, 60, 'landscape');
  assert.equal(decision.rotation, 0);
  assert.equal(decision.confidence, 'confident');
});

test('landscape-right processed portrait bitmap is not deterministic and may still probe', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...androidLandscapeLeft,
    width: 3060,
    height: 4080,
    deviceOrientationAtCapture: 'landscape-right',
  };
  assert.equal(resolveDeterministicCaptureOrientation(input), null);
  const plan = planCapturedDocumentOrientation(input);
  assert.equal(needsProcessedVisualOrientationProbe(input, plan), true);
});

test('portrait capture remains deterministic at rotation 0', () => {
  const input: DocumentOrientationNormalizationInput = {
    platform: 'android',
    cameraProcessingApplied: true,
    rawCapturePreserved: false,
    cameraFacing: 'back',
    captureMode: 'portrait',
    exifOrientation: null,
    deviceOrientationAtCapture: 'portrait',
    previewOrientation: 'portrait',
    width: 3060,
    height: 4080,
  };
  const deterministic = resolveDeterministicCaptureOrientation(input);
  assert.ok(deterministic);
  assert.equal(deterministic.rotation, 0);
});

test('processed EXIF legacy tag on deterministic class still maps to rotation 0 for landscape bitmap', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...androidLandscapeLeft,
    width: 4080,
    height: 3060,
    exifOrientation: 6,
  };
  const deterministic = resolveDeterministicCaptureOrientation(input);
  assert.ok(deterministic);
  assert.equal(deterministic.rotation, 0);
});

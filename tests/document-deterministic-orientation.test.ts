import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDeterministicCaptureOrientation,
  bitmapAspectFromDimensions,
  buildCapturedOrientationKey,
  capturedOrientationKeyLabel,
  planCapturedDocumentOrientation,
  resolveDeterministicCaptureOrientation,
  resolveDeterministicCaptureRotation,
  type DocumentOrientationNormalizationInput,
} from '../lib/document-capture-orientation';
import {
  applyProcessedVisualOrientationDecision,
  needsLandscapeAspectMismatchProbe,
  needsLandscapeUpsideDownProbe,
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

const androidBackProcessed = {
  platform: 'android' as const,
  cameraProcessingApplied: true,
  rawCapturePreserved: false,
  cameraFacing: 'back' as const,
  captureMode: 'landscape-left' as const,
  deviceOrientationAtCapture: 'landscape-left' as const,
  previewOrientation: 'landscape' as const,
  width: 3060,
  height: 4080,
  exifOrientation: null as number | null,
};

function resolveFinalRotation(
  input: DocumentOrientationNormalizationInput,
  gray: Uint8Array,
  grayWidth: number,
  grayHeight: number,
): number {
  const deterministic = resolveDeterministicCaptureOrientation(input);
  if (deterministic) {
    return applyDeterministicCaptureOrientation(
      planCapturedDocumentOrientation(input),
      input,
      deterministic.rotation,
    ).rotationRequired;
  }
  const plan = planCapturedDocumentOrientation(input);
  const targetAspect =
    plan.orientation === 'landscape-left' || plan.orientation === 'landscape-right'
      ? 'landscape'
      : 'portrait';
  const decision = resolveProcessedVisualOrientation(gray, grayWidth, grayHeight, targetAspect);
  return applyProcessedVisualOrientationDecision(plan, input, decision).plan.rotationRequired;
}

const matrixLayouts: Array<{ name: string; dark: (x: number, y: number) => boolean }> = [
  { name: 'header-heavy', dark: (_x, y) => y < 16 },
  { name: 'footer-heavy', dark: (_x, y) => y >= 64 },
  { name: 'sparse', dark: () => false },
  {
    name: 'dense-table',
    dark: (_x, y) => y % 8 < 2,
  },
  { name: 'totals-heavy', dark: (_x, y) => y >= 58 },
  { name: 'two-page-style', dark: (_x, y) => (y < 12 || y >= 68) },
];

test('matrix: landscape-left invalid EXIF portrait bitmap is always rotation 180', () => {
  const key = buildCapturedOrientationKey(androidBackProcessed);
  assert.equal(resolveDeterministicCaptureRotation(key), 180);
  const rotations = matrixLayouts.map((layout) => {
    const gray = paintGray(60, 80, layout.dark);
    return resolveFinalRotation(androidBackProcessed, gray, 60, 80);
  });
  assert.deepEqual(new Set(rotations), new Set([180]), rotations.join(','));
  assert.equal(rotations.length, matrixLayouts.length);
});

test('matrix layouts cannot reopen visual or aspect probes for deterministic key', () => {
  for (const layout of matrixLayouts) {
    const plan = applyDeterministicCaptureOrientation(
      planCapturedDocumentOrientation(androidBackProcessed),
      androidBackProcessed,
      180,
    );
    assert.equal(needsProcessedVisualOrientationProbe(androidBackProcessed, plan), false);
    assert.equal(needsLandscapeAspectMismatchProbe(androidBackProcessed, plan), false);
    assert.equal(needsLandscapeUpsideDownProbe(androidBackProcessed, plan), false);
    assert.equal(plan.rotationRequired, 180);
  }
});

test('portrait capture remains rotation 0 across matrix layouts', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...androidBackProcessed,
    captureMode: 'portrait',
    deviceOrientationAtCapture: 'portrait',
    previewOrientation: 'portrait',
  };
  assert.equal(resolveDeterministicCaptureRotation(buildCapturedOrientationKey(input)), 0);
  for (const layout of matrixLayouts) {
    const gray = paintGray(60, 80, layout.dark);
    assert.equal(resolveFinalRotation(input, gray, 60, 80), 0);
  }
});

test('landscape-left valid EXIF true landscape bitmap remains rotation 0', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...androidBackProcessed,
    width: 4080,
    height: 3060,
    exifOrientation: 1,
  };
  assert.equal(resolveDeterministicCaptureRotation(buildCapturedOrientationKey(input)), 0);
  const gray = paintGray(80, 60, (_x, y) => y < 12);
  assert.equal(resolveFinalRotation(input, gray, 80, 60), 0);
  const plan = planCapturedDocumentOrientation(input);
  assert.equal(needsLandscapeAspectMismatchProbe(input, plan), false);
});

test('landscape-left invalid EXIF true landscape bitmap requires rotation 180', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...androidBackProcessed,
    width: 4080,
    height: 3060,
    exifOrientation: null,
  };
  const key = buildCapturedOrientationKey(input);
  assert.equal(
    capturedOrientationKeyLabel(key),
    'android|back|landscape-left|landscape-left|processed|baked|exif-null|bitmap-landscape',
  );
  assert.equal(resolveDeterministicCaptureRotation(key), 180);
  const gray = paintGray(80, 60, (_x, y) => y >= 48);
  assert.equal(resolveFinalRotation(input, gray, 80, 60), 180);
  const plan = applyDeterministicCaptureOrientation(
    planCapturedDocumentOrientation(input),
    input,
    180,
  );
  assert.equal(needsProcessedVisualOrientationProbe(input, plan), false);
  assert.equal(needsLandscapeUpsideDownProbe(input, plan), false);
});

test('landscape-right processed portrait bitmap is explicitly unresolved', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...androidBackProcessed,
    deviceOrientationAtCapture: 'landscape-right',
  };
  assert.equal(resolveDeterministicCaptureRotation(buildCapturedOrientationKey(input)), null);
});

test('orientation key is stable and content-independent', () => {
  const key = buildCapturedOrientationKey(androidBackProcessed);
  assert.match(
    capturedOrientationKeyLabel(key),
    /android\|back\|landscape-left\|landscape-left\|processed\|baked\|exif-null\|bitmap-portrait/,
  );
});

test('deterministic rotation depends on aspect class only, not exact sensor resolution', () => {
  const portraitSizes: Array<[number, number]> = [
    [3060, 4080],
    [3000, 4000],
    [1080, 1920],
    [1536, 2048],
  ];
  const landscapeSizes: Array<[number, number]> = [
    [4080, 3060],
    [4000, 3000],
    [1920, 1080],
    [2048, 1536],
    [4032, 3024],
  ];

  for (const [width, height] of portraitSizes) {
    assert.equal(bitmapAspectFromDimensions(width, height), 'portrait');
    const nullExif: DocumentOrientationNormalizationInput = {
      ...androidBackProcessed,
      width,
      height,
      exifOrientation: null,
    };
    assert.equal(resolveDeterministicCaptureRotation(buildCapturedOrientationKey(nullExif)), 180);
  }

  for (const [width, height] of landscapeSizes) {
    assert.equal(bitmapAspectFromDimensions(width, height), 'landscape');
    const nullExif: DocumentOrientationNormalizationInput = {
      ...androidBackProcessed,
      width,
      height,
      exifOrientation: null,
    };
    assert.equal(resolveDeterministicCaptureRotation(buildCapturedOrientationKey(nullExif)), 180);
    const upright: DocumentOrientationNormalizationInput = {
      ...nullExif,
      exifOrientation: 1,
    };
    assert.equal(resolveDeterministicCaptureRotation(buildCapturedOrientationKey(upright)), 0);
  }

  assert.equal(bitmapAspectFromDimensions(2000, 2000), 'square');
  assert.equal(bitmapAspectFromDimensions(2001, 2000), 'square');
  assert.equal(bitmapAspectFromDimensions(2100, 2000), 'landscape');
});

import {
  applyLandscapeReadingOrderCorrection,
  resolveDeterministicCaptureOrientation,
  type DocumentOrientationNormalizationInput,
  type DocumentOrientationNormalizationPlan,
} from './document-capture-orientation';

/** Campione stretto per probe post-capture: solo bande alto/basso. */
export const LANDSCAPE_INK_DARK_THRESHOLD = 180;
export const LANDSCAPE_TOP_BAND_RATIO = 0.2;
export const LANDSCAPE_BOTTOM_BAND_START = 0.8;

export interface LandscapeInkBands {
  topInk: number;
  bottomInk: number;
}

function bandInkDensity(
  gray: Uint8Array,
  width: number,
  height: number,
  yStartRatio: number,
  yEndRatio: number,
): number {
  const y0 = Math.floor(height * yStartRatio);
  const y1 = Math.max(y0 + 1, Math.floor(height * yEndRatio));
  let dark = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] < LANDSCAPE_INK_DARK_THRESHOLD) dark += 1;
      total += 1;
    }
  }
  return total > 0 ? dark / total : 0;
}

const PAPER_BRIGHT_THRESHOLD = 160;
const CONTENT_INSET = 0.18;

function paperContentYRange(
  gray: Uint8Array,
  width: number,
  height: number,
): { y0: number; y1: number } {
  const x0 = Math.floor(width * CONTENT_INSET);
  const x1 = Math.max(x0 + 1, Math.ceil(width * (1 - CONTENT_INSET)));
  const paperRows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    let bright = 0;
    let total = 0;
    for (let x = x0; x < x1; x += 2) {
      total += 1;
      if (gray[y * width + x] >= PAPER_BRIGHT_THRESHOLD) bright += 1;
    }
    if (total > 0 && bright / total >= 0.42) paperRows.push(y);
  }
  if (paperRows.length < Math.max(8, Math.floor(height * 0.12))) {
    return {
      y0: Math.floor(height * CONTENT_INSET),
      y1: Math.max(Math.floor(height * CONTENT_INSET) + 1, Math.ceil(height * (1 - CONTENT_INSET))),
    };
  }
  return { y0: paperRows[0], y1: paperRows[paperRows.length - 1] + 1 };
}

function bandInkDensityInRect(
  gray: Uint8Array,
  width: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number {
  const left = Math.max(0, Math.min(width, Math.floor(x0)));
  const right = Math.max(left + 1, Math.min(width, Math.ceil(x1)));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.max(top + 1, Math.ceil(y1));
  let dark = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (gray[y * width + x] < LANDSCAPE_INK_DARK_THRESHOLD) dark += 1;
      total += 1;
    }
  }
  return total > 0 ? dark / total : 0;
}

export function measureLandscapeInkBandsFromGray(
  gray: Uint8Array,
  width: number,
  height: number,
): LandscapeInkBands {
  const paper = paperContentYRange(gray, width, height);
  const span = Math.max(8, paper.y1 - paper.y0);
  const x0 = width * CONTENT_INSET;
  const x1 = width * (1 - CONTENT_INSET);
  const topEnd = paper.y0 + span * LANDSCAPE_TOP_BAND_RATIO;
  const bottomStart = paper.y1 - span * (1 - LANDSCAPE_BOTTOM_BAND_START);
  return {
    topInk: bandInkDensityInRect(gray, width, x0, x1, paper.y0, topEnd),
    bottomInk: bandInkDensityInRect(gray, width, x0, x1, bottomStart, paper.y1),
  };
}

export function mirroredLandscapeInkBands(bands: LandscapeInkBands): LandscapeInkBands {
  return {
    topInk: bands.bottomInk,
    bottomInk: bands.topInk,
  };
}

/**
 * Score più alto = maggiore evidenza che l'header del documento sia in alto
 * (footer/totali in basso). Non usa OCR né label testuali.
 */
export function scoreLandscapeHeaderAtTop(bands: LandscapeInkBands): number {
  const ratio = bands.topInk / Math.max(0.001, bands.bottomInk);
  // Footer o blocco totali in cima: banda superiore molto più scura della inferiore.
  if (bands.topInk >= 0.88 && ratio >= 1.65) return -2;
  if (ratio >= 1.75 && bands.topInk >= 0.82) return -2;
  // Header in alto tipico: banda superiore non domina quella inferiore.
  if (ratio <= 1.35) return 1;
  // Header leggero (logo/colori chiari) con corpo tabellare in basso.
  if (bands.topInk <= 0.45 && bands.bottomInk >= 0.55) return 0.5;
  return 0;
}

export function resolveLandscapeUpsideDownCorrection(bandsAt0: LandscapeInkBands): 0 | 180 {
  const bandsAt180 = mirroredLandscapeInkBands(bandsAt0);
  const score0 = scoreLandscapeHeaderAtTop(bandsAt0);
  const score180 = scoreLandscapeHeaderAtTop(bandsAt180);
  if (score180 > score0) return 180;
  if (score0 > score180) return 0;
  if (score0 < 0 && score180 >= 0) return 180;
  return 0;
}


/**
 * Portrait Android already baked by CameraX can still occasionally arrive
 * upside-down with EXIF absent/neutral. Unlike the landscape probe, this is
 * deliberately conservative: a 180 correction is allowed only when the
 * top/bottom ink evidence is strongly asymmetric. Ambiguous portrait pages
 * stay untouched and are left to manual review rather than risk a false flip.
 */
export function resolvePortraitUpsideDownCorrection(
  bandsAt0: LandscapeInkBands,
): 0 | 180 {
  const bandsAt180 = mirroredLandscapeInkBands(bandsAt0);
  const score0 = scoreLandscapeHeaderAtTop(bandsAt0);
  const score180 = scoreLandscapeHeaderAtTop(bandsAt180);
  const ratio = bandsAt0.bottomInk > 0
    ? bandsAt0.topInk / bandsAt0.bottomInk
    : Number.POSITIVE_INFINITY;

  const strongUpsideDown =
    score0 <= -2 &&
    score180 >= 1 &&
    bandsAt0.topInk >= 0.88 &&
    bandsAt0.bottomInk <= 0.58 &&
    ratio >= 1.65;

  return strongUpsideDown ? 180 : 0;
}

export function needsPortraitUpsideDownProbe(
  input: DocumentOrientationNormalizationInput,
  plan: DocumentOrientationNormalizationPlan,
): boolean {
  if (input.rawCapturePreserved) return false;
  if (!input.cameraProcessingApplied) return false;
  if (input.platform !== 'android') return false;
  if (plan.rotationRequired !== 0 || plan.rotationApplied !== 0) return false;
  if (plan.orientation !== 'portrait' && plan.orientation !== 'portrait-down') return false;
  if (input.width >= input.height) return false;
  const exif = input.exifOrientation;
  if (exif != null && exif !== 1) return false;
  return true;
}

export function needsLandscapeUpsideDownProbe(
  input: DocumentOrientationNormalizationInput,
  plan: DocumentOrientationNormalizationPlan,
): boolean {
  if (resolveDeterministicCaptureOrientation(input) != null) return false;
  if (input.rawCapturePreserved) return false;
  if (!input.cameraProcessingApplied) return false;
  if (input.platform !== 'android') return false;
  if (plan.rotationRequired !== 0 || plan.rotationApplied !== 0) return false;
  const targetLandscape =
    plan.orientation === 'landscape-left' || plan.orientation === 'landscape-right';
  if (!targetLandscape) return false;
  if (input.width < input.height) return false;
  const exif = input.exifOrientation;
  if (exif != null && exif !== 1) return false;
  return true;
}

/**
 * Landscape capture whose baked pixels are still portrait-shaped.
 * Device orientation must not invent 90/270; visual bands decide.
 */
export function needsLandscapeAspectMismatchProbe(
  input: DocumentOrientationNormalizationInput,
  plan: DocumentOrientationNormalizationPlan,
): boolean {
  if (resolveDeterministicCaptureOrientation(input) != null) return false;
  if (input.rawCapturePreserved) return false;
  if (!input.cameraProcessingApplied) return false;
  if (input.platform !== 'android') return false;
  if (plan.rotationRequired !== 0 || plan.rotationApplied !== 0) return false;
  const targetLandscape =
    plan.orientation === 'landscape-left' || plan.orientation === 'landscape-right';
  if (!targetLandscape) return false;
  if (input.width >= input.height) return false;
  const exif = input.exifOrientation;
  if (exif != null && exif !== 1) return false;
  return true;
}

/** Bitmap landscape → target portrait con quarter-turn 90/270 ambiguo (CameraX Android). */
export function needsPortraitQuarterTurnProbe(
  input: DocumentOrientationNormalizationInput,
  plan: DocumentOrientationNormalizationPlan,
): boolean {
  if (input.rawCapturePreserved) return false;
  if (!input.cameraProcessingApplied) return false;
  if (input.platform !== 'android') return false;
  // Android CameraX can report a portrait capture while returning a processed
  // landscape-shaped bitmap with no trustworthy EXIF.  In that contradictory
  // state the deterministic plan may still be 0, so the visual 90/270 probe
  // must remain eligible before any crop is materialized.
  if (plan.rotationRequired !== 0 && plan.rotationRequired !== 90) return false;
  if (plan.orientation !== 'portrait' && plan.orientation !== 'portrait-down') return false;
  if (input.width <= input.height) return false;
  const exif = input.exifOrientation;
  // A zero deterministic rotation is reconsidered only when EXIF is absent:
  // a concrete EXIF value remains stronger evidence than the axis mismatch.
  if (plan.rotationRequired === 0 && exif != null) return false;
  if (exif != null && exif !== 1 && exif !== 3) return false;
  return true;
}

export interface DocumentOrientationSessionPage {
  rotationApplied: 0 | 90 | 180 | 270;
  normalizedWidth: number;
  normalizedHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  captureOrientation: DocumentOrientationNormalizationInput['deviceOrientationAtCapture'];
}

export interface DocumentOrientationSessionContext {
  previousPages: readonly DocumentOrientationSessionPage[];
}

function bandInkFromGraySamples(
  gray: Uint8Array,
  width: number,
  samples: Array<{ x: number; y: number }>,
): number {
  let dark = 0;
  for (const point of samples) {
    const x = Math.max(0, Math.min(width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(Math.floor(gray.length / width) - 1, Math.round(point.y)));
    if (gray[y * width + x] < LANDSCAPE_INK_DARK_THRESHOLD) dark += 1;
  }
  return samples.length > 0 ? dark / samples.length : 0;
}

function samplePortraitQuarterTurnBands(
  gray: Uint8Array,
  width: number,
  height: number,
  rotation: 90 | 270,
): LandscapeInkBands {
  const resultHeight = width;
  const resultWidth = height;
  const topEnd = Math.max(1, Math.floor(resultHeight * LANDSCAPE_TOP_BAND_RATIO));
  const bottomStart = Math.floor(resultHeight * LANDSCAPE_BOTTOM_BAND_START);
  const topSamples: Array<{ x: number; y: number }> = [];
  const bottomSamples: Array<{ x: number; y: number }> = [];
  const stepX = Math.max(1, Math.floor(resultWidth / 24));
  const stepYTop = Math.max(1, Math.floor(topEnd / 6));
  const stepYBottom = Math.max(1, Math.floor((resultHeight - bottomStart) / 6));

  for (let ry = 0; ry < topEnd; ry += stepYTop) {
    for (let rx = 0; rx < resultWidth; rx += stepX) {
      const mapped = rotation === 90
        ? { x: width - 1 - ry, y: rx }
        : { x: ry, y: height - 1 - rx };
      topSamples.push(mapped);
    }
  }
  for (let ry = bottomStart; ry < resultHeight; ry += stepYBottom) {
    for (let rx = 0; rx < resultWidth; rx += stepX) {
      const mapped = rotation === 90
        ? { x: width - 1 - ry, y: rx }
        : { x: ry, y: height - 1 - rx };
      bottomSamples.push(mapped);
    }
  }
  return {
    topInk: bandInkFromGraySamples(gray, width, topSamples),
    bottomInk: bandInkFromGraySamples(gray, width, bottomSamples),
  };
}

export function measurePortraitQuarterTurnBandsFromGray(
  gray: Uint8Array,
  width: number,
  height: number,
  rotation: 90 | 270,
): LandscapeInkBands {
  return samplePortraitQuarterTurnBands(gray, width, height, rotation);
}

export type PortraitQuarterTurnConfidence = 'confident' | 'ambiguous';

export interface PortraitQuarterTurnDecision {
  rotation: 90 | 270;
  confidence: PortraitQuarterTurnConfidence;
}

export function resolvePortraitQuarterTurnRotation(
  bands90: LandscapeInkBands,
  bands270: LandscapeInkBands,
  session?: DocumentOrientationSessionContext,
): PortraitQuarterTurnDecision {
  const score90 = scoreLandscapeHeaderAtTop(bands90) + (bands90.topInk - bands90.bottomInk);
  const score270 = scoreLandscapeHeaderAtTop(bands270) + (bands270.topInk - bands270.bottomInk);
  if (score270 > score90 + 0.25) {
    return { rotation: 270, confidence: 'confident' };
  }
  if (score90 > score270 + 0.25) {
    return { rotation: 90, confidence: 'confident' };
  }
  const previous = session?.previousPages.at(-1);
  if (
    previous &&
    (previous.captureOrientation === 'portrait' || previous.captureOrientation === 'portrait-down') &&
    previous.rotationApplied === 0 &&
    previous.normalizedHeight > previous.normalizedWidth
  ) {
    return { rotation: 270, confidence: 'confident' };
  }
  return { rotation: 90, confidence: 'ambiguous' };
}

export type VisualOrientationDegrees = 0 | 90 | 180 | 270;
export type VisualOrientationConfidence = 'confident' | 'ambiguous';

export type VisualOrientationAxis = '0-180' | '90-270';

export interface VisualOrientationDecision {
  rotation: VisualOrientationDegrees;
  confidence: VisualOrientationConfidence;
  scores: Record<VisualOrientationDegrees, number>;
  lockSameAxis: boolean;
  sameAxisClear: boolean;
  eligibleAxis: VisualOrientationAxis;
}

/** Horizontal text or a clear 0-vs-180 ink split already locked the reading axis. */
export function isProcessedVisualSameAxisLocked(decision: VisualOrientationDecision): boolean {
  return decision.eligibleAxis === '0-180' && (decision.lockSameAxis || decision.sameAxisClear);
}

/**
 * Rotation 0 is a finished same-axis decision. It must not be treated as "no probe".
 */
export function applyProcessedVisualOrientationDecision(
  plan: DocumentOrientationNormalizationPlan,
  input: Pick<DocumentOrientationNormalizationInput, 'width' | 'height'>,
  decision: VisualOrientationDecision,
): {
  plan: DocumentOrientationNormalizationPlan;
  visualComplete: boolean;
} {
  const sameAxisLocked = isProcessedVisualSameAxisLocked(decision);
  const applyPixels =
    decision.rotation !== 0 &&
    decision.confidence === 'confident';
  const visualComplete = applyPixels
    || (sameAxisLocked && (decision.rotation === 0 || decision.rotation === 180));
  if (!visualComplete) {
    return { plan, visualComplete: false };
  }
  if (!applyPixels) {
    return {
      plan: {
        ...plan,
        normalizationReason: 'processed_visual_orientation_probe',
      },
      visualComplete: true,
    };
  }
  if (decision.rotation === 180) {
    const corrected = applyLandscapeReadingOrderCorrection(plan, 180);
    return {
      plan: {
        ...corrected,
        normalizationReason: 'processed_visual_orientation_probe',
      },
      visualComplete: true,
    };
  }
  return {
    plan: {
      ...plan,
      rotationRequired: decision.rotation,
      rotationApplied: decision.rotation,
      normalizedWidth: input.height,
      normalizedHeight: input.width,
      normalizationReason: 'processed_visual_orientation_probe',
    },
    visualComplete: true,
  };
}

function dimensionsAfterVisualRotation(
  width: number,
  height: number,
  rotation: VisualOrientationDegrees,
): { width: number; height: number } {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

function mapRotatedToSource(
  rx: number,
  ry: number,
  width: number,
  height: number,
  rotation: VisualOrientationDegrees,
): { x: number; y: number } {
  if (rotation === 0) return { x: rx, y: ry };
  if (rotation === 180) return { x: width - 1 - rx, y: height - 1 - ry };
  if (rotation === 90) return { x: width - 1 - ry, y: rx };
  return { x: ry, y: height - 1 - rx };
}

const TEXT_DARK_THRESHOLD = 140;
const HORIZONTAL_TEXT_GUARD = 0.2;

/**
 * +1 = ink changes more along rows (horizontal text / baselines).
 * -1 = ink changes more along columns (sideways text).
 * Desk clutter is ignored better than raw band density because it is not striped.
 */
export function scoreHorizontalTextEvidence(
  gray: Uint8Array,
  width: number,
  height: number,
  rotation: VisualOrientationDegrees,
): number {
  const next = dimensionsAfterVisualRotation(width, height, rotation);
  const insetX = Math.floor(next.width * 0.18);
  const insetY = Math.floor(next.height * 0.18);
  const x0 = insetX;
  const x1 = Math.max(x0 + 8, next.width - insetX);
  const y0 = insetY;
  const y1 = Math.max(y0 + 8, next.height - insetY);
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 64));
  const isDark = (rx: number, ry: number): boolean => {
    const source = mapRotatedToSource(rx, ry, width, height, rotation);
    const x = Math.max(0, Math.min(width - 1, Math.round(source.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(source.y)));
    return gray[y * width + x] < TEXT_DARK_THRESHOLD;
  };
  let textishRows = 0;
  let textishCols = 0;
  for (let ry = y0; ry < y1; ry += step) {
    let previous: boolean | null = null;
    let transitions = 0;
    for (let rx = x0; rx < x1; rx += step) {
      const dark = isDark(rx, ry);
      if (previous !== null && dark !== previous) transitions += 1;
      previous = dark;
    }
    if (transitions >= 3) textishRows += 1;
  }
  for (let rx = x0; rx < x1; rx += step) {
    let previous: boolean | null = null;
    let transitions = 0;
    for (let ry = y0; ry < y1; ry += step) {
      const dark = isDark(rx, ry);
      if (previous !== null && dark !== previous) transitions += 1;
      previous = dark;
    }
    if (transitions >= 3) textishCols += 1;
  }
  return (textishRows - textishCols) / Math.max(1, textishRows + textishCols);
}

export function measureInkBandsAtRotation(
  gray: Uint8Array,
  width: number,
  height: number,
  rotation: VisualOrientationDegrees,
): LandscapeInkBands {
  if (rotation === 0) return measureLandscapeInkBandsFromGray(gray, width, height);
  if (rotation === 180) return mirroredLandscapeInkBands(measureLandscapeInkBandsFromGray(gray, width, height));
  return measurePortraitQuarterTurnBandsFromGray(gray, width, height, rotation);
}

function scoreVisualOrientation(bands: LandscapeInkBands): number {
  return scoreLandscapeHeaderAtTop(bands);
}

/**
 * Score 0/90/180/270 from page-interior ink plus text-baseline direction.
 * Capture-mode target aspect is a hint only: clearly horizontal text keeps the
 * current reading axis, and 0 vs 180 is decided from header/footer content.
 */
export function resolveProcessedVisualOrientation(
  gray: Uint8Array,
  width: number,
  height: number,
  targetAspect: 'landscape' | 'portrait',
): VisualOrientationDecision {
  const bands = {
    0: measureInkBandsAtRotation(gray, width, height, 0),
    90: measureInkBandsAtRotation(gray, width, height, 90),
    180: measureInkBandsAtRotation(gray, width, height, 180),
    270: measureInkBandsAtRotation(gray, width, height, 270),
  } as Record<VisualOrientationDegrees, LandscapeInkBands>;
  const text = {
    0: scoreHorizontalTextEvidence(gray, width, height, 0),
    90: scoreHorizontalTextEvidence(gray, width, height, 90),
    180: scoreHorizontalTextEvidence(gray, width, height, 180),
    270: scoreHorizontalTextEvidence(gray, width, height, 270),
  } as Record<VisualOrientationDegrees, number>;
  const scores = {
    0: scoreVisualOrientation(bands[0]),
    90: scoreVisualOrientation(bands[90]),
    180: scoreVisualOrientation(bands[180]),
    270: scoreVisualOrientation(bands[270]),
  } as Record<VisualOrientationDegrees, number>;
  const bitmapLandscape = width >= height;
  const sameAxisText = Math.max(text[0], text[180]);
  const quarterText = Math.max(text[90], text[270]);
  const lockSameAxis = sameAxisText > HORIZONTAL_TEXT_GUARD && sameAxisText >= quarterText - 0.05;
  const lockQuarter = !bitmapLandscape
    && !lockSameAxis
    && quarterText > HORIZONTAL_TEXT_GUARD
    && quarterText >= sameAxisText + 0.15;
  const axisTop = bands[0].topInk - bands[0].bottomInk;
  const axisBottom = bands[180].topInk - bands[180].bottomInk;
  const frameTop = bandInkDensity(gray, width, height, 0, LANDSCAPE_TOP_BAND_RATIO);
  const frameBottom = bandInkDensity(gray, width, height, LANDSCAPE_BOTTOM_BAND_START, 1);
  const sameAxisClear = Math.abs(scores[180] - scores[0]) >= 0.25
    || (scores[0] < 0) !== (scores[180] < 0)
    || Math.abs(axisTop - axisBottom) >= 0.08
    || Math.abs(frameTop - frameBottom) >= 0.08;
  const sameAxisLocked = lockSameAxis || sameAxisClear;
  let eligible: VisualOrientationDegrees[];
  let eligibleAxis: VisualOrientationAxis;
  if (sameAxisLocked) {
    eligible = [0, 180];
    eligibleAxis = '0-180';
  } else if (lockQuarter) {
    eligible = [90, 270];
    eligibleAxis = '90-270';
  } else if (!lockSameAxis && targetAspect === 'landscape' && !bitmapLandscape) {
    eligible = [90, 270];
    eligibleAxis = '90-270';
  } else if (!lockSameAxis && targetAspect === 'portrait' && bitmapLandscape) {
    eligible = [90, 270];
    eligibleAxis = '90-270';
  } else {
    eligible = [0, 180];
    eligibleAxis = '0-180';
  }
  const ranked = [...eligible].sort((left, right) => {
    const scoreDelta = scores[right] - scores[left];
    if (scoreDelta !== 0) return scoreDelta;
    if (left === 0 || right === 0) return left === 0 ? -1 : 1;
    return 0;
  });
  const best = ranked[0];
  const second = ranked[1];
  const withAxis = (
    rotation: VisualOrientationDegrees,
    confidence: VisualOrientationConfidence,
  ): VisualOrientationDecision => ({
    rotation,
    confidence,
    scores,
    lockSameAxis,
    sameAxisClear,
    eligibleAxis,
  });
  if (best === undefined) {
    return withAxis(0, 'ambiguous');
  }
  if (eligible.length === 2 && eligible.includes(0) && eligible.includes(180)) {
    const interiorTop = bands[0].topInk - bands[0].bottomInk;
    const interiorBottom = bands[180].topInk - bands[180].bottomInk;
    const frameTop = bandInkDensity(gray, width, height, 0, LANDSCAPE_TOP_BAND_RATIO);
    const frameBottom = bandInkDensity(gray, width, height, LANDSCAPE_BOTTOM_BAND_START, 1);
    const frameDelta = frameTop - frameBottom;
    const useFrame = Math.abs(interiorTop) < 0.04 && Math.abs(interiorBottom) < 0.04;
    const footerAtTop = useFrame ? frameDelta : interiorTop;
    const footerAtBottom = useFrame ? -frameDelta : interiorBottom;
    const prefer180 = scores[180] > scores[0]
      || (scores[180] >= scores[0] && footerAtTop > footerAtBottom + 0.04)
      || (scores[0] < 0 && scores[180] >= 0);
    const rotation: VisualOrientationDegrees = prefer180 ? 180 : 0;
    const margin = Math.abs(scores[180] - scores[0]);
    const confident = margin >= 0.25
      || (scores[0] < 0) !== (scores[180] < 0)
      || Math.abs(footerAtTop - footerAtBottom) >= 0.08;
    return withAxis(rotation, confident ? 'confident' : 'ambiguous');
  }
  if (
    (best === 90 || best === 270)
    && (second === 90 || second === 270)
    && Math.abs(scores[90] - scores[270]) < 0.25
  ) {
    const header90 = bands[90].topInk - bands[90].bottomInk;
    const header270 = bands[270].topInk - bands[270].bottomInk;
    const chosen = header270 >= header90 ? 270 : 90;
    return withAxis(
      chosen,
      Math.abs(header270 - header90) >= 0.15 ? 'confident' : 'ambiguous',
    );
  }
  const margin = second === undefined ? 1 : scores[best] - scores[second];
  if (margin < 0.25 || scores[best] <= 0) {
    return withAxis(best === 180 ? 180 : 0, 'ambiguous');
  }
  return withAxis(best, 'confident');
}

/** Processed Android capture whose EXIF cannot be trusted for another pixel rotate. */
export function processedExifUntrusted(
  input: DocumentOrientationNormalizationInput,
): boolean {
  if (!input.cameraProcessingApplied) return false;
  const exif = input.exifOrientation;
  return exif == null || exif === 1 || (Number.isInteger(exif) && exif >= 2 && exif <= 8);
}

/**
 * Visual/text probe for processed captures when the target is landscape or the
 * baked bitmap aspect does not match the target. Dimensions alone must not decide.
 */
export function needsProcessedVisualOrientationProbe(
  input: DocumentOrientationNormalizationInput,
  plan: DocumentOrientationNormalizationPlan,
): boolean {
  if (resolveDeterministicCaptureOrientation(input) != null) return false;
  if (input.rawCapturePreserved) return false;
  if (!input.cameraProcessingApplied) return false;
  if (input.platform !== 'android') return false;
  if (!processedExifUntrusted(input)) return false;
  if (plan.rotationRequired !== 0 || plan.rotationApplied !== 0) return true;
  const targetLandscape =
    plan.orientation === 'landscape-left' || plan.orientation === 'landscape-right';
  const bitmapLandscape = input.width >= input.height;
  if (targetLandscape) return true;
  return !targetLandscape && bitmapLandscape;
}

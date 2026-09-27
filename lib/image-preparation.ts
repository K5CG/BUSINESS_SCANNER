import type { Action as ImageManipulatorAction } from 'expo-image-manipulator';

export type ExifQuarterTurn = 0 | 90 | 180 | 270;
export type ImageOrientation = 'landscape' | 'portrait' | 'square';
export type ResizeReason = 'long_side_limit' | 'within_limit';

export interface PixelDimensions {
  width: number;
  height: number;
}

export interface LongSideResizePlan {
  input: PixelDimensions;
  oriented: PixelDimensions;
  output: PixelDimensions;
  orientation: ImageOrientation;
  maxLongSide: number;
  scale: number;
  shouldResize: boolean;
  reason: ResizeReason;
  action: ImageManipulatorAction | null;
}

export interface PlannedImageActions {
  actions: ImageManipulatorAction[];
  initial: PixelDimensions;
  output: PixelDimensions;
}

export interface ImageTransformResult {
  uri?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface PreparedImageResult {
  inputUri: string;
  preparedUri: string;
  initial: PixelDimensions;
  output: PixelDimensions;
  transformed: boolean;
  transformCount: 0 | 1;
}

export interface ImagePipelineUris {
  originalUri: string;
  ocrPreparedUri: string;
  previewUri: string;
  persistenceSourceUri: string;
}

export class InvalidImageDimensionsError extends Error {
  constructor() {
    super('INVALID_IMAGE_DIMENSIONS');
    this.name = 'InvalidImageDimensionsError';
  }
}

export class InvalidCropPlanError extends Error {
  constructor() {
    super('INVALID_CROP_PLAN');
    this.name = 'InvalidCropPlanError';
  }
}

export class ImageUpscaleError extends Error {
  constructor() {
    super('IMAGE_UPSCALE_BLOCKED');
    this.name = 'ImageUpscaleError';
  }
}

export class ImageManipulationError extends Error {
  constructor(cause: unknown) {
    super('IMAGE_MANIPULATION_FAILED', { cause });
    this.name = 'ImageManipulationError';
  }
}

export class MissingImageOutputUriError extends Error {
  constructor() {
    super('IMAGE_OUTPUT_URI_MISSING');
    this.name = 'MissingImageOutputUriError';
  }
}

export class ImageOutputNotDistinctError extends Error {
  constructor() {
    super('IMAGE_OUTPUT_NOT_DISTINCT');
    this.name = 'ImageOutputNotDistinctError';
  }
}

export function requireDistinctImageOutputUri(
  inputUri: string,
  outputUri: string | null | undefined
): string {
  const input = inputUri.trim();
  const output = outputUri?.trim();
  if (!output) throw new MissingImageOutputUriError();
  if (output === input) throw new ImageOutputNotDistinctError();
  return output;
}

function isValidDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function assertPixelDimensions(
  width: unknown,
  height: unknown
): PixelDimensions {
  if (!isValidDimension(width) || !isValidDimension(height)) {
    throw new InvalidImageDimensionsError();
  }
  return { width, height };
}

export function normalizeExifQuarterTurn(rotation: number): ExifQuarterTurn {
  if (!Number.isFinite(rotation)) throw new InvalidImageDimensionsError();
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized !== 0 && normalized !== 90 && normalized !== 180 && normalized !== 270) {
    throw new InvalidImageDimensionsError();
  }
  return normalized;
}

export function dimensionsAfterExifRotation(
  width: number,
  height: number,
  exifRotation: number
): PixelDimensions {
  const dimensions = assertPixelDimensions(width, height);
  const rotation = normalizeExifQuarterTurn(exifRotation);
  return rotation === 90 || rotation === 270
    ? { width: dimensions.height, height: dimensions.width }
    : dimensions;
}

function orientationOf({ width, height }: PixelDimensions): ImageOrientation {
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

/**
 * Calcola un resize da applicare dopo la normalizzazione EXIF.
 * Una sola dimensione viene passata al manipolatore per lasciare alla
 * libreria il mantenimento esatto dell'aspect ratio; il risultato atteso
 * completo resta disponibile per diagnostica e test.
 */
export function planLongSideResize(
  width: number | undefined,
  height: number | undefined,
  maxLongSide: number
): LongSideResizePlan {
  const input = assertPixelDimensions(width, height);
  if (!isValidDimension(maxLongSide)) throw new InvalidImageDimensionsError();

  // Il chiamante deve passare dimensioni già normalizzate. Tenere questa
  // policy separata dall'EXIF impedisce di produrre una resize action per
  // assi ruotati e applicarla accidentalmente al bitmap grezzo.
  const oriented = input;
  const orientation = orientationOf(oriented);
  const longSide = Math.max(oriented.width, oriented.height);

  if (longSide <= maxLongSide) {
    return {
      input,
      oriented,
      output: oriented,
      orientation,
      maxLongSide,
      scale: 1,
      shouldResize: false,
      reason: 'within_limit',
      action: null,
    };
  }

  const scale = maxLongSide / longSide;
  const output = {
    width: Math.max(1, Math.round(oriented.width * scale)),
    height: Math.max(1, Math.round(oriented.height * scale)),
  };
  const action: ImageManipulatorAction =
    orientation === 'portrait'
      ? { resize: { height: maxLongSide } }
      : orientation === 'square'
        ? { resize: { width: maxLongSide, height: maxLongSide } }
        : { resize: { width: maxLongSide } };

  return {
    input,
    oriented,
    output,
    orientation,
    maxLongSide,
    scale,
    shouldResize: true,
    reason: 'long_side_limit',
    action,
  };
}

export function clampCropActionToBitmap(
  action: ImageManipulatorAction,
  bitmapWidth: number,
  bitmapHeight: number
): ImageManipulatorAction | null {
  if (!('crop' in action)) return action;
  if (!isValidDimension(bitmapWidth) || !isValidDimension(bitmapHeight)) return null;

  const crop = action.crop;
  const originX = Math.max(
    0,
    Math.min(Math.round(crop.originX), Math.floor(bitmapWidth) - 1)
  );
  const originY = Math.max(
    0,
    Math.min(Math.round(crop.originY), Math.floor(bitmapHeight) - 1)
  );
  const maxWidth = Math.floor(bitmapWidth) - originX;
  const maxHeight = Math.floor(bitmapHeight) - originY;
  const width = Math.min(Math.max(1, Math.round(crop.width)), maxWidth);
  const height = Math.min(Math.max(1, Math.round(crop.height)), maxHeight);

  if (width < 80 || height < 80) return null;
  if (originX + width > bitmapWidth || originY + height > bitmapHeight) return null;

  return {
    crop: {
      originX,
      originY,
      width,
      height,
    },
  };
}

function dimensionsAfterResize(
  current: PixelDimensions,
  resize: { width?: number; height?: number }
): PixelDimensions {
  const hasWidth = resize.width != null;
  const hasHeight = resize.height != null;
  if (!hasWidth && !hasHeight) throw new InvalidImageDimensionsError();
  if (hasWidth && !isValidDimension(resize.width)) throw new InvalidImageDimensionsError();
  if (hasHeight && !isValidDimension(resize.height)) throw new InvalidImageDimensionsError();

  let width: number;
  let height: number;
  if (hasWidth && hasHeight) {
    width = resize.width!;
    height = resize.height!;
    const beforeRatio = current.width / current.height;
    const afterRatio = width / height;
    if (Math.abs(beforeRatio - afterRatio) / beforeRatio > 0.001) {
      throw new InvalidImageDimensionsError();
    }
  } else if (hasWidth) {
    width = resize.width!;
    height = Math.max(1, Math.round(current.height * (width / current.width)));
  } else {
    height = resize.height!;
    width = Math.max(1, Math.round(current.width * (height / current.height)));
  }

  if (width > current.width + 0.5 || height > current.height + 0.5) {
    throw new ImageUpscaleError();
  }
  return { width, height };
}

/**
 * Valida tutte le action nelle dimensioni in cui verranno eseguite e produce
 * una singola lista sicura da passare a ImageManipulator in un solo invio.
 */
export function planImageActions(
  actions: readonly ImageManipulatorAction[],
  initialWidth: number,
  initialHeight: number
): PlannedImageActions {
  const initial = assertPixelDimensions(initialWidth, initialHeight);
  let current = initial;
  const safeActions: ImageManipulatorAction[] = [];

  for (const action of actions) {
    if ('rotate' in action) {
      const rotation = normalizeExifQuarterTurn(action.rotate);
      if (rotation === 0) continue;
      safeActions.push({ rotate: rotation });
      if (rotation === 90 || rotation === 270) {
        current = { width: current.height, height: current.width };
      }
      continue;
    }

    if ('crop' in action) {
      const safe = clampCropActionToBitmap(action, current.width, current.height);
      if (!safe || !('crop' in safe)) throw new InvalidCropPlanError();
      safeActions.push(safe);
      current = { width: safe.crop.width, height: safe.crop.height };
      continue;
    }

    if ('resize' in action) {
      const output = dimensionsAfterResize(current, action.resize);
      if (output.width === current.width && output.height === current.height) continue;
      safeActions.push(action);
      current = output;
      continue;
    }

    // Flip non cambia dimensioni. Extent non è usato nella pipeline mobile,
    // ma resta una action valida e viene lasciata al manipolatore.
    safeActions.push(action);
    if ('extent' in action) {
      current = assertPixelDimensions(action.extent.width, action.extent.height);
    }
  }

  return { actions: safeActions, initial, output: current };
}

export async function prepareImageOnce(
  inputUri: string,
  actions: readonly ImageManipulatorAction[],
  initialWidth: number,
  initialHeight: number,
  transform: (
    uri: string,
    actions: ImageManipulatorAction[]
  ) => Promise<ImageTransformResult>
): Promise<PreparedImageResult> {
  const normalizedInputUri = inputUri.trim();
  if (!normalizedInputUri) throw new MissingImageOutputUriError();

  const planned = planImageActions(actions, initialWidth, initialHeight);
  if (planned.actions.length === 0) {
    return {
      inputUri: normalizedInputUri,
      preparedUri: normalizedInputUri,
      initial: planned.initial,
      output: planned.output,
      transformed: false,
      transformCount: 0,
    };
  }

  let result: ImageTransformResult;
  try {
    result = await transform(normalizedInputUri, planned.actions);
  } catch (error) {
    throw new ImageManipulationError(error);
  }

  const preparedUri = requireDistinctImageOutputUri(normalizedInputUri, result.uri);
  const output =
    isValidDimension(result.width) && isValidDimension(result.height)
      ? { width: result.width, height: result.height }
      : planned.output;

  return {
    inputUri: normalizedInputUri,
    preparedUri,
    initial: planned.initial,
    output,
    transformed: true,
    transformCount: 1,
  };
}

export function imagePipelineUris(
  originalUri: string,
  ocrPreparedUri: string,
): ImagePipelineUris {
  const original = originalUri.trim();
  const prepared = ocrPreparedUri.trim();
  if (!original || !prepared) throw new MissingImageOutputUriError();
  return {
    originalUri: original,
    ocrPreparedUri: prepared,
    previewUri: prepared,
    // La saga Fase 1 copia questa sorgente temporanea nello storage definitivo.
    persistenceSourceUri: prepared,
  };
}

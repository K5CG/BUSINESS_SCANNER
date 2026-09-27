import * as ImageManipulator from 'expo-image-manipulator';
import { decode } from 'jpeg-js';
import type { CardOrientation, DocumentType } from '../types';
import {
  buildScanManipulatorActions,
  getImageSize,
  type ScanManipulatorPlan,
} from './image-utils';
import type { CameraResolutionDiag } from './camera-focus-gate';
import { planImageActions, planLongSideResize } from './image-preparation';
import { runtimeLogger } from './safe-runtime-logger';

/** Varianza Laplaciana minima (immagine analizzata a ~320px di larghezza). */
export const SHARPNESS_MIN_VARIANCE = 85;

/** Soglia più bassa se AF non ha lockato (PASSIVE_SCAN / TIMEOUT). */
export const SHARPNESS_MIN_VARIANCE_NO_AF_LOCK = 35;

export type SharpnessGateMode = 'strict' | 'business_card';

function evaluateSharpnessGate(
  fullScore: number,
  zoneScores: Record<string, number>,
  threshold: number,
  mode: SharpnessGateMode = 'strict'
): { gateScore: number; passed: boolean } {
  const zones = Object.values(zoneScores);
  if (!zones.length) {
    return { gateScore: fullScore, passed: fullScore >= threshold };
  }

  const minZone = Math.min(...zones);
  const maxZone = Math.max(...zones);
  const sorted = [...zones].sort((a, b) => a - b);
  const medianZone = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const strongZones = zones.filter((z) => z >= threshold).length;

  if (mode === 'business_card') {
    // Non usare il punteggio globale come via libera autonoma: sul biglietto
    // inclinato/sfocato il bordo carta e lo sfondo possono alzare fullScore
    // anche quando il testo interno resta morbido. Il gate resta permissivo
    // sui biglietti con poco testo: basta una zona realmente nitida oppure una
    // nitidezza moderata distribuita su piu zone.
    const peripheralStrong = maxZone >= threshold * 0.8;
    const distributedReadable = medianZone >= threshold * 0.55;
    const passed = peripheralStrong || distributedReadable || strongZones >= 2;
    const gateScore = Math.max(
      medianZone,
      maxZone * 0.8,
      Math.min(fullScore, maxZone)
    );
    return { gateScore, passed };
  }

  const gateScore = Math.min(fullScore, minZone);
  return { gateScore, passed: gateScore >= threshold };
}

const SHARPNESS_SAMPLE_WIDTH = 320;

export interface SharpnessResult {
  score: number;
  sampleWidth: number;
  sampleHeight: number;
  cropWidth: number;
  cropHeight: number;
  passed: boolean;
  /** Score minimo tra ROI interne (centro + quadranti). */
  minZoneScore?: number;
  zoneScores?: Record<string, number>;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function rgbaToGray(data: Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
  }
  return gray;
}

/** Varianza del filtro Laplaciano 3×3 — proxy standard di nitidezza. */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = gray[y * width + x];
      const lap =
        gray[(y - 1) * width + x] +
        gray[(y + 1) * width + x] +
        gray[y * width + (x - 1)] +
        gray[y * width + (x + 1)] -
        4 * c;
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

function decodeJpegBase64ToGray(base64: string): { gray: Uint8Array; width: number; height: number } | null {
  try {
    const decoded = decode(base64ToUint8Array(base64), { useTArray: true });
    const gray = rgbaToGray(decoded.data, decoded.width, decoded.height);
    return { gray, width: decoded.width, height: decoded.height };
  } catch {
    return null;
  }
}

function sampleRegionVariance(
  gray: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number
): number {
  const x1 = Math.min(width, x0 + w);
  const y1 = Math.min(height, y0 + h);
  if (x1 - x0 < 8 || y1 - y0 < 8) return 0;
  const sub = new Uint8Array((x1 - x0) * (y1 - y0));
  let p = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sub[p++] = gray[y * width + x];
    }
  }
  return laplacianVariance(sub, x1 - x0, y1 - y0);
}

/** Nitidezza su più ROI interne — usa il minimo (zona più soft). */
export function measureMultiZoneSharpness(
  gray: Uint8Array,
  width: number,
  height: number
): { score: number; minZoneScore: number; zoneScores: Record<string, number> } {
  const marginX = Math.floor(width * 0.12);
  const marginY = Math.floor(height * 0.12);
  const innerW = width - marginX * 2;
  const innerH = height - marginY * 2;
  const halfW = Math.floor(innerW / 2);
  const halfH = Math.floor(innerH / 2);

  const zones: Record<string, { x: number; y: number; w: number; h: number }> = {
    center: { x: marginX + Math.floor(innerW * 0.25), y: marginY + Math.floor(innerH * 0.25), w: Math.floor(innerW * 0.5), h: Math.floor(innerH * 0.5) },
    top: { x: marginX, y: marginY, w: innerW, h: halfH },
    bottom: { x: marginX, y: marginY + halfH, w: innerW, h: halfH },
    left: { x: marginX, y: marginY, w: halfW, h: innerH },
    right: { x: marginX + halfW, y: marginY, w: halfW, h: innerH },
  };

  const zoneScores: Record<string, number> = {};
  let minZoneScore = Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const [name, z] of Object.entries(zones)) {
    const s = sampleRegionVariance(gray, width, height, z.x, z.y, z.w, z.h);
    zoneScores[name] = s;
    sum += s;
    if (s < minZoneScore) minZoneScore = s;
  }
  const score = minZoneScore < Number.POSITIVE_INFINITY ? minZoneScore : 0;
  return { score, minZoneScore: score, zoneScores };
}

async function sampleGrayFromUri(
  uri: string,
  preActions: ImageManipulator.Action[],
  initialDimensions?: { width: number; height: number }
): Promise<{ gray: Uint8Array; width: number; height: number } | null> {
  let initial = initialDimensions;
  if (!initial) {
    try {
      initial = await getImageSize(uri);
    } catch {
      return null;
    }
  }
  const prePlan = planImageActions(
    preActions,
    initial.width,
    initial.height
  );
  const resizePlan = planLongSideResize(
    prePlan.output.width,
    prePlan.output.height,
    SHARPNESS_SAMPLE_WIDTH
  );
  const actions: ImageManipulator.Action[] = [
    ...preActions,
    ...(resizePlan.action ? [resizePlan.action] : []),
  ];
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: 1,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  });
  if (!result.base64) return null;
  return decodeJpegBase64ToGray(result.base64);
}

/** Misura nitidezza sulla stessa regione di crop usata per OCR/salvataggio. */
export async function measureScanRegionSharpness(
  uri: string,
  plan: ScanManipulatorPlan,
  options: { afLocked?: boolean; gateMode?: SharpnessGateMode } = {}
): Promise<SharpnessResult> {
  const preOrientActions = plan.actions.filter((action) => !('resize' in action));
  const sampled = await sampleGrayFromUri(uri, preOrientActions, {
    width: plan.originalWidth,
    height: plan.originalHeight,
  });

  if (!sampled) {
    return {
      score: 0,
      sampleWidth: 0,
      sampleHeight: 0,
      cropWidth: plan.cropWidth,
      cropHeight: plan.cropHeight,
      passed: false,
    };
  }

  const score = laplacianVariance(sampled.gray, sampled.width, sampled.height);
  const multi = measureMultiZoneSharpness(sampled.gray, sampled.width, sampled.height);
  const gateMode = options.gateMode ?? 'strict';
  const threshold =
    options.afLocked === false && gateMode === 'strict'
      ? SHARPNESS_MIN_VARIANCE_NO_AF_LOCK
      : SHARPNESS_MIN_VARIANCE;
  const gate = evaluateSharpnessGate(score, multi.zoneScores, threshold, gateMode);
  return {
    score: gate.gateScore,
    sampleWidth: sampled.width,
    sampleHeight: sampled.height,
    cropWidth: plan.cropWidth,
    cropHeight: plan.cropHeight,
    passed: gate.passed,
    minZoneScore: multi.minZoneScore,
    zoneScores: multi.zoneScores,
  };
}

/**
 * Gate leggero sulla carta GIA isolata dal boundary.
 *
 * Il vecchio gate business-card lavorava sul crop della cornice e poteva
 * essere falsato dal tappetino nitido attorno al biglietto. Qui analizziamo
 * una sola volta l'output fisico gia isolato, sempre a ~320 px.
 *
 * Regola deliberatamente permissiva: rifiuta soltanto quando NESSUNA zona ha
 * dettaglio forte e anche la mediana resta molto bassa. In questo modo un
 * biglietto con poco testo non viene bocciato solo perche ha ampie zone vuote.
 */
export interface PreparedBusinessCardSharpnessResult extends SharpnessResult {
  medianZoneScore: number;
  maxZoneScore: number;
  measured: boolean;
}

/**
 * A verified camera-overlay crop may be used when the physical paper edge is
 * invisible (for example dark stock on a dark surface), but only when the
 * image measurement itself completed and found readable internal detail.
 */
export function shouldUseVerifiedOverlayFallback(
  result: PreparedBusinessCardSharpnessResult,
): boolean {
  return result.measured && result.passed && result.sampleWidth > 0 && result.sampleHeight > 0;
}

export async function measurePreparedBusinessCardSharpness(
  uri: string
): Promise<PreparedBusinessCardSharpnessResult> {
  const sampled = await sampleGrayFromUri(uri, []);
  if (!sampled) {
    // Fail-open: un problema della diagnostica non deve costringere l'utente
    // a rifare una foto che potrebbe essere perfettamente utilizzabile.
    return {
      score: 0,
      sampleWidth: 0,
      sampleHeight: 0,
      cropWidth: 0,
      cropHeight: 0,
      passed: true,
      minZoneScore: 0,
      zoneScores: {},
      medianZoneScore: 0,
      maxZoneScore: 0,
      measured: false,
    };
  }

  const fullScore = laplacianVariance(sampled.gray, sampled.width, sampled.height);
  const multi = measureMultiZoneSharpness(sampled.gray, sampled.width, sampled.height);
  const zones = Object.values(multi.zoneScores).sort((a, b) => a - b);
  const medianZoneScore = zones[Math.floor(zones.length / 2)] ?? 0;
  const maxZoneScore = zones[zones.length - 1] ?? 0;

  // Soglia P0 volutamente bassa: sui corpus camera reali separa le catture
  // realmente illeggibili da quelle semplicemente sparse/contrastate.
  // Usa due segnali OR per non penalizzare biglietti con testo concentrato.
  const enoughStrongDetail = maxZoneScore >= SHARPNESS_MIN_VARIANCE * 3.0;
  const enoughDistributedDetail = medianZoneScore >= SHARPNESS_MIN_VARIANCE * 1.7;
  const passed = enoughStrongDetail || enoughDistributedDetail;
  const gateScore = Math.max(
    medianZoneScore,
    maxZoneScore * 0.8,
    Math.min(fullScore, maxZoneScore),
  );

  return {
    score: gateScore,
    sampleWidth: sampled.width,
    sampleHeight: sampled.height,
    cropWidth: sampled.width,
    cropHeight: sampled.height,
    passed,
    minZoneScore: multi.minZoneScore,
    zoneScores: multi.zoneScores,
    medianZoneScore,
    maxZoneScore,
    measured: true,
  };
}

/** Misura nitidezza sull'intero frame (es. foto persona senza crop biglietto). */
export async function measureFullFrameSharpness(
  uri: string,
  preActions: ImageManipulator.Action[] = []
): Promise<SharpnessResult> {
  const sampled = await sampleGrayFromUri(uri, preActions);
  if (!sampled) {
    return {
      score: 0,
      sampleWidth: 0,
      sampleHeight: 0,
      cropWidth: 0,
      cropHeight: 0,
      passed: false,
    };
  }

  const score = laplacianVariance(sampled.gray, sampled.width, sampled.height);
  const multi = measureMultiZoneSharpness(sampled.gray, sampled.width, sampled.height);
  const gateScore = Math.min(score, multi.minZoneScore);
  return {
    score: gateScore,
    sampleWidth: sampled.width,
    sampleHeight: sampled.height,
    cropWidth: sampled.width,
    cropHeight: sampled.height,
    passed: gateScore >= SHARPNESS_MIN_VARIANCE,
    minZoneScore: multi.minZoneScore,
    zoneScores: multi.zoneScores,
  };
}

export interface CaptureDebugLog {
  originalWidth: number;
  originalHeight: number;
  cropWidth: number;
  cropHeight: number;
  sharpnessScore: number;
  sharpnessPassed: boolean;
  minZoneScore?: number;
  zoneScores?: Record<string, number>;
  retryCount: number;
  focusPoint: { nx: number; ny: number };
  documentType: DocumentType;
  cardOrientation: CardOrientation;
  afState?: string;
  cameraDiag?: CameraResolutionDiag | null;
}

export function logCaptureDebug(info: CaptureDebugLog): void {
  if (!__DEV__) return;
  const diag = info.cameraDiag;
  runtimeLogger.debug(
    'CAMERA_CAPTURE_DIAGNOSTIC',
    {
      status: 'completed',
      stage: 'capture',
      source: 'camera',
      width: info.cropWidth,
      height: info.cropHeight,
      count: info.retryCount,
      documentType: info.documentType,
    },
    {
      original: `${info.originalWidth}x${info.originalHeight}`,
      crop: `${info.cropWidth}x${info.cropHeight}`,
      sharpness: info.sharpnessScore.toFixed(1),
      sharpnessPassed: info.sharpnessPassed,
      minZone: info.minZoneScore?.toFixed(1),
      zones: info.zoneScores,
      retry: info.retryCount,
      focusPoint: info.focusPoint,
      documentType: info.documentType,
      orientation: info.cardOrientation,
      afState: info.afState,
      previewStream: diag?.previewStreamSize,
      imageCapture: diag?.imageCaptureSize,
      previewView: diag
        ? `${diag.previewViewWidth ?? '?'}x${diag.previewViewHeight ?? '?'}`
        : undefined,
    }
  );
}

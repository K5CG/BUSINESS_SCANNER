/**
 * Gate acquisizione: attende AF_STATE reale (patch expo-camera v4) con timeline.
 * Lo stato AF è per-istanza (createFocusGate), non singleton di modulo.
 */

import { runtimeLogger } from './safe-runtime-logger';

export type AfState =
  | 'ACTIVE_SCAN'
  | 'PASSIVE_SCAN'
  | 'FOCUSED_LOCKED'
  | 'NOT_FOCUSED_LOCKED'
  | 'CAMERA_OPEN'
  | 'TIMEOUT';

/**
 * Le capacità di zoom arrivano su questo stesso canale nativo ma NON sono uno
 * stato di messa a fuoco: vanno raccolte senza toccare la macchina a stati AF.
 */
export const CAMERA_ZOOM_RANGE_STATE = 'CAMERA_ZOOM_RANGE';

export interface AfStateEvent {
  state: AfState;
  previewWidth?: number;
  previewHeight?: number;
  previewStreamSize?: string;
  imageCaptureSize?: string;
  captureSizes?: string;
  /** Intervallo di zoom del dispositivo — serve a tradurre un ingrandimento. */
  minZoomRatio?: number;
  maxZoomRatio?: number;
  /** Rapporto di zoom realmente applicato da CameraX. */
  zoomRatio?: number;
  focusSuccessful?: boolean;
  elapsedMs?: number;
}

export interface CameraResolutionDiag {
  previewViewWidth?: number;
  previewViewHeight?: number;
  previewStreamSize?: string;
  imageCaptureSize?: string;
  captureSizes?: string;
  pictureSizeSelected?: string;
  minZoomRatio?: number;
  maxZoomRatio?: number;
  zoomRatio?: number;
  updatedAt: number;
}

export interface FocusTimelineEntry {
  at: number;
  label: string;
  detail?: string;
}

export interface FocusGate {
  onAutofocusStateChanged: (event: { nativeEvent: Record<string, unknown> }) => void;
  waitForFocusedLocked: (timeoutMs?: number) => Promise<AfState>;
  getLastAfState: () => AfState;
  getCameraResolutionDiag: () => CameraResolutionDiag | null;
  setPictureSizeDiag: (selected?: string) => void;
  logFocusTimeline: (label: string, detail?: string) => void;
  resetFocusTimeline: () => void;
  /** Invalida lock AF precedente (es. dopo flip retro biglietto). */
  invalidateFocusLock: () => void;
  reset: () => void;
  getFocusTimeline: () => FocusTimelineEntry[];
  formatFocusTimeline: () => string;
}

export function parseAfNativeEvent(nativeEvent: Record<string, unknown>): AfStateEvent {
  return {
    state: String(nativeEvent.state ?? 'PASSIVE_SCAN') as AfState,
    previewWidth:
      typeof nativeEvent.previewWidth === 'number'
        ? nativeEvent.previewWidth
        : typeof nativeEvent.previewViewWidth === 'number'
          ? nativeEvent.previewViewWidth
          : undefined,
    previewHeight:
      typeof nativeEvent.previewHeight === 'number'
        ? nativeEvent.previewHeight
        : typeof nativeEvent.previewViewHeight === 'number'
          ? nativeEvent.previewViewHeight
          : undefined,
    previewStreamSize:
      typeof nativeEvent.previewStreamSize === 'string' ? nativeEvent.previewStreamSize : undefined,
    imageCaptureSize:
      typeof nativeEvent.imageCaptureSize === 'string' ? nativeEvent.imageCaptureSize : undefined,
    captureSizes: typeof nativeEvent.captureSizes === 'string' ? nativeEvent.captureSizes : undefined,
    minZoomRatio:
      typeof nativeEvent.minZoomRatio === 'number' ? nativeEvent.minZoomRatio : undefined,
    maxZoomRatio:
      typeof nativeEvent.maxZoomRatio === 'number' ? nativeEvent.maxZoomRatio : undefined,
    zoomRatio: typeof nativeEvent.zoomRatio === 'number' ? nativeEvent.zoomRatio : undefined,
    focusSuccessful:
      typeof nativeEvent.focusSuccessful === 'boolean' ? nativeEvent.focusSuccessful : undefined,
  };
}

export function createFocusGate(): FocusGate {
  const timeline: FocusTimelineEntry[] = [];
  let lastAfState: AfState = 'PASSIVE_SCAN';
  let cameraDiag: CameraResolutionDiag | null = null;
  let pending: ((state: AfState) => void) | null = null;

  const logFocusTimeline = (label: string, detail?: string) => {
    const entry = { at: Date.now(), label, detail };
    timeline.push(entry);
    if (__DEV__) {
      runtimeLogger.debug(
        'FOCUS_TIMELINE',
        {
          status: 'active',
          stage: 'capture',
          source: 'camera',
          count: timeline.length,
        },
        { label, detail }
      );
    }
  };

  const resetFocusTimeline = () => {
    timeline.length = 0;
  };

  const invalidateFocusLock = () => {
    lastAfState = 'PASSIVE_SCAN';
    pending = null;
    logFocusTimeline('FOCUS_LOCK_INVALIDATED');
  };

  const reset = () => {
    resetFocusTimeline();
    lastAfState = 'PASSIVE_SCAN';
    cameraDiag = null;
    pending = null;
  };

  const getFocusTimeline = () => [...timeline];

  const formatFocusTimeline = () => {
    if (!timeline.length) return '';
    const t0 = timeline[0].at;
    return timeline
      .map((e) => {
        const delta = e.at - t0;
        const detail = e.detail ? ` (${e.detail})` : '';
        return `+${delta}ms ${e.label}${detail}`;
      })
      .join('\n');
  };

  const applyCameraDiag = (parsed: AfStateEvent) => {
    if (parsed.state !== 'CAMERA_OPEN') return;
    cameraDiag = {
      previewViewWidth: parsed.previewWidth,
      previewViewHeight: parsed.previewHeight,
      previewStreamSize: parsed.previewStreamSize,
      imageCaptureSize: parsed.imageCaptureSize,
      captureSizes: parsed.captureSizes,
      pictureSizeSelected: cameraDiag?.pictureSizeSelected,
      // All'apertura `zoomState` può non essere ancora pronto e il nativo
      // ripiega su 1: la misura osservata, quando c'è, vale di più.
      minZoomRatio: parsed.minZoomRatio ?? cameraDiag?.minZoomRatio,
      maxZoomRatio:
        Math.max(parsed.maxZoomRatio ?? 0, cameraDiag?.maxZoomRatio ?? 0) || undefined,
      zoomRatio: cameraDiag?.zoomRatio,
      updatedAt: Date.now(),
    };
    if (__DEV__) {
      runtimeLogger.debug(
        'CAMERA_DIAGNOSTIC',
        {
          status: 'active',
          stage: 'capture',
          source: 'camera',
          width: parsed.previewWidth,
          height: parsed.previewHeight,
        },
        {
          previewView: `${parsed.previewWidth ?? '?'}x${parsed.previewHeight ?? '?'}`,
          previewStream: parsed.previewStreamSize ?? '?',
          imageCapture: parsed.imageCaptureSize ?? '?',
          jpegSizes: parsed.captureSizes?.split(',').slice(0, 4),
        }
      );
    }
  };

  const onAutofocusStateChanged = (event: { nativeEvent: Record<string, unknown> }) => {
    const parsed = parseAfNativeEvent(event.nativeEvent);
    // Le capacità di zoom viaggiano sullo stesso canale nativo ma non sono uno
    // stato di messa a fuoco: aggiornarle qui non deve spostare l'attesa AF né
    // sovrascrivere l'ultimo stato reale.
    if ((parsed.state as string) === CAMERA_ZOOM_RANGE_STATE) {
      cameraDiag = {
        ...(cameraDiag ?? { updatedAt: Date.now() }),
        minZoomRatio: parsed.minZoomRatio,
        maxZoomRatio: parsed.maxZoomRatio,
        zoomRatio: parsed.zoomRatio,
        updatedAt: Date.now(),
      };
      return;
    }
    lastAfState = parsed.state;
    applyCameraDiag(parsed);
    logFocusTimeline(parsed.state, JSON.stringify(parsed));
    pending?.(parsed.state);
  };

  const waitForFocusedLocked = (timeoutMs = 3000): Promise<AfState> =>
    new Promise((resolve) => {
      if (lastAfState === 'FOCUSED_LOCKED') {
        logFocusTimeline('FOCUSED_LOCKED', 'already-locked');
        resolve('FOCUSED_LOCKED');
        return;
      }

      const started = Date.now();
      let settled = false;
      const finish = (state: AfState) => {
        if (settled) return;
        settled = true;
        pending = null;
        clearTimeout(timer);
        logFocusTimeline(state, `elapsed=${Date.now() - started}ms`);
        resolve(state);
      };

      pending = (state) => {
        // NOT_FOCUSED_LOCKED e uno stato terminale della ricerca nativa, ma
        // non autorizza lo scatto: continuiamo ad attendere un vero lock fino
        // al budget globale e restituiamo TIMEOUT se non arriva.
        if (state === 'FOCUSED_LOCKED') finish(state);
      };

      const timer = setTimeout(() => {
        // TIMEOUT non blocca lo scatto: il chiamante può proseguire se la nitidezza passa.
        finish('TIMEOUT');
      }, timeoutMs);
    });

  const setPictureSizeDiag = (selected?: string) => {
    cameraDiag = {
      ...(cameraDiag ?? { updatedAt: Date.now() }),
      pictureSizeSelected: selected,
      updatedAt: Date.now(),
    };
  };

  return {
    onAutofocusStateChanged,
    waitForFocusedLocked,
    getLastAfState: () => lastAfState,
    getCameraResolutionDiag: () => cameraDiag,
    setPictureSizeDiag,
    logFocusTimeline,
    resetFocusTimeline,
    invalidateFocusLock,
    reset,
    getFocusTimeline,
    formatFocusTimeline,
  };
}

/** Sceglie la risoluzione JPEG massima tra quelle disponibili (es. "4000x3000"). */
export function pickMaxPictureSize(sizes: string[]): string | undefined {
  let best: { pixels: number; label: string } | null = null;
  for (const raw of sizes) {
    const m = raw.match(/^(\d+)x(\d+)$/);
    if (!m) continue;
    const w = Number(m[1]);
    const h = Number(m[2]);
    const pixels = w * h;
    if (!best || pixels > best.pixels) best = { pixels, label: raw };
  }
  return best?.label;
}

export function formatCameraDiag(diag: CameraResolutionDiag | null): string {
  if (!diag) return 'Risoluzioni: in attesa CAMERA_OPEN…';
  const lines = [
    `Preview view: ${diag.previewViewWidth ?? '?'}×${diag.previewViewHeight ?? '?'}`,
    `Preview stream (CameraX): ${diag.previewStreamSize ?? '?'}`,
    `ImageCapture bound: ${diag.imageCaptureSize ?? '?'}`,
    `pictureSize prop: ${diag.pictureSizeSelected ?? 'default'}`,
    `JPEG sensor sizes: ${diag.captureSizes?.split(',').slice(0, 4).join(' | ') ?? '?'}`,
  ];
  return lines.join('\n');
}

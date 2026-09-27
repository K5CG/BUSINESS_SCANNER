/**
 * Diagnostica della messa a fuoco, separata per biglietto e documenti.
 *
 * Serve a rispondere a una domanda sola: quando l'otturatore lavora davvero, la
 * camera aveva il fuoco fermo oppure stava ancora cercando? Per saperlo non
 * basta lo stato prima dello scatto: servono gli istanti di inizio e fine della
 * cattura JPEG, perché è in quell'intervallo che una nuova ricerca rovina
 * l'immagine.
 *
 * Vengono registrati stati e tempi: nessun testo riconosciuto, nessun URI,
 * nessun dato del contatto o del documento. Va disattivata prima della
 * pubblicazione.
 */
import { CARD_GEOMETRY_QA_DIAGNOSTICS } from './card-capture-diagnostics';

export type FocusChannel = 'CardFocus' | 'DocumentFocus';

export interface FocusLog {
  state: string;
  timestamp: number;
  timeSinceCameraReady: number | null;
  timeSinceLastFocusChange: number | null;
  captureRequested: boolean;
  jpegCaptureStarted: boolean;
  jpegCaptureCompleted: boolean;
  captureExecuted: boolean;
}

export function formatFocusLog(channel: FocusChannel, entry: FocusLog): string {
  return `[${channel}] ${JSON.stringify(entry)}`;
}

export interface FocusTracker {
  setEnabled: (enabled: boolean) => void;
  markCameraReady: () => void;
  markState: (state: string) => void;
  markCaptureRequested: () => void;
  markFocusHeld: () => void;
  markJpegStarted: () => void;
  markJpegCompleted: (state: string) => void;
  markFocusReleased: () => void;
  reset: () => void;
}

export function createFocusTracker(emit: (entry: FocusLog) => void): FocusTracker {
  let enabled = false;
  let cameraReadyAt: number | null = null;
  let lastFocusChangeAt: number | null = null;
  let captureRequested = false;
  let jpegCaptureStarted = false;
  let jpegCaptureCompleted = false;

  const log = (state: string) => {
    if (!enabled) return;
    const now = Date.now();
    emit({
      state,
      timestamp: now,
      timeSinceCameraReady: cameraReadyAt === null ? null : now - cameraReadyAt,
      timeSinceLastFocusChange:
        lastFocusChangeAt === null ? null : now - lastFocusChangeAt,
      captureRequested,
      jpegCaptureStarted,
      jpegCaptureCompleted,
      // La cattura è eseguita solo quando il JPEG è concluso: dichiararlo prima
      // nascondeva proprio l'intervallo in cui il fuoco poteva ripartire.
      captureExecuted: jpegCaptureCompleted,
    });
  };

  const resetCaptureFlags = () => {
    captureRequested = false;
    jpegCaptureStarted = false;
    jpegCaptureCompleted = false;
  };

  return {
    setEnabled: (value) => {
      enabled = value;
    },
    markCameraReady: () => {
      cameraReadyAt = Date.now();
      lastFocusChangeAt = null;
      resetCaptureFlags();
      log('CAMERA_READY');
    },
    markState: (state) => {
      log(state);
      lastFocusChangeAt = Date.now();
    },
    markCaptureRequested: () => {
      resetCaptureFlags();
      captureRequested = true;
      log('CAPTURE_REQUESTED');
    },
    markFocusHeld: () => log('FOCUS_HELD'),
    markJpegStarted: () => {
      jpegCaptureStarted = true;
      log('JPEG_CAPTURE_STARTED');
    },
    markJpegCompleted: (state) => {
      jpegCaptureCompleted = true;
      log('JPEG_CAPTURE_COMPLETED');
      if (state) log(state);
    },
    markFocusReleased: () => log('FOCUS_RELEASED'),
    reset: () => {
      cameraReadyAt = null;
      lastFocusChangeAt = null;
      resetCaptureFlags();
    },
  };
}

const emitter = (channel: FocusChannel) => (entry: FocusLog) => {
  if (!CARD_GEOMETRY_QA_DIAGNOSTICS) return;
  console.warn(formatFocusLog(channel, entry));
};

export const cardFocusTracker = createFocusTracker(emitter('CardFocus'));
export const documentFocusTracker = createFocusTracker(emitter('DocumentFocus'));

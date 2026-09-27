import type {
  DocumentProcessProgress,
  DocumentProcessProgressListener,
  DocumentProcessStage,
} from './document-process-progress';
import { PDF_LOCAL_DIAGNOSTICS } from './pdf-import-local';
import { isQaLogEnabled } from './release-diagnostics';

/**
 * L'import PDF attraversa fasi proprie. Durante l'attesa del servizio AI la barra
 * avanza lentamente per UX, senza mai fingere il completamento del provider.
 */
export type PdfImportStage =
  | 'prepare'
  | 'read'
  | 'payload'
  | 'upload'
  | 'extract'
  | 'verify'
  | 'persist'
  | 'done';

/** Tetto UX mentre la chiamata Edge è ancora in corso. */
export const PDF_AI_WAIT_CEILING = 78;

const PDF_STAGE_PERCENT: Record<PdfImportStage, number> = {
  prepare: 10,
  read: 20,
  payload: 30,
  upload: 35,
  extract: 80,
  verify: 90,
  persist: 95,
  done: 100,
};

const PDF_STAGE_MESSAGE: Record<PdfImportStage, string> = {
  prepare: 'processing.pdfPrepare',
  read: 'processing.pdfRead',
  payload: 'processing.pdfPayload',
  upload: 'processing.pdfUpload',
  extract: 'processing.pdfExtract',
  verify: 'processing.pdfVerify',
  persist: 'processing.persist',
  done: 'processing.done',
};

/**
 * Il riquadro di avanzamento mostra soltanto percentuale e messaggio, ma il tipo
 * condiviso richiede una fase: si riusa quella piu' vicina della pipeline esistente
 * per non toccare il percorso della fotocamera.
 */
const SHARED_STAGE: Record<PdfImportStage, DocumentProcessStage> = {
  prepare: 'prepare',
  read: 'ocr',
  payload: 'page_results',
  upload: 'metadata',
  extract: 'items_totals',
  verify: 'reconciliation',
  persist: 'persist',
  done: 'done',
};

export function setPdfProgressMonotonic(current: number, next: number): number {
  const clampedNext = Math.min(100, Math.max(0, next));
  return Math.max(0, Math.min(100, Math.max(current, clampedNext)));
}

/**
 * Passo successivo dell'interpolazione 35→78: passi più ampi all'inizio,
 * poi sempre più piccoli avvicinandosi al tetto.
 */
export function nextAiWaitPercent(current: number): number {
  if (current >= PDF_AI_WAIT_CEILING) return PDF_AI_WAIT_CEILING;
  const remaining = PDF_AI_WAIT_CEILING - current;
  const step =
    remaining > 15 ? 4 : remaining > 9 ? 3 : remaining > 5 ? 2 : 1;
  return Math.min(PDF_AI_WAIT_CEILING, current + step);
}

export function pdfStageProgress(stage: PdfImportStage): DocumentProcessProgress {
  return {
    stage: SHARED_STAGE[stage],
    percent: PDF_STAGE_PERCENT[stage],
    messageKey: PDF_STAGE_MESSAGE[stage],
  };
}

const PDF_PROGRESS_PHASE_LABEL: Record<string, string> = {
  'processing.pdfPrepare': 'Preparazione PDF',
  'processing.pdfRead': 'Lettura PDF',
  'processing.pdfPayload': 'Preparazione dati',
  'processing.pdfUpload': 'Invio al servizio AI',
  'processing.pdfExtract': 'Elaborazione con AI',
  'processing.pdfVerify': 'Verifica dati',
  'processing.persist': 'Salvataggio',
  'processing.done': 'Completato',
};

export type PdfProgressLogSource = 'real_event' | 'ai_interpolation';

/** Dedup diagnostica: evita log ripetuti se percentuale e fase non cambiano. */
let lastPdfProgressLog: { progress: number; phase: string } | null = null;

export function resetPdfProgressDiagnostics(): void {
  lastPdfProgressLog = null;
}

/**
 * Log QA temporaneo della barra PDF. Solo valori sanitizzati (niente path/testo documento).
 * Non emette se progress+phase sono uguali all'ultimo log.
 */
export function logPdfProgressChange(
  progress: number,
  phase: string,
  source: PdfProgressLogSource
): void {
  if (
    lastPdfProgressLog &&
    lastPdfProgressLog.progress === progress &&
    lastPdfProgressLog.phase === phase
  ) {
    return;
  }
  lastPdfProgressLog = { progress, phase };
  // QA-gated: RC PDF flag + central release diagnostics gate.
  if (!PDF_LOCAL_DIAGNOSTICS || !isQaLogEnabled()) return;
  console.warn(
    `[PdfProgress] ${JSON.stringify({ progress, phase, source })}`
  );
}

export function pdfProgressPhaseLabel(messageKey: string): string {
  return PDF_PROGRESS_PHASE_LABEL[messageKey] ?? messageKey;
}

export type PdfImportProgressScheduler = {
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Restituisce un numero in [0, 1) per variare l'intervallo 400–700 ms. */
  randomFn?: () => number;
};

/** Avanzamento monotono: una fase gia' superata non riporta mai indietro la barra. */
export function createPdfImportProgressReporter(
  listener?: DocumentProcessProgressListener,
  scheduler?: PdfImportProgressScheduler
) {
  let lastPercent = 0;
  let disposed = false;
  let aiWaiting = false;
  let waitTimer: unknown = null;

  const setTimeoutFn =
    scheduler?.setTimeoutFn ??
    ((handler: () => void, ms: number) => setTimeout(handler, ms));
  const clearTimeoutFn =
    scheduler?.clearTimeoutFn ??
    ((handle: unknown) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const randomFn = scheduler?.randomFn ?? Math.random;

  const emit = (
    progress: DocumentProcessProgress,
    source: PdfProgressLogSource
  ): void => {
    if (disposed) return;
    const percent = setPdfProgressMonotonic(lastPercent, progress.percent);
    const phase = pdfProgressPhaseLabel(progress.messageKey);
    logPdfProgressChange(percent, phase, source);
    lastPercent = percent;
    listener?.({ ...progress, percent });
  };

  const clearAiWaitTimer = (): void => {
    if (waitTimer != null) {
      clearTimeoutFn(waitTimer);
      waitTimer = null;
    }
  };

  const stopAiWait = (): void => {
    aiWaiting = false;
    clearAiWaitTimer();
  };

  const scheduleAiTick = (): void => {
    if (!aiWaiting || disposed) return;
    const delayMs = 400 + Math.floor(randomFn() * 301);
    waitTimer = setTimeoutFn(() => {
      waitTimer = null;
      if (!aiWaiting || disposed) return;
      const next = nextAiWaitPercent(lastPercent);
      if (next > lastPercent) {
        emit(
          {
            stage: SHARED_STAGE.upload,
            percent: next,
            messageKey: 'processing.pdfExtract',
          },
          'ai_interpolation'
        );
      }
      if (lastPercent < PDF_AI_WAIT_CEILING) {
        scheduleAiTick();
      }
    }, delayMs);
  };

  const beginAiWait = (): void => {
    if (disposed) return;
    stopAiWait();
    aiWaiting = true;
    scheduleAiTick();
  };

  return {
    stage(stage: PdfImportStage): void {
      if (disposed) return;
      if (stage !== 'upload') {
        stopAiWait();
      }
      emit(pdfStageProgress(stage), 'real_event');
      if (stage === 'upload') {
        beginAiWait();
      }
    },
    /** Ferma l'interpolazione senza avanzare a 80 (errore / risposta vuota). */
    stopAiWait,
    /** Annulla timer e ignora ulteriori aggiornamenti. */
    dispose(): void {
      stopAiWait();
      disposed = true;
    },
    get lastPercent(): number {
      return lastPercent;
    },
    get isAiWaiting(): boolean {
      return aiWaiting;
    },
  };
}

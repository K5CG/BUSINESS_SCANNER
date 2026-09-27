import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFocusGate, type AfState } from '../../lib/camera-focus-gate';
import { cardFocusTracker, type FocusTracker } from '../../lib/camera-focus-diagnostics';
import { createFocusHold } from '../../lib/camera-focus-hold';
import type { OverlayFocusProps } from './camera-focus';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Primo scatto: settle + breve attesa AF lock (timeout corto). */
const FAST_AF_SETTLE_MS = 150;
const FAST_AF_LOCK_WAIT_MS = 500;

/** Retry (immagine soft): più tempo per rimettere a fuoco. */
const RETRY_AF_SETTLE_MS = 220;
const RETRY_AF_LOCK_WAIT_MS = 700;

/**
 * Biglietto: finestra massima di stabilizzazione. Oltre questa soglia si scatta
 * comunque, perché un'attesa percepibile è peggio di un fotogramma da rifare.
 */
const CARD_AF_LOCK_WAIT_MS = 700;
/** Un lock vecchio non deve restare verde mentre telefono o biglietto si muovono. */
const AF_GREEN_FRESHNESS_MS = 1500;

export type CaptureFocusMode = 'fast' | 'retry' | 'card';

/**
 * Android expo-camera: autofocus "off" chiama cancelFocusAndMetering() → NESSUN fuoco.
 * Teniamo sempre "on" e rilanciamo AF prima dello scatto.
 */
export function useFocusPulse(tracker: FocusTracker = cardFocusTracker) {
  const gate = useMemo(() => createFocusGate(), []);
  const [focusPulseKey, setFocusPulseKey] = useState(0);
  const [afState, setAfState] = useState<AfState>('PASSIVE_SCAN');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autofocus] = useState<'off' | 'on'>('on');
  const trackerRef = useRef(tracker);
  trackerRef.current = tracker;
  // Il fuoco viene tenuto fermo per tutta la cattura JPEG: il punto di
  // misurazione nativo riparte a ogni cambio di valore, quindi durante lo
  // scatto le prop devono restare identiche a quelle su cui il fuoco è stato
  // raggiunto.
  const focusHold = useMemo(() => createFocusHold<OverlayFocusProps>(), []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    gate.reset();
  }, [gate]);

  const onAutofocusStateChanged = useCallback(
    (event: { nativeEvent: Record<string, unknown> }) => {
      try {
        gate.onAutofocusStateChanged(event);
        const state = String(event.nativeEvent.state ?? 'PASSIVE_SCAN') as AfState;
        trackerRef.current.markState(state);
        setAfState(state);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = state === 'FOCUSED_LOCKED'
          ? setTimeout(() => {
              setAfState('PASSIVE_SCAN');
              timerRef.current = null;
            }, AF_GREEN_FRESHNESS_MS)
          : null;
      } catch {
        /* evento opzionale — non bloccare la camera */
      }
    },
    [gate]
  );

  const triggerFocusPulse = useCallback(() => {
    // Durante la cattura una nuova ricerca annullerebbe il fuoco appena
    // raggiunto: le richieste in quell'intervallo vengono ignorate.
    if (focusHold.isHeld()) return;
    setFocusPulseKey((k) => k + 1);
  }, [focusHold]);

  const stabilizeFocusProps = useCallback(
    (props: OverlayFocusProps) => focusHold.stabilize(props),
    [focusHold]
  );

  const holdFocusForCapture = useCallback(() => {
    if (!focusHold.hold()) return;
    gate.logFocusTimeline('FOCUS_HELD');
    trackerRef.current.markFocusHeld();
  }, [focusHold, gate]);

  const releaseFocusAfterCapture = useCallback(() => {
    if (!focusHold.release()) return;
    gate.logFocusTimeline('FOCUS_RELEASED');
    trackerRef.current.markFocusReleased();
  }, [focusHold, gate]);

  const pulseAutofocus = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    gate.logFocusTimeline('FOCUS_PULSE_START');
    triggerFocusPulse();
    await sleep(FAST_AF_SETTLE_MS);
    gate.logFocusTimeline('FOCUS_PULSE_DONE', gate.getLastAfState());
  }, [gate, triggerFocusPulse]);

  const prepareForCapture = useCallback(
    async (mode: CaptureFocusMode = 'fast') => {
      gate.resetFocusTimeline();
      // Business card: non riusare un FOCUSED_LOCKED vecchio. Sul device reale
      // il lock poteva essere stato ottenuto molti secondi prima, anche sullo sfondo,
      // e veniva poi congelato durante il JPEG. Ad ogni pressione invalidiamo solo
      // lo stato AF e rilanciamo UNA ricerca sul punto centrale del riquadro.
      // Attesa massima 700 ms; al timeout si scatta comunque e decide il quality gate.
      if (mode === 'card') {
        gate.logFocusTimeline('CAPTURE_PREPARE_START', mode);
        // Spegne immediatamente un verde della scansione precedente. Solo un
        // nuovo FOCUSED_LOCKED del ciclo corrente puo' riaccenderlo.
        setAfState('PASSIVE_SCAN');
        gate.invalidateFocusLock();
        triggerFocusPulse();
        const cardState = await gate.waitForFocusedLocked(CARD_AF_LOCK_WAIT_MS);
        gate.logFocusTimeline('CAPTURE_PREPARE_DONE', cardState);
        return cardState;
      }

      gate.invalidateFocusLock();
      gate.logFocusTimeline('CAPTURE_PREPARE_START', mode);
      triggerFocusPulse();
      gate.logFocusTimeline('FOCUS_CARD_REGION');
      const settleMs = mode === 'fast' ? FAST_AF_SETTLE_MS : RETRY_AF_SETTLE_MS;
      await sleep(settleMs);
      const lockWaitMs = mode === 'fast' ? FAST_AF_LOCK_WAIT_MS : RETRY_AF_LOCK_WAIT_MS;
      const lockState = await gate.waitForFocusedLocked(lockWaitMs);
      const state = lockState === 'TIMEOUT' ? gate.getLastAfState() : lockState;
      gate.logFocusTimeline('CAPTURE_PREPARE_DONE', state);
      return state;
    },
    [gate, triggerFocusPulse]
  );

  const onCameraReadyFocus = useCallback(() => {
    trackerRef.current.markCameraReady();
    triggerFocusPulse();
  }, [triggerFocusPulse]);

  const resetAutofocus = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return {
    autofocus,
    focusPulseKey,
    afState,
    onAutofocusStateChanged,
    onCameraReadyFocus,
    pulseAutofocus,
    prepareForCapture,
    stabilizeFocusProps,
    holdFocusForCapture,
    releaseFocusAfterCapture,
    resetAutofocus,
    getCameraResolutionDiag: gate.getCameraResolutionDiag,
    logFocusTimeline: gate.logFocusTimeline,
  };
}

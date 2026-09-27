/**
 * Profilo di ripresa del biglietto da visita.
 *
 * A distanza ravvicinata l'obiettivo perde definizione ai bordi: si vede anche
 * con la fotocamera di sistema, quindi è un limite ottico e non del ritaglio.
 * Riprendendo a circa 2x il biglietto cade nella porzione centrale della lente,
 * dove la resa è uniforme, e la cornice può tornare ampia perché il campo
 * inquadrato è più stretto.
 *
 * La prop `zoom` di expo-camera NON è un ingrandimento ottico. Su Android il
 * modulo calcola:
 *
 *   zoomRatio = clamp(zoom * maxZoomRatio, 1, maxZoomRatio)
 *
 * quindi per ottenere un ingrandimento M serve `zoom = M / maxZoomRatio`, e
 * senza conoscere maxZoomRatio del dispositivo qualsiasi valore sarebbe un
 * indovinello. L'intervallo arriva dall'evento nativo di apertura camera; se
 * manca, si resta a 1x.
 */

import { RELEASE_QA_DIAGNOSTICS } from './release-diagnostics';

export const CARD_TARGET_MAGNIFICATION = 2;

/**
 * Sotto questo ingrandimento il vantaggio ottico non è quello verificato sul
 * dispositivo, quindi conviene restare al comportamento 1x invece di applicare
 * uno zoom parziale che cambierebbe l'inquadratura senza il beneficio atteso.
 */
export const CARD_MIN_ACCEPTED_MAGNIFICATION = 1.8;

/**
 * Larghezza FINALE della cornice rispetto alla larghezza del viewport.
 *
 * Non è un moltiplicatore da comporre con altri rapporti: è direttamente
 * `larghezza cornice / larghezza viewport`. La versione precedente moltiplicava
 * una scala per il rapporto overlay preesistente e per i margini laterali,
 * finendo al 76% invece del valore inteso.
 */
export const CARD_FRAME_VIEWPORT_WIDTH_RATIO_1X = 0.76;

/** A ~2x il campo inquadrato è più stretto: la cornice occupa quasi tutto. */
export const CARD_FRAME_VIEWPORT_WIDTH_RATIO_2X = 0.95;

/** Margine laterale minimo, perché la cornice non tocchi il bordo. */
export const CARD_FRAME_MIN_SIDE_MARGIN = 8;

export type CardZoomFallbackReason =
  | 'zoom_range_unknown'
  | 'magnification_unsupported'
  | null;

export interface CardZoomPlan {
  requestedMagnification: number;
  /** Ingrandimento che il dispositivo applicherà davvero. */
  effectiveMagnification: number;
  /** Valore 0–1 da passare alla prop `zoom` di CameraView. */
  appliedZoomValue: number;
  deviceMinZoomRatio: number | null;
  deviceMaxZoomRatio: number | null;
  /** Larghezza cornice / larghezza viewport. */
  frameViewportWidthRatio: number;
  fallbackUsed: boolean;
  fallbackReason: CardZoomFallbackReason;
}

export const CARD_ZOOM_FALLBACK_PLAN: CardZoomPlan = {
  requestedMagnification: CARD_TARGET_MAGNIFICATION,
  effectiveMagnification: 1,
  appliedZoomValue: 0,
  deviceMinZoomRatio: null,
  deviceMaxZoomRatio: null,
  frameViewportWidthRatio: CARD_FRAME_VIEWPORT_WIDTH_RATIO_1X,
  fallbackUsed: true,
  fallbackReason: 'zoom_range_unknown',
};

export interface CardZoomRange {
  maxZoomRatio?: number | null;
  minZoomRatio?: number | null;
}

function isUsableRatio(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Traduce l'intervallo di zoom del dispositivo nel piano di ripresa del
 * biglietto. Non conosce la marca del telefono: se l'ottica non arriva
 * all'ingrandimento utile si torna a 1x senza mai bloccare la scansione.
 */
export function resolveCardZoomPlan(range: CardZoomRange): CardZoomPlan {
  const maxZoomRatio = range.maxZoomRatio;
  const minZoomRatio = isUsableRatio(range.minZoomRatio) ? range.minZoomRatio : null;

  // Un massimo pari a 1 significa quasi sempre che la capacità non è ancora
  // arrivata, non che la camera sia priva di zoom: si resta a 1x in attesa.
  if (!isUsableRatio(maxZoomRatio) || maxZoomRatio <= 1) {
    return {
      ...CARD_ZOOM_FALLBACK_PLAN,
      deviceMinZoomRatio: minZoomRatio,
      fallbackReason: 'zoom_range_unknown',
    };
  }

  if (maxZoomRatio < CARD_MIN_ACCEPTED_MAGNIFICATION) {
    return {
      ...CARD_ZOOM_FALLBACK_PLAN,
      deviceMinZoomRatio: minZoomRatio,
      deviceMaxZoomRatio: maxZoomRatio,
      fallbackReason: 'magnification_unsupported',
    };
  }

  const effectiveMagnification = Math.min(CARD_TARGET_MAGNIFICATION, maxZoomRatio);
  const appliedZoomValue = Math.min(1, Math.max(0, effectiveMagnification / maxZoomRatio));

  return {
    requestedMagnification: CARD_TARGET_MAGNIFICATION,
    effectiveMagnification,
    appliedZoomValue,
    deviceMinZoomRatio: minZoomRatio,
    deviceMaxZoomRatio: maxZoomRatio,
    frameViewportWidthRatio: CARD_FRAME_VIEWPORT_WIDTH_RATIO_2X,
    fallbackUsed: false,
    fallbackReason: null,
  };
}

/**
 * Piano attivo della sessione.
 *
 * Cornice visibile e ritaglio devono restare la stessa cosa: tenendo il fattore
 * in un unico punto nessun percorso può disegnare un riquadro e ritagliarne un
 * altro, cosa che accadrebbe passando la scala per parametro a più chiamanti.
 */
let activePlan: CardZoomPlan = CARD_ZOOM_FALLBACK_PLAN;

export function setActiveCardZoomPlan(plan: CardZoomPlan): void {
  activePlan = plan;
}

export function resetActiveCardZoomPlan(): void {
  activePlan = CARD_ZOOM_FALLBACK_PLAN;
}

export function getActiveCardZoomPlan(): CardZoomPlan {
  return activePlan;
}

export function activeCardFrameViewportWidthRatio(): number {
  return activePlan.frameViewportWidthRatio;
}

/**
 * Tracce di collaudo indipendenti da `__DEV__` (bundle QA = `--dev false`).
 * Gate: `RELEASE_QA_DIAGNOSTICS` — must be false for Play Store production.
 * Solo numeri della camera.
 */
export const CARD_ZOOM_QA_DIAGNOSTICS = RELEASE_QA_DIAGNOSTICS;

export function formatCardCaptureProfileLog(plan: CardZoomPlan): string {
  return `[CardCaptureProfile] ${JSON.stringify({
    deviceMinZoomRatio: plan.deviceMinZoomRatio,
    deviceMaxZoomRatio: plan.deviceMaxZoomRatio,
    requestedMagnification: plan.requestedMagnification,
    calculatedExpoZoomProp: Number(plan.appliedZoomValue.toFixed(4)),
    actualPolicyMagnification: plan.effectiveMagnification,
    selectedLens: null,
    frameViewportWidthRatio: plan.frameViewportWidthRatio,
    fallbackUsed: plan.fallbackUsed,
    fallbackReason: plan.fallbackReason,
  })}`;
}

export function logCardCaptureProfile(plan: CardZoomPlan): void {
  if (!CARD_ZOOM_QA_DIAGNOSTICS) return;
  console.warn(formatCardCaptureProfileLog(plan));
}

export function logCardZoomApplied(info: {
  expoZoomProp: number;
  expectedNativeZoomRatio: number;
  reportedNativeZoomRatio?: number | null;
}): void {
  if (!CARD_ZOOM_QA_DIAGNOSTICS) return;
  console.warn(
    `[CardZoomApplied] ${JSON.stringify({
      expoZoomProp: Number(info.expoZoomProp.toFixed(4)),
      expectedNativeZoomRatio: Number(info.expectedNativeZoomRatio.toFixed(3)),
      reportedNativeZoomRatio: info.reportedNativeZoomRatio ?? null,
    })}`
  );
}

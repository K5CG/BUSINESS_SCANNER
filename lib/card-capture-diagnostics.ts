/**
 * Diagnostica di inquadratura del biglietto da visita.
 *
 * Le diagnostiche geometriche ordinarie passano da `runtimeLogger.debug`, che
 * viene rimosso nelle build di release: una build QA non produrrebbe quindi
 * alcuna traccia con cui verificare l'inquadratura su dispositivo reale.
 * Questo canale è indipendente da `__DEV__` e segue `RELEASE_QA_DIAGNOSTICS`
 * (false in produzione / store).
 *
 * Vengono registrate solo misure geometriche: nessun URI, nessun testo OCR,
 * nessun dato del contatto.
 */
import { RELEASE_QA_DIAGNOSTICS, isDevLogEnabled } from './release-diagnostics';

declare const process: {
  env: { EXPO_PUBLIC_CARD_QA_DIAGNOSTICS?: string };
};

// Le build debug usate per la validazione fisica devono produrre gli artefatti
// senza dover cambiare un flag di release. Le build store restano spente.
const CARD_QA_DIAGNOSTICS_FROM_ENV =
  process.env.EXPO_PUBLIC_CARD_QA_DIAGNOSTICS === '1';

export const CARD_GEOMETRY_QA_DIAGNOSTICS =
  RELEASE_QA_DIAGNOSTICS || isDevLogEnabled() || CARD_QA_DIAGNOSTICS_FROM_ENV;

export interface CardCaptureGeometryLog {
  stage: 'preview' | 'raw_capture' | 'crop_plan' | 'ocr_input';
  viewportWidth?: number;
  viewportHeight?: number;
  overlayWidth?: number;
  overlayHeight?: number;
  overlayX?: number;
  overlayY?: number;
  photoWidth?: number;
  photoHeight?: number;
  normalizedWidth?: number;
  normalizedHeight?: number;
  previewStreamSize?: string | null;
  imageCaptureSize?: string | null;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  cropAreaRatio?: number;
  cropDecision?: string;
  cropApplied?: boolean;
  mappingMode?: string;
  previewScale?: number;
  previewCropOffsetX?: number;
  previewCropOffsetY?: number;
  orientationTransformApplied?: boolean;
  cropValidated?: boolean;
  uncertaintyReason?: string | null;
  alignRotation?: number;
  readingRotation?: number;
  cameraZoom?: number;
  cardOrientation?: string;
  exifOrientation?: number | null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function formatCardGeometryLog(info: CardCaptureGeometryLog): string {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (value === undefined) continue;
    payload[key] = typeof value === 'number' ? round(value) : value;
  }
  return `[CardCameraGeometry] ${JSON.stringify(payload)}`;
}

export function logCardGeometry(info: CardCaptureGeometryLog): void {
  if (!CARD_GEOMETRY_QA_DIAGNOSTICS) return;
  console.warn(formatCardGeometryLog(info));
}

export interface CropOverlayGeometry {
  photoWidth: number;
  photoHeight: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

/**
 * SVG che disegna il rettangolo calcolato sopra lo scatto integrale salvato
 * accanto: permette di confrontare a occhio la cornice vista in anteprima con
 * quella davvero usata, senza ricodificare il fotogramma.
 */
export function buildCropOverlaySvg(
  rawFileName: string,
  geometry: CropOverlayGeometry
): string {
  const stroke = Math.max(4, Math.round(geometry.photoWidth / 200));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${geometry.photoWidth}" height="${geometry.photoHeight}" viewBox="0 0 ${geometry.photoWidth} ${geometry.photoHeight}">`,
    `<image xlink:href="${rawFileName}" x="0" y="0" width="${geometry.photoWidth}" height="${geometry.photoHeight}"/>`,
    `<rect x="${geometry.cropX}" y="${geometry.cropY}" width="${geometry.cropWidth}" height="${geometry.cropHeight}" fill="none" stroke="#00e5ff" stroke-width="${stroke}"/>`,
    '</svg>',
  ].join('\n');
}

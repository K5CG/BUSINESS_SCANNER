import type { CameraRatio } from 'expo-camera';
import type { PreviewScaleMode } from './overlay-geometry';

export type { PreviewScaleMode };
export {
  BUSINESS_CARD_CAMERA_ZOOM,
  BUSINESS_CARD_CAMERA_ZOOM_PORTRAIT,
  businessCardCameraZoom,
} from './camera-capture-profile';

/** Nessun ratio forzato nel profilo storico dei biglietti. */
export const CAMERA_PREVIEW_RATIO: CameraRatio | undefined = undefined;

export function previewScaleModeForRatio(
  ratio?: CameraRatio,
): PreviewScaleMode {
  return ratio ? 'contain' : 'cover';
}

export function parseStreamSize(
  raw?: string,
): { width: number; height: number } | null {
  if (!raw || raw === 'unknown') return null;
  const match = raw.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

import type { CameraRatio } from 'expo-camera';
import type { CardOrientation, DocumentType } from '../types';

export type CameraCaptureProfileId = 'business_card' | 'document';
export type CameraCapturePlatform = 'android' | 'ios';
export type CameraAvailabilityStatus = 'available' | 'unavailable';

export interface CameraCaptureProfile {
  id: CameraCaptureProfileId;
  initialZoom: number;
  minZoom: number;
  maxZoom: number;
  overlayWidthRatio: number;
  facing: 'back';
  autofocus: 'on';
  ratio?: CameraRatio;
  pictureSize?: string;
  selectedLens?: string;
  responsiveOrientationWhenOrientationLocked: boolean;
  initialDigitalCrop: boolean;
  allowUpscale: false;
}

/** Business cards must start at the native wide field of view. */
export const BUSINESS_CARD_CAMERA_ZOOM = 0;
export const BUSINESS_CARD_CAMERA_ZOOM_PORTRAIT = 0;
export const DOCUMENT_CAMERA_ZOOM = 0;
export const BUSINESS_CARD_OVERLAY_WIDTH_RATIO = 0.92;
export const DOCUMENT_OVERLAY_WIDTH_RATIO = 0.94;
export const DOCUMENT_MAX_PINCH_ZOOM = 0.35;

export function cameraCaptureProfileId(
  documentType: DocumentType,
): CameraCaptureProfileId {
  return documentType === 'business_card' ? 'business_card' : 'document';
}

export function businessCardCameraZoom(
  orientation: CardOrientation,
): number {
  return orientation === 'portrait'
    ? BUSINESS_CARD_CAMERA_ZOOM_PORTRAIT
    : BUSINESS_CARD_CAMERA_ZOOM;
}

export function cameraCaptureProfile(
  documentType: DocumentType,
  orientation: CardOrientation,
  platform: CameraCapturePlatform,
): CameraCaptureProfile {
  if (documentType === 'business_card') {
    const initialZoom = businessCardCameraZoom(orientation);
    return {
      id: 'business_card',
      initialZoom,
      minZoom: 0,
      maxZoom: 0,
      overlayWidthRatio: BUSINESS_CARD_OVERLAY_WIDTH_RATIO,
      facing: 'back',
      autofocus: 'on',
      responsiveOrientationWhenOrientationLocked: false,
      initialDigitalCrop: false,
      allowUpscale: false,
    };
  }

  return {
    id: 'document',
    initialZoom: DOCUMENT_CAMERA_ZOOM,
    minZoom: 0,
    maxZoom: DOCUMENT_MAX_PINCH_ZOOM,
    overlayWidthRatio: DOCUMENT_OVERLAY_WIDTH_RATIO,
    facing: 'back',
    autofocus: 'on',
    responsiveOrientationWhenOrientationLocked: platform === 'ios',
    initialDigitalCrop: false,
    allowUpscale: false,
  };
}

export function clampCameraZoom(
  zoom: number,
  profile: Pick<CameraCaptureProfile, 'minZoom' | 'maxZoom'>,
): number {
  if (!Number.isFinite(zoom)) return profile.minZoom;
  return Math.min(profile.maxZoom, Math.max(profile.minZoom, zoom));
}

export function zoomFromPinch(
  startingZoom: number,
  pinchScale: number,
  profile: Pick<CameraCaptureProfile, 'minZoom' | 'maxZoom'>,
): number {
  const safeScale = Number.isFinite(pinchScale) && pinchScale > 0 ? pinchScale : 1;
  return clampCameraZoom(startingZoom + (safeScale - 1) * 0.2, profile);
}

export function resetCameraZoom(profile: CameraCaptureProfile): number {
  return profile.initialZoom;
}

export function cameraAvailabilityStatus(
  available: boolean,
): CameraAvailabilityStatus {
  return available ? 'available' : 'unavailable';
}

export function selectPrimaryBackLens(
  _availableLenses: readonly string[],
): string | undefined {
  // Expo espone su iOS nomi localizzati, non identificatori AVCaptureDevice.
  // `undefined` conserva il default nativo documentato: wide posteriore.
  return undefined;
}

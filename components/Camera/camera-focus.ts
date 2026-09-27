import { Platform } from 'react-native';
import type { CameraViewProps } from 'expo-camera';
import type { CardOrientation, DocumentType } from '../../types';
import {
  getOverlayFrameCenterInView,
  getOverlayFrameRectInView,
  type OverlayViewportInsets,
  type PreviewLayout,
} from '../../lib/overlay-geometry';

export type OverlayFocusProps = Partial<CameraViewProps> & {
  meteringPointX?: number;
  meteringPointY?: number;
  meteringSpreadX?: number;
  meteringSpreadY?: number;
  focusPointX?: number;
  focusPointY?: number;
};

/**
 * AF sul biglietto: spread contenuto (solo area card, non lo sfondo).
 * focusPulseKey rilancia il metering nativo cambiando leggermente il punto.
 */
export function overlayCardFocusProps(
  screenWidth: number,
  screenHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  viewportInsets: OverlayViewportInsets = {},
  previewLayout?: PreviewLayout,
  focusPulseKey = 0
): OverlayFocusProps {
  const frame = getOverlayFrameRectInView(
    screenWidth,
    screenHeight,
    documentType,
    cardOrientation,
    viewportInsets,
    previewLayout
  );
  const center = getOverlayFrameCenterInView(
    screenWidth,
    screenHeight,
    documentType,
    cardOrientation,
    viewportInsets,
    previewLayout
  );

  const nudge = focusPulseKey % 2 === 0 ? 0 : 0.004;
  const spreadBump = (focusPulseKey % 2) * 0.006;
  const spreadX = Math.min(0.22, screenWidth > 0 ? (frame.width * 0.32) / screenWidth : 0.14);
  const spreadY = Math.min(0.16, screenHeight > 0 ? (frame.height * 0.32) / screenHeight : 0.1);

  if (Platform.OS === 'ios') {
    return {
      focusPointX: Math.min(1, Math.max(0, center.ny + nudge)),
      focusPointY: Math.min(1, Math.max(0, 1 - center.nx)),
    };
  }

  return {
    meteringPointX: Math.min(1, Math.max(0, center.nx + nudge)),
    meteringPointY: Math.min(1, Math.max(0, center.ny)),
    meteringSpreadX: Math.min(0.25, spreadX + spreadBump),
    meteringSpreadY: Math.min(0.18, spreadY + spreadBump),
  };
}

/** @deprecated Usa overlayCardFocusProps */
export function overlayFocusPointProps(nx: number, ny: number): OverlayFocusProps {
  const x = Math.min(1, Math.max(0, nx));
  const y = Math.min(1, Math.max(0, ny));
  if (Platform.OS === 'ios') {
    return { focusPointX: y, focusPointY: 1 - x };
  }
  return { meteringPointX: x, meteringPointY: y, meteringSpreadX: 0.2, meteringSpreadY: 0.12 };
}

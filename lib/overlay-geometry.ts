import { CardOrientation, DocumentType } from '../types';
import {
  BUSINESS_CARD_OVERLAY_WIDTH_RATIO,
  DOCUMENT_OVERLAY_WIDTH_RATIO,
} from './camera-capture-profile';
import {
  CARD_FRAME_MIN_SIDE_MARGIN,
  activeCardFrameViewportWidthRatio,
} from './business-card-zoom-policy';

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Altezza striscia anteprime in camera (deve coincidere con styles.previewContainer.height). */
export const BUSINESS_CARD_PREVIEW_STRIP_HEIGHT = 80;

/** Margini area utile (sotto header app, sopra bottoni camera). */
export interface OverlayViewportInsets {
  top?: number;
  bottom?: number;
  horizontal?: number;
  left?: number;
  right?: number;
}

/** Rapporto larghezza/altezza del riquadro (A4 verticale ≈ 210/297). */
export const A4_PORTRAIT_ASPECT = 210 / 297;
export const A4_LANDSCAPE_ASPECT = 297 / 210;

/** Larghezza riquadro rispetto allo schermo — unica fonte per overlay e crop. */
export const OVERLAY_WIDTH_RATIO = DOCUMENT_OVERLAY_WIDTH_RATIO;

/** Biglietto da visita ISO 85.6 × 53.98 mm. */
export const CARD_LANDSCAPE_ASPECT = 85.6 / 53.98;
export const CARD_PORTRAIT_ASPECT = 53.98 / 85.6;

export const CARD_OVERLAY_WIDTH_RATIO = BUSINESS_CARD_OVERLAY_WIDTH_RATIO;

const BUSINESS_CARD_BOTTOM_MARGIN = 20;
export const DOCUMENT_LANDSCAPE_PREVIEW_RAIL = 92;
export const DOCUMENT_LANDSCAPE_CONTROLS_RAIL = 140;

/** Inset inferiori stabili: riserva sempre lo slot anteprime su business card. */
export function getBusinessCardViewportInsets(
  documentType: DocumentType,
  reservePreviewStrip = true
): OverlayViewportInsets {
  const bottom =
    documentType === 'business_card' && reservePreviewStrip
      ? BUSINESS_CARD_PREVIEW_STRIP_HEIGHT + BUSINESS_CARD_BOTTOM_MARGIN
      : BUSINESS_CARD_BOTTOM_MARGIN;
  return { top: 20, bottom, horizontal: 16 };
}

/**
 * Area utile dello scanner. In landscape documentale guida, controlli e
 * anteprime vivono nelle rail laterali e non riducono l'altezza del foglio.
 */
export function getScannerViewportInsets(
  documentType: DocumentType,
  orientation: CardOrientation,
  hasPages: boolean,
  _safeArea: { left: number; right: number } = { left: 0, right: 0 }
): OverlayViewportInsets {
  if (documentType !== 'business_card' && orientation === 'landscape') {
    // Le rail (anteprime / controlli) sono già fuori dal cameraStage:
    // non applicare una seconda volta safe-area o margini orizzontali alla preview.
    return {
      top: 8,
      bottom: 8,
      left: 0,
      right: 0,
    };
  }

  if (documentType !== 'business_card' && orientation === 'portrait') {
    return {
      top: 8,
      bottom: hasPages ? BUSINESS_CARD_PREVIEW_STRIP_HEIGHT + 12 : 12,
      horizontal: 8,
    };
  }

  const base = getBusinessCardViewportInsets(documentType, true);
  if (documentType !== 'business_card' && hasPages) {
    return { ...base, bottom: BUSINESS_CARD_PREVIEW_STRIP_HEIGHT };
  }
  return base;
}

const MIN_CROP_EDGE = 80;
const MIN_CROP_AREA_RATIO = 0.04;

export function isA4DocumentType(documentType: DocumentType): boolean {
  return documentType !== 'business_card';
}

export function getOverlayAspectRatio(
  documentType: DocumentType,
  cardOrientation: CardOrientation
): number {
  if (documentType === 'business_card') {
    return cardOrientation === 'landscape' ? CARD_LANDSCAPE_ASPECT : CARD_PORTRAIT_ASPECT;
  }
  return cardOrientation === 'portrait' ? A4_PORTRAIT_ASPECT : A4_LANDSCAPE_ASPECT;
}

function fitFrameInViewport(
  availW: number,
  availH: number,
  aspectRatio: number,
  widthRatio: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation
): { width: number; height: number } {
  const isDocumentPortrait =
    documentType !== 'business_card' && cardOrientation === 'portrait';
  const isDocumentLandscapeFrame =
    documentType !== 'business_card' && cardOrientation === 'landscape';
  const maxH = availH * (isDocumentPortrait || isDocumentLandscapeFrame ? 0.98 : 0.94);
  const maxW = availW * (isDocumentPortrait || isDocumentLandscapeFrame ? 0.98 : 0.96);

  let width = availW * widthRatio;
  let height = width / aspectRatio;

  if (isDocumentPortrait) {
    // A4 verticale: priorità alla larghezza utile (evita cornice troppo stretta).
    if (height > maxH) {
      height = maxH;
      width = height * aspectRatio;
    }
    if (width > maxW) {
      width = maxW;
      height = width / aspectRatio;
    }
    return { width, height };
  }

  if (isDocumentLandscapeFrame) {
    // A4 orizzontale: riempie la preview tra le rail (priorità larghezza).
    width = availW * widthRatio;
    height = width / aspectRatio;
    if (height > maxH) {
      height = maxH;
      width = height * aspectRatio;
    }
    if (width > maxW) {
      width = maxW;
      height = width / aspectRatio;
    }
    return { width, height };
  }

  if (height > maxH) {
    height = maxH;
    width = height * aspectRatio;
  }
  if (width > maxW) {
    width = maxW;
    height = width / aspectRatio;
  }

  return { width, height };
}

/**
 * Riquadro del biglietto: la larghezza è una frazione diretta del viewport, non
 * il prodotto di più rapporti. Se la carta è verticale la larghezza richiesta
 * non ci sta in altezza, quindi vince l'altezza utile e si ottiene il riquadro
 * più grande che entra davvero, sempre con la proporzione della carta.
 */
function fitCardFrame(
  viewportWidth: number,
  availHeight: number,
  aspectRatio: number
): { width: number; height: number } {
  const target = viewportWidth * activeCardFrameViewportWidthRatio();
  const maxWidth = Math.max(80, viewportWidth - CARD_FRAME_MIN_SIDE_MARGIN * 2);
  const maxHeight = availHeight * 0.94;

  let width = Math.min(target, maxWidth);
  let height = width / aspectRatio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspectRatio;
  }
  return { width, height };
}

/** Rettangolo del riquadro in coordinate schermo — usato da overlay e crop. */
export function getOverlayFrameRect(
  screenWidth: number,
  screenHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  viewportInsets: OverlayViewportInsets = {}
): ScreenRect {
  const top = viewportInsets.top ?? 0;
  const bottom = viewportInsets.bottom ?? 0;
  const horizontal = viewportInsets.horizontal ?? 0;
  const left = viewportInsets.left ?? horizontal;
  const right = viewportInsets.right ?? horizontal;

  const availW = Math.max(80, screenWidth - left - right);
  const availH = Math.max(80, screenHeight - top - bottom);
  const aspectRatio = getOverlayAspectRatio(documentType, cardOrientation);

  if (documentType === 'business_card') {
    // I margini laterali non limitano più la carta: a ~2x la cornice deve
    // arrivare quasi al bordo dell'anteprima. Restano il margine minimo e
    // l'altezza utile, che protegge la striscia delle anteprime.
    const { width, height } = fitCardFrame(screenWidth, availH, aspectRatio);
    return {
      x: (screenWidth - width) / 2,
      y: top + (availH - height) / 2,
      width,
      height,
    };
  }

  const { width, height } = fitFrameInViewport(
    availW,
    availH,
    aspectRatio,
    OVERLAY_WIDTH_RATIO,
    documentType,
    cardOrientation
  );

  const x = left + (availW - width) / 2;
  const y = top + (availH - height) / 2;

  return { x, y, width, height };
}

/** Centro del riquadro di inquadratura (pixel schermo + coordinate normalizzate 0–1). */
export function getOverlayFrameCenter(
  screenWidth: number,
  screenHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  viewportInsets: OverlayViewportInsets = {}
): { x: number; y: number; nx: number; ny: number } {
  const frame = getOverlayFrameRect(
    screenWidth,
    screenHeight,
    documentType,
    cardOrientation,
    viewportInsets
  );
  const x = frame.x + frame.width / 2;
  const y = frame.y + frame.height / 2;
  return {
    x,
    y,
    nx: screenWidth > 0 ? x / screenWidth : 0.5,
    ny: screenHeight > 0 ? y / screenHeight : 0.5,
  };
}

/**
 * Riquadro overlay in coordinate view — centrato nell'area preview visibile
 * (esclude bande nere FIT / ratio 4:3).
 */
export function getOverlayFrameRectInView(
  viewWidth: number,
  viewHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  viewportInsets: OverlayViewportInsets = {},
  previewLayout?: PreviewLayout
): ScreenRect {
  if (!previewLayout) {
    return getOverlayFrameRect(viewWidth, viewHeight, documentType, cardOrientation, viewportInsets);
  }

  const scaleMode = previewLayout.scaleMode ?? 'cover';
  const contentRect = getPreviewContentRect(
    viewWidth,
    viewHeight,
    previewLayout.contentWidth,
    previewLayout.contentHeight,
    scaleMode
  );

  const frame = getOverlayFrameRect(
    contentRect.width,
    contentRect.height,
    documentType,
    cardOrientation,
    viewportInsets
  );

  return {
    x: contentRect.x + frame.x,
    y: contentRect.y + frame.y,
    width: frame.width,
    height: frame.height,
  };
}

/** Centro riquadro in coordinate view (per AF). */
export function getOverlayFrameCenterInView(
  viewWidth: number,
  viewHeight: number,
  documentType: DocumentType,
  cardOrientation: CardOrientation,
  viewportInsets: OverlayViewportInsets = {},
  previewLayout?: PreviewLayout
): { x: number; y: number; nx: number; ny: number } {
  const frame = getOverlayFrameRectInView(
    viewWidth,
    viewHeight,
    documentType,
    cardOrientation,
    viewportInsets,
    previewLayout
  );
  const x = frame.x + frame.width / 2;
  const y = frame.y + frame.height / 2;
  return {
    x,
    y,
    nx: viewWidth > 0 ? x / viewWidth : 0.5,
    ny: viewHeight > 0 ? y / viewHeight : 0.5,
  };
}

/** Ritaglio entro i limiti dell'immagine; `null` se troppo piccolo o fuori bounds. */
export function sanitizeCropRect(
  crop: ScreenRect,
  photoWidth: number,
  photoHeight: number
): ScreenRect | null {
  if (photoWidth <= 0 || photoHeight <= 0) return null;

  const originX = Math.max(0, Math.min(Math.round(crop.x), photoWidth - 1));
  const originY = Math.max(0, Math.min(Math.round(crop.y), photoHeight - 1));
  const maxW = photoWidth - originX;
  const maxH = photoHeight - originY;
  const width = Math.min(Math.max(1, Math.round(crop.width)), maxW);
  const height = Math.min(Math.max(1, Math.round(crop.height)), maxH);

  if (width < MIN_CROP_EDGE || height < MIN_CROP_EDGE) return null;
  if (originX + width > photoWidth || originY + height > photoHeight) return null;

  const areaRatio = (width * height) / (photoWidth * photoHeight);
  if (areaRatio < MIN_CROP_AREA_RATIO) return null;

  const aspect = crop.width / crop.height;
  if (aspect < 0.2 || aspect > 5) return null;

  return { x: originX, y: originY, width, height };
}

export type PreviewScaleMode = 'cover' | 'contain';

export interface PreviewLayout {
  contentWidth: number;
  contentHeight: number;
  scaleMode?: PreviewScaleMode;
}

/** Area visibile della preview nella view (esclude bande nere con FIT). */
export function getPreviewContentRect(
  viewWidth: number,
  viewHeight: number,
  contentWidth: number,
  contentHeight: number,
  scaleMode: PreviewScaleMode = 'cover'
): ScreenRect {
  if (viewWidth <= 0 || viewHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return { x: 0, y: 0, width: viewWidth, height: viewHeight };
  }

  const contentAspect = contentWidth / contentHeight;
  const viewAspect = viewWidth / viewHeight;

  if (scaleMode === 'contain') {
    if (contentAspect > viewAspect) {
      const width = viewWidth;
      const height = width / contentAspect;
      return { x: 0, y: (viewHeight - height) / 2, width, height };
    }
    const height = viewHeight;
    const width = height * contentAspect;
    return { x: (viewWidth - width) / 2, y: 0, width, height };
  }

  return { x: 0, y: 0, width: viewWidth, height: viewHeight };
}

export interface MapScreenToPhotoOptions {
  /** cover = FILL_CENTER (default), contain = FIT_CENTER (con ratio 4:3) */
  scaleMode?: PreviewScaleMode;
  /** Preview stream CameraX (es. da CAMERA_OPEN) — può differire dal JPEG capture */
  previewStreamWidth?: number;
  previewStreamHeight?: number;
}

/** Schermo → buffer preview (view CameraView). */
export function mapScreenRectToBuffer(
  frame: ScreenRect,
  bufferWidth: number,
  bufferHeight: number,
  screenWidth: number,
  screenHeight: number,
  scaleMode: PreviewScaleMode = 'cover'
): ScreenRect | null {
  if (bufferWidth <= 0 || bufferHeight <= 0 || screenWidth <= 0 || screenHeight <= 0) {
    return null;
  }

  const bufferAspect = bufferWidth / bufferHeight;
  const screenAspect = screenWidth / screenHeight;

  let scale: number;
  let offsetX: number;
  let offsetY: number;

  if (scaleMode === 'contain') {
    if (bufferAspect > screenAspect) {
      scale = screenWidth / bufferWidth;
      offsetX = 0;
      offsetY = (screenHeight - bufferHeight * scale) / 2;
    } else {
      scale = screenHeight / bufferHeight;
      offsetX = (screenWidth - bufferWidth * scale) / 2;
      offsetY = 0;
    }
  } else if (bufferAspect > screenAspect) {
    scale = screenHeight / bufferHeight;
    offsetX = (bufferWidth * scale - screenWidth) / 2;
    offsetY = 0;
  } else {
    scale = screenWidth / bufferWidth;
    offsetX = 0;
    offsetY = (bufferHeight * scale - screenHeight) / 2;
  }

  const x = (frame.x + offsetX) / scale;
  const y = (frame.y + offsetY) / scale;
  const width = frame.width / scale;
  const height = frame.height / scale;

  return sanitizeCropRect(
    {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    },
    bufferWidth,
    bufferHeight
  );
}

/**
 * Buffer preview → pixel JPEG capture quando stream e capture hanno FOV diverso.
 * Entrambi center-crop sul sensore (modello CameraX).
 */
export function mapBufferRectToCapture(
  frame: ScreenRect,
  previewWidth: number,
  previewHeight: number,
  captureWidth: number,
  captureHeight: number
): ScreenRect | null {
  if (
    previewWidth <= 0 ||
    previewHeight <= 0 ||
    captureWidth <= 0 ||
    captureHeight <= 0
  ) {
    return null;
  }

  const previewAspect = previewWidth / previewHeight;
  const captureAspect = captureWidth / captureHeight;

  if (Math.abs(previewAspect - captureAspect) < 0.015) {
    const scaleX = captureWidth / previewWidth;
    const scaleY = captureHeight / previewHeight;
    return sanitizeCropRect(
      {
        x: Math.round(frame.x * scaleX),
        y: Math.round(frame.y * scaleY),
        width: Math.round(frame.width * scaleX),
        height: Math.round(frame.height * scaleY),
      },
      captureWidth,
      captureHeight
    );
  }

  if (previewAspect > captureAspect) {
    const mappedHeight = captureWidth / previewAspect;
    const offsetY = (captureHeight - mappedHeight) / 2;
    const scale = captureWidth / previewWidth;
    return sanitizeCropRect(
      {
        x: Math.round(frame.x * scale),
        y: Math.round(frame.y * scale + offsetY),
        width: Math.round(frame.width * scale),
        height: Math.round(frame.height * scale),
      },
      captureWidth,
      captureHeight
    );
  }

  const mappedWidth = captureHeight * previewAspect;
  const offsetX = (captureWidth - mappedWidth) / 2;
  const scale = captureHeight / previewHeight;
  return sanitizeCropRect(
    {
      x: Math.round(frame.x * scale + offsetX),
      y: Math.round(frame.y * scale),
      width: Math.round(frame.width * scale),
      height: Math.round(frame.height * scale),
    },
    captureWidth,
    captureHeight
  );
}

/**
 * Mappa rettangolo schermo → pixel foto capture.
 * Con preview stream noto: view → stream → capture (corregge FOV diverso).
 */
export function mapScreenRectToPhoto(
  frame: ScreenRect,
  photoWidth: number,
  photoHeight: number,
  screenWidth: number,
  screenHeight: number,
  options: MapScreenToPhotoOptions = {}
): ScreenRect | null {
  const scaleMode = options.scaleMode ?? 'cover';
  const streamW = options.previewStreamWidth;
  const streamH = options.previewStreamHeight;

  const bufferW = streamW && streamH ? streamW : photoWidth;
  const bufferH = streamW && streamH ? streamH : photoHeight;

  const bufferRect = mapScreenRectToBuffer(
    frame,
    bufferW,
    bufferH,
    screenWidth,
    screenHeight,
    scaleMode
  );
  if (!bufferRect) return null;

  if (streamW && streamH && (streamW !== photoWidth || streamH !== photoHeight)) {
    return mapBufferRectToCapture(bufferRect, streamW, streamH, photoWidth, photoHeight);
  }

  return bufferRect;
}

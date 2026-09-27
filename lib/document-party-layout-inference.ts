import type { OcrLine } from '../types';
import { buildDocumentLayoutLines, type DocumentLayoutPageInput } from './document-layout';
import { inferCustomerNameFromLayoutPages } from './document-parties-metadata';
import type { StructuredDocumentPage, StructuredDocumentType } from './document-structure';

export interface LayoutInferenceCapture {
  width?: number;
  height?: number;
  ocrWidth?: number;
  ocrHeight?: number;
}

function layoutPageFromOcr(
  ocrLines: readonly OcrLine[],
  rawText: string,
  pageIndex: number,
  capture?: LayoutInferenceCapture,
): StructuredDocumentPage {
  const input: DocumentLayoutPageInput = {
    pageIndex,
    lines: ocrLines,
    rawText,
    width: capture?.ocrWidth ?? capture?.width,
    height: capture?.ocrHeight ?? capture?.height,
    ocrCanvasWidth: capture?.ocrWidth,
    ocrCanvasHeight: capture?.ocrHeight,
  };
  const layoutLines = buildDocumentLayoutLines(input);
  const boxes = layoutLines.flatMap((line) => (line.boundingBox ? [line.boundingBox] : []));
  const inferredWidth = input.width ?? (boxes.length > 0
    ? Math.max(...boxes.map((box) => box.x + box.width))
    : undefined);
  const inferredHeight = input.height ?? (boxes.length > 0
    ? Math.max(...boxes.map((box) => box.y + box.height))
    : undefined);
  return {
    pageIndex,
    ...(inferredWidth !== undefined ? { width: inferredWidth } : {}),
    ...(inferredHeight !== undefined ? { height: inferredHeight } : {}),
    lines: layoutLines,
    zones: [],
    status: 'partial',
    complete: false,
    requiresRescan: false,
    reasons: ['party_layout_inference'],
  };
}

/** Nome cliente/destinatario da etichette + geometria OCR (non ordine di lettura). */
export function inferCustomerNameFromOcrLayout(
  ocrLines: readonly OcrLine[],
  rawText: string,
  documentType: StructuredDocumentType,
  capture?: LayoutInferenceCapture,
  pageIndex = 0,
): string | undefined {
  if (!ocrLines.some((line) => line.boundingBox)) return undefined;
  const page = layoutPageFromOcr(ocrLines, rawText, pageIndex, capture);
  return inferCustomerNameFromLayoutPages([page], documentType);
}

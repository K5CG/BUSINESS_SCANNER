import type { AnyDocument, OcrLine } from '../types';
import type { DocumentLayoutPageInput } from './document-layout';
import { isDeferredStructuredExtraction } from './document-structured-extraction';
import { traceScan } from './scan-trace';

/**
 * Post-scan sulla scheda documento: non tocca Elabora.
 * Disattivato: il layout async congeola ancora la UI (Salva/Invia non rispondono).
 */
export const BACKGROUND_STRUCTURED_ENRICHMENT_ENABLED = false;

export function documentNeedsStructuredEnrichment(document: AnyDocument): boolean {
  if (!BACKGROUND_STRUCTURED_ENRICHMENT_ENABLED) return false;
  if (document.type === 'business_card') return false;
  if (!document.structuredExtraction) return true;
  return isDeferredStructuredExtraction(document.structuredExtraction);
}

function ocrLinesFromTexts(lines: readonly { text: string; boundingBox?: OcrLine['boundingBox']; elements?: OcrLine['elements'] }[]): OcrLine[] {
  return lines.map((line) => ({
    text: line.text,
    confidence: 0.9,
    ...(line.boundingBox ? { boundingBox: line.boundingBox } : {}),
    ...(line.elements ? { elements: line.elements } : {}),
  }));
}

export function layoutInputsFromDocument(document: AnyDocument): DocumentLayoutPageInput[] {
  const structuredPages = document.structuredExtraction?.pages ?? [];
  if (structuredPages.length > 0 && structuredPages.some((page) => page.lines.length > 0)) {
    return structuredPages.map((page, pageIndex) => {
      const capture = document.pageCaptureMetadata?.[pageIndex];
      return {
        pageIndex,
        lines: ocrLinesFromTexts(page.lines),
        rawText: page.lines.map((line) => line.text).join('\n'),
        width: page.width ?? capture?.ocrWidth ?? capture?.width,
        height: page.height ?? capture?.ocrHeight ?? capture?.height,
        ...(capture?.ocrWidth ? { ocrCanvasWidth: capture.ocrWidth } : {}),
        ...(capture?.ocrHeight ? { ocrCanvasHeight: capture.ocrHeight } : {}),
      };
    });
  }

  const extractions = document.pageExtractions ?? [];
  if (extractions.length === 0) return [];

  return extractions.map((page, pageIndex) => {
    const capture = document.pageCaptureMetadata?.[pageIndex];
    const lines: OcrLine[] = (page.rawText ?? '')
      .split(/\r?\n/)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((text) => ({ text, confidence: 0.9 }));
    return {
      pageIndex,
      lines,
      rawText: page.rawText ?? lines.map((line) => line.text).join('\n'),
      width: capture?.ocrWidth ?? capture?.width,
      height: capture?.ocrHeight ?? capture?.height,
      ...(capture?.ocrWidth ? { ocrCanvasWidth: capture.ocrWidth } : {}),
      ...(capture?.ocrHeight ? { ocrCanvasHeight: capture.ocrHeight } : {}),
    };
  });
}

/** Disattivato: il layout post-scan congela Salva/Invia su device reali. */
export async function enrichDocumentStructuredExtraction(
  _document: AnyDocument,
  _options?: { isActive?: () => boolean },
): Promise<AnyDocument | null> {
  traceScan('enrich:hard_disabled');
  return null;
}

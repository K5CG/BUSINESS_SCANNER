import type { OcrLine, OcrQualityMetadata } from '../types';
import { assessOcrQuality, emptyOcrQuality } from './ocr-quality';
import { traceScan } from './scan-trace';
import { runTimedOperation } from './guarded-operation';

export interface LocalOcrScanResult {
  lines: OcrLine[];
  text: string;
  quality?: OcrQualityMetadata;
  rotationDegrees?: 0 | 90 | 180 | 270;
  ocrCanvasWidth?: number;
  ocrCanvasHeight?: number;
}

export interface LocalOcrPage {
  lines: OcrLine[];
  rawText: string;
  ocrQuality: OcrQualityMetadata;
  error?: string;
  completed: boolean;
  rotationDegrees?: 0 | 90 | 180 | 270;
  ocrCanvasWidth?: number;
  ocrCanvasHeight?: number;
}

export interface LocalOcrPagesResult {
  pages: LocalOcrPage[];
  ocrWorked: boolean;
}

/**
 * Esegue esclusivamente lo scanner locale passato dal chiamante.
 * Le dipendenze sono iniettate per tenere questo flusso testabile senza UI,
 * moduli nativi o rete.
 */
export async function scanPagesLocally(
  imageUris: readonly string[],
  scanPage: (imageUri: string) => Promise<LocalOcrScanResult>,
  options?: {
    isActive?: () => boolean;
    onPageComplete?: (pageIndex: number, pageCount: number) => void;
    /**
     * Absolute wall-clock deadline for local OCR.  Native ML Kit cannot be
     * cancelled, but its late value is deliberately discarded so it cannot
     * keep a capture operation logically alive after the UI deadline.
     */
    deadline?: number;
    operationIdPrefix?: string;
  }
): Promise<LocalOcrPagesResult> {
  const pages: LocalOcrPage[] = [];
  let ocrWorked = false;
  const isActive = options?.isActive ?? (() => true);

  for (const [pageIndex, imageUri] of imageUris.entries()) {
    if (!isActive()) break;
    const pageStarted = Date.now();
    try {
      const remainingMs = options?.deadline === undefined
        ? undefined
        : Math.max(0, options.deadline - Date.now());
      if (remainingMs !== undefined && remainingMs < 1) {
        pages.push({
          lines: [], rawText: '', ocrQuality: emptyOcrQuality(), completed: false,
          error: 'OCR locale oltre il limite di tempo: acquisizione da verificare',
        });
        traceScan('workflow:ocr_page_deadline', { pageIndex, remainingMs });
        break;
      }
      const outcome = remainingMs === undefined
        ? { status: 'completed' as const, value: await scanPage(imageUri) }
        : await runTimedOperation<LocalOcrScanResult>({
          operationId: `${options?.operationIdPrefix ?? 'local-ocr'}-${pageIndex}`,
          timeoutMs: remainingMs,
          fallback: { lines: [], text: '', quality: emptyOcrQuality() },
          isExternallyActive: isActive,
          task: () => scanPage(imageUri),
        });
      if (outcome.status === 'timed_out') {
        pages.push({
          lines: [], rawText: '', ocrQuality: emptyOcrQuality(), completed: false,
          error: 'OCR locale oltre il limite di tempo: acquisizione da verificare',
        });
        traceScan('workflow:ocr_page_timeout', { pageIndex, ms: Date.now() - pageStarted });
        break;
      }
      if (outcome.status === 'failed') throw outcome.error;
      if (outcome.status === 'stale') break;
      const scanResult = outcome.value;
      if (!isActive()) break;
      const rawText =
        scanResult.text.trim() ||
        scanResult.lines.map((line) => line.text).join('\n');

      if (scanResult.lines.length > 0 || rawText.trim().length > 0) {
        ocrWorked = true;
      }

      pages.push({
        lines: scanResult.lines,
        rawText,
        ocrQuality:
          scanResult.quality ??
          assessOcrQuality(scanResult.lines, rawText, {
            confidenceType: 'heuristic',
            source: 'derived',
          }),
        completed: true,
        ...(scanResult.rotationDegrees !== undefined ? { rotationDegrees: scanResult.rotationDegrees } : {}),
        ...(scanResult.ocrCanvasWidth !== undefined ? { ocrCanvasWidth: scanResult.ocrCanvasWidth } : {}),
        ...(scanResult.ocrCanvasHeight !== undefined ? { ocrCanvasHeight: scanResult.ocrCanvasHeight } : {}),
      });
      traceScan('workflow:ocr_page_done', {
        pageIndex,
        ms: Date.now() - pageStarted,
        lines: scanResult.lines.length,
      });
      options?.onPageComplete?.(pageIndex, imageUris.length);
    } catch (error) {
      if (!isActive()) break;
      pages.push({
        lines: [],
        rawText: '',
        ocrQuality: emptyOcrQuality(),
        error: error instanceof Error ? error.message : String(error),
        completed: false,
      });
    }
  }

  return { pages, ocrWorked };
}

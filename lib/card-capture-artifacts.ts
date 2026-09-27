/**
 * Artefatti QA della pipeline immagine business-card.
 *
 * Nelle build debug salva, nello stesso gruppo temporale:
 * 01 raw camera
 * 02 crop della cornice
 * 03 output boundary (crop fisico oppure foreground mask)
 * 04 immagine base consegnata alla pipeline OCR dopo auto-orientamento
 * 05 metadata geometrici/boundary
 *
 * I file restano solo sul dispositivo e la diagnostica e disattivata nelle
 * build store. Il RAW OCR viene salvato separatamente dal modulo OCR, cosi la
 * prova resta agganciata all'immagine realmente riconosciuta.
 */
import * as FileSystem from 'expo-file-system/legacy';
import {
  CARD_GEOMETRY_QA_DIAGNOSTICS,
  buildCropOverlaySvg,
} from './card-capture-diagnostics';
import { runtimeLogger } from './safe-runtime-logger';

export const CARD_ARTIFACTS_DIR_NAME = 'qa-card-geometry';

export interface CardCaptureArtifactInput {
  rawUri: string;
  overlayCropUri?: string;
  boundaryUri?: string;
  ocrInputUri?: string;
  boundaryMode?: 'none' | 'rectangle_crop' | 'foreground_bbox' | 'verified_overlay_fallback';
  boundaryConfidence?: number | null;
  boundaryAreaRatio?: number | null;
  boundaryRecoveryUsed?: boolean;
  rejectionReason?: 'crop_unreliable' | 'boundary_unreliable' | 'prepared_image_too_soft' | null;
  preparedSharpnessScore?: number | null;
  preparedSharpnessMedian?: number | null;
  preparedSharpnessMax?: number | null;
  photoWidth: number;
  photoHeight: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
}

export interface CardCaptureArtifactPaths {
  rawPath: string;
  overlayPath: string;
  overlayCropPath?: string;
  boundaryPath?: string;
  ocrInputPath?: string;
  metadataPath: string;
}

function artifactsDirectory(): string | null {
  const base = FileSystem.documentDirectory;
  if (!base) return null;
  return `${base}${CARD_ARTIFACTS_DIR_NAME}/`;
}

async function copyOptional(from: string | undefined, to: string): Promise<string | undefined> {
  if (!from) return undefined;
  await FileSystem.copyAsync({ from, to });
  return to;
}

/**
 * Salva gli stadi visuali della pipeline. Non solleva mai: una diagnostica non
 * deve poter bloccare lo scatto reale.
 */
export async function saveCardCaptureArtifacts(
  input: CardCaptureArtifactInput
): Promise<CardCaptureArtifactPaths | null> {
  if (!CARD_GEOMETRY_QA_DIAGNOSTICS) return null;
  const dir = artifactsDirectory();
  if (!dir) return null;

  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const stamp = Date.now();
    const prefix = `card-${stamp}`;

    const rawFileName = `${prefix}-01-raw.jpg`;
    const rawPath = `${dir}${rawFileName}`;
    await FileSystem.copyAsync({ from: input.rawUri, to: rawPath });

    const overlayPath = `${dir}${prefix}-01-crop-rect.svg`;
    await FileSystem.writeAsStringAsync(
      overlayPath,
      buildCropOverlaySvg(rawFileName, input)
    );

    const overlayCropPath = await copyOptional(
      input.overlayCropUri,
      `${dir}${prefix}-02-overlay-crop.jpg`
    );
    const boundaryPath = await copyOptional(
      input.boundaryUri,
      `${dir}${prefix}-03-boundary-output.jpg`
    );
    const ocrInputPath = await copyOptional(
      input.ocrInputUri,
      `${dir}${prefix}-04-ocr-base-input.jpg`
    );

    const metadataPath = `${dir}${prefix}-05-pipeline.json`;
    await FileSystem.writeAsStringAsync(
      metadataPath,
      JSON.stringify(
        {
          boundaryMode: input.boundaryMode ?? 'none',
          boundaryConfidence: input.boundaryConfidence ?? null,
          boundaryAreaRatio: input.boundaryAreaRatio ?? null,
          boundaryRecoveryUsed: input.boundaryRecoveryUsed ?? false,
          rejectionReason: input.rejectionReason ?? null,
          preparedSharpnessScore: input.preparedSharpnessScore ?? null,
          preparedSharpnessMedian: input.preparedSharpnessMedian ?? null,
          preparedSharpnessMax: input.preparedSharpnessMax ?? null,
          crop: {
            x: input.cropX,
            y: input.cropY,
            width: input.cropWidth,
            height: input.cropHeight,
          },
          photo: { width: input.photoWidth, height: input.photoHeight },
        },
        null,
        2
      )
    );

    console.warn(
      `[CardCameraGeometry] ${JSON.stringify({
        stage: 'pipeline_artifacts',
        raw: rawFileName,
        overlayCrop: overlayCropPath?.split('/').pop() ?? null,
        boundary: boundaryPath?.split('/').pop() ?? null,
        ocrBaseInput: ocrInputPath?.split('/').pop() ?? null,
        metadata: metadataPath.split('/').pop(),
        boundaryMode: input.boundaryMode ?? 'none',
        directory: CARD_ARTIFACTS_DIR_NAME,
      })}`
    );

    return {
      rawPath,
      overlayPath,
      overlayCropPath,
      boundaryPath,
      ocrInputPath,
      metadataPath,
    };
  } catch (error) {
    runtimeLogger.debug('CAMERA_DIAGNOSTIC', {
      source: 'camera',
      status: 'failed',
    });
    return null;
  }
}

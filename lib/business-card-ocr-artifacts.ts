/**
 * Diagnostica P0 business-card OCR, solo build QA/debug.
 *
 * Salva localmente sul dispositivo le immagini effettivamente consegnate a
 * ML Kit per ogni angolo Latin e il RAW OCR restituito. Serve a distinguere in
 * modo oggettivo un errore di crop/mask da un errore del recognizer.
 *
 * CONTIENE PII del biglietto: non deve essere attivo nelle build store.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { CARD_GEOMETRY_QA_DIAGNOSTICS } from './card-capture-diagnostics';
import { runtimeLogger } from './safe-runtime-logger';

export const CARD_OCR_ARTIFACTS_DIR_NAME = 'qa-card-ocr';

export interface BusinessCardOcrQaSession {
  directory: string;
  prefix: string;
}

function artifactsDirectory(): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${CARD_OCR_ARTIFACTS_DIR_NAME}/` : null;
}

export async function beginBusinessCardOcrQaSession(): Promise<BusinessCardOcrQaSession | null> {
  if (!CARD_GEOMETRY_QA_DIAGNOSTICS) return null;
  const directory = artifactsDirectory();
  if (!directory) return null;
  try {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    return {
      directory,
      prefix: `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    };
  } catch {
    return null;
  }
}

export async function saveBusinessCardOcrAttempt(
  session: BusinessCardOcrQaSession | null,
  angle: 0 | 90 | 180 | 270,
  imageUri: string,
  rawText: string,
): Promise<void> {
  if (!session) return;
  try {
    const angleLabel = String(angle).padStart(3, '0');
    const imageName = `${session.prefix}-10-latin-${angleLabel}-input.jpg`;
    const textName = `${session.prefix}-10-latin-${angleLabel}-raw.txt`;
    await FileSystem.copyAsync({
      from: imageUri,
      to: `${session.directory}${imageName}`,
    });
    await FileSystem.writeAsStringAsync(
      `${session.directory}${textName}`,
      rawText,
    );
  } catch (error) {
    runtimeLogger.debug('OCR_QA_ARTIFACT_FAILED', {
      source: 'filesystem',
      status: 'failed',
    });
  }
}

export type BusinessCardCjkQaScript = 'chinese' | 'japanese' | 'korean';

export async function saveBusinessCardCjkOcrAttempt(
  session: BusinessCardOcrQaSession | null,
  script: BusinessCardCjkQaScript,
  angle: 0 | 90 | 180 | 270,
  rawText: string,
): Promise<void> {
  if (!session) return;
  try {
    const angleLabel = String(angle).padStart(3, '0');
    const textName = `${session.prefix}-20-cjk-${script}-${angleLabel}-raw.txt`;
    await FileSystem.writeAsStringAsync(
      `${session.directory}${textName}`,
      rawText,
    );
  } catch (error) {
    runtimeLogger.debug('OCR_QA_ARTIFACT_FAILED', {
      source: 'filesystem',
      status: 'failed',
    });
  }
}

export async function saveBusinessCardCjkOcrFailure(
  session: BusinessCardOcrQaSession | null,
  script: BusinessCardCjkQaScript,
  angle: 0 | 90 | 180 | 270,
): Promise<void> {
  if (!session) return;
  try {
    const angleLabel = String(angle).padStart(3, '0');
    const textName = `${session.prefix}-20-cjk-${script}-${angleLabel}-failed.txt`;
    await FileSystem.writeAsStringAsync(
      `${session.directory}${textName}`,
      'recognizer_failed',
    );
  } catch {
    runtimeLogger.debug('OCR_QA_ARTIFACT_FAILED', {
      source: 'filesystem',
      status: 'failed',
    });
  }
}

export async function saveBusinessCardOcrSummary(
  session: BusinessCardOcrQaSession | null,
  selectedAngle: 0 | 90 | 180 | 270,
  finalRawText: string,
): Promise<void> {
  if (!session) return;
  try {
    const summaryName = `${session.prefix}-99-selected.json`;
    const rawName = `${session.prefix}-99-final-raw-ocr.txt`;
    await FileSystem.writeAsStringAsync(
      `${session.directory}${summaryName}`,
      JSON.stringify({ selectedAngle }, null, 2),
    );
    await FileSystem.writeAsStringAsync(
      `${session.directory}${rawName}`,
      finalRawText,
    );
    console.warn(
      `[BusinessCardOCRQA] ${JSON.stringify({
        selectedAngle,
        directory: CARD_OCR_ARTIFACTS_DIR_NAME,
        summary: summaryName,
        rawOcr: rawName,
      })}`
    );
  } catch (error) {
    runtimeLogger.debug('OCR_QA_ARTIFACT_FAILED', {
      source: 'filesystem',
      status: 'failed',
    });
  }
}

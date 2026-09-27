import * as ImageManipulator from 'expo-image-manipulator';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import type { CardOrientation, OcrLine } from '../types';
import { getImageSize, rotateImage } from './image-utils';
import { planLongSideResize, prepareImageOnce } from './image-preparation';
import { resolveImageUri } from './image-uri';
import {
  createGuardedOperationId,
  createTemporaryAssetScope,
  runLimitedAttempts,
  runTimedOperation,
  selectBestScoredAttempt,
} from './guarded-operation';
import { runOcrNativeTask } from './ocr-native-concurrency';
import { cleanupTemporaryImageUri } from './temporary-image-cleanup';
import { createProviderOcrLine } from './ocr-quality';
import { runtimeLogger } from './safe-runtime-logger';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/;
// L'orientamento precede il salvataggio: prima si confrontano 0/180 (stesso
// asse), poi i quarti di giro solo se necessari.
const ORIENT_OCR_TIMEOUT_MS = 3500;
export const ORIENTATION_ATTEMPT_CONCURRENCY = 2;

export interface OrientationOperationGuard {
  operationId: string;
  isActive(): boolean;
  /** Override solo per test deterministici; produzione usa 1200 ms. */
  timeoutMs?: number;
  /** Override solo per test; produzione limita a due tentativi. */
  maxConcurrency?: number;
}

function linesFromMlResult(
  result: Awaited<ReturnType<typeof TextRecognition.recognize>>
): OcrLine[] {
  return result.blocks.flatMap((block) =>
    block.lines.map((line) =>
      createProviderOcrLine({
        text: line.text,
        confidence: (line as unknown as { confidence?: unknown }).confidence,
        boundingBox: line.frame
          ? {
              x: line.frame.left,
              y: line.frame.top,
              width: line.frame.width,
              height: line.frame.height,
            }
          : undefined,
      })
    )
  );
}

function scoreBusinessCardOrientation(
  lines: OcrLine[],
  text: string,
  cardOrientation: CardOrientation,
  imageWidth: number,
  imageHeight: number
): number {
  let score = 0;
  const blob = text || lines.map((l) => l.text).join('\n');

  for (const line of lines) {
    const bb = line.boundingBox;
    const t = line.text.trim();
    if (!bb || t.length < 2 || bb.width < 6 || bb.height < 4) continue;
    const ratio = bb.width / Math.max(bb.height, 1);
    if (ratio >= 1.15) score += ratio * Math.min(t.length, 24);
    else score -= (bb.height / Math.max(bb.width, 1)) * Math.min(t.length, 24);
  }

  if (EMAIL_RE.test(blob)) score += 45;
  if (PHONE_RE.test(blob)) score += 35;
  if (/\b(?:via|viale|piazza|corso)\b/i.test(blob)) score += 20;
  score += Math.min(lines.filter((l) => l.text.trim().length >= 2).length, 12) * 4;

  const wantLandscape = cardOrientation === 'landscape';
  const isLandscape = imageWidth > imageHeight;
  if (wantLandscape === isLandscape) score += 60;

  return score;
}

async function thumbForOrientation(
  uri: string
): Promise<{ uri: string; temporary: boolean }> {
  let size: { width: number; height: number };
  try {
    size = await getImageSize(uri);
  } catch {
    // Il riconoscitore prova comunque le forme URI supportate; non
    // ricodificare alla cieca e soprattutto non rischiare un upscale.
    return { uri, temporary: false };
  }
  const resizePlan = planLongSideResize(size.width, size.height, 480);
  if (!resizePlan.action) return { uri, temporary: false };
  const prepared = await prepareImageOnce(
    uri,
    [resizePlan.action],
    size.width,
    size.height,
    (source, actions) =>
      ImageManipulator.manipulateAsync(source, actions, {
        compress: 0.85,
        format: ImageManipulator.SaveFormat.JPEG,
      })
  );
  return { uri: prepared.preparedUri, temporary: true };
}

async function recognizeThumb(uri: string): Promise<{
  lines: OcrLine[];
  text: string;
  width: number;
  height: number;
} | null> {
  const candidates = [uri, resolveImageUri(uri), uri.startsWith('file://') ? uri.slice(7) : `file://${uri}`];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    try {
      const result = await TextRecognition.recognize(candidate);
      const lines = linesFromMlResult(result);
      const text = lines.map((l) => l.text.trim()).filter(Boolean).join('\n');
      const { width, height } = await getImageSize(uri);
      return { lines, text, width, height };
    } catch {
      /* try next uri form */
    }
  }
  return null;
}

/** Sceglie 0° / 90° / 270° in base al testo ML Kit — stesso criterio della preview. */
export async function autoOrientBusinessCardImage(
  uri: string,
  cardOrientation: CardOrientation,
  guard?: OrientationOperationGuard
): Promise<string> {
  const operationId =
    guard?.operationId ?? createGuardedOperationId('orientation');
  const scope = createTemporaryAssetScope({
    cleanup: cleanupTemporaryImageUri,
    onCleanupError: () => {
      runtimeLogger.warn('ORIENTATION_CLEANUP_FAILED', undefined, {
        status: 'failed',
        stage: 'cleanup',
        source: 'filesystem',
      });
    },
  });
  const angles = [0, 180, 90, 270] as const;

  const outcome = await runTimedOperation({
    operationId,
    timeoutMs: guard?.timeoutMs ?? ORIENT_OCR_TIMEOUT_MS,
    fallback: uri,
    isExternallyActive: () => guard?.isActive() ?? true,
    task: async (context) => {
      try {
        if (!context.isActive()) return uri;

        const thumbnail = await thumbForOrientation(uri);
        if (thumbnail.temporary) scope.track(thumbnail.uri);
        if (!context.isActive()) return uri;

        const attempts = await runLimitedAttempts({
          items: angles,
          maxConcurrency:
            guard?.maxConcurrency ?? ORIENTATION_ATTEMPT_CONCURRENCY,
          context,
          attempt: async (angle, _index, attemptContext) => {
            const gated = await runOcrNativeTask(
              async () => {
                if (!attemptContext.isActive()) return null;
                const testUri =
                  angle === 0
                    ? thumbnail.uri
                    : await rotateImage(thumbnail.uri, angle);
                if (angle !== 0) scope.track(testUri);
                if (!attemptContext.isActive()) return null;

                const ocr = await recognizeThumb(testUri);
                if (!ocr || !attemptContext.isActive()) return null;
                return {
                  angle,
                  score: scoreBusinessCardOrientation(
                    ocr.lines,
                    ocr.text,
                    cardOrientation,
                    ocr.width,
                    ocr.height
                  ),
                };
              },
              attemptContext.isActive
            );
            if (gated.status === 'failed') throw gated.error;
            return gated.status === 'completed' ? gated.value : null;
          },
        });

        if (!context.isActive()) return uri;
        const scored = attempts.flatMap((attempt) =>
          attempt.status === 'fulfilled' && attempt.value
            ? [
                {
                  index: attempt.index,
                  score: attempt.value.score,
                  value: attempt.value.angle,
                },
              ]
            : []
        );
        const best = selectBestScoredAttempt(scored);
        if (!best || best.value === 0 || best.score < 8) {
          console.warn('[BusinessCardOrientation] reading_order_kept', {
            selectedRotation: best?.value ?? null,
            selectedScore: best?.score ?? null,
          });
          return uri;
        }
        if (!context.isActive()) return uri;

        const orientedUri = await rotateImage(uri, best.value);
        console.warn('[BusinessCardOrientation] reading_order_rotated', {
          selectedRotation: best.value,
          selectedScore: best.score,
        });
        scope.track(orientedUri);
        if (!context.isActive()) return uri;
        scope.retain(orientedUri);
        return orientedUri;
      } finally {
        // Non anticipare il delete: dopo timeout i file restano disponibili
        // finché i consumatori nativi effettivamente pendenti sono terminati.
        void scope.close();
      }
    },
  });

  return outcome.value;
}

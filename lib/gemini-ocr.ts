import { isSupabaseConfigured } from './config';
import { resolveImageUri } from './image-uri';
import { callSupabaseFunction } from './supabase-functions';
import { runtimeLogger } from './safe-runtime-logger';
import * as FileSystem from 'expo-file-system/legacy';
import {
  normalizeGeminiDocumentExtract,
  type GeminiDocumentExtract,
} from './gemini-document-extract';
import {
  aiContextPayload,
  buildAiRequestContext,
  clearPendingOperation,
} from './ai-credit/operation-context';

export { normalizeGeminiDocumentExtract };
export type { GeminiDocumentExtract };

export const DOCUMENT_AI_INTERACTIVE_TIMEOUT_MS = 30_000;

export function isGeminiConfigured(): boolean {
  return isSupabaseConfigured();
}

export type GeminiDocumentExtractOutcome =
  | { status: 'ok'; extract: GeminiDocumentExtract; aiCreditsRemaining?: number }
  | { status: 'not_configured' }
  | { status: 'credits_exhausted' }
  | { status: 'error'; message: string };

function forceClientStructuredPageIndex(value: unknown, pageIndex: number): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => forceClientStructuredPageIndex(entry, pageIndex));
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const mapped = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      forceClientStructuredPageIndex(entry, pageIndex),
    ])
  );
  return 'pageIndex' in record || 'evidenceText' in record
    ? { ...mapped, pageIndex }
    : mapped;
}

async function readImageBase64(uri: string): Promise<string> {
  const resolved = resolveImageUri(uri);
  return FileSystem.readAsStringAsync(resolved, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

/** OCR cloud solo su richiesta esplicita per preventivi/ordini/documenti. */
export async function extractDocumentWithGeminiVerbose(
  imageUri: string,
  pageIndex = 0,
  pageCount = 1,
  existingOperationId?: string
): Promise<GeminiDocumentExtractOutcome> {
  if (!isGeminiConfigured()) {
    return { status: 'not_configured' };
  }

  const ctx = await buildAiRequestContext('document_page_ai', existingOperationId);

  try {
    const base64 = await readImageBase64(imageUri);
    const remote = await callSupabaseFunction<unknown>(
      'parse-document',
      {
        imageBase64: base64,
        mimeType: 'image/jpeg',
        // parse-document riceve una sola immagine per request: il costo corretto è 1 credito.
        // pageIndex/pageCount della richiesta Edge sono quindi 0/1; l'indice reale viene
        // ripristinato sotto sullo structured evidence prima del merge multipagina.
        pageIndex: 0,
        pageCount: 1,
        ...aiContextPayload(ctx),
      },
      { timeoutMs: DOCUMENT_AI_INTERACTIVE_TIMEOUT_MS }
    );

    if (remote.errorCode === 'AI_CREDITS_INSUFFICIENT') {
      return { status: 'credits_exhausted' };
    }

    const normalizedRemote = normalizeGeminiDocumentExtract(remote.data);
    if (normalizedRemote?.rawText.trim()) {
      if (normalizedRemote.structured) {
        normalizedRemote.structured = forceClientStructuredPageIndex(
          normalizedRemote.structured,
          pageIndex
        ) as typeof normalizedRemote.structured;
      }
      clearPendingOperation(ctx.operationId);
      const remaining =
        remote.data &&
        typeof remote.data === 'object' &&
        !Array.isArray(remote.data) &&
        typeof (remote.data as Record<string, unknown>).aiCreditsRemaining === 'number'
          ? (remote.data as Record<string, unknown>).aiCreditsRemaining as number
          : undefined;
      return { status: 'ok', extract: normalizedRemote, aiCreditsRemaining: remaining };
    }
    if (remote.error) {
      runtimeLogger.warn(
        'DOCUMENT_CLOUD_FAILED',
        new Error(remote.error),
        {
          httpStatus:
            remote.status >= 100 && remote.status <= 599
              ? remote.status
              : undefined,
          source: 'cloud',
          stage: 'network',
          status: 'failed',
        }
      );
    }

    return {
      status: 'error',
      message: remote.error ?? 'Il servizio AI non ha restituito testo leggibile',
    };
  } catch (error) {
    runtimeLogger.warn('DOCUMENT_AI_FAILED', error, {
      source: 'cloud',
      stage: 'provider',
      status: 'failed',
    });
    return {
      status: 'error',
      message: 'Impossibile contattare il servizio AI',
    };
  }
}

export async function extractDocumentWithGemini(
  imageUri: string
): Promise<GeminiDocumentExtract | null> {
  const outcome = await extractDocumentWithGeminiVerbose(imageUri);
  return outcome.status === 'ok' ? outcome.extract : null;
}

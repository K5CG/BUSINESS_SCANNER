import type { SupportedGeminiModel } from './gemini-model-config.ts';
import { MAX_PROVIDER_RESPONSE_BYTES } from './edge-request-guard.ts';
import {
  parseGeminiUsageMetadata,
  type GeminiTokenUsage,
} from './gemini-token-usage.ts';

export interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

export type GeminiProviderErrorCode =
  | 'AI_PROVIDER_NETWORK_ERROR'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_MODEL_NOT_FOUND'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_PROVIDER_REJECTED'
  | 'AI_PROVIDER_RESPONSE_TOO_LARGE'
  | 'AI_PROVIDER_RESPONSE_INVALID';

export type GeminiProviderOutcome =
  | {
      ok: true;
      text: string;
      /** Motivo di chiusura del candidato Gemini, se presente. */
      finishReason?: string;
      httpStatus?: number;
      /** Passive metering — never contains document contents. */
      usage?: GeminiTokenUsage;
    }
  | {
      ok: false;
      errorCode: GeminiProviderErrorCode;
      httpStatus?: number;
    };

export type { GeminiTokenUsage };

export type GeminiOperationOutcome<T> =
  | { ok: true; value: T; usage?: GeminiTokenUsage }
  | {
      ok: false;
      errorCode: GeminiProviderErrorCode;
      httpStatus?: number;
    };

export type GeminiFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

export interface GenerateGeminiJsonOptions {
  model: SupportedGeminiModel;
  parts: GeminiPart[];
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: GeminiFetch;
}

// Deve scadere prima del timeout client Supabase (45 s), così l'Edge Function
// può chiudere la richiesta e il client può avviare il fallback locale.
export const GEMINI_PROVIDER_TIMEOUT_MS = 12_000;

/**
 * Un PDF commerciale arriva intero al modello, con più pagine, tabelle e
 * riepiloghi fiscali da interpretare: dodici secondi bastano a una singola
 * pagina fotografata, non a un documento strutturato. Resta comunque ben
 * dentro i 45 secondi che il client concede alla chiamata.
 */
export const PDF_GEMINI_TIMEOUT_MS = 20_000;

function providerFailureForStatus(
  status: number
): GeminiProviderErrorCode {
  if (status === 404) return 'AI_MODEL_NOT_FOUND';
  if (status === 429) return 'AI_PROVIDER_RATE_LIMITED';
  if (status >= 500) return 'AI_PROVIDER_UNAVAILABLE';
  return 'AI_PROVIDER_REJECTED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function candidateTextFromPayload(payload: unknown): string | null {
  return candidateFromPayload(payload)?.text ?? null;
}

function candidateFromPayload(
  payload: unknown
): { text: string; finishReason?: string } | null {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return null;
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue;
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (isRecord(part) && typeof part.text === 'string' && part.text.trim()) {
        return {
          text: part.text,
          ...(typeof candidate.finishReason === 'string'
            ? { finishReason: candidate.finishReason }
            : {}),
        };
      }
    }
  }
  return null;
}

type ProviderBodyOutcome =
  | { ok: true; payload: unknown }
  | {
      ok: false;
      errorCode:
        | 'AI_PROVIDER_TIMEOUT'
        | 'AI_PROVIDER_RESPONSE_TOO_LARGE'
        | 'AI_PROVIDER_RESPONSE_INVALID';
    };

async function readProviderPayload(
  response: Response,
  signal: AbortSignal,
  maxBytes: number
): Promise<ProviderBodyOutcome> {
  const contentLength = response.headers?.get?.('content-length');
  if (
    contentLength !== null &&
    contentLength !== undefined &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, errorCode: 'AI_PROVIDER_RESPONSE_TOO_LARGE' };
  }

  // I Response reali espongono sempre body. Il fallback conserva la
  // compatibilità con fetch stub minimali usati nei test.
  if (!response.body) {
    try {
      return { ok: true, payload: await response.json() };
    } catch {
      return {
        ok: false,
        errorCode: signal.aborted
          ? 'AI_PROVIDER_TIMEOUT'
          : 'AI_PROVIDER_RESPONSE_INVALID',
      };
    }
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const aborted = new Promise<{ aborted: true }>((resolve) => {
    if (signal.aborted) {
      resolve({ aborted: true });
      return;
    }
    signal.addEventListener(
      'abort',
      () => resolve({ aborted: true }),
      { once: true }
    );
  });

  try {
    while (true) {
      const next = await Promise.race([
        reader.read().then((result) => ({ aborted: false as const, result })),
        aborted,
      ]);
      if (next.aborted) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, errorCode: 'AI_PROVIDER_TIMEOUT' };
      }
      if (next.result.done) break;

      totalBytes += next.result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          errorCode: 'AI_PROVIDER_RESPONSE_TOO_LARGE',
        };
      }
      chunks.push(next.result.value);
    }
  } catch {
    return {
      ok: false,
      errorCode: signal.aborted
        ? 'AI_PROVIDER_TIMEOUT'
        : 'AI_PROVIDER_RESPONSE_INVALID',
    };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, payload: JSON.parse(text) };
  } catch {
    return { ok: false, errorCode: 'AI_PROVIDER_RESPONSE_INVALID' };
  }
}

/**
 * Esegue esattamente una richiesta verso il modello già validato.
 * Il body di errore del provider non viene letto, registrato o restituito.
 */
export async function generateGeminiJson(
  options: GenerateGeminiJsonOptions
): Promise<GeminiProviderOutcome> {
  const controller = new AbortController();
  const timeoutMs =
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : GEMINI_PROVIDER_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    let response: Response;
    try {
      response = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': options.apiKey,
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: options.parts }],
            generationConfig: {
              responseMimeType: 'application/json',
            },
          }),
        }
      );
    } catch {
      return {
        ok: false,
        errorCode: controller.signal.aborted
          ? 'AI_PROVIDER_TIMEOUT'
          : 'AI_PROVIDER_NETWORK_ERROR',
      };
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        errorCode: providerFailureForStatus(response.status),
        httpStatus: response.status,
      };
    }

    const body = await readProviderPayload(
      response,
      controller.signal,
      options.maxResponseBytes ?? MAX_PROVIDER_RESPONSE_BYTES
    );
    if (!body.ok) return body;

    const candidate = candidateFromPayload(body.payload);
    if (!candidate?.text) {
      return { ok: false, errorCode: 'AI_PROVIDER_RESPONSE_INVALID' };
    }

    const usage = parseGeminiUsageMetadata(body.payload);

    return {
      ok: true,
      text: candidate.text,
      httpStatus: response.status,
      ...(candidate.finishReason !== undefined
        ? { finishReason: candidate.finishReason }
        : {}),
      ...(usage !== undefined ? { usage } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function geminiFailureHttpStatus(
  errorCode: GeminiProviderErrorCode
): number {
  switch (errorCode) {
    case 'AI_PROVIDER_RATE_LIMITED':
      return 429;
    case 'AI_PROVIDER_TIMEOUT':
      return 504;
    case 'AI_PROVIDER_UNAVAILABLE':
      return 503;
    case 'AI_PROVIDER_RESPONSE_INVALID':
      return 422;
    case 'AI_PROVIDER_RESPONSE_TOO_LARGE':
      return 502;
    default:
      return 502;
  }
}

export function geminiProviderFailure(
  errorCode: GeminiProviderErrorCode
): {
  status: number;
  body: { error: string; errorCode: GeminiProviderErrorCode };
} {
  return {
    status: geminiFailureHttpStatus(errorCode),
    body: {
      error: 'Il servizio AI non ha completato l’operazione',
      errorCode,
    },
  };
}

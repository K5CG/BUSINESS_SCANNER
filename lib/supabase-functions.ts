import { getSupabaseAnonKey, getSupabaseUrl, isSupabaseConfigured } from './config';

export { isSupabaseConfigured };

export const FUNCTION_TIMEOUT_MS = 15_000;
export const DOCUMENT_FUNCTION_TIMEOUT_MS = 45_000;
const MAX_FUNCTION_RESPONSE_BYTES = 512 * 1024;

export type SupabaseFunctionName =
  | 'check-license'
  | 'parse-document'
  | 'parse-pdf'
  | 'structure-business-card'
  | 'validate-license'
  | 'privacy-consent';

const DOCUMENT_FUNCTIONS = new Set<SupabaseFunctionName>([
  'parse-document',
  'parse-pdf',
  'structure-business-card',
]);

const SAFE_DOCUMENT_ERRORS: Record<string, string> = {
  CORS_ORIGIN_DENIED: 'Origine richiesta non consentita',
  METHOD_NOT_ALLOWED: 'Metodo non consentito',
  CONTENT_TYPE_REQUIRED: 'Richiesta non supportata',
  CONTENT_ENCODING_UNSUPPORTED: 'Richiesta non supportata',
  EMPTY_PAYLOAD: 'Richiesta non valida',
  PAYLOAD_TOO_LARGE: 'Richiesta troppo grande',
  REQUEST_BODY_TIMEOUT: 'Tempo di richiesta scaduto',
  INVALID_JSON: 'Richiesta non valida',
  INVALID_REQUEST: 'Richiesta non valida',
  INVALID_BASE64: 'Contenuto file non valido',
  FILE_TOO_LARGE: 'File troppo grande',
  UNSUPPORTED_MIME_TYPE: 'Formato file non supportato',
  MEDIA_SIGNATURE_MISMATCH: 'Contenuto file non valido',
  PDF_INVALID: 'PDF non valido',
  PDF_PAGE_LIMIT_EXCEEDED: 'Il PDF contiene troppe pagine',
  RATE_LIMITED: 'Troppe richieste, riprova più tardi',
  CONCURRENCY_LIMITED: 'Servizio temporaneamente occupato',
  EDGE_SECURITY_UNAVAILABLE: 'Servizio temporaneamente non disponibile',
  AI_QUOTA_EXCEEDED: 'Quota AI giornaliera raggiunta, riprova domani',
  AI_CREDITS_INSUFFICIENT: 'Crediti AI esauriti',
  AI_CREDITS_UNAVAILABLE: 'Servizio AI temporaneamente non disponibile',
  AI_MODEL_NOT_CONFIGURED: 'Servizio AI temporaneamente non disponibile',
  AI_MODEL_UNSUPPORTED: 'Servizio AI temporaneamente non disponibile',
  AI_CONFIGURATION_UNAVAILABLE: 'Servizio AI temporaneamente non disponibile',
  AI_PROVIDER_NETWORK_ERROR: 'Servizio AI temporaneamente non disponibile',
  AI_PROVIDER_TIMEOUT: 'Tempo di richiesta AI scaduto',
  AI_MODEL_NOT_FOUND: 'Servizio AI temporaneamente non disponibile',
  AI_PROVIDER_RATE_LIMITED: 'Servizio AI temporaneamente occupato',
  AI_PROVIDER_UNAVAILABLE: 'Servizio AI temporaneamente non disponibile',
  AI_PROVIDER_REJECTED: 'Servizio AI temporaneamente non disponibile',
  AI_PROVIDER_RESPONSE_TOO_LARGE: 'Risposta AI non valida',
  AI_PROVIDER_RESPONSE_INVALID: 'Risposta AI non valida',
  DOCUMENT_PARSE_FAILED: 'Impossibile elaborare il documento',
  PDF_PARSE_FAILED: 'Impossibile elaborare il PDF',
  CARD_STRUCTURE_FAILED: 'Impossibile strutturare il biglietto da visita',
};

function stableErrorCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value)
    ? value
    : null;
}

type FunctionResponseRead =
  | { ok: true; text: string }
  | { ok: false; reason: 'invalid' | 'timeout' | 'too_large' };

async function readFunctionResponse(
  response: Response,
  signal: AbortSignal
): Promise<FunctionResponseRead> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > MAX_FUNCTION_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }

  if (!response.body) {
    try {
      const text = await response.text();
      return new TextEncoder().encode(text).byteLength >
        MAX_FUNCTION_RESPONSE_BYTES
        ? { ok: false, reason: 'too_large' }
        : { ok: true, text };
    } catch {
      return {
        ok: false,
        reason: signal.aborted ? 'timeout' : 'invalid',
      };
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pieces: string[] = [];
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
        return { ok: false, reason: 'timeout' };
      }
      if (next.result.done) break;
      totalBytes += next.result.value.byteLength;
      if (totalBytes > MAX_FUNCTION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      pieces.push(decoder.decode(next.result.value, { stream: true }));
    }
    pieces.push(decoder.decode());
    return { ok: true, text: pieces.join('') };
  } catch {
    return {
      ok: false,
      reason: signal.aborted ? 'timeout' : 'invalid',
    };
  }
}

export interface SupabaseFunctionCallOptions {
  /** Optional per-call timeout. Defaults remain unchanged when omitted. */
  timeoutMs?: number;
}

export function resolveSupabaseFunctionTimeoutMs(
  functionName: SupabaseFunctionName,
  options: SupabaseFunctionCallOptions = {}
): number {
  const override =
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.round(options.timeoutMs)
      : undefined;
  if (override !== undefined) return override;
  return DOCUMENT_FUNCTIONS.has(functionName)
    ? DOCUMENT_FUNCTION_TIMEOUT_MS
    : FUNCTION_TIMEOUT_MS;
}

export async function callSupabaseFunction<T>(
  functionName: SupabaseFunctionName,
  body: Record<string, unknown>,
  options: SupabaseFunctionCallOptions = {}
): Promise<{ data: T | null; error: string | null; errorCode?: string; status: number }> {
  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) {
    return { data: null, error: 'Supabase non configurato', status: 0 };
  }

  // Timeout esplicito: una chiamata lenta non deve mai bloccare l'app
  const controller = new AbortController();
  const timeoutMs = resolveSupabaseFunctionTimeoutMs(functionName, options);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${url}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Le funzioni licenza restano sul contratto precedente: la Fase 7C
    // applica limiti e catalogo errori esclusivamente agli endpoint documentali.
    if (!DOCUMENT_FUNCTIONS.has(functionName)) {
      const text = await response.text();
      let payload: T | { error?: string } | null = null;
      if (text) {
        try {
          payload = JSON.parse(text) as T | { error?: string };
        } catch {
          payload = null;
        }
      }

      if (!response.ok) {
        const errorPayload =
          payload && typeof payload === 'object'
            ? (payload as { error?: string; errorCode?: string })
            : null;
        return {
          data: null,
          error:
            errorPayload?.error ?? (text || `HTTP ${response.status}`),
          errorCode: errorPayload?.errorCode,
          status: response.status,
        };
      }

      return { data: payload as T, error: null, status: response.status };
    }

    const responseBody = await readFunctionResponse(
      response,
      controller.signal
    );
    if (!responseBody.ok) {
      const timedOut = responseBody.reason === 'timeout';
      return {
        data: null,
        error:
          responseBody.reason === 'too_large'
            ? 'Risposta del servizio troppo grande'
            : timedOut
              ? 'Tempo di richiesta scaduto'
              : 'Risposta del servizio non valida',
        errorCode:
          responseBody.reason === 'too_large'
            ? 'EDGE_RESPONSE_TOO_LARGE'
            : timedOut
              ? 'EDGE_TIMEOUT'
              : 'EDGE_RESPONSE_INVALID',
        status: response.status,
      };
    }
    const text = responseBody.text;

    let payload:
      | T
      | { error?: string; errorCode?: string }
      | null = null;
    if (text) {
      try {
        payload = JSON.parse(text) as
          | T
          | { error?: string; errorCode?: string };
      } catch {
        return {
          data: null,
          error: 'Risposta del servizio non valida',
          errorCode: 'EDGE_RESPONSE_INVALID',
          status: response.status,
        };
      }
    }

    if (!response.ok) {
      const errorPayload =
        payload && typeof payload === 'object'
          ? (payload as { error?: string; errorCode?: string })
          : null;
      const parsedErrorCode =
        stableErrorCode(errorPayload?.errorCode) ?? undefined;
      const errorCode =
        parsedErrorCode && SAFE_DOCUMENT_ERRORS[parsedErrorCode]
          ? parsedErrorCode
          : undefined;
      const message =
        (errorCode && SAFE_DOCUMENT_ERRORS[errorCode]) ??
        'Il servizio non ha completato l’operazione';
      return {
        data: null,
        error: message,
        errorCode,
        status: response.status,
      };
    }

    return { data: payload as T, error: null, status: response.status };
  } catch (error) {
    if (!DOCUMENT_FUNCTIONS.has(functionName)) {
      return { data: null, error: String(error), status: 0 };
    }
    const timedOut =
      error instanceof Error &&
      (error.name === 'AbortError' || controller.signal.aborted);
    return {
      data: null,
      error: timedOut
        ? 'Tempo di richiesta scaduto'
        : 'Connessione al servizio non disponibile',
      errorCode: timedOut ? 'EDGE_TIMEOUT' : 'EDGE_NETWORK_ERROR',
      status: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

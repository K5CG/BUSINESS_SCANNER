export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DOCUMENT_ALLOWED_HEADERS =
  'authorization, x-client-info, apikey, content-type';

export interface DocumentCorsDecision {
  allowed: boolean;
  headers: Record<string, string>;
}

function configuredOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const candidate of raw?.split(',') ?? []) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed === '*') continue;
    try {
      const url = new URL(trimmed);
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        trimmed.replace(/\/$/, '') === url.origin
      ) {
        origins.add(url.origin);
      }
    } catch {
      // Configurazioni non valide vengono ignorate: la policy resta fail-closed.
    }
  }
  return origins;
}

/**
 * CORS limita soltanto le pagine web eseguite da un browser. Le richieste
 * native normalmente non hanno Origin e restano ammesse senza header ACAO:
 * questa scelta non è autenticazione e non sostituisce rate limit/JWT.
 */
export function resolveDocumentCors(
  request: Request,
  allowedOrigins: string | undefined
): DocumentCorsDecision {
  const origin = request.headers.get('origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': DOCUMENT_ALLOWED_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };

  if (origin === null) return { allowed: true, headers };
  if (origin === 'null' || !configuredOrigins(allowedOrigins).has(origin)) {
    return { allowed: false, headers };
  }

  return {
    allowed: true,
    headers: {
      ...headers,
      'Access-Control-Allow-Origin': origin,
    },
  };
}

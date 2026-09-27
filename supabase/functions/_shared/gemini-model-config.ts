export const SUPPORTED_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
] as const;

export type SupportedGeminiModel =
  (typeof SUPPORTED_GEMINI_MODELS)[number];

export type GeminiModelConfigurationErrorCode =
  | 'AI_MODEL_NOT_CONFIGURED'
  | 'AI_MODEL_UNSUPPORTED';

export type GeminiModelConfiguration =
  | { ok: true; model: SupportedGeminiModel }
  | {
      ok: false;
      errorCode: GeminiModelConfigurationErrorCode;
    };

const SUPPORTED_MODEL_SET = new Set<string>(SUPPORTED_GEMINI_MODELS);

/**
 * Fail-closed: il modello deve essere scelto esplicitamente nell'ambiente
 * server. Non esistono default, alias mobili o fallback automatici.
 */
export function resolveGeminiModelConfiguration(
  configuredModel: string | null | undefined
): GeminiModelConfiguration {
  const model = configuredModel?.trim();
  if (!model) {
    return { ok: false, errorCode: 'AI_MODEL_NOT_CONFIGURED' };
  }
  if (!SUPPORTED_MODEL_SET.has(model)) {
    return { ok: false, errorCode: 'AI_MODEL_UNSUPPORTED' };
  }
  return { ok: true, model: model as SupportedGeminiModel };
}

export function geminiModelConfigurationFailure(
  errorCode: GeminiModelConfigurationErrorCode
): {
  status: 503;
  body: { error: string; errorCode: GeminiModelConfigurationErrorCode };
} {
  return {
    status: 503,
    body: {
      error: 'Servizio AI temporaneamente non disponibile',
      errorCode,
    },
  };
}

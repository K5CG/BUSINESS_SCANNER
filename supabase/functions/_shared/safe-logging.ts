export const EDGE_LOG_CODES = [
  'AI_USAGE_CHECK_FAILED',
  'AI_USAGE_UPDATE_FAILED',
  'CARD_STRUCTURE_FAILED',
  'CARD_STRUCTURE_PROVIDER_FAILED',
  'DOCUMENT_PARSE_FAILED',
  'EDGE_TRAFFIC_ACQUIRE_FAILED',
  'EDGE_TRAFFIC_RELEASE_FAILED',
  'GEMINI_PROVIDER_REJECTED',
  'GEMINI_TOKEN_USAGE',
  'LICENSE_LOOKUP_FAILED',
  'PDF_PARSE_FAILED',
] as const;

export type EdgeLogCode = (typeof EDGE_LOG_CODES)[number];

export interface EdgeLogMetadata {
  pageCount?: number;
  payloadBytes?: number;
  fieldCount?: number;
  durationMs?: number;
  httpStatus?: number;
  count?: number;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  creditsCharged?: number;
  status?: 'completed' | 'failed' | 'rejected' | 'unavailable';
  stage?: 'database' | 'parse' | 'provider' | 'validation';
  method?: 'POST' | 'OPTIONS';
  mimeType?: 'application/json' | 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
  documentType?: 'business_card' | 'quote' | 'order' | 'free_document';
  reasonCode?: 'model_missing' | 'provider_rejected' | 'response_invalid';
  operationType?:
    | 'business_card_ai'
    | 'document_page_ai'
    | 'pdf_page_ai'
    | 'document_reprocess';
  model?: 'gemini-3.5-flash-lite' | 'gemini-3.6-flash';
}

export interface EdgeLogSink {
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
}

const EDGE_LOG_CODE_SET = new Set<string>(EDGE_LOG_CODES);

const NUMERIC_BOUNDS: Partial<
  Record<keyof EdgeLogMetadata, readonly [number, number]>
> = {
  pageCount: [0, 100],
  payloadBytes: [0, 100 * 1024 * 1024],
  fieldCount: [0, 1_000],
  durationMs: [0, 300_000],
  httpStatus: [100, 599],
  count: [0, 1_000_000],
  promptTokens: [0, 50_000_000],
  outputTokens: [0, 50_000_000],
  totalTokens: [0, 50_000_000],
  creditsCharged: [0, 100_000],
};

const STRING_VALUES: Partial<Record<keyof EdgeLogMetadata, readonly string[]>> = {
  status: ['completed', 'failed', 'rejected', 'unavailable'],
  stage: ['database', 'parse', 'provider', 'validation'],
  method: ['POST', 'OPTIONS'],
  mimeType: [
    'application/json',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
  ],
  documentType: ['business_card', 'quote', 'order', 'free_document'],
  reasonCode: ['model_missing', 'provider_rejected', 'response_invalid'],
  operationType: [
    'business_card_ai',
    'document_page_ai',
    'pdf_page_ai',
    'document_reprocess',
  ],
  model: ['gemini-3.5-flash-lite', 'gemini-3.6-flash'],
};

export function normalizeEdgeLogCode(
  code: unknown
): EdgeLogCode | 'INVALID_LOG_CODE' {
  return typeof code === 'string' && EDGE_LOG_CODE_SET.has(code)
    ? (code as EdgeLogCode)
    : 'INVALID_LOG_CODE';
}

export function sanitizeEdgeLogMetadata(
  metadata: Record<string, unknown> | EdgeLogMetadata | undefined
): Record<string, string | number> {
  if (!metadata) return {};
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const typedKey = key as keyof EdgeLogMetadata;
    const bounds = NUMERIC_BOUNDS[typedKey];
    if (
      bounds &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= bounds[0] &&
      value <= bounds[1]
    ) {
      safe[key] = value;
      continue;
    }
    const allowedValues = STRING_VALUES[typedKey];
    if (
      allowedValues &&
      typeof value === 'string' &&
      allowedValues.includes(value)
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

export function createSafeEdgeLogger(sink: EdgeLogSink) {
  const emit = (
    level: 'info' | 'warn' | 'error',
    code: EdgeLogCode,
    metadata?: EdgeLogMetadata
  ) => {
    const eventCode = normalizeEdgeLogCode(code);
    sink[level]({
      scope: 'edge',
      level,
      eventCode,
      ...(level === 'info' ? {} : { errorCode: eventCode }),
      metadata: sanitizeEdgeLogMetadata(metadata),
    });
  };

  return {
    info(code: EdgeLogCode, metadata?: EdgeLogMetadata): void {
      emit('info', code, metadata);
    },
    warn(code: EdgeLogCode, metadata?: EdgeLogMetadata): void {
      emit('warn', code, metadata);
    },
    error(code: EdgeLogCode, metadata?: EdgeLogMetadata): void {
      emit('error', code, metadata);
    },
  };
}

export const edgeLogger = createSafeEdgeLogger(console);

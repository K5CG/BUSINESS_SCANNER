declare const __DEV__: boolean | undefined;

export const RUNTIME_LOG_CODES = [
  'AI_NOTICE_SAVE_FAILED',
  'APP_BOOTSTRAP_FAILED',
  'CAMERA_CAPTURE_DIAGNOSTIC',
  'CAMERA_DIAGNOSTIC',
  'CAPTURE_FAILED',
  'CAPTURE_PROCESSING_OR_PERSISTENCE_FAILED',
  'CARD_AI_STRUCTURE_FAILED',
  'CARD_SCAN_FAILED',
  'CONTACT_CLEAR_FAILED',
  'CONTACT_EXPORT_FAILED',
  'CONTACT_SAVE_FAILED',
  'CONTACT_REPARSE_BLOCKED',
  'CONTACT_REPARSE_DIFF',
  'CONTACT_REPARSE_FAILED',
  'CONTACT_REPARSE_SUMMARY',
  'CROP_DIAGNOSTIC',
  'DEVICE_ID_READ_FAILED',
  'DEVICE_ID_WRITE_FAILED',
  'DOCUMENT_AI_DIAGNOSTIC',
  'DOCUMENT_AI_FAILED',
  'DOCUMENT_CLOUD_FAILED',
  'PROCESSED_VISUAL_ORIENTATION_PROBE_FAILED',
  'LANDSCAPE_ASPECT_MISMATCH_PROBE_FAILED',
  'PORTRAIT_QUARTER_TURN_PROBE_FAILED',
  'LANDSCAPE_READING_ORDER_PROBE_FAILED',
  'DOCUMENT_ORIENTATION_NORMALIZATION_FAILED',
  'FOCUS_TIMELINE',
  'GEMINI_PROVIDER_REJECTED',
  'IMAGE_ASPECT_MISMATCH',
  'IMAGE_BITMAP_DIAGNOSTIC',
  'IMAGE_RESIZE_DIAGNOSTIC',
  'LICENSE_CHECK_FAILED',
  'LICENSE_REFRESH_FAILED',
  'LICENSE_STATE_WRITE_FAILED',
  'LICENSE_STATE_MIGRATED',
  'SECURE_STORE_READ_FAILED',
  'SECURE_STORE_WRITE_FAILED',
  'SECURE_STORE_FALLBACK_WRITE_FAILED',
  'SECURE_JSON_WRITE_FAILED',
  'INSTALLATION_ID_GENERATED',
  'INSTALLATION_ID_PERSIST_FAILED',
  'LEGACY_DEVICE_ID_DELETE_FAILED',
  'LEGACY_LICENSE_STATE_DELETE_FAILED',
  'LOCALE_SAVE_FAILED',
  'OCR_ANGLE_FAILED',
  'OCR_CJK_ANGLE_FAILED',
  'OCR_CANDIDATE_FAILED',
  'OCR_INPUT_REJECTED_DEGENERATE_IMAGE',
  'OCR_CRITICAL_ROW_REFINED',
  'OCR_CRITICAL_ROW_REFINE_FAILED',
  'OCR_MISSING_IDENTITY_REFINE_FAILED',
  'OCR_DOCUMENT_TIMEOUT',
  'OCR_EMAIL_ROW_REFINED',
  'OCR_EMAIL_ROW_REFINE_FAILED',
  'OCR_FAILED',
  'OCR_NATIVE_UNAVAILABLE',
  'OCR_QA_ARTIFACT_FAILED',
  'ORIENTATION_CLEANUP_FAILED',
  'PARSER_LAYOUT_DIAGNOSTIC',
  'PARSER_ML_COMPLETED',
  'PARSER_ML_INFERENCE_SKIPPED',
  'PARSER_ML_MODEL_LOAD_FAILED',
  'PARSER_ML_MODEL_LOADED',
  'PARSER_ML_RUN',
  'PARSER_PAGE_FALLBACK',
  'PARSER_PERSON_PAIR_DIAGNOSTIC',
  'PARSER_PERSON_REJECTED',
  'PDF_CLOUD_FAILED',
  'PDF_CLOUD_REJECTED',
  'PDF_IMPORT_FAILED',
  'PDF_ITEMS_PASS_DIAGNOSTIC',
  'PDF_LOCAL_DIAGNOSTIC',
  'PDF_QA_DIAGNOSTIC',
  'PENDING_DOCUMENT_ROTATE_180_FAILED',
  'PRIVACY_CONSENT_LOAD_FAILED',
  'PRIVACY_CONSENT_SAVE_FAILED',
  'QA_IMAGE_SKIPPED',
  'QA_SHARE_FAILED',
  'SCAN_PROCESS_FAILED',
  'THEME_PREFERENCE_SAVE_FAILED',
  'DOCUMENT_READING_ORIENTATION_PROBE_FAILED',
] as const;

export type RuntimeLogCode = (typeof RUNTIME_LOG_CODES)[number];
export type SafeLogLevel = 'debug' | 'info' | 'warn' | 'error';

type SafeStatus =
  | 'active'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'inactive'
  | 'timed_out'
  | 'rejected'
  | 'skipped'
  | 'started'
  | 'unavailable';

type SafeStage =
  | 'bootstrap'
  | 'capture'
  | 'cleanup'
  | 'database'
  | 'filesystem'
  | 'network'
  | 'preview'
  | 'ocr'
  | 'parse'
  | 'persist'
  | 'provider'
  | 'migration'
  | 'delete'
  | 'read'
  | 'write';

type SafeSource =
  | 'camera'
  | 'cloud'
  | 'database'
  | 'filesystem'
  | 'local'
  | 'provider';

type SafeReasonCode =
  | 'domain_collision'
  | 'full_name_rejected'
  | 'initial_length'
  | 'last_name_rejected'
  | 'line_text_rejected'
  | 'model_missing'
  | 'native_module_missing'
  | 'person_pair_probe';

export interface SafeLogMetadata {
  pageCount?: number;
  durationMs?: number;
  payloadBytes?: number;
  fieldCount?: number;
  candidateIndex?: number;
  angle?: number;
  httpStatus?: number;
  count?: number;
  width?: number;
  height?: number;
  skipped?: number;
  updated?: number;
  changed?: number;
  unchanged?: number;
  accepted?: number;
  rejected?: number;
  status?: SafeStatus;
  stage?: SafeStage;
  source?: SafeSource;
  method?: 'GET' | 'POST' | 'OPTIONS';
  mimeType?: 'application/json' | 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
  documentType?: 'business_card' | 'quote' | 'order' | 'invoice' | 'free_document';
  reasonCode?: SafeReasonCode;
}

export interface SafeLogSink {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
}

export interface SafeLogRecord {
  scope: 'client';
  level: SafeLogLevel;
  eventCode: RuntimeLogCode | 'INVALID_LOG_CODE';
  errorCode?: RuntimeLogCode | 'INVALID_LOG_CODE';
  metadata: Record<string, string | number>;
  stack?: string;
  diagnostic?: unknown;
}

const RUNTIME_LOG_CODE_SET = new Set<string>(RUNTIME_LOG_CODES);

const NUMERIC_BOUNDS: Partial<
  Record<keyof SafeLogMetadata, readonly [number, number]>
> = {
  pageCount: [0, 100],
  durationMs: [0, 300_000],
  payloadBytes: [0, 100 * 1024 * 1024],
  fieldCount: [0, 1_000],
  candidateIndex: [0, 10_000],
  angle: [-360, 360],
  httpStatus: [100, 599],
  count: [0, 1_000_000],
  width: [0, 50_000],
  height: [0, 50_000],
  skipped: [0, 1_000_000],
  updated: [0, 1_000_000],
  changed: [0, 1_000_000],
  unchanged: [0, 1_000_000],
  accepted: [0, 1_000_000],
  rejected: [0, 1_000_000],
};

const STRING_VALUES: Partial<Record<keyof SafeLogMetadata, readonly string[]>> = {
  status: [
    'active',
    'blocked',
    'completed',
    'failed',
    'inactive',
    'timed_out',
    'rejected',
    'skipped',
    'started',
    'unavailable',
  ],
  stage: [
    'bootstrap',
    'capture',
    'cleanup',
    'database',
    'filesystem',
    'network',
    'preview',
    'ocr',
    'parse',
    'persist',
    'provider',
    'migration',
    'delete',
    'read',
    'write',
  ],
  source: ['camera', 'cloud', 'database', 'filesystem', 'local', 'provider'],
  method: ['GET', 'POST', 'OPTIONS'],
  mimeType: [
    'application/json',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
  ],
  documentType: ['business_card', 'quote', 'order', 'free_document'],
  reasonCode: [
    'domain_collision',
    'full_name_rejected',
    'initial_length',
    'last_name_rejected',
    'line_text_rejected',
    'model_missing',
    'native_module_missing',
    'person_pair_probe',
  ],
};

export function normalizeRuntimeLogCode(
  code: unknown
): RuntimeLogCode | 'INVALID_LOG_CODE' {
  return typeof code === 'string' && RUNTIME_LOG_CODE_SET.has(code)
    ? (code as RuntimeLogCode)
    : 'INVALID_LOG_CODE';
}

export function sanitizeSafeLogMetadata(
  metadata: Record<string, unknown> | SafeLogMetadata | undefined
): Record<string, string | number> {
  if (!metadata) return {};
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const typedKey = key as keyof SafeLogMetadata;
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

function developmentStack(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.stack;
}

export function createSafeRuntimeLogger(options: {
  isDevelopment: boolean;
  sink: SafeLogSink;
}) {
  const emit = (
    level: Exclude<SafeLogLevel, 'debug'>,
    code: RuntimeLogCode,
    error?: unknown,
    metadata?: SafeLogMetadata
  ) => {
    const eventCode = normalizeRuntimeLogCode(code);
    const record: SafeLogRecord = {
      scope: 'client',
      level,
      eventCode,
      errorCode: eventCode,
      metadata: sanitizeSafeLogMetadata(metadata),
    };
    if (options.isDevelopment) {
      const stack = developmentStack(error);
      if (stack) record.stack = stack;
    }
    options.sink[level](record);
  };

  return {
    debug(
      code: RuntimeLogCode,
      metadata?: SafeLogMetadata,
      diagnostic?: unknown
    ): void {
      if (!options.isDevelopment) return;
      options.sink.log({
        scope: 'client',
        level: 'debug',
        eventCode: normalizeRuntimeLogCode(code),
        metadata: sanitizeSafeLogMetadata(metadata),
        ...(diagnostic === undefined ? {} : { diagnostic }),
      } satisfies SafeLogRecord);
    },
    info(code: RuntimeLogCode, metadata?: SafeLogMetadata): void {
      emit('info', code, undefined, metadata);
    },
    warn(
      code: RuntimeLogCode,
      error?: unknown,
      metadata?: SafeLogMetadata
    ): void {
      emit('warn', code, error, metadata);
    },
    error(
      code: RuntimeLogCode,
      error?: unknown,
      metadata?: SafeLogMetadata
    ): void {
      emit('error', code, error, metadata);
    },
  };
}

const isDevelopment =
  typeof __DEV__ !== 'undefined' && __DEV__ === true;

export const runtimeLogger = createSafeRuntimeLogger({
  isDevelopment,
  sink: console,
});

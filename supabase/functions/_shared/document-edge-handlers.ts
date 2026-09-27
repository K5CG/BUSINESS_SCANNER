import {
  resolveDocumentCors,
  type DocumentCorsDecision,
} from './cors.ts';
import {
  MAX_CARD_OCR_CHARS,
  MAX_CARD_REQUEST_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_REQUEST_BYTES,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  MAX_PDF_REQUEST_BYTES,
  MAX_PROVIDER_RESPONSE_BYTES,
  decodeStrictBase64,
  isImageMimeType,
  isStructurallyValidImage,
  readBoundedJsonObject,
  validateJsonRequestHeaders,
  validatePdfPageCount,
  type EdgeTrafficControl,
  type PdfPageCounter,
  type RequestGuardErrorCode,
} from './edge-request-guard.ts';
import {
  CARD_EXTRACT_PROMPT,
  EXTRACT_PROMPT,
  extractPdfWithGemini,
  extractWithGemini,
  pdfExpectedDocumentType,
  type DocumentExtract,
  type ExtractPdfOptions,
  type PdfExtraction,
} from './gemini-extract.ts';
import {
  geminiModelConfigurationFailure,
  type GeminiModelConfiguration,
} from './gemini-model-config.ts';
import {
  geminiProviderFailure,
  PDF_GEMINI_TIMEOUT_MS,
  type GeminiOperationOutcome,
  type GeminiPart,
  type GeminiTokenUsage,
} from './gemini-provider.ts';
import {
  structureCardWithGeminiVerbose,
  type AiCardStructure,
} from './card-structure.ts';
import { edgeLogger } from './safe-logging.ts';
import type { SupportedGeminiModel } from './gemini-model-config.ts';
import { AiCreditGuard } from './ai-credit-ledger.ts';
import { parseAiCreditContext } from './ai-credit-edge.ts';
import { creditsForOperation } from '../../../lib/ai-credit/cost-policy.ts';
import {
  buildGeminiTokenUsageReport,
  toSafeTokenUsageDiagnostic,
  type GeminiMeterOperationType,
  type GeminiTokenUsageCallReport,
  type GeminiTokenUsageReport,
} from './gemini-token-usage.ts';
import type { PdfPassTokenUsage } from './gemini-extract.ts';

export const DOCUMENT_GEMINI_TIMEOUT_MS = 20_000;

export type DocumentEdgeHandler = (request: Request) => Promise<Response>;

interface CommonHandlerDependencies {
  allowedOrigins: () => string | undefined;
  getApiKey: () => string | undefined;
  getModelConfiguration: () => GeminiModelConfiguration;
  traffic: EdgeTrafficControl;
  creditGuard?: AiCreditGuard;
  /**
   * Durable trial/premium grant bootstrap (idempotent RPC).
   * Awaited before reserve so the installation has a funded account.
   */
  ensureCreditGrant?: (
    installationId: string,
    licenseId: string | null
  ) => void | Promise<void>;
  /**
   * Fail-closed commercial gate: active paid activation OR active trial.
   * When omitted (unit tests without DB), credit reserve alone applies.
   * Production AI handlers must wire this.
   */
  assertCommercialAccess?: (
    installationId: string,
    licenseId: string | null
  ) => boolean | Promise<boolean>;
}

type ExtractDocument = (
  parts: GeminiPart[],
  apiKey: string,
  model: SupportedGeminiModel,
  options?: { timeoutMs?: number }
) => Promise<GeminiOperationOutcome<DocumentExtract>>;

type ExtractPdf = (
  pdfBase64: string,
  apiKey: string,
  model: SupportedGeminiModel,
  options?: ExtractPdfOptions
) => Promise<GeminiOperationOutcome<PdfExtraction>>;

type StructureCard = (
  ocrText: string,
  apiKey: string,
  model: SupportedGeminiModel
) => Promise<GeminiOperationOutcome<AiCardStructure>>;

export interface ParseDocumentHandlerDependencies
  extends CommonHandlerDependencies {
  extract?: ExtractDocument;
}

export interface ParsePdfHandlerDependencies
  extends CommonHandlerDependencies {
  countPdfPages: PdfPageCounter;
  extractPdf?: ExtractPdf;
}

export interface StructureCardHandlerDependencies
  extends CommonHandlerDependencies {
  isWithinDailyQuota: () => Promise<boolean>;
  structure?: StructureCard;
}

const ERROR_MESSAGES: Record<string, string> = {
  CORS_ORIGIN_DENIED: 'Origine richiesta non consentita',
  METHOD_NOT_ALLOWED: 'Metodo non consentito',
  CONTENT_TYPE_REQUIRED: 'Content-Type non supportato',
  CONTENT_ENCODING_UNSUPPORTED: 'Codifica richiesta non supportata',
  EMPTY_PAYLOAD: 'Richiesta non valida',
  PAYLOAD_TOO_LARGE: 'Richiesta troppo grande',
  REQUEST_BODY_TIMEOUT: 'Tempo di ricezione richiesta scaduto',
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
  AI_CONFIGURATION_UNAVAILABLE: 'Servizio AI temporaneamente non disponibile',
  AI_QUOTA_EXCEEDED: 'Quota AI giornaliera raggiunta, riprova domani',
  AI_CREDITS_INSUFFICIENT: 'Crediti AI insufficienti',
  AI_CREDITS_UNAVAILABLE: 'Crediti AI temporaneamente non disponibili',
  LICENSE_INACTIVE: 'Licenza o periodo di prova non attivo',
  DOCUMENT_PARSE_FAILED: 'Impossibile elaborare il documento',
  PDF_PARSE_FAILED: 'Impossibile elaborare il PDF',
  CARD_STRUCTURE_FAILED: 'Impossibile strutturare il biglietto da visita',
};

function responseHeaders(
  cors: DocumentCorsDecision,
  additional: Record<string, string> = {}
): Record<string, string> {
  return {
    ...cors.headers,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    ...additional,
  };
}

function jsonResponse(
  body: object,
  status: number,
  cors: DocumentCorsDecision,
  additionalHeaders?: Record<string, string>
): Response {
  const serialized = JSON.stringify(body);
  if (
    new TextEncoder().encode(serialized).byteLength >
    MAX_PROVIDER_RESPONSE_BYTES
  ) {
    return new Response(
      JSON.stringify({
        error: 'Il servizio AI non ha completato l’operazione',
        errorCode: 'AI_PROVIDER_RESPONSE_TOO_LARGE',
      }),
      {
        status: 502,
        headers: responseHeaders(cors),
      }
    );
  }

  return new Response(serialized, {
    status,
    headers: responseHeaders(cors, additionalHeaders),
  });
}

function jsonError(
  errorCode: string,
  status: number,
  cors: DocumentCorsDecision,
  additionalHeaders?: Record<string, string>
): Response {
  return jsonResponse(
    {
      error: ERROR_MESSAGES[errorCode] ?? 'Operazione non completata',
      errorCode,
    },
    status,
    cors,
    additionalHeaders
  );
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(body).every((key) => allowedSet.has(key));
}

type EnteredRequest =
  | { entered: false; response: Response }
  | {
      entered: true;
      cors: DocumentCorsDecision;
      release: () => Promise<void>;
    };

async function enterRequest(
  request: Request,
  dependencies: CommonHandlerDependencies
): Promise<EnteredRequest> {
  const cors = resolveDocumentCors(
    request,
    dependencies.allowedOrigins()
  );
  if (!cors.allowed) {
    return {
      entered: false,
      response: jsonError('CORS_ORIGIN_DENIED', 403, cors),
    };
  }

  if (request.method === 'OPTIONS') {
    return {
      entered: false,
      response: new Response(null, {
        status: 204,
        headers: {
          ...cors.headers,
          'Cache-Control': 'no-store',
        },
      }),
    };
  }

  if (request.method !== 'POST') {
    return {
      entered: false,
      response: jsonError('METHOD_NOT_ALLOWED', 405, cors, {
        Allow: 'POST, OPTIONS',
      }),
    };
  }

  const headerFailure = validateJsonRequestHeaders(request);
  if (headerFailure) {
    return {
      entered: false,
      response: jsonError(
        headerFailure.errorCode,
        headerFailure.status,
        cors
      ),
    };
  }

  const admission = await dependencies.traffic.enter(request);
  if (!admission.allowed) {
    const errorCode =
      admission.reason === 'rate_limited'
        ? 'RATE_LIMITED'
        : admission.reason === 'concurrency_limited'
          ? 'CONCURRENCY_LIMITED'
          : 'EDGE_SECURITY_UNAVAILABLE';
    return {
      entered: false,
      response: jsonError(
        errorCode,
        admission.reason === 'security_unavailable' ? 503 : 429,
        cors,
        {
          'Retry-After': String(admission.retryAfterSeconds),
        }
      ),
    };
  }

  return {
    entered: true,
    cors,
    release: admission.release,
  };
}

function guardError(
  outcome: { ok: false; status: number; errorCode: RequestGuardErrorCode },
  cors: DocumentCorsDecision
): Response {
  return jsonError(outcome.errorCode, outcome.status, cors);
}

function configuration(
  dependencies: CommonHandlerDependencies,
  cors: DocumentCorsDecision
):
  | { ok: true; apiKey: string; model: SupportedGeminiModel }
  | { ok: false; response: Response } {
  const apiKey = dependencies.getApiKey()?.trim();
  if (!apiKey) {
    return {
      ok: false,
      response: jsonError('AI_CONFIGURATION_UNAVAILABLE', 503, cors),
    };
  }

  const model = dependencies.getModelConfiguration();
  if (!model.ok) {
    const failure = geminiModelConfigurationFailure(model.errorCode);
    return {
      ok: false,
      response: jsonResponse(failure.body, failure.status, cors),
    };
  }
  return { ok: true, apiKey, model: model.model };
}

function providerError(
  outcome: Extract<
    GeminiOperationOutcome<unknown>,
    { ok: false }
  >,
  cors: DocumentCorsDecision
): Response {
  const failure = geminiProviderFailure(outcome.errorCode);
  return jsonResponse(failure.body, failure.status, cors);
}

async function creditBalancePayload(
  guard: AiCreditGuard | undefined,
  installationId: string
) {
  if (!guard) return {};
  return { aiCreditsRemaining: await guard.getBalance(installationId) };
}

type ExecuteSuccess<T> = {
  ok: true;
  value: T;
  usage?: GeminiTokenUsage;
  passTokenUsage?: PdfPassTokenUsage;
};

function maybeLogTokenUsage(report: GeminiTokenUsageReport | undefined): void {
  if (!report) return;
  // Numbers-only diagnostic; gated off only when explicitly disabled.
  const disabled =
    (typeof process !== 'undefined' &&
      process.env?.AI_TOKEN_METERING_LOG === '0') ||
    (globalThis as { Deno?: { env: { get(name: string): string | undefined } } })
      .Deno?.env.get('AI_TOKEN_METERING_LOG') === '0';
  if (disabled) return;
  edgeLogger.info('GEMINI_TOKEN_USAGE', {
    status: 'completed',
    stage: 'provider',
    pageCount: report.pageCount,
    promptTokens: report.promptTokenCount ?? 0,
    outputTokens: report.candidatesTokenCount ?? 0,
    totalTokens: report.totalTokenCount ?? 0,
    creditsCharged: report.creditsCharged,
    operationType: report.operationType,
    model: report.model as SupportedGeminiModel,
  });
}

function providerTokenUsagePayload(
  model: SupportedGeminiModel,
  operationType: GeminiMeterOperationType,
  pageCount: number,
  usage: GeminiTokenUsage | undefined,
  passTokenUsage: PdfPassTokenUsage | undefined
): { providerTokenUsage: ReturnType<typeof toSafeTokenUsageDiagnostic> } | Record<string, never> {
  const calls: GeminiTokenUsageCallReport[] = [];
  if (passTokenUsage) {
    if (passTokenUsage.summary) {
      calls.push({ callType: 'pdf_summary', ...passTokenUsage.summary });
    }
    if (passTokenUsage.items) {
      calls.push({ callType: 'pdf_items', ...passTokenUsage.items });
    }
  } else if (usage) {
    const callType =
      operationType === 'business_card_ai'
        ? 'card_structure'
        : 'document_extract';
    calls.push({ callType, ...usage });
  }
  if (calls.length === 0 && !usage) return {};

  const creditsCharged = creditsForOperation(operationType, undefined, pageCount);
  const report = buildGeminiTokenUsageReport({
    model,
    operationType,
    pageCount,
    creditsCharged,
    calls:
      calls.length > 0
        ? calls
        : usage
          ? [{ callType: 'pdf_aggregate', ...usage }]
          : [],
  });
  maybeLogTokenUsage(report);
  return { providerTokenUsage: toSafeTokenUsageDiagnostic(report) };
}

async function runWithCommercialCredits<T>(
  dependencies: CommonHandlerDependencies,
  body: Record<string, unknown>,
  defaultOperationType: 'document_page_ai' | 'pdf_page_ai' | 'business_card_ai',
  cors: DocumentCorsDecision,
  execute: () => Promise<
    | ExecuteSuccess<T>
    | { ok: false; providerError: Extract<GeminiOperationOutcome<unknown>, { ok: false }> }
    | { ok: false; validationError: true }
  >
): Promise<
  | Response
  | {
      ok: true;
      value: T;
      installationId: string;
      usage?: GeminiTokenUsage;
      passTokenUsage?: PdfPassTokenUsage;
      pageCount: number;
      operationType: GeminiMeterOperationType;
    }
> {
  const guard = dependencies.creditGuard;
  if (!guard) {
    const outcome = await execute();
    if (!outcome.ok) {
      if ('validationError' in outcome) {
        return jsonError('AI_PROVIDER_RESPONSE_INVALID', 502, cors);
      }
      return providerError(outcome.providerError, cors);
    }
    return {
      ok: true,
      value: outcome.value,
      installationId: '',
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      ...(outcome.passTokenUsage !== undefined
        ? { passTokenUsage: outcome.passTokenUsage }
        : {}),
      pageCount: 1,
      operationType: defaultOperationType,
    };
  }

  const ctx = parseAiCreditContext(body, defaultOperationType);
  if (!ctx) {
    return jsonError('INVALID_REQUEST', 400, cors);
  }

  if (dependencies.assertCommercialAccess) {
    const commerciallyActive = await dependencies.assertCommercialAccess(
      ctx.installationId,
      ctx.licenseId ?? null
    );
    if (!commerciallyActive) {
      return jsonError('LICENSE_INACTIVE', 403, cors);
    }
  }

  await dependencies.ensureCreditGrant?.(ctx.installationId, ctx.licenseId ?? null);

  let reservationId: string | null = null;
  try {
    const reservation = await guard.reserve({
      installationId: ctx.installationId,
      licenseId: ctx.licenseId,
      operationId: ctx.operationId,
      operationType: ctx.operationType,
      pageCount: ctx.pageCount,
    });
    reservationId = reservation.reservationId;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'insufficient_credits') {
      return jsonResponse(
        {
          error: ERROR_MESSAGES.AI_CREDITS_INSUFFICIENT,
          errorCode: 'AI_CREDITS_INSUFFICIENT',
          ...(await creditBalancePayload(guard, ctx.installationId)),
        },
        402,
        cors
      );
    }
    if (message === 'duplicate_operation') {
      return jsonResponse(
        {
          ...(await creditBalancePayload(guard, ctx.installationId)),
          idempotentReplay: true,
        },
        200,
        cors
      );
    }
    return jsonError('AI_CREDITS_UNAVAILABLE', 503, cors);
  }

  const outcome = await execute();
  if (!outcome.ok) {
    await guard.commitAfterProvider(
      reservationId,
      'validationError' in outcome ? 'validation_error' : 'provider_error'
    );
    if ('validationError' in outcome) {
      return jsonError('AI_PROVIDER_RESPONSE_INVALID', 502, cors);
    }
    return providerError(outcome.providerError, cors);
  }

  await guard.commitAfterProvider(reservationId, 'success');
  return {
    ok: true,
    value: outcome.value,
    installationId: ctx.installationId,
    ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    ...(outcome.passTokenUsage !== undefined
      ? { passTokenUsage: outcome.passTokenUsage }
      : {}),
    pageCount: ctx.pageCount ?? 1,
    operationType: ctx.operationType as GeminiMeterOperationType,
  };
}

function validPageMetadata(body: Record<string, unknown>): boolean {
  const pageCount = body.pageCount ?? 1;
  const pageIndex = body.pageIndex ?? 0;
  return (
    Number.isInteger(pageCount) &&
    (pageCount as number) >= 1 &&
    (pageCount as number) <= MAX_PDF_PAGES &&
    Number.isInteger(pageIndex) &&
    (pageIndex as number) >= 0 &&
    (pageIndex as number) < (pageCount as number)
  );
}

function forceStructuredPageIndex(value: unknown, pageIndex: number): unknown {
  if (Array.isArray(value)) return value.map((entry) => forceStructuredPageIndex(entry, pageIndex));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const mapped = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, forceStructuredPageIndex(entry, pageIndex)])
  );
  return 'pageIndex' in record || 'evidenceText' in record
    ? { ...mapped, pageIndex }
    : mapped;
}

export function createParseDocumentHandler(
  dependencies: ParseDocumentHandlerDependencies
): DocumentEdgeHandler {
  const extract = dependencies.extract ?? extractWithGemini;

  return async (request) => {
    const entered = await enterRequest(request, dependencies);
    if (!entered.entered) return entered.response;

    const { cors, release } = entered;
    try {
      const payload = await readBoundedJsonObject(
        request,
        MAX_IMAGE_REQUEST_BYTES
      );
      if (!payload.ok) return guardError(payload, cors);

      const body = payload.value;
      const allowedKeys = [
          'imageBase64',
          'mimeType',
          'kind',
          'pageIndex',
          'pageCount',
          'installationId',
          'deviceId',
          'operationId',
          'operationType',
          'licenseId',
        ];
      if (
        !hasOnlyKeys(body, allowedKeys) ||
        !isImageMimeType(body.mimeType) ||
        (body.kind !== undefined &&
          body.kind !== 'document' &&
          body.kind !== 'business_card') ||
        !validPageMetadata(body)
      ) {
        return jsonError(
          isImageMimeType(body.mimeType)
            ? 'INVALID_REQUEST'
            : 'UNSUPPORTED_MIME_TYPE',
          isImageMimeType(body.mimeType) ? 400 : 415,
          cors
        );
      }

      const decoded = decodeStrictBase64(body.imageBase64, MAX_IMAGE_BYTES);
      if (!decoded.ok) return guardError(decoded, cors);
      if (!isStructurallyValidImage(decoded.value, body.mimeType)) {
        return jsonError('MEDIA_SIGNATURE_MISMATCH', 400, cors);
      }

      const configured = configuration(dependencies, cors);
      if (!configured.ok) return configured.response;

      const prompt =
        body.kind === 'business_card'
          ? CARD_EXTRACT_PROMPT
          : EXTRACT_PROMPT;
      const mimeType = body.mimeType as string;
      const pageIndex = (body.pageIndex ?? 0) as number;
      const pageCount = (body.pageCount ?? 1) as number;

      const creditOutcome = await runWithCommercialCredits(
        dependencies,
        body,
        'document_page_ai',
        cors,
        async () => {
          const outcome = await extract(
            [
              { text: prompt },
              {
                text: `Pagina ${pageIndex + 1} di ${pageCount}. Per ogni evidenza structured usa pageIndex=${pageIndex}.`,
              },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: body.imageBase64 as string,
                },
              },
            ],
            configured.apiKey,
            configured.model,
            { timeoutMs: DOCUMENT_GEMINI_TIMEOUT_MS }
          );
          if (!outcome.ok) return { ok: false as const, providerError: outcome };
          const responseValue = outcome.value.structured
            ? {
                ...outcome.value,
                structured: forceStructuredPageIndex(outcome.value.structured, pageIndex),
              }
            : outcome.value;
          return {
            ok: true as const,
            value: responseValue,
            ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
          };
        }
      );

      if (creditOutcome instanceof Response) return creditOutcome;
      return jsonResponse(
        {
          ...creditOutcome.value,
          ...providerTokenUsagePayload(
            configured.model,
            creditOutcome.operationType,
            creditOutcome.pageCount,
            creditOutcome.usage,
            creditOutcome.passTokenUsage
          ),
          ...(await creditBalancePayload(
            dependencies.creditGuard,
            creditOutcome.installationId
          )),
        },
        200,
        cors
      );
    } catch {
      edgeLogger.error('DOCUMENT_PARSE_FAILED', {
        status: 'failed',
        stage: 'parse',
      });
      return jsonError('DOCUMENT_PARSE_FAILED', 500, cors);
    } finally {
      await release();
    }
  };
}

export function createParsePdfHandler(
  dependencies: ParsePdfHandlerDependencies
): DocumentEdgeHandler {
  const extractPdf = dependencies.extractPdf ?? extractPdfWithGemini;

  return async (request) => {
    const entered = await enterRequest(request, dependencies);
    if (!entered.entered) return entered.response;

    const { cors, release } = entered;
    try {
      const payload = await readBoundedJsonObject(
        request,
        MAX_PDF_REQUEST_BYTES
      );
      if (!payload.ok) return guardError(payload, cors);

      const body = payload.value;
      if (
        !        hasOnlyKeys(body, [
          'pdfBase64',
          'mimeType',
          'installationId',
          'deviceId',
          'operationId',
          'operationType',
          'licenseId',
          'pageCount',
          'documentType',
        ]) ||
        body.mimeType !== 'application/pdf'
      ) {
        return jsonError(
          body.mimeType === 'application/pdf'
            ? 'INVALID_REQUEST'
            : 'UNSUPPORTED_MIME_TYPE',
          body.mimeType === 'application/pdf' ? 400 : 415,
          cors
        );
      }

      const decoded = decodeStrictBase64(body.pdfBase64, MAX_PDF_BYTES);
      if (!decoded.ok) return guardError(decoded, cors);
      const pageCount = await validatePdfPageCount(
        decoded.value,
        dependencies.countPdfPages
      );
      if (!pageCount.ok) return guardError(pageCount, cors);

      const configured = configuration(dependencies, cors);
      if (!configured.ok) return configured.response;

      // Il conteggio reale del PDF governa i crediti: non si usa il default client.
      const creditOutcome = await runWithCommercialCredits(
        dependencies,
        { ...body, pageCount: pageCount.value },
        'pdf_page_ai',
        cors,
        async () => {
          const expectedType = pdfExpectedDocumentType(body.documentType);
          const outcome = await extractPdf(
            body.pdfBase64 as string,
            configured.apiKey,
            configured.model,
            {
              ...(expectedType !== undefined ? { expectedType } : {}),
              timeoutMs: PDF_GEMINI_TIMEOUT_MS,
            }
          );
          if (!outcome.ok) return { ok: false as const, providerError: outcome };
          return {
            ok: true as const,
            value: outcome.value,
            ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
            ...(outcome.value.passTokenUsage !== undefined
              ? { passTokenUsage: outcome.value.passTokenUsage }
              : {}),
          };
        }
      );

      if (creditOutcome instanceof Response) return creditOutcome;
      const {
        extract: pdfExtract,
        timings,
        itemsPassFailed,
        itemsPassDiagnostics,
      } = creditOutcome.value;
      return jsonResponse(
        {
          ...pdfExtract,
          providerTimings: timings,
          ...(itemsPassFailed ? { itemsPassFailed: true } : {}),
          ...(itemsPassDiagnostics
            ? { itemsPassDiagnostics }
            : {}),
          ...providerTokenUsagePayload(
            configured.model,
            creditOutcome.operationType,
            pageCount.value,
            creditOutcome.usage,
            creditOutcome.passTokenUsage
          ),
          ...(await creditBalancePayload(
            dependencies.creditGuard,
            creditOutcome.installationId
          )),
        },
        200,
        cors
      );
    } catch {
      edgeLogger.error('PDF_PARSE_FAILED', {
        status: 'failed',
        stage: 'parse',
      });
      return jsonError('PDF_PARSE_FAILED', 500, cors);
    } finally {
      await release();
    }
  };
}

export function createStructureCardHandler(
  dependencies: StructureCardHandlerDependencies
): DocumentEdgeHandler {
  const structure =
    dependencies.structure ?? structureCardWithGeminiVerbose;

  return async (request) => {
    const entered = await enterRequest(request, dependencies);
    if (!entered.entered) return entered.response;

    const { cors, release } = entered;
    try {
      const payload = await readBoundedJsonObject(
        request,
        MAX_CARD_REQUEST_BYTES
      );
      if (!payload.ok) return guardError(payload, cors);

      const body = payload.value;
      if (
        !hasOnlyKeys(body, [
          'ocrText',
          'installationId',
          'deviceId',
          'operationId',
          'operationType',
          'licenseId',
        ]) ||
        typeof body.ocrText !== 'string' ||
        body.ocrText.trim().length === 0 ||
        body.ocrText.length > MAX_CARD_OCR_CHARS
      ) {
        return jsonError('INVALID_REQUEST', 400, cors);
      }

      const ocrText = body.ocrText as string;

      const configured = configuration(dependencies, cors);
      if (!configured.ok) return configured.response;
      if (!(await dependencies.isWithinDailyQuota())) {
        return jsonError('AI_QUOTA_EXCEEDED', 429, cors);
      }

      const creditOutcome = await runWithCommercialCredits(
        dependencies,
        body,
        'business_card_ai',
        cors,
        async () => {
          const outcome = await structure(
            ocrText.trim(),
            configured.apiKey,
            configured.model
          );
          if (!outcome.ok) {
            edgeLogger.error('CARD_STRUCTURE_PROVIDER_FAILED', {
              status: 'failed',
              stage: 'provider',
              reasonCode:
                outcome.errorCode === 'AI_PROVIDER_RESPONSE_INVALID'
                  ? 'response_invalid'
                  : 'provider_rejected',
            });
            return { ok: false as const, providerError: outcome };
          }
          return {
            ok: true as const,
            value: outcome.value,
            ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
          };
        }
      );

      if (creditOutcome instanceof Response) return creditOutcome;
      return jsonResponse(
        {
          ...creditOutcome.value,
          ...providerTokenUsagePayload(
            configured.model,
            creditOutcome.operationType,
            creditOutcome.pageCount,
            creditOutcome.usage,
            creditOutcome.passTokenUsage
          ),
          ...(await creditBalancePayload(
            dependencies.creditGuard,
            creditOutcome.installationId
          )),
        },
        200,
        cors
      );
    } catch {
      edgeLogger.error('CARD_STRUCTURE_FAILED', {
        status: 'failed',
        stage: 'parse',
      });
      return jsonError('CARD_STRUCTURE_FAILED', 500, cors);
    } finally {
      await release();
    }
  };
}

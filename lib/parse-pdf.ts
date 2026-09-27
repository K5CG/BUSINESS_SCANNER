import { isSupabaseConfigured } from './config';
import {
  normalizeGeminiDocumentExtract,
  type GeminiDocumentExtract,
} from './gemini-document-extract';
import { callSupabaseFunction } from './supabase-functions';
import { runtimeLogger } from './safe-runtime-logger';
import {
  aiContextPayload,
  buildAiRequestContext,
  clearPendingOperation,
} from './ai-credit/operation-context';
import { RC_PDF_IMPORT_ALLOWED } from './release-rc-policy';
import { isQaLogEnabled } from './release-diagnostics';
import type { DocumentType } from '../types';
import { expectedGeminiDocumentType } from './pdf-document-type';

export { isSupabaseConfigured as isSupabasePdfConfigured };

/**
 * Canale di collaudo indipendente da `__DEV__`.
 *
 * Il bundle QA nasce con `--dev false`, quindi `runtimeLogger.debug` non emette
 * nulla proprio nella build su cui l'import PDF va verificato. Segue il flag di
 * abilitazione RC; l'emissione reale richiede anche `isQaLogEnabled()` così una
 * build store con PDF abilitato non spammi diagnostiche di staging.
 */
export const PDF_QA_DIAGNOSTICS = RC_PDF_IMPORT_ALLOWED;

function emitPdfQaDiagnostics(): boolean {
  return PDF_QA_DIAGNOSTICS && isQaLogEnabled();
}

/** Durate delle passate provider: numeri, così la traccia resta priva di testo. */
function numericTimings(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const timings = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  );
  return Object.keys(timings).length > 0 ? timings : null;
}

/**
 * Traccia temporanea della seconda passata: solo forma e conteggi, mai
 * descrizioni o importi. Serve a dimostrare dove spariscono le righe.
 */
function logItemsPassDiagnostics(operationId: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const diagnostics = value as Record<string, unknown>;
  const stages: Array<[string, unknown]> = [
    ['PROVIDER_RESPONSE', diagnostics.providerResponse],
    ['AFTER_PARSE', diagnostics.afterParse],
    ['AFTER_MERGE', diagnostics.afterMerge],
  ];
  for (const [stage, payload] of stages) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const line = {
      operationId,
      stage,
      ...(payload as Record<string, unknown>),
    };
    runtimeLogger.debug(
      'PDF_ITEMS_PASS_DIAGNOSTIC',
      { source: 'cloud', stage: 'network', status: 'active' },
      line
    );
    if (emitPdfQaDiagnostics()) {
      console.warn(`[PdfItemsPass] ${stage} ${JSON.stringify(line)}`);
    }
  }
}

export type PdfParseOutcome =
  | { status: 'ok'; extract: GeminiDocumentExtract; aiCreditsRemaining?: number }
  | { status: 'not_configured' }
  | { status: 'credits_exhausted' }
  | { status: 'error' };

/** Chiama Supabase Edge Function `parse-pdf` (stesso schema dell'app referti). */
export async function parsePdfWithSupabaseVerbose(
  pdfBase64: string,
  pageCount = 1,
  existingOperationId?: string,
  documentType?: DocumentType
): Promise<PdfParseOutcome> {
  if (!isSupabaseConfigured()) return { status: 'not_configured' };

  const ctx = await buildAiRequestContext('pdf_page_ai', existingOperationId);

  // Traccia QA: solo identificativi e stato della chiamata, mai il contenuto
  // del PDF. Serve a collegare l'esito all'addebito `pdf_page_ai`.
  const logQa = (
    edgeStatus: number | string,
    success: boolean,
    aiCreditsRemaining?: number | null,
    providerTimings?: Record<string, number> | null
  ) => {
    const payload = {
      operationId: ctx.operationId,
      pageCount,
      edgeStatus,
      creditOperationType: ctx.operationType,
      success,
      aiCreditsRemaining: aiCreditsRemaining ?? null,
      ...(providerTimings ? { providerTimings } : {}),
    };
    runtimeLogger.debug(
      'PDF_QA_DIAGNOSTIC',
      { source: 'cloud', stage: 'network', status: success ? 'active' : 'failed' },
      payload
    );
    if (emitPdfQaDiagnostics()) console.warn(`[PdfQa] ${JSON.stringify(payload)}`);
  };

  try {
    const expectedType = expectedGeminiDocumentType(documentType);
    const response = await callSupabaseFunction<unknown>('parse-pdf', {
      pdfBase64,
      mimeType: 'application/pdf',
      pageCount,
      ...(expectedType ? { documentType: expectedType } : {}),
      ...aiContextPayload(ctx),
    });
    logQa(response.status, !response.error);

    if (response.errorCode === 'AI_CREDITS_INSUFFICIENT') {
      return { status: 'credits_exhausted' };
    }

    if (response.error) {
      runtimeLogger.warn(
        'PDF_CLOUD_REJECTED',
        new Error(response.error),
        {
          httpStatus:
            response.status >= 100 && response.status <= 599
              ? response.status
              : undefined,
          source: 'cloud',
          stage: 'network',
          status: 'rejected',
        }
      );
      return { status: 'error' };
    }

    const data = response.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { status: 'error' };
    const record = data as Record<string, unknown>;
    const extract = normalizeGeminiDocumentExtract({
      ...record,
      rawText: record.rawText ?? record.text,
    });
    if (!extract?.rawText.trim()) return { status: 'error' };

    clearPendingOperation(ctx.operationId);
    const remaining =
      typeof record.aiCreditsRemaining === 'number' ? record.aiCreditsRemaining : undefined;
    // Saldo dichiarato dal server dopo l'addebito: è l'unico riscontro che il
    // client può avere sull'operazione `pdf_page_ai`.
    logQa(
      response.status,
      true,
      remaining ?? null,
      numericTimings(record.providerTimings)
    );
    logItemsPassDiagnostics(ctx.operationId, record.itemsPassDiagnostics);
    return { status: 'ok', extract, aiCreditsRemaining: remaining };
  } catch (error) {
    logQa('exception', false);
    runtimeLogger.warn('PDF_CLOUD_FAILED', error, {
      source: 'cloud',
      stage: 'network',
      status: 'failed',
    });
    return { status: 'error' };
  }
}

export type PdfParseSuccess = {
  extract: GeminiDocumentExtract;
  aiCreditsRemaining?: number;
};

export async function parsePdfWithSupabase(
  pdfBase64: string,
  fileName = 'document.pdf',
  documentType?: DocumentType,
  /** Conteggio pagine reale già risolto dal chiamante (fonte unica client). */
  pageCount?: number
): Promise<PdfParseSuccess | null> {
  if (
    typeof pageCount !== 'number' ||
    !Number.isInteger(pageCount) ||
    pageCount < 1
  ) {
    // Mai inventare 1: senza conteggio affidabile la chiamata non parte.
    return null;
  }
  const outcome = await parsePdfWithSupabaseVerbose(
    pdfBase64,
    pageCount,
    undefined,
    documentType
  );
  void fileName;
  if (outcome.status !== 'ok') return null;
  return {
    extract: outcome.extract,
    aiCreditsRemaining: outcome.aiCreditsRemaining,
  };
}

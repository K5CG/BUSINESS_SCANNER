import { PDFDocument, ParseSpeeds } from 'pdf-lib';
import { MAX_CLOUD_DOCUMENT_PAGES } from './cloud-ai-limits';
import { RC_PDF_IMPORT_ALLOWED } from './release-rc-policy';
import { isQaLogEnabled } from './release-diagnostics';

/**
 * Conta le pagine dal page tree PDF, senza renderizzare né inviare il file al provider.
 * Allineato al contatore Edge (`supabase/functions/_shared/pdf-page-count.ts`).
 */
export const PDF_PAGE_COUNT_METHOD = 'pdf-lib';

export type PdfPageCountErrorCode = 'PDF_INVALID' | 'PDF_PAGE_LIMIT_EXCEEDED';

export type PdfPageCountResult =
  | {
      ok: true;
      pageCount: number;
      method: typeof PDF_PAGE_COUNT_METHOD;
      errorCode: null;
    }
  | {
      ok: false;
      pageCount: null;
      method: typeof PDF_PAGE_COUNT_METHOD;
      errorCode: PdfPageCountErrorCode;
    };

export const PDF_PAGE_COUNT_DIAGNOSTICS = RC_PDF_IMPORT_ALLOWED;

function emitPdfPageCountDiagnostics(): boolean {
  return PDF_PAGE_COUNT_DIAGNOSTICS && isQaLogEnabled();
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function logPdfPageCount(result: {
  success: boolean;
  pageCount: number | null;
  method: string;
  errorCode: string | null;
}): void {
  if (!emitPdfPageCountDiagnostics()) return;
  console.warn(`[PdfPageCount] ${JSON.stringify(result)}`);
}

/**
 * Fonte unica del conteggio pagine PDF lato client: valida minimo 1 e il
 * massimo già usato dal cloud (`MAX_CLOUD_DOCUMENT_PAGES`).
 */
export async function resolvePdfPageCount(
  pdfBase64: string,
  maxPages: number = MAX_CLOUD_DOCUMENT_PAGES
): Promise<PdfPageCountResult> {
  try {
    const bytes = base64ToUint8Array(pdfBase64);
    const document = await PDFDocument.load(bytes, {
      capNumbers: true,
      ignoreEncryption: false,
      parseSpeed: ParseSpeeds.Fastest,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    const pageCount = document.getPageCount();
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      const failed = {
        ok: false as const,
        pageCount: null,
        method: PDF_PAGE_COUNT_METHOD as typeof PDF_PAGE_COUNT_METHOD,
        errorCode: 'PDF_INVALID' as const,
      };
      logPdfPageCount({
        success: false,
        pageCount: null,
        method: failed.method,
        errorCode: failed.errorCode,
      });
      return failed;
    }
    if (pageCount > maxPages) {
      const failed = {
        ok: false as const,
        pageCount: null,
        method: PDF_PAGE_COUNT_METHOD as typeof PDF_PAGE_COUNT_METHOD,
        errorCode: 'PDF_PAGE_LIMIT_EXCEEDED' as const,
      };
      logPdfPageCount({
        success: false,
        pageCount: null,
        method: failed.method,
        errorCode: failed.errorCode,
      });
      return failed;
    }
    const ok = {
      ok: true as const,
      pageCount,
      method: PDF_PAGE_COUNT_METHOD as typeof PDF_PAGE_COUNT_METHOD,
      errorCode: null,
    };
    logPdfPageCount({
      success: true,
      pageCount,
      method: ok.method,
      errorCode: null,
    });
    return ok;
  } catch {
    const failed = {
      ok: false as const,
      pageCount: null,
      method: PDF_PAGE_COUNT_METHOD as typeof PDF_PAGE_COUNT_METHOD,
      errorCode: 'PDF_INVALID' as const,
    };
    logPdfPageCount({
      success: false,
      pageCount: null,
      method: failed.method,
      errorCode: failed.errorCode,
    });
    return failed;
  }
}

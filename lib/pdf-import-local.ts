import { MAX_CLOUD_PDF_BYTES } from './cloud-ai-limits';
import { RC_PDF_IMPORT_ALLOWED } from './release-rc-policy';
import { isQaLogEnabled } from './release-diagnostics';
import { runtimeLogger } from './safe-runtime-logger';

/**
 * Traccia dell'acquisizione locale del PDF, indipendente da `__DEV__`.
 *
 * Il primo collaudo su dispositivo è fallito prima della chiamata al servizio e
 * senza lasciare tracce: la diagnostica cominciava troppo tardi. Segue il flag
 * dell'import PDF; l'emissione richiede anche `isQaLogEnabled()`.
 */
export const PDF_LOCAL_DIAGNOSTICS = RC_PDF_IMPORT_ALLOWED;

function emitPdfLocalDiagnostics(): boolean {
  return PDF_LOCAL_DIAGNOSTICS && isQaLogEnabled();
}

export type PdfImportErrorCode =
  | 'PDF_FILE_NOT_READABLE'
  | 'PDF_TOO_LARGE'
  | 'PDF_INVALID'
  | 'PDF_PAGE_LIMIT_EXCEEDED'
  | 'PDF_UPLOAD_FAILED';

/** Passi dell'acquisizione locale, nell'ordine in cui devono comparire. */
export type PdfLocalStage =
  | 'picker_result'
  | 'asset_received'
  | 'uri_normalization'
  | 'file_stat'
  | 'local_copy_start'
  | 'local_copy_ok'
  | 'read_start'
  | 'read_ok'
  | 'payload_ready'
  | 'edge_call_start'
  | 'edge_call_result'
  | 'structured_parity';

export type PdfUriScheme = 'file' | 'content' | 'other';

export interface PickedPdfAsset {
  uri?: string | null;
  name?: string | null;
  mimeType?: string | null;
  size?: number | null;
}

export interface PdfLocalLogFields {
  uriScheme?: PdfUriScheme;
  mimeType?: string | null;
  displayName?: string | null;
  fileSize?: number | null;
  localName?: string | null;
  copied?: boolean;
  canceled?: boolean;
  assetCount?: number;
  base64Length?: number;
  pageCount?: number;
  exists?: boolean;
  success?: boolean;
  aiCreditsRemaining?: number | null;
  errorName?: string;
  errorCode?: string;
  errorMessage?: string;
  structuredPages?: number;
  itemCount?: number;
  complete?: boolean;
  requiresReview?: boolean;
  requiresRescan?: boolean;
}

export function readUriScheme(uri: string | null | undefined): PdfUriScheme {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri ?? '')?.[1]?.toLowerCase();
  if (scheme === 'file') return 'file';
  if (scheme === 'content') return 'content';
  return 'other';
}

/**
 * Nome mostrabile nei log: solo l'ultimo segmento, senza cartelle né query, così
 * la traccia non rivela percorsi dell'utente.
 */
export function basenameOf(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const withoutQuery = uri.split(/[?#]/)[0];
  const segment = withoutQuery.split('/').pop() ?? '';
  let readable = segment;
  try {
    readable = decodeURIComponent(segment);
  } catch {
    // Un segmento con percentuali non valide resta com'è: serve solo al log.
  }
  const safe = readable.replace(/[^\w.\- ]+/g, '_').trim();
  return safe.length > 60 ? `${safe.slice(0, 57)}...` : safe || null;
}

/**
 * Un PDF scelto su Android può arrivare senza `mimeType`: l'estensione resta un
 * riscontro valido e rifiutarlo per il solo tipo mancante bloccherebbe file
 * legittimi.
 */
export function looksLikePdf(asset: PickedPdfAsset): boolean {
  const mime = asset.mimeType?.toLowerCase().split(';')[0]?.trim();
  if (mime === 'application/pdf') return true;
  if (mime && mime !== 'application/octet-stream') return false;
  return /\.pdf$/i.test(asset.name ?? basenameOf(asset.uri) ?? '');
}

export function validatePickedPdf(
  asset: PickedPdfAsset
): { ok: true; name: string } | { ok: false; code: PdfImportErrorCode } {
  if (!asset.uri) return { ok: false, code: 'PDF_FILE_NOT_READABLE' };
  if (!looksLikePdf(asset)) return { ok: false, code: 'PDF_INVALID' };
  if (typeof asset.size === 'number' && asset.size > MAX_CLOUD_PDF_BYTES) {
    return { ok: false, code: 'PDF_TOO_LARGE' };
  }
  return { ok: true, name: asset.name?.trim() || basenameOf(asset.uri) || 'document.pdf' };
}

export function classifyLocalReadError(error: unknown): PdfImportErrorCode {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('PDF_TOO_LARGE')) return 'PDF_TOO_LARGE';
  return 'PDF_FILE_NOT_READABLE';
}

const ERROR_MESSAGE_KEYS: Record<PdfImportErrorCode, string> = {
  PDF_FILE_NOT_READABLE: 'pdfErrorNotReadable',
  PDF_TOO_LARGE: 'pdfErrorTooLarge',
  PDF_INVALID: 'pdfErrorInvalid',
  PDF_PAGE_LIMIT_EXCEEDED: 'pdfErrorPageLimit',
  PDF_UPLOAD_FAILED: 'pdfErrorUploadFailed',
};

export function pdfErrorMessageKey(code: PdfImportErrorCode): string {
  return ERROR_MESSAGE_KEYS[code];
}

/** Messaggio tecnico ripulito: niente percorsi, niente contenuto del file. */
export function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const withoutUris = raw.replace(/(file|content):\/\/\S+/gi, '<uri>');
  return withoutUris.length > 120 ? `${withoutUris.slice(0, 117)}...` : withoutUris;
}

export function logPdfLocal(stage: PdfLocalStage, fields: PdfLocalLogFields = {}): void {
  const payload = { stage, ...fields };
  runtimeLogger.debug(
    'PDF_LOCAL_DIAGNOSTIC',
    {
      source: 'filesystem',
      stage: 'read',
      status: fields.errorCode || fields.success === false ? 'failed' : 'active',
    },
    payload
  );
  if (emitPdfLocalDiagnostics()) console.warn(`[PdfLocal] ${JSON.stringify(payload)}`);
}

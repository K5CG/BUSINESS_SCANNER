import * as DocumentPicker from 'expo-document-picker';
import { parsePdfWithSupabase } from './parse-pdf';
import { buildDocumentFromExtract } from './document-from-extract';
import { applyPdfStructuredParity } from './pdf-structured-parity';
import { documentStageSnapshot, geminiStageSnapshot, logPdfStage } from './pdf-stage-trace';
import { createPdfImportProgressReporter } from './pdf-import-progress';
import { hardenPdfExtract } from './pdf-party-subject';
import { withAiStructuredExtraction } from './pdf-ai-authority';
import { resolvePdfPageCount } from './pdf-page-count';
import type { DocumentProcessProgressListener } from './document-process-progress';
import type { GeminiDocumentExtract } from './gemini-document-extract';
import type { AnyDocument, DocumentType } from '../types';
import { cleanupTemporaryPdfUri } from './temporary-image-cleanup';
import { MAX_CLOUD_PDF_BYTES } from './cloud-ai-limits';
import {
  basenameOf,
  classifyLocalReadError,
  logPdfLocal,
  readUriScheme,
  sanitizeErrorMessage,
  validatePickedPdf,
  type PdfImportErrorCode,
} from './pdf-import-local';

interface LocalPdfPayload {
  base64: string;
  localUri: string;
  copied: boolean;
  fileSize: number | null;
}

/**
 * Il selettore Android restituisce normalmente una copia in cache (`file://`),
 * ma con `copyToCacheDirectory` disattivato o su alcuni fornitori arriva un
 * `content://` del Storage Access Framework, che non è un percorso del file
 * system. In quel caso il file va prima portato in una cartella dell'app.
 */
async function copySelectionToCache(uri: string): Promise<string> {
  const { File, Paths } = await import('expo-file-system');
  const target = new File(Paths.cache, `pdf-import-${Date.now()}.pdf`);
  new File(uri).copy(target);
  return target.uri;
}

/**
 * La conversione in base64 è affidata al modulo nativo: costruirla in JavaScript
 * byte per byte, come faceva la versione precedente, significa concatenare
 * milioni di stringhe per un PDF di pochi megabyte.
 */
async function readLocalPdf(
  uri: string,
  expectedSize: number | null,
  onStage?: (stage: 'read') => void
): Promise<LocalPdfPayload> {
  const { File } = await import('expo-file-system');

  const initialScheme = readUriScheme(uri);
  logPdfLocal('uri_normalization', { uriScheme: initialScheme, localName: basenameOf(uri) });

  let localUri = uri;
  let copied = false;
  if (initialScheme !== 'file') {
    logPdfLocal('local_copy_start', { uriScheme: initialScheme });
    localUri = await copySelectionToCache(uri);
    copied = true;
    logPdfLocal('local_copy_ok', { localName: basenameOf(localUri) });
  }

  const file = new File(localUri);
  const fileSize = typeof file.size === 'number' ? file.size : expectedSize;
  logPdfLocal('file_stat', {
    exists: file.exists,
    fileSize,
    localName: basenameOf(localUri),
    copied,
  });
  if (!file.exists) throw new Error('PDF_FILE_MISSING');
  if (typeof fileSize === 'number' && fileSize > MAX_CLOUD_PDF_BYTES) {
    throw new Error('PDF_TOO_LARGE');
  }

  logPdfLocal('read_start', { fileSize });
  const bytes = await file.bytes();
  if (bytes.byteLength > MAX_CLOUD_PDF_BYTES) {
    throw new Error('PDF_TOO_LARGE');
  }
  const base64 = await file.base64();
  logPdfLocal('read_ok', { base64Length: base64.length });
  onStage?.('read');
  if (!base64) throw new Error('PDF_EMPTY_PAYLOAD');

  return { base64, localUri, copied, fileSize: bytes.byteLength };
}

/**
 * Il documento importato nasceva senza gli artefatti strutturati che ogni
 * scatto produce, quindi restava fuori da completezza, revisione e riletture
 * successive. La seconda passata locale li aggiunge; se fallisce resta il
 * documento del servizio AI, che è già utilizzabile.
 */
async function withStructuredParity(
  document: AnyDocument,
  extract: GeminiDocumentExtract
): Promise<AnyDocument> {
  try {
    const enriched = await applyPdfStructuredParity(document, extract);
    const extraction = enriched.structuredExtraction;
    logPdfLocal('structured_parity', {
      success: Boolean(extraction),
      structuredPages: extraction?.pages.length ?? 0,
      itemCount: 'items' in enriched ? enriched.items.length : 0,
      complete: extraction?.complete,
      requiresReview: extraction?.requiresReview,
      requiresRescan: extraction?.requiresRescan,
    });
    logPdfStage('AFTER_STRUCTURED_PARITY', documentStageSnapshot(enriched));
    return enriched;
  } catch (error) {
    logPdfLocal('structured_parity', {
      success: false,
      errorName: error instanceof Error ? error.name : 'unknown',
      errorMessage: sanitizeErrorMessage(error),
    });
    logPdfStage('AFTER_STRUCTURED_PARITY', documentStageSnapshot(document));
    return document;
  }
}

export async function pickAndParsePdf(
  documentType: DocumentType,
  options?: { onProgress?: DocumentProcessProgressListener }
): Promise<{
  document: AnyDocument | null;
  errorCode: PdfImportErrorCode | null;
  /** Authoritative Edge balance after a successful charge; omit on failure. */
  aiCreditsRemaining?: number;
}> {
  const progress = createPdfImportProgressReporter(options?.onProgress);
  if (documentType === 'business_card') {
    return { document: null, errorCode: 'PDF_INVALID' };
  }

  const picked = await DocumentPicker.getDocumentAsync({
    type: 'application/pdf',
    copyToCacheDirectory: true,
    multiple: false,
  });
  logPdfLocal('picker_result', {
    canceled: picked.canceled,
    assetCount: picked.assets?.length ?? 0,
  });

  if (picked.canceled || !picked.assets?.[0]?.uri) {
    progress.dispose();
    return { document: null, errorCode: null };
  }

  const asset = picked.assets[0];
  logPdfLocal('asset_received', {
    uriScheme: readUriScheme(asset.uri),
    mimeType: asset.mimeType ?? null,
    displayName: asset.name ?? null,
    fileSize: asset.size ?? null,
  });

  const validation = validatePickedPdf(asset);
  if (!validation.ok) {
    logPdfLocal('asset_received', { errorCode: validation.code, success: false });
    progress.dispose();
    return { document: null, errorCode: validation.code };
  }

  progress.stage('prepare');

  let payload: LocalPdfPayload | undefined;
  try {
    payload = await readLocalPdf(asset.uri, asset.size ?? null, progress.stage);
  } catch (error) {
    const errorCode = classifyLocalReadError(error);
    logPdfLocal('read_ok', {
      success: false,
      errorCode,
      errorName: error instanceof Error ? error.name : 'unknown',
      errorMessage: sanitizeErrorMessage(error),
    });
    progress.dispose();
    await cleanupTemporaryPdfUri(asset.uri).catch(() => undefined);
    return { document: null, errorCode };
  }

  try {
    logPdfLocal('payload_ready', {
      base64Length: payload.base64.length,
      fileSize: payload.fileSize,
      copied: payload.copied,
    });
    progress.stage('payload');
    // Fonte unica: conteggio reale prima di crediti / Edge (mai default silenzioso a 1).
    const pdfPageCount = await resolvePdfPageCount(payload.base64);
    if (!pdfPageCount.ok) {
      progress.dispose();
      return { document: null, errorCode: pdfPageCount.errorCode };
    }
    logPdfLocal('edge_call_start', {
      displayName: validation.name,
      pageCount: pdfPageCount.pageCount,
    });
    // 35% + interpolazione UX fino a 78 finché il provider non risponde.
    progress.stage('upload');
    const provided = await parsePdfWithSupabase(
      payload.base64,
      validation.name,
      documentType,
      pdfPageCount.pageCount
    );
    const extractPayload = provided?.extract ?? null;
    logPdfLocal('edge_call_result', {
      success: Boolean(extractPayload?.rawText.trim()),
      aiCreditsRemaining:
        typeof provided?.aiCreditsRemaining === 'number'
          ? provided.aiCreditsRemaining
          : null,
    });

    if (!extractPayload?.rawText.trim()) {
      progress.stopAiWait();
      return { document: null, errorCode: 'PDF_UPLOAD_FAILED' };
    }

    // Solo dopo la risposta reale del servizio si può salire a 80.
    progress.stage('extract');
    // Prima fotografia: quello che il servizio AI ha restituito, senza aiuti locali.
    logPdfStage('GEMINI_PROVIDER_NORMALIZED', geminiStageSnapshot(extractPayload));
    const extract = hardenPdfExtract(extractPayload);
    logPdfStage('AFTER_PDF_HARDENING', geminiStageSnapshot(extract));
    const built = withAiStructuredExtraction(
      buildDocumentFromExtract(documentType, extract),
      extract
    );
    logPdfStage('AFTER_BUILD_DOCUMENT', documentStageSnapshot(built));

    const document = await withStructuredParity(built, extract);
    progress.stage('verify');
    return {
      document,
      errorCode: null,
      ...(typeof provided?.aiCreditsRemaining === 'number'
        ? { aiCreditsRemaining: provided.aiCreditsRemaining }
        : {}),
    };
  } catch (error) {
    progress.stopAiWait();
    logPdfLocal('edge_call_result', {
      success: false,
      errorName: error instanceof Error ? error.name : 'unknown',
      errorMessage: sanitizeErrorMessage(error),
    });
    return { document: null, errorCode: 'PDF_UPLOAD_FAILED' };
  } finally {
    progress.dispose();
    // Il selettore crea una copia in cache solo per la lettura immediata: il PDF
    // non fa parte del documento salvato e va rimosso, insieme alla nostra copia.
    await cleanupTemporaryPdfUri(asset.uri).catch(() => undefined);
    if (payload?.copied && payload.localUri !== asset.uri) {
      await cleanupTemporaryPdfUri(payload.localUri).catch(() => undefined);
    }
  }
}

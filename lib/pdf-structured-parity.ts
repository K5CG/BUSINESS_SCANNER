import type { AnyDocument, OcrLine } from '../types';
import type { DocumentLayoutPageInput } from './document-layout';
import type { GeminiDocumentExtract } from './gemini-document-extract';
import type { StructuredDocumentExtraction } from './document-structure';
import {
  applyStructuredExtractionToDocument,
  extractStructuredDocumentAsync,
  shouldSkipStructuredCanonicalApply,
} from './document-structured-extraction';
import { withAiAuthority } from './pdf-ai-authority';

/**
 * Motivi che descrivono ciò che l'inquadratura non ha mostrato del foglio.
 * Un PDF non ha inquadratura: tenerli significherebbe chiedere all'utente di
 * riscansionare qualcosa che non si può riscansionare.
 */
const CAMERA_FRAMING_REASONS = new Set([
  'page_starts_below_expected_top',
  'only_lower_document_section_visible',
  'essential_sections_not_visible',
]);

/** Registra che le zone provengono dal solo testo, senza coordinate. */
export const PDF_TEXT_ONLY_REASON = 'pdf_text_only_layout';

/**
 * Il testo restituito dal servizio non porta coordinate, quindi le righe restano
 * senza `boundingBox` e la pagina senza dimensioni: inventarle darebbe al parser
 * una geometria falsa, peggiore dell'assenza di geometria.
 */
export function pdfLayoutInputsFromRawText(rawText: string): DocumentLayoutPageInput[] {
  const lines: OcrLine[] = rawText
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text, confidence: 0.9 }));
  if (lines.length === 0) return [];
  return [
    {
      pageIndex: 0,
      lines,
      rawText: lines.map((line) => line.text).join('\n'),
    },
  ];
}

export function withoutCameraFramingSignals(
  extraction: StructuredDocumentExtraction
): StructuredDocumentExtraction {
  const pages = extraction.pages.map((page) => {
    const reasons = page.reasons.filter((reason) => !CAMERA_FRAMING_REASONS.has(reason));
    const complete = reasons.length === 0;
    return {
      ...page,
      reasons,
      status: complete ? ('complete' as const) : ('partial' as const),
      complete,
      requiresRescan: false,
    };
  });
  const reasons = extraction.reasons.filter(
    (reason) => !CAMERA_FRAMING_REASONS.has(reason.replace(/^page_\d+:/, ''))
  );
  const complete = pages.length > 0 && pages.every((page) => page.complete);
  return {
    ...extraction,
    pages,
    complete,
    requiresRescan: false,
    requiresReview: extraction.requiresReview || !complete,
    reasons: [...new Set([...reasons, PDF_TEXT_ONLY_REASON])],
  };
}

/**
 * Seconda passata locale sul documento già costruito dal servizio AI.
 *
 * Il servizio resta la fonte primaria: la modalità di merge predefinita scrive
 * soltanto dove il documento è vuoto, quindi campi, articoli e totali già
 * estratti non vengono mai sostituiti da una lettura locale più debole.
 */
export async function applyPdfStructuredParity(
  document: AnyDocument,
  extract: GeminiDocumentExtract,
  options?: { isActive?: () => boolean; layoutDeadlineMs?: number }
): Promise<AnyDocument> {
  if (document.type === 'business_card') return document;

  const inputs = pdfLayoutInputsFromRawText(extract.rawText);
  if (inputs.length === 0) return document;

  // La passata locale arricchisce: dove il servizio AI ha già letto un valore,
  // la lettura locale resta come alternativa e non prende il suo posto.
  const extraction = withAiAuthority(
    withoutCameraFramingSignals(
      await extractStructuredDocumentAsync(document.type, inputs, options)
    ),
    extract
  );
  if (shouldSkipStructuredCanonicalApply(extraction)) {
    return { ...document, structuredExtraction: extraction };
  }
  return applyStructuredExtractionToDocument(document, extraction);
}

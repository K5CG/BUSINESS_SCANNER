import type { GeminiDocumentExtract } from './gemini-ocr';
import {
  parseFreeDocument,
  parseOrderFromGemini,
  parseQuoteFromGemini,
  parseInvoiceFromGemini,
} from './document-parser';
import type { AnyDocument, DocumentType } from '../types';

export {
  applyDocumentFieldMerge,
  fieldMergeToGeminiExtract,
} from './document-field-merge-application';

export interface BuildDocumentFromExtractOptions {
  /**
   * Evita che il parser di compatibilità ricerchi nuovamente i campi nel
   * rawText multipagina dopo che il merge 2B ha già scelto i valori.
   */
  exactStructuredFields?: boolean;
}

export function buildDocumentFromExtract(
  documentType: DocumentType,
  extract: GeminiDocumentExtract,
  options?: BuildDocumentFromExtractOptions
): AnyDocument {
  switch (documentType) {
    case 'quote':
      return parseQuoteFromGemini(extract, {
        enrich: options?.exactStructuredFields !== true,
      });
    case 'order':
      return parseOrderFromGemini(extract, {
        enrich: options?.exactStructuredFields !== true,
      });
    case 'invoice':
      return parseInvoiceFromGemini(extract, {
        enrich: options?.exactStructuredFields !== true,
      });
    case 'free_document': {
      if (options?.exactStructuredFields === true) {
        const base = parseFreeDocument([], '', {
          source: 'cloud_ai',
        });
        return {
          ...base,
          title: extract.documentNumber
            ? `Documento ${extract.documentNumber}`
            : 'Documento libero',
          documentNumber: extract.documentNumber || undefined,
          documentDate: undefined,
          extractedFields: {},
          rawText: extract.rawText,
        };
      }
      return parseFreeDocument(
        [],
        extract.rawText,
        { source: 'cloud_ai' }
      );
    }
    default:
      throw new Error(`Tipo documento non supportato: ${documentType}`);
  }
}

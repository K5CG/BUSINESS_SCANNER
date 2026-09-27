import type { DocumentType } from '../types';

export type ExpectedGeminiDocumentType =
  | 'quotation'
  | 'order'
  | 'invoice'
  | 'free_document';

/**
 * Il tipo scelto nell'app diventa l'indizio dato al servizio AI: resta un
 * suggerimento, perché il documento reale può smentirlo. Il biglietto da visita
 * non passa da qui e non ha un equivalente commerciale.
 */
export function expectedGeminiDocumentType(
  documentType?: DocumentType
): ExpectedGeminiDocumentType | undefined {
  switch (documentType) {
    case 'quote':
      return 'quotation';
    case 'order':
      return 'order';
    case 'invoice':
      return 'invoice';
    case 'free_document':
      return 'free_document';
    default:
      return undefined;
  }
}

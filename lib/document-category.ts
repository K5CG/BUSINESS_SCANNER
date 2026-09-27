import type { DocumentCategory, DocumentType } from '../types';

export const OTHER_DOCUMENT_CATEGORIES = [
  'delivery_document',
  'proforma_invoice',
  'generic_document',
  'generic_image',
] as const;

export type OtherDocumentCategory = (typeof OTHER_DOCUMENT_CATEGORIES)[number];

export function isDocumentCategory(value: unknown): value is DocumentCategory {
  return (
    value === 'quote'
    || value === 'order'
    || value === 'invoice'
    || value === 'delivery_document'
    || value === 'proforma_invoice'
    || value === 'generic_document'
    || value === 'generic_image'
  );
}

export function defaultCategoryForDocumentType(
  type: Exclude<DocumentType, 'business_card'>,
): DocumentCategory {
  switch (type) {
    case 'quote':
      return 'quote';
    case 'order':
      return 'order';
    case 'invoice':
      return 'invoice';
    case 'free_document':
      return 'generic_document';
  }
}

export function processingTypeForCategory(
  category: DocumentCategory,
): Exclude<DocumentType, 'business_card'> {
  switch (category) {
    case 'quote':
      return 'quote';
    case 'order':
      return 'order';
    case 'invoice':
      return 'invoice';
    case 'delivery_document':
      // DDT has the same commercial row/quantity/amount structure as the
      // established order-family flow. The category remains distinct.
      return 'order';
    case 'proforma_invoice':
      // Pro-forma keeps the invoice extraction path but is never relabelled
      // as a fiscal invoice: its persistent category remains distinct.
      return 'invoice';
    case 'generic_document':
    case 'generic_image':
      return 'free_document';
  }
}

export const DOCUMENT_CATEGORY_LABEL_KEYS: Record<DocumentCategory, string> = {
  quote: 'quote',
  order: 'order',
  invoice: 'invoice',
  delivery_document: 'deliveryDocument',
  proforma_invoice: 'proformaInvoice',
  generic_document: 'genericDocument',
  generic_image: 'genericImageOther',
};

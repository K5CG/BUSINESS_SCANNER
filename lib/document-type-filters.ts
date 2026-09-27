import type { AnyDocument } from '../types';

export const STORED_DOCUMENT_TYPES = ['quote', 'order', 'invoice', 'free_document'] as const;
export type StoredDocumentType = (typeof STORED_DOCUMENT_TYPES)[number];

export const COMMERCIAL_SCAN_TYPES = ['quote', 'order', 'invoice'] as const;
export type CommercialScanType = (typeof COMMERCIAL_SCAN_TYPES)[number];

export type DocumentTypeSelection = Record<StoredDocumentType, boolean>;

export function createDefaultDocumentTypeSelection(): DocumentTypeSelection {
  return {
    quote: true,
    order: true,
    invoice: true,
    free_document: true,
  };
}

export function isStoredDocument(
  document: AnyDocument
): document is Extract<AnyDocument, { type: StoredDocumentType }> {
  return STORED_DOCUMENT_TYPES.includes(document.type as StoredDocumentType);
}

export function isAllDocumentTypesSelected(selection: DocumentTypeSelection): boolean {
  return STORED_DOCUMENT_TYPES.every((type) => selection[type]);
}

export function setAllDocumentTypesSelected(selected: boolean): DocumentTypeSelection {
  return {
    quote: selected,
    order: selected,
    invoice: selected,
    free_document: selected,
  };
}

export function toggleDocumentTypeSelection(
  selection: DocumentTypeSelection,
  type: StoredDocumentType
): DocumentTypeSelection {
  return {
    ...selection,
    [type]: !selection[type],
  };
}

export function documentMatchesTypeSelection(
  document: AnyDocument,
  selection: DocumentTypeSelection
): boolean {
  if (!isStoredDocument(document)) return false;
  return selection[document.type];
}

export function countSelectedDocumentTypes(selection: DocumentTypeSelection): number {
  return STORED_DOCUMENT_TYPES.filter((type) => selection[type]).length;
}

export function getSingleSelectedDocumentType(
  selection: DocumentTypeSelection
): StoredDocumentType | undefined {
  const selected = STORED_DOCUMENT_TYPES.filter((type) => selection[type]);
  return selected.length === 1 ? selected[0] : undefined;
}

export function isDocumentTypeFilterActive(selection: DocumentTypeSelection): boolean {
  return !isAllDocumentTypesSelected(selection);
}

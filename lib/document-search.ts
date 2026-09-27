import type { AnyDocument } from '../types';
import { CONTACT_SEARCH_MIN_LEN, normalizeSearchText } from './contact-search';
import {
  documentMatchesTypeSelection,
  isDocumentTypeFilterActive,
  isStoredDocument,
  STORED_DOCUMENT_TYPES,
  type DocumentTypeSelection,
  type StoredDocumentType,
} from './document-type-filters';

export type { DocumentTypeSelection, StoredDocumentType };
export { STORED_DOCUMENT_TYPES };

export type DocumentListFilter = 'all' | StoredDocumentType;

function documentSearchBlob(doc: AnyDocument): string {
  const parts = [doc.title, doc.rawText, doc.type];
  return normalizeSearchText(parts.filter(Boolean).join(' '));
}

export function documentMatchesQuery(doc: AnyDocument, query: string): boolean {
  const q = normalizeSearchText(query.trim());
  if (q.length < CONTACT_SEARCH_MIN_LEN) return true;
  return documentSearchBlob(doc).includes(q);
}

export function documentMatchesListFilter(doc: AnyDocument, typeFilter: DocumentListFilter): boolean {
  if (typeFilter === 'all') return isStoredDocument(doc);
  return doc.type === typeFilter;
}

export function filterDocuments(
  documents: AnyDocument[],
  query: string,
  typeSelection: DocumentTypeSelection,
): AnyDocument[] {
  return documents.filter(
    (doc) => documentMatchesQuery(doc, query) && documentMatchesTypeSelection(doc, typeSelection),
  );
}

export function isDocumentListFilterActive(typeSelection: DocumentTypeSelection): boolean {
  return isDocumentTypeFilterActive(typeSelection);
}

export const DOCUMENT_SEARCH_MIN_LEN = CONTACT_SEARCH_MIN_LEN;

export const DOCUMENT_TYPE_FILTER_KEYS = ['all', ...STORED_DOCUMENT_TYPES] as const;

export type DocumentTypeFilterKey = (typeof DOCUMENT_TYPE_FILTER_KEYS)[number];

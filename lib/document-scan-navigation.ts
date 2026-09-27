import type { DocumentCategory, DocumentType } from '../types';

type DocumentProcessingType = Extract<DocumentType, 'quote' | 'order' | 'invoice' | 'free_document'>;

let sessionSequence = 0;

export function createDocumentScanSessionId(nowMs = Date.now()): string {
  sessionSequence = (sessionSequence + 1) % 0x100000;
  return `${nowMs.toString(36)}-${sessionSequence.toString(36)}`;
}

export function buildDocumentScanHref(
  type: DocumentProcessingType,
  category: DocumentCategory,
  sessionId: string,
): string {
  return `/scan/${type}?category=${encodeURIComponent(category)}&session=${encodeURIComponent(sessionId)}&captureMode=portrait`;
}

export function documentScannerSessionKey(
  type: DocumentType,
  category: DocumentCategory | undefined,
  sessionId: string | undefined,
): string {
  return `${type}:${category ?? 'none'}:${sessionId ?? 'legacy'}`;
}

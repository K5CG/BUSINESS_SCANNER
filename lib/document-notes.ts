import { AnyDocument } from '../types';

export function getDocumentNotes(document: AnyDocument): string {
  if ('notes' in document && typeof document.notes === 'string') {
    return document.notes;
  }
  return '';
}

export function withDocumentNotes(document: AnyDocument, notes: string): AnyDocument {
  return { ...document, notes: notes.trim() || undefined, updatedAt: new Date() };
}

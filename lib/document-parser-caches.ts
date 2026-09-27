import { resetDocumentLabelCaches } from './document-label-dictionary';
import { resetDocumentItemsCaches } from './document-items-totals';
import { resetDocumentPartiesCaches } from './document-parties-metadata';

/** Clears process-local parser caches. Safe between documents; not required mid-page. */
export function resetDocumentParserCaches(): void {
  resetDocumentLabelCaches();
  resetDocumentItemsCaches();
  resetDocumentPartiesCaches();
}

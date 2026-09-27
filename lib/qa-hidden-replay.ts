import { File, Paths } from 'expo-file-system';
import type { AnyDocument } from '../types';
import {
  canonicalPagesFromPersistedDocument,
  parseStructuredDocumentFromOcr,
} from './document-canonical-parse';
import { resetDocumentParserCaches } from './document-parser-caches';

const REQUEST_NAME = 'qa-replay-request.json';
const RESULT_NAME = 'qa-replay-result.json';

interface QaReplayRequest {
  documents: AnyDocument[];
  deadlineMode?: 'production' | 'unlimited';
}

/**
 * Hidden QA hook: if a request file exists in the app document directory,
 * replay stored OCR through the production parser and write a result file.
 * Not a customer-visible screen.
 */
export async function runHiddenQaFixtureReplayIfRequested(): Promise<void> {
  const requestFile = new File(Paths.document, REQUEST_NAME);
  if (!requestFile.exists) return;
  try {
    const request = JSON.parse(await requestFile.text()) as QaReplayRequest;
    const results = [];
    for (const document of request.documents ?? []) {
      resetDocumentParserCaches();
      const documentType = document.type === 'business_card' ? 'free_document' : document.type;
      const parsed = await parseStructuredDocumentFromOcr({
        documentType,
        pages: canonicalPagesFromPersistedDocument(document),
        deadlineMode: request.deadlineMode ?? 'production',
      }, { persistShell: { ...document, items: [], subtotal: undefined, vatAmount: undefined, total: undefined } as AnyDocument });
      results.push({
        id: document.id,
        title: document.title,
        snapshot: parsed.snapshot,
        persisted:
          parsed.persisted.type === 'business_card' || parsed.persisted.type === 'free_document'
            ? null
            : {
                customer: parsed.persisted.customerName,
                items: parsed.persisted.items?.length ?? 0,
                subtotal: parsed.persisted.subtotal,
                vatAmount: parsed.persisted.vatAmount,
                total: parsed.persisted.total,
              },
      });
    }
    const resultFile = new File(Paths.document, RESULT_NAME);
    resultFile.write(JSON.stringify({ runtime: 'hermes', results }, null, 2));
    try { requestFile.delete(); } catch { /* keep request if delete fails */ }
  } catch (error) {
    const resultFile = new File(Paths.document, RESULT_NAME);
    resultFile.write(JSON.stringify({
      runtime: 'hermes',
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

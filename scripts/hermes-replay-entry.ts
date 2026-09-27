import { parseStructuredDocumentFromOcr } from '../lib/document-canonical-parse';
import { resetDocumentParserCaches } from '../lib/document-parser-caches';

interface HermesReplayFixture {
  id: string;
  title: string;
  documentType: 'quote' | 'order' | 'invoice' | 'free_document';
  pages: Parameters<typeof parseStructuredDocumentFromOcr>[0]['pages'];
}

declare const __QA_FIXTURES__: HermesReplayFixture[];
declare const __HERMES_REPLAY__: boolean | undefined;
declare function print(text: string): void;

function emit(value: unknown): void {
  const text = `HERMES_REPLAY_RESULT:${JSON.stringify(value)}`;
  if (typeof print === 'function') {
    print(text);
    return;
  }
  console.log(text);
}

async function main(): Promise<void> {
  try {
    const fixtures = typeof __QA_FIXTURES__ === 'undefined' ? [] : __QA_FIXTURES__;
    const results = [];
    for (const fixture of fixtures) {
      resetDocumentParserCaches();
      const parsed = await parseStructuredDocumentFromOcr({
        documentType: fixture.documentType,
        pages: fixture.pages,
        deadlineMode: 'production',
      });
      const reasons = parsed.extraction.reasons ?? [];
      results.push({
        id: fixture.id,
        title: fixture.title,
        snapshot: parsed.snapshot,
        timings: parsed.snapshot.stageTimings ?? [],
        reasons,
        deadline_expired: reasons.some((reason) =>
          /timeout|deadline_exceeded/i.test(reason)),
        reason_codes: reasons,
        persisted: parsed.persisted.type === 'business_card' ? null : {
          customer: parsed.persisted.customerName ?? null,
          items: parsed.persisted.items?.length ?? 0,
          subtotal: parsed.persisted.subtotal ?? null,
          vatAmount: parsed.persisted.vatAmount ?? null,
          total: parsed.persisted.total ?? null,
        },
      });
    }
    emit({
      runtime: typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object'
        || typeof __HERMES_REPLAY__ !== 'undefined'
        ? 'hermes'
        : 'node',
      results,
    });
  } catch (error) {
    emit({
      runtime: 'error',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

void main();

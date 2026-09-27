import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDocumentProcessResult,
  createDocumentProcessProgressReporter,
} from '../lib/document-process-progress';

test('document process progress is monotonic', () => {
  const seen: number[] = [];
  const reporter = createDocumentProcessProgressReporter((progress) => {
    seen.push(progress.percent);
  });
  reporter.prepare();
  reporter.ocrPage(0, 2);
  reporter.ocrPage(1, 2);
  reporter.pageResults();
  reporter.layout();
  reporter.metadata();
  reporter.itemsTotals();
  reporter.reconciliation();
  reporter.fallback();
  reporter.persist();
  reporter.done();
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `percent went backwards at ${i}: ${seen.join(' -> ')}`);
  }
  assert.equal(seen.at(-1), 100);
});

test('classifyDocumentProcessResult distinguishes success partial and insufficient', () => {
  assert.equal(
    classifyDocumentProcessResult({
      ocrWorked: true,
      rawTextLength: 500,
      structuredExtraction: { complete: true, requiresReview: false, reasons: [] },
    }),
    'success',
  );
  assert.equal(
    classifyDocumentProcessResult({
      ocrWorked: true,
      rawTextLength: 500,
      structuredExtraction: {
        complete: false,
        requiresReview: true,
        reasons: ['structured_layout_timeout', 'semantic_fallback_applied'],
      },
    }),
    'partial_success',
  );
  assert.equal(
    classifyDocumentProcessResult({
      ocrWorked: false,
      rawTextLength: 0,
      structuredExtraction: { reasons: ['structured_extraction_insufficient_ocr'] },
    }),
    'ocr_insufficient',
  );
});

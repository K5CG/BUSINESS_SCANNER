import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDocumentItemsAndTotals } from '../lib/document-items-totals';
import type { StructuredDocumentPage } from '../lib/document-structure';

function syntheticNumericPage(amountCount: number): StructuredDocumentPage {
  const lines = Array.from({ length: amountCount }, (_, index) => ({
    id: `l${index}`,
    pageIndex: 0,
    readingOrder: index,
    text: `${(index + 1) * 11.11}`,
    boundingBox: {
      x: 100,
      y: 100 + index * 20,
      width: 80,
      height: 16,
    },
  }));
  return {
    pageIndex: 0,
    width: 3000,
    height: 4000,
    lines,
    zones: [],
    status: 'partial',
    complete: false,
    requiresRescan: false,
    reasons: [],
  };
}

test('arithmetic triplet detection stays bounded with many numeric candidates', () => {
  const started = Date.now();
  const content = extractDocumentItemsAndTotals([syntheticNumericPage(120)]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `expected bounded runtime, got ${elapsed}ms`);
  assert.ok(Array.isArray(content.items));
  assert.ok(Array.isArray(content.reasons));
});

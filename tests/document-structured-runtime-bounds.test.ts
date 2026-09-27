import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { extractStructuredDocumentAsync } from '../lib/document-structured-extraction';

const qaRoot = path.join(process.cwd(), 'test-data', 'qa-export-2026-08-08-real-full');
const MOTORPARTS_ID = 'a13fa9a4-b89f-48df-9f51-8a3d48d5d318';

function rawTextFor(id: string): string {
  const file = path.join(qaRoot, 'raw-text', `${id}.txt`);
  assert.equal(fs.existsSync(file), true, `missing fixture ${file}`);
  return fs.readFileSync(file, 'utf8');
}

test('Motorparts structured extraction completes under reasonable PC threshold', async () => {
  const rawText = rawTextFor(MOTORPARTS_ID);
  const started = Date.now();
  const extraction = await extractStructuredDocumentAsync('order', [{
    pageIndex: 0,
    rawText,
    lines: [],
    width: 4080,
    height: 3060,
  }]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, `structured extraction too slow: ${elapsed}ms`);
  assert.equal(extraction.schemaVersion, 1);
  assert.ok(extraction.items.length >= 0);
});

test('scanner preview exposes manual 180 rotate fallback', () => {
  const scanner = fs.readFileSync(
    path.join(process.cwd(), 'components', 'Camera', 'MultiPageScanner.tsx'),
    'utf8',
  );
  assert.match(scanner, /rotatePendingDocument180/);
  assert.match(scanner, /rotateImage\(pending\.page\.uri, 180\)/);
});

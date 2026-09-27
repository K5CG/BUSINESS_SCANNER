import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const datasetRoot = path.join(root, 'test-data', 'real-device-documents');
const manifest = JSON.parse(fs.readFileSync(path.join(datasetRoot, 'manifest.json'), 'utf8'));
const summary = JSON.parse(
  fs.readFileSync(path.join(datasetRoot, 'qa-export-2026-08-02-summary.json'), 'utf8'),
);

test('la baseline reale non promuove output non certificati a expected', () => {
  assert.equal(summary.expectedCertified, false);
  assert.ok(summary.cases.every((entry) => entry.expectedStatus === 'UNCERTIFIED'));
  for (const relativeCasePath of manifest.cases) {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(datasetRoot, relativeCasePath), 'utf8'),
    );
    const expected = JSON.parse(
      fs.readFileSync(
        path.join(datasetRoot, path.dirname(relativeCasePath), fixture.expectedFile),
        'utf8',
      ),
    );
    assert.equal(expected.verifiedManually, true);
  }
});

test('l export QA indicizzato contiene sei documenti e sei pagine', () => {
  assert.equal(summary.documentCount, 6);
  assert.equal(summary.pageCount, 6);
  assert.equal(summary.imageCount, 6);
  assert.equal(summary.rawOcrCount, 6);
  assert.equal(summary.cases.reduce((sum, entry) => sum + entry.pages, 0), 6);
});

test('la baseline copre preventivi, ordine e documento libero', () => {
  assert.deepEqual(summary.types, { quote: 4, order: 1, free_document: 1 });
  assert.deepEqual(
    [...new Set(summary.cases.map((entry) => entry.type))].sort(),
    ['free_document', 'order', 'quote'],
  );
});

test('ogni caso distingue le classi di problema senza inventare campi attesi', () => {
  const allowed = new Set(['acquisition', 'ocr', 'layout', 'parser', 'merge', 'ui', 'ambiguous', 'completeness']);
  for (const entry of summary.cases) {
    assert.ok(entry.classification.length > 0);
    assert.ok(entry.classification.every((value) => allowed.has(value)));
    assert.equal(Object.hasOwn(entry, 'expectedFields'), false);
  }
});

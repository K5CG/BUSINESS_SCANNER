import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assessLocalDocumentMinimum } from '../lib/document-local-minimum';
import type { StructuredDocumentExtraction } from '../lib/document-structure';

test('KÜNZI conserva la presenza tabella anche quando non produce righe', () => {
  const documents = JSON.parse(fs.readFileSync(path.join(
    process.cwd(), 'test-data', 'real-device-documents',
    'runtime-kunzi-failure-20260803', 'imported', 'documents.json',
  ), 'utf8')) as Array<{ id: string; structuredExtraction?: StructuredDocumentExtraction }>;
  const kunzi = documents.find((document) => document.id === 'cdc508e6-83fb-4961-bb8b-9ed77438a8a5');
  assert.ok(kunzi?.structuredExtraction);
  const assessment = assessLocalDocumentMinimum(kunzi.structuredExtraction);
  assert.equal(assessment.tableDetected, true);
  assert.equal(assessment.tableStructured, false);
  assert.equal(assessment.tableNeedsReview, true);
  assert.equal(assessment.offerAiSupport, true);
  assert.deepEqual(assessment.messages, ['table_detected_details_require_review']);
});

test('assenza tabella non viene trasformata in una tabella vuota', () => {
  const extraction = {
    pages: [{ zones: [] }], items: [], requiresReview: false,
  } as unknown as StructuredDocumentExtraction;
  const assessment = assessLocalDocumentMinimum(extraction);
  assert.equal(assessment.tableDetected, false);
  assert.equal(assessment.tableNeedsReview, false);
  assert.deepEqual(assessment.messages, []);
});

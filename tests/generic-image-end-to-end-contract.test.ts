import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

import {
  buildDocumentScanHref,
  createDocumentScanSessionId,
  documentScannerSessionKey,
} from '../lib/document-scan-navigation';
import { processingTypeForCategory } from '../lib/document-category';

test('generic image uses established free-document engine', () => {
  assert.equal(processingTypeForCategory('generic_image'), 'free_document');
});

test('generic image gets a fresh scanner session and explicit portrait start', () => {
  const first = createDocumentScanSessionId(1788169000000);
  const second = createDocumentScanSessionId(1788169000000);
  assert.notEqual(first, second);

  const firstHref = buildDocumentScanHref('free_document', 'generic_image', first);
  const secondHref = buildDocumentScanHref('free_document', 'generic_image', second);

  assert.notEqual(firstHref, secondHref);
  assert.match(firstHref, /^\/scan\/free_document\?category=generic_image&session=.*&captureMode=portrait$/);
  assert.match(secondHref, /^\/scan\/free_document\?category=generic_image&session=.*&captureMode=portrait$/);
});

test('generic image and generic document never share scanner identity', () => {
  const session = 'same-clock';
  assert.notEqual(
    documentScannerSessionKey('free_document', 'generic_image', session),
    documentScannerSessionKey('free_document', 'generic_document', session),
  );
});

test('scanner passes selected document category into processing workflow', () => {
  const source = fs.readFileSync('components/Camera/MultiPageScanner.tsx', 'utf8');
  assert.match(
    source,
    /processCapturedScan\(\{[\s\S]*documentType,[\s\S]*documentCategory,/,
  );
});

test('workflow persists the selected category on the built document', () => {
  const source = fs.readFileSync('lib/scan-process-workflow.ts', 'utf8');
  assert.match(
    source,
    /if \(documentCategory\) \{[\s\S]*category:\s*documentCategory/,
  );
});

test('generic image bypasses OCR-insufficient rejection only for generic image', () => {
  const source = fs.readFileSync('lib/scan-process-workflow.ts', 'utf8');

  assert.match(
    source,
    /documentCategory === 'generic_image' && classifiedProcessResult === 'ocr_insufficient'[\s\S]*\? 'success'/,
  );

  // The ordinary OCR rejection remains in place for all other document categories.
  assert.match(
    source,
    /if \(processResult === 'ocr_insufficient'\) \{[\s\S]*return \{ status: 'ocr_insufficient' \}/,
  );
});

test('parent scan screen resets capture mode whenever acquisition session changes', () => {
  const source = fs.readFileSync('app/scan/[type].tsx', 'utf8');
  assert.match(source, /\[scanSessionParam, captureModeParam, documentType\]/);
  assert.match(source, /setCaptureModeState\([\s\S]*'portrait'/);
});

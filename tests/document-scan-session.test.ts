import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDocumentScanHref,
  createDocumentScanSessionId,
  documentScannerSessionKey,
} from '../lib/document-scan-navigation';

test('every document acquisition gets a fresh session even in the same millisecond', () => {
  const first = createDocumentScanSessionId(1788166000000);
  const second = createDocumentScanSessionId(1788166000000);
  assert.notEqual(first, second);
});

test('same processing engine with different categories gets different scanner session identity', () => {
  const session = 'abc-1';
  assert.notEqual(
    documentScannerSessionKey('free_document', 'generic_document', session),
    documentScannerSessionKey('free_document', 'generic_image', session),
  );
});

test('new session id forces a different scanner identity for the same category', () => {
  assert.notEqual(
    documentScannerSessionKey('invoice', 'proforma_invoice', 'session-1'),
    documentScannerSessionKey('invoice', 'proforma_invoice', 'session-2'),
  );
});

test('navigation preserves processing type, category and session', () => {
  assert.equal(
    buildDocumentScanHref('order', 'delivery_document', 'session-1'),
    '/scan/order?category=delivery_document&session=session-1&captureMode=portrait',
  );
  assert.equal(
    buildDocumentScanHref('invoice', 'proforma_invoice', 'session-2'),
    '/scan/invoice?category=proforma_invoice&session=session-2&captureMode=portrait',
  );
  assert.equal(
    buildDocumentScanHref('free_document', 'generic_document', 'session-3'),
    '/scan/free_document?category=generic_document&session=session-3&captureMode=portrait',
  );
  assert.equal(
    buildDocumentScanHref('free_document', 'generic_image', 'session-4'),
    '/scan/free_document?category=generic_image&session=session-4&captureMode=portrait',
  );
});

test('home-launched document scans explicitly reset capture mode to portrait', () => {
  const href = buildDocumentScanHref('free_document', 'generic_document', 'fresh-session');
  assert.match(href, /captureMode=portrait$/);
});

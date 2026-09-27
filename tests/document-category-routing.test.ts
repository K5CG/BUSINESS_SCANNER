import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultCategoryForDocumentType,
  isDocumentCategory,
  processingTypeForCategory,
} from '../lib/document-category';

test('existing document types keep their established processing path', () => {
  assert.equal(processingTypeForCategory('quote'), 'quote');
  assert.equal(processingTypeForCategory('order'), 'order');
  assert.equal(processingTypeForCategory('invoice'), 'invoice');
});

test('DDT and pro-forma are categories, not new parser engines', () => {
  assert.equal(processingTypeForCategory('delivery_document'), 'order');
  assert.equal(processingTypeForCategory('proforma_invoice'), 'invoice');
});

test('generic document and generic image use the established free-document path', () => {
  assert.equal(processingTypeForCategory('generic_document'), 'free_document');
  assert.equal(processingTypeForCategory('generic_image'), 'free_document');
});

test('legacy records receive a display category without migration', () => {
  assert.equal(defaultCategoryForDocumentType('quote'), 'quote');
  assert.equal(defaultCategoryForDocumentType('order'), 'order');
  assert.equal(defaultCategoryForDocumentType('invoice'), 'invoice');
  assert.equal(defaultCategoryForDocumentType('free_document'), 'generic_document');
});

test('only declared persistent categories are accepted from navigation', () => {
  assert.equal(isDocumentCategory('delivery_document'), true);
  assert.equal(isDocumentCategory('proforma_invoice'), true);
  assert.equal(isDocumentCategory('generic_document'), true);
  assert.equal(isDocumentCategory('generic_image'), true);
  assert.equal(isDocumentCategory('anything_else'), false);
  assert.equal(isDocumentCategory(undefined), false);
});

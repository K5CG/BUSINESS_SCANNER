import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type {
  AnyDocument,
  FreeDocument,
  InvoiceDocument,
  OrderDocument,
  QuoteDocument,
} from '../types';
import {
  findDocumentDuplicateMatch,
  getCanonicalDocumentNumber,
  isRejectedDocumentIdentityValue,
  normalizeDocumentIdentityNumber,
  shouldPersistAfterDocumentDuplicateDecision,
} from '../lib/duplicate-documents';

const root = process.cwd();

function baseDoc(overrides: Partial<AnyDocument> & Pick<AnyDocument, 'id' | 'type' | 'title'>): AnyDocument {
  return {
    images: [],
    rawText: '',
    confidence: {},
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as AnyDocument;
}

function order(id: string, orderNumber?: string, extra: Partial<OrderDocument> = {}): OrderDocument {
  return baseDoc({
    id,
    type: 'order',
    title: orderNumber ? `Ordine ${orderNumber}` : 'Ordine',
    orderNumber,
    items: [],
    ...extra,
  }) as OrderDocument;
}

function quote(id: string, quoteNumber?: string, extra: Partial<QuoteDocument> = {}): QuoteDocument {
  return baseDoc({
    id,
    type: 'quote',
    title: quoteNumber ? `Preventivo ${quoteNumber}` : 'Preventivo',
    quoteNumber,
    items: [],
    ...extra,
  }) as QuoteDocument;
}

function invoice(id: string, invoiceNumber?: string, extra: Partial<InvoiceDocument> = {}): InvoiceDocument {
  return baseDoc({
    id,
    type: 'invoice',
    title: invoiceNumber ? `Fattura ${invoiceNumber}` : 'Fattura',
    invoiceNumber,
    items: [],
    ...extra,
  }) as InvoiceDocument;
}

function freeDoc(id: string, documentNumber?: string, extra: Partial<FreeDocument> = {}): FreeDocument {
  return baseDoc({
    id,
    type: 'free_document',
    title: documentNumber ? `Documento ${documentNumber}` : 'Documento libero',
    documentNumber,
    extractedFields: {},
    ...extra,
  }) as FreeDocument;
}

test('1 same order + same exact number → strong duplicate', () => {
  const stored = order('stored', '2025/0874');
  const incoming = order('incoming', '2025/0874');
  const match = findDocumentDuplicateMatch(incoming, [stored]);
  assert.equal(match?.kind, 'strong');
  assert.equal(match?.document.id, 'stored');
});

test('2 normalized equivalent 2025/0874 vs 2025 / 0874 → strong duplicate', () => {
  const stored = order('stored', '2025/0874');
  const incoming = order('incoming', '2025 / 0874');
  const match = findDocumentDuplicateMatch(incoming, [stored]);
  assert.equal(match?.kind, 'strong');
  assert.equal(normalizeDocumentIdentityNumber('2025 / 0874'), '2025/0874');
});

test('3 different number → no duplicate', () => {
  const stored = order('stored', '2025/0874');
  const incoming = order('incoming', '2025/0875');
  assert.equal(findDocumentDuplicateMatch(incoming, [stored]), null);
});

test('4 same number but different document type → no strong duplicate', () => {
  const stored = order('stored', '2025/0874');
  const incoming = invoice('incoming', '2025/0874');
  assert.equal(findDocumentDuplicateMatch(incoming, [stored]), null);
  assert.equal(findDocumentDuplicateMatch(quote('q1', '2025/0874'), [stored]), null);
});

test('5 missing number + same customer/date/total → possible duplicate at most', () => {
  const when = new Date('2025-05-20T10:00:00.000Z');
  const stored = order('stored', undefined, {
    customerName: 'Autofficina Chiozza Service',
    orderDate: when,
    total: 608.46,
  });
  const incoming = order('incoming', undefined, {
    customerName: 'Autofficina  Chiozza Service',
    orderDate: new Date('2025-05-20T18:00:00.000Z'),
    total: 608.46,
  });
  const match = findDocumentDuplicateMatch(incoming, [stored]);
  assert.equal(match?.kind, 'possible');
  assert.equal(match?.document.id, 'stored');
});

test('6 same customer only → no duplicate', () => {
  const stored = order('stored', undefined, {
    customerName: 'Autofficina Chiozza Service',
    orderDate: new Date('2025-05-20'),
    total: 100,
  });
  const incoming = order('incoming', undefined, {
    customerName: 'Autofficina Chiozza Service',
    orderDate: new Date('2025-06-01'),
    total: 200,
  });
  assert.equal(findDocumentDuplicateMatch(incoming, [stored]), null);
});

test('7 same total only → no duplicate', () => {
  const stored = order('stored', undefined, {
    customerName: 'Alpha',
    total: 608.46,
  });
  const incoming = order('incoming', undefined, {
    customerName: 'Beta',
    total: 608.46,
  });
  assert.equal(findDocumentDuplicateMatch(incoming, [stored]), null);
});

test('8 IBAN accidentally present → never used as document number', () => {
  const iban = 'IT62 2030 6960 2111 0000 0012 345';
  assert.equal(isRejectedDocumentIdentityValue(iban), true);
  const stored = order('stored', '2025/0874', { rawText: iban });
  const incoming = order('incoming', iban, { rawText: iban });
  assert.equal(getCanonicalDocumentNumber(incoming), iban);
  assert.equal(findDocumentDuplicateMatch(incoming, [stored]), null);
});

test('9 IVA code 122 → never used as document identity', () => {
  assert.equal(isRejectedDocumentIdentityValue('122'), true);
  const stored = order('stored', '122', { total: 122 });
  const incoming = order('incoming', '122', { total: 122 });
  assert.equal(findDocumentDuplicateMatch(incoming, [stored]), null);
});

test('10 corrected number in review → duplicate check uses corrected value', () => {
  const stored = order('stored', '2025/0874');
  const ocrWrong = order('incoming', '2025/087A');
  assert.equal(findDocumentDuplicateMatch(ocrWrong, [stored]), null);
  const corrected = { ...ocrWrong, orderNumber: '2025/0874' };
  const match = findDocumentDuplicateMatch(corrected, [stored]);
  assert.equal(match?.kind, 'strong');
});

test('11 reprocessing existing document → existing document does not match itself', () => {
  const stored = order('stored', '2025/0874');
  assert.equal(
    findDocumentDuplicateMatch(stored, [stored], { excludeDocumentId: 'stored' }),
    null
  );
  assert.equal(findDocumentDuplicateMatch(stored, [stored]), null);
});

test('12 deliberate Salva comunque → second record is allowed', () => {
  assert.equal(shouldPersistAfterDocumentDuplicateDecision('save_anyway'), true);
  assert.equal(shouldPersistAfterDocumentDuplicateDecision('cancel'), false);
  assert.equal(shouldPersistAfterDocumentDuplicateDecision('open_existing'), false);
  assert.equal(shouldPersistAfterDocumentDuplicateDecision('none'), true);
});

test('quote same number is strong; different number is not', () => {
  const stored = quote('q-stored', 'DEV-2025-0612');
  assert.equal(findDocumentDuplicateMatch(quote('q-new', 'DEV-2025-0612'), [stored])?.kind, 'strong');
  assert.equal(findDocumentDuplicateMatch(quote('q-other', 'DEV-2025-0613'), [stored]), null);
});

test('invoice same number is strong; spaces around slash still match', () => {
  const stored = invoice('i-stored', 'AN-2025-0457');
  assert.equal(findDocumentDuplicateMatch(invoice('i-new', 'AN-2025-0457'), [stored])?.kind, 'strong');
  assert.equal(
    findDocumentDuplicateMatch(invoice('i-spaced', 'AN - 2025 - 0457'), [stored])?.kind,
    'strong'
  );
});

test('812/Z is not equivalent to 812Z', () => {
  const stored = quote('q-slash', '812/Z');
  assert.equal(findDocumentDuplicateMatch(quote('q-noslash', '812Z'), [stored]), null);
  assert.notEqual(normalizeDocumentIdentityNumber('812/Z'), normalizeDocumentIdentityNumber('812Z'));
});

test('generic document is conservative: no possible match without a number', () => {
  const stored = freeDoc('f-stored', undefined, { subject: 'Same title' });
  const incoming = freeDoc('f-new', undefined, { subject: 'Same title' });
  assert.equal(findDocumentDuplicateMatch(incoming, [stored]), null);
});

test('create path and review save use the duplicate helper', () => {
  const store = fs.readFileSync(path.join(root, 'store', 'useDocumentStore.ts'), 'utf8');
  const review = fs.readFileSync(path.join(root, 'app', 'document', '[id].tsx'), 'utf8');
  const list = fs.readFileSync(path.join(root, 'app', '(tabs)', 'documents.tsx'), 'utf8');
  assert.match(store, /resolveDocumentDuplicate/);
  assert.match(store, /excludeDocumentId: document\.id/);
  assert.match(review, /excludeDocumentId: toSave\.id/);
  assert.doesNotMatch(list, /pickDuplicateToRemove/);
  assert.doesNotMatch(list, /deleteDuplicate/);
});

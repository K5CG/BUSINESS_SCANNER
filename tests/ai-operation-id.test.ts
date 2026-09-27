import test from 'node:test';
import assert from 'node:assert/strict';

import { createAiOperationContext, createAiOperationId } from '../lib/ai-credit/operation-id';
import { AI_OPERATION_ID_RE } from '../lib/ai-credit/types';

type CryptoHolder = { crypto?: unknown };

function withoutWebCrypto<T>(run: () => T): T {
  const holder = globalThis as CryptoHolder;
  const original = holder.crypto;
  // Su Hermes questa proprietà non esiste: è la condizione che faceva fallire
  // ogni operazione AI, importazione PDF compresa.
  delete holder.crypto;
  try {
    return run();
  } finally {
    holder.crypto = original;
  }
}

test("l'identificativo dell'operazione nasce anche senza crypto nel runtime", () => {
  const id = withoutWebCrypto(() => createAiOperationId());
  assert.match(id, AI_OPERATION_ID_RE);
});

test('gli identificativi restano distinti su molte generazioni', () => {
  const ids = withoutWebCrypto(() =>
    Array.from({ length: 2000 }, () => createAiOperationId()),
  );
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, AI_OPERATION_ID_RE);
});

test('una fonte crittografica presente viene usata', () => {
  const holder = globalThis as CryptoHolder;
  const original = holder.crypto;
  let used = false;
  holder.crypto = {
    getRandomValues: (array: Uint8Array) => {
      used = true;
      for (let i = 0; i < array.length; i++) array[i] = (i * 7 + 3) % 256;
      return array;
    },
  };
  try {
    assert.match(createAiOperationId(), AI_OPERATION_ID_RE);
    assert.ok(used, 'la fonte crittografica disponibile è stata ignorata');
  } finally {
    holder.crypto = original;
  }
});

test('un identificativo già valido viene riusato senza generarne un altro', () => {
  const first = withoutWebCrypto(() => createAiOperationId());
  const context = withoutWebCrypto(() => createAiOperationContext('pdf_page_ai', first));
  assert.equal(context.operationId, first);
  assert.equal(context.operationType, 'pdf_page_ai');

  // Un valore non conforme non viene propagato: se ne crea uno valido.
  const replaced = withoutWebCrypto(() => createAiOperationContext('pdf_page_ai', 'non-un-uuid'));
  assert.notEqual(replaced.operationId, 'non-un-uuid');
  assert.match(replaced.operationId, AI_OPERATION_ID_RE);
});

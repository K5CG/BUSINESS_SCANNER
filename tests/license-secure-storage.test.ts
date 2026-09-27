import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  readSecureJson,
  setSecureStorageAdapterForTests,
  writeSecureJson,
  type SecureStorageAdapter,
} from '../lib/license-secure-storage.ts';

function memoryAdapter(): SecureStorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async isAvailable() {
      return true;
    },
    async getItem(key: string) {
      return store.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      store.set(key, value);
    },
    async deleteItem(key: string) {
      store.delete(key);
    },
  };
}

test('12. SecureStore disponibile — read/write roundtrip', async () => {
  const adapter = memoryAdapter();
  setSecureStorageAdapterForTests(adapter);
  await writeSecureJson({ hello: 'world' }, 'test.secure');
  const value = await readSecureJson<{ hello: string }>('test.secure');
  assert.deepEqual(value, { hello: 'world' });
  setSecureStorageAdapterForTests(null);
});

test('13. SecureStore failure — adapter rifiuta write', async () => {
  const adapter: SecureStorageAdapter = {
    async isAvailable() {
      return false;
    },
    async getItem() {
      return null;
    },
    async setItem() {
      throw new Error('secure unavailable');
    },
    async deleteItem() {},
  };
  setSecureStorageAdapterForTests(adapter);
  const ok = await writeSecureJson({ x: 1 });
  assert.equal(ok, false);
  setSecureStorageAdapterForTests(null);
});

test('14. migrazione legacy documentata nel sorgente', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib/license-storage.ts'), 'utf8');
  assert.match(src, /ensureLicenseStorageMigrated/);
  assert.match(src, /license-state\.json/);
  assert.match(src, /deleteLegacyStateFile/);
  assert.match(src, /writeSecureJson/);
});

test('3C.17 no plaintext filesystem fallback for license secrets', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib/license-secure-storage.ts'), 'utf8');
  assert.doesNotMatch(src, /license-secure-fallback/);
  assert.doesNotMatch(src, /expo-file-system/);
  assert.match(src, /secure_store_unavailable/);
});

import { runtimeLogger } from './safe-runtime-logger';

const SECURE_KEY = 'business_scanner.license.secure.v1';

export interface SecureStorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

let secureStoreModule: typeof import('expo-secure-store') | null = null;

async function loadSecureStore(): Promise<typeof import('expo-secure-store') | null> {
  if (secureStoreModule) return secureStoreModule;
  try {
    secureStoreModule = await import('expo-secure-store');
    return secureStoreModule;
  } catch {
    return null;
  }
}

/**
 * License proof/tokens must never be written to plaintext filesystem.
 * If SecureStore is unavailable, reads return null and writes fail closed.
 */
export const defaultSecureStorageAdapter: SecureStorageAdapter = {
  async isAvailable(): Promise<boolean> {
    const mod = await loadSecureStore();
    if (!mod) return false;
    try {
      return (await mod.isAvailableAsync()) === true;
    } catch {
      return false;
    }
  },

  async getItem(key: string): Promise<string | null> {
    const mod = await loadSecureStore();
    if (!mod) return null;
    try {
      const available = await mod.isAvailableAsync();
      if (!available) return null;
      return await mod.getItemAsync(key);
    } catch (error) {
      runtimeLogger.warn('SECURE_STORE_READ_FAILED', error, {
        source: 'local',
        stage: 'read',
        status: 'failed',
      });
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    const mod = await loadSecureStore();
    if (!mod) {
      throw new Error('secure_store_unavailable');
    }
    const available = await mod.isAvailableAsync();
    if (!available) {
      throw new Error('secure_store_unavailable');
    }
    await mod.setItemAsync(key, value, {
      keychainAccessible: mod.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },

  async deleteItem(key: string): Promise<void> {
    const mod = await loadSecureStore();
    if (!mod) return;
    try {
      await mod.deleteItemAsync(key);
    } catch {
      /* ignore */
    }
  },
};

let adapterOverride: SecureStorageAdapter | null = null;

export function setSecureStorageAdapterForTests(adapter: SecureStorageAdapter | null): void {
  adapterOverride = adapter;
}

function adapter(): SecureStorageAdapter {
  return adapterOverride ?? defaultSecureStorageAdapter;
}

export async function readSecureJson<T>(key: string = SECURE_KEY): Promise<T | null> {
  const raw = await adapter().getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeSecureJson(
  value: unknown,
  key: string = SECURE_KEY
): Promise<boolean> {
  try {
    await adapter().setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    runtimeLogger.warn('SECURE_JSON_WRITE_FAILED', error, {
      source: 'local',
      stage: 'write',
      status: 'failed',
    });
    return false;
  }
}

export async function deleteSecureJson(key: string = SECURE_KEY): Promise<void> {
  await adapter().deleteItem(key);
}

export async function isSecureStorageAvailable(): Promise<boolean> {
  return adapter().isAvailable();
}

export { SECURE_KEY };

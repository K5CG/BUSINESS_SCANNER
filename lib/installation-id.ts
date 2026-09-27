import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { createReactNativeSafeInstallationId } from './installation-id-generate';
import { logLicense, redactInstallationId } from './license-log';
import { getPrivacyConsentRecord } from './privacy-consent';
import { readSecureJson, writeSecureJson } from './license-secure-storage';
import { runtimeLogger } from './safe-runtime-logger';

const INSTALLATION_SECURE_KEY = 'business_scanner.installation_id.v1';
const LEGACY_DEVICE_FILE = 'device-id.txt';

export interface InstallationRecord {
  installationId: string;
  createdAt: string;
  migratedFrom: 'expo' | 'legacy_file' | 'privacy_consent' | 'generated' | null;
}

function legacyDeviceFileUri(): string | null {
  const root = FileSystem.documentDirectory;
  if (!root) return null;
  return `${root}${LEGACY_DEVICE_FILE}`;
}

function isValidInstallationId(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return false;
  return /^[A-Za-z0-9._-]+$/.test(trimmed);
}

async function readLegacyDeviceId(): Promise<string | null> {
  const fromExpo = Constants.installationId?.trim();
  if (fromExpo && isValidInstallationId(fromExpo)) {
    return fromExpo;
  }

  const uri = legacyDeviceFileUri();
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const id = (await FileSystem.readAsStringAsync(uri)).trim();
    return isValidInstallationId(id) ? id : null;
  } catch {
    return null;
  }
}

async function readPrivacyConsentInstallationId(): Promise<string | null> {
  try {
    const consent = await getPrivacyConsentRecord();
    const id = consent?.installationId?.trim();
    return id && isValidInstallationId(id) ? id : null;
  } catch {
    return null;
  }
}

async function persistInstallation(record: InstallationRecord): Promise<boolean> {
  return writeSecureJson(record, INSTALLATION_SECURE_KEY);
}

export async function getInstallationId(): Promise<string> {
  logLicense('installation_id_begin');

  const existing = await readSecureJson<InstallationRecord>(INSTALLATION_SECURE_KEY);
  if (existing?.installationId && isValidInstallationId(existing.installationId)) {
    logLicense('installation_id_source', {
      source: 'secure_store',
      installationId: redactInstallationId(existing.installationId),
    });
    return existing.installationId;
  }

  const legacy = await readLegacyDeviceId();
  if (legacy) {
    const record: InstallationRecord = {
      installationId: legacy,
      createdAt: new Date().toISOString(),
      migratedFrom: Constants.installationId?.trim() === legacy ? 'expo' : 'legacy_file',
    };
    await persistInstallation(record);
    logLicense('installation_id_source', {
      source: record.migratedFrom,
      installationId: redactInstallationId(legacy),
    });
    return legacy;
  }

  const fromPrivacyConsent = await readPrivacyConsentInstallationId();
  if (fromPrivacyConsent) {
    const record: InstallationRecord = {
      installationId: fromPrivacyConsent,
      createdAt: new Date().toISOString(),
      migratedFrom: 'privacy_consent',
    };
    await persistInstallation(record);
    logLicense('installation_id_source', {
      source: 'privacy_consent',
      installationId: redactInstallationId(fromPrivacyConsent),
    });
    return fromPrivacyConsent;
  }

  const generated = createReactNativeSafeInstallationId();
  const record: InstallationRecord = {
    installationId: generated,
    createdAt: new Date().toISOString(),
    migratedFrom: 'generated',
  };
  const persisted = await persistInstallation(record);
  if (!persisted) {
    runtimeLogger.warn('INSTALLATION_ID_PERSIST_FAILED', undefined, {
      source: 'local',
      stage: 'write',
      status: 'failed',
    });
  }
  logLicense('installation_id_source', {
    source: 'generated_fallback',
    installationId: redactInstallationId(generated),
    persisted,
  });
  runtimeLogger.info('INSTALLATION_ID_GENERATED', {
    stage: 'bootstrap',
    status: 'completed',
  });
  return generated;
}

export async function readInstallationRecord(): Promise<InstallationRecord | null> {
  return readSecureJson<InstallationRecord>(INSTALLATION_SECURE_KEY);
}

/** Removes legacy plaintext device id file after migration (best effort). */
export async function purgeLegacyDeviceIdFile(): Promise<void> {
  const uri = legacyDeviceFileUri();
  if (!uri) return;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  } catch (error) {
    runtimeLogger.warn('LEGACY_DEVICE_ID_DELETE_FAILED', error, {
      source: 'filesystem',
      stage: 'delete',
      status: 'failed',
    });
  }
}

import * as FileSystem from 'expo-file-system/legacy';
import { FALLBACK_PRIVACY_POLICY_VERSION } from './privacy-config';
import { logPrivacyConsent } from './privacy-consent-log';
import { runtimeLogger } from './safe-runtime-logger';

export type PrivacyConsentBackendSyncStatus = 'pending' | 'synced' | 'failed';

export interface PrivacyConsentRecord {
  policyVersion: string;
  acknowledgedAt: string;
  installationId: string;
  licenseId: string | null;
  accepted: boolean;
  backendSyncStatus?: PrivacyConsentBackendSyncStatus;
  backendAcceptedAt?: string | null;
}

export const PRIVACY_CONSENT_FILENAME = 'privacy-consent.json';

function consentFileUri(): string | null {
  const root = FileSystem.documentDirectory;
  if (!root) return null;
  return `${root}${PRIVACY_CONSENT_FILENAME}`;
}

const INSTALLATION_ID_MIN_LENGTH = 8;

/** RN/Android safe — does not rely on crypto.getRandomValues (uuid v4 breaks on device). */
export function createPrivacyConsentInstallationFallback(): string {
  return `bs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function isValidInstallationId(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= INSTALLATION_ID_MIN_LENGTH &&
    trimmed.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(trimmed)
  );
}

export async function getPrivacyConsentRecord(): Promise<PrivacyConsentRecord | null> {
  const uri = consentFileUri();
  if (!uri) return null;

  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;

    const raw = await FileSystem.readAsStringAsync(uri);
    const parsed = JSON.parse(raw) as PrivacyConsentRecord;
    if (!parsed?.accepted || !parsed.policyVersion || !parsed.installationId) {
      return null;
    }
    return parsed;
  } catch (error) {
    runtimeLogger.warn('PRIVACY_CONSENT_LOAD_FAILED', error, {
      source: 'filesystem',
      stage: 'read',
      status: 'failed',
    });
    return null;
  }
}

/**
 * Returns consent only when accepted for the expected privacy version.
 * Pass the resolved DB/cache/fallback version from resolvePrivacySettings().
 */
export async function getPrivacyConsent(
  expectedPolicyVersion: string = FALLBACK_PRIVACY_POLICY_VERSION
): Promise<PrivacyConsentRecord | null> {
  const parsed = await getPrivacyConsentRecord();
  if (!parsed) return null;
  if (String(parsed.policyVersion) !== String(expectedPolicyVersion)) {
    return null;
  }
  return parsed;
}

export async function hasValidPrivacyConsent(
  expectedPolicyVersion: string = FALLBACK_PRIVACY_POLICY_VERSION
): Promise<boolean> {
  const record = await getPrivacyConsent(expectedPolicyVersion);
  return record?.accepted === true && Boolean(record.acknowledgedAt);
}

export async function savePrivacyConsent(input?: {
  installationId?: string;
  policyVersion?: string;
  licenseId?: string | null;
  backendSyncStatus?: PrivacyConsentBackendSyncStatus;
  backendAcceptedAt?: string | null;
}): Promise<PrivacyConsentRecord> {
  const uri = consentFileUri();
  if (!uri) {
    throw new Error('privacy_consent_document_directory_unavailable');
  }

  logPrivacyConsent('storage_write_start', { uri: PRIVACY_CONSENT_FILENAME });

  const installationIdRaw = input?.installationId?.trim() ?? '';
  const installationId = isValidInstallationId(installationIdRaw)
    ? installationIdRaw
    : createPrivacyConsentInstallationFallback();
  if (!isValidInstallationId(installationIdRaw)) {
    logPrivacyConsent('installation_id_source', { source: 'generated_fallback' });
  } else {
    logPrivacyConsent('installation_id_source', { source: 'provided' });
  }

  const record: PrivacyConsentRecord = {
    policyVersion: String(input?.policyVersion ?? FALLBACK_PRIVACY_POLICY_VERSION),
    acknowledgedAt: new Date().toISOString(),
    installationId,
    licenseId: input?.licenseId ?? null,
    accepted: true,
    backendSyncStatus: input?.backendSyncStatus ?? 'pending',
    backendAcceptedAt: input?.backendAcceptedAt ?? null,
  };

  try {
    await FileSystem.writeAsStringAsync(uri, JSON.stringify(record, null, 2));
    logPrivacyConsent('storage_write_ok', {
      policyVersion: record.policyVersion,
      backendSyncStatus: record.backendSyncStatus,
    });
    return record;
  } catch (error) {
    runtimeLogger.warn('PRIVACY_CONSENT_SAVE_FAILED', error, {
      source: 'filesystem',
      stage: 'write',
      status: 'failed',
    });
    logPrivacyConsent('storage_write_failed', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

export async function markPrivacyConsentBackendSynced(
  backendAcceptedAt: string
): Promise<PrivacyConsentRecord | null> {
  const existing = await getPrivacyConsentRecord();
  if (!existing?.accepted) return null;
  const uri = consentFileUri();
  if (!uri) return null;

  const next: PrivacyConsentRecord = {
    ...existing,
    backendSyncStatus: 'synced',
    backendAcceptedAt,
  };
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(next, null, 2));
  return next;
}

export async function markPrivacyConsentBackendFailed(): Promise<PrivacyConsentRecord | null> {
  const existing = await getPrivacyConsentRecord();
  if (!existing?.accepted) return null;
  const uri = consentFileUri();
  if (!uri) return null;

  const next: PrivacyConsentRecord = {
    ...existing,
    backendSyncStatus: 'failed',
  };
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(next, null, 2));
  return next;
}

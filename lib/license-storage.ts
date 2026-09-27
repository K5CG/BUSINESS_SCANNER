import * as FileSystem from 'expo-file-system/legacy';
import type { LicenseKind } from './license-config';
import type { CachedEntitlementProof } from './entitlement-state-machine';
import { computeOfflineValidUntil } from './entitlement-state-machine';
import { sourceFromLicenseKind } from './entitlement';
import {
  deleteSecureJson,
  readSecureJson,
  SECURE_KEY,
  writeSecureJson,
} from './license-secure-storage';
import { getInstallationId, purgeLegacyDeviceIdFile } from './installation-id';
import { runtimeLogger } from './safe-runtime-logger';

const LEGACY_STATE_FILE = 'license-state.json';
const UI_CACHE_FILE = 'license-ui-cache.json';

export interface StoredLicense {
  kind: Exclude<LicenseKind, 'trial'>;
  expiresAt: string;
  activatedAt: string;
  keyHint: string;
  customerEmail: string;
}

/** @deprecated Legacy shape — used only for migration from license-state.json */
export interface LicenseStateFile {
  customerEmail: string | null;
  lastServerCheckAt: string | null;
  trialExpiresAt: string | null;
  license: StoredLicense | null;
}

export interface SecureLicensePayload {
  version: 1;
  entitlementProof: CachedEntitlementProof | null;
  activatedLicense: StoredLicense | null;
}

export interface LicenseUiCache {
  lastBannerDismissedAt: string | null;
  lastOfflineNoticeAt: string | null;
}

function legacyStateUri(): string | null {
  const root = FileSystem.documentDirectory;
  if (!root) return null;
  return `${root}${LEGACY_STATE_FILE}`;
}

function uiCacheUri(): string | null {
  const root = FileSystem.documentDirectory;
  if (!root) return null;
  return `${root}${UI_CACHE_FILE}`;
}

async function readLegacyStateFile(): Promise<LicenseStateFile | null> {
  const uri = legacyStateUri();
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(uri);
    const parsed = JSON.parse(raw) as LicenseStateFile & { trialStartedAt?: string };
    return {
      customerEmail: parsed.customerEmail ?? null,
      lastServerCheckAt: parsed.lastServerCheckAt ?? null,
      trialExpiresAt: parsed.trialExpiresAt ?? null,
      license: parsed.license ?? null,
    };
  } catch {
    return null;
  }
}

async function deleteLegacyStateFile(): Promise<void> {
  const uri = legacyStateUri();
  if (!uri) return;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  } catch (error) {
    runtimeLogger.warn('LEGACY_LICENSE_STATE_DELETE_FAILED', error, {
      source: 'filesystem',
      stage: 'delete',
      status: 'failed',
    });
  }
}

function proofFromLegacy(
  legacy: LicenseStateFile,
  installationId: string
): CachedEntitlementProof | null {
  const lastVerifiedAt = legacy.lastServerCheckAt;
  if (!lastVerifiedAt) return null;

  if (legacy.license) {
    return {
      source: 'manual_b2b',
      plan: legacy.license.kind,
      entitlementExpiresAt: legacy.license.expiresAt,
      trialExpiresAt: legacy.trialExpiresAt,
      trialStartedAt: null,
      lastVerifiedAt,
      offlineValidUntil: computeOfflineValidUntil(lastVerifiedAt),
      installationId,
      licenseId: null,
      keyHint: legacy.license.keyHint,
      customerEmail: legacy.license.customerEmail,
    };
  }

  if (legacy.trialExpiresAt) {
    return {
      source: 'trial',
      plan: 'trial',
      entitlementExpiresAt: legacy.trialExpiresAt,
      trialExpiresAt: legacy.trialExpiresAt,
      trialStartedAt: null,
      lastVerifiedAt,
      offlineValidUntil: computeOfflineValidUntil(lastVerifiedAt),
      installationId,
      licenseId: null,
      keyHint: null,
      customerEmail: legacy.customerEmail,
    };
  }

  return null;
}

let migrationPromise: Promise<void> | null = null;

export async function ensureLicenseStorageMigrated(): Promise<void> {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    const existing = await readSecureJson<SecureLicensePayload>(SECURE_KEY);
    if (existing?.version === 1) {
      await purgeLegacyDeviceIdFile();
      return;
    }

    const legacy = await readLegacyStateFile();
    const installationId = await getInstallationId();
    if (!legacy) return;

    const proof = proofFromLegacy(legacy, installationId);
    const payload: SecureLicensePayload = {
      version: 1,
      entitlementProof: proof,
      activatedLicense: legacy.license,
    };
    const written = await writeSecureJson(payload, SECURE_KEY);
    if (written) {
      await deleteLegacyStateFile();
      await purgeLegacyDeviceIdFile();
      runtimeLogger.info('LICENSE_STATE_MIGRATED', {
        stage: 'migration',
        status: 'completed',
      });
    }
  })();
  return migrationPromise;
}

export async function readSecureLicensePayload(): Promise<SecureLicensePayload | null> {
  await ensureLicenseStorageMigrated();
  const payload = await readSecureJson<SecureLicensePayload>(SECURE_KEY);
  if (payload?.version === 1) return payload;
  return null;
}

export async function readCachedEntitlementProof(): Promise<CachedEntitlementProof | null> {
  const payload = await readSecureLicensePayload();
  return payload?.entitlementProof ?? null;
}

/** @deprecated Prefer readCachedEntitlementProof — kept for transitional callers. */
export async function readLicenseState(): Promise<LicenseStateFile | null> {
  const payload = await readSecureLicensePayload();
  if (!payload) return null;
  const proof = payload.entitlementProof;
  return {
    customerEmail: proof?.customerEmail ?? payload.activatedLicense?.customerEmail ?? null,
    lastServerCheckAt: proof?.lastVerifiedAt ?? null,
    trialExpiresAt: proof?.trialExpiresAt ?? null,
    license: payload.activatedLicense,
  };
}

async function writeSecurePayload(payload: SecureLicensePayload): Promise<void> {
  await writeSecureJson(payload, SECURE_KEY);
}

export async function saveLicenseStateFromServer(params: {
  kind: LicenseKind;
  expiresAt: string;
  trialStartedAt?: string | null;
  trialScanCount?: number;
  trialMaxScans?: number;
  trialDeviceStatus?: string | null;
  customerEmail: string | null;
  keyHint: string | null;
  licenseId?: string | null;
}): Promise<void> {
  await ensureLicenseStorageMigrated();
  const installationId = await getInstallationId();
  const now = new Date().toISOString();
  const existing = await readSecureLicensePayload();

  let activatedLicense = existing?.activatedLicense ?? null;
  if (params.kind === 'premium' || params.kind === 'test') {
    activatedLicense = {
      kind: params.kind,
      expiresAt: params.expiresAt,
      activatedAt: activatedLicense?.activatedAt ?? now,
      keyHint: params.keyHint ?? activatedLicense?.keyHint ?? '',
      customerEmail: params.customerEmail ?? activatedLicense?.customerEmail ?? '',
    };
  }

  const proof: CachedEntitlementProof = {
    source: sourceFromLicenseKind(params.kind),
    plan: params.kind,
    entitlementExpiresAt: params.expiresAt,
    trialExpiresAt: params.kind === 'trial' ? params.expiresAt : existing?.entitlementProof?.trialExpiresAt ?? null,
    trialStartedAt:
      params.kind === 'trial'
        ? params.trialStartedAt ?? existing?.entitlementProof?.trialStartedAt ?? null
        : existing?.entitlementProof?.trialStartedAt ?? null,
    trialScanCount:
      params.kind === 'trial'
        ? params.trialScanCount ?? existing?.entitlementProof?.trialScanCount
        : existing?.entitlementProof?.trialScanCount,
    trialMaxScans:
      params.kind === 'trial'
        ? params.trialMaxScans ?? existing?.entitlementProof?.trialMaxScans
        : existing?.entitlementProof?.trialMaxScans,
    trialDeviceStatus:
      params.kind === 'trial'
        ? params.trialDeviceStatus ?? existing?.entitlementProof?.trialDeviceStatus ?? null
        : existing?.entitlementProof?.trialDeviceStatus ?? null,
    lastVerifiedAt: now,
    offlineValidUntil: computeOfflineValidUntil(now),
    installationId,
    licenseId: params.licenseId ?? existing?.entitlementProof?.licenseId ?? null,
    keyHint: params.keyHint ?? activatedLicense?.keyHint ?? null,
    customerEmail:
      params.customerEmail ??
      existing?.entitlementProof?.customerEmail ??
      activatedLicense?.customerEmail ??
      null,
  };

  await writeSecurePayload({
    version: 1,
    entitlementProof: proof,
    activatedLicense,
  });
}

export async function saveActivatedLicense(license: StoredLicense): Promise<void> {
  await ensureLicenseStorageMigrated();
  const installationId = await getInstallationId();
  const now = new Date().toISOString();
  const existing = await readSecureLicensePayload();

  const proof: CachedEntitlementProof = {
    source: 'manual_b2b',
    plan: license.kind,
    entitlementExpiresAt: license.expiresAt,
    trialExpiresAt: existing?.entitlementProof?.trialExpiresAt ?? null,
    trialStartedAt: existing?.entitlementProof?.trialStartedAt ?? null,
    lastVerifiedAt: now,
    offlineValidUntil: computeOfflineValidUntil(now),
    installationId,
    licenseId: existing?.entitlementProof?.licenseId ?? null,
    keyHint: license.keyHint,
    customerEmail: license.customerEmail,
  };

  await writeSecurePayload({
    version: 1,
    entitlementProof: proof,
    activatedLicense: license,
  });
}

export async function readLicenseUiCache(): Promise<LicenseUiCache> {
  const uri = uiCacheUri();
  if (!uri) {
    return { lastBannerDismissedAt: null, lastOfflineNoticeAt: null };
  }
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) {
      return { lastBannerDismissedAt: null, lastOfflineNoticeAt: null };
    }
    return JSON.parse(await FileSystem.readAsStringAsync(uri)) as LicenseUiCache;
  } catch {
    return { lastBannerDismissedAt: null, lastOfflineNoticeAt: null };
  }
}

export async function clearSecureLicenseState(): Promise<void> {
  await deleteSecureJson(SECURE_KEY);
}

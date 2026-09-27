import { OFFLINE_GRACE_DAYS, isValidEmail, normalizeEmail, type LicenseKind } from './license-config';
import type { Entitlement } from './entitlement';
import { isEntitlementAccessGranted } from './entitlement';
import {
  buildEntitlementFromCache,
  buildEntitlementFromServer,
  emptyEntitlement,
  entitlementToLicenseStatusView,
  mapEntitlementToLegacyAccess,
  type ServerEntitlementSnapshot,
} from './entitlement-state-machine';
import { getInstallationId } from './installation-id';
import {
  readCachedEntitlementProof,
  saveActivatedLicense,
  saveLicenseStateFromServer,
  type StoredLicense,
} from './license-storage';
import {
  logLicense,
  redactInstallationId,
  sanitizeLicenseCheckResponseBody,
} from './license-log';
import { callSupabaseFunction, isSupabaseConfigured } from './supabase-functions';
import { getSupabaseUrl } from './config';

export type LicenseAccess =
  | 'loading'
  | 'active'
  | 'expired'
  | 'offline_blocked'
  | 'offline_grace'
  | 'revoked'
  | 'network_unknown';

export interface LicenseStatus {
  access: LicenseAccess;
  entitlement: Entitlement;
  kind: LicenseKind | null;
  expiresAt: Date | null;
  daysRemaining: number;
  trialEndsAt: Date | null;
  trialScanCount: number | null;
  trialMaxScans: number | null;
  trialScansRemaining: number | null;
  trialDeviceStatus: string | null;
  keyHint: string | null;
  customerEmail: string | null;
  aiCreditsTotal: number | null;
  aiCreditsUsed: number | null;
  aiCreditsRemaining: number | null;
}

export interface ActivateLicenseResult {
  ok: boolean;
  error?: string;
  status?: LicenseStatus;
}

interface CheckLicenseResponse {
  access: 'active' | 'expired';
  kind?: LicenseKind;
  expiresAt?: string;
  trialStartedAt?: string | null;
  trialScanCount?: number;
  trialMaxScans?: number;
  trialScansRemaining?: number;
  trialDeviceStatus?: string | null;
  customerEmail?: string | null;
  keyHint?: string | null;
  licenseId?: string | null;
  revoked?: boolean;
  aiCreditsRemaining?: number;
  aiCreditsTotal?: number;
  aiCreditsUsed?: number;
  errorCode?: string;
  error?: string;
}

interface ValidateLicenseResponse {
  valid: boolean;
  licenseType?: 'test' | 'premium';
  expiresAt?: string;
  customerEmail?: string;
  licenseId?: string | null;
  aiCreditsRemaining?: number;
  aiCreditsTotal?: number;
  aiCreditsUsed?: number;
  errorCode?: string;
  error?: string;
}

const LOADING_ENTITLEMENT = emptyEntitlement('', 'LOADING');

function normalizeCreditField(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  return Math.max(0, value);
}

function entitlementToStatus(
  entitlement: Entitlement,
  aiCreditsRemaining: number | null = null,
  aiCreditsTotal: number | null = null,
  aiCreditsUsed: number | null = null
): LicenseStatus {
  const view = entitlementToLicenseStatusView(entitlement);
  const access = mapEntitlementToLegacyAccess(entitlement);

  return {
    access: isEntitlementAccessGranted(entitlement) ? access : access,
    entitlement,
    kind: view.kind,
    expiresAt: view.expiresAt,
    daysRemaining: view.daysRemaining,
    trialEndsAt: view.trialEndsAt,
    trialScanCount: view.trialScanCount,
    trialMaxScans: view.trialMaxScans,
    trialScansRemaining: view.trialScansRemaining,
    trialDeviceStatus: entitlement.trialQuota?.trialDeviceStatus ?? null,
    keyHint: view.keyHint,
    customerEmail: view.customerEmail,
    aiCreditsTotal,
    aiCreditsUsed,
    aiCreditsRemaining,
  };
}

function creditsFromServer(data: {
  aiCreditsRemaining?: unknown;
  aiCreditsTotal?: unknown;
  aiCreditsUsed?: unknown;
}): Pick<LicenseStatus, 'aiCreditsRemaining' | 'aiCreditsTotal' | 'aiCreditsUsed'> {
  const remaining = normalizeCreditField(data.aiCreditsRemaining);
  const total = normalizeCreditField(data.aiCreditsTotal);
  const used = normalizeCreditField(data.aiCreditsUsed);
  return {
    aiCreditsRemaining: remaining,
    aiCreditsTotal: total,
    aiCreditsUsed: used,
  };
}

export function normalizeLicenseKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

function keyHintFromKey(key: string): string {
  const normalized = normalizeLicenseKey(key);
  return normalized.length <= 4 ? normalized : normalized.slice(-4);
}

function mapServerErrorCode(code?: string): string {
  switch (code) {
    case 'email_required':
      return 'email_required';
    case 'email_invalid':
      return 'email_invalid';
    case 'email_mismatch':
      return 'email_mismatch';
    case 'max_devices':
      return 'max_devices';
    case 'revoked':
      return 'revoked';
    case 'expired_key':
      return 'expired_key';
    case 'activation_failed':
      return 'activation_failed';
    case 'rate_limited':
      return 'rate_limited';
    case 'server_error':
      return 'server_error';
    default:
      return 'invalid_key';
  }
}

function statusFromCheckResponse(
  data: CheckLicenseResponse,
  installationId: string
): LicenseStatus {
  const verifiedAt = new Date().toISOString();
  const snapshot: ServerEntitlementSnapshot = {
    access: data.access,
    kind: data.kind,
    expiresAt: data.expiresAt,
    trialStartedAt: data.trialStartedAt,
    trialScanCount: data.trialScanCount,
    trialMaxScans: data.trialMaxScans,
    trialDeviceStatus: data.trialDeviceStatus,
    customerEmail: data.customerEmail,
    keyHint: data.keyHint,
    licenseId: data.licenseId,
    revoked: data.revoked,
  };
  const credits = creditsFromServer(data);
  const entitlement = buildEntitlementFromServer(
    snapshot,
    installationId,
    verifiedAt,
    credits.aiCreditsRemaining
  );
  return entitlementToStatus(
    entitlement,
    credits.aiCreditsRemaining,
    credits.aiCreditsTotal,
    credits.aiCreditsUsed
  );
}

function supabaseHost(): string | null {
  const url = getSupabaseUrl();
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  logLicense('check_start');
  logLicense('network_state', {
    configured: isSupabaseConfigured(),
    supabaseHost: supabaseHost(),
  });

  const installationId = await getInstallationId();

  if (!isSupabaseConfigured()) {
    const status = entitlementToStatus(emptyEntitlement(installationId, 'INVALID'));
    logLicense('entitlement_result', {
      status: status.entitlement.status,
      access: status.access,
      reason: 'supabase_not_configured',
    });
    return status;
  }

  const cachedProof = await readCachedEntitlementProof();
  logLicense('cached_entitlement', {
    present: Boolean(cachedProof),
    lastVerifiedAt: cachedProof?.lastVerifiedAt ?? null,
  });

  const email = cachedProof?.customerEmail ?? '';

  logLicense('endpoint', { name: 'check-license' });
  const { data, error, status: httpStatus, errorCode } = await callSupabaseFunction<CheckLicenseResponse>(
    'check-license',
    {
      installationId,
      deviceId: installationId,
      ...(email ? { email } : {}),
    }
  );

  logLicense('response_status', { httpStatus, error: error ?? null, errorCode: errorCode ?? null });
  logLicense('response_body_sanitized', sanitizeLicenseCheckResponseBody(
    data as Record<string, unknown> | null,
    httpStatus,
    errorCode
  ));

  if (data && !error) {
    await saveLicenseStateFromServer({
      kind: data.kind ?? 'trial',
      expiresAt: data.expiresAt ?? new Date().toISOString(),
      trialStartedAt: data.trialStartedAt ?? null,
      trialScanCount: data.trialScanCount,
      trialMaxScans: data.trialMaxScans,
      trialDeviceStatus: data.trialDeviceStatus ?? null,
      customerEmail: data.customerEmail ?? cachedProof?.customerEmail ?? null,
      keyHint: data.keyHint ?? cachedProof?.keyHint ?? null,
      licenseId: data.licenseId ?? null,
    });
    const status = statusFromCheckResponse(data, installationId);
    logLicense('entitlement_result', {
      status: status.entitlement.status,
      access: status.access,
      kind: status.kind,
      installationId: redactInstallationId(installationId),
    });
    return status;
  }

  if (cachedProof) {
    const offlineEntitlement = buildEntitlementFromCache(cachedProof);
    if (isEntitlementAccessGranted(offlineEntitlement)) {
      const status = entitlementToStatus(offlineEntitlement);
      logLicense('entitlement_result', {
        status: status.entitlement.status,
        access: status.access,
        reason: 'offline_cache_granted',
      });
      return status;
    }
    if (offlineEntitlement.status === 'NETWORK_UNKNOWN') {
      const status = entitlementToStatus(offlineEntitlement);
      logLicense('entitlement_result', {
        status: status.entitlement.status,
        access: status.access,
        reason: 'offline_cache_network_unknown',
      });
      return status;
    }
  }

  if (httpStatus === 0) {
    logLicense('check_network_unreachable');
    const status = entitlementToStatus(emptyEntitlement(installationId, 'NETWORK_UNKNOWN'));
    logLicense('entitlement_result', {
      status: status.entitlement.status,
      access: status.access,
      reason: 'network_unreachable',
    });
    return status;
  }

  if (!cachedProof?.lastVerifiedAt) {
    logLicense('check_http_error', { httpStatus, errorCode: errorCode ?? null });
    const status = entitlementToStatus(emptyEntitlement(installationId, 'INVALID'));
    logLicense('entitlement_result', {
      status: status.entitlement.status,
      access: status.access,
      reason: 'first_launch_http_error',
    });
    return status;
  }

  const status = entitlementToStatus(emptyEntitlement(installationId, 'EXPIRED'));
  logLicense('entitlement_result', {
    status: status.entitlement.status,
    access: status.access,
    reason: 'expired_fallback',
  });
  return status;
}

export async function activateLicense(
  rawEmail: string,
  rawKey: string
): Promise<ActivateLicenseResult> {
  const email = normalizeEmail(rawEmail);
  const licenseKey = normalizeLicenseKey(rawKey);

  if (!email) {
    return { ok: false, error: 'email_required' };
  }
  if (!isValidEmail(email)) {
    return { ok: false, error: 'email_invalid' };
  }
  if (!licenseKey) {
    return { ok: false, error: 'empty_key' };
  }
  if (!isSupabaseConfigured()) {
    return { ok: false, error: 'supabase_not_configured' };
  }

  const installationId = await getInstallationId();
  const { data, error, errorCode } = await callSupabaseFunction<ValidateLicenseResponse>(
    'validate-license',
    { licenseKey, installationId, deviceId: installationId, email }
  );

  if (error || !data?.valid || !data.licenseType || !data.expiresAt) {
    return {
      ok: false,
      error: mapServerErrorCode(data?.errorCode ?? errorCode) ?? 'invalid_key',
    };
  }

  const expiresAt = new Date(data.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: 'expired_key' };
  }

  const stored: StoredLicense = {
    kind: data.licenseType,
    expiresAt: expiresAt.toISOString(),
    activatedAt: new Date().toISOString(),
    keyHint: keyHintFromKey(licenseKey),
    customerEmail: data.customerEmail ?? email,
  };
  await saveActivatedLicense(stored);

  const entitlement = buildEntitlementFromServer(
    {
      access: 'active',
      kind: data.licenseType,
      expiresAt: expiresAt.toISOString(),
      customerEmail: stored.customerEmail,
      keyHint: stored.keyHint,
      licenseId: data.licenseId ?? null,
    },
    installationId,
    new Date().toISOString(),
    creditsFromServer(data).aiCreditsRemaining
  );

  const credits = creditsFromServer(data);
  const status = entitlementToStatus(
    entitlement,
    credits.aiCreditsRemaining,
    credits.aiCreditsTotal,
    credits.aiCreditsUsed
  );
  return { ok: true, status };
}

export { OFFLINE_GRACE_DAYS };

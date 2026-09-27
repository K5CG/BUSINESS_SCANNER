import { OFFLINE_GRACE_DAYS } from './license-config';
import {
  DEFAULT_ENTITLEMENT_FEATURES,
  type Entitlement,
  type EntitlementFeatures,
  type EntitlementSource,
  type EntitlementStatus,
  type EntitlementTrialQuota,
  entitlementDaysRemaining,
  planFromLicenseKind,
  sourceFromLicenseKind,
} from './entitlement';
import type { LicenseKind } from './license-config';
import {
  normalizeTrialDeviceStatus,
  trialIsActive,
  trialScansRemaining,
  type TrialDeviceStatus,
} from './trial-status';

export interface ServerEntitlementSnapshot {
  access: 'active' | 'expired';
  kind?: LicenseKind;
  expiresAt?: string;
  trialStartedAt?: string | null;
  customerEmail?: string | null;
  keyHint?: string | null;
  licenseId?: string | null;
  revoked?: boolean;
  trialScanCount?: number;
  trialMaxScans?: number;
  trialDeviceStatus?: TrialDeviceStatus | string | null;
}

export interface CachedEntitlementProof {
  source: EntitlementSource;
  plan: Exclude<LicenseKind, never>;
  entitlementExpiresAt: string;
  trialExpiresAt: string | null;
  trialStartedAt: string | null;
  trialScanCount?: number;
  trialMaxScans?: number;
  trialDeviceStatus?: TrialDeviceStatus | string | null;
  lastVerifiedAt: string;
  offlineValidUntil: string;
  installationId: string;
  licenseId: string | null;
  keyHint: string | null;
  customerEmail: string | null;
}

function addDaysIso(fromIso: string, days: number): string {
  const d = new Date(fromIso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function isFuture(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t > Date.now();
}

function trialQuotaFromSnapshot(
  snapshot: Pick<
    ServerEntitlementSnapshot,
    'trialScanCount' | 'trialMaxScans' | 'trialDeviceStatus' | 'expiresAt' | 'trialStartedAt'
  >
): EntitlementTrialQuota | null {
  if (snapshot.trialMaxScans === undefined && snapshot.trialScanCount === undefined) {
    return null;
  }
  const maxScans = Math.max(0, snapshot.trialMaxScans ?? 0);
  const scanCount = Math.max(0, snapshot.trialScanCount ?? 0);
  return {
    scanCount,
    maxScans,
    scansRemaining: trialScansRemaining({ scanCount, maxScans }),
    trialDeviceStatus: snapshot.trialDeviceStatus
      ? normalizeTrialDeviceStatus(snapshot.trialDeviceStatus)
      : null,
  };
}

function trialQuotaFromCache(proof: CachedEntitlementProof): EntitlementTrialQuota | null {
  if (proof.trialMaxScans === undefined && proof.trialScanCount === undefined) {
    return null;
  }
  const maxScans = Math.max(0, proof.trialMaxScans ?? 0);
  const scanCount = Math.max(0, proof.trialScanCount ?? 0);
  return {
    scanCount,
    maxScans,
    scansRemaining: trialScansRemaining({ scanCount, maxScans }),
    trialDeviceStatus: proof.trialDeviceStatus
      ? normalizeTrialDeviceStatus(proof.trialDeviceStatus)
      : null,
  };
}

function featuresForTrial(
  snapshot: ServerEntitlementSnapshot,
  aiCreditsRemaining: number | null
): EntitlementFeatures {
  const quota = trialQuotaFromSnapshot(snapshot);
  const trialActive =
    snapshot.kind === 'trial' &&
    snapshot.expiresAt &&
    isFuture(snapshot.expiresAt) &&
    (quota
      ? trialIsActive({
          trialStartedAt: snapshot.trialStartedAt ?? null,
          trialExpiresAt: snapshot.expiresAt,
          scanCount: quota.scanCount,
          maxScans: quota.maxScans,
          status: normalizeTrialDeviceStatus(snapshot.trialDeviceStatus ?? 'active'),
        })
      : true);

  return {
    scan: Boolean(trialActive),
    export: Boolean(trialActive),
    cloudAi: aiCreditsRemaining === null ? true : aiCreditsRemaining > 0,
  };
}

export function computeOfflineValidUntil(lastVerifiedAt: string): string {
  return addDaysIso(lastVerifiedAt, OFFLINE_GRACE_DAYS);
}

export function buildEntitlementFromServer(
  snapshot: ServerEntitlementSnapshot,
  installationId: string,
  verifiedAtIso: string,
  aiCreditsRemaining: number | null = null
): Entitlement {
  const plan = planFromLicenseKind(snapshot.kind);
  const source = sourceFromLicenseKind(snapshot.kind);
  const expiresAt = snapshot.expiresAt ?? null;
  const trialQuota =
    snapshot.kind === 'trial' ? trialQuotaFromSnapshot(snapshot) : null;

  if (snapshot.revoked) {
    return emptyEntitlement(installationId, 'REVOKED', source, plan);
  }

  const trialTimeOk = expiresAt && isFuture(expiresAt);
  const trialScansOk =
    snapshot.kind !== 'trial' ||
    !trialQuota ||
    trialIsActive({
      trialStartedAt: snapshot.trialStartedAt ?? null,
      trialExpiresAt: expiresAt,
      scanCount: trialQuota.scanCount,
      maxScans: trialQuota.maxScans,
      status: normalizeTrialDeviceStatus(snapshot.trialDeviceStatus ?? 'active'),
    });

  if (
    snapshot.access === 'active' &&
    trialTimeOk &&
    trialScansOk &&
    snapshot.kind
  ) {
    const status: EntitlementStatus =
      snapshot.kind === 'trial' ? 'TRIAL' : 'VALID_ONLINE';
    const features =
      snapshot.kind === 'trial'
        ? featuresForTrial(snapshot, aiCreditsRemaining)
        : DEFAULT_ENTITLEMENT_FEATURES;
    return {
      status,
      source,
      plan,
      features,
      trialStartedAt: snapshot.trialStartedAt ?? null,
      trialExpiresAt: snapshot.kind === 'trial' ? expiresAt : null,
      trialQuota,
      entitlementExpiresAt: expiresAt,
      lastVerifiedAt: verifiedAtIso,
      offlineValidUntil: computeOfflineValidUntil(verifiedAtIso),
      installationId,
      licenseId: snapshot.licenseId ?? null,
      keyHint: snapshot.keyHint ?? null,
      customerEmail: snapshot.customerEmail ?? null,
    };
  }

  return {
    status: 'EXPIRED',
    source,
    plan,
    features: { scan: false, export: true, cloudAi: false },
    trialStartedAt: snapshot.trialStartedAt ?? null,
    trialExpiresAt: snapshot.kind === 'trial' ? expiresAt : null,
    trialQuota,
    entitlementExpiresAt: expiresAt,
    lastVerifiedAt: verifiedAtIso,
    offlineValidUntil: computeOfflineValidUntil(verifiedAtIso),
    installationId,
    licenseId: snapshot.licenseId ?? null,
    keyHint: null,
    customerEmail: snapshot.customerEmail ?? null,
  };
}

export function buildEntitlementFromCache(
  proof: CachedEntitlementProof,
  nowMs = Date.now()
): Entitlement {
  const expiresOk = isFuture(proof.entitlementExpiresAt);
  const graceOk = new Date(proof.offlineValidUntil).getTime() > nowMs;

  if (expiresOk && graceOk) {
    const status: EntitlementStatus =
      proof.plan === 'trial' ? 'TRIAL' : 'VALID_OFFLINE_GRACE';
    const trialQuota = proof.plan === 'trial' ? trialQuotaFromCache(proof) : null;
    return {
      status,
      source: proof.source,
      plan: proof.plan,
      features: DEFAULT_ENTITLEMENT_FEATURES,
      trialStartedAt: proof.trialStartedAt,
      trialExpiresAt: proof.trialExpiresAt,
      trialQuota,
      entitlementExpiresAt: proof.entitlementExpiresAt,
      lastVerifiedAt: proof.lastVerifiedAt,
      offlineValidUntil: proof.offlineValidUntil,
      installationId: proof.installationId,
      licenseId: proof.licenseId,
      keyHint: proof.keyHint,
      customerEmail: proof.customerEmail,
    };
  }

  if (!graceOk && expiresOk) {
    return emptyEntitlement(proof.installationId, 'NETWORK_UNKNOWN', proof.source, proof.plan);
  }

  return emptyEntitlement(proof.installationId, 'EXPIRED', proof.source, proof.plan);
}

export function emptyEntitlement(
  installationId: string,
  status: EntitlementStatus,
  source: EntitlementSource = 'trial',
  plan: Entitlement['plan'] = 'unknown'
): Entitlement {
  const expiredReadOnly = status === 'EXPIRED';
  return {
    status,
    source,
    plan,
    features: {
      scan: false,
      export: expiredReadOnly,
      cloudAi: false,
    },
    trialStartedAt: null,
    trialExpiresAt: null,
    trialQuota: null,
    entitlementExpiresAt: null,
    lastVerifiedAt: null,
    offlineValidUntil: null,
    installationId,
    licenseId: null,
    keyHint: null,
    customerEmail: null,
  };
}

/** Maps entitlement to legacy LicenseStatus.access for existing UI gates. */
export function mapEntitlementToLegacyAccess(
  entitlement: Entitlement
): 'loading' | 'active' | 'expired' | 'offline_blocked' | 'offline_grace' | 'revoked' | 'network_unknown' {
  switch (entitlement.status) {
    case 'LOADING':
      return 'loading';
    case 'VALID_ONLINE':
    case 'TRIAL':
      return 'active';
    case 'VALID_OFFLINE_GRACE':
      return 'offline_grace';
    case 'REVOKED':
      return 'revoked';
    case 'NETWORK_UNKNOWN':
      return 'network_unknown';
    case 'EXPIRED':
    case 'INVALID':
    default:
      return 'expired';
  }
}

export function entitlementToLicenseStatusView(entitlement: Entitlement): {
  kind: LicenseKind | null;
  expiresAt: Date | null;
  daysRemaining: number;
  trialEndsAt: Date | null;
  trialScanCount: number | null;
  trialMaxScans: number | null;
  trialScansRemaining: number | null;
  keyHint: string | null;
  customerEmail: string | null;
} {
  const expiresAt = entitlement.entitlementExpiresAt
    ? new Date(entitlement.entitlementExpiresAt)
    : null;
  const kind =
    entitlement.plan === 'unknown' ? null : (entitlement.plan as LicenseKind);
  return {
    kind,
    expiresAt,
    daysRemaining: entitlementDaysRemaining(entitlement.entitlementExpiresAt),
    trialEndsAt:
      entitlement.plan === 'trial' && entitlement.trialExpiresAt
        ? new Date(entitlement.trialExpiresAt)
        : null,
    trialScanCount: entitlement.trialQuota?.scanCount ?? null,
    trialMaxScans: entitlement.trialQuota?.maxScans ?? null,
    trialScansRemaining: entitlement.trialQuota?.scansRemaining ?? null,
    keyHint: entitlement.keyHint,
    customerEmail: entitlement.customerEmail,
  };
}

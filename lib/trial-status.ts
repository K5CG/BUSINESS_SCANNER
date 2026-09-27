import { entitlementDaysRemaining } from './entitlement.ts';

/** Canonical trial lifecycle status (server `trial_devices.status`). */
export type TrialDeviceStatus =
  | 'active'
  | 'expired_time'
  | 'expired_scans'
  | 'disabled'
  | 'revoked'
  | 'abuse_blocked'
  /** Legacy rows from pre-3C.5 migration */
  | 'expired';

export interface TrialQuotaSnapshot {
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  scanCount: number;
  maxScans: number;
  status: TrialDeviceStatus;
  nowMs?: number;
}

export type TrialExpiryReason = 'time' | 'scans' | 'disabled' | null;

export function normalizeTrialDeviceStatus(raw: string | null | undefined): TrialDeviceStatus {
  switch (raw) {
    case 'active':
    case 'expired_time':
    case 'expired_scans':
    case 'disabled':
    case 'revoked':
    case 'abuse_blocked':
    case 'expired':
      return raw;
    default:
      return 'active';
  }
}

export function trialScansRemaining(snapshot: Pick<TrialQuotaSnapshot, 'scanCount' | 'maxScans'>): number {
  return Math.max(0, snapshot.maxScans - Math.max(0, snapshot.scanCount));
}

export function trialExpiryReason(snapshot: TrialQuotaSnapshot): TrialExpiryReason {
  const now = snapshot.nowMs ?? Date.now();
  const status = normalizeTrialDeviceStatus(snapshot.status);

  if (status === 'expired_time' || status === 'expired') {
    return 'time';
  }
  if (status === 'expired_scans') {
    return 'scans';
  }
  if (status === 'disabled' || status === 'revoked' || status === 'abuse_blocked') {
    return 'disabled';
  }

  const expiresAt = snapshot.trialExpiresAt ? new Date(snapshot.trialExpiresAt).getTime() : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return 'time';
  }
  if (snapshot.scanCount >= snapshot.maxScans) {
    return 'scans';
  }
  return null;
}

/**
 * Trial is active when time AND scan budget remain and status is active.
 * AI credit exhaustion does NOT affect this.
 */
export function trialIsActive(snapshot: TrialQuotaSnapshot): boolean {
  const status = normalizeTrialDeviceStatus(snapshot.status);
  if (status !== 'active') return false;
  return trialExpiryReason(snapshot) === null;
}

export function trialDaysRemaining(snapshot: Pick<TrialQuotaSnapshot, 'trialExpiresAt'>): number {
  return entitlementDaysRemaining(snapshot.trialExpiresAt);
}

export function resolveTrialAccess(
  snapshot: TrialQuotaSnapshot
): { active: boolean; reason: TrialExpiryReason } {
  const active = trialIsActive(snapshot);
  return { active, reason: active ? null : trialExpiryReason(snapshot) };
}

/** Map server trial status after expiry evaluation (for persistence). */
export function trialStatusAfterEvaluation(snapshot: TrialQuotaSnapshot): TrialDeviceStatus {
  if (!trialIsActive(snapshot)) {
    const reason = trialExpiryReason(snapshot);
    if (reason === 'scans') return 'expired_scans';
    if (reason === 'time') return 'expired_time';
    return normalizeTrialDeviceStatus(snapshot.status);
  }
  return 'active';
}

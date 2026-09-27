import type { LicenseKind } from './license-config.ts';
import { isRcCloudAiEnabled } from './release-rc-policy.ts';

/** Commercial / provisioning source — store channels reserved for future use. */
export type EntitlementSource =
  | 'trial'
  | 'manual_b2b'
  | 'google_play'
  | 'apple_app_store'
  | 'business_admin';

/** Canonical entitlement lifecycle status (not a boolean premium flag). */
export type EntitlementStatus =
  | 'VALID_ONLINE'
  | 'VALID_OFFLINE_GRACE'
  | 'TRIAL'
  | 'EXPIRED'
  | 'REVOKED'
  | 'NETWORK_UNKNOWN'
  | 'INVALID'
  | 'LOADING';

export type EntitlementPlan = LicenseKind | 'unknown';

export interface EntitlementFeatures {
  scan: boolean;
  export: boolean;
  cloudAi: boolean;
}

export interface EntitlementTrialQuota {
  scanCount: number;
  maxScans: number;
  scansRemaining: number;
  trialDeviceStatus: string | null;
}

export interface Entitlement {
  status: EntitlementStatus;
  source: EntitlementSource;
  plan: EntitlementPlan;
  features: EntitlementFeatures;
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  trialQuota: EntitlementTrialQuota | null;
  entitlementExpiresAt: string | null;
  lastVerifiedAt: string | null;
  offlineValidUntil: string | null;
  installationId: string;
  licenseId: string | null;
  keyHint: string | null;
  customerEmail: string | null;
}

export const DEFAULT_ENTITLEMENT_FEATURES: EntitlementFeatures = {
  scan: true,
  export: true,
  cloudAi: true,
};

export function planFromLicenseKind(kind: LicenseKind | null | undefined): EntitlementPlan {
  if (kind === 'trial' || kind === 'test' || kind === 'premium') return kind;
  return 'unknown';
}

export function sourceFromLicenseKind(kind: LicenseKind | null | undefined): EntitlementSource {
  if (kind === 'trial') return 'trial';
  if (kind === 'test' || kind === 'premium') return 'manual_b2b';
  return 'trial';
}

export function isEntitlementAccessGranted(entitlement: Entitlement): boolean {
  return (
    entitlement.status === 'VALID_ONLINE' ||
    entitlement.status === 'VALID_OFFLINE_GRACE' ||
    entitlement.status === 'TRIAL'
  );
}

/** Local OCR / scan — trial scan budget or premium. AI credits are separate. */
export function isEntitlementScanAllowed(entitlement: Entitlement): boolean {
  if (!isEntitlementAccessGranted(entitlement)) return false;
  if (entitlement.plan !== 'trial') return true;
  const quota = entitlement.trialQuota;
  if (!quota) return true;
  return quota.scansRemaining > 0;
}

/** Cloud AI — requires credits; trial may continue locally when zero. */
export function isEntitlementCloudAiAllowed(
  entitlement: Entitlement,
  aiCreditsRemaining: number | null
): boolean {
  if (!isRcCloudAiEnabled()) return false;
  if (!isEntitlementAccessGranted(entitlement)) return false;
  if (aiCreditsRemaining === null) return entitlement.features.cloudAi;
  return aiCreditsRemaining > 0;
}

export function entitlementDaysRemaining(expiresAtIso: string | null): number {
  if (!expiresAtIso) return 0;
  const expiresAt = new Date(expiresAtIso);
  if (Number.isNaN(expiresAt.getTime())) return 0;
  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const ms = startOfDay(expiresAt).getTime() - startOfDay(new Date()).getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

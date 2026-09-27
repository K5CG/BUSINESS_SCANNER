/**
 * Best-effort in-memory rate limiter for license Edge Functions.
 * Resets on cold start — full persistence requires SUPABASE_LICENSE_MIGRATION_DRAFT.sql.
 */

type Bucket = { count: number; windowStartMs: number };

const buckets = new Map<string, Bucket>();

export type LicenseRateLimitScope = 'check_license' | 'validate_license' | 'trial_create';

export interface LicenseRateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const DEFAULTS: Record<LicenseRateLimitScope, LicenseRateLimitConfig> = {
  check_license: { maxRequests: 60, windowMs: 60_000 },
  validate_license: { maxRequests: 20, windowMs: 60_000 },
  trial_create: { maxRequests: 10, windowMs: 86_400_000 },
};

function bucketKey(scope: LicenseRateLimitScope, fingerprint: string): string {
  return `${scope}:${fingerprint}`;
}

export function checkLicenseRateLimit(
  scope: LicenseRateLimitScope,
  fingerprint: string,
  config?: Partial<LicenseRateLimitConfig>
): { allowed: boolean; retryAfterSeconds: number } {
  const merged = { ...DEFAULTS[scope], ...config };
  const key = bucketKey(scope, fingerprint);
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStartMs >= merged.windowMs) {
    buckets.set(key, { count: 1, windowStartMs: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (existing.count >= merged.maxRequests) {
    const retryAfterMs = merged.windowMs - (now - existing.windowStartMs);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  existing.count += 1;
  buckets.set(key, existing);
  return { allowed: true, retryAfterSeconds: 0 };
}

export function resetLicenseRateLimitsForTests(): void {
  buckets.clear();
}

export function fingerprintFromInstallation(installationId: string): string {
  return installationId.slice(0, 64);
}

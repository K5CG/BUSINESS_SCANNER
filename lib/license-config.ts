import { TRIAL_CONFIG_DEFAULTS, trialDurationDaysFallback } from './trial-config.ts';

/**
 * Offline display fallback only — authoritative trial duration comes from Supabase
 * `app_commercial_settings.trial_duration_days` through the server resolver.
 * Safety fallback is 3 days. Do not use this constant for commercial gating.
 */
export const TRIAL_DAYS = TRIAL_CONFIG_DEFAULTS.trialDurationDays;

export { trialDurationDaysFallback };

/** Durata licenza premium (giorni). */
export const PREMIUM_DAYS = 365;

/** Durata licenza test/demo (giorni). */
export const TEST_LICENSE_DAYS = 15;

/** Giorni max offline dopo l'ultimo controllo licenza riuscito. */
export const OFFLINE_GRACE_DAYS = 7;

export type LicenseKind = 'trial' | 'test' | 'premium';

export function daysForLicenseKind(kind: Exclude<LicenseKind, 'trial'>): number {
  return kind === 'premium' ? PREMIUM_DAYS : TEST_LICENSE_DAYS;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

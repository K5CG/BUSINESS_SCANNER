/**
 * Premium AI monthly grant — idempotent per license + calendar month.
 * Store Billing integration deferred to Phase 3D.
 */

import type { TrialCommercialConfig } from './trial-config.ts';
import { TRIAL_CONFIG_DEFAULTS } from './trial-config.ts';

export function premiumMonthlyPeriodKey(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function premiumMonthlyGrantOperationId(
  licenseId: string,
  periodKey: string
): string {
  return `premium-monthly-grant:${licenseId}:${periodKey}`;
}

export function premiumMonthlyGrantReferenceId(
  licenseId: string,
  periodKey: string
): string {
  return `premium-monthly:${licenseId}:${periodKey}`;
}

export function isPremiumMonthlyReferenceId(referenceId: string | null | undefined): boolean {
  return typeof referenceId === 'string' && referenceId.startsWith('premium-monthly:');
}

export function resolvePremiumMonthlyGrantAmount(
  config: Pick<TrialCommercialConfig, 'aiPremiumMonthlyGrantCredits'>
): number | null {
  if (
    config.aiPremiumMonthlyGrantCredits !== null &&
    config.aiPremiumMonthlyGrantCredits >= 0
  ) {
    return config.aiPremiumMonthlyGrantCredits;
  }
  return null;
}

/** Local beta default when env explicitly sets monthly grant (documented as non-final). */
export function betaPremiumMonthlyGrantAmount(): number {
  return TRIAL_CONFIG_DEFAULTS.aiPremiumMonthlyGrantCreditsBeta;
}

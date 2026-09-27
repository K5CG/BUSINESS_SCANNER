/**
 * Server-side commercial trial configuration.
 *
 * Trial AI credits grant amount is resolved server-side via:
 *   lib/commercial-settings.ts → DB `app_commercial_settings.trial_ai_credits`
 *   with optional emergency ENV override and code fallback.
 *
 * Trial duration is resolved server-side from Supabase
 * `app_commercial_settings.trial_duration_days` (via setting_key), with an
 * emergency ENV override and a 3-day safety fallback.
 * Scan cap / premium monthly grant still use their existing configuration paths.
 * UI release policy remains controlled separately by `lib/release-rc-policy.ts`.
 *
 * Env keys (Supabase Edge secrets / local .env for Deno):
 *   TRIAL_DURATION_DAYS
 *   TRIAL_MAX_SCANS
 *   AI_TRIAL_GRANT_CREDITS — LEGACY; grant path uses commercial-settings resolver
 *   AI_TRIAL_GRANT_EMERGENCY_OVERRIDE — when true, AI_TRIAL_GRANT_CREDITS wins
 *   AI_PREMIUM_MONTHLY_GRANT_CREDITS  — BETA / initial only; NOT final commercial value
 */

import {
  DEFAULT_TRIAL_AI_CREDITS,
  DEFAULT_TRIAL_DURATION_DAYS,
  TRIAL_AI_CREDITS_ENV,
  TRIAL_AI_CREDITS_MAX,
  TRIAL_AI_CREDITS_MIN,
  TRIAL_DURATION_DAYS_MAX,
  TRIAL_DURATION_DAYS_MIN,
  TRIAL_DURATION_ENV,
} from './commercial-settings.ts';

export const TRIAL_CONFIG_ENV = {
  TRIAL_DURATION_DAYS: TRIAL_DURATION_ENV.AMOUNT,
  TRIAL_DURATION_EMERGENCY_OVERRIDE: TRIAL_DURATION_ENV.EMERGENCY_OVERRIDE,
  TRIAL_MAX_SCANS: 'TRIAL_MAX_SCANS',
  AI_TRIAL_GRANT_CREDITS: 'AI_TRIAL_GRANT_CREDITS',
  AI_TRIAL_GRANT_EMERGENCY_OVERRIDE: TRIAL_AI_CREDITS_ENV.EMERGENCY_OVERRIDE,
  AI_PREMIUM_MONTHLY_GRANT_CREDITS: 'AI_PREMIUM_MONTHLY_GRANT_CREDITS',
} as const;

/**
 * Fallbacks when env/DB unavailable.
 * `trialDurationDays` mirrors DEFAULT_TRIAL_DURATION_DAYS (code fallback only).
 * Ordinary production duration is DB `trial_duration_days`.
 */
export const TRIAL_CONFIG_DEFAULTS = {
  trialDurationDays: DEFAULT_TRIAL_DURATION_DAYS,
  trialMaxScans: 20,
  aiTrialGrantCredits: DEFAULT_TRIAL_AI_CREDITS,
  /** BETA / INITIAL CONFIGURATION — NOT FINAL COMMERCIAL VALUE */
  aiPremiumMonthlyGrantCreditsBeta: 20,
} as const;

export interface TrialCommercialConfig {
  trialDurationDays: number;
  trialMaxScans: number;
  /** @deprecated Prefer resolveTrialAiCredits() for grant amounts. */
  aiTrialGrantCredits: number;
  /** null when AI_PREMIUM_MONTHLY_GRANT_CREDITS is not configured */
  aiPremiumMonthlyGrantCredits: number | null;
}

type EnvReader = Record<string, string | undefined>;

function readBoundedInt(
  env: EnvReader,
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

function readOptionalBoundedInt(
  env: EnvReader,
  key: string,
  min: number,
  max: number
): number | null {
  const raw = env[key];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

/**
 * Sync config reader for non-grant trial knobs.
 * For trial AI grant amount use `resolveTrialAiCredits` (DB-primary).
 * `aiTrialGrantCredits` here remains a legacy sync view: emergency env or code fallback only.
 */
export function readTrialCommercialConfig(
  env: EnvReader = typeof process !== 'undefined' ? process.env : {}
): TrialCommercialConfig {
  const emergency =
    (env[TRIAL_CONFIG_ENV.AI_TRIAL_GRANT_EMERGENCY_OVERRIDE] ?? '')
      .trim()
      .toLowerCase();
  const emergencyOn =
    emergency === '1' ||
    emergency === 'true' ||
    emergency === 'yes' ||
    emergency === 'on';

  const aiTrialGrantCredits = emergencyOn
    ? readBoundedInt(
        env,
        TRIAL_CONFIG_ENV.AI_TRIAL_GRANT_CREDITS,
        TRIAL_CONFIG_DEFAULTS.aiTrialGrantCredits,
        TRIAL_AI_CREDITS_MIN,
        TRIAL_AI_CREDITS_MAX
      )
    : TRIAL_CONFIG_DEFAULTS.aiTrialGrantCredits;

  return {
    trialDurationDays: (() => {
      // Duration: emergency ENV only; ordinary callers must use resolveTrialDurationDays (DB).
      const emergency =
        (env[TRIAL_CONFIG_ENV.TRIAL_DURATION_EMERGENCY_OVERRIDE] ?? '')
          .trim()
          .toLowerCase();
      const emergencyOn =
        emergency === '1' ||
        emergency === 'true' ||
        emergency === 'yes' ||
        emergency === 'on';
      if (emergencyOn) {
        return readBoundedInt(
          env,
          TRIAL_CONFIG_ENV.TRIAL_DURATION_DAYS,
          TRIAL_CONFIG_DEFAULTS.trialDurationDays,
          TRIAL_DURATION_DAYS_MIN,
          TRIAL_DURATION_DAYS_MAX
        );
      }
      return TRIAL_CONFIG_DEFAULTS.trialDurationDays;
    })(),
    trialMaxScans: readBoundedInt(
      env,
      TRIAL_CONFIG_ENV.TRIAL_MAX_SCANS,
      TRIAL_CONFIG_DEFAULTS.trialMaxScans,
      1,
      10_000
    ),
    aiTrialGrantCredits,
    aiPremiumMonthlyGrantCredits: readOptionalBoundedInt(
      env,
      TRIAL_CONFIG_ENV.AI_PREMIUM_MONTHLY_GRANT_CREDITS,
      0,
      100_000
    ),
  };
}

/** @deprecated Prefer server-provided trial duration. Kept for offline grace display fallback. */
export function trialDurationDaysFallback(env?: EnvReader): number {
  return readTrialCommercialConfig(env).trialDurationDays;
}

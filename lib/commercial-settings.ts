/**
 * Commercial settings resolution (server-side only).
 *
 * Resolution order for trial AI credits:
 *   1. ENV emergency override (AI_TRIAL_GRANT_EMERGENCY_OVERRIDE=true + AI_TRIAL_GRANT_CREDITS)
 *   2. Durable DB setting `trial_ai_credits` via get_commercial_setting_int
 *   3. Code fallback DEFAULT_TRIAL_AI_CREDITS
 *
 * Mobile clients must never read or write these settings.
 */

export const COMMERCIAL_SETTING_KEYS = {
  TRIAL_AI_CREDITS: 'trial_ai_credits',
  TRIAL_DURATION_DAYS: 'trial_duration_days',
} as const;

/** Code fallback only — not the production source of truth. */
export const DEFAULT_TRIAL_AI_CREDITS = 20;

/**
 * Safety fallback only. Ordinary production policy is read from Supabase
 * `app_commercial_settings` with setting_key = `trial_duration_days`.
 * Keep this aligned with the live commercial value so a transient settings
 * read failure can never extend the trial beyond the configured policy.
 */
export const DEFAULT_TRIAL_DURATION_DAYS = 3;

/** Sensible bounds for trial grant (reject absurd values). */
export const TRIAL_AI_CREDITS_MIN = 0;
export const TRIAL_AI_CREDITS_MAX = 10_000;

/** Sensible bounds for trial duration days. */
export const TRIAL_DURATION_DAYS_MIN = 1;
export const TRIAL_DURATION_DAYS_MAX = 365;

export const TRIAL_AI_CREDITS_ENV = {
  EMERGENCY_OVERRIDE: 'AI_TRIAL_GRANT_EMERGENCY_OVERRIDE',
  AMOUNT: 'AI_TRIAL_GRANT_CREDITS',
} as const;

export const TRIAL_DURATION_ENV = {
  EMERGENCY_OVERRIDE: 'TRIAL_DURATION_EMERGENCY_OVERRIDE',
  AMOUNT: 'TRIAL_DURATION_DAYS',
} as const;

export type TrialAiCreditsSource =
  | 'emergency_env'
  | 'database'
  | 'code_fallback';

export interface TrialAiCreditsResolution {
  amount: number;
  source: TrialAiCreditsSource;
}

type EnvReader = Record<string, string | undefined>;

export function parseBoundedTrialAiCredits(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(n)) return null;
  if (n < TRIAL_AI_CREDITS_MIN || n > TRIAL_AI_CREDITS_MAX) return null;
  return n;
}

function envFlagEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export type CommercialSettingIntReader = (
  key: string,
  min: number,
  max: number
) => Promise<number | null>;

let dbReaderOverride: CommercialSettingIntReader | null = null;

/** Test-only injector for DB reads (no network). */
export function setCommercialSettingIntReaderForTests(
  reader: CommercialSettingIntReader | null
): void {
  dbReaderOverride = reader;
}

export function resolveTrialAiCreditsFromParts(input: {
  env?: EnvReader;
  dbValue?: unknown;
}): TrialAiCreditsResolution {
  const env = input.env ?? {};
  if (envFlagEnabled(env[TRIAL_AI_CREDITS_ENV.EMERGENCY_OVERRIDE])) {
    const emergency = parseBoundedTrialAiCredits(env[TRIAL_AI_CREDITS_ENV.AMOUNT]);
    if (emergency !== null) {
      return { amount: emergency, source: 'emergency_env' };
    }
  }

  const fromDb = parseBoundedTrialAiCredits(input.dbValue);
  if (fromDb !== null) {
    return { amount: fromDb, source: 'database' };
  }

  return { amount: DEFAULT_TRIAL_AI_CREDITS, source: 'code_fallback' };
}

export async function resolveTrialAiCredits(input: {
  env?: EnvReader;
  readDbInt?: CommercialSettingIntReader;
}): Promise<TrialAiCreditsResolution> {
  const env = input.env ?? {};
  if (envFlagEnabled(env[TRIAL_AI_CREDITS_ENV.EMERGENCY_OVERRIDE])) {
    const emergency = parseBoundedTrialAiCredits(env[TRIAL_AI_CREDITS_ENV.AMOUNT]);
    if (emergency !== null) {
      return { amount: emergency, source: 'emergency_env' };
    }
  }

  const reader = input.readDbInt ?? dbReaderOverride;
  if (reader) {
    try {
      const dbValue = await reader(
        COMMERCIAL_SETTING_KEYS.TRIAL_AI_CREDITS,
        TRIAL_AI_CREDITS_MIN,
        TRIAL_AI_CREDITS_MAX
      );
      const fromDb = parseBoundedTrialAiCredits(dbValue);
      if (fromDb !== null) {
        return { amount: fromDb, source: 'database' };
      }
    } catch {
      /* fall through to code fallback */
    }
  }

  return { amount: DEFAULT_TRIAL_AI_CREDITS, source: 'code_fallback' };
}

export type TrialDurationSource = 'emergency_env' | 'database' | 'code_fallback';

export interface TrialDurationResolution {
  days: number;
  source: TrialDurationSource;
}

export function parseBoundedTrialDurationDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(n)) return null;
  if (n < TRIAL_DURATION_DAYS_MIN || n > TRIAL_DURATION_DAYS_MAX) return null;
  return n;
}

export function resolveTrialDurationDaysFromParts(input: {
  env?: EnvReader;
  dbValue?: unknown;
}): TrialDurationResolution {
  const env = input.env ?? {};
  if (envFlagEnabled(env[TRIAL_DURATION_ENV.EMERGENCY_OVERRIDE])) {
    const emergency = parseBoundedTrialDurationDays(env[TRIAL_DURATION_ENV.AMOUNT]);
    if (emergency !== null) {
      return { days: emergency, source: 'emergency_env' };
    }
  }

  const fromDb = parseBoundedTrialDurationDays(input.dbValue);
  if (fromDb !== null) {
    return { days: fromDb, source: 'database' };
  }

  return { days: DEFAULT_TRIAL_DURATION_DAYS, source: 'code_fallback' };
}

export async function resolveTrialDurationDays(input: {
  env?: EnvReader;
  readDbInt?: CommercialSettingIntReader;
}): Promise<TrialDurationResolution> {
  const env = input.env ?? {};
  if (envFlagEnabled(env[TRIAL_DURATION_ENV.EMERGENCY_OVERRIDE])) {
    const emergency = parseBoundedTrialDurationDays(env[TRIAL_DURATION_ENV.AMOUNT]);
    if (emergency !== null) {
      return { days: emergency, source: 'emergency_env' };
    }
  }

  const reader = input.readDbInt ?? dbReaderOverride;
  if (reader) {
    try {
      const dbValue = await reader(
        COMMERCIAL_SETTING_KEYS.TRIAL_DURATION_DAYS,
        TRIAL_DURATION_DAYS_MIN,
        TRIAL_DURATION_DAYS_MAX
      );
      const fromDb = parseBoundedTrialDurationDays(dbValue);
      if (fromDb !== null) {
        return { days: fromDb, source: 'database' };
      }
    } catch {
      /* fall through */
    }
  }

  return { days: DEFAULT_TRIAL_DURATION_DAYS, source: 'code_fallback' };
}

/**
 * Privacy policy public configuration.
 * Ordinary production source = DB via Edge `privacy-consent` get_config.
 * Code values below are safe fallbacks only.
 */

/** Code fallback — ordinary source is DB `privacy_policy_version`. */
export const FALLBACK_PRIVACY_POLICY_VERSION = '1.0';

/** @deprecated Use FALLBACK_PRIVACY_POLICY_VERSION / resolvePrivacySettings(). */
export const PRIVACY_POLICY_VERSION = FALLBACK_PRIVACY_POLICY_VERSION;

/** Canonical public Privacy Policy URL (production website). */
export const FALLBACK_PRIVACY_POLICY_URL = 'https://mybizscanner.com/privacy';

function isRetiredProductPrivacyHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'businessscanner.app' || host === 'www.businessscanner.app';
}

/** @deprecated Use FALLBACK_PRIVACY_POLICY_URL / resolvePrivacySettings(). */
export const PRIVACY_POLICY_URL =
  process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL?.trim() || FALLBACK_PRIVACY_POLICY_URL;

export const PRIVACY_POLICY_URL_MAX_LENGTH = 2048;

export const DATA_CONTROLLER = {
  name: 'KFIVE di Chiozza Giovanni S.a.s.',
  address: 'Via Pasini 15, 36015 Schio (VI), Italy',
  email: 'info@kfive.it',
} as const;

export function isValidPrivacyPolicyVersion(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 1 &&
    trimmed.length <= 64 &&
    /^[A-Za-z0-9._-]+$/.test(trimmed)
  );
}

export function parsePrivacyPolicyVersion(
  raw: unknown,
  fallback: string = FALLBACK_PRIVACY_POLICY_VERSION
): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!isValidPrivacyPolicyVersion(trimmed)) return fallback;
  return trimmed;
}

/**
 * HTTPS-only absolute URL for production privacy pages.
 * Rejects javascript:/file:/credentials and malformed values.
 */
export function parseSafePrivacyPolicyUrl(
  raw: unknown,
  fallback: string = FALLBACK_PRIVACY_POLICY_URL
): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > PRIVACY_POLICY_URL_MAX_LENGTH) return fallback;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return fallback;
    if (url.username || url.password) return fallback;
    if (isRetiredProductPrivacyHost(url.hostname)) return FALLBACK_PRIVACY_POLICY_URL;
    return url.toString();
  } catch {
    return fallback;
  }
}

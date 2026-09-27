import { Linking } from 'react-native';
import {
  FALLBACK_PRIVACY_POLICY_URL,
  parseSafePrivacyPolicyUrl,
} from './privacy-config';

/** Resolved HTTPS privacy URL for in-app links. Does not record consent. */
export function resolvePrivacyPolicyOpenUrl(url?: string | null): string {
  return parseSafePrivacyPolicyUrl(url, FALLBACK_PRIVACY_POLICY_URL);
}

/**
 * Open the full privacy policy in the system browser.
 * Cross-platform Linking only — no Android-specific intents.
 */
export function openPrivacyPolicyUrl(
  url: string | null | undefined,
  onError: () => void,
): void {
  const resolved = resolvePrivacyPolicyOpenUrl(url);
  Linking.openURL(resolved).catch(() => {
    onError();
  });
}

import * as FileSystem from 'expo-file-system/legacy';
import { callSupabaseFunction } from './supabase-functions';
import { isSupabaseConfigured } from './config';
import {
  FALLBACK_PRIVACY_POLICY_URL,
  FALLBACK_PRIVACY_POLICY_VERSION,
  parsePrivacyPolicyVersion,
  parseSafePrivacyPolicyUrl,
} from './privacy-config';

export const PRIVACY_SETTINGS_CACHE_FILENAME = 'privacy-settings-cache.json';

export type PrivacySettingsSource = 'database' | 'cache' | 'code_fallback';

export interface PrivacySettings {
  privacyPolicyUrl: string;
  privacyPolicyVersion: string;
  source: PrivacySettingsSource;
  fetchedAt: string;
}

interface PrivacyConfigResponse {
  privacyPolicyUrl?: string;
  privacyPolicyVersion?: string;
  source?: string;
}

function cacheUri(): string | null {
  const root = FileSystem.documentDirectory;
  if (!root) return null;
  return `${root}${PRIVACY_SETTINGS_CACHE_FILENAME}`;
}

export async function readPrivacySettingsCache(): Promise<PrivacySettings | null> {
  const uri = cacheUri();
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(uri);
    const parsed = JSON.parse(raw) as Partial<PrivacySettings>;
    const url = parseSafePrivacyPolicyUrl(parsed.privacyPolicyUrl);
    const version = parsePrivacyPolicyVersion(parsed.privacyPolicyVersion);
    if (!url || !version) return null;
    return {
      privacyPolicyUrl: url,
      privacyPolicyVersion: version,
      source: 'cache',
      fetchedAt:
        typeof parsed.fetchedAt === 'string' && parsed.fetchedAt
          ? parsed.fetchedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export async function writePrivacySettingsCache(
  settings: Omit<PrivacySettings, 'source'> & { source?: PrivacySettingsSource }
): Promise<void> {
  const uri = cacheUri();
  if (!uri) return;
  const payload: PrivacySettings = {
    privacyPolicyUrl: parseSafePrivacyPolicyUrl(settings.privacyPolicyUrl),
    privacyPolicyVersion: parsePrivacyPolicyVersion(settings.privacyPolicyVersion),
    source: 'cache',
    fetchedAt: settings.fetchedAt || new Date().toISOString(),
  };
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(payload, null, 2));
}

function codeFallbackSettings(): PrivacySettings {
  return {
    privacyPolicyUrl: parseSafePrivacyPolicyUrl(
      process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
      FALLBACK_PRIVACY_POLICY_URL
    ),
    privacyPolicyVersion: FALLBACK_PRIVACY_POLICY_VERSION,
    source: 'code_fallback',
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Resolution: live DB (via Edge) → last valid cache → code fallback.
 */
export async function resolvePrivacySettings(): Promise<PrivacySettings> {
  if (isSupabaseConfigured()) {
    try {
      const { data, error } = await callSupabaseFunction<PrivacyConfigResponse>(
        'privacy-consent',
        { action: 'get_config' }
      );
      if (!error && data) {
        const url = parseSafePrivacyPolicyUrl(
          data.privacyPolicyUrl,
          FALLBACK_PRIVACY_POLICY_URL
        );
        const version = parsePrivacyPolicyVersion(
          data.privacyPolicyVersion,
          FALLBACK_PRIVACY_POLICY_VERSION
        );
        const settings: PrivacySettings = {
          privacyPolicyUrl: url,
          privacyPolicyVersion: version,
          source: 'database',
          fetchedAt: new Date().toISOString(),
        };
        await writePrivacySettingsCache(settings).catch(() => undefined);
        return settings;
      }
    } catch {
      /* fall through */
    }
  }

  const cached = await readPrivacySettingsCache();
  if (cached) return cached;

  return codeFallbackSettings();
}

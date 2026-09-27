import Constants from 'expo-constants';
import i18n from '../i18n';
import { callSupabaseFunction } from './supabase-functions';
import { isSupabaseConfigured } from './config';
import {
  getPrivacyConsentRecord,
  markPrivacyConsentBackendSynced,
  type PrivacyConsentRecord,
} from './privacy-consent';
import { logPrivacyConsent } from './privacy-consent-log';

export interface RegisterPrivacyConsentResult {
  ok: boolean;
  acceptedAt: string | null;
  created: boolean;
  error?: string;
}

interface RegisterResponse {
  id?: string | null;
  installationId?: string;
  privacyVersion?: string;
  acceptedAt?: string | null;
  created?: boolean;
  error?: string;
  errorCode?: string;
}

function resolveAppVersion(): string | null {
  const fromExpo = Constants.expoConfig?.version?.trim();
  if (fromExpo) return fromExpo.slice(0, 64);
  return null;
}

function resolveLocale(): string | null {
  const lang = i18n.language?.trim();
  if (!lang) return null;
  return lang.slice(0, 32);
}

export async function registerPrivacyConsentRemote(input: {
  installationId: string;
  privacyVersion: string;
  licenseId?: string | null;
}): Promise<RegisterPrivacyConsentResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, acceptedAt: null, created: false, error: 'supabase_not_configured' };
  }

  const { data, error } = await callSupabaseFunction<RegisterResponse>('privacy-consent', {
    action: 'register',
    installationId: input.installationId,
    privacyVersion: input.privacyVersion,
    locale: resolveLocale(),
    appVersion: resolveAppVersion(),
    licenseId: input.licenseId ?? null,
    consentType: 'first_launch_summary',
  });

  if (error || !data?.acceptedAt) {
    logPrivacyConsent('backend_sync_failed', {
      error: error ?? data?.error ?? 'missing_accepted_at',
      errorCode: data?.errorCode ?? null,
    });
    return {
      ok: false,
      acceptedAt: null,
      created: false,
      error: error ?? data?.error ?? 'privacy_consent_unavailable',
    };
  }

  logPrivacyConsent('backend_sync_ok', {
    created: Boolean(data.created),
    privacyVersion: input.privacyVersion,
  });

  return {
    ok: true,
    acceptedAt: String(data.acceptedAt),
    created: Boolean(data.created),
  };
}

/** Idempotent retry for pending local consents. */
export async function syncPendingPrivacyConsentIfNeeded(
  record?: PrivacyConsentRecord | null
): Promise<RegisterPrivacyConsentResult | null> {
  const local = record ?? (await getPrivacyConsentRecord());
  if (!local?.accepted) return null;
  if (local.backendSyncStatus === 'synced' && local.backendAcceptedAt) {
    return {
      ok: true,
      acceptedAt: local.backendAcceptedAt,
      created: false,
    };
  }

  const result = await registerPrivacyConsentRemote({
    installationId: local.installationId,
    privacyVersion: local.policyVersion,
    licenseId: local.licenseId,
  });

  if (result.ok && result.acceptedAt) {
    await markPrivacyConsentBackendSynced(result.acceptedAt);
  }
  return result;
}

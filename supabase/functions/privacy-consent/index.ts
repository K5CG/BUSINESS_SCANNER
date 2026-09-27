import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { createAdminClient } from '../_shared/license-utils.ts';

const FALLBACK_PRIVACY_POLICY_URL = 'https://www.mybizscanner.com/privacy/';
const FALLBACK_PRIVACY_POLICY_VERSION = '1.0';
const MAX_URL_LENGTH = 2048;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isValidInstallationId(value: string): boolean {
  return value.length >= 8 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isValidPrivacyVersion(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9._-]+$/.test(value);
}

function parseSafeHttpsUrl(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return fallback;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') return fallback;
    if (url.username || url.password) return fallback;
    const host = url.hostname.toLowerCase();
    if (host === 'businessscanner.app' || host === 'www.businessscanner.app') {
      return FALLBACK_PRIVACY_POLICY_URL;
    }
    return url.toString();
  } catch {
    return fallback;
  }
}

function parsePrivacyVersion(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!isValidPrivacyVersion(trimmed)) return fallback;
  return trimmed;
}

function asOptionalTrimmed(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return jsonResponse(
      { error: 'Metodo non consentito', errorCode: 'METHOD_NOT_ALLOWED' },
      405
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(
      { error: 'Richiesta non valida', errorCode: 'INVALID_REQUEST' },
      400
    );
  }

  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (action !== 'get_config' && action !== 'register') {
    return jsonResponse(
      { error: 'Richiesta non valida', errorCode: 'INVALID_REQUEST' },
      400
    );
  }

  try {
    const admin = await createAdminClient();

    if (action === 'get_config') {
      const { data, error } = await admin.rpc('get_public_privacy_settings');
      if (error) {
        return jsonResponse({
          privacyPolicyUrl: FALLBACK_PRIVACY_POLICY_URL,
          privacyPolicyVersion: FALLBACK_PRIVACY_POLICY_VERSION,
          source: 'code_fallback',
        });
      }
      const row = Array.isArray(data) ? data[0] : data;
      const url = parseSafeHttpsUrl(
        row?.privacy_policy_url,
        FALLBACK_PRIVACY_POLICY_URL
      );
      const version = parsePrivacyVersion(
        row?.privacy_policy_version,
        FALLBACK_PRIVACY_POLICY_VERSION
      );
      return jsonResponse({
        privacyPolicyUrl: url,
        privacyPolicyVersion: version,
        source: 'database',
      });
    }

    const installationId = asOptionalTrimmed(body.installationId, 128);
    const privacyVersion = asOptionalTrimmed(body.privacyVersion, 64);
    if (!installationId || !isValidInstallationId(installationId)) {
      return jsonResponse(
        { error: 'installationId non valido', errorCode: 'INVALID_INSTALLATION_ID' },
        400
      );
    }
    if (!privacyVersion || !isValidPrivacyVersion(privacyVersion)) {
      return jsonResponse(
        { error: 'privacyVersion non valido', errorCode: 'INVALID_PRIVACY_VERSION' },
        400
      );
    }

    const locale = asOptionalTrimmed(body.locale, 32);
    const appVersion = asOptionalTrimmed(body.appVersion, 64);
    const consentType =
      asOptionalTrimmed(body.consentType, 64) ?? 'first_launch_summary';
    const licenseRaw = asOptionalTrimmed(body.licenseId, 64);
    const licenseId =
      licenseRaw &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        licenseRaw
      )
        ? licenseRaw
        : null;

    const { data, error } = await admin.rpc('register_privacy_consent', {
      p_installation_id: installationId,
      p_privacy_version: privacyVersion,
      p_locale: locale,
      p_app_version: appVersion,
      p_license_id: licenseId,
      p_consent_type: consentType,
    });

    if (error) {
      return jsonResponse(
        {
          error: 'Registrazione consenso non disponibile',
          errorCode: 'PRIVACY_CONSENT_UNAVAILABLE',
        },
        503
      );
    }

    const row = Array.isArray(data) ? data[0] : data;
    return jsonResponse({
      id: row?.out_id ?? row?.id ?? null,
      installationId: row?.out_installation_id ?? row?.installation_id ?? installationId,
      privacyVersion: row?.out_privacy_version ?? row?.privacy_version ?? privacyVersion,
      acceptedAt: row?.out_accepted_at ?? row?.accepted_at ?? null,
      created: Boolean(row?.out_created ?? row?.created),
    });
  } catch {
    return jsonResponse(
      {
        error: 'Servizio temporaneamente non disponibile',
        errorCode: 'PRIVACY_CONSENT_UNAVAILABLE',
      },
      503
    );
  }
});

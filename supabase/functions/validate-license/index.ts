import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders } from '../_shared/cors.ts';
import {
  addDays,
  createAdminClient,
  findActiveActivation,
  isValidEmail,
  lookupLicenseByKey,
  normalizeEmail,
  PREMIUM_DAYS,
  TEST_DAYS,
  touchActivationLastSeen,
} from '../_shared/license-utils.ts';
import {
  licenseKeyHint,
  parseValidateLicenseBody,
  sanitizeLicenseKeyForLog,
} from '../_shared/license-payload.ts';
import {
  checkLicenseRateLimit,
  fingerprintFromInstallation,
} from '../_shared/license-rate-limit.ts';
import { edgeLogger } from '../_shared/safe-logging.ts';
import { ensurePremiumCreditGrant, readCreditBalance } from '../_shared/ai-credit-bootstrap.ts';

async function premiumCreditFields(installationId: string, licenseId: string | null) {
  await ensurePremiumCreditGrant(installationId, licenseId);
  const balance = await readCreditBalance(installationId);
  return {
    aiCreditsRemaining: balance,
    aiCreditsTotal: balance,
    aiCreditsUsed: 0,
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ valid: false, errorCode: 'invalid_request' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ valid: false, errorCode: 'invalid_request' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const parsed = parseValidateLicenseBody(body);
    if (!parsed.ok) {
      const status =
        parsed.errorCode === 'email_required' || parsed.errorCode === 'email_invalid'
          ? 400
          : parsed.errorCode === 'payload_too_large'
            ? 413
            : 400;
      return new Response(JSON.stringify({ valid: false, errorCode: parsed.errorCode }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { installationId, email, licenseKey } = parsed;

    if (!isValidEmail(email)) {
      return new Response(JSON.stringify({ valid: false, errorCode: 'email_invalid' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rate = checkLicenseRateLimit(
      'validate_license',
      fingerprintFromInstallation(installationId)
    );
    if (!rate.allowed) {
      return new Response(JSON.stringify({ valid: false, errorCode: 'rate_limited' }), {
        status: 429,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Retry-After': String(rate.retryAfterSeconds),
        },
      });
    }

    const supabase = await createAdminClient();

    const { data: license, error: licenseError } = await lookupLicenseByKey(
      supabase,
      licenseKey
    );

    if (licenseError) {
      edgeLogger.error('LICENSE_LOOKUP_FAILED', {
        status: 'failed',
        stage: 'database',
      });
      return new Response(
        JSON.stringify({
          valid: false,
          errorCode: 'server_error',
          error: 'Servizio licenze temporaneamente non disponibile',
        }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    if (!license) {
      edgeLogger.warn('LICENSE_LOOKUP_FAILED', {
        status: 'rejected',
        stage: 'validation',
        count: sanitizeLicenseKeyForLog(licenseKey).length,
      });
      return new Response(JSON.stringify({ valid: false, errorCode: 'invalid_key' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (license.revoked) {
      return new Response(JSON.stringify({ valid: false, errorCode: 'revoked' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const assigned = license.assigned_email
      ? normalizeEmail(String(license.assigned_email))
      : null;

    if (assigned && assigned !== email) {
      return new Response(JSON.stringify({ valid: false, errorCode: 'email_mismatch' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const validDays =
      license.valid_days ??
      (license.license_type === 'premium' ? PREMIUM_DAYS : TEST_DAYS);

    const existingActivation = await findActiveActivation(supabase, installationId);
    if (
      existingActivation &&
      existingActivation.licenseId === license.id &&
      existingActivation.expiresAt.getTime() > Date.now()
    ) {
      const storedEmail = existingActivation.customerEmail
        ? normalizeEmail(String(existingActivation.customerEmail))
        : null;

      if (storedEmail && storedEmail !== email) {
        return new Response(JSON.stringify({ valid: false, errorCode: 'email_mismatch' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await touchActivationLastSeen(supabase, existingActivation.activationId);

      return new Response(
        JSON.stringify({
          valid: true,
          licenseType: license.license_type,
          expiresAt: existingActivation.expiresAt.toISOString(),
          customerEmail: email,
          licenseId: license.id,
          keyHint: licenseKeyHint(licenseKey),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: existingForLicense } = await supabase
      .from('license_activations')
      .select('expires_at, customer_email, id')
      .eq('license_id', license.id)
      .eq('device_id', installationId)
      .maybeSingle();

    if (existingForLicense?.expires_at) {
      const storedEmail = existingForLicense.customer_email
        ? normalizeEmail(String(existingForLicense.customer_email))
        : null;

      if (storedEmail && storedEmail !== email) {
        return new Response(JSON.stringify({ valid: false, errorCode: 'email_mismatch' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const expiresAt = new Date(existingForLicense.expires_at as string);
      if (expiresAt.getTime() <= Date.now()) {
        return new Response(JSON.stringify({ valid: false, errorCode: 'expired_key' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      await touchActivationLastSeen(supabase, existingForLicense.id as string);

      return new Response(
        JSON.stringify({
          valid: true,
          licenseType: license.license_type,
          expiresAt: expiresAt.toISOString(),
          customerEmail: email,
          licenseId: license.id,
          keyHint: licenseKeyHint(licenseKey),
          ...(await premiumCreditFields(installationId, license.id)),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { count: emailDeviceCount } = await supabase
      .from('license_activations')
      .select('id', { count: 'exact', head: true })
      .eq('license_id', license.id)
      .eq('customer_email', email);

    if ((emailDeviceCount ?? 0) >= license.max_activations) {
      return new Response(JSON.stringify({ valid: false, errorCode: 'max_devices' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (license.activation_count >= license.max_activations) {
      return new Response(JSON.stringify({ valid: false, errorCode: 'max_devices' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const now = new Date();
    const expiresAt = addDays(now, validDays);

    const { error: insertError } = await supabase.from('license_activations').insert({
      license_id: license.id,
      device_id: installationId,
      customer_email: email,
      activated_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    });

    if (insertError) {
      return new Response(JSON.stringify({ valid: false, errorCode: 'activation_failed' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await supabase
      .from('app_licenses')
      .update({
        activation_count: license.activation_count + 1,
        ...(assigned ? {} : { assigned_email: email }),
      })
      .eq('id', license.id);

    return new Response(
      JSON.stringify({
        valid: true,
        licenseType: license.license_type,
        expiresAt: expiresAt.toISOString(),
        customerEmail: email,
        licenseId: license.id,
        keyHint: licenseKeyHint(licenseKey),
        ...(await premiumCreditFields(installationId, license.id)),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch {
    edgeLogger.error('LICENSE_LOOKUP_FAILED', {
      status: 'failed',
      stage: 'database',
    });
    return new Response(
      JSON.stringify({
        valid: false,
        errorCode: 'server_error',
        error: 'Servizio licenze temporaneamente non disponibile',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

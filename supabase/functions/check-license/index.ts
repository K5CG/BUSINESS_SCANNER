import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { corsHeaders } from '../_shared/cors.ts';
import {
  createAdminClient,
  ensureTrialDevice,
  findActiveActivation,
  isTrialAccessActive,
  touchActivationLastSeen,
  trialResponseFields,
} from '../_shared/license-utils.ts';
import { parseCheckLicenseBody } from '../_shared/license-payload.ts';
import {
  checkLicenseRateLimit,
  fingerprintFromInstallation,
} from '../_shared/license-rate-limit.ts';
import {
  ensurePremiumCreditGrant,
  ensureTrialCreditGrant,
  readCreditBalance,
} from '../_shared/ai-credit-bootstrap.ts';

async function creditResponseFields(
  installationId: string,
  kind: string | null,
  licenseId: string | null
): Promise<{ aiCreditsRemaining: number; aiCreditsTotal: number; aiCreditsUsed: number }> {
  if (kind === 'trial') {
    await ensureTrialCreditGrant(installationId, licenseId);
  } else if (kind === 'premium' || kind === 'test') {
    await ensurePremiumCreditGrant(installationId, licenseId);
  }
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
    return new Response(
      JSON.stringify({
        access: 'expired',
        error: 'Metodo non consentito',
        errorCode: 'invalid_request',
      }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({
          access: 'expired',
          error: 'Richiesta non valida',
          errorCode: 'invalid_request',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const parsed = parseCheckLicenseBody(body);
    if (!parsed.ok) {
      return new Response(
        JSON.stringify({
          access: 'expired',
          error: 'Richiesta non valida',
          errorCode: parsed.errorCode,
        }),
        {
          status: parsed.errorCode === 'payload_too_large' ? 413 : 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    const { installationId, email } = parsed;

    const rate = checkLicenseRateLimit(
      'check_license',
      fingerprintFromInstallation(installationId)
    );
    if (!rate.allowed) {
      return new Response(
        JSON.stringify({
          access: 'expired',
          error: 'Troppe richieste, riprova più tardi',
          errorCode: 'rate_limited',
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': String(rate.retryAfterSeconds),
          },
        }
      );
    }

    const supabase = await createAdminClient();
    const activation = await findActiveActivation(supabase, installationId);

    if (activation) {
      if (email && activation.customerEmail && activation.customerEmail !== email) {
        return new Response(
          JSON.stringify({
            access: 'expired',
            error: 'Email non corrisponde alla licenza attiva su questo dispositivo',
            errorCode: 'email_mismatch',
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      await touchActivationLastSeen(supabase, activation.activationId);

      const keyHint =
        activation.licenseKey.length <= 4
          ? activation.licenseKey
          : activation.licenseKey.slice(-4);

      return new Response(
        JSON.stringify({
          access: 'active',
          kind: activation.licenseType,
          expiresAt: activation.expiresAt.toISOString(),
          customerEmail: activation.customerEmail,
          keyHint,
          licenseId: activation.licenseId,
          ...(await creditResponseFields(
            installationId,
            activation.licenseType,
            activation.licenseId
          )),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const trialRate = checkLicenseRateLimit(
      'trial_create',
      fingerprintFromInstallation(installationId)
    );
    if (!trialRate.allowed) {
      return new Response(
        JSON.stringify({
          access: 'expired',
          error: 'Troppe richieste, riprova più tardi',
          errorCode: 'rate_limited',
        }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const trialRow = await ensureTrialDevice(supabase, installationId);
    const trialFields = trialResponseFields(trialRow);

    if (isTrialAccessActive(trialRow)) {
      return new Response(
        JSON.stringify({
          access: 'active',
          kind: 'trial',
          expiresAt: trialFields.trialExpiresAt,
          trialStartedAt: trialFields.trialStartedAt,
          trialScanCount: trialFields.trialScanCount,
          trialMaxScans: trialFields.trialMaxScans,
          trialScansRemaining: trialFields.trialScansRemaining,
          trialDeviceStatus: trialFields.trialDeviceStatus,
          customerEmail: null,
          keyHint: null,
          licenseId: null,
          ...(await creditResponseFields(installationId, 'trial', null)),
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        access: 'expired',
        kind: 'trial',
        expiresAt: trialFields.trialExpiresAt,
        trialStartedAt: trialFields.trialStartedAt,
        trialScanCount: trialFields.trialScanCount,
        trialMaxScans: trialFields.trialMaxScans,
        trialScansRemaining: trialFields.trialScansRemaining,
        trialDeviceStatus: trialFields.trialDeviceStatus,
        customerEmail: null,
        keyHint: null,
        licenseId: null,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch {
    return new Response(
      JSON.stringify({
        access: 'expired',
        error: 'Servizio licenze temporaneamente non disponibile',
        errorCode: 'server_error',
      }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});

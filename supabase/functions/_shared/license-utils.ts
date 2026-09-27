import {
  getLicenseKeyPepper,
  hashLicenseKey,
} from './license-key-hash.ts';
import { readEdgeTrialConfig, resolveEdgeTrialDurationDays } from './trial-utils.ts';
import {
  isTrialAccessActive,
  trialResponseFields,
  type TrialDeviceRow,
} from './trial-utils.ts';

export const PREMIUM_DAYS = 365;
export const TEST_DAYS = 15;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizeLicenseKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function addDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

export async function createAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Server non configurato');
  }
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.49.1');
  return createClient(supabaseUrl, serviceKey);
}

export type ActiveActivation = {
  activationId: string;
  licenseId: string;
  customerEmail: string | null;
  expiresAt: Date;
  licenseType: 'test' | 'premium';
  licenseKey: string;
};

export type LicenseRow = {
  id: string;
  license_type: 'test' | 'premium';
  valid_days: number | null;
  max_activations: number;
  activation_count: number;
  revoked: boolean;
  assigned_email: string | null;
  license_key?: string;
};

const LICENSE_SELECT_LEGACY =
  'id, license_type, valid_days, max_activations, activation_count, revoked, assigned_email, license_key';

export async function findActiveActivation(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  installationId: string
): Promise<ActiveActivation | null> {
  const { data: activations } = await supabase
    .from('license_activations')
    .select('id, customer_email, expires_at, license_id')
    .eq('device_id', installationId)
    .gt('expires_at', new Date().toISOString());

  if (!activations?.length) return null;

  for (const act of activations) {
    const { data: license } = await supabase
      .from('app_licenses')
      .select(LICENSE_SELECT_LEGACY)
      .eq('id', act.license_id)
      .maybeSingle();

    if (!license || license.revoked) continue;

    return {
      activationId: act.id as string,
      licenseId: act.license_id as string,
      customerEmail: (act.customer_email as string | null) ?? null,
      expiresAt: new Date(act.expires_at as string),
      licenseType: license.license_type as 'test' | 'premium',
      licenseKey: (license.license_key as string) ?? '',
    };
  }

  return null;
}

/** Updates last_seen when column exists (post-migration). Silent no-op on legacy schema. */
export async function touchActivationLastSeen(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  activationId: string
): Promise<void> {
  const { error } = await supabase
    .from('license_activations')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', activationId);
  if (error) {
    /* legacy schema without last_seen_at */
  }
}

export async function lookupLicenseByKey(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  licenseKey: string
): Promise<{ data: LicenseRow | null; error: unknown }> {
  const pepper = getLicenseKeyPepper();
  if (pepper) {
    const keyHash = await hashLicenseKey(licenseKey, pepper);
    const hashed = await supabase
      .from('app_licenses')
      .select(`${LICENSE_SELECT_LEGACY}, key_hash`)
      .eq('key_hash', keyHash)
      .maybeSingle();
    if (!hashed.error && hashed.data) {
      return { data: hashed.data as LicenseRow, error: null };
    }
  }

  const { data, error } = await supabase
    .from('app_licenses')
    .select(LICENSE_SELECT_LEGACY)
    .eq('license_key', licenseKey)
    .maybeSingle();

  return { data: (data as LicenseRow | null) ?? null, error };
}

export async function ensureTrialDevice(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  installationId: string
): Promise<TrialDeviceRow> {
  const config = readEdgeTrialConfig();
  const now = new Date();
  const nowIso = now.toISOString();
  const trialSelect =
    'device_id, trial_started_at, trial_ends_at, created_at, status, scan_count, max_scans_snapshot, installation_id, last_seen_at';

  let { data: existing } = await supabase
    .from('trial_devices')
    .select(trialSelect)
    .eq('installation_id', installationId)
    .maybeSingle();

  if (!existing) {
    const { data: legacy } = await supabase
      .from('trial_devices')
      .select(trialSelect)
      .eq('device_id', installationId)
      .maybeSingle();
    existing = legacy ?? null;
    if (existing && !existing.installation_id) {
      await supabase
        .from('trial_devices')
        .update({ installation_id: installationId, last_seen_at: nowIso })
        .eq('device_id', existing.device_id as string);
      existing = { ...existing, installation_id: installationId, last_seen_at: nowIso };
    }
  }

  if (existing) {
    const row = existing as TrialDeviceRow;
    await supabase
      .from('trial_devices')
      .update({ last_seen_at: nowIso })
      .eq('installation_id', row.installation_id ?? installationId);
    return { ...row, last_seen_at: nowIso, installation_id: row.installation_id ?? installationId };
  }

  const durationDays = await resolveEdgeTrialDurationDays(async (key, min, max) => {
    const { data, error } = await supabase.rpc('get_commercial_setting_int', {
      p_key: key,
      p_min: min,
      p_max: max,
    });
    if (error) return null;
    return typeof data === 'number' ? data : null;
  });

  const ends = addDays(now, durationDays);
  const insertRow = {
    device_id: installationId,
    installation_id: installationId,
    trial_started_at: nowIso,
    trial_ends_at: ends.toISOString(),
    scan_count: 0,
    max_scans_snapshot: config.trialMaxScans,
    status: 'active',
    last_seen_at: nowIso,
  };
  await supabase.from('trial_devices').insert(insertRow);
  return {
    device_id: installationId,
    trial_started_at: nowIso,
    trial_ends_at: ends.toISOString(),
    created_at: nowIso,
    status: 'active',
    scan_count: 0,
    max_scans_snapshot: config.trialMaxScans,
    installation_id: installationId,
    last_seen_at: nowIso,
  };
}

/**
 * Paid activation OR active (time+scan) trial.
 * Used by AI Edge paths so leftover credits cannot bypass an expired trial.
 */
export async function isInstallationCommerciallyActive(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  installationId: string
): Promise<boolean> {
  const activation = await findActiveActivation(supabase, installationId);
  if (activation) return true;
  const trial = await ensureTrialDevice(supabase, installationId);
  return isTrialAccessActive(trial);
}

export async function assertInstallationCommerciallyActive(
  installationId: string
): Promise<boolean> {
  const supabase = await createAdminClient();
  return isInstallationCommerciallyActive(supabase, installationId);
}

export async function recordTrialScanEvent(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  installationId: string,
  operationId: string
): Promise<{ duplicate: boolean; scanCount: number; trialActive: boolean } | null> {
  const { data, error } = await supabase.rpc('record_trial_scan', {
    p_installation_id: installationId,
    p_operation_id: operationId,
  });
  if (error || !data) return null;
  const payload = data as {
    duplicate?: boolean;
    scan_count?: number;
    trial_active?: boolean;
  };
  return {
    duplicate: Boolean(payload.duplicate),
    scanCount: Math.max(0, payload.scan_count ?? 0),
    trialActive: Boolean(payload.trial_active),
  };
}

export { isTrialAccessActive, trialResponseFields };

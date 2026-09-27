import { readTrialCommercialConfig } from '../../../lib/trial-config.ts';
import { resolveTrialDurationDays } from '../../../lib/commercial-settings.ts';
import {
  normalizeTrialDeviceStatus,
  resolveTrialAccess,
  trialStatusAfterEvaluation,
  type TrialDeviceStatus,
} from '../../../lib/trial-status.ts';

export type TrialDeviceRow = {
  device_id: string;
  trial_started_at: string;
  trial_ends_at: string;
  created_at: string;
  status?: string;
  scan_count?: number;
  max_scans_snapshot?: number | null;
  installation_id?: string | null;
  last_seen_at?: string | null;
};

type EnvReader = Record<string, string | undefined>;

function edgeEnv(): EnvReader {
  if (typeof process !== 'undefined' && process.env) return process.env;
  const deno = (globalThis as { Deno?: { env: { toObject(): Record<string, string> } } })
    .Deno;
  return deno?.env.toObject() ?? {};
}

export function readEdgeTrialConfig() {
  return readTrialCommercialConfig(edgeEnv());
}

/** Async duration: emergency ENV → DB → code fallback. */
export async function resolveEdgeTrialDurationDays(
  readDbInt?: (
    key: string,
    min: number,
    max: number
  ) => Promise<number | null>
): Promise<number> {
  const resolved = await resolveTrialDurationDays({
    env: edgeEnv(),
    readDbInt,
  });
  return resolved.days;
}

export function trialResponseFields(row: TrialDeviceRow): {
  trialStartedAt: string;
  trialExpiresAt: string;
  trialScanCount: number;
  trialMaxScans: number;
  trialScansRemaining: number;
  trialDeviceStatus: TrialDeviceStatus;
} {
  const config = readEdgeTrialConfig();
  const scanCount = Math.max(0, row.scan_count ?? 0);
  const maxScans = row.max_scans_snapshot ?? config.trialMaxScans;
  const snapshot = {
    trialStartedAt: row.trial_started_at,
    trialExpiresAt: row.trial_ends_at,
    scanCount,
    maxScans,
    status: normalizeTrialDeviceStatus(row.status ?? 'active'),
  };
  const { active } = resolveTrialAccess(snapshot);
  const trialDeviceStatus = active
    ? 'active'
    : trialStatusAfterEvaluation(snapshot);

  return {
    trialStartedAt: row.trial_started_at,
    trialExpiresAt: row.trial_ends_at,
    trialScanCount: scanCount,
    trialMaxScans: maxScans,
    trialScansRemaining: Math.max(0, maxScans - scanCount),
    trialDeviceStatus,
  };
}

export function isTrialAccessActive(row: TrialDeviceRow): boolean {
  const fields = trialResponseFields(row);
  if (fields.trialDeviceStatus !== 'active') return false;
  const expiresMs = new Date(fields.trialExpiresAt).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return false;
  return fields.trialScansRemaining > 0;
}

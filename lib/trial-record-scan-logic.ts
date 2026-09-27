import type { TrialDeviceStatus } from './trial-status';
import { trialStatusAfterEvaluation, type TrialQuotaSnapshot } from './trial-status';

export interface TrialDeviceRecordState {
  installationId: string;
  deviceId: string;
  status: TrialDeviceStatus;
  trialExpiresAt: string;
  scanCount: number;
  maxScans: number;
}

export interface TrialScanRecordSimulationInput {
  state: TrialDeviceRecordState;
  operationId: string;
  recordedOperationIds: ReadonlySet<string>;
  nowMs?: number;
}

export type TrialScanRejectReason = 'expired_time' | 'expired_scans' | 'inactive';

export interface TrialScanRecordSimulationResult {
  state: TrialDeviceRecordState;
  duplicate: boolean;
  rejected: boolean;
  rejectReason: TrialScanRejectReason | null;
  recorded: boolean;
  trialActive: boolean;
  trialDeviceStatus: TrialDeviceStatus;
}

function quotaSnapshot(
  state: TrialDeviceRecordState,
  nowMs: number
): TrialQuotaSnapshot {
  return {
    trialStartedAt: null,
    trialExpiresAt: state.trialExpiresAt,
    scanCount: state.scanCount,
    maxScans: state.maxScans,
    status: state.status,
    nowMs,
  };
}

/**
 * Mirrors Postgres `record_trial_scan` authorization order (pre-deploy unit tests).
 */
export function simulateRecordTrialScan(
  input: TrialScanRecordSimulationInput
): TrialScanRecordSimulationResult {
  const nowMs = input.nowMs ?? Date.now();
  let state = { ...input.state };

  if (input.recordedOperationIds.has(input.operationId)) {
    const trialActive = evaluateTrialActive(state, nowMs);
    return {
      state,
      duplicate: true,
      rejected: false,
      rejectReason: null,
      recorded: false,
      trialActive,
      trialDeviceStatus: state.status,
    };
  }

  if (state.status !== 'active') {
    return reject(state, nowMs, 'inactive');
  }

  const expiresMs = new Date(state.trialExpiresAt).getTime();
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
    state = { ...state, status: 'expired_time' };
    return reject(state, nowMs, 'expired_time');
  }

  if (state.scanCount >= state.maxScans) {
    state = { ...state, status: 'expired_scans' };
    return reject(state, nowMs, 'expired_scans');
  }

  const nextCount = state.scanCount + 1;
  state = {
    ...state,
    scanCount: nextCount,
    status: nextCount >= state.maxScans ? 'expired_scans' : 'active',
  };

  return {
    state,
    duplicate: false,
    rejected: false,
    rejectReason: null,
    recorded: true,
    trialActive: evaluateTrialActive(state, nowMs),
    trialDeviceStatus: state.status,
  };
}

function evaluateTrialActive(state: TrialDeviceRecordState, nowMs: number): boolean {
  return (
    trialStatusAfterEvaluation(quotaSnapshot(state, nowMs)) === 'active' &&
    state.scanCount < state.maxScans &&
    new Date(state.trialExpiresAt).getTime() > nowMs
  );
}

function reject(
  state: TrialDeviceRecordState,
  nowMs: number,
  reason: TrialScanRejectReason
): TrialScanRecordSimulationResult {
  return {
    state,
    duplicate: false,
    rejected: true,
    rejectReason: reason,
    recorded: false,
    trialActive: false,
    trialDeviceStatus: state.status,
  };
}

/** Resolve trial row lookup key — primary installation_id, legacy device_id fallback. */
export function resolveTrialLookupInstallationId(
  installationId: string,
  row: { installationId: string | null; deviceId: string } | null
): boolean {
  if (!row) return false;
  if (row.installationId === installationId) return true;
  return row.installationId == null && row.deviceId === installationId;
}

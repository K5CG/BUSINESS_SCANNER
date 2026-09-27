import { getSharedTrialScanLedger, type TrialScanRecordResult } from './trial-scan-ledger';
import { readTrialCommercialConfig } from './trial-config';
import type { TrialQuotaSnapshot } from './trial-status';
import { trialIsActive, trialScansRemaining } from './trial-status';

export type TrialScanCountableEvent =
  | 'document_persisted'
  | 'business_card_draft_ready';

/** Events that must NOT increment trial scan count. */
export const TRIAL_SCAN_EXCLUDED_EVENTS = [
  'camera_open',
  'capture_cancelled',
  'retake_photo',
  'camera_error',
  'ocr_error_before_result',
  'technical_retry_same_operation',
] as const;

export interface RecordTrialScanContext {
  installationId: string;
  operationId: string;
  /** Premium / paid license — skip trial scan accounting */
  skipTrialAccounting: boolean;
  event: TrialScanCountableEvent;
}

export function shouldCountTrialScanEvent(
  event: string
): event is TrialScanCountableEvent {
  return event === 'document_persisted' || event === 'business_card_draft_ready';
}

/**
 * Multipage documents share one operationId for the whole capture session → one trial scan.
 */
export function isMultipageSingleTrialScan(pageCount: number): boolean {
  return pageCount >= 1;
}

export function buildTrialQuotaSnapshot(params: {
  installationId: string;
  trialStartedAt: string | null;
  trialExpiresAt: string | null;
  scanCount: number;
  maxScans?: number;
  status?: TrialQuotaSnapshot['status'];
  nowMs?: number;
}): TrialQuotaSnapshot {
  const config = readTrialCommercialConfig();
  return {
    trialStartedAt: params.trialStartedAt,
    trialExpiresAt: params.trialExpiresAt,
    scanCount: params.scanCount,
    maxScans: params.maxScans ?? config.trialMaxScans,
    status: params.status ?? 'active',
    nowMs: params.nowMs,
  };
}

export function recordTrialScanLocally(
  ctx: RecordTrialScanContext
): TrialScanRecordResult | null {
  if (ctx.skipTrialAccounting) return null;
  if (!shouldCountTrialScanEvent(ctx.event)) return null;

  const ledger = getSharedTrialScanLedger();
  return ledger.recordScan({
    installationId: ctx.installationId,
    operationId: ctx.operationId,
  });
}

export function canStartTrialScan(params: {
  snapshot: TrialQuotaSnapshot;
  isPremium: boolean;
}): boolean {
  if (params.isPremium) return true;
  return trialIsActive(params.snapshot);
}

export function formatTrialScanUsage(snapshot: TrialQuotaSnapshot): {
  used: number;
  max: number;
  remaining: number;
} {
  const max = snapshot.maxScans;
  const used = Math.min(snapshot.scanCount, max);
  return {
    used,
    max,
    remaining: trialScansRemaining(snapshot),
  };
}

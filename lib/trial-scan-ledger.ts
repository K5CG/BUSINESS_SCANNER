/**
 * In-memory idempotent trial scan counter (Phase 3C.5 local / pre-deploy).
 * Production: `trial_scan_events` + `record_trial_scan` RPC in Postgres.
 */

export interface TrialScanRecordInput {
  installationId: string;
  operationId: string;
}

export interface TrialScanRecordResult {
  recorded: boolean;
  duplicate: boolean;
  scanCount: number;
}

export class InMemoryTrialScanLedger {
  private readonly operationKeys = new Set<string>();
  private readonly counts = new Map<string, number>();

  private key(installationId: string, operationId: string): string {
    return `${installationId}:${operationId}`;
  }

  getScanCount(installationId: string): number {
    return this.counts.get(installationId) ?? 0;
  }

  hasOperation(installationId: string, operationId: string): boolean {
    return this.operationKeys.has(this.key(installationId, operationId));
  }

  recordScan(input: TrialScanRecordInput): TrialScanRecordResult {
    const opKey = this.key(input.installationId, input.operationId);
    if (this.operationKeys.has(opKey)) {
      return {
        recorded: false,
        duplicate: true,
        scanCount: this.getScanCount(input.installationId),
      };
    }
    this.operationKeys.add(opKey);
    const next = this.getScanCount(input.installationId) + 1;
    this.counts.set(input.installationId, next);
    return { recorded: true, duplicate: false, scanCount: next };
  }

  reset(): void {
    this.operationKeys.clear();
    this.counts.clear();
  }
}

let sharedLedger: InMemoryTrialScanLedger | null = null;

export function getSharedTrialScanLedger(): InMemoryTrialScanLedger {
  if (!sharedLedger) sharedLedger = new InMemoryTrialScanLedger();
  return sharedLedger;
}

export function resetSharedTrialScanLedger(): void {
  sharedLedger?.reset();
  sharedLedger = null;
}

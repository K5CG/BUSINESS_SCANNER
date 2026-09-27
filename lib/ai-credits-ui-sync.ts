/**
 * Sync LicenseProvider AI credit UI state from authoritative Edge responses.
 * Never invents a balance locally (no client-side pageCount subtraction).
 */

export type AiCreditsUiSyncSource = 'pdf' | 'document' | 'card' | 'unknown';

export function isAuthoritativeAiCreditsRemaining(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Returns the next remaining balance when the server provides an authoritative
 * number; otherwise null (caller must leave existing UI balance unchanged).
 */
export function nextAiCreditsRemainingFromServer(value: unknown): number | null {
  return isAuthoritativeAiCreditsRemaining(value) ? value : null;
}

export function applyAiCreditsRemainingToStatus<T extends { aiCreditsRemaining: number | null }>(
  status: T,
  value: unknown
): T | null {
  const next = nextAiCreditsRemainingFromServer(value);
  if (next === null) return null;
  if (status.aiCreditsRemaining === next) return status;
  return { ...status, aiCreditsRemaining: next };
}

import { isDevLogEnabled } from './release-diagnostics';

/**
 * Temporary sanitized credit-UI diagnostic.
 * DEV/QA gated; silent in production store builds (`RELEASE_QA_DIAGNOSTICS=false`).
 * Never logs license keys, installation ids, or document contents.
 */
export function logAiCreditsUiSync(input: {
  source: AiCreditsUiSyncSource;
  previous: number | null;
  next: number;
}): void {
  if (!isDevLogEnabled()) return;
  console.warn(
    `[AiCreditsUiSync] ${JSON.stringify({
      source: input.source,
      previous: input.previous,
      next: input.next,
    })}`
  );
}

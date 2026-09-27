/**
 * Test-only release policy for phase 6B.
 *
 * The production RC policy intentionally suspends general cloud AI.
 * These integration tests provide their own deterministic cloud extractor,
 * so the policy gate must be opened only inside this bundled test surface.
 */
export const isRcCloudAiEnabled = (): boolean => true;
export const isRcPdfImportEnabled = (): boolean => true;
export const isRcTrialScanQuotaAdvertised = (): boolean => false;
export const RC_TRIAL_TIME_ONLY = true;
export const RC_AI_DISABLED = false;
export const RC_PDF_IMPORT_ALLOWED = true;

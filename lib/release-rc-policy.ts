/**
 * Android release-candidate policy (2026-08-09).
 *
 * Keep these flags true until durable Supabase scan metering and Postgres AI
 * credit ledger are verified end-to-end against the live project and redeployed
 * edge functions. Safe + limited beats feature-rich + unverified.
 */
export const RC_TRIAL_TIME_ONLY = true;
export const RC_AI_DISABLED = true;

/** QA ONLY: abilita gli stessi percorsi cloud AI di documenti e biglietti nella build di collaudo. */
export const RC_AI_QA_ALLOWED = true;

/**
 * QA ONLY: mostra il ri-OCR massivo dalle foto salvate.
 * Deve essere false nella build Play Store; il ri-OCR singolo con review resta.
 */
export const RC_CONTACT_REOCR_QA_ENABLED = true;

/**
 * QA ONLY — DO NOT SHIP ENABLED UNTIL pdf_page_ai durable ledger is verified
 * end-to-end.
 *
 * L'importazione PDF passa comunque da Gemini, quindi resta soggetta alla
 * sospensione generale: questo flag la scorpora soltanto per poterla collaudare
 * su dispositivo senza riaprire le altre funzioni AI. Prima della release deve
 * tornare `false` finché la contabilità dei crediti non è verificata.
 */
export const RC_PDF_IMPORT_ALLOWED = true;

export function isRcCloudAiEnabled(): boolean {
  // QA must exercise the exact cloud path while the production RC remains
  // suspended. The single QA flag is intentionally the only override.
  return !RC_AI_DISABLED || RC_AI_QA_ALLOWED;
}

export function isRcPdfImportEnabled(): boolean {
  return RC_PDF_IMPORT_ALLOWED;
}

export function isRcTrialScanQuotaAdvertised(): boolean {
  return !RC_TRIAL_TIME_ONLY;
}

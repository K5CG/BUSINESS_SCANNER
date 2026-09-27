/**
 * Central release diagnostics gates (minimal shared switch).
 *
 * - DEV: Metro / `__DEV__ === true` local builds
 * - QA: non-dev RC APKs that still need camera/PDF stage traces
 * - Production store builds: keep both false
 *
 * Do not log raw OCR / PDF / PII through these channels.
 */
declare const __DEV__: boolean | undefined;

/**
 * Master switch for QA diagnostics on release-candidate APKs built with
 * `--dev false`. Must remain **false** for Play Store production.
 * Flip to true only for temporary QA instrumentation sessions.
 */
export const RELEASE_QA_DIAGNOSTICS = false;

export function isDevLogEnabled(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

/** DEV or explicit QA instrumentation (never on production store builds). */
export function isQaLogEnabled(): boolean {
  return RELEASE_QA_DIAGNOSTICS || isDevLogEnabled();
}

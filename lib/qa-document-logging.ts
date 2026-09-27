/**
 * QA document logging is independent of Metro `__DEV__`.
 * The next QA APK must emit build/deadline/stage fingerprints without OCR text.
 */
export const DOCUMENT_QA_LOGGING = true;

export function isQaDocumentLoggingEnabled(): boolean {
  if (typeof process !== 'undefined' && (
    process.env?.NODE_ENV === 'test' || process.env?.NODE_TEST_CONTEXT
  ) && process.env?.EXPO_PUBLIC_QA_DOCUMENT_LOGGING !== 'true') {
    return false;
  }
  if (DOCUMENT_QA_LOGGING) return true;
  if (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_QA_DOCUMENT_LOGGING === 'true') {
    return true;
  }
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

export function logQaDocument(tag: string, payload: Record<string, unknown>): void {
  if (!isQaDocumentLoggingEnabled()) return;
  console.warn(`[${tag}] ${JSON.stringify(payload)}`);
}

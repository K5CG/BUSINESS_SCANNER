import { isQaDocumentLoggingEnabled } from './qa-document-logging';

export type DocumentProcessStep =
  | 'start'
  | 'image_prepare_start'
  | 'image_prepare_done'
  | 'ocr_start'
  | 'ocr_done'
  | 'structured_start'
  | 'structured_stage'
  | 'structured_done'
  | 'merge_start'
  | 'merge_done'
  | 'persist_start'
  | 'persist_done'
  | 'page_results_start'
  | 'page_results_stage'
  | 'page_results_done'
  | 'total'
  | 'watchdog_warning'
  | 'watchdog_timeout';

declare const __DEV__: boolean | undefined;

export function logDocumentProcess(
  step: DocumentProcessStep,
  detail?: Record<string, unknown>,
): void {
  if (!isQaDocumentLoggingEnabled()) return;
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[DocumentProcess] ${step}${suffix}`);
}

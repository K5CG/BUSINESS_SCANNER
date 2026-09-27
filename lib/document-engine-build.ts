import { PARSER_BUILD_ID } from './parser-version';
import {
  SINGLE_PAGE_PROCESS_HARD_MS,
  TWO_PAGE_PROCESS_HARD_MS,
} from './scan-process-deadline';
import { isQaDocumentLoggingEnabled, logQaDocument } from './qa-document-logging';

export const DOCUMENT_ENGINE_VERSION = '2026-08-17-final-device-closure';
export const ORIENTATION_HELPER_VERSION = 'visual-0-90-180-270-v5';

export function documentEngineBuildFingerprint(input?: {
  pageCount?: number;
  deadlineMode?: string;
}): Record<string, string | number | undefined> {
  return {
    engineVersion: DOCUMENT_ENGINE_VERSION,
    parserBuildId: PARSER_BUILD_ID,
    orientationVersion: ORIENTATION_HELPER_VERSION,
    deadlineMode: input?.deadlineMode,
    singlePageProcessMs: SINGLE_PAGE_PROCESS_HARD_MS,
    twoPageProcessMs: TWO_PAGE_PROCESS_HARD_MS,
    pageCount: input?.pageCount,
  };
}

export function logDocumentEngineBuild(input?: {
  pageCount?: number;
  deadlineMode?: string;
}): void {
  if (!isQaDocumentLoggingEnabled()) return;
  logQaDocument('DocumentEngineBuild', documentEngineBuildFingerprint(input));
}

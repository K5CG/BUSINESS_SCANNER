import type { NormalizedInput } from '../../types';
import { extractPhoneCandidates as originalExtractPhoneCandidates } from '../../extractors/phone';

/**
 * Proxy to the existing phone extraction logic.
 * This utility lives in the common validators folder for easier import
 * from other validators that need phone candidate extraction.
 */
export function extractPhoneCandidates(input: NormalizedInput) {
  return originalExtractPhoneCandidates(input);
}

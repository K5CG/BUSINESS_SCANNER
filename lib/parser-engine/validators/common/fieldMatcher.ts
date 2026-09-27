import { levenshteinDistance } from '../dictionaries';

/**
 * Checks if a given value appears in the raw OCR text with a tolerant matching.
 * Returns true if the value is found exactly, or if a fuzzy match within a
 * small Levenshtein distance and sufficient token overlap exists.
 */
export function fieldInRaw(value: string, rawText: string): boolean {
  if (!value || !rawText) return false;
  const normalized = value.trim().toLowerCase();
  const raw = rawText.toLowerCase();
  // Direct substring check first – fast path.
  if (raw.includes(normalized)) return true;

  // Token based fuzzy check.
  const valueTokens = normalized.split(/\s+/).filter(Boolean);
  const rawTokens = raw.split(/\s+/).filter(Boolean);
  // If any token matches exactly, we consider it present.
  for (const vt of valueTokens) {
    if (rawTokens.includes(vt)) return true;
  }

  // Levenshtein distance fallback – allow small typo tolerance.
  for (const rt of rawTokens) {
    if (levenshteinDistance(normalized, rt) <= 2) return true;
  }
  return false;
}

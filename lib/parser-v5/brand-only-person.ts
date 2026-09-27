/**
 * Recupero persona su card dove il marchio domina (EXHAUST SYSTÈM + MOSCATELLI LUCA).
 */
import { isProductBrandLineAsPerson, shouldRejectPersonCandidate } from './semantic-class';
import { parseCapsSurnameFirstLine, normalizeFusedPersonLine } from './person-token-split';
import { parsePersonNameFromLine, validatePersonName } from '../parser-engine/validators/name';
import {
  COMMON_FIRST_NAMES,
  normalizeBrandKey,
} from '../parser-engine/validators/dictionaries';
import { personEmailAffinityScore } from './person-email-ownership';

function hasPositivePersonEvidence(
  line: string,
  firstName: string,
  lastName: string,
  emails: string[]
): boolean {
  if (COMMON_FIRST_NAMES.has(normalizeBrandKey(firstName))) return true;
  if (personEmailAffinityScore(firstName, lastName, emails) >= 3) return true;
  return /^(?:(?:dott|dott\.ssa|dr|prof|avv|ing|arch|geom|rag|sig|sig\.ra)\.?\s+)/i.test(
    line.trim()
  );
}

export function recoverPersonOnBrandOnlyCard(
  rawText: string | undefined,
  emails: string[] = [],
  emailToks: string[] = []
): { firstName: string; lastName: string } | null {
  if (!rawText?.trim()) return null;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const hasBrandLine = lines.some((l) => isProductBrandLineAsPerson(l));
  if (!hasBrandLine) return null;

  let best: { firstName: string; lastName: string; score: number } | null = null;

  for (const line of lines) {
    if (shouldRejectPersonCandidate(line) || isProductBrandLineAsPerson(line)) continue;

    const caps = parseCapsSurnameFirstLine(line);
    if (caps) {
      if (
        !hasPositivePersonEvidence(
          line,
          caps.firstName,
          caps.lastName,
          emails
        )
      ) {
        continue;
      }
      const score = 4;
      if (score > (best?.score ?? 0)) best = { ...caps, score };
      continue;
    }

    const normalized = normalizeFusedPersonLine(line, emails, emailToks);
    const parsed = parsePersonNameFromLine(normalized);
    if (!parsed?.firstName || !parsed?.lastName) continue;
    const validated = validatePersonName(parsed);
    if (!validated?.firstName || !validated.lastName) continue;
    if (
      !hasPositivePersonEvidence(
        line,
        validated.firstName,
        validated.lastName,
        emails
      )
    ) {
      continue;
    }
    const titleCase =
      /^[A-ZÀ-Ü][a-zà-ü]/.test(validated.firstName) &&
      /^[A-ZÀ-Ü][a-zà-ü]/.test(validated.lastName);
    const score = titleCase ? 3 : 2;
    if (score > (best?.score ?? 0)) {
      best = {
        firstName: validated.firstName,
        lastName: validated.lastName,
        score,
      };
    }
  }

  return best ? { firstName: best.firstName, lastName: best.lastName } : null;
}

import { isAllCaps, tokenize } from '../normalize/tokens';
import {
  hasCompanyDescriptorInText,
  isDescriptiveActivityLine,
  looksLikeCatalogLine,
} from '../scoring/features';
import {
  ROLE_KEYWORD_REGEX,
  containsFuzzyRoleWord,
  hasAmbiguousTerminalLegalSeparator,
  hasTerminalLegalFormSuffix,
  matchTerminalLegalFormSuffix,
} from './dictionaries';
import { isPlausiblePersonNameLine } from './name';

const SLOGAN_CLAIM_WORDS = new Set([
  'innovation',
  'innovative',
  'technology',
  'consulting',
  'bridge',
  'software',
  'business',
  'soluzioni',
  'solutions',
  'systems',
  'digital',
  'future',
  'excellence',
]);

const SLOGAN_ACTION_WORDS = new Set([
  'build',
  'built',
  'connect',
  'create',
  'drive',
  'empower',
  'grow',
  'imagine',
  'inspire',
  'lead',
  'make',
  'move',
  'shape',
  'shaping',
  'transform',
]);

const SLOGAN_ABSTRACT_WORDS = new Set([
  'action',
  'confidence',
  'future',
  'ideas',
  'innovation',
  'passion',
  'quality',
  'tomorrow',
  'world',
]);

function countSloganClaimWords(text: string): number {
  return tokenize(text).filter((word) =>
    SLOGAN_CLAIM_WORDS.has(word.toLowerCase().replace(/[.,'’`-]/g, ''))
  ).length;
}

/**
 * Slogan/claim aziendale (es. SOFTWARE TECHNOLOGY INNOVATION) — non ruolo professionale.
 */
export function isCompanySloganClaimLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 8) return false;
  const professionalHeaderKey = t
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]/g, '');
  if (
    /^studio(?:legale?|notarile|tecnico|commerciale)/.test(
      professionalHeaderKey
    ) ||
    /^(?:commercialisti|avvocati)associati/.test(professionalHeaderKey)
  ) {
    return false;
  }

  const words = tokenize(t);
  if (words.length < 2) return false;
  if (hasTerminalLegalFormSuffix(t)) return false;

  const sloganHits = countSloganClaimWords(t);
  const normalizedWords = words.map((word) =>
    word.toLowerCase().replace(/[.,'’`-]/g, '')
  );
  const actionHits = normalizedWords.filter((word) =>
    SLOGAN_ACTION_WORDS.has(word)
  ).length;
  const abstractHits = normalizedWords.filter((word) =>
    SLOGAN_ABSTRACT_WORDS.has(word)
  ).length;
  const connectorHits = normalizedWords.filter((word) =>
    /^(?:a|an|the|for|into|where|with|forward|together)$/.test(word)
  ).length;

  if (/\bas\s+(?:an?|the)\s+(?:service|platform|solution|product)\b/i.test(t)) {
    return true;
  }
  if (
    /^the\s+[\p{L}][\p{L}'’ -]{1,40}\s+(?:is|are)\s+[\p{L}][\p{L}'’ -]{1,40}$/iu.test(
      t
    )
  ) {
    return true;
  }
  if (
    /^[\p{L}'’]+ing\s+(?:a|an|the)\s+[\p{L}'’]+(?:\s+[\p{L}'’]+){1,3}$/iu.test(
      t
    )
  ) {
    return true;
  }
  if (
    words.length >= 3 &&
    words.length <= 6 &&
    isAllCaps(t) &&
    (
      actionHits >= 2 ||
      (actionHits >= 1 && abstractHits >= 1 && connectorHits >= 1) ||
      (abstractHits >= 2 && connectorHits >= 1) ||
      (actionHits >= 1 && connectorHits >= 2)
    )
  ) {
    return true;
  }

  // Claim marketing breve (es. INNOVATIVE BRIDGE) — non nome persona.
  if (words.length === 2 && isAllCaps(t) && sloganHits >= 1) return true;

  if (isPlausiblePersonNameLine(t)) return false;
  if (ROLE_KEYWORD_REGEX.test(t) || containsFuzzyRoleWord(t)) return false;
  const buzzwordLine =
    isDescriptiveActivityLine(t) ||
    hasCompanyDescriptorInText(t) ||
    looksLikeCatalogLine(t) ||
    sloganHits >= 2 ||
    (sloganHits >= 1 && words.length >= 3);

  if (!buzzwordLine) return false;
  if (isAllCaps(t)) return true;
  if (/\s-\s/.test(t) && words.length >= 3) return true;
  if (words.length >= 3 && !ROLE_KEYWORD_REGEX.test(t)) return true;
  if (words.length === 2 && isAllCaps(t) && sloganHits >= 1) return true;

  return false;
}

/**
 * Segnala una possibile label claim/slogan che termina con forma giuridica.
 * Non è un veto autonomo: i consumer devono confrontarla con email, sito o
 * altra evidenza business e lasciare il caso in review se resta ambiguo.
 */
export function isClaimLikeTerminalLegalPhrase(text: string): boolean {
  if (!hasAmbiguousTerminalLegalSeparator(text)) return false;
  const legal = matchTerminalLegalFormSuffix(text);
  if (!legal) return false;
  const brand = legal.brand.trim();
  if (
    /^(?:claim|slogan|tagline|motto|message|messaggio|payoff|headline|strapline)\s*[:=]/iu.test(
      brand
    )
  ) {
    return true;
  }
  return isCompanySloganClaimLine(brand);
}

/** Distanza in righe sotto un indice nome plausibile (1–3 = vicino). */
export function roleProximityToNameLine(
  roleLineIndex: number,
  nameLineIndices: number[]
): number {
  if (roleLineIndex < 0 || !nameLineIndices.length) return 0;
  let best = 0;
  for (const nameIdx of nameLineIndices) {
    const distance = roleLineIndex - nameIdx;
    if (distance >= 1 && distance <= 3) {
      best = Math.max(best, 0.92 - (distance - 1) * 0.12);
    }
  }
  return best;
}

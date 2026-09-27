/**
 * Riconciliazione conservativa OCR ↔ email (local-part).
 * Mai riscrivere usando dominio aziendale; solo evidenza forte sul local-part.
 */
import { isGenericProviderDomain } from '../parser-engine/extractors/website';
import {
  COMMON_FIRST_NAMES,
  levenshteinDistance,
  normalizeBrandKey,
} from '../parser-engine/validators/dictionaries';
import { parseNameFromEmailLocal, validatePersonName } from '../parser-engine/validators/name';
import { isLogoNoisePersonLine, isSloganAsPersonLine, shouldRejectPersonCandidate } from './semantic-class';

const MAX_SURNAME_DISTANCE = 2;
const MAX_FIRST_DISTANCE = 2;

function isGenericEmailLocal(email: string): boolean {
  const dom = email.split('@')[1]?.toLowerCase() ?? '';
  return !dom || isGenericProviderDomain(dom);
}

function parseInitialSurnameLocal(local: string): { initial: string; surname: string } | null {
  const lower = local.toLowerCase().trim();
  const m = lower.match(/^([a-zà-ü])\.?([a-zà-ü]{3,})$/i) ?? lower.match(/^([a-zà-ü])([a-zà-ü]{4,})$/i);
  if (!m) return null;
  return { initial: m[1], surname: m[2] };
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function ocrNameLooksCorrupted(first: string, last: string): boolean {
  const combined = `${first} ${last}`.trim();
  if (isSloganAsPersonLine(combined) || isLogoNoisePersonLine(combined)) return true;
  const lastKey = normalizeBrandKey(last);
  if (lastKey.length >= 5) {
    const vowels = (last.replace(/[^a-zà-ü]/gi, '').match(/[aeiouàèéìòù]/gi) ?? []).length;
    const letters = last.replace(/[^a-zà-ü]/gi, '').length;
    if (letters >= 6 && vowels / letters < 0.22) return true;
  }
  return false;
}

function emailSurnameCandidates(email: string): string[] {
  const local = (email.split('@')[0] ?? '').trim();
  if (!local || local.length < 4) return [];
  const out = new Set<string>();
  const parsed = parseNameFromEmailLocal(email);
  if (parsed?.lastName) out.add(parsed.lastName);
  const initSur = parseInitialSurnameLocal(local);
  if (initSur?.surname) out.add(capitalize(initSur.surname));
  const parts = local.split(/[._-]+/).filter((p) => p.length >= 3);
  if (parts.length >= 2) out.add(capitalize(parts[parts.length - 1]));
  if (parts.length === 1 && parts[0].length >= 5) {
    const lower = parts[0].toLowerCase();
    for (const first of COMMON_FIRST_NAMES) {
      if (lower.startsWith(first) && lower.length > first.length + 2) {
        out.add(capitalize(lower.slice(first.length)));
      }
    }
  }
  return [...out];
}

function emailFirstNameCandidates(email: string, surnameHint?: string): string[] {
  const local = (email.split('@')[0] ?? '').trim();
  if (!local) return [];
  const out = new Set<string>();
  const parsed = parseNameFromEmailLocal(email);
  if (parsed?.firstName) out.add(parsed.firstName);
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2 && parts[0].length >= 2) out.add(capitalize(parts[0]));
  const initSur = parseInitialSurnameLocal(local);
  if (initSur?.initial) {
    const matches = [...COMMON_FIRST_NAMES].filter((n) => n.startsWith(initSur.initial));
    if (matches.length === 1) out.add(capitalize(matches[0]));
    if (surnameHint && matches.length >= 2) {
      let best: string | null = null;
      let bestDist = 99;
      for (const name of matches) {
        const d = levenshteinDistance(normalizeBrandKey(name), normalizeBrandKey(initSur.initial));
        if (d < bestDist) {
          bestDist = d;
          best = name;
        }
      }
      if (best) out.add(capitalize(best));
    }
  }
  const lower = local.toLowerCase();
  for (const first of COMMON_FIRST_NAMES) {
    if (lower.startsWith(first) && lower.length > first.length + 2) {
      out.add(capitalize(first));
    }
  }
  if (initSur?.surname && surnameHint && normalizeBrandKey(initSur.surname) === normalizeBrandKey(surnameHint)) {
    for (const first of COMMON_FIRST_NAMES) {
      if (first.startsWith(initSur.initial)) out.add(capitalize(first));
    }
  }
  return [...out];
}

/**
 * Corregge nome/cognome OCR solo con evidenza convergente dall'email personale.
 */
export function reconcilePersonWithEmailEvidence(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  emails: string[] = []
): { firstName: string | null; lastName: string | null; reasons: string[] } {
  const reasons: string[] = [];
  let first = (firstName ?? '').trim();
  let last = (lastName ?? '').trim();

  const personal = emails.find((e) => {
    if (!e.includes('@') || isGenericEmailLocal(e)) return false;
    const fromEmail = parseNameFromEmailLocal(e);
    if (
      fromEmail?.firstName &&
      fromEmail?.lastName &&
      shouldRejectPersonCandidate(`${fromEmail.firstName} ${fromEmail.lastName}`)
    ) {
      return false;
    }
    return true;
  });
  if (!personal) return { firstName: first || null, lastName: last || null, reasons };

  const emailLastCandidates = emailSurnameCandidates(personal);
  let emailFirstCandidates = emailFirstNameCandidates(personal);
  if (!emailLastCandidates.length && !emailFirstCandidates.length) {
    return { firstName: first || null, lastName: last || null, reasons };
  }

  const ocrCorrupted = ocrNameLooksCorrupted(first, last);
  let surnameReconciled = false;

  // Cognome: email vs OCR
  if (emailLastCandidates.length && last) {
    const lastKey = normalizeBrandKey(last);
    const local = (personal.split('@')[0] ?? '').trim().toLowerCase();
    const localKey = normalizeBrandKey(local);
    if (localKey.endsWith(lastKey) && localKey.length <= lastKey.length + 2) {
      // i.cognome + "Icognome": l'OCR ha incollato al cognome l'iniziale che
      // appartiene al local-part. Si corregge soltanto quando coincidono
      // iniziale del nome, iniziale email e resto del cognome osservato.
      const initialSurname = parseInitialSurnameLocal(local);
      const firstKey = normalizeBrandKey(first);
      const emailSurnameKey = normalizeBrandKey(initialSurname?.surname ?? '');
      const gluedKey = initialSurname
        ? `${normalizeBrandKey(initialSurname.initial)}${emailSurnameKey}`
        : '';
      if (
        initialSurname &&
        firstKey.length >= 2 &&
        firstKey.startsWith(normalizeBrandKey(initialSurname.initial)) &&
        emailSurnameKey.length >= 3 &&
        lastKey === gluedKey
      ) {
        const repaired = validatePersonName({
          firstName: first || 'X',
          lastName: capitalize(initialSurname.surname),
        });
        if (repaired?.lastName) {
          last = repaired.lastName;
          surnameReconciled = true;
          reasons.push('iniziale email separata dal cognome OCR');
        }
      }
    } else {
    let bestEmailLast: string | null = null;
    let bestDist = 99;
    for (const cand of emailLastCandidates) {
      const candKey = normalizeBrandKey(cand);
      if (candKey.endsWith(lastKey) && candKey.length === lastKey.length + 1) continue;
      const d = levenshteinDistance(lastKey, candKey);
      if (d < bestDist) {
        bestDist = d;
        bestEmailLast = cand;
      }
    }
    if (
      bestEmailLast &&
      bestDist > 0 &&
      bestDist <= MAX_SURNAME_DISTANCE &&
      (ocrCorrupted || bestDist <= 1 || last.length <= 4)
    ) {
      const validated = validatePersonName({ firstName: first || 'X', lastName: bestEmailLast });
      if (validated?.lastName) {
        last = validated.lastName;
        surnameReconciled = true;
        reasons.push('cognome riconciliato con email');
      }
    }
    }
  } else if (emailLastCandidates.length && !last && ocrCorrupted) {
    const validated = validatePersonName({ firstName: first || 'X', lastName: emailLastCandidates[0] });
    if (validated?.lastName) {
      last = validated.lastName;
      surnameReconciled = true;
      reasons.push('cognome da email');
    }
  }

  if (surnameReconciled) {
    emailFirstCandidates = emailFirstNameCandidates(personal, last);
    const local = (personal.split('@')[0] ?? '').trim().toLowerCase();
    const initSur = parseInitialSurnameLocal(local);
    if (initSur && first) {
      let bestName: string | null = null;
      let bestDist = 99;
      let ties = 0;
      for (const name of COMMON_FIRST_NAMES) {
        if (!name.startsWith(initSur.initial)) continue;
        const d = levenshteinDistance(normalizeBrandKey(first), name);
        if (d < bestDist) {
          bestDist = d;
          bestName = name;
          ties = 1;
        } else if (d === bestDist) {
          ties += 1;
        }
      }
      if (bestName && bestDist > 0 && bestDist <= MAX_FIRST_DISTANCE && ties === 1) {
        const validated = validatePersonName({ firstName: capitalize(bestName), lastName: last || 'X' });
        if (validated?.firstName) {
          first = validated.firstName;
          reasons.push('nome riconciliato con iniziale email');
        }
      }
    }
  }

  // Nome: solo se OCR chiaramente corrotto o distante, con evidenza convergente
  if (emailFirstCandidates.length && first) {
    const firstKey = normalizeBrandKey(first);
    let bestEmailFirst: string | null = null;
    let bestDist = 99;
    let secondDist = 99;
    for (const cand of emailFirstCandidates) {
      const d = levenshteinDistance(firstKey, normalizeBrandKey(cand));
      if (d < bestDist) {
        secondDist = bestDist;
        bestDist = d;
        bestEmailFirst = cand;
      } else if (d < secondDist) {
        secondDist = d;
      }
    }
    const singleCandidate = emailFirstCandidates.length === 1;
    const strongSurnameEvidence = surnameReconciled || emailLastCandidates.some(
      (c) => levenshteinDistance(normalizeBrandKey(c), normalizeBrandKey(last)) <= 1
    );
    if (
      bestEmailFirst &&
      bestDist > 0 &&
      bestDist <= MAX_FIRST_DISTANCE &&
      (singleCandidate || secondDist - bestDist >= 2) &&
      (ocrCorrupted || strongSurnameEvidence) &&
      emailFirstCandidates.length <= 4
    ) {
      const validated = validatePersonName({ firstName: bestEmailFirst, lastName: last || 'X' });
      if (validated?.firstName) {
        first = validated.firstName;
        reasons.push('nome riconciliato con email');
      }
    }
  }

  if (ocrCorrupted && isLogoNoisePersonLine(`${first} ${last}`.trim())) {
    return { firstName: null, lastName: null, reasons: ['persona OCR non plausibile'] };
  }

  const final = validatePersonName({ firstName: first, lastName: last });
  return {
    firstName: final?.firstName ?? (first || null),
    lastName: final?.lastName ?? (last || null),
    reasons,
  };
}

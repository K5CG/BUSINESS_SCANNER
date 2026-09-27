import { looksLikeCatalogLine } from '../scoring/features';
import {
  ACTIVITY_WORDS_REGEX,
  COMMON_FIRST_NAMES,
  COMPANY_DESCRIPTOR_WORDS,
  containsFuzzyRoleWord,
  EMAIL_SINGLE_REGEX,
  hasLegalForm,
  hasPersonNameBreakingLowercaseWord,
  isCommonFirstName,
  isCompanyNoiseLine,
  isItalianCityName,
  levenshteinDistance,
  NON_PERSON_WORDS,
  ROLE_KEYWORD_REGEX,
  stripProfessionalTitle,
} from './dictionaries';
import { isGenericEmailLocalPart } from '../extractors/email';

export interface PersonNameValue {
  firstName: string;
  lastName: string;
}

function capitalizeWord(word: string): string {
  if (!word) return '';
  return word
    .replace(/[’‘´]/g, "'")
    .split(/(['`-])/)
    .map((part) =>
      /^[A-Za-zÀ-ü]/.test(part)
        ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
        : part
    )
    .join('');
}

/**
 * I token persona osservati non ricevono lettere nuove senza una seconda
 * evidenza indipendente. Qui si conserva quindi il token OCR.
 */
function repairOcrPersonToken(word: string): string {
  return word;
}

function exactFirstNameKey(word: string): string {
  return word
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]/g, '');
}

function isExactCommonFirstName(word: string): boolean {
  return COMMON_FIRST_NAMES.has(exactFirstNameKey(word));
}

export function repairExtraInternalOcrGlyphInFirstName(word: string): string {
  const observed = exactFirstNameKey(word);
  if (observed.length < 5) return word;
  const matches = new Set<string>();
  for (const candidate of COMMON_FIRST_NAMES) {
    if (observed.length !== candidate.length + 1) continue;
    for (let index = 1; index < observed.length - 1; index++) {
      if (
        observed.slice(0, index) + observed.slice(index + 1) ===
        candidate
      ) {
        matches.add(candidate);
      }
    }
  }
  if (matches.size !== 1) return word;
  return capitalizeWord([...matches][0]!);
}

function isSingleLetterInitial(word: string): boolean {
  const bare = word.replace(/\./g, '').trim();
  return bare.length === 1 && /^[A-Za-zÀ-Ü]$/.test(bare);
}

/** Correzione conservativa di typo OCR su nome noto: stessa iniziale e distanza limitata. */
export function fuzzyMatchCommonFirstName(token: string): string | null {
  const low = token.toLowerCase().replace(/[^a-zà-ü]/g, '');
  if (!low || low.length < 3) return null;
  if (COMMON_FIRST_NAMES.has(low)) return capitalizeWord(low);
  let best: { name: string; dist: number } | null = null;
  for (const first of COMMON_FIRST_NAMES) {
    if (low[0] !== first[0]) continue;
    const dist = levenshteinDistance(low, first);
    const maxDist =
      low.length >= 5 && first.length >= 5 && low.slice(0, 4) === first.slice(0, 4) ? 3 : 2;
    if (dist > maxDist) continue;
    if (!best || dist < best.dist) best = { name: first, dist };
    else if (dist === best.dist) {
      const preferA = low.endsWith('a') && first.endsWith('a');
      const preferBest = low.endsWith('a') && best.name.endsWith('a');
      if (preferA && !preferBest) best = { name: first, dist };
    }
  }
  return best ? capitalizeWord(best.name) : null;
}

/** Nome proprio OCR spurio (E', È, glifo singolo) — non persona. */
export function isSuspiciousPersonFirstName(firstName: string): boolean {
  const t = firstName.trim();
  if (!t) return true;
  const bare = t.replace(/\./g, '').trim();
  if (bare.length <= 1) return true;
  if (/^e[''`´]?$/i.test(bare)) return true;
  if (/^è$/i.test(bare)) return true;
  if (/^e[''`´]\s*/i.test(t)) return true;
  if (/^e[''`´]?$/i.test(bare.replace(/\s+/g, ''))) return true;
  return false;
}

const BRAND_SLOGAN_NAME_RE =
  /\b(?:international|solutions?|software)\b/i;

/** True se nome+cognome sembra slogan/marchio OCR, non persona. */
export function isBrandSloganPersonName(
  firstName: string | null | undefined,
  lastName: string | null | undefined
): boolean {
  const full = `${firstName ?? ''} ${lastName ?? ''}`.trim();
  if (!full) return false;
  if (isSuspiciousPersonFirstName(firstName ?? '')) return true;
  if (BRAND_SLOGAN_NAME_RE.test(full) && isSuspiciousPersonFirstName(firstName ?? '')) return true;
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length === 2 && /^e[''`´]?$/i.test(words[0]!.replace(/\./g, ''))) return true;
  if (words.some((w) => BRAND_SLOGAN_NAME_RE.test(w)) && words.length <= 2 && !isCommonFirstName(words[0] ?? '')) {
    return true;
  }
  return false;
}

function normalizeNameOrder(
  first: string,
  second: string
): PersonNameValue {
  if (isExactCommonFirstName(second) && !isExactCommonFirstName(first)) {
    return { firstName: capitalizeWord(second), lastName: capitalizeWord(first) };
  }
  return { firstName: capitalizeWord(first), lastName: capitalizeWord(second) };
}

const ITALIAN_OWNER_NAME_PREFIX =
  /^(?:di|del|della|dello|dei|degli)\s+(?:(?:dott\.?ssa?|dott\.?|sig\.?ra?|sig\.?|ing\.?|arch\.?|avv\.?|prof\.?|geom\.?)\s+)?/i;

function stripItalianOwnerPrefix(raw: string): string {
  return raw.trim().replace(ITALIAN_OWNER_NAME_PREFIX, '').trim();
}

/** True se la riga ha struttura plausibile di nome persona (senza selezionare). */
export function isPlausiblePersonNameLine(line: string): boolean {
  return parsePersonNameFromLine(line) !== null;
}

/**
 * Analizza una riga e restituisce nome/cognome se la struttura è plausibile.
 * Solo regole generiche: casing, dizionario nomi, esclusione ruoli/catalogo.
 */
export function parsePersonNameFromLine(raw: string): PersonNameValue | null {
  const observedText = raw.trim().replace(/[’‘´]/g, "'");
  let t = stripProfessionalTitle(observedText);
  t = stripItalianOwnerPrefix(t);
  t = t
    .replace(/([A-Za-z])0([A-Za-z])/g, '$1O$2')
    .replace(/\b0(?=[a-z])/gi, 'O')
    .replace(/[",]/g, ' ')
    .replace(/\b([A-Za-z])\.\s*(?=[A-Za-z])/g, '$1 ');
  if (!t || EMAIL_SINGLE_REGEX.test(t) || isCompanyNoiseLine(t)) return null;
  if (looksLikeCatalogLine(t)) return null;
  if (/^per\s+/i.test(t)) return null;
  t = t.replace(/[.,;:]+$/g, '');

  let words = t.split(/\s+/).filter(Boolean);
  while (words.length >= 3 && NON_PERSON_WORDS.has(words[0]!.toLowerCase().replace(/[.,]/g, ''))) {
    words = words.slice(1);
  }
  t = words.join(' ');
  if (words.length < 2 || words.length > 5) return null;
  if (hasLegalForm(t)) return null;
  if (ROLE_KEYWORD_REGEX.test(t)) return null;
  if (containsFuzzyRoleWord(t)) return null;
  if (/^impresa\b/i.test(t)) return null;

  const normalizedWords = words.map((word) =>
    repairOcrPersonToken(word.replace(/[.,]/g, ''))
  );
  const allCaps = normalizedWords.every((w) => /^[A-ZÀ-Ü'`-]+$/.test(w));
  const titleCase = normalizedWords.every((w) => /^[A-ZÀ-Ü][a-zà-ü'`-]*$/.test(w));
  const mixed = normalizedWords.every((w) => /^[A-Za-zÀ-ü'`-]+$/.test(w));
  if (!allCaps && !titleCase && !mixed) return null;

  const allLowercase = normalizedWords.every((w) => /^[a-zà-ü'`-]+$/.test(w));
  if (allLowercase) return null;
  if (normalizedWords.some((w) => w.length > 6 && /zione$/i.test(w))) return null;
  if (normalizedWords.some((w) => NON_PERSON_WORDS.has(w.toLowerCase()))) return null;
  if (normalizedWords.some((w) => isItalianCityName(w))) return null;
  if (normalizedWords.some((w) => COMPANY_DESCRIPTOR_WORDS.has(w.toLowerCase().replace(/[.,]/g, '')))) {
    return null;
  }
  if (ACTIVITY_WORDS_REGEX.test(t)) return null;
  if (hasPersonNameBreakingLowercaseWord(normalizedWords)) return null;

  if (normalizedWords.length === 2) {
    if (isSuspiciousPersonFirstName(normalizedWords[0])) return null;
    if (isBrandSloganPersonName(normalizedWords[0], normalizedWords[1])) return null;
    return normalizeNameOrder(normalizedWords[0], normalizedWords[1]);
  }

  if (normalizedWords.length === 3 && isSingleLetterInitial(normalizedWords[0])) {
    return {
      firstName: capitalizeWord(repairOcrPersonToken(normalizedWords[1])),
      lastName: capitalizeWord(normalizedWords[2]),
    };
  }

  if (normalizedWords.length === 3 && isSingleLetterInitial(normalizedWords[1])) {
    return {
      firstName: capitalizeWord(repairOcrPersonToken(normalizedWords[0])),
      lastName: capitalizeWord(normalizedWords[2]),
    };
  }

  if (normalizedWords.length >= 3 && !normalizedWords.some((w) => isCommonFirstName(w))) {
    return null;
  }

  if (normalizedWords.length >= 3) {
    const last = normalizedWords[normalizedWords.length - 1].toLowerCase();
    const first = normalizedWords[0].toLowerCase();
    if (isExactCommonFirstName(last) && !isExactCommonFirstName(first)) {
      return {
        firstName: capitalizeWord(normalizedWords[normalizedWords.length - 1]),
        lastName: normalizedWords.slice(0, -1).map(capitalizeWord).join(' '),
      };
    }
  }

  return {
    firstName: capitalizeWord(normalizedWords[0]),
    lastName: normalizedWords.slice(1).map(capitalizeWord).join(' '),
  };
}

/**
 * Valida un nome persona già estratto (formato e plausibilità generica).
 * Non seleziona tra candidati.
 */
export function validatePersonName(name: PersonNameValue): PersonNameValue | null {
  const firstName = name.firstName?.trim().replace(/[’‘´]/g, "'") ?? '';
  const lastName = name.lastName?.trim().replace(/[’‘´]/g, "'") ?? '';
  if (!firstName && !lastName) return null;
  if (firstName && isSuspiciousPersonFirstName(firstName)) return null;
  if (isBrandSloganPersonName(firstName, lastName)) return null;
  const nameToken = /^[A-Za-zÀ-ü'`-]+(?:\s+[A-Za-zÀ-ü'`-]+)*$/;
  const firstNameToken = /^(?:[A-Za-zÀ-Ü]\.\s+)?[A-Za-zÀ-ü'`-]+(?:\s+[A-Za-zÀ-ü'`-]+)*$/;
  if (firstName && !firstNameToken.test(firstName)) return null;
  if (lastName && !nameToken.test(lastName)) return null;

  const full = `${firstName} ${lastName}`.trim();
  if (looksLikeCatalogLine(full)) return null;
  if (/\bskype\b/i.test(full) || /@|www\./i.test(full)) return null;
  if (!firstName && lastName && (/\bskype\b/i.test(lastName) || /@|www\./i.test(lastName))) return null;
  if (ROLE_KEYWORD_REGEX.test(full)) return null;
  if (ACTIVITY_WORDS_REGEX.test(full)) return null;
  if (hasLegalForm(full)) return null;
  if (isItalianCityName(firstName) || isItalianCityName(lastName)) return null;

  return { firstName, lastName };
}

/**
 * Estrae nome/cognome dalla local-part di un'email personale (regole generiche).
 * Supporta cognome.nome, nome.cognome, iniziale.cognome, blocco unico con prefisso nome.
 */
export function parseNameFromEmailLocal(email: string): PersonNameValue | null {
  const local = email.split('@')[0] ?? '';
  if (!local || isGenericEmailLocalPart(email)) return null;

  const parts = local.split(/[._-]+/).filter((p) => p.length >= 1);
  if (parts.length === 0) return null;

  if (parts.length === 2) {
    const [a, b] = parts;
    if (a.length === 1) return null;
    if (isExactCommonFirstName(b) && !isExactCommonFirstName(a)) {
      return validatePersonName({
        firstName: capitalizeWord(b),
        lastName: capitalizeWord(a),
      });
    }
    if (isExactCommonFirstName(a)) {
      return validatePersonName({
        firstName: capitalizeWord(a),
        lastName: capitalizeWord(b),
      });
    }
    return validatePersonName(normalizeNameOrder(a, b));
  }

  if (parts.length === 1) {
    const lower = parts[0].toLowerCase();
    if (isCommonFirstName(lower)) {
      return validatePersonName({ firstName: capitalizeWord(lower), lastName: '' });
    }
    const initSurname = lower.match(/^([a-zà-ü])([a-zà-ü]{4,})$/i);
    if (initSurname) {
      const sur = initSurname[2]!;
      const surnameOnly = validatePersonName({
        firstName: '',
        lastName: capitalizeWord(sur),
      });
      if (surnameOnly?.lastName) {
        const initChar = initSurname[1]!.toLowerCase();
        const ambiguousInitSurname = lower.length === sur.length + 1 && lower === `${initChar}${sur}`;
        for (const first of [...COMMON_FIRST_NAMES].sort((a, b) => b.length - a.length)) {
          if (!first.startsWith(initChar)) continue;
          if (!lower.startsWith(first[0]!.toLowerCase())) continue;
          const fused = `${first}${sur}`.toLowerCase();
          if (
            levenshteinDistance(lower, fused) <= 2 ||
            (lower.length > sur.length + 1 && levenshteinDistance(lower.slice(0, first.length), first) <= 2)
          ) {
            const full = validatePersonName({
              firstName: capitalizeWord(first),
              lastName: capitalizeWord(sur),
            });
            if (full?.firstName && full.lastName) return full;
          }
        }
        if (ambiguousInitSurname) {
          return { firstName: '', lastName: surnameOnly.lastName };
        }
        return { firstName: '', lastName: surnameOnly.lastName };
      }
    }
    for (const first of COMMON_FIRST_NAMES) {
      if (lower.startsWith(first) && lower.length > first.length + 1) {
        return validatePersonName({
          firstName: capitalizeWord(first),
          lastName: capitalizeWord(lower.slice(first.length)),
        });
      }
    }
    const sortedNames = [...COMMON_FIRST_NAMES].sort((a, b) => b.length - a.length);
    for (const first of sortedNames) {
      if (lower.endsWith(first) && lower.length > first.length + 2) {
        return validatePersonName({
          firstName: capitalizeWord(first),
          lastName: capitalizeWord(lower.slice(0, lower.length - first.length)),
        });
      }
    }
    return null;
  }

  if (isCommonFirstName(parts[0])) {
    return validatePersonName({
      firstName: capitalizeWord(parts[0]),
      lastName: parts.slice(1).map(capitalizeWord).join(' '),
    });
  }

  return validatePersonName({
    firstName: capitalizeWord(parts[0]),
    lastName: parts.slice(1).map(capitalizeWord).join(' '),
  });
}

/**
 * True se il testo è una riga di attività professionale plausibile come ruolo
 * (es. intermediazioni, progettazione), non come ragione sociale.
 */
export function isLikelyActivityRoleLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 5 || t.length > 55) return false;
  if (parsePersonNameFromLine(t)) return false;
  if (looksLikeCatalogLine(t)) return false;
  if (ACTIVITY_WORDS_REGEX.test(t)) return true;
  return /\b(intermediazioni?|progettazione|produzione|commercio|consulenza|assistenza)\b/i.test(t);
}

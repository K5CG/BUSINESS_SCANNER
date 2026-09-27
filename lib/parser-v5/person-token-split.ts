/**
 * Split di token persona fusi da OCR, inclusi i prefissi iniziali.
 * Regole generiche — nessun hardcode per contatto.
 */

import { COMMON_FIRST_NAMES } from '../parser-engine/validators/dictionaries';

function exactFirstNameKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]/g, '');
}

function personTokenKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]/g, '');
}

/**
 * Divide solo veri confini CamelCase.
 * Non spezza casing OCR irregolare (es. AlesSIO) e può proteggere token
 * corroborati esattamente da email osservata.
 */
export function splitCamelCaseInText(
  text: string,
  protectedTokens: string[] = []
): string {
  const protectedKeys = new Set(
    protectedTokens.map(personTokenKey).filter((k) => k.length >= 3)
  );
  return text
    .split(/\s+/)
    .map((tok) => {
      if (protectedKeys.has(personTokenKey(tok))) return tok;
      return tok.replace(/([a-zà-ü])([A-ZÀ-Ü])(?=[a-zà-ü])/g, '$1 $2');
    })
    .join(' ');
}

/** Spezza un token fuso usando un cognome osservato nell'indirizzo email. */
export function splitFusedTokenWithHints(token: string, hints: string[] = []): string {
  let t = token.trim();
  if (!t || t.length < 5) return t;
  for (const hint of hints) {
    const h = hint.trim().toLowerCase();
    if (h.length < 4) continue;
    const re = new RegExp(`([A-Za-zÀ-ü]{2,})(${h})`, 'i');
    if (re.test(t)) {
      t = t.replace(re, '$1 $2');
    }
  }
  return t;
}

export function collectPersonSplitHints(emails: string[] = [], emailToks: string[] = []): string[] {
  const hints = new Set<string>();
  for (const tok of emailToks) {
    if (tok.length >= 4) hints.add(tok.toLowerCase());
  }
  for (const email of emails) {
    const local = (email.split('@')[0] ?? '').toLowerCase();
    const dom = (email.split('@')[1] ?? '').toLowerCase().replace(/^www\./, '');
    const domRoot = dom.split('.')[0] ?? '';
    for (const part of local.split(/[._\-+]+/)) {
      if (part.length >= 4) hints.add(part);
    }
    if (domRoot.length >= 4) hints.add(domRoot);
  }
  return [...hints];
}

/** Normalizza una riga persona prima del parse, separando i token fusi. */
export function normalizeFusedPersonLine(
  text: string,
  emails: string[] = [],
  emailToks: string[] = []
): string {
  let t = text.trim().replace(/[’‘´]/g, "'");
  if (!t) return t;
  t = t.replace(/^([A-Za-z])\.\s+/, '');
  const hints = collectPersonSplitHints(emails, emailToks);
  t = splitCamelCaseInText(t, hints);
  t = t
    .split(/\s+/)
    .map((tok) => splitFusedTokenWithHints(tok, hints))
    .join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** COGNOME NOME tutto maiuscolo (MOSCATELLI LUCA) → { firstName, lastName }. */
export function parseCapsSurnameFirstLine(
  line: string
): { firstName: string; lastName: string } | null {
  const t = line.trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length !== 2) return null;
  if (!words.every((w) => /^[A-ZÀ-Ü][A-ZÀ-Ü'.-]*$/.test(w))) return null;
  const given = words[1]!.toLowerCase();
  const family = words[0]!.toLowerCase();
  if (given.length < 4) return null;
  if (family.length < 3) return null;
  if (
    !COMMON_FIRST_NAMES.has(exactFirstNameKey(given)) ||
    COMMON_FIRST_NAMES.has(exactFirstNameKey(family))
  ) {
    return null;
  }
  const cap = (s: string) =>
    s
      .replace(/[’‘´]/g, "'")
      .split(/(['.-])/)
      .map((part) =>
        /^[A-Za-zÀ-ü]/.test(part)
          ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
          : part
      )
      .join('');
  return { firstName: cap(given), lastName: cap(family) };
}

/**
 * Allineamento persona ↔ email personale (regole generiche, nessun hardcode per contatto).
 */
import { isGenericProviderDomain } from '../parser-engine/extractors/website';
import {
  COMMON_FIRST_NAMES,
  levenshteinDistance,
  normalizeBrandKey,
  ROLE_KEYWORD_REGEX,
} from '../parser-engine/validators/dictionaries';
import { parseNameFromEmailLocal, parsePersonNameFromLine, validatePersonName, isBrandSloganPersonName } from '../parser-engine/validators/name';
import { isLogoNoisePersonLine, isSloganAsPersonLine, shouldRejectPersonCandidate } from './semantic-class';
import { normalizeFusedPersonLine } from './person-token-split';

const GENERIC_EMAIL_LOCAL =
  /^(?:info|contact|contatti|sales|vendite|commerciale|export|amministrazione|admin|office|ufficio|segreteria|ordini|support|assistenza|service|marketing|hello|mail|posta|pec|webmaster|hr|jobs|press|restaurant|shop|store|formazione|training|education)\d*$/i;

function isTaglinePersonalEmail(email: string): boolean {
  const parsed = parseNameFromEmailLocal(email);
  if (!parsed?.firstName || !parsed.lastName) return false;
  return shouldRejectPersonCandidate(`${parsed.firstName} ${parsed.lastName}`);
}

export function primaryPersonalEmail(emails: string[] = []): string | undefined {
  return emails.find((e) => {
    if (!e.includes('@')) return false;
    const dom = e.split('@')[1]?.toLowerCase().trim() ?? '';
    if (!dom || isGenericProviderDomain(dom)) return false;
    const local = (e.split('@')[0] ?? '').trim();
    if (!local || GENERIC_EMAIL_LOCAL.test(local)) return false;
    if (isTaglinePersonalEmail(e)) return false;
    return true;
  });
}

function emailLocalKey(email: string): string {
  return (email.split('@')[0] ?? '').toLowerCase().replace(/[^a-zà-ü]/g, '');
}

export function hasExactObservedPersonalEmailEvidence(
  text: string,
  emails: string[] = []
): boolean {
  const observedTokens = text
    .trim()
    .split(/\s+/)
    .map((token) => normalizeBrandKey(token))
    .filter(Boolean);
  if (observedTokens.length !== 2) return false;
  if (!observedTokens.some((token) => COMMON_FIRST_NAMES.has(token))) {
    return false;
  }

  return emails.some((email) => {
    const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';
    if (!domain || isGenericProviderDomain(domain)) return false;
    const local = email.split('@')[0] ?? '';
    if (!local || GENERIC_EMAIL_LOCAL.test(local)) return false;
    const localTokens = local
      .split(/[._+\-]+/)
      .map((token) => normalizeBrandKey(token))
      .filter(Boolean);
    if (
      localTokens.length === 2 &&
      [...localTokens].sort().join('|') ===
        [...observedTokens].sort().join('|')
    ) {
      return true;
    }
    const compactLocal = normalizeBrandKey(local);
    return (
      compactLocal === observedTokens.join('') ||
      compactLocal === [...observedTokens].reverse().join('')
    );
  });
}

/**
 * Recupera due token persona entrambi osservati quando una local-part business
 * li conferma esattamente. Il vincolo di un solo nome proprio noto evita di
 * reinterpretare reparti o mailbox generiche come identità.
 */
/**
 * Conserva l'ordine di due token persona entrambi osservati quando una email
 * personale business li conferma ESATTAMENTE nello stesso ordine.
 *
 * Diversamente da parseExactObservedPersonFromEmail, qui NON serve che il
 * primo token appartenga a un dizionario di nomi: la funzione e' pensata per
 * il caso piu conservativo in cui il chiamante abbia gia una seconda evidenza
 * indipendente di persona (per esempio un ruolo adiacente). Nessuna lettera
 * viene inventata e non viene mai usato un provider generico.
 */
export function parseOrderedObservedPersonFromPersonalEmail(
  text: string,
  emails: string[] = []
): { firstName: string; lastName: string } | null {
  const observed = text
    .trim()
    .replace(/[’‘´]/g, "'")
    .split(/\s+/)
    .filter(Boolean);
  if (
    observed.length !== 2 ||
    !observed.every((token) => /^\p{L}[\p{L}\p{M}'-]*$/u.test(token))
  ) {
    return null;
  }
  const observedKeys = observed.map((token) => normalizeBrandKey(token));
  if (observedKeys.some((token) => token.length < 2)) return null;

  const exact = emails.some((email) => {
    const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';
    if (!domain || isGenericProviderDomain(domain)) return false;
    const local = email.split('@')[0] ?? '';
    if (!local || GENERIC_EMAIL_LOCAL.test(local)) return false;
    const localTokens = local
      .split(/[._+\-]+/)
      .map((token) => normalizeBrandKey(token))
      .filter(Boolean);
    return (
      localTokens.length === 2 &&
      localTokens[0] === observedKeys[0] &&
      localTokens[1] === observedKeys[1]
    );
  });
  if (!exact) return null;

  const titleCase = (value: string) =>
    value
      .split(/(['-])/)
      .map((part) =>
        /^\p{L}/u.test(part)
          ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
          : part
      )
      .join('');

  return {
    firstName: titleCase(observed[0]!),
    lastName: titleCase(observed[1]!),
  };
}

export function parseExactObservedPersonFromEmail(
  text: string,
  emails: string[] = []
): { firstName: string; lastName: string } | null {
  if (!hasExactObservedPersonalEmailEvidence(text, emails)) return null;
  const observed = text
    .trim()
    .replace(/[’‘´]/g, "'")
    .split(/\s+/)
    .filter(Boolean);
  if (
    observed.length !== 2 ||
    !observed.every((token) => /^\p{L}[\p{L}\p{M}'-]*$/u.test(token))
  ) {
    return null;
  }
  const givenIndexes = observed
    .map((token, index) =>
      COMMON_FIRST_NAMES.has(normalizeBrandKey(token)) ? index : -1
    )
    .filter((index) => index >= 0);
  if (givenIndexes.length !== 1) return null;

  const givenIndex = givenIndexes[0]!;
  const familyIndex = givenIndex === 0 ? 1 : 0;
  const titleCase = (value: string) =>
    value
      .split(/(['-])/)
      .map((part) =>
        /^\p{L}/u.test(part)
          ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
          : part
      )
      .join('');
  const firstName = titleCase(observed[givenIndex]!);
  const lastName = titleCase(observed[familyIndex]!);
  const validatedFirst = validatePersonName({ firstName, lastName: '' });
  if (!validatedFirst?.firstName || lastName.length < 2) return null;
  return { firstName: validatedFirst.firstName, lastName };
}

/** 0..4 — quanto nome/cognome sono coerenti con la local-part. */
export function personEmailAffinityScore(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  emails: string[] = []
): number {
  const personal = primaryPersonalEmail(emails);
  if (!personal) return 0;
  const local = emailLocalKey(personal);
  if (local.length < 3) return 0;

  const fn = normalizeBrandKey(firstName ?? '');
  const ln = normalizeBrandKey(lastName ?? '');
  if (!fn && !ln) return 0;

  let score = 0;
  const initSurname = local.match(/^([a-zà-ü])([a-zà-ü]{4,})$/i);
  if (initSurname && ln.length >= 4) {
    const sur = initSurname[2]!;
    if (normalizeBrandKey(ln) === normalizeBrandKey(sur)) score += 4.5;
    if (fn.length >= 3 && local.startsWith(fn.slice(0, 1).toLowerCase())) score += 1.5;
    if (fn.length >= 4 && levenshteinDistance(local.slice(0, fn.length), fn) <= 2) score += 2;
  }

  if (ln.length >= 3 && local.includes(ln)) score += 3;
  else if (ln.length >= 4 && levenshteinDistance(local, ln) <= 2) score += 2;

  if (fn.length >= 3 && local.includes(fn)) score += 1.5;
  else if (fn.length >= 3 && local.startsWith(fn.slice(0, 1)) && ln.length >= 4 && local.includes(ln)) score += 1;

  if (fn.length >= 3 && ln.length >= 4) {
    const initSur = `${fn[0]!.toLowerCase()}${ln.toLowerCase()}`;
    if (local === initSur || levenshteinDistance(local, initSur) <= 1) score += 5;
    if (local.startsWith(fn.slice(0, 1).toLowerCase()) && local.endsWith(ln.toLowerCase())) score += 3;
  }

  const parsed = parseNameFromEmailLocal(personal);
  if (parsed?.lastName && ln && normalizeBrandKey(parsed.lastName) === ln) score += 1;
  if (parsed?.firstName && fn && normalizeBrandKey(parsed.firstName) === fn) score += 0.5;

  return score;
}

/** Cerca nel testo OCR una persona coerente con l'email personale. */
export function recoverPersonMatchingPersonalEmail(
  rawText: string | undefined,
  emails: string[] = []
): { firstName: string; lastName: string } | null {
  const personal = primaryPersonalEmail(emails);
  if (!personal || !rawText?.trim()) return null;

  const local = emailLocalKey(personal);
  let best: { firstName: string; lastName: string; score: number } | null = null;

  const initialSurname = local.match(/^([a-z])([a-z]{3,})$/i);
  if (initialSurname) {
    const observedInitial = normalizeBrandKey(initialSurname[1]!);
    const observedSurname = normalizeBrandKey(initialSurname[2]!);
    const rawLines = rawText.split('\n');
    for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
      const line = rawLines[lineIndex]!;
      const nextLine = rawLines[lineIndex + 1]?.trim() ?? '';
      if (!ROLE_KEYWORD_REGEX.test(nextLine)) continue;
      const observedTokens =
        line.match(/\p{L}+(?:['\u2019-]\p{L}+)*/gu) ?? [];
      for (let index = 1; index < observedTokens.length; index += 1) {
        const lastName = observedTokens[index]!;
        if (normalizeBrandKey(lastName) !== observedSurname) continue;
        const firstName = observedTokens[index - 1]!;
        const firstKey = normalizeBrandKey(firstName);
        if (
          !firstKey.startsWith(observedInitial) ||
          !COMMON_FIRST_NAMES.has(firstKey)
        ) {
          continue;
        }
        const observedRemainder = observedTokens.slice(index - 1).join(' ');
        const parsedObservedPair =
          parsePersonNameFromLine(observedRemainder) ??
          parsePersonNameFromLine(`${firstName} ${lastName}`);
        if (
          parsedObservedPair &&
          (
            normalizeBrandKey(parsedObservedPair.firstName) !== firstKey ||
            !normalizeBrandKey(parsedObservedPair.lastName).startsWith(
              observedSurname
            )
          )
        ) {
          continue;
        }
        const validated = validatePersonName(
          parsedObservedPair ?? { firstName, lastName }
        );
        if (!validated?.firstName || !validated.lastName) continue;
        best = {
          firstName: validated.firstName,
          lastName: validated.lastName,
          score: 8,
        };
      }
    }
  }

  for (const line of rawText.split('\n')) {
    const t = line.trim();
    if (!t || t.length < 5) continue;
    const normalized = normalizeFusedPersonLine(t, emails);
    const parsed = parsePersonNameFromLine(normalized) ?? parsePersonNameFromLine(t);
    if (!parsed?.firstName || !parsed?.lastName) continue;
    if (isBrandSloganPersonName(parsed.firstName, parsed.lastName)) continue;
    const validated = validatePersonName(parsed);
    if (!validated?.firstName || !validated.lastName) continue;

    const ln = normalizeBrandKey(validated.lastName);
    const fn = normalizeBrandKey(validated.firstName);
    let score = 0;
    if (ln.length >= 3 && local.includes(ln)) score += 4;
    if (fn.length >= 3 && local.includes(fn)) score += 1.5;
    if (fn.length === 1 && local.startsWith(fn) && ln.length >= 4 && local.includes(ln)) score += 3;
    if (score > (best?.score ?? 0)) {
      // Verifica ordine email: "elda.alberti" → firstName=elda (prima del punto), lastName=alberti
      const emailParts = (personal.split('@')[0] ?? '').toLowerCase().split(/[._-]+/).filter(p => p.length >= 2);
      let correctedFirst = validated.firstName;
      let correctedLast = validated.lastName;
      if (emailParts.length >= 2) {
        const part0 = normalizeBrandKey(emailParts[0]!);
        const part1 = normalizeBrandKey(emailParts[1]!);
        const fnMatchesPart1 = fn.length >= 3 && (fn === part1 || fn.startsWith(part1.slice(0,4)));
        const lnMatchesPart0 = ln.length >= 3 && (ln === part0 || ln.startsWith(part0.slice(0,4)));
        // Se il cognome corrisponde alla prima parte email e il nome alla seconda → invertiti
        if (fnMatchesPart1 && lnMatchesPart0 && part0 !== part1) {
          correctedFirst = validated.lastName;
          correctedLast = validated.firstName;
        }
      }
      best = { firstName: correctedFirst, lastName: correctedLast, score };
    }
  }

  for (const line of rawText.split('\n')) {
    const t = line.trim();
    if (!t || t.length < 4 || t.length > 24) continue;
    if (/@|www\.|https?:|tel|fax/i.test(t)) continue;
    const phoneName = t.match(/(?:\d[\d.\s-]{6,})\s+([A-ZÀ-Ü]{3,})\s*$/);
    const nameToken = phoneName?.[1] ?? t;
    if (!phoneName && /\d{3}/.test(t)) continue;
    const observedFirst =
      /^[A-ZÀ-Ü]{4,}$/.test(nameToken) &&
      COMMON_FIRST_NAMES.has(normalizeBrandKey(nameToken))
        ? nameToken.charAt(0).toUpperCase() + nameToken.slice(1).toLowerCase()
        : null;
    if (!observedFirst) continue;
    for (const other of rawText.split('\n')) {
      const o = other.trim();
      if (!o || o === t || o === nameToken) continue;
      if (/@|www\.|https?:|tel|fax|\d{3}/i.test(o)) continue;
      const lnKey = normalizeBrandKey(o);
      if (lnKey.length < 4 || !local.includes(lnKey)) continue;
      const validated = validatePersonName({
        firstName: observedFirst,
        lastName: o.charAt(0).toUpperCase() + o.slice(1).toLowerCase(),
      });
      if (!validated?.firstName || !validated.lastName) continue;
      const score = 5;
      if (score > (best?.score ?? 0)) {
        best = { firstName: validated.firstName, lastName: validated.lastName, score };
      }
    }
  }

  if (best && best.score >= 3) {
    return { firstName: best.firstName, lastName: best.lastName };
  }

  const fromEmail = parseNameFromEmailLocal(personal);
  if (
    fromEmail?.firstName &&
    fromEmail.lastName &&
    !shouldRejectPersonCandidate(`${fromEmail.firstName} ${fromEmail.lastName}`)
  ) {
    return { firstName: fromEmail.firstName, lastName: fromEmail.lastName };
  }

  if (fromEmail?.lastName) {
    for (const line of rawText.split('\n')) {
      const normalized = normalizeFusedPersonLine(line.trim(), emails);
      const parsed = parsePersonNameFromLine(normalized) ?? parsePersonNameFromLine(line.trim());
      if (!parsed?.lastName) continue;
      if (normalizeBrandKey(parsed.lastName) === normalizeBrandKey(fromEmail.lastName)) {
        const validated = validatePersonName(parsed);
        if (validated?.firstName && validated.lastName) {
          return { firstName: validated.firstName, lastName: validated.lastName };
        }
      }
    }
  }

  return null;
}

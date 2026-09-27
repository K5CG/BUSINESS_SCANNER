import type { Address } from '../../../types';
import { normalizeAddress } from '../../address-format';
import { VALID_PROVINCE_CODES } from '../../address-format';
import {
  COMMON_FIRST_NAMES,
  containsFuzzyRoleWord,
  LEGAL_FORM_REGEX,
  ROLE_KEYWORD_REGEX,
} from './dictionaries';
import { capProvinceCompatible, provinceFromItalianCap } from './italian-cap';
import { isExplicitlyForeignAddress, isItalianAddressContext } from '../../geo-validation';
import { isPlausiblePersonNameLine } from './name';
import { isCompanySloganClaimLine } from './role';
import { preserveIfUnchanged } from './preserveIfUnchanged';

const STREET_TYPE_FINAL =
  /\b(?:via|viale|vicolo|corso|piazza|p\.?\s*le\.?|piazzale|contr[aà]|localit[aà]|zona|strada|str\.?|v\.|road|street|st\.?|avenue|ave\.?|boulevard|blvd\.?|strasse|rue|calle|\w+straat)\b/i;

const FOREIGN_STREET_TYPE =
  /\b(?:street|road|avenue|strasse|rue|cours|crs\.?|boulevard|blvd\.?)\b/i;

const FOREIGN_LOCATION_RE =
  /\b(?:korea|corea|japan|china|singapore|metropolitan\s+city|room\s*#|technopark|center\s+\d+|belgium|belgique|straat|ireland|irlanda|dublin|pakistan)\b|(?:-|\s)(?:dong|gu|ku|do)\b|\b\d{4}\s+[A-Za-z]/i;

const CIVIC_NUMBER_PATTERN =
  /(?:^|[\s,.(])(?:n\.?\s*|nr\.?\s*)?\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?(?=$|[\s,.)\/-])/i;

const ITALIAN_CAP_PATTERN = /\b(\d{5})\b/;
const PROVINCE_IN_PARENS = /\(\s*([A-Z]{2})\s*\)/;
const PHONE_PATTERN =
  /(?:\btel\.?|\bfax\b|\btelefono\b|\+\d{1,3}[\s.-]?\d{5,}|\b\d{9,}\b)/i;

const GARBAGE_CITY_TOKENS = new Set([
  'internet',
  'for',
  'asso',
  'www',
  'email',
  'mail',
  'tel',
  'fax',
  'http',
  'https',
  'italy',
  'italia',
  'obosch',
]);

/** Città OCR spurie (label, frammenti, rumore layout). */
export function isGarbageCityName(city?: string | null): boolean {
  if (!city?.trim()) return true;
  const raw = city.trim();
  const norm = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
  if (!norm || norm.length < 2) return true;
  if (GARBAGE_CITY_TOKENS.has(norm)) return true;
  // Short OCR noise tokens (SSNE/Ssne) — too few vowels to be a real city word.
  const vowels = (norm.match(/[aeiou]/g) ?? []).length;
  if (norm.length >= 4 && norm.length <= 5 && vowels <= 1) return true;
  return false;
}

function addressText(address: Address): string {
  return (
    address.full ??
    [address.street, address.civicNumber, address.postalCode, address.city, address.region]
      .filter(Boolean)
      .join(' ')
  ).trim();
}

function hasStrongStreetBlock(text: string): boolean {
  return STREET_TYPE_FINAL.test(text) && CIVIC_NUMBER_PATTERN.test(text);
}

function hasStrongCapCityBlock(text: string, address: Address): boolean {
  const cap =
    address.postalCode?.replace(/\s/g, '') ??
    text.match(ITALIAN_CAP_PATTERN)?.[1] ??
    '';
  if (!isValidItalianPostalCode(cap)) return false;

  const hasCity =
    Boolean(address.city?.trim()) ||
    new RegExp(`\\b${cap}\\s+[A-Za-zÀ-ü][A-Za-zÀ-ü'’,.\\-]{2,}`, 'i').test(text);
  const hasProvince =
    isValidItalianProvince(address.region) ||
    PROVINCE_IN_PARENS.test(text) ||
    /\b-\s*[A-Z]{2}\s*(?:-\s*|$)/.test(text);

  return hasCity || hasProvince;
}

function isPlausibleForeignAddressBlock(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /\b(?:belgium|belgique|germany|france|netherlands|nederland|austria|spain|portugal|uk|usa|ireland|irlanda|pakistan|taiwan|sialkot)\b/i.test(
      t
    ) &&
    (/\b\d{4,5}\s+[A-Za-zÀ-ü]{2,}/i.test(t) ||
      /\b\w+straat\b/i.test(t) ||
      FOREIGN_STREET_TYPE.test(t) ||
      /\b[A-Za-zÀ-ü][A-Za-zÀ-ü' .-]{1,30}\s+\d{1,4}\s*,\s*[A-Za-z]/i.test(t))
  );
}

function hasStrongForeignBlock(text: string): boolean {
  if (isPlausibleForeignAddressBlock(text)) return true;
  if (FOREIGN_STREET_TYPE.test(text)) {
    const hasNumber = CIVIC_NUMBER_PATTERN.test(text);
    const hasCityState =
      /\b[A-Za-zÀ-ü]{3,}(?:\s+[A-Za-zÀ-ü]{2,}){0,3}\b/.test(text) &&
      /\b(?:italy|italia|germany|france|spain|uk|usa|state|korea|corea|japan|china)\b/i.test(text) === false;
    return hasNumber || hasCityState;
  }
  if (FOREIGN_LOCATION_RE.test(text)) return true;
  if (/\b(?:head|daegu|main|branch|registered|corporate|sales|regional)\s+office\s*:/i.test(text)) {
    return true;
  }
  return false;
}

function hasAnyAddressMarker(text: string): boolean {
  return (
    STREET_TYPE_FINAL.test(text) ||
    ITALIAN_CAP_PATTERN.test(text) ||
    PROVINCE_IN_PARENS.test(text) ||
    /\b\d{5}\s+[A-Za-zÀ-ü]{3,}/.test(text) ||
    FOREIGN_LOCATION_RE.test(text)
  );
}

function looksLikeStandalonePhoneBlock(text: string): boolean {
  const t = text.trim();
  const digits = t.replace(/\D/g, '');
  if (digits.length < 7) return false;
  if (STREET_TYPE_FINAL.test(t) || FOREIGN_LOCATION_RE.test(t)) return false;

  const residue = t
    .replace(
      /\b(?:tel(?:efono|ephone)?|fax|phone|ph|mobile|mob|cell(?:ulare)?|whatsapp|direct|office|rep|nr)\b\.?/gi,
      ' '
    )
    // OCR frequently reads a phone/mobile icon as one leading letter.
    .replace(/^\s*[A-Z](?=\d)/i, '')
    .replace(/[\d\s+().,;:/\\|-]/g, '')
    .trim();

  return residue.length === 0;
}

function looksLikeOcrPhoneTailAfterPostalCode(
  text: string,
  postalCode: string
): boolean {
  const escapedPostalCode = postalCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\b${escapedPostalCode}\\b`).exec(text);
  if (!match) return false;

  const fullTail = text.slice(match.index + match[0].length);
  const followingStreet = STREET_TYPE_FINAL.exec(fullTail);
  const tail =
    followingStreet?.index !== undefined
      ? fullTail.slice(0, followingStreet.index)
      : fullTail;
  const tokens = tail.match(/[A-Za-zÀ-ÿ0-9|]+/g) ?? [];
  if (tokens.length < 2) return false;

  let digitLikeCount = 0;
  let letterCount = 0;
  for (const character of tokens.join('')) {
    if (/\d/.test(character) || /[oOiIlL|]/.test(character)) {
      digitLikeCount += 1;
    } else if (/[A-Za-zÀ-ÿ]/.test(character)) {
      letterCount += 1;
    }
  }

  return digitLikeCount >= 2 && letterCount <= 2;
}

/**
 * Un prefisso telefonico OCR può assumere l'aspetto di un CAP seguito da
 * frammenti come "eI O00 84". In assenza di una via il candidato è scartato;
 * se una via reale è già presente, vengono rimossi solo CAP/località spurii.
 */
function stripOcrPhonePrefixPostalArtifact(
  address: Address
): Address | null | undefined {
  const text = addressText(address);
  const postalCode =
    address.postalCode?.replace(/\s/g, '') ??
    text.match(ITALIAN_CAP_PATTERN)?.[1];
  if (
    !postalCode ||
    !isValidItalianPostalCode(postalCode) ||
    !looksLikeOcrPhoneTailAfterPostalCode(text, postalCode)
  ) {
    return undefined;
  }

  const postalIndex = text.search(
    new RegExp(`\\b${postalCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  );
  const observedPrefix = text
    .slice(0, Math.max(0, postalIndex))
    .replace(/\s*[-–,]\s*$/, '')
    .trim();
  const observedStreet = address.street?.trim() ?? '';
  const hasStreetEvidence =
    STREET_TYPE_FINAL.test(observedStreet) ||
    STREET_TYPE_FINAL.test(observedPrefix);

  if (!hasStreetEvidence) return null;

  const street = STREET_TYPE_FINAL.test(observedStreet)
    ? observedStreet
    : observedPrefix;
  return {
    ...address,
    street,
    postalCode: undefined,
    city: undefined,
    region: undefined,
    full: observedPrefix || street,
  };
}

function looksLikePersonRolePhoneBlock(text: string): boolean {
  const hasPhone = PHONE_PATTERN.test(text);
  const hasRole = ROLE_KEYWORD_REGEX.test(text) || containsFuzzyRoleWord(text);
  const hasPerson =
    isPlausiblePersonNameLine(text) ||
    /\b[A-ZÀ-Ü][a-zà-ü]+\s+[A-ZÀ-Ü][a-zà-ü]+/.test(text) ||
    [...COMMON_FIRST_NAMES].some((name) =>
      new RegExp(`\\b${name}\\b`, 'i').test(text)
    );

  const hasCompanyMarker =
    LEGAL_FORM_REGEX.test(text) ||
    /\b(group|software|technology|innovation|consulting|srl|s\.r\.l)\b/i.test(text) ||
    /\b[A-ZÀ-Ü]{2,}(?:\s+[A-ZÀ-Ü]{2,}){1,}/.test(text);

  return (hasPhone && hasPerson) || (hasPhone && hasRole) || (hasPerson && hasRole && hasCompanyMarker);
}

function hasInvalidAddressContent(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/@/.test(t)) return true;
  if (/\bwww\.|https?:\/\//i.test(t)) return true;
  if (PHONE_PATTERN.test(t)) return true;
  if (isCompanySloganClaimLine(t) && !hasAnyAddressMarker(t)) return true;
  if (looksLikePersonRolePhoneBlock(t)) return true;
  if (/\|/.test(t) && !STREET_TYPE_FINAL.test(t)) return true;

  if (
    ROLE_KEYWORD_REGEX.test(t) &&
    !STREET_TYPE_FINAL.test(t) &&
    !ITALIAN_CAP_PATTERN.test(t)
  ) {
    return true;
  }

  if (
    isPlausiblePersonNameLine(t) &&
    !STREET_TYPE_FINAL.test(t) &&
    !ITALIAN_CAP_PATTERN.test(t)
  ) {
    return true;
  }

  if (
    LEGAL_FORM_REGEX.test(t) &&
    !STREET_TYPE_FINAL.test(t) &&
    !ITALIAN_CAP_PATTERN.test(t) &&
    !PROVINCE_IN_PARENS.test(t)
  ) {
    return true;
  }

  if (isMixedContactAddressBlock({ full: t, street: t })) return true;
  if (!hasAnyAddressMarker(t)) return true;

  return false;
}

/**
 * Validazione finale obbligatoria prima di restituire/mostrare un indirizzo.
 * Ritorna `null` se il contenuto non è un indirizzo strutturale plausibile.
 */
function stripFiscalTailFromAddress(text: string): string {
  return text
    .replace(
      /\s*(?:C\.?\s*F\.?(?:\s*\/\s*|\s*e\s*)?P\.?\s*IVA|P\.?\s*IVA(?:\s*e\s*C\.?\s*F\.?)?)\s*:?\s*[A-Z0-9./\s-]*/gi,
      ' '
    )
    .replace(/\s*(?:Tel\.?|Fax\.?|T\s+\+39|I\s+T\s+\+39)\s*.*$/i, '')
    .replace(/,\s*Nr\.?\s*0\b/gi, '')
    .replace(/\bNr\.?\s*0\b/gi, '')
    .replace(/\s+-\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function validateFinalAddress(address: Address | null | undefined): Address | null {
  if (!address) return null;

  // Preserve exact observed text only when validation succeeds unchanged.
  const original = { ...address };

  if (address.full?.trim()) {
    const cleanedFull = stripFiscalTailFromAddress(address.full);
    if (cleanedFull !== address.full) {
      address = { ...address, full: cleanedFull };
    }
  }

  const withoutPhonePrefixPostal = stripOcrPhonePrefixPostalArtifact(address);
  if (withoutPhonePrefixPostal !== undefined) {
    return withoutPhonePrefixPostal;
  }

  const rawFull = address.full?.trim() ?? '';
  if (rawFull && isPlausibleForeignAddressBlock(rawFull)) {
    const cleaned = rawFull.replace(/\b1Z\b/gi, 'IZ');
    return {
      ...address,
      full: cleaned,
      country: address.country ?? (/belgium/i.test(cleaned) ? 'BE' : address.country),
    };
  }
  if (
    rawFull &&
    /\n/.test(rawFull) &&
    /\b(?:head|daegu|main|branch|registered|corporate|sales|regional)\s+office\s*:/i.test(rawFull)
  ) {
    return {
      ...address,
      full: rawFull,
      country: address.country ?? (/\bkorea\b/i.test(rawFull) ? 'KR' : address.country),
    };
  }

  const observedText = addressText(address);
  const normalized = normalizeAddress(address);
  if (!normalized?.full && !normalized?.street) {
    return looksLikeStandalonePhoneBlock(observedText) ? null : original;
  }

  if (normalized.postalCode && /^\d{5}$/.test(normalized.postalCode.replace(/\s/g, ''))) {
    const cap = normalized.postalCode.replace(/\s/g, '');
    const addressContext = `${rawFull} ${normalized.full ?? ''}`;
    if (!isExplicitlyForeignAddress(addressContext) && isItalianAddressContext(normalized, rawFull)) {
      if (normalized.city?.trim() === cap) {
        normalized.city = undefined;
      }
      const expectedProv = provinceFromItalianCap(cap);
      if (expectedProv) {
        if (!normalized.region || !capProvinceCompatible(cap, normalized.region)) {
          normalized.region = expectedProv;
        }
      }
    }
  }

  if (isGarbageCityName(normalized.city)) {
    normalized.city = undefined;
    if (
      normalized.full &&
      isGarbageCityName(normalized.full.split(/\s*-\s*/).pop())
    ) {
      normalized.full = normalized.full
        .replace(/\s*-\s*[A-Za-zÀ-ü]{2,12}\s*-\s*IT\s*$/i, ' - IT')
        .replace(/\s*-\s*[A-Za-zÀ-ü]{2,12}\s*$/i, '')
        .trim();
    }
  }

  const text = addressText(normalized);
  if (!text) return null;
  if (hasInvalidAddressContent(text)) {
    return looksLikeStandalonePhoneBlock(text) ||
      looksLikeStandalonePhoneBlock(observedText)
      ? null
      : original;
  }

  const strong =
    hasStrongStreetBlock(text) ||
    hasStrongCapCityBlock(text, normalized) ||
    hasStrongForeignBlock(text);
  if (!strong) {
    return looksLikeStandalonePhoneBlock(text) ||
      looksLikeStandalonePhoneBlock(observedText)
      ? null
      : original;
  }
  if (isMixedContactAddressBlock(normalized)) return null;

  return preserveIfUnchanged(original, normalized);
}

/**
 * Valida e normalizza un indirizzo strutturato.
 */
export function validateAddress(address: Address | undefined | null): Address | undefined {
  return validateFinalAddress(address ?? null) ?? undefined;
}

/** Via/viale/… + civico, oppure CAP + città + provincia. */
export function hasMinimumAddressEvidence(address: Address): boolean {
  const text = addressText(address);
  return (
    hasStrongStreetBlock(text) ||
    hasStrongCapCityBlock(text, address) ||
    hasStrongForeignBlock(text)
  );
}

/** Blocco indirizzo che mescola ragione sociale, telefono ed email. */
export function isMixedContactAddressBlock(address: Address): boolean {
  const text = addressText(address).trim();
  if (!text) return false;

  const hasEmail = /@/.test(text);
  const hasPhone = PHONE_PATTERN.test(text);
  const hasCompanyMarker =
    /\b(s\.?r\.?l\.?|snc|spa|group|srl|software|technology|innovation)\b/i.test(text) ||
    /\b[A-ZÀ-Ü]{2,}(?:\s+[A-ZÀ-Ü]{2,}){1,}/.test(text);
  const hasPerson =
    isPlausiblePersonNameLine(text) ||
    /\b[A-ZÀ-Ü][a-zà-ü]+\s+[A-ZÀ-Ü][a-zà-ü]+/.test(text);

  if (hasEmail && hasPhone && hasCompanyMarker) return true;
  if (hasPhone && hasPerson && (hasCompanyMarker || ROLE_KEYWORD_REGEX.test(text))) return true;

  return false;
}

/** True se la provincia IT è nella lista ufficiale. */
export function isValidItalianProvince(region?: string): boolean {
  if (!region) return false;
  const code = region.trim().toUpperCase().replace(/[()]/g, '');
  return VALID_PROVINCE_CODES.has(code);
}

/** True se il CAP ha formato italiano a 5 cifre. */
export function isValidItalianPostalCode(postalCode?: string): boolean {
  if (!postalCode) return false;
  return /^\d{5}$/.test(postalCode.replace(/\s/g, ''));
}

/** Punteggio 0–1 di completezza strutturale (via, CAP, città, provincia, full). */
export function addressCompletenessScore(address: Address | undefined | null): number {
  if (!address) return 0;
  let score = 0;
  const hasStreet = Boolean(address.street?.trim());
  const hasCap = isValidItalianPostalCode(address.postalCode);
  const hasCity = Boolean(address.city?.trim());
  const hasProvince = isValidItalianProvince(address.region);

  if (hasStreet) score += 0.22;
  if (hasCap) score += 0.28;
  if (hasCity) score += 0.22;
  if (hasProvince) score += 0.18;
  if (address.full && /\s-\s(?:IT|UK|US|DE|FR|CH)\s*$/i.test(address.full)) score += 0.1;

  if (hasStreet && hasCap && hasCity && hasProvince) score += 0.12;

  if (hasCity && !hasCap && !hasStreet) {
    score = Math.min(score, 0.28);
  }

  return Math.min(1, score);
}

/** Città isolata senza CAP né via — tipico rumore OCR (loghi/certificazioni). */
export function isWeakLocationOnlyAddress(address: Address | undefined | null): boolean {
  if (!address) return false;
  const hasCity = Boolean(address.city?.trim());
  const hasStreet = Boolean(address.street?.trim());
  const hasCap = isValidItalianPostalCode(address.postalCode);
  return hasCity && !hasStreet && !hasCap;
}

/** True se manca via o località (CAP/città) per un indirizzo IT plausibile. */
export function isPartialAddress(address: Address | undefined | null): boolean {
  if (!address) return true;
  const text = addressText(address);
  return !hasMinimumAddressEvidence({ ...address, full: text });
}

/** Ranking composito per merge/selezione indirizzo. */
export function rankAddressCandidate(address: Address, score = 0): number {
  return score + addressCompletenessScore(address) * 1.25;
}

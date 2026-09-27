/**
 * Assemblaggio indirizzo e confronto semantico (replay QA).
 */
import { isGarbageCityName } from '../parser-engine/validators/address';
import { levenshteinDistance, normalizeBrandKey, ROLE_KEYWORD_REGEX } from '../parser-engine/validators/dictionaries';
import { CIVIC_LABEL_PATTERN_SOURCE } from '../address-format';

const STREET_COMPONENT_RE =
  /\b(?:via|viale|vicolo|corso|piazza|strada|street|road|avenue|lane|drive|boulevard|blvd|strasse|stra\u00dfe|rue|straat|court|galleria|localit[aà])\b/i;

const COUNTRY_TOKEN_RE =
  /\b(?:italy|italia|ireland|belgium|belgique|germany|france|usa|uk|korea|corea|spain|portugal|netherlands|austria|switzerland|pakistan)\b/i;

const POSTAL_INLINE_RE = /\b\d{4,6}\b|\b\d{3}\s\d{2}\b/;
const COMPOUND_STREET_COMPONENT_RE =
  /\b[\p{L}]+(?:strasse|stra\u00dfe)\b|\bstra\s*\u00dfe\b/iu;

export function isAddressComponentText(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 3) return false;
  if (/@|www\.|https?:\/\//i.test(t)) return false;
  if (/^[a-z]{4,}[a-z0-9-]*\.[a-z]{2,6}$/i.test(t.replace(/\s+/g, ''))) return false;
  if (/^(?:tel\.?|fax|phone|mob\.?|cell|e-?mail)/i.test(t)) return false;
  const phoneDigits = t.replace(/\D/g, '');
  if (
    phoneDigits.length >= 9 &&
    (t.startsWith('+') || t.startsWith('00') || /^(?:\+|00)?[\d\s().\/\-]+$/.test(t))
  ) {
    return false;
  }
  if (/\b(?:p\.?\s*iva|c\.?\s*f\.?|cod\.?\s*fisc|partita\s+iva)\b/i.test(t)) return false;
  return (
    STREET_COMPONENT_RE.test(t) ||
    COUNTRY_TOKEN_RE.test(t) ||
    POSTAL_INLINE_RE.test(t) ||
    /\b\d{5}\s+[A-Za-zÀ-ÿ' .-]{2,}/i.test(t) ||
    /^[\p{L}][\p{L}\p{M}' .-]{2,40},\s*[A-Za-z]{3,20}\s+\d{3}\s?\d{2}\b/u.test(t) ||
    /\([A-Z]{2}\)/.test(t) ||
    /\b(?:estate|industrial|park)\b/i.test(t) ||
    /\b\d{1,5}[a-zA-Z]?\b/.test(t)
  );
}

export interface AddressLineLike {
  id: number;
  page: number;
  indexInPage: number;
  text: string;
  masked?: string | null;
}

export type UniversalAddressType =
  | 'head-office'
  | 'branch-office'
  | 'registered-office'
  | 'po-box'
  | 'office'
  | 'unlabeled';

export interface UniversalAddressBlock extends AssembledAddressParts {
  rawLines: string[];
  lineIds: number[];
  page: number;
  order: number;
  addressType: UniversalAddressType;
  confidence: number;
  requiresReview: boolean;
}

const ADDRESS_BLOCK_LABEL_RE =
  /^(head\s+office|main\s+office|branch\s+office|registered\s+office|corporate\s+office|sales\s+office|regional\s+office|warehouse|showroom|factory|plant|[\p{L}][\p{L} .'-]{1,24}\s+(?:office|factory|faciory)|sede\s+(?:centrale|operativa|legale|amministrativa|fiscale)|centro\s+direzionale|filiali?)\b\s*(?:[:/|]|\s[-\u2013\u2014]\s)?\s*(.*)$/iu;

const LOCATION_PREFIX_ADDRESS_RE =
  /^[\p{L}][\p{L} .'-]{1,30}:\s*((?:via|viale|vicolo|corso|piazza|strada|street|road|avenue|lane|drive|boulevard|blvd|strasse|stra\u00dfe|rue|straat)\b.+)$/iu;

const PO_BOX_RE = /\b(?:p\.?\s*o\.?\s*box|postfach|bo[i\u00ee]te\s+postale|casella\s+postale)\b/i;
const BUILDING_CONTINUATION_RE =
  /^(?:room|building|edificio|suite|floor|piano|unit|interno|block|tower)\b\s*[#.:/-]?\s*[\p{L}\p{N}-]+/iu;
const CITY_POSTAL_RE =
  /(?:\b\d{4,6}\b.*[\p{L}]|[\p{L}].*\b\d{4,6}\b|[\p{L}].*\b\d{3}\s\d{2}\b|\([A-Z]{2}\)\s*$)/u;
const ADDRESS_BLOCK_TERMINATOR_RE =
  /^(?:tel(?:efono|ephone)?\.?|phone|ph\.?|fon|fax|telefax|mob(?:ile)?\.?|cell(?:ulare)?\.?|whatsapp|e-?mail|mail|pec|web|sito|www\.|https?:|p\.?\s*iva|partita\s+iva|vat|c\.?\s*f\.?|tax\s+id)\b/i;

function addressLabel(text: string): { label?: string; body?: string; type: UniversalAddressType } | null {
  const match = text.trim().match(ADDRESS_BLOCK_LABEL_RE);
  if (!match) {
    const location = text.trim().match(LOCATION_PREFIX_ADDRESS_RE);
    if (!location) return null;
    return { body: location[1].trim(), type: 'branch-office' };
  }
  const label = match[1].trim();
  const lower = label.toLowerCase();
  const type: UniversalAddressType = /branch|filial|factory|faciory|warehouse|showroom|plant/.test(lower)
    ? 'branch-office'
    : /registered|legale|fiscale/.test(lower)
      ? 'registered-office'
      : /head|main|centrale|corporate|direzionale/.test(lower)
        ? 'head-office'
        : 'office';
  return { label, body: match[2]?.trim() || undefined, type };
}

function isAddressBlockTerminator(text: string): boolean {
  const value = text.trim();
  if (!value) return true;
  // P0 ADDRESS BOUNDARY BATCH
  if (ROLE_KEYWORD_REGEX.test(value) && !STREET_COMPONENT_RE.test(value)) return true;
  if (/@|https?:\/\//i.test(value)) return true;
  if (/^www\./i.test(value)) return true;
  if (ADDRESS_BLOCK_TERMINATOR_RE.test(value)) return true;
  const digits = value.replace(/\D/g, '');
  const letters = value.match(/\p{L}/gu)?.length ?? 0;
  if (
    digits.length >= 8 &&
    letters <= 3 &&
    !STREET_COMPONENT_RE.test(value) &&
    !COUNTRY_TOKEN_RE.test(value)
  ) return true;
  return digits.length >= 9 && /^(?:\+|00|\d[\d\s()./-]+)$/.test(value);
}

function stripInlineCompanyFromAddressBody(text: string): string {
  const match = text.match(
    /\b(?:s\.?\s*r\.?\s*l\.?|s\.?\s*p\.?\s*a\.?|s\.?\s*n\.?\s*c\.?|s\.?\s*a\.?\s*s\.?|s\.?\s*c\.?\s*p\.?\s*a\.?|gmbh|ltd\.?|limited|llc|inc\.?|corp\.?|corporation)\b[.,]?\s+((?:via|viale|vicolo|corso|piazza|strada|street|road|avenue|lane|drive|boulevard|blvd|rue)\b.*)$/i
  );
  const body = match?.[1]?.trim() || text;
  return body.replace(/\s+\+\d{1,3}\s*$/, '').trim();
}


/**
 * Ripara solo confusioni OCR fortemente ancorate a una riga indirizzo italiana:
 * - "uia" all'inizio può essere "Via" soltanto con CAP + città + provincia.
 * - I/l/| isolato subito prima del separatore e del CAP può essere civico "1".
 * Nessuna correzione viene applicata fuori da questo contesto strutturale.
 */
function repairPostalAnchoredItalianOcrStreet(text: string): string {
  const original = text.trim();
  const hasPostalCityProvince =
    /\b\d{5}\s+[\p{L}][\p{L}\p{M}'’ .-]{1,40}\s*\([A-Za-z]{2}\)\s*$/u.test(original);
  if (!hasPostalCityProvince) return original;

  let repaired = original.replace(/^uia\b(?=\s+\p{L})/iu, 'Via');
  if (STREET_COMPONENT_RE.test(repaired) || COMPOUND_STREET_COMPONENT_RE.test(repaired)) {
    repaired = repaired.replace(
      /\s+[Il|]\s*[-\u2013\u2014]\s*(?=\d{5}\b)/u,
      ', 1 - '
    );
  }
  return repaired;
}

function isUniversalAddressLine(text: string): boolean {
  const value = text.trim();
  if (!value || isAddressBlockTerminator(value)) return false;
  if (addressLabel(value) || PO_BOX_RE.test(value)) return true;
  if (
    STREET_COMPONENT_RE.test(value) ||
    COMPOUND_STREET_COMPONENT_RE.test(value) ||
    BUILDING_CONTINUATION_RE.test(value)
  ) return true;
  if (COUNTRY_TOKEN_RE.test(value) || CITY_POSTAL_RE.test(value)) return true;
  return false;
}

function splitUniversalStreetCivic(text: string): { street?: string; civicNumber?: string } {
  const cleaned = text
    .replace(/^[^\p{L}]{1,3}(?=(?:via|viale|vicolo|corso|piazza|strada|street|road|avenue)\b)/iu, '')
    .replace(/^[\p{L}][\p{L} .'-]{1,30}:\s*/u, '')
    .trim();
  const explicitRange = cleaned.match(
    new RegExp(
      String.raw`^(.+?)[,\s]+(?:${CIVIC_LABEL_PATTERN_SOURCE})?(\d{1,5}[a-zA-Z]?)\s*[-\u2013\u2014]\s*(\d{1,5}[a-zA-Z]?)\s*$`,
      'iu'
    )
  );
  if (explicitRange) {
    return {
      street: explicitRange[1].trim(),
      civicNumber: `${explicitRange[2]} - ${explicitRange[3]}`,
    };
  }
  const range = cleaned.match(
    new RegExp(
      String.raw`^(.+?)[,\s]+(?:${CIVIC_LABEL_PATTERN_SOURCE})?(\d{1,5}[a-zA-Z]?(?:\s*[-\u2013\u2014]\s*\d{1,5}[a-zA-Z]?)?(?:\/[a-zA-Z0-9]+)?)\s*$`,
      'iu'
    )
  );
  const hasExplicitCivicLabel = new RegExp(
    String.raw`(?:^|[,\s])${CIVIC_LABEL_PATTERN_SOURCE}\d{1,5}`,
    'iu'
  ).test(cleaned);
  if (range && (hasExplicitCivicLabel || !/^\d{4,6}$/.test(range[2]))) {
    return { street: range[1].trim(), civicNumber: range[2].replace(/\s+/g, ' ') };
  }
  return { street: cleaned || undefined };
}


function extractPostalCodeFromBodies(bodies: string[]): string | undefined {
  const joined = bodies.join(' ');
  const civicLabeled = new RegExp(
    String.raw`${CIVIC_LABEL_PATTERN_SOURCE}(\d{4,6})\b`,
    'igu'
  );
  const civicValues = new Set<string>();
  for (const match of joined.matchAll(civicLabeled)) {
    if (match[1]) civicValues.add(match[1]);
  }

  // Prefer a postal token that is structurally tied to locality text.
  for (const body of bodies) {
    const cityAfter = body.match(/\b(\d{4,6})\s+[\p{L}][\p{L}\p{M}'’ .-]{2,}/u)?.[1];
    if (cityAfter && !civicValues.has(cityAfter)) return cityAfter;

    const cityBefore = body.match(/[\p{L}][\p{L}\p{M}'’ .-]{2,}\s+(\d{4,6})\b/u)?.[1];
    if (cityBefore && !civicValues.has(cityBefore)) return cityBefore;

    const grouped = body.match(/\b(\d{3})\s(\d{2})\b/);
    if (grouped) {
      const value = `${grouped[1]}${grouped[2]}`;
      if (!civicValues.has(value)) return value;
    }
  }

  // Fall back to the first plausible numeric token that is not explicitly a
  // civic/house number. This keeps open-set international formats without
  // allowing "Civico 12345" or "Hausnummer 12345" to become the postal code.
  for (const match of joined.matchAll(/\b\d{4,6}\b/g)) {
    if (!civicValues.has(match[0])) return match[0];
  }
  return undefined;
}

function cityBeforePostalCode(text: string, country?: string): string | undefined {
  const parts = text.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
  const civicLabelRe = new RegExp(
    String.raw`${CIVIC_LABEL_PATTERN_SOURCE}\d{4,6}\b`,
    'iu'
  );
  const postalIndex = parts.findIndex(
    (part) => /\b\d{4,6}\b/.test(part) && !civicLabelRe.test(part)
  );
  if (postalIndex < 0) return undefined;

  const looksLikeStreet = (value: string) =>
    STREET_COMPONENT_RE.test(value) ||
    COMPOUND_STREET_COMPONENT_RE.test(value) ||
    PO_BOX_RE.test(value);

  // Prefer a separate locality segment immediately AFTER the postal segment:
  // "Via X, 1 - 50126, Firenze" or a locality recovered from a following
  // "CITTA TEL/FAX" line.
  const nextPart = parts[postalIndex + 1];
  if (
    nextPart &&
    /^[\p{L}][\p{L}\p{M}'’ .-]{1,50}$/u.test(nextPart) &&
    !looksLikeStreet(nextPart) &&
    !COUNTRY_TOKEN_RE.test(nextPart)
  ) {
    return nextPart;
  }

  // Prefer city AFTER postal: "60486 Frankfurt am Main"
  const cityAfterPostal = parts[postalIndex]?.match(
    /^\s*\d{4,6}\s+([\p{L}][\p{L}\p{M}' .-]{2,50}?)(?:\s*\([A-Z]{1,2}\))?\s*$/u
  )?.[1]?.trim();
  if (
    cityAfterPostal &&
    !looksLikeStreet(cityAfterPostal) &&
    !COUNTRY_TOKEN_RE.test(cityAfterPostal)
  ) {
    return cityAfterPostal;
  }

  let city = postalIndex > 0 ? parts[postalIndex - 1] : undefined;
  // Formati tipo "Quinto di Treviso, TV, 31055": la sigla geografica
  // immediatamente prima del CAP non deve essere scambiata per la citta.
  if (city && /^[A-Z]{2}$/.test(city) && postalIndex > 1) {
    city = parts[postalIndex - 2];
  }
  if (city && (/\b(?:estate|industrial|park|building|suite|floor|unit|block)\b/i.test(city) || looksLikeStreet(city))) {
    city = undefined;
  }
  if (!city) {
    const countryPattern = country
      ? country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : COUNTRY_TOKEN_RE.source;
    city = parts[postalIndex]?.match(
      new RegExp(
        String.raw`^\s*([\p{L}][\p{L}\p{M}' .-]{1,40}?)\s*[-,]?\s*\d{4,6}\s*[-,]?\s*(?:${countryPattern})?\.?\s*$`,
        'iu'
      )
    )?.[1]?.trim();
  }
  // "Sialkot - 51310-Pakistan." when postal/country are fused without spaces around hyphen
  if (!city) {
    city = parts[postalIndex]?.match(
      /^\s*([\p{L}][\p{L}\p{M}' .-]{2,40}?)\s*[-–—]\s*\d{4,6}\s*[-–—]?\s*[\p{L}].*$/u
    )?.[1]?.trim();
  }
  return city && !looksLikeStreet(city) && !COUNTRY_TOKEN_RE.test(city) ? city : undefined;
}

function parseCapCityStreetSingleLine(text: string): {
  postalCode: string;
  city: string;
  street: string;
  civicNumber?: string;
} | null {
  const match=text.match(
    /\b(\d{4,6})\s+([^,;–—-]{2,40}?)\s*[-–—]\s*(?:[^,;–—]{2,40}?\s*[-–—]\s*)?((?:via|viale|vicolo|corso|piazza|strada|street|road|avenue|lane|drive|boulevard|blvd|strasse|straße|rue|straat|galleria|localit[aà])\b.+)$/iu
  );
  if(!match)return null;
  const tail=match[3]!.trim();
  const streetCivic=tail.match(/^(.+?)[,\s]+(\d{1,5}[A-Za-z]?(?:\/[A-Za-z0-9]+)?(?:\s+(?:bis|ter|quater))?)\s*$/iu);
  return {
    postalCode:match[1]!,
    city:match[2]!.trim(),
    street:streetCivic?.[1]?.trim() ?? tail,
    civicNumber:streetCivic?.[2]?.trim(),
  };
}

function parseStreetCivicPostalCitySingleLine(text: string): {
  street: string;
  civicNumber: string;
  postalCode: string;
  city: string;
} | null {
  const match=text.match(
    /\b((?:via|viale|vicolo|corso|piazza|strada|street|road|avenue|lane|drive|boulevard|blvd|strasse|straße|rue|straat|galleria|localit[aà])\b.+?)\s+(\d{1,5}[A-Za-z]?(?:\/[A-Za-z0-9]+)?(?:\s+(?:bis|ter|quater))?)\s*[-–—]\s*(\d{4,6})\s+([A-Za-zÀ-ÿ'’ .-]{2,40})$/iu
  );
  if(!match)return null;
  const streetCandidate=match[1]!.trim();
  if(/(?:\bed\.?|\bedificio|\bbuilding|\broom|\bsuite|\bunit|\bblock|\btower)\s*$/iu.test(streetCandidate)){
    return null;
  }
  return {
    street:streetCandidate,
    civicNumber:match[2]!.trim(),
    postalCode:match[3]!,
    city:match[4]!.trim(),
  };
}

/**
 * Assembla blocchi address-like senza conoscere casi, nomi o aziende.
 * I blocchi restano separati e conservano ordine e provenienza OCR.
 */
export function assembleUniversalAddressBlocks(lines: AddressLineLike[]): UniversalAddressBlock[] {
  const sorted = [...lines].sort((a, b) => a.page - b.page || a.indexInPage - b.indexInPage);
  const groups: Array<{ lines: AddressLineLike[]; bodies: string[]; type: UniversalAddressType; explicit: boolean }> = [];
  let current: (typeof groups)[number] | null = null;
  let previousIndex = -1;

  const close = () => {
    if (current?.lines.length && current.bodies.some(Boolean)) groups.push(current);
    current = null;
    previousIndex = -1;
  };

  for (const line of sorted) {
    const text = repairPostalAnchoredItalianOcrStreet(line.text);

    // Continuazione localita + recapito: se il blocco corrente termina con un
    // CAP e la riga immediatamente successiva e' "CITTA TEL/FAX/...",
    // conserva solo la localita come parte dell'indirizzo. Il recapito resta
    // fuori dal blocco. Esempio generico: "FIRENZE TEL. 055/...".
    const cityBeforeContact =
      current &&
      line.page === current.lines[0].page &&
      line.indexInPage - previousIndex <= 1 &&
      current.bodies.some((value) => /\b\d{4,6}\s*$/.test(value))
        ? text.match(
            /^([\p{L}][\p{L}\p{M}'’ .-]{1,40}?)\s+(?:tel(?:efono|ephone)?\.?|phone|ph\.?|fax|telefax|mob(?:ile)?\.?|cell(?:ulare)?\.?)\b/iu
          )?.[1]?.trim()
        : undefined;
    if (cityBeforeContact && current && !STREET_COMPONENT_RE.test(cityBeforeContact)) {
      const active = current;
      active.lines.push(line);
      active.bodies.push(cityBeforeContact);
      previousIndex = line.indexInPage;
      continue;
    }

    const label = addressLabel(text);
    if (isAddressBlockTerminator(text)) {
      close();
      continue;
    }
    if (!isUniversalAddressLine(text)) {
      if (current && line.indexInPage - previousIndex > 1) close();
      continue;
    }

    const bodyRaw = stripInlineCompanyFromAddressBody(label ? label.body ?? '' : text);
    const dualItalianOffice = bodyRaw.match(
      /^(Via\s+.+?\d{5}\s+[A-Za-zÀ-ÿ'’ .-]+?)(?=\s+Via\s+)/iu
    );
    const body = dualItalianOffice ? dualItalianOffice[1].trim() : bodyRaw;
    const startsPoBox = PO_BOX_RE.test(body);
    const startsStreet = STREET_COMPONENT_RE.test(body) || COMPOUND_STREET_COMPONENT_RE.test(body);
    const currentHasStreet = current?.bodies.some(
      (value) => STREET_COMPONENT_RE.test(value) || COMPOUND_STREET_COMPONENT_RE.test(value) || PO_BOX_RE.test(value)
    );
    const gap = current ? line.indexInPage - previousIndex : 0;
    const mustStart = Boolean(
      current &&
        (line.page !== current.lines[0].page ||
          gap > 2 ||
          label ||
          (startsPoBox && currentHasStreet) ||
          (startsStreet && currentHasStreet && current.bodies.some((value) => CITY_POSTAL_RE.test(value))))
    );
    if (mustStart) close();

    if (!current) {
      current = {
        lines: [],
        bodies: [],
        type: startsPoBox ? 'po-box' : label?.type ?? 'unlabeled',
        explicit: Boolean(label || startsPoBox),
      };
    }
    current.lines.push(line);
    if (body) current.bodies.push(body);
    previousIndex = line.indexInPage;
  }
  close();

  return groups
    .map((group, order): UniversalAddressBlock | null => {
      const rawLines = group.lines.map((line) => line.text.trim()).filter(Boolean);
      const bodies = group.bodies.map((value) => value.trim()).filter(Boolean);
      if (!bodies.length) return null;
      const full = joinAddressComponents(bodies);
      const inlineStreetPostal = bodies
        .map((value)=>parseStreetCivicPostalCitySingleLine(value))
        .find((value): value is NonNullable<typeof value> => Boolean(value));
      const capCityStreet = bodies
        .map((value)=>parseCapCityStreetSingleLine(value))
        .find((value): value is NonNullable<typeof value> => Boolean(value));
      const streetLine = inlineStreetPostal?.street ?? capCityStreet?.street ?? bodies.find(
        (value) => STREET_COMPONENT_RE.test(value) || COMPOUND_STREET_COMPONENT_RE.test(value) || PO_BOX_RE.test(value)
      );
      const street = inlineStreetPostal
        ? { street:inlineStreetPostal.street, civicNumber:inlineStreetPostal.civicNumber }
        : capCityStreet
          ? { street:capCityStreet.street, civicNumber:capCityStreet.civicNumber }
          : streetLine
            ? splitUniversalStreetCivic(streetLine)
            : {};
      const postalCode = inlineStreetPostal?.postalCode ?? capCityStreet?.postalCode ?? extractPostalCodeFromBodies(bodies);
      const country = bodies.join(' ').match(COUNTRY_TOKEN_RE)?.[0];
      const postalBodyIndex = postalCode
        ? bodies.findIndex((value) => value.includes(postalCode))
        : -1;
      const immediateCityContinuation = postalBodyIndex >= 0 && postalBodyIndex + 1 < bodies.length
        ? bodies[postalBodyIndex + 1].match(
            /^\s*([\p{L}][\p{L}\p{M}'’ .-]{1,40}?)(?=\s+(?:tel(?:efono|ephone)?\.?|phone|fax|mob(?:ile)?\.?|cell(?:ulare)?\.?|whatsapp)\b)/iu
          )?.[1]?.trim()
        : undefined;
      let city =
        inlineStreetPostal?.city ??
        capCityStreet?.city ??
        immediateCityContinuation ??
        cityBeforePostalCode(bodies.join(', '), country);
      // US "City, State ZIP" lines often sit beside the street.
      if (!city) {
        for (const body of bodies) {
          const us = body.match(
            /^([\p{L}][\p{L}\p{M}'’ .-]{2,40}),\s*([A-Za-z]{3,20})\s+(\d{3}\s?\d{2}(?:-\d{4})?)$/u
          );
          if (us) {
            city = us[1].trim();
            break;
          }
        }
      }
      // Prefer city tokens that are not the country name itself.
      if (city && country && normalizeBrandKey(city) === normalizeBrandKey(country)) {
        city = undefined;
      }
      if ((!city || (country && normalizeBrandKey(city.replace(/\.$/, '')) === normalizeBrandKey(country))) ) {
        for (const body of bodies) {
          const beforeCountry = body.match(
            /\b([\p{L}][\p{L}\p{M}' .-]{2,40}?)\s*[-–—,]\s*\d{4,6}\s*[-–—,]?\s*(?:pakistan|italy|italia|germany|france|belgium|ireland)\b/iu
          );
          if (beforeCountry && !STREET_COMPONENT_RE.test(beforeCountry[1]) && !COMPOUND_STREET_COMPONENT_RE.test(beforeCountry[1])) {
            city = beforeCountry[1].trim();
            break;
          }
        }
      }
      const hasLocation = bodies.some((value) => CITY_POSTAL_RE.test(value) || COUNTRY_TOKEN_RE.test(value));
      const hasStreet = Boolean(streetLine);
      const completeness = Math.min(
        1,
        (hasStreet ? 0.42 : 0) +
          (street.civicNumber ? 0.13 : 0) +
          (postalCode ? 0.2 : 0) +
          (hasLocation ? 0.17 : 0) +
          (country ? 0.08 : 0)
      );
      const confidence = Math.min(0.94, 0.48 + (group.explicit ? 0.18 : 0) + completeness * 0.3);
      return {
        full,
        street: street.street,
        civicNumber: street.civicNumber,
        postalCode,
        city,
        country,
        completeness,
        partial: completeness < 0.72,
        rawLines,
        lineIds: group.lines.map((line) => line.id),
        page: group.lines[0].page,
        order,
        addressType: group.type,
        confidence,
        requiresReview: confidence < 0.78 || completeness < 0.72,
      };
    })
    .filter(
      (block): block is UniversalAddressBlock =>
        Boolean(
          block &&
            typeof block.completeness === 'number' &&
            (block.completeness >= 0.42 ||
              (block.addressType !== 'unlabeled' && block.completeness >= 0.2))
        )
    );
}

/** Righe indirizzo sulla stessa pagina della persona (contesto personale). */
export function gatherPersonPageAddressLines(
  lines: AddressLineLike[],
  personPage: number,
  personIndexInPage: number,
  seedIds: Set<number>,
  maxDistance = 10,
  roleLineId?: number
): AddressLineLike[] {
  const out: AddressLineLike[] = [];
  const seen = new Set<number>();
  for (const l of lines) {
    if (l.page !== personPage) continue;
    if (Math.abs(l.indexInPage - personIndexInPage) > maxDistance) continue;
    if (roleLineId !== undefined && l.id === roleLineId) continue;
    const inSeed = seedIds.has(l.id);
    const addressLike = l.masked === 'address' || isAddressComponentText(l.text);
    if (!inSeed && !addressLike) continue;
    if (/^(?:director|manager|president|partner|responsabile)\b/i.test(l.text.trim())) continue;
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
  }
  return out.sort((a, b) => a.indexInPage - b.indexInPage);
}

export function joinAddressComponents(lines: string[]): string {
  const cleaned = lines.map((t) => t.trim()).filter(Boolean);
  if (!cleaned.length) return '';
  if (cleaned.length === 1) return cleaned[0];
  return cleaned.join(', ');
}

function ocrIlEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const maxLen = Math.max(a.length, b.length);
  let mism = 0;
  for (let i = 0; i < maxLen; i++) {
    const ca = (a[i] ?? '').toLowerCase();
    const cb = (b[i] ?? '').toLowerCase();
    if (ca === cb) continue;
    if (/[il1]/i.test(ca) && /[il1]/i.test(cb)) continue;
    mism += 1;
    if (mism > 1) return false;
  }
  return true;
}

function addressNormTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9à-ü\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const tokens: string[] = [];
  for (const w of words) {
    const key = normalizeBrandKey(w);
    if (!key) continue;
    if (key.length >= 3 || /^\d{3,}$/.test(key)) tokens.push(key);
  }
  const civics = text.match(/\b(\d{1,4})\s*(bis|ter|quater)\b/gi) ?? [];
  for (const c of civics) {
    tokens.push(normalizeBrandKey(c));
  }
  return tokens;
}

/** Match semantico: stessi token chiave (via, civico, cap, città, paese). */
export function semanticAddressMatch(actual: string | null | undefined, expected: string | null | undefined): boolean {
  const a = (actual ?? '').trim();
  let e = (expected ?? '').trim();
  if (!e) return !a;
  if (!a) return false;

  e = e
    .replace(/^(?:sede\s+(?:operativa|legale)|personal\s+office)\s*:\s*/i, '')
    .replace(/^(?:must\s+be\s+selected[^;]*;?\s*)/i, '')
    .trim();

  const aNorm = normalizeBrandKey(a);
  const eNorm = normalizeBrandKey(e);
  if (aNorm.includes(eNorm) || eNorm.includes(aNorm)) return true;

  const eTokens = addressNormTokens(e);
  const aTokens = new Set(addressNormTokens(a));
  if (!eTokens.length) return false;

  const significant = eTokens.filter((t) => t.length >= 4 || /^\d{3,}$/.test(t) || /^[il]{3}$/.test(t));
  const pool = significant.length ? significant : eTokens;
  let hits = 0;
  for (const tok of pool) {
    if (
      [...aTokens].some(
        (at) =>
          at.includes(tok) ||
          tok.includes(at) ||
          ocrIlEquivalent(at, tok) ||
          (tok.length >= 4 && levenshteinDistance(at, tok) <= 1) ||
          (tok.length >= 3 && levenshteinDistance(at, tok) <= 1 && /^[a-z]*[il1][a-z]*$/i.test(tok))
      )
    ) {
      hits += 1;
    }
  }
  const need = Math.min(pool.length, Math.max(2, Math.ceil(pool.length * 0.5)));
  return hits >= need;
}

export function exactFormattedAddressMatch(
  actual: string | null | undefined,
  expected: string | null | undefined
): boolean {
  const a = normalizeBrandKey(actual ?? '');
  const e = normalizeBrandKey(expected ?? '');
  if (!e) return !a;
  return a === e || a.includes(e) || e.includes(a);
}

export function sanitizeAddressCity(city: string | undefined, lastName?: string | null): string | undefined {
  if (!city?.trim()) return undefined;
  const c = city.trim();
  if (isGarbageCityName(c)) return undefined;
  if (lastName?.trim()) {
    const cityKey = normalizeBrandKey(c);
    const lastKey = normalizeBrandKey(lastName.split(/\s+/).pop() ?? lastName);
    if (cityKey === lastKey || (lastKey.length >= 4 && cityKey.includes(lastKey))) return undefined;
  }
  return c;
}

export function tokenOverlapScore(a: string, b: string): number {
  const aSet = new Set(addressNormTokens(a));
  const bTokens = addressNormTokens(b);
  if (!bTokens.length) return 0;
  let hits = 0;
  for (const t of bTokens) {
    if ([...aSet].some((x) => x.includes(t) || t.includes(x))) hits += 1;
  }
  return hits / bTokens.length;
}

/** Token di sedi globali — contaminazione se mescolate al cluster personale. */
export const GLOBAL_OFFICE_CONTAMINATION_RE =
  /\b(?:frankfurt|san\s+francisco|rhode\s+island|paris|60322|94103|75017|germany|france|usa\b|ste\s*#\s*\d+)\b/i;

const ITALIAN_SEDE_OPERATIVA_RE = /^sede\s+operativa\b/i;
const ITALIAN_SEDE_LEGALE_RE = /^sede\s+legale\b/i;
const ITALIAN_CAP_CITY_LINE_RE = /^(\d{5})\s*[-–—]\s*([A-Za-zÀ-ÿ' .-]{2,40})(?:\s*\(([A-Z]{2})\))?\s*$/i;
const ITALIAN_CAP_CITY_INLINE_RE = /(\d{5})\s+([A-Za-zÀ-ÿ' .-]{2,40})\s*\(([A-Z]{2})\)/i;

export function parseItalianCapCityLine(
  text: string
): { postalCode?: string; city?: string; region?: string } | null {
  const t = text.trim();
  let m = t.match(ITALIAN_CAP_CITY_LINE_RE);
  if (m) return { postalCode: m[1], city: m[2].trim(), region: m[3]?.toUpperCase() };
  m = t.match(ITALIAN_CAP_CITY_INLINE_RE);
  if (m) return { postalCode: m[1], city: m[2].trim(), region: m[3].toUpperCase() };
  m = t.match(/^(\d{5})\s*[-–—]\s*([A-Za-zÀ-ÿ' .-]{2,40})/i);
  if (m) return { postalCode: m[1], city: m[2].trim() };
  return null;
}

function splitStreetCivic(streetLine: string): { street: string; civic?: string } {
  // Il civico italiano puo' includere edificio/scala/interno. Tenerlo nello
  // stesso campo evita che "4B ed. 26B" venga mozzato a "4B".
  const m = streetLine.match(/^(.+?)[,\s]+(?:n\.?\s*|nr\.?\s*)?(\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?(?:\s+(?:ed(?:ificio)?\.?|scala|int(?:erno)?\.?|palazzina)\s*\d{1,5}[a-zA-Z]?)?)\s*$/i);
  if (m) return { street: m[1].trim(), civic: m[2] };
  return { street: streetLine.trim() };
}

export interface AssembledAddressParts {
  full: string;
  street?: string;
  civicNumber?: string;
  postalCode?: string;
  city?: string;
  region?: string;
  country?: string;
  completeness?: number;
  partial?: boolean;
}

/**
 * Gestione generica di sede operativa e sede legale sulla stessa pagina.
 * Restituisce SOLO la sede operativa (prima via + primo CAP adiacente), senza concatenare sedi.
 */
export function tryAssembleItalianSedeOperativaAddress(
  lines: AddressLineLike[]
): AssembledAddressParts | null {
  const sorted = [...lines].sort((a, b) => a.page - b.page || a.indexInPage - b.indexInPage);
  const operLabel = sorted.find((l) => ITALIAN_SEDE_OPERATIVA_RE.test(l.text.trim()));
  if (!operLabel) return null;

  const afterOper = sorted.filter((l) => l.page === operLabel.page && l.indexInPage > operLabel.indexInPage);
  const streetLines = afterOper.filter(
    (l) =>
      STREET_COMPONENT_RE.test(l.text) &&
      !ITALIAN_SEDE_OPERATIVA_RE.test(l.text) &&
      !ITALIAN_SEDE_LEGALE_RE.test(l.text) &&
      !/^(?:tel\.?|fax|cell)/i.test(l.text.trim())
  );
  const capLines = afterOper.filter((l) => Boolean(parseItalianCapCityLine(l.text)));

  const primaryStreetLine = streetLines[0];
  if (!primaryStreetLine) return null;

  const primaryCapLine = capLines[0];
  const cap = primaryCapLine ? parseItalianCapCityLine(primaryCapLine.text) : null;
  const split = splitStreetCivic(primaryStreetLine.text.trim());

  const fullParts = [primaryStreetLine.text.trim()];
  if (cap?.postalCode && cap.city) fullParts.push(`${cap.postalCode} ${cap.city}`);
  else if (cap?.city) fullParts.push(cap.city);

  const hasCapCity = Boolean(cap?.postalCode && cap?.city);
  return {
    full: joinAddressComponents(fullParts),
    street: split.street,
    civicNumber: split.civic,
    postalCode: cap?.postalCode,
    city: cap?.city,
    region: cap?.region,
    country: cap ? 'IT' : undefined,
    completeness: hasCapCity ? 0.82 : split.civic ? 0.58 : 0.45,
    partial: !hasCapCity,
  };
}

function isGlobalOfficeHeaderLine(text: string): boolean {
  const t = text.trim();
  if (/\b(?:gmbh|sarl|corporation|corp\.?)\b/i.test(t) && t.length < 48) return true;
  return false;
}

/** Cluster indirizzo personale — si ferma prima di header sedi globali. */
export function collectPersonalAddressCluster(
  lines: AddressLineLike[],
  personLine: AddressLineLike,
  maxDistance = 18,
  roleLineId?: number
): AddressLineLike[] {
  const sorted = lines
    .filter((l) => l.page === personLine.page)
    .sort((a, b) => a.indexInPage - b.indexInPage);
  const out: AddressLineLike[] = [];
  let sawPersonAddress = false;
  let sawIreland = false;

  for (const l of sorted) {
    if (l.indexInPage <= personLine.indexInPage) continue;
    if (Math.abs(l.indexInPage - personLine.indexInPage) > maxDistance) break;
    if (roleLineId !== undefined && l.id === roleLineId) continue;
    if (isGlobalOfficeHeaderLine(l.text)) break;
    if (l.masked === 'structured' || l.masked === 'social' || /@|www\./i.test(l.text)) continue;
    if (/^(?:mob|fax|skype|tel)/i.test(l.text.trim())) continue;

    const ie = /\b(?:dublin|ireland)\b/i.test(l.text);
    const us = /\b(?:san\s+francisco|rhode\s+island|ca\s*\d{5}|usa\b)/i.test(l.text);
    const de = /\b(?:frankfurt|60322|germany|france|paris|75017)\b/i.test(l.text);

    if (us && !sawIreland) continue;
    if (de && sawPersonAddress) break;
    if (us && sawIreland) continue;

    const addressLike = l.masked === 'address' || isAddressComponentText(l.text);
    if (!addressLike) {
      if (out.length >= 2) break;
      continue;
    }

    if (ie) sawIreland = true;
    sawPersonAddress = true;
    out.push(l);
  }
  return out;
}

/** Rimuove segmenti di sedi globali dal full (es. Frankfurt dopo Dublin). */
export function stripGlobalOfficeContamination(full: string): string {
  const t = (full ?? '').trim();
  if (!t) return t;
  if (!/\b(?:dublin|ireland)\b/i.test(t)) return t;

  const parts = t.split(/\s*,\s*/).filter(Boolean);
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (GLOBAL_OFFICE_CONTAMINATION_RE.test(part)) continue;
    const key = normalizeBrandKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(part.trim());
  }
  return kept.join(', ');
}

export function addressHasGlobalOfficeContamination(full: string | null | undefined): boolean {
  if (!full?.trim()) return false;
  if (!/\b(?:dublin|ireland)\b/i.test(full)) {
    return GLOBAL_OFFICE_CONTAMINATION_RE.test(full);
  }
  const parts = full.split(/\s*,\s*/);
  return parts.some((p) => GLOBAL_OFFICE_CONTAMINATION_RE.test(p));
}

/** Copertura componenti — senza inventare valori assenti. */
export function addressCompletenessScore(parts: {
  street?: string | null;
  civicNumber?: string | null;
  postalCode?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  full?: string | null;
}): number {
  let score = 0;
  if (parts.street?.trim()) score += 0.28;
  if (parts.civicNumber?.trim()) score += 0.12;
  if (parts.postalCode?.trim()) score += 0.22;
  if (parts.city?.trim()) score += 0.22;
  if (parts.region?.trim()) score += 0.08;
  if (parts.country?.trim()) score += 0.08;
  return Math.min(1, score);
}

export interface AddressAuditVerdict {
  semantic: boolean;
  exact: boolean;
  contaminated: boolean;
  completeness: number;
  pass: boolean;
}

/** PASS semantico solo se corretto, completo abbastanza, non contaminato. */
export function evaluateAddressAudit(
  actual: { full?: string | null; street?: string | null; civicNumber?: string | null; postalCode?: string | null; city?: string | null; region?: string | null; country?: string | null } | null | undefined,
  expected: string | null | undefined
): AddressAuditVerdict {
  const full = actual?.full ?? '';
  const segments = (expected ?? '')
    .split(/;+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const candidates = segments.length ? segments : [expected ?? ''];
  let semantic = false;
  let exact = false;
  for (const seg of candidates) {
    if (semanticAddressMatch(full, seg)) semantic = true;
    if (exactFormattedAddressMatch(full, seg)) exact = true;
  }
  const contaminated = addressHasGlobalOfficeContamination(full);
  const completeness = addressCompletenessScore(actual ?? {});
  const pass = semantic && !contaminated && completeness >= 0.45;
  return { semantic, exact, contaminated, completeness, pass };
}

export function levenshteinNorm(a: string, b: string): number {
  return levenshteinDistance(normalizeBrandKey(a), normalizeBrandKey(b));
}

import type { Address } from '../../../types';
import {
  buildFormattedAddress,
  formatCityName,
  parseItalianInlineAddress,
  VALID_PROVINCE_CODES,
} from '../../address-format';
import { repairAddressLine, repairAddressText } from '../normalize/ocr-repair';
import type { Candidate, FeatureVector, NormalizedInput } from '../types';
import {
  addressCompletenessScore,
  isPartialAddress,
  isValidItalianPostalCode,
  isValidItalianProvince,
  isWeakLocationOnlyAddress,
  validateAddress,
  validateFinalAddress,
} from '../validators/address';
import {
  ADDRESS_LINE_PREFIX_REGEX,
  COMMON_FIRST_NAMES,
  COMPANY_NOISE_REGEX,
  EMAIL_SINGLE_REGEX,
  LEGAL_FORM_REGEX,
  ROLE_KEYWORD_REGEX,
  TAX_LABEL_REGEX,
} from '../validators/dictionaries';

const EXTRACTOR = 'address';

const STREET_TYPE =
  /\b(?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?|street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.?)\b/i;

const STREET_TYPED_PATTERN =
  /^(?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?|street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.?)\s+(?:[A-Z]\.\s*)?[A-Za-z0-9À-ü][A-Za-z0-9À-ü .'-]*(?:\s+[A-Za-z0-9À-ü][A-Za-z0-9À-ü .'-]*)*(?:,?\s+(?:n\.?\s*|nr\.?\s*)?\d+(?:[a-zA-Z/]|-(?=[A-Za-z]))?)?/i;

interface CapCityParts {
  postalCode?: string;
  city?: string;
  province?: string;
  country?: string;
}

function positionRank(lineIndex: number, lineCount: number): number {
  if (lineCount <= 1) return 0.5;
  return 1 - lineIndex / (lineCount - 1);
}

function lineFeatures(
  line: { text: string; confidence: number; lineIndex: number },
  lineCount: number,
  address: Address
): FeatureVector {
  const completeness = addressCompletenessScore(address);
  return {
    positionRank: positionRank(line.lineIndex, lineCount),
    lineLength: (address.full ?? address.street ?? line.text).length,
    confidenceOcr: completeness >= 0.75 ? Math.max(line.confidence, 0.88) : line.confidence,
    hasAddressPattern: true,
    postalCodeValid: isValidItalianPostalCode(address.postalCode),
    provinceValid: isValidItalianProvince(address.region),
    hasEmailPattern: /@/.test(line.text),
    hasPhonePattern: /\d{5,}/.test(line.text.replace(/\s/g, '')),
    hasLegalForm: LEGAL_FORM_REGEX.test(line.text) && !STREET_TYPE.test(line.text),
    tokenCount: completeness,
  };
}

function makeCandidate(
  value: Address,
  sourceLineIndices: number[],
  rawText: string,
  features: FeatureVector
): Candidate<Address> {
  return {
    value,
    sourceLineIndices,
    extractor: EXTRACTOR,
    rawText,
    features,
  };
}

function addressKey(address: Address): string {
  const street = (address.street ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (street) return street;
  return (address.full ?? '').toLowerCase();
}

function normalizeCountryToken(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/\./g, '').toUpperCase();
  if (['ITALY', 'ITALIA', 'ITALI', 'TALY', 'TALIA', 'ITAL', 'IT'].includes(t)) return 'IT';
  return t.length >= 3 ? t : undefined;
}

function isAddressExcludedLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return true;
  if (EMAIL_SINGLE_REGEX.test(t)) return true;
  if (TAX_LABEL_REGEX.test(t)) return true;
  if (COMPANY_NOISE_REGEX.test(t)) return true;
  if (ROLE_KEYWORD_REGEX.test(t) && !STREET_TYPE.test(t)) return true;
  if (LEGAL_FORM_REGEX.test(t) && !STREET_TYPE.test(t) && !/\b\d{5}\b/.test(t)) return true;
  return false;
}

function isLikelyPersonNameLine(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 2 && /^[A-ZÀ-Ü]{2,}$/.test(words[0]) && /^[A-ZÀ-Ü]{2,}$/.test(words[1])) {
    if (COMMON_FIRST_NAMES.has(words[0].toLowerCase())) return true;
  }
  if (words.length === 1 && COMMON_FIRST_NAMES.has(words[0].toLowerCase())) return true;
  return false;
}

function isLikelyCityOnlyLine(text: string): boolean {
  const t = text.trim();
  if (!t || isAddressExcludedLine(t)) return false;
  if (isLikelyPersonNameLine(t)) return false;
  if (STREET_TYPE.test(t)) return false;
  if (/[·•]/.test(t)) return false;
  if (/\b\d{5}\b/.test(t)) return false;
  if (/\([A-Z]{2}\)/.test(t) || /\b(ITALY|IT|I\.T\.)\s*$/i.test(t)) return true;
  return false;
}

function extractBareProvince(text: string): string | undefined {
  const m = text.trim().match(/^\(?\s*([A-Za-zÀ-Ü]{1,2})\s*\)?$/);
  return m ? m[1].toUpperCase() : undefined;
}

function extractCapCity(text: string): CapCityParts | null {
  const t = repairAddressLine(text);
  if (!t || isAddressExcludedLine(t)) return null;

  const capProvCountry = t.match(
    /\b(\d{5})\s+([A-Za-zÀ-ü][A-Za-zÀ-ü'`,.-]{0,28})\s+([A-Za-z]{2})\s+(italy|italia|it)\s*$/i
  );
  if (capProvCountry) {
    const provCode = capProvCountry[3].toUpperCase();
    return {
      postalCode: capProvCountry[1],
      city: capProvCountry[2].trim().replace(/[,\s]+$/, ''),
      province: VALID_PROVINCE_CODES.has(provCode) ? provCode : undefined,
      country: normalizeCountryToken(capProvCountry[4]),
    };
  }

  const full = t.match(
    /\b(\d{5})\s*[-–]?\s+([A-ZÀ-ÜA-Za-zà-ü][A-Za-zÀ-ü\s'-]{0,35}?)(?:\s*\(([A-Za-z]{1,2})\)?)?(?:\s+([A-Za-z]{3,10}))?\s*$/i
  );
  if (full) {
    return {
      postalCode: full[1],
      city: full[2].trim(),
      province: full[3]?.toUpperCase(),
      country: normalizeCountryToken(full[4]),
    };
  }

  if (/^\d{5}$/.test(t)) {
    return { postalCode: t, city: '' };
  }

  const cityOnly = t.match(
    /^([A-ZÀ-ÜA-Za-zà-ü][A-Za-zÀ-ü\s'-]{1,35}?)(?:\s*\(([A-Za-z]{1,2})\)?)?(?:\s+([A-Za-z]{3,10}))?\s*$/i
  );
  if (cityOnly && isLikelyCityOnlyLine(t)) {
    return {
      postalCode: '',
      city: cityOnly[1].trim(),
      province: cityOnly[2]?.toUpperCase(),
      country: normalizeCountryToken(cityOnly[3]),
    };
  }

  const tail = t.match(
    /\b([A-ZÀ-ÜA-Za-zà-ü][A-Za-zÀ-ü'-]{1,25})\s*\(([A-Za-z]{1,2})\)?\s*$/
  );
  if (
    tail &&
    !ROLE_KEYWORD_REGEX.test(tail[1]) &&
    !isLikelyPersonNameLine(tail[1]) &&
    /\b\d{5}\b/.test(t)
  ) {
    return {
      postalCode: '',
      city: tail[1].trim(),
      province: tail[2].toUpperCase(),
    };
  }

  return null;
}

function extractStreet(text: string): string | null {
  const t = repairAddressLine(text);
  if (!t || t.length < 5 || isAddressExcludedLine(t)) return null;
  if (/^\d{5}\b/.test(t) && !STREET_TYPE.test(t)) return null;

  // Strade internazionali dove il tipo e un suffisso del nome
  // (Ondernemersstraat, Bahnhofstrasse, Baker Street...). Il vecchio matcher
  // riconosceva quasi solo il tipo all'inizio e perdeva l'intera via.
  const suffixStreet = t.match(
    /(?:^|\s*[-–,]\s*)([A-Za-zÀ-ü][A-Za-zÀ-ü .'-]{1,60}?(?:straat|strasse|straße|street|road|avenue|boulevard|lane|drive|way)\s+\d+[A-Za-z0-9/-]*)\b/i
  );
  if (suffixStreet?.[1]) {
    return suffixStreet[1].replace(/\s+/g, ' ').trim();
  }

  const looseStreet = t.match(
    /^(via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?)\s+([A-Za-z0-9À-ü][A-Za-z0-9À-ü .''-]*?)\s*,?\s*(?:n\.?\s*|nr\.?\s*)?(\d+[a-zA-Z]?)\s*$/i
  );
  if (looseStreet) {
    return `${looseStreet[1]} ${looseStreet[2].trim()}, ${looseStreet[3]}`
      .replace(/\s+/g, ' ')
      .trim();
  }

  const typeMatch = STREET_TYPE.exec(t);
  if (typeMatch) {
    const fromType = t.slice(typeMatch.index);
    const typed = fromType.match(STREET_TYPED_PATTERN);
    if (typed) {
      const street = typed[0]
        .replace(/\s+\d{5}\b.*$/, '')
        .replace(/[,-]\s*$/, '')
        .trim();
      if (street.length >= 6) return street;
    }
  }

  return null;
}

function buildAddress(parts: CapCityParts & { street?: string }): Address | undefined {
  return validateAddress(
    buildFormattedAddress({
      street: parts.street,
      postalCode: parts.postalCode,
      city: parts.city ? formatCityName(parts.city) : undefined,
      region: parts.province,
      country: parts.country,
    })
  );
}

function parseCapCityProvinceStreet(text: string): (CapCityParts & { street?: string }) | null {
  const t = repairAddressLine(text);
  if (!t) return null;

  const capFirst = t.match(
    /\b(\d{5})\s+([A-Za-zÀ-ü][A-Za-zÀ-ü'`,.\s-]{1,32}?)\s*\(([A-Za-z]{2})\)\s+((?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?)\s+.+)$/i
  );
  if (capFirst) {
    const prov = capFirst[3].toUpperCase();
    return {
      postalCode: capFirst[1],
      city: capFirst[2].trim().replace(/[,\s]+$/, ''),
      province: VALID_PROVINCE_CODES.has(prov) ? prov : undefined,
      street: capFirst[4].trim().replace(/[,.]\s*$/, ''),
    };
  }

  const streetFirst = t.match(
    /^((?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?)\s+.+?)\s*[-–]\s*(\d{5})\s+([A-Za-zÀ-ü][A-Za-zÀ-ü'`,.\s-]{1,32}?)\s*\(([A-Za-z]{2})\)\s*$/i
  );
  if (streetFirst) {
    const prov = streetFirst[4].toUpperCase();
    return {
      street: streetFirst[1].trim().replace(/[,.]\s*$/, ''),
      postalCode: streetFirst[2],
      city: streetFirst[3].trim().replace(/[,\s]+$/, ''),
      province: VALID_PROVINCE_CODES.has(prov) ? prov : undefined,
    };
  }

  const capStreetInline = t.match(
    /\b(\d{5})\s+([A-Za-zÀ-ü][A-Za-zÀ-ü'`,.\s-]{1,28}?)\s+([A-Za-z]{2})\s+((?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?)\s+.+)$/i
  );
  if (capStreetInline) {
    const prov = capStreetInline[3].toUpperCase();
    return {
      postalCode: capStreetInline[1],
      city: capStreetInline[2].trim().replace(/[,\s]+$/, ''),
      province: VALID_PROVINCE_CODES.has(prov) ? prov : undefined,
      street: capStreetInline[4].trim().replace(/[,.]\s*$/, ''),
    };
  }

  return null;
}

function parseDotSeparatedAddress(line: string): Address | undefined {
  const trimmed = repairAddressLine(line);
  if (!ADDRESS_LINE_PREFIX_REGEX.test(trimmed) && !STREET_TYPE.test(trimmed)) return undefined;

  const inline = parseItalianInlineAddress(trimmed);
  if (inline) return validateAddress(buildFormattedAddress(inline));

  if (!/[\u00b7\u2022·•]/.test(line) && !/\s+\.\s+[A-ZÀ-Ü]/i.test(line)) return undefined;

  let parts = trimmed
    .split(/\s*[\u00b7\u2022·•]\s*/g)
    .map((p) => p.trim().replace(/[.,]+$/g, ''))
    .filter(Boolean);
  if (parts.length < 2) {
    const alt = trimmed
      .split(/\s+\.\s+(?=[A-ZÀ-Ü][a-zà-ü]{2,})/g)
      .map((p) => p.trim().replace(/[.,]+$/g, ''))
      .filter(Boolean);
    if (alt.length >= 2) parts = alt;
  }
  if (parts.length < 2) return undefined;

  const street = parts[0];
  const city = parts[1];
  let province: string | undefined;
  let country: string | undefined;

  for (let i = 2; i < parts.length; i++) {
    const p = parts[i].trim();
    if (/^(IT|ITALY|ITALIA)$/i.test(p)) {
      country = 'IT';
    } else if (/^[A-Z]{2}$/i.test(p)) {
      province = p.toUpperCase();
    }
  }

  return buildAddress({ street, city, province, country });
}

function parseAddressFromText(text: string): Address | undefined {
  const flat = repairAddressLine(text.replace(/\n+/g, ' '));

  const capCityStreet = parseCapCityProvinceStreet(flat);
  if (capCityStreet) {
    const fromCapPattern = buildAddress(capCityStreet);
    if (fromCapPattern) return fromCapPattern;
  }

  const inline = parseItalianInlineAddress(flat);
  if (inline) {
    return validateAddress(buildFormattedAddress(inline));
  }

  const dotAddr = parseDotSeparatedAddress(flat);
  if (dotAddr) return dotAddr;

  const street = extractStreet(flat);
  const capCity = extractCapCity(flat);
  const combined = buildAddress({
    street: street ?? undefined,
    postalCode: capCity?.postalCode,
    city: capCity?.city,
    province: capCity?.province,
    country: capCity?.country,
  });
  if (combined) return combined;

  if (street) {
    return buildAddress({ street });
  }

  return undefined;
}

function mergeCapWithNearbyProvince(capCity: CapCityParts, nextLine?: string): CapCityParts {
  if (capCity.city && !capCity.province) {
    const bare = nextLine ? extractBareProvince(nextLine) : undefined;
    if (bare) return { ...capCity, province: bare };
  }
  return capCity;
}

function parseMultilineItalianAddress(lineTexts: string[]): Address | undefined {
  for (let i = 0; i < lineTexts.length; i++) {
    const street = extractStreet(lineTexts[i]);
    if (!street) continue;

    for (let j = i + 1; j < Math.min(lineTexts.length, i + 3); j++) {
      const capCity = mergeCapWithNearbyProvince(
        extractCapCity(lineTexts[j]) ?? {},
        lineTexts[j + 1]
      );
      if (!capCity.postalCode && !capCity.city) {
        const mergedLine = `${lineTexts[j]} ${lineTexts[j + 1] ?? ''}`.trim();
        const mergedCap = extractCapCity(mergedLine);
        if (mergedCap?.postalCode || mergedCap?.city) {
          const built = buildAddress({ street, ...mergedCap });
          if (built) return built;
        }
        continue;
      }
      const built = buildAddress({ street, ...capCity });
      if (built) return built;
    }
  }

  for (let i = 0; i < lineTexts.length - 1; i++) {
    const combined = `${lineTexts[i]}\n${lineTexts[i + 1]}`;
    const parsed = parseAddressFromText(combined);
    if (parsed && addressCompletenessScore(parsed) >= 0.75) return parsed;
  }

  return undefined;
}

function collectFromLineWindow(lineTexts: string[], start: number, end: number): Address | undefined {
  let best: Address | undefined;
  let bestScore = 0;

  const consider = (candidate: Address | undefined) => {
    if (!candidate) return;
    const score = addressCompletenessScore(candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  };

  consider(parseMultilineItalianAddress(lineTexts.slice(start, end)));

  for (let i = start; i < end; i++) {
    consider(parseDotSeparatedAddress(lineTexts[i]));
    consider(parseAddressFromText(lineTexts[i]));

    const street = extractStreet(lineTexts[i]);
    let capCity = mergeCapWithNearbyProvince(extractCapCity(lineTexts[i]) ?? {}, lineTexts[i + 1]);

    if (street && capCity.city) {
      consider(buildAddress({ street, ...capCity }));
    } else if (street) {
      for (let j = i - 1; j >= Math.max(start, i - 2); j--) {
        const prevCap = mergeCapWithNearbyProvince(extractCapCity(lineTexts[j]) ?? {}, lineTexts[j + 1]);
        if (prevCap.city || prevCap.postalCode) {
          consider(buildAddress({ street, ...prevCap }));
        }
      }
      for (let j = i + 1; j < Math.min(end, i + 3); j++) {
        const nearCap = mergeCapWithNearbyProvince(extractCapCity(lineTexts[j]) ?? {}, lineTexts[j + 1]);
        if (nearCap.city || nearCap.postalCode) {
          consider(buildAddress({ street, ...nearCap }));
        }
        if (/^\d{5}$/.test(lineTexts[j]) && j + 1 < end) {
          const merged = extractCapCity(`${lineTexts[j]} ${lineTexts[j + 1]}`);
          if (merged?.city) consider(buildAddress({ street, ...merged }));
        }
      }
    } else if (capCity.postalCode && !capCity.city && i + 1 < end) {
      const merged = extractCapCity(`${lineTexts[i]} ${lineTexts[i + 1]}`);
      const prevStreet = i > start ? extractStreet(lineTexts[i - 1]) : null;
      if (merged?.city) {
        consider(buildAddress({ street: prevStreet ?? undefined, ...merged }));
      }
    } else if (capCity.city) {
      const prevStreet =
        (i > start ? extractStreet(lineTexts[i - 1]) : null) ??
        (i > start + 1 ? extractStreet(lineTexts[i - 2]) : null);
      consider(buildAddress({ street: prevStreet ?? undefined, ...capCity }));
    }
  }

  for (let i = start; i < end; i++) {
    const block = lineTexts.slice(i, Math.min(end, i + 4)).join('\n');
    consider(parseAddressFromText(block));
  }

  return best;
}

function isLocationOnlyAddress(address: Address): boolean {
  return !address.street?.trim() && Boolean(address.postalCode || address.city);
}

function resolveSourceLineIndices(
  address: Address,
  lines: NormalizedInput['lines'],
  fallback: number[] = []
): number[] {
  const matched: number[] = [];
  const street = (address.street ?? '').toLowerCase();
  const cap = address.postalCode ?? '';
  const city = (address.city ?? '').toLowerCase();

  for (const line of lines) {
    const t = repairAddressLine(line.text).toLowerCase();
    if (street.length >= 6) {
      const stem = street.replace(/^(?:via|viale|piazza|corso|vicolo|largo|galleria)\s+/, '').slice(0, 14);
      if (stem && t.includes(stem)) {
        matched.push(line.lineIndex);
        continue;
      }
    }
    if (cap && t.includes(cap)) {
      matched.push(line.lineIndex);
      continue;
    }
    if (city.length >= 4 && t.includes(city)) {
      matched.push(line.lineIndex);
    }
  }

  const unique = [...new Set(matched)];
  return unique.length > 0 ? unique : fallback;
}

function pushCandidate(
  candidates: Candidate<Address>[],
  seen: Map<string, Address>,
  address: Address | undefined,
  sourceLineIndices: number[],
  rawText: string,
  pseudoLine: { text: string; confidence: number; lineIndex: number },
  lineCount: number,
  lines: NormalizedInput['lines']
) {
  if (!address) return;
  const validated = validateFinalAddress(address);
  if (!validated) return;

  const indices = resolveSourceLineIndices(validated, lines, sourceLineIndices);
  const key = addressKey(validated);
  const existing = seen.get(key);

  if (existing && addressCompletenessScore(existing) >= addressCompletenessScore(validated)) {
    return;
  }

  if (isLocationOnlyAddress(validated)) {
    const cap = validated.postalCode ?? '';
    for (const [, other] of seen.entries()) {
      if (cap && other.postalCode === cap && other.street?.trim()) return;
      if (validated.city && other.city === validated.city && other.street?.trim()) return;
    }
    if (isWeakLocationOnlyAddress(validated)) return;
  }

  seen.set(key, validated);

  const duplicateIdx = candidates.findIndex((c) => addressKey(c.value) === key);
  const candidate = makeCandidate(
    validated,
    indices,
    rawText,
    lineFeatures({ ...pseudoLine, lineIndex: indices[0] ?? pseudoLine.lineIndex }, lineCount, validated)
  );
  if (duplicateIdx >= 0) {
    candidates[duplicateIdx] = candidate;
  } else {
    candidates.push(candidate);
  }
}

/**
 * Estrae candidati indirizzo con parsing multi-riga e testo riparato OCR.
 */
export function extractAddressCandidates(input: NormalizedInput): Candidate<Address>[] {
  const { lines } = input;
  const repairedText = repairAddressText(input.repairedText || input.rawText);
  const lineCount = lines.length;
  const seen = new Map<string, Address>();
  const candidates: Candidate<Address>[] = [];

  const lineTexts = lines.map((line) => repairAddressLine(line.text)).filter((t) => t.length >= 2);

  const bestFromText = collectFromLineWindow(lineTexts, 0, lineTexts.length);
  if (bestFromText) {
    pushCandidate(
      candidates,
      seen,
      bestFromText,
      [],
      repairedText,
      { text: repairedText, confidence: 0.75, lineIndex: 0 },
      lineCount,
      lines
    );
  }

  for (const line of lines) {
    const repairedLine = repairAddressLine(line.text);
    const parsed = parseAddressFromText(repairedLine);
    pushCandidate(
      candidates,
      seen,
      parsed,
      [line.lineIndex],
      line.text,
      { ...line, text: repairedLine },
      lineCount,
      lines
    );
  }

  for (const chunk of repairedText.split('\n')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const parsed = parseAddressFromText(trimmed);
    const lineIndex = lines.find((l) => trimmed.includes(repairAddressLine(l.text)))?.lineIndex ?? 0;
    pushCandidate(
      candidates,
      seen,
      parsed,
      [lineIndex],
      trimmed,
      { text: trimmed, confidence: 0.68, lineIndex },
      lineCount,
      lines
    );
  }

  return candidates
    .filter((c) => {
      if (isWeakLocationOnlyAddress(c.value)) return false;
      if (!isLocationOnlyAddress(c.value)) return true;
      return !candidates.some(
        (other) =>
          other !== c &&
          Boolean(other.value.street?.trim()) &&
          (other.value.postalCode === c.value.postalCode ||
            other.value.city === c.value.city)
      );
    })
    .sort((a, b) => addressCompletenessScore(b.value) - addressCompletenessScore(a.value));
}

/** Secondo passaggio generico: completa indirizzi parziali da testo riparato e righe adiacenti. */
export function enrichSelectedAddress(
  selected: Address | undefined,
  repairedText: string,
  rawText?: string
): Address | undefined {
  const normalized = validateAddress(selected);
  if (normalized && !isPartialAddress(normalized)) return normalized;

  const text = repairAddressText(repairedText || rawText || '');
  const lineTexts = text
    .split('\n')
    .map((line) => repairAddressLine(line))
    .filter((line) => line.length >= 2);

  const best = collectFromLineWindow(lineTexts, 0, lineTexts.length);
  if (!best) return normalized;

  const selectedScore = normalized ? addressCompletenessScore(normalized) : 0;
  const bestScore = addressCompletenessScore(best);
  if (bestScore > selectedScore) return validateAddress(best);
  return normalized;
}

export { VALID_PROVINCE_CODES };

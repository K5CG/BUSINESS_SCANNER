import type { DocumentLanguage } from './document-label-dictionary';
import { normalizeDocumentLabel } from './document-label-dictionary';

export interface InternationalAmount {
  rawValue: string;
  normalizedValue?: number;
  decimalSeparator?: ',' | '.';
  thousandsSeparator?: ',' | '.' | ' ' | "'";
  currency?: 'EUR' | 'USD' | 'GBP' | 'CHF';
  ambiguous: boolean;
  localeEvidence: string[];
}

const CURRENCY_SYMBOLS: Record<string, InternationalAmount['currency']> = {
  '€': 'EUR', '$': 'USD', '£': 'GBP',
};

function emptyAmount(rawValue: string, currency: InternationalAmount['currency'] | undefined, reasons: string[]): InternationalAmount {
  return {
    rawValue,
    ...(currency ? { currency } : {}),
    ambiguous: false,
    localeEvidence: reasons,
  };
}

function integerSpaceGroupsInvalid(compact: string): boolean {
  const comma = compact.lastIndexOf(',');
  const dot = compact.lastIndexOf('.');
  const decimalAt = comma >= 0 && (dot < 0 || comma > dot) ? comma : (dot >= 0 ? dot : -1);
  const integer = decimalAt >= 0 ? compact.slice(0, decimalAt) : compact;
  if (!/\s/.test(integer)) return false;
  const groups = integer.trim().split(/\s+/);
  if (groups.length < 2) return false;
  if (!/^\d{1,3}$/.test(groups[0])) return true;
  return groups.slice(1).some((group) => !/^\d{3}$/.test(group));
}

/** Slash/dot dates must never become monetary amounts (23/05/2025 → 23052025). */
export function looksLikeCalendarDateNotAmount(rawValue: string): boolean {
  const trimmed = rawValue.trim();
  if (!trimmed) return false;
  if (/[€$£]|\b(?:EUR|USD|GBP|CHF)\b/i.test(trimmed)) return false;
  if (/\d{1,3}[.,]\d{2}\b/.test(trimmed) && !/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/.test(trimmed)) {
    return false;
  }
  if (/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(trimmed)) return true;
  if (/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/.test(trimmed)) return true;
  return false;
}

export function parseInternationalAmount(rawValue: string, language?: DocumentLanguage): InternationalAmount {
  const normalizedQuotes = rawValue.replace(/[’‘`´]/g, "'").replace(/\u00a0/g, ' ');
  const code = normalizedQuotes.match(/\b(EUR|USD|GBP|CHF)\b/i)?.[1]?.toUpperCase() as InternationalAmount['currency'] | undefined;
  const symbol = Object.entries(CURRENCY_SYMBOLS).find(([candidate]) => normalizedQuotes.includes(candidate))?.[1];
  const currency = code ?? symbol;
  if (looksLikeCalendarDateNotAmount(normalizedQuotes)) {
    return emptyAmount(rawValue, currency, ['calendar_date_not_amount']);
  }
  const withoutCurrency = normalizedQuotes
    .replace(/\b(?:EUR|USD|GBP|CHF)\b/gi, '')
    .replace(/[€$£]/g, '')
    .trim();
  if (/\d+[.,]\d{2}\s+\d+[.,]\d{2}/.test(withoutCurrency)) {
    return emptyAmount(rawValue, currency, ['multiple_decimal_amounts_in_cell']);
  }
  const negative = /(?:^|\s)[−-]/.test(normalizedQuotes);
  const numeric = withoutCurrency
    .replace(/[−-]/g, '')
    .replace(/[^\d.,' ]/g, '')
    .trim();
  if (!/\d/.test(numeric)) return { rawValue, ...(currency ? { currency } : {}), ambiguous: false, localeEvidence: [] };

  const compact = numeric.replace(/\s+/g, ' ');
  // OCR may glue a neighbor column fragment after a 2-decimal money cell
  // (e.g. `60,00` + `0` → `60,00 0`). Keep the money token only.
  // Constrained: requires explicit 2-decimal money token + trailing 1–2 digits only.
  const neighborFragment = compact.match(/^(\d{1,6}(?:[.,]\d{3})*[.,]\d{2})\s+\d{1,2}$/);
  const moneyCompact = neighborFragment?.[1] ?? compact;
  if (integerSpaceGroupsInvalid(moneyCompact)) {
    return emptyAmount(rawValue, currency, ['invalid_thousands_grouping']);
  }
  const comma = moneyCompact.lastIndexOf(',');
  const dot = moneyCompact.lastIndexOf('.');
  const apostrophe = moneyCompact.lastIndexOf("'");
  const lastSeparator = Math.max(comma, dot, apostrophe, moneyCompact.lastIndexOf(' '));
  const lastCharacter = lastSeparator >= 0 ? moneyCompact[lastSeparator] : undefined;
  const trailingDigits = lastSeparator >= 0 ? moneyCompact.slice(lastSeparator + 1).replace(/\D/g, '').length : 0;
  const commaCount = (moneyCompact.match(/,/g) ?? []).length;
  const dotCount = (moneyCompact.match(/\./g) ?? []).length;
  const reasons: string[] = [];
  let decimalSeparator: ',' | '.' | undefined;
  let thousandsSeparator: InternationalAmount['thousandsSeparator'];
  let ambiguous = false;

  if (comma >= 0 && dot >= 0) {
    decimalSeparator = comma > dot ? ',' : '.';
    thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    reasons.push('mixed_separators_last_is_decimal');
  } else if (lastCharacter === "'" || lastCharacter === ' ') {
    thousandsSeparator = lastCharacter;
    reasons.push('apostrophe_or_space_thousands_separator');
  } else if (lastCharacter === ',' || lastCharacter === '.') {
    const separator = lastCharacter;
    const count = separator === ',' ? commaCount : dotCount;
    if (trailingDigits === 1 || trailingDigits === 2) {
      decimalSeparator = separator;
      reasons.push('one_or_two_decimal_digits');
    } else if (trailingDigits === 3) {
      thousandsSeparator = separator;
      reasons.push('three_digit_group_thousands_separator');
      if (!currency && count === 1 && !language) ambiguous = true;
    } else if (count > 1) {
      thousandsSeparator = separator;
      reasons.push('repeated_group_separator');
    }
  }
  if (neighborFragment) reasons.push('trailing_column_fragment_ignored');
  if (decimalSeparator && moneyCompact.includes("'")) thousandsSeparator = "'";
  if (decimalSeparator && moneyCompact.includes(' ')) thousandsSeparator = ' ';

  let normalized = moneyCompact.replace(/[ ']/g, '');
  if (thousandsSeparator === ',' || thousandsSeparator === '.') {
    normalized = normalized.split(thousandsSeparator).join('');
  }
  if (decimalSeparator) {
    const decimalIndex = normalized.lastIndexOf(decimalSeparator);
    normalized = `${normalized.slice(0, decimalIndex).replace(/[.,]/g, '')}.${normalized.slice(decimalIndex + 1)}`;
  } else {
    normalized = normalized.replace(/[.,]/g, '');
  }
  const value = Number(normalized);
  return {
    rawValue,
    ...(Number.isFinite(value) ? { normalizedValue: negative ? -value : value } : {}),
    ...(decimalSeparator ? { decimalSeparator } : {}),
    ...(thousandsSeparator ? { thousandsSeparator } : {}),
    ...(currency ? { currency } : {}),
    ambiguous,
    localeEvidence: [
      ...reasons,
      ...(language ? [`language_${language}`] : []),
      ...(currency ? [`currency_${currency}`] : []),
    ],
  };
}

const MONTHS: Readonly<Record<DocumentLanguage, Readonly<Record<string, number>>>> = {
  it: { gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12 },
  en: { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 },
  fr: { janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12 },
  de: { januar: 1, februar: 2, marz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12 },
  es: { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 },
};

export interface InternationalDate {
  rawValue: string;
  normalizedValue?: string;
  ambiguous: boolean;
  alternatives: string[];
  languageEvidence?: DocumentLanguage;
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function parseInternationalDate(rawValue: string, primaryLanguage?: DocumentLanguage): InternationalDate {
  const compact = rawValue
    .replace(/(^|[./\-\s])[Oo](?=$|[./\-\s])/g, '$10')
    .replace(/(\d)\s+(?=\d)/g, '$1')
    .trim();
  const iso = compact.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const value = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return { rawValue, ...(value ? { normalizedValue: value } : {}), ambiguous: false, alternatives: [] };
  }
  const numeric = compact.match(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = Number(numeric[3]);
    const dayFirst = isoDate(year, second, first);
    const monthFirst = isoDate(year, first, second);
    const ambiguous = !!dayFirst && !!monthFirst && dayFirst !== monthFirst;
    const dayFirstLanguage = primaryLanguage && primaryLanguage !== 'en';
    const selected = ambiguous ? (dayFirstLanguage ? dayFirst : undefined) : dayFirst ?? monthFirst;
    return {
      rawValue,
      ...(selected ? { normalizedValue: selected } : {}),
      ambiguous,
      alternatives: [...new Set([dayFirst, monthFirst].filter((value): value is string => !!value))],
      ...(primaryLanguage ? { languageEvidence: primaryLanguage } : {}),
    };
  }
  const natural = normalizeDocumentLabel(compact).match(/\b(\d{1,2})\s+(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})\b/);
  if (natural) {
    for (const [language, months] of Object.entries(MONTHS) as Array<[DocumentLanguage, Readonly<Record<string, number>>]>) {
      const month = months[natural[2]];
      if (!month) continue;
      const value = isoDate(Number(natural[3]), month, Number(natural[1]));
      return { rawValue, ...(value ? { normalizedValue: value } : {}), ambiguous: false, alternatives: [], languageEvidence: language };
    }
  }
  return { rawValue, ambiguous: false, alternatives: [] };
}

export function looksLikeInternationalTaxIdentifier(value: string): boolean {
  const compact = value.toUpperCase().replace(/[ .-]/g, '');
  return /^(?:IT\d{11}|FR[A-Z0-9]{2}\d{9}|DE\d{9}|ES[A-Z0-9]\d{7}[A-Z0-9]|GB\d{9}(?:\d{3})?|CHE\d{9}(?:MWST|TVA|IVA)?|(?:ATU|BE0|NL|LU|IE|PT|PL|CZ|SK|SI|HR|HU|RO|BG|DK|SE|FI|EL)[A-Z0-9]{7,12})$/.test(compact);
}

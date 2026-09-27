export type DocumentFieldSource =
  | 'local_ocr'
  | 'cloud_ai'
  | 'merged'
  | 'user';

export type DocumentFieldConfidenceType =
  | 'measured'
  | 'heuristic'
  | 'unknown';

export type DocumentFieldValidationStatus =
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'ambiguous'
  | 'unverified';

export type DocumentReliabilityFieldKey =
  | 'documentNumber'
  | 'customerName'
  | 'date'
  | 'vatNumber'
  | 'subtotal'
  | 'vatAmount'
  | 'total'
  | 'currency'
  | 'items'
  | 'extractedFields';

export interface DocumentFieldAlternative {
  value?: unknown;
  rawValue?: unknown;
  source: DocumentFieldSource;
  pageIndex?: number;
  confidence?: number;
  confidenceType: DocumentFieldConfidenceType;
  validationStatus: DocumentFieldValidationStatus;
  validationReasons: string[];
}

export interface DocumentFieldReliability
  extends DocumentFieldAlternative {
  requiresReview: boolean;
  alternatives: DocumentFieldAlternative[];
  conflict: boolean;
}

export type DocumentFieldReliabilityMap = Partial<
  Record<DocumentReliabilityFieldKey, DocumentFieldReliability>
>;

export interface EvaluateDocumentFieldOptions {
  source: DocumentFieldSource;
  pageIndex?: number;
  confidence?: number;
  confidenceType?: DocumentFieldConfidenceType;
  /**
   * Un valore digitato e confermato dall'utente non è una previsione OCR.
   * Resta comunque soggetto ai controlli sintattici e di calendario.
   */
  userConfirmed?: boolean;
}

export interface StrictDocumentDateResult {
  rawValue: unknown;
  value?: string;
  date?: Date;
  validationStatus: Extract<
    DocumentFieldValidationStatus,
    'valid' | 'invalid' | 'missing' | 'ambiguous'
  >;
  validationReasons: string[];
  requiresReview: boolean;
}

export interface DocumentAmountResult {
  rawValue: unknown;
  value?: number;
  validationStatus: Extract<
    DocumentFieldValidationStatus,
    'valid' | 'invalid' | 'missing'
  >;
  validationReasons: string[];
  requiresReview: boolean;
}

export const DOCUMENT_RELIABILITY_FIELD_KEYS: readonly DocumentReliabilityFieldKey[] =
  [
    'documentNumber',
    'customerName',
    'date',
    'vatNumber',
    'subtotal',
    'vatAmount',
    'total',
    'currency',
    'items',
    'extractedFields',
  ];

const AMOUNT_FIELDS = new Set<DocumentReliabilityFieldKey>([
  'subtotal',
  'vatAmount',
  'total',
]);

const MISSING_STRINGS = new Set([
  '',
  '-',
  '–',
  '—',
  'n/a',
  'na',
  'n.d.',
  'n.d',
  'nd',
  'non disponibile',
  'unknown',
  'not found',
  'null',
  'undefined',
]);

function own(record: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Accetta sia lo scalare piatto sia il wrapper structured `{ value, ... }`. */
function unwrapDocumentFieldValue(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    own(value, 'value')
  ) {
    return (value as { value: unknown }).value;
  }
  return value;
}

function normalizedMissingToken(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('it-IT');
}

export function isMissingDocumentValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  return MISSING_STRINGS.has(normalizedMissingToken(value));
}

function normalizedConfidence(
  confidence: number | undefined
): number | undefined {
  return typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
    ? confidence
    : undefined;
}

function confidenceMetadata(
  options: EvaluateDocumentFieldOptions
): Pick<DocumentFieldAlternative, 'confidence' | 'confidenceType'> {
  const confidence = normalizedConfidence(options.confidence);
  const requestedType = options.confidenceType ?? 'unknown';
  if (confidence === undefined) {
    return {
      confidenceType:
        requestedType === 'measured' ? 'unknown' : requestedType,
    };
  }
  return {
    confidence,
    confidenceType: requestedType,
  };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  if ([4, 6, 9, 11].includes(month)) return 30;
  return 31;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function canonicalDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

function dateAfterValidation(
  year: number,
  month: number,
  day: number
): Date {
  // Il calendario è già stato validato manualmente. La mezzanotte locale
  // mantiene invariato il giorno mostrato dalla UI in qualunque fuso orario.
  return new Date(year, month - 1, day);
}

export function validateStrictDocumentDate(
  rawValue: unknown,
  options: { userConfirmed?: boolean } = {}
): StrictDocumentDateResult {
  if (isMissingDocumentValue(rawValue)) {
    return {
      rawValue,
      validationStatus: 'missing',
      validationReasons: ['missing_value'],
      requiresReview: true,
    };
  }

  if (rawValue instanceof Date) {
    if (Number.isNaN(rawValue.getTime())) {
      return {
        rawValue,
        validationStatus: 'invalid',
        validationReasons: ['invalid_date'],
        requiresReview: true,
      };
    }
    const year = rawValue.getFullYear();
    const month = rawValue.getMonth() + 1;
    const day = rawValue.getDate();
    const value = canonicalDate(
      year,
      month,
      day
    );
    return {
      rawValue: value,
      value,
      date: dateAfterValidation(year, month, day),
      validationStatus: 'valid',
      validationReasons: ['valid_calendar_date'],
      requiresReview: false,
    };
  }

  if (typeof rawValue !== 'string') {
    return {
      rawValue,
      validationStatus: 'invalid',
      validationReasons: ['invalid_date_type'],
      requiresReview: true,
    };
  }

  const text = rawValue.trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!iso && !local) {
    return {
      rawValue: text,
      validationStatus: 'invalid',
      validationReasons: ['invalid_date_format'],
      requiresReview: true,
    };
  }

  const year = Number(iso?.[1] ?? local?.[3]);
  const month = Number(iso?.[2] ?? local?.[2]);
  const day = Number(iso?.[3] ?? local?.[1]);
  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(day) ||
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return {
      rawValue: text,
      validationStatus: 'invalid',
      validationReasons: ['invalid_calendar_date'],
      requiresReview: true,
    };
  }

  const value = canonicalDate(year, month, day);
  const ambiguousDayMonth =
    !!local && day <= 12 && month <= 12 && day !== month;
  if (ambiguousDayMonth && !options.userConfirmed) {
    return {
      rawValue: text,
      value,
      validationStatus: 'ambiguous',
      validationReasons: ['ambiguous_day_month'],
      requiresReview: true,
    };
  }

  return {
    rawValue: text,
    value,
    date: dateAfterValidation(year, month, day),
    validationStatus: 'valid',
    validationReasons: [
      ambiguousDayMonth
        ? 'user_confirmed_day_month'
        : 'valid_calendar_date',
    ],
    requiresReview: false,
  };
}

function strictAmountFromText(rawValue: string): number | undefined {
  let text = rawValue.trim().replace(/\u00a0/g, ' ');
  text = text
    .replace(/^(?:EUR|USD|GBP|CHF|CAD|AUD|JPY|€|\$|£)\s*/i, '')
    .replace(/\s*(?:EUR|USD|GBP|CHF|CAD|AUD|JPY|€|\$|£)$/i, '')
    .trim();
  if (!text || !/\d/.test(text)) return undefined;

  let negative = false;
  if (text.startsWith('+') || text.startsWith('-')) {
    negative = text.startsWith('-');
    text = text.slice(1);
  }
  if (!text || /[+\-]/.test(text)) return undefined;

  if (/[ ']/.test(text)) {
    if (!/^\d{1,3}(?:[ ']\d{3})+(?:[.,]\d{1,2})?$/.test(text)) {
      return undefined;
    }
    text = text.replace(/[ ']/g, '');
  }

  const italianGrouped = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(
    text
  );
  const internationalGrouped =
    /^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text);
  const plain = /^\d+(?:[.,]\d{1,2})?$/.test(text);
  if (!italianGrouped && !internationalGrouped && !plain) {
    return undefined;
  }

  const normalized = italianGrouped
    ? text.replace(/\./g, '').replace(',', '.')
    : internationalGrouped
      ? text.replace(/,/g, '')
      : text.replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return undefined;
  return negative ? -value : value;
}

export function validateDocumentAmount(
  rawValue: unknown
): DocumentAmountResult {
  if (isMissingDocumentValue(rawValue)) {
    return {
      rawValue,
      validationStatus: 'missing',
      validationReasons: ['missing_value'],
      requiresReview: true,
    };
  }

  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue) || rawValue < 0) {
      return {
        rawValue,
        validationStatus: 'invalid',
        validationReasons: ['invalid_amount'],
        requiresReview: true,
      };
    }
    return {
      rawValue,
      value: rawValue,
      validationStatus: 'valid',
      validationReasons: ['valid_amount'],
      requiresReview: false,
    };
  }

  if (typeof rawValue !== 'string') {
    return {
      rawValue,
      validationStatus: 'invalid',
      validationReasons: ['invalid_amount_type'],
      requiresReview: true,
    };
  }

  const parsed = strictAmountFromText(rawValue);
  if (parsed === undefined) {
    return {
      rawValue,
      validationStatus: 'invalid',
      validationReasons: ['invalid_amount_format'],
      requiresReview: true,
    };
  }

  if (!Number.isFinite(parsed) || parsed < 0) {
    return {
      rawValue,
      validationStatus: 'invalid',
      validationReasons: ['invalid_amount'],
      requiresReview: true,
    };
  }
  return {
    rawValue,
    value: parsed,
    validationStatus: 'valid',
    validationReasons: ['valid_amount'],
    requiresReview: false,
  };
}

function evaluateItems(rawValue: unknown): Pick<
  DocumentFieldReliability,
  | 'value'
  | 'rawValue'
  | 'validationStatus'
  | 'validationReasons'
  | 'requiresReview'
> {
  if (rawValue === null || rawValue === undefined) {
    return {
      rawValue,
      validationStatus: 'missing',
      validationReasons: ['missing_items'],
      requiresReview: true,
    };
  }
  if (!Array.isArray(rawValue)) {
    return {
      rawValue,
      validationStatus: 'invalid',
      validationReasons: ['invalid_items_type'],
      requiresReview: true,
    };
  }
  if (rawValue.length === 0) {
    return {
      rawValue,
      value: [],
      validationStatus: 'missing',
      validationReasons: ['empty_items'],
      requiresReview: true,
    };
  }

  const normalizedItems: Array<Record<string, unknown>> = [];
  let invalid = false;
  let incomplete = false;
  for (const rawItem of rawValue) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      invalid = true;
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    const description = unwrapDocumentFieldValue(item.description);
    if (
      typeof description === 'string' &&
      !isMissingDocumentValue(description)
    ) {
      normalized.description = description.trim();
    } else {
      incomplete = true;
    }
    for (const key of ['quantity', 'unitPrice', 'total', 'vatRate'] as const) {
      const hasAlias = key === 'total' && own(item, 'lineTotal');
      if (!own(item, key) && !hasAlias) {
        if (key !== 'vatRate') incomplete = true;
        continue;
      }
      const amount = validateDocumentAmount(
        unwrapDocumentFieldValue(
          key === 'total' ? item.total ?? item.lineTotal : item[key]
        )
      );
      if (amount.validationStatus === 'valid') {
        normalized[key] = amount.value;
      } else if (key !== 'vatRate') {
        if (amount.validationStatus === 'invalid') invalid = true;
        else incomplete = true;
      }
    }
    if (Object.keys(normalized).length > 0) normalizedItems.push(normalized);
  }

  if (invalid || normalizedItems.length === 0) {
    return {
      rawValue,
      ...(normalizedItems.length > 0 ? { value: normalizedItems } : {}),
      validationStatus: 'invalid',
      validationReasons: ['invalid_item'],
      requiresReview: true,
    };
  }
  if (incomplete) {
    return {
      rawValue,
      value: normalizedItems,
      validationStatus: 'unverified',
      validationReasons: ['incomplete_item'],
      requiresReview: true,
    };
  }
  return {
    rawValue,
    value: normalizedItems,
    validationStatus: 'valid',
    validationReasons: ['complete_items'],
    requiresReview: false,
  };
}

function evaluateText(
  field: DocumentReliabilityFieldKey,
  rawValue: unknown,
  userConfirmed: boolean
): Pick<
  DocumentFieldReliability,
  | 'value'
  | 'rawValue'
  | 'validationStatus'
  | 'validationReasons'
  | 'requiresReview'
> {
  if (isMissingDocumentValue(rawValue)) {
    return {
      rawValue,
      validationStatus: 'missing',
      validationReasons: ['missing_value'],
      requiresReview: true,
    };
  }
  if (typeof rawValue !== 'string') {
    return {
      rawValue,
      validationStatus: 'invalid',
      validationReasons: ['invalid_text_type'],
      requiresReview: true,
    };
  }

  const value = rawValue.trim().replace(/\s+/g, ' ');
  if (field === 'currency') {
    const currency = value.toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      return {
        rawValue,
        validationStatus: 'invalid',
        validationReasons: ['invalid_currency'],
        requiresReview: true,
      };
    }
    return {
      rawValue,
      value: currency,
      validationStatus: 'valid',
      validationReasons: ['valid_currency_code'],
      requiresReview: false,
    };
  }

  return {
    rawValue,
    value,
    validationStatus: userConfirmed ? 'valid' : 'unverified',
    validationReasons: [
      userConfirmed ? 'user_confirmed_value' : 'text_not_semantically_verified',
    ],
    requiresReview: !userConfirmed,
  };
}

export function evaluateDocumentField(
  field: DocumentReliabilityFieldKey,
  rawValue: unknown,
  options: EvaluateDocumentFieldOptions
): DocumentFieldReliability {
  const userConfirmed =
    options.source === 'user' && options.userConfirmed === true;
  const evaluated =
    field === 'date'
      ? validateStrictDocumentDate(rawValue, { userConfirmed })
      : AMOUNT_FIELDS.has(field)
        ? validateDocumentAmount(rawValue)
        : field === 'items'
          ? evaluateItems(rawValue)
          : field === 'extractedFields'
            ? rawValue &&
              typeof rawValue === 'object' &&
              !Array.isArray(rawValue) &&
              Object.keys(rawValue).length > 0
              ? {
                  rawValue,
                  value: rawValue,
                  validationStatus: 'unverified' as const,
                  validationReasons: ['unverified_extracted_fields'],
                  requiresReview: true,
                }
              : {
                  rawValue,
                  validationStatus: 'missing' as const,
                  validationReasons: ['missing_extracted_fields'],
                  requiresReview: true,
                }
            : evaluateText(field, rawValue, userConfirmed);
  const confidence = confidenceMetadata(options);
  const unknownCloudConfidence =
    options.source === 'cloud_ai' &&
    confidence.confidenceType === 'unknown' &&
    evaluated.validationStatus !== 'missing';

  return {
    ...evaluated,
    source: options.source,
    ...(options.pageIndex !== undefined
      ? { pageIndex: options.pageIndex }
      : {}),
    ...confidence,
    validationReasons: [
      ...evaluated.validationReasons,
      ...(unknownCloudConfidence ? ['provider_confidence_unavailable'] : []),
    ],
    requiresReview:
      evaluated.requiresReview || unknownCloudConfidence,
    alternatives: [],
    conflict: false,
  };
}

export function documentFieldAlternative(
  reliability: DocumentFieldReliability
): DocumentFieldAlternative {
  return {
    ...(own(reliability, 'value') ? { value: reliability.value } : {}),
    ...(own(reliability, 'rawValue')
      ? { rawValue: reliability.rawValue }
      : {}),
    source: reliability.source,
    ...(reliability.pageIndex !== undefined
      ? { pageIndex: reliability.pageIndex }
      : {}),
    ...(reliability.confidence !== undefined
      ? { confidence: reliability.confidence }
      : {}),
    confidenceType: reliability.confidenceType,
    validationStatus: reliability.validationStatus,
    validationReasons: [...reliability.validationReasons],
  };
}

export function isApplicableDocumentField(
  reliability: Pick<
    DocumentFieldReliability,
    'validationStatus' | 'conflict'
  >
): boolean {
  return (
    !reliability.conflict &&
    (reliability.validationStatus === 'valid' ||
      reliability.validationStatus === 'unverified')
  );
}

export function strictDocumentDateToDate(
  value: unknown,
  options: { userConfirmed?: boolean } = {}
): Date | undefined {
  return validateStrictDocumentDate(value, options).date;
}

import type {
  DocumentType,
  OcrLine,
  OcrQualityMetadata,
} from '../types';
import type { GeminiDocumentExtractOutcome } from './gemini-ocr';
import {
  normalizeGeminiDocumentExtract,
  type GeminiDocumentExtract,
} from './gemini-document-extract';
import type { DocumentMergeFieldKey } from './document-field-merge';
import {
  DOCUMENT_RELIABILITY_FIELD_KEYS,
  evaluateDocumentField,
  isApplicableDocumentField,
  isMissingDocumentValue,
  validateDocumentAmount,
  validateStrictDocumentDate,
  type DocumentFieldConfidenceType,
  type DocumentFieldReliability,
  type DocumentFieldReliabilityMap,
  type DocumentFieldSource,
  type DocumentReliabilityFieldKey,
} from './document-field-reliability';
import {
  assessOcrQuality,
  emptyOcrQuality,
  reconcileOcrQualityMetadata,
} from './ocr-quality';
import { MAX_CLOUD_DOCUMENT_PAGES } from './cloud-ai-limits';
import { parseMinimalScanPageFields } from './document-parser';
import { logDocumentProcess } from './document-process-log';
import { processDeadlineExceeded } from './scan-process-deadline';

export type PageProcessingMethod =
  | 'local'
  | 'cloud'
  | 'local_fallback'
  | 'failed';

export interface DocumentPageItem {
  description?: string;
  quantity?: number;
  unitPrice?: number;
  total?: number;
  vatRate?: number;
}

/**
 * Campi realmente osservati in una singola pagina.
 *
 * Tutte le proprietà sono opzionali: l'assenza resta assenza e non viene
 * convertita in zero, stringa vuota o array vuoto affidabile.
 */
export interface DocumentPageStructuredFields {
  documentNumber?: string;
  customerName?: string;
  date?: string;
  vatNumber?: string;
  subtotal?: number;
  vatAmount?: number;
  total?: number;
  currency?: string;
  items?: DocumentPageItem[];
  extractedFields?: Record<string, string>;
}

export interface PageExtractionResult {
  pageIndex: number;
  imageUri: string;
  processingMethod: PageProcessingMethod;
  rawText: string;
  structuredFields: DocumentPageStructuredFields;
  /** Provider-agnostic schema v2, kept intact for reconciliation/review. */
  aiStructured?: import('./document-ai-contract').AiStructuredDocumentExtract;
  fieldConfidence?: Partial<Record<DocumentMergeFieldKey, number>>;
  fieldReliability?: DocumentFieldReliabilityMap;
  /** Qualità OCR generale, indipendente dalla validazione dei campi. */
  ocrQuality?: OcrQualityMetadata;
  warnings: string[];
  error?: string;
  duplicateOf?: number;
  completed: boolean;
  requiresReview: boolean;
}

export interface LocalPageOcr {
  lines: OcrLine[];
  text: string;
  quality?: OcrQualityMetadata;
}

export interface LocalPageSnapshot {
  lines: OcrLine[];
  rawText: string;
  ocrQuality?: OcrQualityMetadata;
  error?: string;
  completed?: boolean;
}

export type LocalDocumentPageExtractor = (
  imageUri: string
) => Promise<LocalPageOcr>;

export type DocumentPageStructureBuilder = (
  documentType: DocumentType,
  lines: OcrLine[],
  rawText: string
) => DocumentPageStructuredFields;

export type CloudDocumentPageExtractor = (
  imageUri: string,
  pageIndex?: number,
  pageCount?: number
) => Promise<GeminiDocumentExtractOutcome>;

export type CloudPagesExtractionOutcome =
  | { status: 'ok'; results: PageExtractionResult[] }
  | { status: 'not_configured'; results: PageExtractionResult[] }
  | {
      status: 'error';
      results: PageExtractionResult[];
      message: string;
      failedPageIndex: number;
      reason: 'provider_unavailable' | 'invalid_response';
    }
  | {
      status: 'credits_exhausted';
      results: PageExtractionResult[];
      failedPageIndex: number;
    };

export const PAGE_WARNING_EMPTY_TEXT = 'empty_text';
export const PAGE_WARNING_CLOUD_FALLBACK = 'cloud_fallback';
export const PAGE_WARNING_DUPLICATE = 'duplicate_page';
export const PAGE_WARNING_PARTIAL_FIELDS = 'partial_structured_fields';
export const DOCUMENT_CLOUD_PAGE_TIMEOUT_MS = 50_000;

function meaningfulText(lines: readonly OcrLine[], text: string): string {
  const direct = text.trim();
  if (direct) return direct;
  return lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join('\n');
}

function explicitCurrencyInText(rawText: string): string | undefined {
  const currencies = new Set(
    [...rawText.matchAll(/\b(EUR|USD|GBP|CHF|CAD|AUD|JPY|CNY|SEK|NOK|DKK|PLN)\b/gi)]
      .map((match) => match[1].toUpperCase())
  );
  if (rawText.includes('€')) currencies.add('EUR');
  if (rawText.includes('£')) currencies.add('GBP');
  return currencies.size === 1 ? [...currencies][0] : undefined;
}

/**
 * Gemini usa valori vuoti nel proprio DTO di compatibilità. Il contratto
 * per-pagina li elimina subito, prima che possano essere interpretati come
 * estrazioni affidabili.
 */
function fieldSourceFromMethod(
  processingMethod: PageProcessingMethod
): DocumentFieldSource {
  return processingMethod === 'cloud' ? 'cloud_ai' : 'local_ocr';
}

function confidenceTypeForPage(
  processingMethod: PageProcessingMethod,
  confidence: number | undefined
): DocumentFieldConfidenceType {
  if (confidence !== undefined) return 'measured';
  return processingMethod === 'cloud' ? 'unknown' : 'heuristic';
}

function reliabilityRawValue(
  fields: DocumentPageStructuredFields,
  rawFields: GeminiDocumentExtract['rawFields'] | undefined,
  field: DocumentReliabilityFieldKey
): unknown {
  // Per gli item cloud preferiamo l'evidenza grezza quando è nel formato
  // top-level normale: così valori presenti ma invalidi non vengono persi durante
  // la normalizzazione e possono essere classificati correttamente come invalidi.
  // Gli item PDF strutturati possono invece contenere wrapper { value, evidenceText };
  // in quel caso manteniamo fields.items, già normalizzato dal relativo contratto.
  if (field === 'items') {
    const rawItems = rawFields?.items;
    const hasWrappedItems =
      Array.isArray(rawItems) &&
      rawItems.some(
        (item) =>
          !!item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.values(item as Record<string, unknown>).some(
            (value) =>
              !!value &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              Object.prototype.hasOwnProperty.call(value, 'value')
          )
      );

    if (Array.isArray(rawItems) && !hasWrappedItems) {
      return rawItems;
    }
    if (Array.isArray(fields.items) && fields.items.length > 0) {
      return fields.items;
    }
  }
  if (
    rawFields &&
    Object.prototype.hasOwnProperty.call(rawFields, field)
  ) {
    return rawFields[field as keyof typeof rawFields];
  }
  return fields[field as keyof DocumentPageStructuredFields];
}

const CLOUD_ZERO_LABELS: Partial<
  Record<'subtotal' | 'vatAmount' | 'total', string>
> = {
  subtotal: '(?:subtotale|subtotal|imponibile)',
  vatAmount: '(?:iva|vat)(?:\\s+(?:importo|amount))?',
  total: '(?:totale|total|amount\\s+due|da\\s+pagare)',
};

/**
 * Un'imposta a zero dichiarata dal documento si riconosce anche dalla natura
 * dell'operazione, non solo dall'etichetta "IVA" seguita da uno zero: inversione
 * contabile, esenzione e aliquota zero sono il modo normale di scriverlo.
 */
const ZERO_RATED_VAT_NATURE =
  /\b(?:reverse\s*charge|inversione\s+contabile|autoliquidazione|esente|esenzione|non\s+imponibile|zero[-\s]?rated|exempt|steuerfrei|exon[ée]r[ée]e?)\b/i;
const EXPLICIT_ZERO_AMOUNT = /(?:^|[^\d.,])0(?:[.,]0{1,2})?(?![\d.,])(?!\s*%)/;

function rawTextHasLabeledZeroAmount(
  rawText: string,
  field: 'subtotal' | 'vatAmount' | 'total'
): boolean {
  const label = CLOUD_ZERO_LABELS[field];
  if (!label) return false;
  const zero =
    '(?:(?:EUR|USD|GBP|CHF|CAD|AUD|JPY|€|\\$|£)\\s*)?' +
    '0(?:[.,]0{1,2})?(?![\\d.,])(?!(?:\\s*)%)' +
    '(?:\\s*(?:EUR|USD|GBP|CHF|CAD|AUD|JPY|€|\\$|£))?';
  if (
    new RegExp(`\\b${label}\\b\\s*(?:[:=\\-–—]\\s*)?${zero}`, 'i').test(rawText)
  ) {
    return true;
  }
  // Un'aliquota zero da sola non basta: serve un importo zero scritto accanto
  // alla natura dell'operazione.
  if (field !== 'vatAmount') return false;
  return rawText
    .split(/\r?\n/)
    .some(
      (line) => ZERO_RATED_VAT_NATURE.test(line) && EXPLICIT_ZERO_AMOUNT.test(line)
    );
}

function normalizedEvidenceText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/\s+/g, ' ')
    .trim();
}

function countStandaloneZeros(value: string): number {
  const withoutPercentages = value.replace(
    /(?:^|[^\d])0(?:[.,]0{1,2})?\s*%/g,
    ' '
  );
  return [
    ...withoutPercentages.matchAll(
      /(?:^|[^\d])0(?:[.,]0{1,2})?(?![\d.,])/g
    ),
  ].length;
}

function lineContainsItemDescription(
  line: string,
  description: string
): boolean {
  const normalizedLine = normalizedEvidenceText(line);
  const normalizedDescription = normalizedEvidenceText(description);
  if (!normalizedDescription) return false;
  const compactDescription = normalizedDescription.replace(
    /[^a-z0-9]/gi,
    ''
  );
  if (
    compactDescription.length < 2 ||
    (/^[a-z]+$/i.test(compactDescription) &&
      compactDescription.length < 3)
  ) {
    return false;
  }
  const escaped = normalizedDescription
    .split(/\s+/)
    .map((token) =>
      token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('\\s+');
  return new RegExp(
    `(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`,
    'i'
  ).test(normalizedLine);
}

function lineContainsItemAmounts(
  line: string,
  item: Record<string, unknown>
): boolean {
  const required = [
    'quantity',
    'unitPrice',
    'total',
  ].flatMap((key): number[] => {
    if (!Object.prototype.hasOwnProperty.call(item, key)) return [];
    const amount = validateDocumentAmount(item[key]);
    return amount.validationStatus === 'valid' &&
      amount.value !== undefined
      ? [amount.value]
      : [];
  });
  const withoutPercentages = line.replace(
    /(?:^|[^\d])\d+(?:[.,]\d{1,2})?\s*%/g,
    ' '
  );
  const observed = [
    ...withoutPercentages.matchAll(
      /(?:^|[^a-z0-9])(\d{1,3}(?:[ .'’]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![a-z0-9])/gi
    ),
  ].flatMap((match): number[] => {
    const amount = validateDocumentAmount(match[1]);
    return amount.validationStatus === 'valid' &&
      amount.value !== undefined
      ? [amount.value]
      : [];
  });

  for (const amount of required) {
    const index = observed.findIndex(
      (candidate) => Math.abs(candidate - amount) < 0.005
    );
    if (index < 0) return false;
    observed.splice(index, 1);
  }
  return true;
}

function cloudItemZerosAreObserved(
  rawText: string,
  rawItems: unknown
): boolean {
  if (!Array.isArray(rawItems)) return true;
  const lines = rawText.split(/\r?\n/);
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const zeroCount = ['quantity', 'unitPrice', 'total'].filter((key) => {
      const amount = validateDocumentAmount(item[key]);
      return amount.validationStatus === 'valid' && amount.value === 0;
    }).length;
    if (zeroCount === 0) continue;
    const description =
      typeof item.description === 'string'
        ? normalizedEvidenceText(item.description)
        : '';
    if (!description) return false;
    const evidenceLine = lines.find((line) =>
      lineContainsItemDescription(line, description) &&
      lineContainsItemAmounts(line, item)
    );
    if (!evidenceLine || countStandaloneZeros(evidenceLine) < zeroCount) {
      return false;
    }
  }
  return true;
}

/**
 * Mesi scritti a parole nelle lingue commerciali che l'app incontra: senza di
 * questi una data perfettamente leggibile come "Feb 6, 2025" risulta non vista
 * nel documento e viene scartata.
 */
const MONTH_NAMES: Record<string, number> = {
  gen: 1, gennaio: 1, jan: 1, january: 1, januar: 1, janvier: 1, ene: 1, enero: 1,
  feb: 2, febbraio: 2, february: 2, februar: 2, fev: 2, fevrier: 2, febrero: 2,
  mar: 3, marzo: 3, march: 3, marz: 3, mars: 3, maerz: 3,
  apr: 4, aprile: 4, april: 4, avr: 4, avril: 4, abr: 4, abril: 4,
  mag: 5, maggio: 5, may: 5, mai: 5, mayo: 5,
  giu: 6, giugno: 6, jun: 6, june: 6, juni: 6, juin: 6, junio: 6,
  lug: 7, luglio: 7, jul: 7, july: 7, juli: 7, juillet: 7, julio: 7,
  ago: 8, agosto: 8, aug: 8, august: 8, aout: 8,
  set: 9, settembre: 9, sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9,
  ott: 10, ottobre: 10, oct: 10, october: 10, okt: 10, oktober: 10, octobre: 10, octubre: 10,
  nov: 11, novembre: 11, november: 11, noviembre: 11,
  dic: 12, dicembre: 12, dec: 12, december: 12, dez: 12, dezember: 12, decembre: 12, diciembre: 12,
};

/** Righe che parlano di termini e consegne: non possono confermare la data del documento. */
const DEADLINE_LABEL =
  /\b(?:scadenza|valido\s+fino|validit[àa]|valid\s+until|due\s+date|consegna|delivery|immatricolazione|nascita|birth)\b/i;

function monthFromName(value: string): number | undefined {
  const key = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return MONTH_NAMES[key] ?? MONTH_NAMES[key.slice(0, 3)];
}

/** Date con il mese scritto a parole, nei due ordini in uso. */
function textualDates(line: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b([A-Za-z\u00c0-\u024f]{3,10})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{4})\b/g,
    /\b(\d{1,2})\.?\s*(?:°|º)?\s+(?:de\s+)?([A-Za-z\u00c0-\u024f]{3,10})\.?\s+(?:de\s+)?(\d{4})\b/g,
  ];
  for (const [index, pattern] of patterns.entries()) {
    for (const match of line.matchAll(pattern)) {
      const month = monthFromName(index === 0 ? match[1] : match[2]);
      const day = Number(index === 0 ? match[2] : match[1]);
      const year = Number(match[3]);
      if (!month || !Number.isSafeInteger(day) || day < 1 || day > 31) continue;
      found.push(
        `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      );
    }
  }
  return found;
}

function observedRawDate(
  rawText: string,
  candidate: unknown
): string | undefined {
  const normalizedCandidate = validateStrictDocumentDate(candidate);
  const lines = rawText.split(/\r?\n/);
  const labeledLine = lines.find(
    (line) => /\b(?:data|date)\b/i.test(line) && !DEADLINE_LABEL.test(line)
  );
  if (labeledLine) {
    const afterLabel =
      labeledLine.match(/\b(?:data|date)\b(.*)$/i)?.[1]?.trim() ?? '';
    const separatorIndex = Math.max(
      afterLabel.lastIndexOf(':'),
      afterLabel.lastIndexOf('=')
    );
    const labeledValue =
      separatorIndex >= 0
        ? afterLabel.slice(separatorIndex + 1).trim()
        : afterLabel;
    if (
      isMissingDocumentValue(labeledValue)
    ) {
      return labeledValue;
    }
    const trailingSentinel = afterLabel.match(
      /(?:^|\s)(n\s*\/\s*a|na|n\.?\s*d\.?|non\s+disponibile|not\s+available|unknown|not\s+found|null|undefined|-)\s*$/i
    )?.[1];
    if (
      trailingSentinel !== undefined &&
      isMissingDocumentValue(trailingSentinel)
    ) {
      return trailingSentinel;
    }
    const labeledDates = labeledLine.match(
      /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/g
    );
    const candidates = [...(labeledDates ?? []), ...textualDates(labeledLine)];
    if (normalizedCandidate.value) {
      const matchingCandidate = candidates.find(
        (raw) =>
          validateStrictDocumentDate(raw).value ===
          normalizedCandidate.value
      );
      if (matchingCandidate) return matchingCandidate;
    }
    if (candidates.length > 0) return candidates[0];
  }

  // Senza una riga etichettata la data resta valida se il documento la mostra
  // comunque, nella stessa forma o scritta a parole. Le righe di scadenza e
  // consegna restano escluse: una data limite non è la data del documento.
  if (!normalizedCandidate.value) return undefined;
  for (const line of lines) {
    if (DEADLINE_LABEL.test(line)) continue;
    const written = [
      ...(line.match(
        /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/g
      ) ?? []),
      ...textualDates(line),
    ];
    const matching = written.find(
      (raw) => validateStrictDocumentDate(raw).value === normalizedCandidate.value
    );
    if (matching) return matching;
  }
  return undefined;
}

function uncorroboratedCloudEvidence(
  evidence: DocumentFieldReliability,
  reason: string
): DocumentFieldReliability {
  return {
    ...evidence,
    validationStatus: 'ambiguous',
    validationReasons: [
      ...evidence.validationReasons,
      reason,
    ],
    requiresReview: true,
  };
}

export function buildPageFieldReliability(
  fields: DocumentPageStructuredFields,
  processingMethod: PageProcessingMethod,
  pageIndex: number,
  fieldConfidence?: Partial<Record<DocumentMergeFieldKey, number>>,
  rawFields?: GeminiDocumentExtract['rawFields'],
  rawText = ''
): DocumentFieldReliabilityMap {
  const source = fieldSourceFromMethod(processingMethod);
  const result: DocumentFieldReliabilityMap = {};
  for (const field of DOCUMENT_RELIABILITY_FIELD_KEYS) {
    const confidence =
      field === 'extractedFields'
        ? undefined
        : fieldConfidence?.[field as DocumentMergeFieldKey];
    const originalRawValue = reliabilityRawValue(fields, rawFields, field);
    const dateRawValue =
      processingMethod === 'cloud' && field === 'date'
        ? observedRawDate(rawText, originalRawValue) ?? originalRawValue
        : originalRawValue;
    let evidence = evaluateDocumentField(
      field,
      dateRawValue,
      {
        source,
        pageIndex,
        ...(confidence !== undefined ? { confidence } : {}),
        confidenceType: confidenceTypeForPage(
          processingMethod,
          confidence
        ),
      }
    );
    if (
      processingMethod === 'cloud' &&
      (field === 'subtotal' ||
        field === 'vatAmount' ||
        field === 'total') &&
      evidence.value === 0 &&
      !rawTextHasLabeledZeroAmount(rawText, field)
    ) {
      evidence = uncorroboratedCloudEvidence(
        evidence,
        'cloud_zero_not_observed_for_field'
      );
    }
    if (
      processingMethod === 'cloud' &&
      field === 'items' &&
      !cloudItemZerosAreObserved(rawText, originalRawValue)
    ) {
      evidence = uncorroboratedCloudEvidence(
        evidence,
        'cloud_item_zero_not_observed'
      );
    }
    if (
      processingMethod === 'cloud' &&
      field === 'date' &&
      evidence.validationStatus === 'valid' &&
      !observedRawDate(rawText, originalRawValue)
    ) {
      evidence = uncorroboratedCloudEvidence(
        evidence,
        'cloud_date_not_observed'
      );
    }
    result[field] = evidence;
  }
  return result;
}

function normalizedItems(value: unknown): DocumentPageItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && !Array.isArray(item)
    )
    .map((item): DocumentPageItem => ({
      ...(typeof item.description === 'string' && item.description.trim()
        ? { description: item.description.trim() }
        : {}),
      ...(typeof item.quantity === 'number' &&
      Number.isFinite(item.quantity) &&
      item.quantity >= 0
        ? { quantity: item.quantity }
        : {}),
      ...(typeof item.unitPrice === 'number' &&
      Number.isFinite(item.unitPrice) &&
      item.unitPrice >= 0
        ? { unitPrice: item.unitPrice }
        : {}),
      ...(typeof item.total === 'number' &&
      Number.isFinite(item.total) &&
      item.total >= 0
        ? { total: item.total }
        : {}),
    }))
    .filter((item) => Object.keys(item).length > 0);
  return items.length > 0 ? items : undefined;
}

function fieldsFromReliability(
  reliability: DocumentFieldReliabilityMap
): DocumentPageStructuredFields {
  const result: DocumentPageStructuredFields = {};
  const apply = (
    field: DocumentReliabilityFieldKey,
    assign: (value: unknown) => void
  ): void => {
    const evidence = reliability[field];
    if (!evidence || !isApplicableDocumentField(evidence)) return;
    assign(evidence.value);
  };
  apply('documentNumber', (value) => {
    if (typeof value === 'string') result.documentNumber = value;
  });
  apply('customerName', (value) => {
    if (typeof value === 'string') result.customerName = value;
  });
  apply('date', (value) => {
    if (typeof value === 'string') result.date = value;
  });
  apply('vatNumber', (value) => {
    if (typeof value === 'string') result.vatNumber = value;
  });
  apply('subtotal', (value) => {
    if (typeof value === 'number') result.subtotal = value;
  });
  apply('vatAmount', (value) => {
    if (typeof value === 'number') result.vatAmount = value;
  });
  apply('total', (value) => {
    if (typeof value === 'number') result.total = value;
  });
  apply('currency', (value) => {
    if (typeof value === 'string') result.currency = value;
  });
  apply('items', (value) => {
    const items = normalizedItems(value);
    if (items) result.items = items;
  });
  apply('extractedFields', (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result.extractedFields = value as Record<string, string>;
    }
  });
  return result;
}

export function reliabilityFromCloudExtract(
  extract: unknown,
  pageIndex = 0,
  fieldConfidence?: Partial<Record<DocumentMergeFieldKey, number>>
): DocumentFieldReliabilityMap {
  const normalized = normalizeGeminiDocumentExtract(extract);
  if (!normalized) return {};
  const candidateFields: DocumentPageStructuredFields = {
    ...(normalized.documentNumber !== undefined
      ? { documentNumber: normalized.documentNumber }
      : {}),
    ...(normalized.customerName !== undefined
      ? { customerName: normalized.customerName }
      : {}),
    ...(normalized.date !== undefined ? { date: normalized.date } : {}),
    ...(normalized.subtotal !== undefined
      ? { subtotal: normalized.subtotal }
      : {}),
    ...(normalized.vatAmount !== undefined
      ? { vatAmount: normalized.vatAmount }
      : {}),
    ...(normalized.total !== undefined ? { total: normalized.total } : {}),
    ...(normalized.items !== undefined ? { items: normalized.items } : {}),
  };
  const currency = explicitCurrencyInText(normalized.rawText);
  if (currency) candidateFields.currency = currency;
  return buildPageFieldReliability(
    candidateFields,
    'cloud',
    pageIndex,
    fieldConfidence,
    normalized.rawFields,
    normalized.rawText
  );
}

export function sparseFieldsFromCloudExtract(
  extract: unknown
): DocumentPageStructuredFields {
  return fieldsFromReliability(reliabilityFromCloudExtract(extract));
}

export function pageResultFromLocalSnapshot(
  documentType: DocumentType,
  pageIndex: number,
  imageUri: string,
  page: LocalPageSnapshot,
  processingMethod: 'local' | 'local_fallback' = 'local',
  cloudError?: string,
  structurePage?: DocumentPageStructureBuilder
): PageExtractionResult {
  const rawText = meaningfulText(page.lines, page.rawText);
  const warnings = [
    ...(processingMethod === 'local_fallback'
      ? [PAGE_WARNING_CLOUD_FALLBACK]
      : []),
    ...(!rawText ? [PAGE_WARNING_EMPTY_TEXT] : []),
  ];

  try {
    const structuredFields = structurePage
      ? structurePage(documentType, page.lines, rawText)
      : {};
    const fieldReliability = buildPageFieldReliability(
      structuredFields,
      processingMethod,
      pageIndex,
      undefined,
      undefined,
      rawText
    );
    const fieldRequiresReview = Object.values(fieldReliability).some(
      (field) =>
        field?.validationStatus === 'invalid' ||
        field?.validationStatus === 'ambiguous' ||
        (field?.validationStatus === 'unverified' &&
          field.value !== undefined)
    );
    const ocrQuality = reconcileOcrQualityMetadata(
      page.ocrQuality,
      assessOcrQuality(page.lines, rawText, {
        confidenceType:
          page.ocrQuality?.confidenceType === 'heuristic'
            ? 'heuristic'
            : 'unknown',
        recognizedFieldCount: Object.keys(structuredFields).length,
        source: 'local',
      })
    );
    return {
      pageIndex,
      imageUri,
      processingMethod,
      rawText,
      structuredFields,
      fieldReliability,
      ocrQuality,
      warnings,
      ...(cloudError ? { error: cloudError } : {}),
      completed: true,
      requiresReview: warnings.length > 0 || fieldRequiresReview,
    };
  } catch (error) {
    const structureError =
      error instanceof Error ? error.message : String(error);
    return {
      pageIndex,
      imageUri,
      processingMethod: 'failed',
      rawText,
      structuredFields: {},
      ocrQuality: reconcileOcrQualityMetadata(
        page.ocrQuality,
        assessOcrQuality(page.lines, rawText, {
          confidenceType: 'unknown',
          source: 'local',
        })
      ),
      warnings,
      error: [
        cloudError,
        `Strutturazione locale fallita: ${structureError}`,
      ]
        .filter(Boolean)
        .join('; '),
      completed: false,
      requiresReview: true,
    };
  }
}

export function pageResultFromCloudExtract(
  pageIndex: number,
  imageUri: string,
  extract: unknown
): PageExtractionResult {
  const normalized = normalizeGeminiDocumentExtract(extract);
  if (!normalized) {
    throw new Error('Payload cloud non valido');
  }
  const rawText = normalized.rawText;
  const fieldReliability = reliabilityFromCloudExtract(
    normalized,
    pageIndex
  );
  const structuredFields = fieldsFromReliability(fieldReliability);
  const warnings = [
    ...(!rawText ? [PAGE_WARNING_EMPTY_TEXT] : []),
    ...(rawText && Object.keys(structuredFields).length === 0
      ? [PAGE_WARNING_PARTIAL_FIELDS]
      : []),
  ];
  const fieldRequiresReview = Object.values(fieldReliability).some(
    (field) =>
      field?.validationStatus !== 'missing' &&
      field?.requiresReview
  );
  const ocrQuality = assessOcrQuality([], rawText, {
    confidenceType: 'unknown',
    recognizedFieldCount: Object.keys(structuredFields).length,
    source: 'cloud',
  });
  return {
    pageIndex,
    imageUri,
    processingMethod: 'cloud',
    rawText,
    structuredFields,
    ...(normalized.structured ? { aiStructured: normalized.structured } : {}),
    fieldReliability,
    ocrQuality,
    warnings,
    completed: true,
    requiresReview: warnings.length > 0 || fieldRequiresReview,
  };
}

export function failedPageResult(
  pageIndex: number,
  imageUri: string,
  error: string
): PageExtractionResult {
  return {
    pageIndex,
    imageUri,
    processingMethod: 'failed',
    rawText: '',
    structuredFields: {},
    ocrQuality: emptyOcrQuality(),
    warnings: [],
    error,
    completed: false,
    requiresReview: true,
  };
}

/**
 * Per Elabora/new_scan: page result minimi senza parseLineItems né field reliability.
 */
export function localSnapshotsToScanPageResults(
  documentType: DocumentType,
  imageUris: readonly string[],
  pages: readonly LocalPageSnapshot[],
  options?: { deadline?: number },
): PageExtractionResult[] {
  const deadline = options?.deadline;
  const firstPageByUri = new Map<string, number>();
  return imageUris.map((imageUri, pageIndex) => {
    const pageStarted = Date.now();
    const page = pages[pageIndex];
    if (!page) {
      logDocumentProcess('page_results_stage', {
        stage: 'missing_page',
        pageIndex,
        ms: Date.now() - pageStarted,
      });
      return failedPageResult(
        pageIndex,
        imageUri,
        'Risultato OCR locale mancante',
      );
    }
    if (page.completed === false || page.error) {
      return failedPageResult(
        pageIndex,
        imageUri,
        page.error || 'Elaborazione OCR locale non completata',
      );
    }
    const textStarted = Date.now();
    const rawText = meaningfulText(page.lines, page.rawText);
    logDocumentProcess('page_results_stage', {
      stage: 'meaningfulText',
      pageIndex,
      ms: Date.now() - textStarted,
    });
    let structuredFields: DocumentPageStructuredFields = {};
    if (!processDeadlineExceeded(deadline)) {
      const fieldsStarted = Date.now();
      structuredFields = parseMinimalScanPageFields(
        documentType,
        page.lines,
        rawText,
      );
      logDocumentProcess('page_results_stage', {
        stage: 'parseMinimalScanPageFields',
        pageIndex,
        ms: Date.now() - fieldsStarted,
      });
    } else {
      logDocumentProcess('page_results_stage', {
        stage: 'parseMinimalScanPageFields_skipped',
        pageIndex,
        reason: 'deadline',
      });
    }
    const qualityStarted = Date.now();
    const ocrQuality = reconcileOcrQualityMetadata(
      page.ocrQuality,
      assessOcrQuality(page.lines, rawText, {
        confidenceType:
          page.ocrQuality?.confidenceType === 'heuristic'
            ? 'heuristic'
            : 'unknown',
        recognizedFieldCount: Object.keys(structuredFields).length,
        source: 'local',
      }),
    );
    logDocumentProcess('page_results_stage', {
      stage: 'assessOcrQuality',
      pageIndex,
      ms: Date.now() - qualityStarted,
    });
    const warnings = !rawText ? [PAGE_WARNING_EMPTY_TEXT] : [];
    const result: PageExtractionResult = {
      pageIndex,
      imageUri,
      processingMethod: 'local',
      rawText,
      structuredFields,
      fieldReliability: {},
      ocrQuality,
      warnings,
      completed: true,
      requiresReview: true,
    };
    logDocumentProcess('page_results_stage', {
      stage: 'page_total',
      pageIndex,
      ms: Date.now() - pageStarted,
    });
    const duplicateOf = firstPageByUri.get(imageUri);
    if (duplicateOf !== undefined) {
      return {
        ...result,
        duplicateOf,
        warnings: [...new Set([...result.warnings, PAGE_WARNING_DUPLICATE])],
        requiresReview: true,
      };
    }
    firstPageByUri.set(imageUri, pageIndex);
    return result;
  });
}

/**
 * Adatta l'OCR locale già eseguito dallo scanner. L'indice dell'immagine è
 * l'identità della pagina: ordine e URI duplicati vengono conservati.
 */
export function localSnapshotsToPageResults(
  documentType: DocumentType,
  imageUris: readonly string[],
  pages: readonly LocalPageSnapshot[],
  structurePage?: DocumentPageStructureBuilder
): PageExtractionResult[] {
  const firstPageByUri = new Map<string, number>();
  return imageUris.map((imageUri, pageIndex) => {
    const page = pages[pageIndex];
    if (!page) {
      return failedPageResult(
        pageIndex,
        imageUri,
        'Risultato OCR locale mancante'
      );
    }
    if (page.completed === false || page.error) {
      return failedPageResult(
        pageIndex,
        imageUri,
        page.error || 'Elaborazione OCR locale non completata'
      );
    }
    const result = pageResultFromLocalSnapshot(
      documentType,
      pageIndex,
      imageUri,
      page,
      'local',
      undefined,
      structurePage
    );
    const duplicateOf = firstPageByUri.get(imageUri);
    if (duplicateOf !== undefined) {
      return {
        ...result,
        duplicateOf,
        warnings: [...new Set([...result.warnings, PAGE_WARNING_DUPLICATE])],
        requiresReview: true,
      };
    }
    firstPageByUri.set(imageUri, pageIndex);
    return result;
  });
}

async function localFallbackResult(
  documentType: DocumentType,
  pageIndex: number,
  imageUri: string,
  cloudError: string,
  extractLocalPage: LocalDocumentPageExtractor,
  structurePage?: DocumentPageStructureBuilder
): Promise<PageExtractionResult> {
  try {
    const local = await extractLocalPage(imageUri);
    const rawText = meaningfulText(local.lines, local.text);
    if (!rawText && local.lines.length === 0) {
      return failedPageResult(
        pageIndex,
        imageUri,
        `${cloudError}; fallback locale senza testo`
      );
    }
    return pageResultFromLocalSnapshot(
      documentType,
      pageIndex,
      imageUri,
      {
        lines: local.lines,
        rawText,
        ...(local.quality ? { ocrQuality: local.quality } : {}),
      },
      'local_fallback',
      cloudError,
      structurePage
    );
  } catch (error) {
    const localError = error instanceof Error ? error.message : String(error);
    return failedPageResult(
      pageIndex,
      imageUri,
      `${cloudError}; fallback locale fallito: ${localError}`
    );
  }
}

/**
 * Una sola chiamata cloud per pagina, già autorizzata dal chiamante. Un errore
 * cloud passa al solo OCR locale; le altre pagine continuano indipendentemente.
 */
export async function extractCloudPagesWithLocalFallback(
  documentType: DocumentType,
  imageUris: readonly string[],
  extractCloudPage: CloudDocumentPageExtractor,
  extractLocalPage: LocalDocumentPageExtractor,
  structurePage?: DocumentPageStructureBuilder,
  options: {
    cloudTimeoutMs?: number;
    /**
     * Supporto AI esplicito: un errore cloud non deve essere mascherato dal
     * fallback locale e non deve far attendere inutilmente le pagine seguenti.
     * Default false per mantenere invariati gli altri workflow.
     */
    abortOnCloudError?: boolean;
  } = {}
): Promise<CloudPagesExtractionOutcome> {
  const results: PageExtractionResult[] = [];
  const firstResultByUri = new Map<string, PageExtractionResult>();
  const cloudPageLimitExceeded =
    imageUris.length > MAX_CLOUD_DOCUMENT_PAGES;

  for (let pageIndex = 0; pageIndex < imageUris.length; pageIndex += 1) {
    const imageUri = imageUris[pageIndex];
    const duplicateSource = firstResultByUri.get(imageUri);
    if (duplicateSource) {
      results.push({
        ...duplicateSource,
        pageIndex,
        imageUri,
        duplicateOf: duplicateSource.pageIndex,
        warnings: [
          ...new Set([
            ...duplicateSource.warnings,
            PAGE_WARNING_DUPLICATE,
          ]),
        ],
        requiresReview: true,
      });
      continue;
    }

    let cloudOutcome: unknown;
    if (cloudPageLimitExceeded) {
      cloudOutcome = {
        status: 'error',
        message: `Limite cloud di ${MAX_CLOUD_DOCUMENT_PAGES} pagine superato`,
      };
    } else {
      try {
        const timeoutMs =
          typeof options.cloudTimeoutMs === 'number' &&
          Number.isFinite(options.cloudTimeoutMs) &&
          options.cloudTimeoutMs > 0
            ? options.cloudTimeoutMs
            : DOCUMENT_CLOUD_PAGE_TIMEOUT_MS;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          cloudOutcome = await Promise.race([
            extractCloudPage(imageUri, pageIndex, imageUris.length),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    new Error(`Timeout cloud dopo ${timeoutMs} ms`)
                  ),
                timeoutMs
              );
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      } catch (error) {
        cloudOutcome = {
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const outcomeRecord =
      cloudOutcome &&
      typeof cloudOutcome === 'object' &&
      !Array.isArray(cloudOutcome)
        ? (cloudOutcome as Record<string, unknown>)
        : null;
    const cloudStatus = outcomeRecord?.status;

    if (cloudStatus === 'not_configured') {
      return { status: 'not_configured', results };
    }
    if (cloudStatus === 'credits_exhausted' && options.abortOnCloudError) {
      return {
        status: 'credits_exhausted',
        results,
        failedPageIndex: pageIndex,
      };
    }
    if (cloudStatus === 'error' && options.abortOnCloudError) {
      return {
        status: 'error',
        results,
        message:
          typeof outcomeRecord?.message === 'string' && outcomeRecord.message.trim()
            ? outcomeRecord.message
            : 'Impossibile contattare il servizio AI',
        failedPageIndex: pageIndex,
        reason: 'provider_unavailable',
      };
    }

    let cloudConversionError: string | null = null;
    if (cloudStatus === 'ok') {
      try {
        const normalized = normalizeGeminiDocumentExtract(
          outcomeRecord?.extract
        );
        if (normalized?.rawText) {
          const pageResult = pageResultFromCloudExtract(
            pageIndex,
            imageUri,
            normalized
          );
          // Una risposta provider OK non diventa un errore di connessione solo
          // perché alcuni campi richiedono revisione. La reliability rimane nel
          // PageExtractionResult e viene gestita dalla review ibrida.
          if (
            Object.keys(pageResult.structuredFields).length > 0 ||
            !!pageResult.aiStructured
          ) {
            results.push(pageResult);
            firstResultByUri.set(imageUri, pageResult);
            continue;
          }
          cloudConversionError = 'Cloud senza campi strutturati utilizzabili';
        } else {
          cloudConversionError = normalized
            ? 'Cloud senza testo leggibile'
            : 'Payload cloud non valido';
        }
      } catch (error) {
        cloudConversionError =
          error instanceof Error ? error.message : String(error);
      }
    }

    const cloudError =
      cloudStatus === 'error' && typeof outcomeRecord?.message === 'string'
        ? outcomeRecord.message
        : cloudConversionError ?? 'Payload cloud non valido';

    if (cloudConversionError && options.abortOnCloudError) {
      return {
        status: 'error',
        results,
        message: cloudConversionError,
        failedPageIndex: pageIndex,
        reason: 'invalid_response',
      };
    }

    const pageResult = await localFallbackResult(
      documentType,
      pageIndex,
      imageUri,
      cloudError,
      extractLocalPage,
      structurePage
    );
    results.push(pageResult);
    firstResultByUri.set(imageUri, pageResult);
  }

  return { status: 'ok', results };
}

export interface PageExtractionAggregate {
  rawText: string;
  structuredFields: DocumentPageStructuredFields;
}

/**
 * Aggregazione minima della 2A: impedisce di perdere le pagine e mantiene il
 * comportamento precedente (testi/stringhe iniziali, importi finali).
 * Provenienza, conflitti e motivi di selezione appartengono alla Fase 2B.
 */
export function aggregatePageExtractionResults(
  results: readonly PageExtractionResult[]
): PageExtractionAggregate {
  const ordered = [...results].sort((a, b) => a.pageIndex - b.pageIndex);
  const fields: DocumentPageStructuredFields = {};
  const items: DocumentPageItem[] = [];
  const extractedFields: Record<string, string> = {};
  const seenImageUris = new Set<string>();
  const rawTexts: string[] = [];

  for (const result of ordered) {
    if (
      result.duplicateOf !== undefined ||
      seenImageUris.has(result.imageUri)
    ) {
      continue;
    }
    seenImageUris.add(result.imageUri);
    const rawText = result.rawText.trim();
    if (rawText) rawTexts.push(rawText);
    const page = result.structuredFields;
    if (!fields.documentNumber && page.documentNumber) {
      fields.documentNumber = page.documentNumber;
    }
    if (!fields.customerName && page.customerName) {
      fields.customerName = page.customerName;
    }
    if (!fields.date && page.date) fields.date = page.date;
    if (!fields.vatNumber && page.vatNumber) fields.vatNumber = page.vatNumber;
    if (page.subtotal !== undefined) fields.subtotal = page.subtotal;
    if (page.vatAmount !== undefined) fields.vatAmount = page.vatAmount;
    if (page.total !== undefined) fields.total = page.total;
    if (page.items) items.push(...page.items);
    if (page.extractedFields) Object.assign(extractedFields, page.extractedFields);
  }

  if (items.length > 0) fields.items = items;
  if (Object.keys(extractedFields).length > 0) {
    fields.extractedFields = extractedFields;
  }

  return {
    rawText: rawTexts.join('\n\n'),
    structuredFields: fields,
  };
}

/**
 * DTO di compatibilità per il builder preesistente. I placeholder restano
 * confinati a questo confine legacy e non vengono salvati come evidenza nelle
 * singole pagine.
 */
export function aggregateToGeminiExtract(
  aggregate: PageExtractionAggregate
): GeminiDocumentExtract {
  const fields = aggregate.structuredFields;
  const items = (fields.items ?? [])
    .filter(
      (
        item
      ): item is Required<
        Pick<
          DocumentPageItem,
          'description' | 'quantity' | 'unitPrice' | 'total'
        >
      > =>
        !!item.description &&
        item.quantity !== undefined &&
        item.unitPrice !== undefined &&
        item.total !== undefined
    )
    .map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
    }));
  return {
    rawText: aggregate.rawText,
    ...(fields.documentNumber !== undefined
      ? { documentNumber: fields.documentNumber }
      : {}),
    ...(fields.customerName !== undefined
      ? { customerName: fields.customerName }
      : {}),
    ...(fields.date !== undefined ? { date: fields.date } : {}),
    ...(fields.subtotal !== undefined ? { subtotal: fields.subtotal } : {}),
    ...(fields.vatAmount !== undefined
      ? { vatAmount: fields.vatAmount }
      : {}),
    ...(fields.total !== undefined ? { total: fields.total } : {}),
    ...(items.length > 0 ? { items } : {}),
  };
}

/**
 * Riallinea i riferimenti diagnostici agli asset finali usando l'indice
 * stabile della pagina. È pura e fallisce prima del commit se il contratto è
 * incoerente, così la saga può compensare normalmente.
 */
export function alignPageExtractionImageUris(
  results: readonly PageExtractionResult[],
  finalImageUris: readonly string[]
): PageExtractionResult[] {
  const seenPageIndexes = new Set<number>();
  return results.map((result) => {
    if (
      !Number.isSafeInteger(result.pageIndex) ||
      result.pageIndex < 0 ||
      seenPageIndexes.has(result.pageIndex)
    ) {
      throw new Error('Indice risultato pagina non valido o duplicato');
    }
    seenPageIndexes.add(result.pageIndex);
    const imageUri = finalImageUris[result.pageIndex];
    if (!imageUri?.trim()) {
      throw new Error('Asset finale mancante per il risultato pagina');
    }
    return { ...result, imageUri };
  });
}

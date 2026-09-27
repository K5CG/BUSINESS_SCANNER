import type {
  DocumentPageItem,
  DocumentPageStructuredFields,
  PageExtractionResult,
  PageProcessingMethod,
} from './document-page-extraction';
import {
  documentFieldAlternative,
  evaluateDocumentField,
  isApplicableDocumentField,
  validateDocumentAmount,
  validateStrictDocumentDate,
  type DocumentFieldConfidenceType,
  type DocumentFieldReliability,
  type DocumentFieldReliabilityMap,
  type DocumentFieldSource,
  type DocumentFieldValidationStatus,
} from './document-field-reliability';

export type DocumentScalarFieldKey =
  | 'documentNumber'
  | 'customerName'
  | 'date'
  | 'vatNumber'
  | 'subtotal'
  | 'vatAmount'
  | 'total'
  | 'currency';

export type DocumentMergeFieldKey = DocumentScalarFieldKey | 'items';

export type DocumentFieldValidation =
  | 'structural'
  | 'unverified'
  | 'invalid';

export type DocumentFieldSelectionReason =
  | 'single_candidate'
  | 'same_value_repeated'
  | 'more_complete_value'
  | 'stronger_validation'
  | 'higher_reported_confidence'
  | 'deterministic_conflict_tiebreak'
  | 'page_group_preserved';

export type DocumentAppliedFieldReason =
  | DocumentFieldSelectionReason
  | 'preserved_conflict'
  | 'preserved_absent'
  | 'preserved_deferred_validation'
  | 'legacy_date_deferred_validation'
  | 'preserved_user_value'
  | 'invalid_or_missing_not_applied'
  | 'user_cleared_value';

export interface DocumentFieldCandidate {
  field: DocumentScalarFieldKey;
  value: string | number;
  normalizedValue: string;
  sourcePageIndex: number;
  sourceMethod: PageProcessingMethod;
  confidence?: number;
  confidenceType: DocumentFieldConfidenceType;
  rawValue?: unknown;
  source: DocumentFieldSource;
  validationStatus: DocumentFieldValidationStatus;
  validationReasons: string[];
  requiresReview: boolean;
  validation: DocumentFieldValidation;
}

export interface DocumentFieldConflict {
  field: DocumentScalarFieldKey;
  reason: 'incompatible_values';
  selectedNormalizedValue: string;
  candidates: DocumentFieldCandidate[];
}

export interface MergedDocumentField {
  field: DocumentScalarFieldKey;
  value: string | number;
  sourcePageIndex: number;
  sourceMethod: PageProcessingMethod;
  confidence?: number;
  confidenceType: DocumentFieldConfidenceType;
  rawValue?: unknown;
  source: DocumentFieldSource;
  validationStatus: DocumentFieldValidationStatus;
  validationReasons: string[];
  requiresReview: boolean;
  alternatives: ReturnType<typeof documentFieldAlternative>[];
  validation: DocumentFieldValidation;
  reason: DocumentFieldSelectionReason;
  conflict?: DocumentFieldConflict;
}

export interface MergedDocumentItemGroup {
  field: 'items';
  value: DocumentPageItem[];
  sourcePageIndex: number;
  sourceMethod: PageProcessingMethod;
  confidence?: number;
  validation: DocumentFieldValidation;
  reason: 'page_group_preserved';
}

export interface MergedDocumentExtractedFieldGroup {
  field: 'extractedFields';
  value: Record<string, string>;
  sourcePageIndex: number;
  sourceMethod: PageProcessingMethod;
  validation: 'unverified';
  reason: 'page_group_preserved';
}

export interface AppliedDocumentField {
  field: DocumentScalarFieldKey;
  value?: string | number;
  valueState?: 'absent';
  source: 'page' | 'existing_record' | 'legacy_placeholder' | 'user';
  sourcePageIndex?: number;
  sourceMethod?: PageProcessingMethod;
  confidence?: number;
  confidenceType?: DocumentFieldConfidenceType;
  rawValue?: unknown;
  validationStatus?: DocumentFieldValidationStatus;
  validationReasons?: string[];
  requiresReview?: boolean;
  alternatives?: ReturnType<typeof documentFieldAlternative>[];
  conflict?: boolean;
  validation: DocumentFieldValidation;
  reason: DocumentAppliedFieldReason;
}

export interface DocumentItemApplication {
  source: 'page_groups' | 'existing_record' | 'none';
  reason:
    | 'complete_groups_applied'
    | 'preserved_conflict'
    | 'preserved_equivalent'
    | 'parser_items_preserved_incomplete_groups'
    | 'preserved_incomplete'
    | 'preserved_absent'
    | 'incomplete_groups_excluded';
  conflict?: {
    reason: 'semantic_mismatch';
    currentItems: DocumentPageItem[];
    proposedItems: DocumentPageItem[];
    proposalSources: Array<{
      sourcePageIndex: number;
      sourceMethod: PageProcessingMethod;
      confidence?: number;
      validation: DocumentFieldValidation;
      reason: 'page_group_preserved';
    }>;
  };
}

export interface DocumentExtractedFieldsApplication {
  source:
    | 'page_groups'
    | 'existing_record_and_page_groups'
    | 'existing_record'
    | 'none';
  reason:
    | 'namespaced_groups_applied'
    | 'merged_namespaced_preserving_existing'
    | 'preserved_absent';
  conflicts?: Array<{
    key: string;
    reason: 'different_values';
    currentValue: string;
    candidate: {
      value: string;
      sourcePageIndex: number;
      sourceMethod: PageProcessingMethod;
      validation: 'unverified';
      reason: 'page_group_preserved';
    };
  }>;
}

export interface DocumentFieldMergeResult {
  fields: Partial<Record<DocumentScalarFieldKey, MergedDocumentField>>;
  fieldReliability: DocumentFieldReliabilityMap;
  itemGroups: MergedDocumentItemGroup[];
  extractedFieldGroups: MergedDocumentExtractedFieldGroup[];
  appliedFields?: Partial<
    Record<DocumentScalarFieldKey, AppliedDocumentField>
  >;
  itemApplication?: DocumentItemApplication;
  extractedFieldsApplication?: DocumentExtractedFieldsApplication;
  conflicts: DocumentFieldConflict[];
  rawText: string;
  includedPageIndexes: number[];
  pageIntegrity: {
    complete: boolean;
    issuePageIndexes: number[];
  };
  requiresReview: boolean;
}

const SCALAR_FIELDS: readonly DocumentScalarFieldKey[] = [
  'documentNumber',
  'customerName',
  'date',
  'vatNumber',
  'subtotal',
  'vatAmount',
  'total',
  'currency',
];

const AMOUNT_FIELDS = new Set<DocumentScalarFieldKey>([
  'subtotal',
  'vatAmount',
  'total',
]);

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function canonicalPages(
  pages: readonly PageExtractionResult[]
): PageExtractionResult[] {
  return [...pages].sort(
    (a, b) =>
      a.pageIndex - b.pageIndex ||
      a.imageUri.localeCompare(b.imageUri) ||
      a.processingMethod.localeCompare(b.processingMethod) ||
      a.rawText.localeCompare(b.rawText) ||
      stableSerialize(a.structuredFields).localeCompare(
        stableSerialize(b.structuredFields)
      )
  );
}

function evidencePages(
  pages: readonly PageExtractionResult[]
): PageExtractionResult[] {
  return canonicalPages(pages).filter(
    (page) => page.duplicateOf === undefined
  );
}

function assertValidPageIndexes(
  pages: readonly PageExtractionResult[]
): void {
  const indexes = new Set<number>();
  const pagesByIndex = new Map<number, PageExtractionResult>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page.pageIndex) || page.pageIndex < 0) {
      throw new Error(
        `Indice pagina non valido: ${String(page.pageIndex)}`
      );
    }
    if (indexes.has(page.pageIndex)) {
      throw new Error(`Indice pagina duplicato: ${page.pageIndex}`);
    }
    indexes.add(page.pageIndex);
    pagesByIndex.set(page.pageIndex, page);
  }

  const canonical = canonicalPages(pages);
  const firstPageByUri = new Map<string, PageExtractionResult>();
  for (const page of canonical) {
    const priorWithSameUri = firstPageByUri.get(page.imageUri);
    if (page.duplicateOf === undefined) {
      if (priorWithSameUri) {
        throw new Error(
          `Pagina duplicata senza riferimento canonico: ${page.pageIndex}`
        );
      }
      firstPageByUri.set(page.imageUri, page);
      continue;
    }
    const source = pagesByIndex.get(page.duplicateOf);
    if (
      !Number.isSafeInteger(page.duplicateOf) ||
      page.duplicateOf < 0 ||
      page.duplicateOf >= page.pageIndex ||
      !source ||
      source.duplicateOf !== undefined ||
      source.imageUri !== page.imageUri ||
      priorWithSameUri?.pageIndex !== source.pageIndex
    ) {
      throw new Error(
        `Indice pagina duplicata non valido: ${String(page.duplicateOf)}`
      );
    }
  }
}

/**
 * Normalizza importi IT/US senza introdurre un valore quando il testo non è
 * interpretabile. Zero resta assenza perché nel DTO cloud è un placeholder.
 */
export function parseDocumentAmount(value: unknown): number | undefined {
  const result = validateDocumentAmount(value);
  return result.validationStatus === 'valid' ? result.value : undefined;
}

function normalizedString(
  field: DocumentScalarFieldKey,
  value: unknown
): { value: string; normalized: string } | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;

  switch (field) {
    case 'documentNumber':
      return {
        value: cleaned,
        normalized: cleaned.toUpperCase().replace(/\s+/g, ''),
      };
    case 'vatNumber':
      return {
        value: cleaned,
        normalized: cleaned.toUpperCase().replace(/[^A-Z0-9]/g, ''),
      };
    case 'currency': {
      const currency = cleaned.toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return null;
      return { value: currency, normalized: currency };
    }
    case 'customerName':
      return {
        value: cleaned,
        normalized: cleaned
          .toLocaleLowerCase('it-IT')
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim(),
      };
    case 'date':
      // La validazione semantica delle date resta rinviata alla Fase 3.
      return {
        value: cleaned,
        normalized: cleaned.toLocaleLowerCase('it-IT'),
      };
    default:
      return { value: cleaned, normalized: cleaned };
  }
}

function legacyValidation(
  status: DocumentFieldValidationStatus
): DocumentFieldValidation {
  if (status === 'valid') return 'structural';
  if (status === 'unverified') return 'unverified';
  return 'invalid';
}

function reportedConfidence(
  page: PageExtractionResult,
  field: DocumentMergeFieldKey
): number | undefined {
  const confidence = page.fieldConfidence?.[field];
  return typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
    ? confidence
    : undefined;
}

function fieldCandidate(
  page: PageExtractionResult,
  field: DocumentScalarFieldKey
): DocumentFieldCandidate | null {
  const rawValue = page.structuredFields[field];
  const confidence = reportedConfidence(page, field);
  const evidence =
    page.fieldReliability?.[field] ??
    evaluateDocumentField(field, rawValue, {
      source:
        page.processingMethod === 'cloud' ? 'cloud_ai' : 'local_ocr',
      pageIndex: page.pageIndex,
      ...(confidence !== undefined ? { confidence } : {}),
      confidenceType:
        confidence !== undefined
          ? 'measured'
          : page.processingMethod === 'cloud'
            ? 'unknown'
            : 'heuristic',
    });
  if (!isApplicableDocumentField(evidence)) return null;

  if (AMOUNT_FIELDS.has(field)) {
    if (typeof evidence.value !== 'number') return null;
    return {
      field,
      value: evidence.value,
      normalizedValue: evidence.value.toFixed(6),
      sourcePageIndex: page.pageIndex,
      sourceMethod: page.processingMethod,
      ...(evidence.confidence !== undefined
        ? { confidence: evidence.confidence }
        : {}),
      confidenceType: evidence.confidenceType,
      ...(Object.prototype.hasOwnProperty.call(evidence, 'rawValue')
        ? { rawValue: evidence.rawValue }
        : {}),
      source: evidence.source,
      validationStatus: evidence.validationStatus,
      validationReasons: [...evidence.validationReasons],
      requiresReview: evidence.requiresReview,
      validation: legacyValidation(evidence.validationStatus),
    };
  }

  const normalized = normalizedString(field, evidence.value);
  if (!normalized) return null;
  return {
    field,
    value: normalized.value,
    normalizedValue: normalized.normalized,
    sourcePageIndex: page.pageIndex,
    sourceMethod: page.processingMethod,
    ...(evidence.confidence !== undefined
      ? { confidence: evidence.confidence }
      : {}),
    confidenceType: evidence.confidenceType,
    ...(Object.prototype.hasOwnProperty.call(evidence, 'rawValue')
      ? { rawValue: evidence.rawValue }
      : {}),
    source: evidence.source,
    validationStatus: evidence.validationStatus,
    validationReasons: [...evidence.validationReasons],
    requiresReview: evidence.requiresReview,
    validation: legacyValidation(evidence.validationStatus),
  };
}

function validationRank(value: DocumentFieldValidation): number {
  if (value === 'structural') return 2;
  if (value === 'unverified') return 1;
  return 0;
}

function valueCompleteness(candidate: DocumentFieldCandidate): number {
  if (typeof candidate.value === 'number') return 1;
  return candidate.normalizedValue.replace(/[^A-Z0-9\p{L}\p{N}]/giu, '')
    .length;
}

function compareCandidateQuality(
  a: DocumentFieldCandidate,
  b: DocumentFieldCandidate
): number {
  const validation =
    validationRank(b.validation) - validationRank(a.validation);
  if (validation !== 0) return validation;

  if (
    a.confidence !== undefined &&
    b.confidence !== undefined &&
    a.confidence !== b.confidence
  ) {
    return b.confidence - a.confidence;
  }

  const completeness = valueCompleteness(b) - valueCompleteness(a);
  if (completeness !== 0) return completeness;

  return (
    a.normalizedValue.localeCompare(b.normalizedValue) ||
    a.sourceMethod.localeCompare(b.sourceMethod) ||
    a.sourcePageIndex - b.sourcePageIndex
  );
}

function compareCandidateTrace(
  a: DocumentFieldCandidate,
  b: DocumentFieldCandidate
): number {
  return (
    a.normalizedValue.localeCompare(b.normalizedValue) ||
    a.sourcePageIndex - b.sourcePageIndex ||
    a.sourceMethod.localeCompare(b.sourceMethod)
  );
}

function amountValuesCompatible(
  a: DocumentFieldCandidate,
  b: DocumentFieldCandidate
): boolean {
  return (
    typeof a.value === 'number' &&
    typeof b.value === 'number' &&
    Math.abs(a.value - b.value) < 0.005
  );
}

function valuesEquivalent(
  a: DocumentFieldCandidate,
  b: DocumentFieldCandidate
): boolean {
  if (typeof a.value === 'number' || typeof b.value === 'number') {
    return amountValuesCompatible(a, b);
  }
  return a.normalizedValue === b.normalizedValue;
}

function isCompletionChainShape(
  field: DocumentScalarFieldKey,
  candidates: readonly DocumentFieldCandidate[]
): boolean {
  if (
    field !== 'documentNumber' &&
    field !== 'customerName'
  ) {
    return false;
  }
  if (
    candidates.length < 2 ||
    candidates.some((candidate) => typeof candidate.value !== 'string')
  ) {
    return false;
  }
  const ordered = [...new Set(candidates.map((candidate) => candidate.normalizedValue))]
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return ordered.every(
    (value, index) =>
      index === 0 ||
      value.startsWith(ordered[index - 1]) ||
      ordered[index - 1].startsWith(value)
  );
}

function isTrustedCompletionChain(
  field: DocumentScalarFieldKey,
  candidates: readonly DocumentFieldCandidate[],
  selected: DocumentFieldCandidate
): boolean {
  if (!isCompletionChainShape(field, candidates)) return false;

  const distinctValues = [
    ...new Set(
      candidates.map((candidate) => candidate.normalizedValue)
    ),
  ].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const longest = distinctValues[distinctValues.length - 1];
  if (!longest || selected.normalizedValue !== longest) return false;

  return candidates
    .filter(
      (candidate) => candidate.normalizedValue !== longest
    )
    .every((shorter) => {
      const cloudToLocal =
        shorter.sourceMethod === 'cloud' &&
        (selected.sourceMethod === 'local' ||
          selected.sourceMethod === 'local_fallback');
      const explicitlyHigherQuality =
        selected.confidence !== undefined &&
        shorter.confidence !== undefined &&
        selected.confidence > shorter.confidence;
      return cloudToLocal || explicitlyHigherQuality;
    });
}

function selectionReason(
  field: DocumentScalarFieldKey,
  candidates: readonly DocumentFieldCandidate[],
  selected: DocumentFieldCandidate,
  conflict: boolean,
  trustedCompletion: boolean
): DocumentFieldSelectionReason {
  if (candidates.length === 1) return 'single_candidate';
  if (candidates.every((candidate) => valuesEquivalent(candidate, selected))) {
    return 'same_value_repeated';
  }
  if (trustedCompletion) return 'more_complete_value';

  const others = candidates.filter((candidate) => candidate !== selected);
  if (
    others.every(
      (candidate) =>
        validationRank(selected.validation) >
        validationRank(candidate.validation)
    )
  ) {
    return 'stronger_validation';
  }
  if (
    selected.confidence !== undefined &&
    others.every(
      (candidate) =>
        candidate.confidence !== undefined &&
        selected.confidence! > candidate.confidence
    )
  ) {
    return 'higher_reported_confidence';
  }
  return conflict
    ? 'deterministic_conflict_tiebreak'
    : 'same_value_repeated';
}

function mergeScalarField(
  field: DocumentScalarFieldKey,
  pages: readonly PageExtractionResult[]
): { selected?: MergedDocumentField; conflict?: DocumentFieldConflict } {
  const candidates = pages
    .map((page) => fieldCandidate(page, field))
    .filter((candidate): candidate is DocumentFieldCandidate => !!candidate);
  if (candidates.length === 0) return {};

  const selected = [...candidates].sort(compareCandidateQuality)[0];
  const equivalent = candidates.every((candidate) =>
    valuesEquivalent(candidate, selected)
  );
  const completionChain =
    !equivalent &&
    isTrustedCompletionChain(field, candidates, selected);
  const hasConflict = !equivalent && !completionChain;
  const conflict = hasConflict
    ? {
        field,
        reason: 'incompatible_values' as const,
        selectedNormalizedValue: selected.normalizedValue,
        candidates: [...candidates].sort(compareCandidateTrace),
      }
    : undefined;
  const alternatives = [...candidates]
    .sort(compareCandidateTrace)
    .map((candidate) => ({
      value: candidate.value,
      ...(Object.prototype.hasOwnProperty.call(candidate, 'rawValue')
        ? { rawValue: candidate.rawValue }
        : {}),
      source: candidate.source,
      pageIndex: candidate.sourcePageIndex,
      ...(candidate.confidence !== undefined
        ? { confidence: candidate.confidence }
        : {}),
      confidenceType: candidate.confidenceType,
      validationStatus: candidate.validationStatus,
      validationReasons: [...candidate.validationReasons],
    }));

  return {
    selected: {
      field,
      value: selected.value,
      sourcePageIndex: selected.sourcePageIndex,
      sourceMethod: selected.sourceMethod,
      ...(selected.confidence !== undefined
        ? { confidence: selected.confidence }
        : {}),
      confidenceType: selected.confidenceType,
      ...(Object.prototype.hasOwnProperty.call(selected, 'rawValue')
        ? { rawValue: selected.rawValue }
        : {}),
      source: candidates.length > 1 ? 'merged' : selected.source,
      validationStatus: selected.validationStatus,
      validationReasons: [...selected.validationReasons],
      requiresReview: hasConflict || selected.requiresReview,
      alternatives,
      validation: selected.validation,
      reason: selectionReason(
        field,
        candidates,
        selected,
        hasConflict,
        completionChain
      ),
      ...(conflict ? { conflict } : {}),
    },
    ...(conflict ? { conflict } : {}),
  };
}

function sparseItem(item: DocumentPageItem): DocumentPageItem | null {
  const description =
    typeof item.description === 'string' && item.description.trim()
      ? item.description.trim()
      : undefined;
  const quantity = parseDocumentAmount(item.quantity);
  const unitPrice = parseDocumentAmount(item.unitPrice);
  const total = parseDocumentAmount(item.total);
  const vatRate = parseDocumentAmount(item.vatRate);
  const value: DocumentPageItem = {
    ...(description ? { description } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
    ...(unitPrice !== undefined ? { unitPrice } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(vatRate !== undefined ? { vatRate } : {}),
  };
  return Object.keys(value).length > 0 ? value : null;
}

function itemGroups(
  pages: readonly PageExtractionResult[]
): MergedDocumentItemGroup[] {
  return pages.flatMap((page) => {
    const items = (page.structuredFields.items ?? [])
      .map(sparseItem)
      .filter((item): item is DocumentPageItem => !!item);
    if (items.length === 0) return [];
    const complete = items.every(
      (item) =>
        !!item.description &&
        item.quantity !== undefined &&
        item.unitPrice !== undefined &&
        item.total !== undefined
    );
    const confidence = reportedConfidence(page, 'items');
    return [
      {
        field: 'items' as const,
        value: items,
        sourcePageIndex: page.pageIndex,
        sourceMethod: page.processingMethod,
        ...(confidence !== undefined ? { confidence } : {}),
        validation: complete ? 'structural' : 'unverified',
        reason: 'page_group_preserved' as const,
      },
    ];
  });
}

function extractedFieldGroups(
  pages: readonly PageExtractionResult[]
): MergedDocumentExtractedFieldGroup[] {
  return pages.flatMap((page) => {
    const extractedFields = page.structuredFields.extractedFields;
    if (!extractedFields) return [];
    const value = Object.fromEntries(
      Object.entries(extractedFields)
        .map(([key, rawValue]) => [key.trim(), rawValue.trim()] as const)
        .filter(([key, rawValue]) => !!key && !!rawValue)
        .sort(([left], [right]) => left.localeCompare(right))
    );
    if (Object.keys(value).length === 0) return [];
    return [
      {
        field: 'extractedFields' as const,
        value,
        sourcePageIndex: page.pageIndex,
        sourceMethod: page.processingMethod,
        validation: 'unverified' as const,
        reason: 'page_group_preserved' as const,
      },
    ];
  });
}

function namespacedExtractedFields(
  groups: readonly MergedDocumentExtractedFieldGroup[]
): Record<string, string> {
  return Object.fromEntries(
    groups.flatMap((group) =>
      Object.entries(group.value).map(([key, value]) => [
        `page_${group.sourcePageIndex + 1}_${key}`,
        value,
      ])
    )
  );
}

function rawTextWithPageSeparators(
  pages: readonly PageExtractionResult[]
): string {
  return pages
    .map((page) => {
      const header = `=== PAGE ${page.pageIndex + 1} | ${page.processingMethod} ===`;
      const duplicateMarker =
        page.duplicateOf !== undefined
          ? ` | duplicate_of_page_${page.duplicateOf + 1}`
          : '';
      const markedHeader = duplicateMarker
        ? `=== PAGE ${page.pageIndex + 1} | ${page.processingMethod}${duplicateMarker} ===`
        : header;
      const rawText = page.rawText.trim();
      return rawText ? `${markedHeader}\n${rawText}` : markedHeader;
    })
    .join('\n\n');
}

function pageReliability(
  page: PageExtractionResult,
  field: DocumentScalarFieldKey
): DocumentFieldReliability {
  const existing = page.fieldReliability?.[field];
  if (existing) return existing;
  const confidence = reportedConfidence(page, field);
  return evaluateDocumentField(field, page.structuredFields[field], {
    source: page.processingMethod === 'cloud' ? 'cloud_ai' : 'local_ocr',
    pageIndex: page.pageIndex,
    ...(confidence !== undefined ? { confidence } : {}),
    confidenceType:
      confidence !== undefined
        ? 'measured'
        : page.processingMethod === 'cloud'
          ? 'unknown'
          : 'heuristic',
  });
}

function mergedScalarReliability(
  field: DocumentScalarFieldKey,
  pages: readonly PageExtractionResult[],
  merged: MergedDocumentField | undefined
): DocumentFieldReliability {
  const evidence = pages
    .map((page) => pageReliability(page, field))
    .sort(
      (left, right) =>
        (left.pageIndex ?? Number.MAX_SAFE_INTEGER) -
        (right.pageIndex ?? Number.MAX_SAFE_INTEGER) ||
        left.source.localeCompare(right.source)
    );
  if (merged) {
    const alternatives =
      merged.alternatives.length > 1 ? merged.alternatives : [];
    return {
      ...(!merged.conflict ? { value: merged.value } : {}),
      ...(Object.prototype.hasOwnProperty.call(merged, 'rawValue')
        ? { rawValue: merged.rawValue }
        : {}),
      source: merged.source,
      pageIndex: merged.sourcePageIndex,
      ...(merged.confidence !== undefined
        ? { confidence: merged.confidence }
        : {}),
      confidenceType: merged.confidenceType,
      validationStatus: merged.validationStatus,
      validationReasons: [
        ...merged.validationReasons,
        ...(merged.conflict ? ['incompatible_valid_values'] : []),
      ],
      requiresReview: merged.requiresReview || !!merged.conflict,
      alternatives,
      conflict: !!merged.conflict,
    };
  }

  const selected =
    evidence.find(
      (candidate) => candidate.validationStatus === 'invalid'
    ) ??
    evidence.find(
      (candidate) => candidate.validationStatus === 'ambiguous'
    ) ??
    evidence[0] ??
    evaluateDocumentField(field, undefined, {
      source: 'merged',
      confidenceType: 'unknown',
    });
  return {
    ...selected,
    alternatives: evidence
      .filter(
        (candidate) =>
          candidate.validationStatus !== 'missing' ||
          candidate.rawValue !== undefined
      )
      .map(documentFieldAlternative),
    conflict: false,
  };
}

function groupedReliability(
  field: 'items' | 'extractedFields',
  pages: readonly PageExtractionResult[],
  value: unknown,
  structurallyValid: boolean
): DocumentFieldReliability {
  const pagesWithField = pages.filter((page) =>
    Object.prototype.hasOwnProperty.call(page.structuredFields, field)
  );
  if (pagesWithField.length === 0) {
    const first =
      pages[0]?.fieldReliability?.[field] ??
      evaluateDocumentField(field, undefined, {
        source: 'merged',
        confidenceType: 'unknown',
      });
    return { ...first, alternatives: [], conflict: false };
  }
  const evidence = pagesWithField.map(
    (page) =>
      page.fieldReliability?.[field] ??
      evaluateDocumentField(
        field,
        page.structuredFields[field],
        {
          source:
            page.processingMethod === 'cloud'
              ? 'cloud_ai'
              : 'local_ocr',
          pageIndex: page.pageIndex,
          confidenceType:
            page.processingMethod === 'cloud'
              ? 'unknown'
              : 'heuristic',
        }
      )
  );
  const alternatives = evidence.map(documentFieldAlternative);
  const extractedFieldsRemainUnverified = field === 'extractedFields';
  const validationStatus =
    structurallyValid &&
    !extractedFieldsRemainUnverified &&
    evidence.every(
      (candidate) => candidate.validationStatus === 'valid'
    )
      ? 'valid'
      : 'unverified';
  const singleEvidence = evidence.length === 1 ? evidence[0] : undefined;
  return {
    value,
    rawValue: value,
    source: pagesWithField.length > 1 ? 'merged' : alternatives[0].source,
    ...(pagesWithField.length === 1
      ? { pageIndex: pagesWithField[0].pageIndex }
      : {}),
    ...(singleEvidence?.confidence !== undefined
      ? { confidence: singleEvidence.confidence }
      : {}),
    confidenceType: singleEvidence?.confidenceType ?? 'unknown',
    validationStatus,
    validationReasons: [
      ...new Set(
        evidence.flatMap((candidate) => candidate.validationReasons)
      ),
      extractedFieldsRemainUnverified
        ? 'unverified_extracted_fields'
        : structurallyValid
          ? 'complete_page_groups'
          : 'incomplete_page_groups',
    ],
    requiresReview:
      extractedFieldsRemainUnverified ||
      !structurallyValid ||
      evidence.some((candidate) => candidate.requiresReview),
    alternatives,
    conflict: false,
  };
}

export function mergeDocumentPageFields(
  pageResults: readonly PageExtractionResult[]
): DocumentFieldMergeResult {
  assertValidPageIndexes(pageResults);
  const allPages = canonicalPages(pageResults);
  const pages = evidencePages(pageResults);
  const fieldPages = pages.filter(
    (page) => page.processingMethod !== 'failed' && page.completed
  );
  const issuePageIndexes = pages
    .filter(
      (page) =>
        page.processingMethod === 'failed' ||
        !page.completed ||
        page.requiresReview
    )
    .map((page) => page.pageIndex);
  const fields: Partial<
    Record<DocumentScalarFieldKey, MergedDocumentField>
  > = {};
  const conflicts: DocumentFieldConflict[] = [];
  const mergedItemGroups = itemGroups(fieldPages);

  for (const field of SCALAR_FIELDS) {
    const merged = mergeScalarField(field, fieldPages);
    if (merged.selected) fields[field] = merged.selected;
    if (merged.conflict) conflicts.push(merged.conflict);
  }
  const mergedExtractedGroups = extractedFieldGroups(fieldPages);
  const fieldReliability: DocumentFieldReliabilityMap = {};
  for (const field of SCALAR_FIELDS) {
    fieldReliability[field] = mergedScalarReliability(
      field,
      fieldPages,
      fields[field]
    );
  }
  fieldReliability.items = groupedReliability(
    'items',
    fieldPages,
    mergedItemGroups.flatMap((group) => group.value),
    mergedItemGroups.length > 0 &&
      mergedItemGroups.every((group) => group.validation === 'structural')
  );
  fieldReliability.extractedFields = groupedReliability(
    'extractedFields',
    fieldPages,
    namespacedExtractedFields(mergedExtractedGroups),
    mergedExtractedGroups.length > 0
  );

  return {
    fields,
    fieldReliability,
    itemGroups: mergedItemGroups,
    extractedFieldGroups: mergedExtractedGroups,
    conflicts,
    rawText: rawTextWithPageSeparators(allPages),
    includedPageIndexes: pages.map((page) => page.pageIndex),
    pageIntegrity: {
      complete: issuePageIndexes.length === 0,
      issuePageIndexes,
    },
    requiresReview:
      conflicts.length > 0 ||
      Object.values(fieldReliability).some(
        (field) =>
          field?.conflict ||
          field?.validationStatus === 'invalid' ||
          field?.validationStatus === 'ambiguous'
      ) ||
      mergedItemGroups.some(
        (group) => group.validation !== 'structural'
      ) ||
      pageResults.some((page) => page.duplicateOf !== undefined) ||
      pageResults.some((page) => page.requiresReview),
  };
}

export function mergeResultToStructuredFields(
  merge: DocumentFieldMergeResult
): DocumentPageStructuredFields {
  const fieldValue = (
    field: DocumentScalarFieldKey
  ): string | number | undefined => {
    const merged = merge.fields[field];
    const reliability = merge.fieldReliability?.[field];
    return merged &&
      !merged.conflict &&
      (!reliability || isApplicableDocumentField(reliability))
      ? merged.value
      : undefined;
  };
  const documentNumber = fieldValue('documentNumber');
  const customerName = fieldValue('customerName');
  const date = fieldValue('date');
  const vatNumber = fieldValue('vatNumber');
  const subtotal = fieldValue('subtotal');
  const vatAmount = fieldValue('vatAmount');
  const total = fieldValue('total');
  const currency = fieldValue('currency');
  const items = merge.itemGroups.flatMap((group) => group.value);
  const extractedFields = namespacedExtractedFields(
    merge.extractedFieldGroups ?? []
  );

  return {
    ...(typeof documentNumber === 'string' ? { documentNumber } : {}),
    ...(typeof customerName === 'string' ? { customerName } : {}),
    ...(typeof date === 'string' ? { date } : {}),
    ...(typeof vatNumber === 'string' ? { vatNumber } : {}),
    ...(typeof subtotal === 'number' ? { subtotal } : {}),
    ...(typeof vatAmount === 'number' ? { vatAmount } : {}),
    ...(typeof total === 'number' ? { total } : {}),
    ...(typeof currency === 'string' ? { currency } : {}),
    ...(items.length > 0 ? { items } : {}),
    ...(Object.keys(extractedFields).length > 0 ? { extractedFields } : {}),
  };
}

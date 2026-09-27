import type { GeminiDocumentExtract } from './gemini-document-extract';
import type {
  AnyDocument,
  OrderDocument,
  QuoteDocument,
  InvoiceDocument,
} from '../types';
import {
  type DocumentExtractedFieldsApplication,
  type DocumentFieldMergeResult,
  type DocumentItemApplication,
  type DocumentScalarFieldKey,
  type MergedDocumentItemGroup,
} from './document-field-merge';
import {
  documentFieldAlternative,
  evaluateDocumentField,
  isApplicableDocumentField,
  strictDocumentDateToDate,
  validateStrictDocumentDate,
  type DocumentFieldReliability,
  type DocumentFieldReliabilityMap,
} from './document-field-reliability';
import { sanitizeDocumentMonetaryFields } from './document-monetary-guardrails';

export interface ApplyDocumentFieldMergeOptions {
  mode?: 'preserve_existing' | 'new_scan';
  /**
   * Nella review AI, un conflitto conserva il valore già confermato nel
   * record. La proposta resta integralmente visibile in fieldMerge.
   */
  currentDocument?: AnyDocument;
}

function completeItemsFromGroups(
  groups: readonly MergedDocumentItemGroup[]
): NonNullable<GeminiDocumentExtract['items']> {
  return groups
    .filter((group) => group.validation === 'structural')
    .flatMap((group) =>
      group.value.flatMap((item) => {
        if (
          !item.description ||
          item.quantity === undefined ||
          item.unitPrice === undefined ||
          item.total === undefined
        ) {
          return [];
        }
        return [
          {
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: item.total,
          },
        ];
      })
    );
}

function completeDocumentItems(
  groups: readonly MergedDocumentItemGroup[]
): QuoteDocument['items'] {
  return groups
    .filter((group) => group.validation === 'structural')
    .flatMap((group) =>
      group.value.flatMap((item) => {
        if (
          !item.description ||
          item.quantity === undefined ||
          item.unitPrice === undefined ||
          item.total === undefined
        ) {
          return [];
        }
        return [
          {
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            total: item.total,
            ...(typeof item.vatRate === 'number'
              ? { vatRate: item.vatRate }
              : {}),
          },
        ];
      })
    );
}

function normalizedItemDescription(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('it-IT');
}

function itemNumbersEqual(
  left: number | undefined,
  right: number | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    Number.isFinite(left) &&
    Number.isFinite(right) &&
    Math.abs(left - right) < 0.005
  );
}

function itemsSemanticallyEqual(
  currentItems: readonly QuoteDocument['items'][number][],
  proposedItems: readonly QuoteDocument['items'][number][]
): boolean {
  if (currentItems.length !== proposedItems.length) return false;
  return proposedItems.every((proposal, index) => {
    const current = currentItems[index];
    if (!current) return false;
    return (
      normalizedItemDescription(current.description) ===
        normalizedItemDescription(proposal.description) &&
      itemNumbersEqual(current.quantity, proposal.quantity) &&
      itemNumbersEqual(current.unitPrice, proposal.unitPrice) &&
      itemNumbersEqual(current.total, proposal.total) &&
      (proposal.vatRate === undefined ||
        itemNumbersEqual(current.vatRate, proposal.vatRate))
    );
  });
}

function proposalHasLessItemInformation(
  currentItems: readonly QuoteDocument['items'][number][],
  proposedItems: readonly QuoteDocument['items'][number][]
): boolean {
  return proposedItems.some((proposal, index) => {
    const current = currentItems[index];
    return (
      !!current &&
      current.vatRate !== undefined &&
      proposal.vatRate === undefined
    );
  });
}

export function fieldMergeToGeminiExtract(
  merge: DocumentFieldMergeResult
): GeminiDocumentExtract {
  const stringField = (
    key: 'documentNumber' | 'customerName' | 'date'
  ): string | undefined => {
    const value = merge.fields[key]?.value;
    const reliability = merge.fieldReliability?.[key];
    return typeof value === 'string' &&
      !merge.fields[key]?.conflict &&
      (!reliability || isApplicableDocumentField(reliability))
      ? value
      : undefined;
  };
  const numberField = (
    key: 'subtotal' | 'vatAmount' | 'total'
  ): number | undefined => {
    const value = merge.fields[key]?.value;
    const reliability = merge.fieldReliability?.[key];
    return typeof value === 'number' &&
      !merge.fields[key]?.conflict &&
      (!reliability || isApplicableDocumentField(reliability))
      ? value
      : undefined;
  };
  const documentNumber = stringField('documentNumber');
  const customerName = stringField('customerName');
  const date = stringField('date');
  const subtotal = numberField('subtotal');
  const vatAmount = numberField('vatAmount');
  const total = numberField('total');
  const items = completeItemsFromGroups(merge.itemGroups);

  return {
    rawText: merge.rawText,
    ...(documentNumber !== undefined ? { documentNumber } : {}),
    ...(customerName !== undefined ? { customerName } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(subtotal !== undefined ? { subtotal } : {}),
    ...(vatAmount !== undefined ? { vatAmount } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(items.length > 0 ? { items } : {}),
  };
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

function recordDateValue(value: Date | undefined): string | undefined {
  return value ? validateStrictDocumentDate(value).value : undefined;
}

function recordFieldValue(
  document: AnyDocument,
  field: DocumentScalarFieldKey
): string | number | undefined {
  switch (document.type) {
    case 'quote':
      switch (field) {
        case 'documentNumber':
          return document.quoteNumber;
        case 'customerName':
          return document.customerName;
        case 'date':
          return recordDateValue(document.quoteDate);
        case 'vatNumber':
          return document.customerVat;
        case 'subtotal':
          return document.subtotal;
        case 'vatAmount':
          return document.vatAmount;
        case 'total':
          return document.total;
        case 'currency':
          return document.currency;
      }
    case 'order':
      switch (field) {
        case 'documentNumber':
          return document.orderNumber;
        case 'customerName':
          return document.customerName;
        case 'date':
          return recordDateValue(document.orderDate);
        case 'vatNumber':
          return document.customerVat;
        case 'subtotal':
          return document.subtotal;
        case 'vatAmount':
          return document.vatAmount;
        case 'total':
          return document.total;
        case 'currency':
          return document.currency;
      }
    case 'invoice':
      switch (field) {
        case 'documentNumber':
          return document.invoiceNumber;
        case 'customerName':
          return document.customerName;
        case 'date':
          return recordDateValue(document.invoiceDate);
        case 'vatNumber':
          return document.customerVat;
        case 'subtotal':
          return document.subtotal;
        case 'vatAmount':
          return document.vatAmount;
        case 'total':
          return document.total;
        case 'currency':
          return document.currency;
      }
    case 'free_document':
      if (field === 'documentNumber') return document.documentNumber;
      if (field === 'date') return recordDateValue(document.documentDate);
      return undefined;
    case 'business_card':
      return undefined;
  }
}

function sameDocumentType(
  left: AnyDocument | undefined,
  right: AnyDocument
): left is AnyDocument {
  return !!left && left.type === right.type;
}

function sameReliabilityValue(
  left: DocumentFieldReliability,
  right: DocumentFieldReliability
): boolean {
  return JSON.stringify(left.value) === JSON.stringify(right.value);
}

function uniqueAlternatives(
  candidates: ReturnType<typeof documentFieldAlternative>[]
): ReturnType<typeof documentFieldAlternative>[] {
  const identity = (
    candidate: ReturnType<typeof documentFieldAlternative>
  ): string =>
    JSON.stringify({
      source: candidate.source,
      pageIndex: candidate.pageIndex,
      value: candidate.value,
      rawValue: candidate.rawValue,
      validationStatus: candidate.validationStatus,
    });
  return candidates.filter(
    (candidate, index, values) =>
      values.findIndex(
        (value) => identity(value) === identity(candidate)
      ) === index
  );
}

function reliabilityAlternatives(
  reliability: DocumentFieldReliability | undefined
): ReturnType<typeof documentFieldAlternative>[] {
  if (!reliability) return [];
  const primaryIsObservable =
    reliability.value !== undefined ||
    (!reliability.conflict && reliability.rawValue !== undefined);
  return uniqueAlternatives([
    ...(primaryIsObservable
      ? [documentFieldAlternative(reliability)]
      : []),
    ...reliability.alternatives,
  ]);
}

function currentRecordEvidence(
  document: AnyDocument,
  field: DocumentScalarFieldKey
): DocumentFieldReliability {
  const existing = document.fieldReliability?.[field];
  const value = recordFieldValue(document, field);
  const inferred = evaluateDocumentField(field, value, {
    source: 'merged',
    confidenceType: 'unknown',
  });
  if (existing && sameReliabilityValue(existing, inferred)) {
    return existing;
  }
  if (existing) {
    return {
      ...inferred,
      alternatives: uniqueAlternatives([
        ...reliabilityAlternatives(inferred),
        ...reliabilityAlternatives(existing),
      ]),
      conflict: true,
      requiresReview: true,
      validationReasons: [
        ...inferred.validationReasons,
        'stored_value_differs_from_reliability',
      ],
    };
  }
  if (
    value === 0 &&
    (field === 'subtotal' || field === 'vatAmount' || field === 'total')
  ) {
    return {
      ...inferred,
      validationStatus: 'ambiguous',
      validationReasons: ['legacy_zero_without_observed_evidence'],
      requiresReview: true,
    };
  }
  if (
    inferred.validationStatus === 'valid' ||
    inferred.validationStatus === 'unverified'
  ) {
    return {
      ...inferred,
      validationStatus: 'unverified',
      validationReasons: [
        ...inferred.validationReasons,
        'legacy_value_without_reliability',
      ],
      requiresReview: true,
    };
  }
  return inferred;
}

function mergeWithCurrentFieldEvidence(
  merge: DocumentFieldMergeResult,
  currentDocument: AnyDocument | undefined
): DocumentFieldMergeResult {
  if (!currentDocument) return merge;
  const fieldReliability: DocumentFieldReliabilityMap = {
    ...merge.fieldReliability,
  };
  let currentConflict = false;

  for (const field of SCALAR_FIELDS) {
    const current = currentRecordEvidence(currentDocument, field);
    const hasPersistedEvidence =
      currentDocument.fieldReliability?.[field] !== undefined;
    const currentMustBePreserved =
      hasPersistedEvidence &&
      (current.source === 'user' ||
        current.conflict ||
        current.validationStatus === 'valid' ||
        current.validationStatus === 'unverified');
    if (!currentMustBePreserved) continue;

    const proposal = merge.fieldReliability[field];
    if (!proposal || !isApplicableDocumentField(proposal)) {
      const proposalIsObservable =
        !!proposal &&
        (proposal.validationStatus !== 'missing' ||
          proposal.rawValue !== undefined);
      fieldReliability[field] = proposalIsObservable
        ? {
            ...current,
            alternatives: uniqueAlternatives([
              ...current.alternatives,
              ...reliabilityAlternatives(proposal),
            ]),
            requiresReview:
              current.requiresReview || proposal.requiresReview,
            validationReasons: [
              ...current.validationReasons,
              'invalid_or_ambiguous_extraction_not_applied',
            ],
          }
        : current;
      continue;
    }

    const valuesConflict = !sameReliabilityValue(current, proposal);
    const conflict = current.conflict || valuesConflict;
    const alternatives = uniqueAlternatives([
      ...reliabilityAlternatives(current),
      ...reliabilityAlternatives(proposal),
    ]);
    fieldReliability[field] = {
      ...current,
      alternatives,
      conflict,
      requiresReview:
        current.requiresReview || proposal.requiresReview || conflict,
      validationReasons: [
        ...current.validationReasons,
        ...(valuesConflict
          ? [
              current.source === 'user'
                ? 'user_value_conflicts_with_extraction'
                : 'existing_value_conflicts_with_extraction',
            ]
          : []),
      ],
    };
    currentConflict ||= conflict;
  }

  return {
    ...merge,
    fieldReliability,
    requiresReview:
      merge.requiresReview ||
      currentConflict,
  };
}

function recordItems(
  document: AnyDocument | undefined
): QuoteDocument['items'] | undefined {
  return document?.type === 'quote' ||
    document?.type === 'order' ||
    document?.type === 'invoice'
    ? document.items
    : undefined;
}

function reliabilityForAppliedValue(
  field: 'items' | 'extractedFields',
  value: unknown,
  preferred: DocumentFieldReliability | undefined
): DocumentFieldReliability {
  const inferred = evaluateDocumentField(field, value, {
    source: 'merged',
    confidenceType: 'unknown',
  });
  if (!preferred) return inferred;
  if (sameReliabilityValue(preferred, inferred)) return preferred;
  return {
    ...inferred,
    alternatives: uniqueAlternatives([
      ...reliabilityAlternatives(inferred),
      ...reliabilityAlternatives(preferred),
    ]),
    conflict: true,
    requiresReview: true,
    validationReasons: [
      ...inferred.validationReasons,
      'stored_value_differs_from_reliability',
    ],
  };
}

function appliedItemsReliability(
  document: AnyDocument,
  current: AnyDocument | undefined,
  proposal: DocumentFieldReliability | undefined,
  application: DocumentItemApplication | undefined
): DocumentFieldReliability | undefined {
  const items = recordItems(document);
  if (!items) return proposal;
  const currentItemsReliability =
    current?.fieldReliability?.items ??
    (recordItems(current)
      ? evaluateDocumentField('items', recordItems(current), {
          source: 'merged',
          confidenceType: 'unknown',
        })
      : undefined);
  const preferred =
    application?.source === 'page_groups'
      ? proposal
      : application?.source === 'existing_record'
        ? currentItemsReliability
        : undefined;
  const applied = reliabilityForAppliedValue('items', items, preferred);
  const conflict = applied.conflict || !!application?.conflict;
  const proposalAlternatives = reliabilityAlternatives(proposal);
  const currentAlternatives = reliabilityAlternatives(
    currentItemsReliability
  );

  return {
    ...applied,
    alternatives: uniqueAlternatives([
      ...(conflict ? reliabilityAlternatives(applied) : []),
      ...applied.alternatives,
      ...currentAlternatives,
      ...proposalAlternatives,
    ]),
    conflict,
    requiresReview:
      applied.requiresReview ||
      !!proposal?.requiresReview ||
      conflict,
    validationReasons: [
      ...applied.validationReasons,
      ...(application?.conflict
        ? ['existing_items_preserved_during_conflict']
        : []),
    ],
  };
}

function appliedExtractedFieldsReliability(
  document: AnyDocument,
  current: AnyDocument | undefined,
  proposal: DocumentFieldReliability | undefined,
  application: DocumentExtractedFieldsApplication | undefined
): DocumentFieldReliability | undefined {
  if (document.type !== 'free_document') return proposal;
  const currentReliability =
    current?.type === 'free_document'
      ? current.fieldReliability?.extractedFields ??
        evaluateDocumentField(
          'extractedFields',
          current.extractedFields,
          {
            source: 'merged',
            confidenceType: 'unknown',
          }
        )
      : undefined;
  const preferred =
    application?.source === 'page_groups'
      ? proposal
      : application?.source === 'existing_record'
        ? currentReliability
        : undefined;
  const applied = reliabilityForAppliedValue(
    'extractedFields',
    document.extractedFields,
    preferred
  );
  const conflict =
    applied.conflict || !!application?.conflicts?.length;
  const proposalAlternatives = reliabilityAlternatives(proposal);
  const currentAlternatives =
    reliabilityAlternatives(currentReliability);

  return {
    ...applied,
    alternatives: uniqueAlternatives([
      ...(conflict ? reliabilityAlternatives(applied) : []),
      ...applied.alternatives,
      ...currentAlternatives,
      ...proposalAlternatives,
    ]),
    conflict,
    requiresReview:
      applied.requiresReview ||
      !!proposal?.requiresReview ||
      conflict,
    validationReasons: [
      ...applied.validationReasons,
      ...(application?.conflicts?.length
        ? ['existing_extracted_fields_preserved_during_conflict']
        : []),
    ],
  };
}

function attachApplicationTrace(
  document: AnyDocument,
  merge: DocumentFieldMergeResult,
  options: ApplyDocumentFieldMergeOptions,
  itemApplication?: DocumentItemApplication,
  extractedFieldsApplication?: DocumentExtractedFieldsApplication
): AnyDocument {
  const current = sameDocumentType(options.currentDocument, document)
    ? options.currentDocument
    : undefined;
  const appliedFields: NonNullable<
    DocumentFieldMergeResult['appliedFields']
  > = {};
  const appliedReliability: DocumentFieldReliabilityMap = {
    ...merge.fieldReliability,
  };

  for (const field of SCALAR_FIELDS) {
    const proposal = merge.fields[field];
    const reliability = merge.fieldReliability[field];
    const currentReliability = current?.fieldReliability?.[field];
    const userValuePreserved = currentReliability?.source === 'user';
    const proposalApplicable =
      !!proposal &&
      !!reliability &&
      isApplicableDocumentField(reliability) &&
      !proposal.conflict &&
      !reliability.conflict;
    const preservedReason =
      current && userValuePreserved
        ? 'preserved_user_value'
        : current &&
      document.type === 'free_document' &&
      field === 'date' &&
      proposal
        ? 'preserved_deferred_validation'
        : current && (proposal?.conflict || reliability?.conflict)
        ? 'preserved_conflict'
        : current && (!proposal || !proposalApplicable)
          ? 'preserved_absent'
          : undefined;
    const value = recordFieldValue(
      preservedReason && current ? current : document,
      field
    );

    if (preservedReason) {
      const proposalReliability = merge.fieldReliability[field];
      const currentEvidence = current
        ? currentRecordEvidence(current, field)
        : evaluateDocumentField(field, value, {
            source: 'merged',
            confidenceType: 'unknown',
          });
      const proposalAlternatives =
        reliabilityAlternatives(proposalReliability);
      appliedReliability[field] = {
        ...currentEvidence,
        alternatives: uniqueAlternatives([
          ...reliabilityAlternatives(currentEvidence),
          ...proposalAlternatives,
        ]),
        conflict:
          currentEvidence.conflict ||
          !!proposalReliability?.conflict ||
          preservedReason === 'preserved_conflict',
        requiresReview:
          currentEvidence.requiresReview ||
          !!proposalReliability?.requiresReview ||
          preservedReason === 'preserved_conflict',
        validationReasons: [
          ...currentEvidence.validationReasons,
          ...(preservedReason === 'preserved_conflict'
            ? ['existing_value_preserved_during_conflict']
            : []),
        ],
      };
      appliedFields[field] = {
        field,
        ...(value !== undefined
          ? { value }
          : { valueState: 'absent' as const }),
        source: userValuePreserved ? 'user' : 'existing_record',
        validation: 'unverified',
        reason: preservedReason,
        ...(Object.prototype.hasOwnProperty.call(
          appliedReliability[field] ?? {},
          'rawValue'
        )
          ? { rawValue: appliedReliability[field]?.rawValue }
          : {}),
        confidenceType: appliedReliability[field]?.confidenceType,
        validationStatus: appliedReliability[field]?.validationStatus,
        validationReasons:
          appliedReliability[field]?.validationReasons,
        requiresReview: appliedReliability[field]?.requiresReview,
        alternatives: appliedReliability[field]?.alternatives,
        conflict: appliedReliability[field]?.conflict,
      };
      continue;
    }
    if (!proposal || !proposalApplicable || value === undefined) {
      if (reliability) {
        appliedFields[field] = {
          field,
          valueState: 'absent',
          source: 'page',
          validation: 'invalid',
          reason: 'invalid_or_missing_not_applied',
          ...(Object.prototype.hasOwnProperty.call(
            reliability,
            'rawValue'
          )
            ? { rawValue: reliability.rawValue }
            : {}),
          confidenceType: reliability.confidenceType,
          validationStatus: reliability.validationStatus,
          validationReasons: reliability.validationReasons,
          requiresReview: reliability.requiresReview,
          alternatives: reliability.alternatives,
          conflict: reliability.conflict,
        };
      }
      continue;
    }
    appliedFields[field] = {
      field,
      value,
      source: 'page',
      sourcePageIndex: proposal.sourcePageIndex,
      sourceMethod: proposal.sourceMethod,
      ...(proposal.confidence !== undefined
        ? { confidence: proposal.confidence }
        : {}),
      confidenceType: proposal.confidenceType,
      ...(Object.prototype.hasOwnProperty.call(proposal, 'rawValue')
        ? { rawValue: proposal.rawValue }
        : {}),
      validationStatus: proposal.validationStatus,
      validationReasons: proposal.validationReasons,
      requiresReview: proposal.requiresReview,
      alternatives: proposal.alternatives,
      conflict: !!proposal.conflict,
      validation: proposal.validation,
      reason: proposal.reason,
    };
  }
  appliedReliability.items = appliedItemsReliability(
    document,
    current,
    merge.fieldReliability.items,
    itemApplication
  );
  appliedReliability.extractedFields =
    appliedExtractedFieldsReliability(
      document,
      current,
      merge.fieldReliability.extractedFields,
      extractedFieldsApplication
    );

  return {
    ...document,
    fieldReliability: appliedReliability,
    fieldMerge: {
      ...merge,
      requiresReview:
        merge.requiresReview ||
        (options.mode === 'new_scan' &&
          Object.values(appliedReliability).some(
            (field) => field?.requiresReview
          )) ||
        !!itemApplication?.conflict ||
        !!extractedFieldsApplication?.conflicts?.length,
      appliedFields,
      ...(itemApplication ? { itemApplication } : {}),
      ...(extractedFieldsApplication
        ? { extractedFieldsApplication }
        : {}),
    },
  };
}

/**
 * Applica al record soltanto i campi realmente selezionati dal merge. I
 * placeholder obbligatori del DTO Gemini non possono quindi cancellare dati
 * esistenti o diventare valori apparentemente estratti.
 */
export function applyDocumentFieldMerge(
  document: AnyDocument,
  merge: DocumentFieldMergeResult,
  options: ApplyDocumentFieldMergeOptions = {}
): AnyDocument {
  merge = mergeWithCurrentFieldEvidence(merge, options.currentDocument);
  const applicableValue = (
    field: DocumentScalarFieldKey
  ): string | number | undefined => {
    const proposal = merge.fields[field];
    const reliability = merge.fieldReliability[field];
    return proposal &&
      reliability &&
      !proposal.conflict &&
      isApplicableDocumentField(reliability)
      ? proposal.value
      : undefined;
  };
  const documentNumber = applicableValue('documentNumber');
  const customerName = applicableValue('customerName');
  const date = applicableValue('date');
  const vatNumber = applicableValue('vatNumber');
  const subtotal = applicableValue('subtotal');
  const vatAmount = applicableValue('vatAmount');
  const total = applicableValue('total');
  const currency = applicableValue('currency');
  const proposedDate =
    typeof date === 'string' ? strictDocumentDateToDate(date) : undefined;
  const completeItems = completeDocumentItems(merge.itemGroups);
  const allItemGroupsComplete =
    merge.itemGroups.length > 0 &&
    merge.itemGroups.every(
      (group) => group.validation === 'structural'
    );
  const reviewItemsCanReplace =
    allItemGroupsComplete &&
    (merge.pageIntegrity?.complete ?? true);
  const isNewScan = options.mode === 'new_scan';
  const resolveItems = (
    currentItems: QuoteDocument['items'],
    existingRecordAvailable: boolean
  ): {
    items: QuoteDocument['items'];
    application: DocumentItemApplication;
  } => {
    const completeProposalAvailable =
      allItemGroupsComplete && completeItems.length > 0;
    if (isNewScan && completeItems.length > 0) {
      return {
        items: completeItems,
        application: {
          source: 'page_groups',
          reason: 'complete_groups_applied',
        },
      };
    }

    const semanticConflict =
      !isNewScan &&
      existingRecordAvailable &&
      currentItems.length > 0 &&
      completeProposalAvailable &&
      !itemsSemanticallyEqual(currentItems, completeItems);
    if (semanticConflict) {
      return {
        items: currentItems,
        application: {
          source: 'existing_record',
          reason: 'preserved_conflict',
          conflict: {
            reason: 'semantic_mismatch',
            currentItems: currentItems.map((item) => ({ ...item })),
            proposedItems: completeItems.map((item) => ({ ...item })),
            proposalSources: merge.itemGroups.map((group) => ({
              sourcePageIndex: group.sourcePageIndex,
              sourceMethod: group.sourceMethod,
              ...(group.confidence !== undefined
                ? { confidence: group.confidence }
                : {}),
              validation: group.validation,
              reason: group.reason,
            })),
          },
        },
      };
    }

    const equivalentButLessInformative =
      !isNewScan &&
      existingRecordAvailable &&
      currentItems.length > 0 &&
      completeProposalAvailable &&
      itemsSemanticallyEqual(currentItems, completeItems) &&
      proposalHasLessItemInformation(currentItems, completeItems);
    if (equivalentButLessInformative) {
      return {
        items: currentItems,
        application: {
          source: 'existing_record',
          reason: 'preserved_equivalent',
        },
      };
    }

    if (
      !isNewScan &&
      completeProposalAvailable &&
      reviewItemsCanReplace &&
      (!existingRecordAvailable ||
        currentItems.length === 0 ||
        itemsSemanticallyEqual(currentItems, completeItems))
    ) {
      return {
        items: completeItems,
        application: {
          source: 'page_groups',
          reason: 'complete_groups_applied',
        },
      };
    }

    if (merge.itemGroups.length > 0 || !(merge.pageIntegrity?.complete ?? true)) {
      if (!isNewScan && currentItems.length > 0) {
        return {
          items: currentItems,
          application: {
            source: isNewScan ? 'existing_record' : 'existing_record',
            reason: isNewScan
              ? 'parser_items_preserved_incomplete_groups'
              : 'preserved_incomplete',
          },
        };
      }
      return {
        items: isNewScan ? [] : currentItems,
        application:
          isNewScan || !existingRecordAvailable
            ? {
                source: 'none',
                reason: 'incomplete_groups_excluded',
              }
            : {
                source: 'existing_record',
                reason: 'preserved_incomplete',
              },
      };
    }
    return {
      items: isNewScan ? [] : currentItems,
      application: existingRecordAvailable
        ? { source: 'existing_record', reason: 'preserved_absent' }
        : { source: 'none', reason: 'preserved_absent' },
    };
  };
  const hasConflict = (
    field:
      | 'documentNumber'
      | 'customerName'
      | 'date'
      | 'vatNumber'
      | 'subtotal'
      | 'vatAmount'
      | 'total'
      | 'currency'
  ): boolean =>
    !!merge.fields[field]?.conflict ||
    !!merge.fieldReliability[field]?.conflict ||
    options.currentDocument?.fieldReliability?.[field]?.source === 'user';
  const common = { rawText: merge.rawText };

  const resolveMonetaryFields = (
    currentDoc: QuoteDocument | OrderDocument | InvoiceDocument | undefined,
    parsed: QuoteDocument | OrderDocument | InvoiceDocument,
    items: readonly { total: number }[]
  ) => {
    const pick = (
      field: 'subtotal' | 'vatAmount' | 'total'
    ): number | undefined => {
      if (hasConflict(field) && currentDoc) {
        return currentDoc[field];
      }
      const proposed = applicableValue(field);
      if (typeof proposed === 'number') return proposed;
      if (isNewScan) return undefined;
      return currentDoc?.[field] ?? parsed[field];
    };
    return sanitizeDocumentMonetaryFields({
      subtotal: pick('subtotal'),
      vatAmount: pick('vatAmount'),
      total: pick('total'),
      items,
    });
  };

  if (document.type === 'quote') {
    const quote = document as QuoteDocument;
    const current =
      options.currentDocument?.type === 'quote'
        ? options.currentDocument
        : undefined;
    const quoteNumber =
      hasConflict('documentNumber') && current
        ? current.quoteNumber
        : typeof documentNumber === 'string'
          ? documentNumber
          : isNewScan
            ? undefined
            : current?.quoteNumber ?? quote.quoteNumber;
    const mergedCustomerName =
      hasConflict('customerName') && current
        ? current.customerName
        : typeof customerName === 'string'
          ? customerName
          : isNewScan
            ? undefined
            : current?.customerName ?? quote.customerName;
    const resolvedItems = resolveItems(
      current?.items ?? quote.items,
      !!current
    );
    const monetary = resolveMonetaryFields(current, quote, resolvedItems.items);
    const result: QuoteDocument = {
      ...quote,
      ...common,
      title:
        current &&
        (hasConflict('documentNumber') ||
          hasConflict('customerName') ||
          hasConflict('date') ||
          (!merge.fields.documentNumber &&
            !merge.fields.customerName &&
            !merge.fields.date))
          ? current.title
          : isNewScan
            ? quoteNumber
              ? `Preventivo ${quoteNumber}`
              : mergedCustomerName
                ? `Preventivo — ${mergedCustomerName}`
                : 'Preventivo senza numero'
            : quote.title,
      quoteNumber,
      quoteDate:
        hasConflict('date') && current
          ? current.quoteDate
          : proposedDate
            ? proposedDate
          : !merge.fields.date && current
            ? current.quoteDate
          : isNewScan
            ? undefined
            : quote.quoteDate,
      customerName: mergedCustomerName,
      customerVat:
        hasConflict('vatNumber') && current
          ? current.customerVat
          : typeof vatNumber === 'string'
            ? vatNumber
            : isNewScan
              ? undefined
              : current?.customerVat ?? quote.customerVat,
      subtotal:
        hasConflict('subtotal') && current
          ? current.subtotal
          : monetary.subtotal,
      vatAmount:
        hasConflict('vatAmount') && current
          ? current.vatAmount
          : monetary.vatAmount,
      total:
        hasConflict('total') && current
          ? current.total
          : monetary.total,
      currency:
        hasConflict('currency') && current
          ? current.currency
          : typeof currency === 'string'
            ? currency
            : isNewScan
              ? undefined
              : current?.currency ?? quote.currency,
      items: resolvedItems.items,
    };
    return attachApplicationTrace(
      result,
      merge,
      options,
      resolvedItems.application
    );
  }

  if (document.type === 'order') {
    const order = document as OrderDocument;
    const current =
      options.currentDocument?.type === 'order'
        ? options.currentDocument
        : undefined;
    const orderNumber =
      hasConflict('documentNumber') && current
        ? current.orderNumber
        : typeof documentNumber === 'string'
          ? documentNumber
          : isNewScan
            ? undefined
            : current?.orderNumber ?? order.orderNumber;
    const mergedCustomerName =
      hasConflict('customerName') && current
        ? current.customerName
        : typeof customerName === 'string'
          ? customerName
          : isNewScan
            ? undefined
            : current?.customerName ?? order.customerName;
    const resolvedItems = resolveItems(
      current?.items ?? order.items,
      !!current
    );
    const monetary = resolveMonetaryFields(current, order, resolvedItems.items);
    const result: OrderDocument = {
      ...order,
      ...common,
      title:
        current &&
        (hasConflict('documentNumber') ||
          hasConflict('customerName') ||
          hasConflict('date') ||
          (!merge.fields.documentNumber &&
            !merge.fields.customerName &&
            !merge.fields.date))
          ? current.title
          : isNewScan
            ? orderNumber
              ? `Ordine ${orderNumber}`
              : mergedCustomerName
                ? `Ordine — ${mergedCustomerName}`
                : 'Ordine senza numero'
            : order.title,
      orderNumber,
      orderDate:
        hasConflict('date') && current
          ? current.orderDate
          : proposedDate
            ? proposedDate
          : !merge.fields.date && current
            ? current.orderDate
          : isNewScan
            ? undefined
            : order.orderDate,
      customerName: mergedCustomerName,
      customerVat:
        hasConflict('vatNumber') && current
          ? current.customerVat
          : typeof vatNumber === 'string'
            ? vatNumber
            : isNewScan
              ? undefined
              : current?.customerVat ?? order.customerVat,
      subtotal:
        hasConflict('subtotal') && current
          ? current.subtotal
          : monetary.subtotal,
      vatAmount:
        hasConflict('vatAmount') && current
          ? current.vatAmount
          : monetary.vatAmount,
      total:
        hasConflict('total') && current
          ? current.total
          : monetary.total,
      currency:
        hasConflict('currency') && current
          ? current.currency
          : typeof currency === 'string'
            ? currency
            : isNewScan
              ? undefined
              : current?.currency ?? order.currency,
      items: resolvedItems.items,
    };
    return attachApplicationTrace(
      result,
      merge,
      options,
      resolvedItems.application
    );
  }

  if (document.type === 'invoice') {
    const invoice = document as InvoiceDocument;
    const current =
      options.currentDocument?.type === 'invoice'
        ? options.currentDocument
        : undefined;
    const invoiceNumber =
      hasConflict('documentNumber') && current
        ? current.invoiceNumber
        : typeof documentNumber === 'string'
          ? documentNumber
          : isNewScan
            ? undefined
            : current?.invoiceNumber ?? invoice.invoiceNumber;
    const mergedCustomerName =
      hasConflict('customerName') && current
        ? current.customerName
        : typeof customerName === 'string'
          ? customerName
          : isNewScan
            ? undefined
            : current?.customerName ?? invoice.customerName;
    const resolvedItems = resolveItems(
      current?.items ?? invoice.items,
      !!current
    );
    const monetary = resolveMonetaryFields(current, invoice, resolvedItems.items);
    const result: InvoiceDocument = {
      ...invoice,
      ...common,
      title:
        current &&
        (hasConflict('documentNumber') ||
          hasConflict('customerName') ||
          hasConflict('date') ||
          (!merge.fields.documentNumber &&
            !merge.fields.customerName &&
            !merge.fields.date))
          ? current.title
          : isNewScan
            ? invoiceNumber
              ? `Fattura ${invoiceNumber}`
              : mergedCustomerName
                ? `Fattura — ${mergedCustomerName}`
                : 'Fattura senza numero'
            : invoice.title,
      invoiceNumber,
      invoiceDate:
        hasConflict('date') && current
          ? current.invoiceDate
          : proposedDate
            ? proposedDate
          : !merge.fields.date && current
            ? current.invoiceDate
          : isNewScan
            ? undefined
            : invoice.invoiceDate,
      customerName: mergedCustomerName,
      customerVat:
        hasConflict('vatNumber') && current
          ? current.customerVat
          : typeof vatNumber === 'string'
            ? vatNumber
            : isNewScan
              ? undefined
              : current?.customerVat ?? invoice.customerVat,
      subtotal:
        hasConflict('subtotal') && current
          ? current.subtotal
          : monetary.subtotal,
      vatAmount:
        hasConflict('vatAmount') && current
          ? current.vatAmount
          : monetary.vatAmount,
      total:
        hasConflict('total') && current
          ? current.total
          : monetary.total,
      currency:
        hasConflict('currency') && current
          ? current.currency
          : typeof currency === 'string'
            ? currency
            : isNewScan
              ? undefined
              : current?.currency ?? invoice.currency,
      items: resolvedItems.items,
    };
    return attachApplicationTrace(
      result,
      merge,
      options,
      resolvedItems.application
    );
  }

  if (document.type === 'free_document') {
    const current =
      options.currentDocument?.type === 'free_document'
        ? options.currentDocument
        : undefined;
    const selectedDocumentNumber =
      hasConflict('documentNumber') && current
        ? current.documentNumber
        : typeof documentNumber === 'string'
          ? documentNumber
          : isNewScan
            ? undefined
            : current?.documentNumber ?? document.documentNumber;
    const currentExtractedFields = current?.extractedFields ?? {};
    const extractedFields: Record<string, string> = isNewScan
      ? {}
      : { ...currentExtractedFields };
    const extractedFieldConflicts: NonNullable<
      DocumentExtractedFieldsApplication['conflicts']
    > = [];
    const extractedFieldCandidates = (merge.extractedFieldGroups ?? []).flatMap(
      (group) =>
        Object.entries(group.value).map(([key, value]) => ({
          key: `page_${group.sourcePageIndex + 1}_${key}`,
          value,
          group,
        }))
    );
    for (const candidate of extractedFieldCandidates) {
      const currentValue = currentExtractedFields[candidate.key];
      if (
        !isNewScan &&
        currentValue !== undefined
      ) {
        if (currentValue.trim() !== candidate.value.trim()) {
          extractedFieldConflicts.push({
            key: candidate.key,
            reason: 'different_values',
            currentValue,
            candidate: {
              value: candidate.value,
              sourcePageIndex: candidate.group.sourcePageIndex,
              sourceMethod: candidate.group.sourceMethod,
              validation: candidate.group.validation,
              reason: candidate.group.reason,
            },
          });
        }
        continue;
      }
      extractedFields[candidate.key] = candidate.value;
    }
    const extractedFieldsApplication: DocumentExtractedFieldsApplication =
      isNewScan
        ? extractedFieldCandidates.length > 0
          ? {
              source: 'page_groups',
              reason: 'namespaced_groups_applied',
            }
          : { source: 'none', reason: 'preserved_absent' }
        : extractedFieldCandidates.length > 0
          ? {
              source: 'existing_record_and_page_groups',
              reason: 'merged_namespaced_preserving_existing',
              ...(extractedFieldConflicts.length > 0
                ? { conflicts: extractedFieldConflicts }
                : {}),
            }
          : {
              source: 'existing_record',
              reason: 'preserved_absent',
            };
    const result = {
      ...document,
      ...common,
      title:
        current &&
        (hasConflict('documentNumber') ||
          hasConflict('date') ||
          (!merge.fields.documentNumber && !merge.fields.date))
          ? current.title
          : isNewScan
            ? selectedDocumentNumber
              ? `Documento ${selectedDocumentNumber}`
              : 'Documento libero'
            : document.title,
      documentNumber: selectedDocumentNumber,
      documentDate:
        hasConflict('date') && current
          ? current.documentDate
          : proposedDate
            ? proposedDate
            : isNewScan
              ? undefined
              : current?.documentDate ?? document.documentDate,
      extractedFields,
    };
    return attachApplicationTrace(
      result,
      merge,
      options,
      undefined,
      extractedFieldsApplication
    );
  }

  return document;
}

export type DocumentUserEditableField =
  | 'documentNumber'
  | 'customerName'
  | 'date'
  | 'subtotal'
  | 'vatAmount'
  | 'total'
  | 'currency'
  | 'vatNumber';

/**
 * Applica un edit esplicito come un'unica operazione valore + provenienza.
 * Un input invalido resta visibile nei metadati ma non sostituisce il valore
 * valido corrente; un input vuoto, essendo un'azione utente, può cancellarlo.
 */
export function applyUserDocumentFieldEdit(
  document: AnyDocument,
  field: DocumentUserEditableField,
  rawValue: unknown
): AnyDocument {
  if (document.type === 'business_card') return document;
  const attemptedReliability = evaluateDocumentField(field, rawValue, {
    source: 'user',
    confidenceType: 'unknown',
    userConfirmed: true,
  });
  const canApply = isApplicableDocumentField(attemptedReliability);
  const clearValue = attemptedReliability.validationStatus === 'missing';
  const rejectedAttempt = !canApply && !clearValue;
  const previousReliability = currentRecordEvidence(document, field);
  const reliability = rejectedAttempt
    ? {
        ...previousReliability,
        alternatives: uniqueAlternatives([
          ...previousReliability.alternatives,
          documentFieldAlternative(attemptedReliability),
        ]),
        validationReasons: [
          ...previousReliability.validationReasons,
          'invalid_user_edit_not_applied',
        ],
        requiresReview: true,
      }
    : attemptedReliability;
  const textValue =
    canApply && typeof attemptedReliability.value === 'string'
      ? attemptedReliability.value
      : undefined;
  const numberValue =
    canApply && typeof attemptedReliability.value === 'number'
      ? attemptedReliability.value
      : undefined;
  const dateValue =
    field === 'date' && canApply
      ? strictDocumentDateToDate(attemptedReliability.value, {
          userConfirmed: true,
        })
      : undefined;
  let updated: AnyDocument = document;

  if (document.type === 'quote') {
    updated = {
      ...document,
      ...(field === 'documentNumber' && (textValue !== undefined || clearValue)
        ? { quoteNumber: textValue }
        : {}),
      ...(field === 'customerName' && (textValue !== undefined || clearValue)
        ? { customerName: textValue }
        : {}),
      ...(field === 'date' && (dateValue !== undefined || clearValue)
        ? { quoteDate: dateValue }
        : {}),
      ...(field === 'vatNumber' && (textValue !== undefined || clearValue)
        ? { customerVat: textValue }
        : {}),
      ...(field === 'subtotal' && (numberValue !== undefined || clearValue)
        ? { subtotal: numberValue }
        : {}),
      ...(field === 'vatAmount' && (numberValue !== undefined || clearValue)
        ? { vatAmount: numberValue }
        : {}),
      ...(field === 'total' && (numberValue !== undefined || clearValue)
        ? { total: numberValue }
        : {}),
      ...(field === 'currency' && (textValue !== undefined || clearValue)
        ? { currency: textValue }
        : {}),
    };
  } else if (document.type === 'order') {
    updated = {
      ...document,
      ...(field === 'documentNumber' && (textValue !== undefined || clearValue)
        ? { orderNumber: textValue }
        : {}),
      ...(field === 'customerName' && (textValue !== undefined || clearValue)
        ? { customerName: textValue }
        : {}),
      ...(field === 'date' && (dateValue !== undefined || clearValue)
        ? { orderDate: dateValue }
        : {}),
      ...(field === 'vatNumber' && (textValue !== undefined || clearValue)
        ? { customerVat: textValue }
        : {}),
      ...(field === 'subtotal' && (numberValue !== undefined || clearValue)
        ? { subtotal: numberValue }
        : {}),
      ...(field === 'vatAmount' && (numberValue !== undefined || clearValue)
        ? { vatAmount: numberValue }
        : {}),
      ...(field === 'total' && (numberValue !== undefined || clearValue)
        ? { total: numberValue }
        : {}),
      ...(field === 'currency' && (textValue !== undefined || clearValue)
        ? { currency: textValue }
        : {}),
    };
  } else if (document.type === 'invoice') {
    updated = {
      ...document,
      ...(field === 'documentNumber' && (textValue !== undefined || clearValue)
        ? { invoiceNumber: textValue }
        : {}),
      ...(field === 'customerName' && (textValue !== undefined || clearValue)
        ? { customerName: textValue }
        : {}),
      ...(field === 'date' && (dateValue !== undefined || clearValue)
        ? { invoiceDate: dateValue }
        : {}),
      ...(field === 'vatNumber' && (textValue !== undefined || clearValue)
        ? { customerVat: textValue }
        : {}),
      ...(field === 'subtotal' && (numberValue !== undefined || clearValue)
        ? { subtotal: numberValue }
        : {}),
      ...(field === 'vatAmount' && (numberValue !== undefined || clearValue)
        ? { vatAmount: numberValue }
        : {}),
      ...(field === 'total' && (numberValue !== undefined || clearValue)
        ? { total: numberValue }
        : {}),
      ...(field === 'currency' && (textValue !== undefined || clearValue)
        ? { currency: textValue }
        : {}),
    };
  } else {
    updated = {
      ...document,
      ...(field === 'documentNumber' && (textValue !== undefined || clearValue)
        ? { documentNumber: textValue }
        : {}),
      ...(field === 'date' && (dateValue !== undefined || clearValue)
        ? { documentDate: dateValue }
        : {}),
    };
  }

  const appliedValue = recordFieldValue(updated, field);
  const fieldReliability: DocumentFieldReliabilityMap = {
    ...document.fieldReliability,
    [field]: reliability,
  };
  const fieldMerge = document.fieldMerge
    ? {
        ...document.fieldMerge,
        fieldReliability: {
          ...document.fieldMerge.fieldReliability,
          [field]: reliability,
        },
        ...(!rejectedAttempt
          ? {
              appliedFields: {
                ...document.fieldMerge.appliedFields,
                [field]: {
                  field,
                  ...(appliedValue !== undefined
                    ? { value: appliedValue }
                    : { valueState: 'absent' as const }),
                  source: 'user' as const,
                  validation:
                    reliability.validationStatus === 'valid'
                      ? ('structural' as const)
                      : reliability.validationStatus === 'unverified'
                        ? ('unverified' as const)
                        : ('invalid' as const),
                  reason: canApply
                    ? ('single_candidate' as const)
                    : ('user_cleared_value' as const),
                  rawValue: reliability.rawValue,
                  confidenceType: reliability.confidenceType,
                  validationStatus: reliability.validationStatus,
                  validationReasons: reliability.validationReasons,
                  requiresReview: reliability.requiresReview,
                  alternatives: reliability.alternatives,
                  conflict: reliability.conflict,
                },
              },
            }
          : {}),
        requiresReview:
          document.fieldMerge.requiresReview ||
          reliability.requiresReview,
      }
    : undefined;

  return {
    ...updated,
    fieldReliability,
    ...(fieldMerge ? { fieldMerge } : {}),
  } as AnyDocument;
}

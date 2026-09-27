import type {
  AppliedDocumentField,
  DocumentFieldMergeResult,
  DocumentScalarFieldKey,
  MergedDocumentField,
} from './document-field-merge';
import type {
  DocumentFieldAlternative,
  DocumentFieldConfidenceType,
  DocumentFieldReliabilityMap,
  DocumentFieldSource,
  DocumentFieldValidationStatus,
  DocumentReliabilityFieldKey,
} from './document-field-reliability';

export const DOCUMENT_REVIEW_FIELD_ORDER: readonly DocumentReliabilityFieldKey[] = [
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

export interface DocumentReviewAlternativeViewModel
  extends DocumentFieldAlternative {
  hasRawValue: boolean;
}

export interface DocumentReviewFieldViewModel {
  field: DocumentReliabilityFieldKey;
  proposal?: MergedDocumentField;
  applied?: AppliedDocumentField;
  source?: DocumentFieldSource;
  pageIndex?: number;
  value?: unknown;
  rawValue?: unknown;
  hasRawValue: boolean;
  confidence?: number;
  confidenceType?: DocumentFieldConfidenceType;
  validationStatus?: DocumentFieldValidationStatus;
  validationReasons: string[];
  requiresReview: boolean;
  alternatives: DocumentReviewAlternativeViewModel[];
  conflict: boolean;
}

export interface DocumentReviewViewModel {
  requiresReview: boolean;
  fields: DocumentReviewFieldViewModel[];
}

export type DocumentReviewFieldPresentation =
  | 'not_found'
  | 'needs_review'
  | 'conflict'
  | 'reliable';

export function classifyDocumentReviewFieldPresentation(
  field: Pick<
    DocumentReviewFieldViewModel,
    'validationStatus' | 'requiresReview' | 'conflict'
  >
): DocumentReviewFieldPresentation {
  if (field.validationStatus === 'missing') return 'not_found';
  if (field.conflict) return 'conflict';
  if (field.requiresReview) return 'needs_review';
  return 'reliable';
}

function alternativeViewModel(
  alternative: DocumentFieldAlternative
): DocumentReviewAlternativeViewModel {
  return {
    ...alternative,
    hasRawValue: Object.prototype.hasOwnProperty.call(
      alternative,
      'rawValue'
    ),
    validationReasons: [...alternative.validationReasons],
  };
}

function isScalarReviewField(
  field: DocumentReliabilityFieldKey
): field is DocumentScalarFieldKey {
  return field !== 'items' && field !== 'extractedFields';
}

export function buildDocumentReviewViewModel(
  fieldMerge: DocumentFieldMergeResult | undefined,
  standaloneReliability?: DocumentFieldReliabilityMap
): DocumentReviewViewModel {
  if (!fieldMerge && !standaloneReliability) {
    return { requiresReview: false, fields: [] };
  }

  const reliabilityMap = {
    ...(standaloneReliability ?? {}),
    ...(fieldMerge?.fieldReliability ?? {}),
  };
  const fields = DOCUMENT_REVIEW_FIELD_ORDER.flatMap(
    (field): DocumentReviewFieldViewModel[] => {
      const proposal = isScalarReviewField(field)
        ? fieldMerge?.fields[field]
        : undefined;
      const applied = isScalarReviewField(field)
        ? fieldMerge?.appliedFields?.[field]
        : undefined;
      const reliability = reliabilityMap[field];
      if (!proposal && !applied && !reliability) return [];

      return [
        {
          field,
          ...(proposal ? { proposal } : {}),
          ...(applied ? { applied } : {}),
          ...(reliability?.source ? { source: reliability.source } : {}),
          ...(reliability?.pageIndex !== undefined
            ? { pageIndex: reliability.pageIndex }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(
            reliability ?? {},
            'value'
          )
            ? { value: reliability?.value }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(
            reliability ?? {},
            'rawValue'
          )
            ? { rawValue: reliability?.rawValue }
            : {}),
          hasRawValue: Object.prototype.hasOwnProperty.call(
            reliability ?? {},
            'rawValue'
          ),
          ...(reliability?.confidence !== undefined
            ? { confidence: reliability.confidence }
            : {}),
          ...(reliability?.confidenceType
            ? { confidenceType: reliability.confidenceType }
            : {}),
          ...(reliability?.validationStatus
            ? { validationStatus: reliability.validationStatus }
            : {}),
          validationReasons: [
            ...(reliability?.validationReasons ?? []),
          ],
          requiresReview: reliability?.requiresReview ?? false,
          alternatives: (reliability?.alternatives ?? []).map(
            alternativeViewModel
          ),
          conflict: reliability?.conflict ?? !!proposal?.conflict,
        },
      ];
    }
  );

  return {
    requiresReview:
      (fieldMerge?.requiresReview ?? false) ||
      fields.some((field) => field.requiresReview || field.conflict),
    fields,
  };
}

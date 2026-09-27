import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  PAGE_WARNING_CLOUD_FALLBACK,
  PAGE_WARNING_DUPLICATE,
  PAGE_WARNING_EMPTY_TEXT,
  type DocumentPageItem,
  type PageExtractionResult,
  type PageProcessingMethod,
} from '../lib/document-page-extraction';
import type {
  DocumentAppliedFieldReason,
  DocumentFieldMergeResult,
  DocumentFieldSelectionReason,
  DocumentFieldValidation,
  DocumentItemApplication,
} from '../lib/document-field-merge';
import {
  buildDocumentReviewViewModel,
  classifyDocumentReviewFieldPresentation,
  type DocumentReviewAlternativeViewModel,
} from '../lib/document-review-view-model';
import { OcrQualityIndicator } from './OcrQualityIndicator';
import { colors } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';
import type {
  DocumentFieldConfidenceType,
  DocumentFieldReliabilityMap,
  DocumentFieldSource,
  DocumentFieldValidationStatus,
  DocumentReliabilityFieldKey,
} from '../lib/document-field-reliability';
import { formatOcrPageTextForDisplay } from '../lib/ocr-display-format';
import type { StructuredDocumentPage } from '../lib/document-structure';

interface Props {
  results?: readonly PageExtractionResult[];
  fieldMerge?: DocumentFieldMergeResult;
  fieldReliability?: DocumentFieldReliabilityMap;
  structuredPages?: readonly StructuredDocumentPage[];
}

function methodTranslationKey(
  method: PageProcessingMethod
):
  | 'documentPageMethodLocal'
  | 'documentPageMethodCloud'
  | 'documentPageMethodLocalFallback'
  | 'documentPageMethodFailed' {
  switch (method) {
    case 'local':
      return 'documentPageMethodLocal';
    case 'cloud':
      return 'documentPageMethodCloud';
    case 'local_fallback':
      return 'documentPageMethodLocalFallback';
    case 'failed':
      return 'documentPageMethodFailed';
  }
}

function fieldTranslationKey(
  field: DocumentReliabilityFieldKey
):
  | 'documentFieldMergeFieldDocumentNumber'
  | 'documentFieldMergeFieldCustomerName'
  | 'documentFieldMergeFieldDate'
  | 'documentFieldMergeFieldVatNumber'
  | 'documentFieldMergeFieldSubtotal'
  | 'documentFieldMergeFieldVatAmount'
  | 'documentFieldMergeFieldTotal'
  | 'documentFieldMergeFieldCurrency'
  | 'documentFieldMergeFieldItems'
  | 'documentFieldMergeFieldExtractedFields' {
  switch (field) {
    case 'documentNumber':
      return 'documentFieldMergeFieldDocumentNumber';
    case 'customerName':
      return 'documentFieldMergeFieldCustomerName';
    case 'date':
      return 'documentFieldMergeFieldDate';
    case 'vatNumber':
      return 'documentFieldMergeFieldVatNumber';
    case 'subtotal':
      return 'documentFieldMergeFieldSubtotal';
    case 'vatAmount':
      return 'documentFieldMergeFieldVatAmount';
    case 'total':
      return 'documentFieldMergeFieldTotal';
    case 'currency':
      return 'documentFieldMergeFieldCurrency';
    case 'items':
      return 'documentFieldMergeFieldItems';
    case 'extractedFields':
      return 'documentFieldMergeFieldExtractedFields';
  }
}

function reasonTranslationKey(
  reason: DocumentFieldSelectionReason
):
  | 'documentFieldMergeReasonSingle'
  | 'documentFieldMergeReasonRepeated'
  | 'documentFieldMergeReasonComplete'
  | 'documentFieldMergeReasonValidation'
  | 'documentFieldMergeReasonConfidence'
  | 'documentFieldMergeReasonConflictTiebreak'
  | 'documentFieldMergeReasonPageGroup' {
  switch (reason) {
    case 'single_candidate':
      return 'documentFieldMergeReasonSingle';
    case 'same_value_repeated':
      return 'documentFieldMergeReasonRepeated';
    case 'more_complete_value':
      return 'documentFieldMergeReasonComplete';
    case 'stronger_validation':
      return 'documentFieldMergeReasonValidation';
    case 'higher_reported_confidence':
      return 'documentFieldMergeReasonConfidence';
    case 'deterministic_conflict_tiebreak':
      return 'documentFieldMergeReasonConflictTiebreak';
    case 'page_group_preserved':
      return 'documentFieldMergeReasonPageGroup';
  }
}

function validationTranslationKey(
  validation: DocumentFieldValidation
):
  | 'documentFieldMergeValidationStructural'
  | 'documentFieldMergeValidationUnverified'
  | 'documentFieldMergeValidationInvalid' {
  switch (validation) {
    case 'structural':
      return 'documentFieldMergeValidationStructural';
    case 'unverified':
      return 'documentFieldMergeValidationUnverified';
    case 'invalid':
      return 'documentFieldMergeValidationInvalid';
  }
}

function appliedReasonTranslationKey(reason: DocumentAppliedFieldReason) {
  switch (reason) {
    case 'preserved_conflict':
      return 'documentFieldMergeAppliedReasonPreservedConflict' as const;
    case 'preserved_absent':
      return 'documentFieldMergeAppliedReasonPreservedAbsent' as const;
    case 'preserved_deferred_validation':
      return 'documentFieldMergeAppliedReasonDeferredValidation' as const;
    case 'legacy_date_deferred_validation':
      return 'documentFieldMergeAppliedReasonLegacyDateDeferred' as const;
    case 'preserved_user_value':
      return 'documentFieldMergeAppliedReasonPreservedUser' as const;
    case 'invalid_or_missing_not_applied':
      return 'documentFieldMergeAppliedReasonInvalidOrMissing' as const;
    case 'user_cleared_value':
      return 'documentFieldMergeAppliedReasonUserCleared' as const;
    default:
      return reasonTranslationKey(reason);
  }
}

function reliabilitySourceTranslationKey(source: DocumentFieldSource) {
  switch (source) {
    case 'local_ocr':
      return 'documentFieldReliabilitySourceLocalOcr' as const;
    case 'cloud_ai':
      return 'documentFieldReliabilitySourceCloudAi' as const;
    case 'merged':
      return 'documentFieldReliabilitySourceMerged' as const;
    case 'user':
      return 'documentFieldReliabilitySourceUser' as const;
  }
}

function reliabilityValidationTranslationKey(
  status: DocumentFieldValidationStatus
) {
  switch (status) {
    case 'valid':
      return 'documentFieldReliabilityValidationValid' as const;
    case 'invalid':
      return 'documentFieldReliabilityValidationInvalid' as const;
    case 'missing':
      return 'documentFieldReliabilityValidationMissing' as const;
    case 'ambiguous':
      return 'documentFieldReliabilityValidationAmbiguous' as const;
    case 'unverified':
      return 'documentFieldReliabilityValidationUnverified' as const;
  }
}

function reliabilityConfidenceTranslationKey(
  type: DocumentFieldConfidenceType
) {
  switch (type) {
    case 'measured':
      return 'documentFieldReliabilityConfidenceMeasured' as const;
    case 'heuristic':
      return 'documentFieldReliabilityConfidenceHeuristic' as const;
    case 'unknown':
      return 'documentFieldReliabilityConfidenceUnknown' as const;
  }
}

function itemApplicationTranslationKey(
  application: DocumentItemApplication
) {
  switch (application.reason) {
    case 'complete_groups_applied':
      return 'documentFieldMergeItemsAppliedComplete' as const;
    case 'preserved_conflict':
      return 'documentFieldMergeItemsPreservedConflict' as const;
    case 'preserved_equivalent':
      return 'documentFieldMergeItemsPreservedEquivalent' as const;
    case 'preserved_incomplete':
      return 'documentFieldMergeItemsPreservedIncomplete' as const;
    case 'preserved_absent':
      return application.source === 'existing_record'
        ? ('documentFieldMergeItemsPreservedAbsent' as const)
        : ('documentFieldMergeItemsNoneAvailable' as const);
    case 'incomplete_groups_excluded':
      return 'documentFieldMergeItemsExcludedIncomplete' as const;
    case 'parser_items_preserved_incomplete_groups':
      return 'documentFieldMergeItemsPreservedIncomplete' as const;
  }
}

function displayValue(value: string | number): string {
  return typeof value === 'number'
    ? value.toLocaleString(undefined, { maximumFractionDigits: 6 })
    : value;
}

function displayUnknownValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value || '—';
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function DocumentPageExtractionReview({
  results,
  fieldMerge,
  fieldReliability,
  structuredPages,
}: Props) {
  const { t } = useTranslation();
  if (
    !results?.length &&
    !fieldMerge &&
    !Object.keys(fieldReliability ?? {}).length
  ) {
    return null;
  }

  const ordered = [...(results ?? [])].sort(
    (a, b) => a.pageIndex - b.pageIndex
  );
  const reviewViewModel = buildDocumentReviewViewModel(
    fieldMerge,
    fieldReliability
  );
  const fieldDecisions = reviewViewModel.fields;
  const fieldPresentations = fieldDecisions.map(
    classifyDocumentReviewFieldPresentation
  );
  const hasMissingFields = fieldPresentations.includes('not_found');
  const hasActionableFieldReview = fieldPresentations.some(
    (status) => status === 'needs_review' || status === 'conflict'
  );
  const hasApplicationTrace = fieldMerge?.appliedFields !== undefined;
  const itemGroups = fieldMerge?.itemGroups ?? [];
  const itemApplication = fieldMerge?.itemApplication;
  const scalarConflicts = fieldMerge?.conflicts ?? [];
  const showReliabilitySection =
    !!fieldMerge || fieldDecisions.length > 0;
  const extractedFieldGroups = fieldMerge?.extractedFieldGroups ?? [];
  const extractedFieldConflicts =
    fieldMerge?.extractedFieldsApplication?.conflicts ?? [];
  const renderItems = (
    items: readonly DocumentPageItem[],
    keyPrefix: string
  ) => (
    <View style={styles.itemList}>
      {items.length > 0 ? (
        items.map((item, index) => (
          <View key={`${keyPrefix}:${index}`} style={styles.itemEntry}>
            <Text style={styles.itemDescription} selectable>
              {item.description?.trim() ||
                t('documentFieldMergeItemNoDescription')}
            </Text>
            <Text style={styles.mergeMeta}>
              {t('documentFieldMergeItemDetails', {
                quantity:
                  item.quantity !== undefined
                    ? displayValue(item.quantity)
                    : '—',
                unitPrice:
                  item.unitPrice !== undefined
                    ? displayValue(item.unitPrice)
                    : '—',
                total:
                  item.total !== undefined
                    ? displayValue(item.total)
                    : '—',
                vatRate:
                  item.vatRate !== undefined
                    ? displayValue(item.vatRate)
                    : '—',
              })}
            </Text>
          </View>
        ))
      ) : (
        <Text style={styles.mergeMeta}>
          {t('documentFieldMergeItemsEmpty')}
        </Text>
      )}
    </View>
  );

  return (
    <View style={styles.container}>
      {showReliabilitySection ? (
        <View
          style={[
            styles.merge,
            reviewViewModel.requiresReview
              ? styles.mergeNeedsReview
              : undefined,
          ]}
        >
          <Text style={styles.mergeHeading}>
            {t('documentFieldMergeTitle')}
          </Text>
          {hasActionableFieldReview ? (
            <Text style={styles.mergeReviewLabel}>
              {t('documentFieldMergeRequiresReview')}
            </Text>
          ) : hasMissingFields ? (
            <Text style={styles.missingSummary}>
              {t('documentFieldReliabilityMissingSummary')}
            </Text>
          ) : null}

          {fieldDecisions.length > 0 ||
          itemGroups.length > 0 ||
          itemApplication ? (
            <Text style={styles.sectionHeading}>
              {t('documentFieldMergeSelectedTitle')}
            </Text>
          ) : null}

          {fieldDecisions.map((fieldDecision) => {
            const {
              field,
              proposal,
              applied,
              source,
              pageIndex,
              rawValue,
              hasRawValue,
              confidence,
              confidenceType,
              validationStatus,
              validationReasons,
              requiresReview,
              alternatives,
              conflict,
            } = fieldDecision;
            const appliedValueAvailable =
              applied?.valueState !== 'absent' &&
              applied?.value !== undefined;
            const sameValue =
              appliedValueAvailable &&
              proposal?.value === applied?.value;
            const samePageApplication =
              sameValue &&
              applied?.source === 'page' &&
              applied.sourcePageIndex === proposal?.sourcePageIndex &&
              applied.sourceMethod === proposal?.sourceMethod;

            return (
              <View
                key={field}
                style={[
                  styles.mergeField,
                  conflict
                    ? styles.mergeFieldConflict
                    : undefined,
                ]}
              >
                <Text style={styles.mergeFieldName}>
                  {t(fieldTranslationKey(field))}
                </Text>

                {proposal ? (
                  <>
                    <Text style={styles.decisionLabel}>
                      {t('documentFieldMergeProposalLabel')}
                    </Text>
                    <Text style={styles.mergeFieldValue} selectable>
                      {displayValue(proposal.value)}
                    </Text>
                    <Text style={styles.mergeMeta}>
                      {t('documentFieldMergeProvenance', {
                        page: proposal.sourcePageIndex + 1,
                        method: t(
                          methodTranslationKey(proposal.sourceMethod)
                        ),
                      })}
                    </Text>
                    <Text style={styles.mergeMeta}>
                      {t(reasonTranslationKey(proposal.reason))} ·{' '}
                      {t(validationTranslationKey(proposal.validation))}
                    </Text>
                    {proposal.confidence !== undefined ? (
                      <Text style={styles.mergeMeta}>
                        {t('documentFieldMergeConfidence', {
                          quality: Math.round(proposal.confidence * 100),
                        })}
                      </Text>
                    ) : null}
                  </>
                ) : null}

                {applied ? (
                  <View
                    style={[
                      styles.appliedDecision,
                      applied.source === 'existing_record' ||
                      applied.source === 'legacy_placeholder' ||
                      applied.source === 'user'
                        ? styles.appliedDecisionPreserved
                        : undefined,
                    ]}
                  >
                    <Text
                      style={[
                        styles.decisionLabel,
                        applied.source === 'existing_record' ||
                        applied.source === 'legacy_placeholder' ||
                        applied.source === 'user'
                          ? styles.preservedDecisionLabel
                          : styles.appliedDecisionLabel,
                      ]}
                    >
                      {t(
                        applied.source === 'existing_record'
                          ? 'documentFieldMergeExistingRetainedLabel'
                          : applied.source === 'legacy_placeholder'
                            ? 'documentFieldMergeLegacyPlaceholderLabel'
                            : applied.source === 'user'
                              ? 'documentFieldMergeUserValueLabel'
                              : 'documentFieldMergeAppliedLabel'
                      )}
                    </Text>
                    {applied.valueState !== 'absent' &&
                    applied.value !== undefined &&
                    !sameValue ? (
                      <Text style={styles.mergeFieldValue} selectable>
                        {displayValue(applied.value)}
                      </Text>
                    ) : null}
                    {!appliedValueAvailable ? (
                      <Text style={styles.absentValue}>
                        {t('documentFieldMergeValueAbsent')}
                      </Text>
                    ) : null}
                    {sameValue &&
                    applied.source === 'existing_record' ? (
                      <Text style={styles.mergeMeta}>
                        {t('documentFieldMergeSameAsProposal')}
                      </Text>
                    ) : null}
                    {applied.source === 'page' &&
                    applied.sourcePageIndex !== undefined &&
                    applied.sourceMethod !== undefined ? (
                      <Text style={styles.mergeMeta}>
                        {t('documentFieldMergeAppliedFromPage', {
                          page: applied.sourcePageIndex + 1,
                          method: t(
                            methodTranslationKey(applied.sourceMethod)
                          ),
                        })}
                      </Text>
                    ) : null}
                    {!samePageApplication ? (
                      <Text style={styles.mergeMeta}>
                        {t(appliedReasonTranslationKey(applied.reason))} ·{' '}
                        {t(
                          validationTranslationKey(applied.validation)
                        )}
                      </Text>
                    ) : null}
                  </View>
                ) : proposal && hasApplicationTrace ? (
                  <View
                    style={[
                      styles.appliedDecision,
                      styles.appliedDecisionPreserved,
                    ]}
                  >
                    <Text
                      style={[
                        styles.decisionLabel,
                        styles.preservedDecisionLabel,
                      ]}
                    >
                      {t('documentFieldMergeNotAppliedLabel')}
                    </Text>
                  </View>
                ) : null}

                {source || validationStatus || hasRawValue ? (
                  <View style={styles.reliabilityDetails}>
                    <Text style={styles.reliabilityHeading}>
                      {t('documentFieldReliabilityTitle')}
                    </Text>
                    {source ? (
                      <Text style={styles.mergeMeta}>
                        {t('documentFieldReliabilitySource', {
                          source: t(
                            reliabilitySourceTranslationKey(source)
                          ),
                        })}
                      </Text>
                    ) : null}
                    {pageIndex !== undefined ? (
                      <Text style={styles.mergeMeta}>
                        {t('documentFieldReliabilityPage', {
                          page: pageIndex + 1,
                        })}
                      </Text>
                    ) : null}
                    {hasRawValue ? (
                      <Text style={styles.mergeMeta} selectable>
                        {t('documentFieldReliabilityRawValue', {
                          value: displayUnknownValue(rawValue),
                        })}
                      </Text>
                    ) : null}
                    {validationStatus ? (
                      <Text style={styles.mergeMeta}>
                        {t('documentFieldReliabilityValidation', {
                          status: t(
                            reliabilityValidationTranslationKey(
                              validationStatus
                            )
                          ),
                        })}
                      </Text>
                    ) : null}
                    {confidenceType ? (
                      <Text style={styles.mergeMeta}>
                        {t('documentFieldReliabilityConfidenceType', {
                          type: t(
                            reliabilityConfidenceTranslationKey(
                              confidenceType
                            )
                          ),
                        })}
                      </Text>
                    ) : null}
                    {confidence !== undefined ? (
                      <Text style={styles.mergeMeta}>
                        {t('documentFieldMergeConfidence', {
                          quality: Math.round(confidence * 100),
                        })}
                      </Text>
                    ) : null}
                    {validationReasons.length > 0 ? (
                      <Text style={styles.mergeMeta} selectable>
                        {t('documentFieldReliabilityReasons', {
                          reasons: validationReasons.join(', '),
                        })}
                      </Text>
                    ) : null}
                    {validationStatus === 'missing' ? (
                      <Text style={styles.reliabilityMissing}>
                        {t('documentFieldReliabilityNotFound')}
                      </Text>
                    ) : requiresReview ? (
                      <Text style={styles.reliabilityAttention}>
                        {t('documentFieldReliabilityRequiresReview')}
                      </Text>
                    ) : null}
                    {conflict ? (
                      <Text style={styles.reliabilityAttention}>
                        {t('documentFieldReliabilityConflict')}
                      </Text>
                    ) : null}
                    {alternatives.length > 0 ? (
                      <>
                        <Text style={styles.decisionSubheading}>
                          {t('documentFieldReliabilityAlternativesTitle')}
                        </Text>
                        {alternatives.map(
                          (
                            alternative: DocumentReviewAlternativeViewModel,
                            index
                          ) => (
                            <View
                              key={`${field}:${alternative.source}:${alternative.pageIndex ?? 'none'}:${index}`}
                              style={styles.reliabilityAlternative}
                            >
                              <Text
                                style={styles.mergeFieldValue}
                                selectable
                              >
                                {displayUnknownValue(
                                  alternative.value !== undefined
                                    ? alternative.value
                                    : alternative.rawValue
                                )}
                              </Text>
                              <Text style={styles.mergeMeta}>
                                {t(
                                  'documentFieldReliabilityAlternativeMeta',
                                  {
                                    source: t(
                                      reliabilitySourceTranslationKey(
                                        alternative.source
                                      )
                                    ),
                                    status: t(
                                      reliabilityValidationTranslationKey(
                                        alternative.validationStatus
                                      )
                                    ),
                                  }
                                )}
                              </Text>
                              {alternative.hasRawValue ? (
                                <Text
                                  style={styles.mergeMeta}
                                  selectable
                                >
                                  {t(
                                    'documentFieldReliabilityRawValue',
                                    {
                                      value: displayUnknownValue(
                                        alternative.rawValue
                                      ),
                                    }
                                  )}
                                </Text>
                              ) : null}
                              <Text style={styles.mergeMeta}>
                                {t(
                                  'documentFieldReliabilityConfidenceType',
                                  {
                                    type: t(
                                      reliabilityConfidenceTranslationKey(
                                        alternative.confidenceType
                                      )
                                    ),
                                  }
                                )}
                              </Text>
                              {alternative.confidence !== undefined ? (
                                <Text style={styles.mergeMeta}>
                                  {t('documentFieldMergeConfidence', {
                                    quality: Math.round(
                                      alternative.confidence * 100
                                    ),
                                  })}
                                </Text>
                              ) : null}
                            </View>
                          )
                        )}
                      </>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}

          {itemGroups.map((group, index) => (
            <View
              key={`items:${group.sourcePageIndex}:${index}`}
              style={styles.mergeField}
            >
              <Text style={styles.mergeFieldName}>
                {t(fieldTranslationKey('items'))}
              </Text>
              <Text style={styles.mergeFieldValue}>
                {t('documentFieldMergeItemCount', {
                  count: group.value.length,
                })}
              </Text>
              <Text style={styles.mergeMeta}>
                {t('documentFieldMergeProvenance', {
                  page: group.sourcePageIndex + 1,
                  method: t(methodTranslationKey(group.sourceMethod)),
                })}
              </Text>
              <Text style={styles.mergeMeta}>
                {t(reasonTranslationKey(group.reason))} ·{' '}
                {t(validationTranslationKey(group.validation))}
              </Text>
              {group.confidence !== undefined ? (
                <Text style={styles.mergeMeta}>
                  {t('documentFieldMergeConfidence', {
                    quality: Math.round(group.confidence * 100),
                  })}
                </Text>
              ) : null}
            </View>
          ))}

          {itemApplication ? (
            <View
              style={[
                styles.itemApplication,
                itemApplication.reason !==
                  'preserved_equivalent' &&
                (itemApplication.source ===
                  'existing_record' ||
                  itemApplication.reason ===
                    'incomplete_groups_excluded')
                  ? styles.itemApplicationAttention
                  : undefined,
              ]}
            >
              <Text style={styles.itemApplicationTitle}>
                {t('documentFieldMergeItemApplicationTitle')}
              </Text>
              <Text style={styles.itemApplicationText}>
                {t(
                  itemApplicationTranslationKey(
                    itemApplication
                  )
                )}
              </Text>
              {itemApplication.conflict ? (
                <View style={styles.itemConflictDetails}>
                  <Text style={styles.decisionSubheading}>
                    {t('documentFieldMergeItemsCurrentTitle', {
                      count:
                        itemApplication.conflict.currentItems
                          .length,
                    })}
                  </Text>
                  {renderItems(
                    itemApplication.conflict.currentItems,
                    'current-item'
                  )}

                  <Text style={styles.decisionSubheading}>
                    {t('documentFieldMergeItemsProposedTitle', {
                      count:
                        itemApplication.conflict.proposedItems
                          .length,
                    })}
                  </Text>
                  {renderItems(
                    itemApplication.conflict.proposedItems,
                    'proposed-item'
                  )}

                  <Text style={styles.decisionSubheading}>
                    {t('documentFieldMergeItemProposalSourcesTitle')}
                  </Text>
                  {itemApplication.conflict.proposalSources.map(
                    (source, index) => (
                      <View
                        key={`${source.sourcePageIndex}:${source.sourceMethod}:${index}`}
                        style={styles.proposalSource}
                      >
                        <Text style={styles.mergeMeta}>
                          {t('documentFieldMergeProvenance', {
                            page: source.sourcePageIndex + 1,
                            method: t(
                              methodTranslationKey(source.sourceMethod)
                            ),
                          })}
                        </Text>
                        <Text style={styles.mergeMeta}>
                          {t(reasonTranslationKey(source.reason))} ·{' '}
                          {t(
                            validationTranslationKey(source.validation)
                          )}
                        </Text>
                        {source.confidence !== undefined ? (
                          <Text style={styles.mergeMeta}>
                            {t('documentFieldMergeConfidence', {
                              quality: Math.round(
                                source.confidence * 100
                              ),
                            })}
                          </Text>
                        ) : null}
                      </View>
                    )
                  )}
                </View>
              ) : null}
            </View>
          ) : null}

          {extractedFieldGroups.length > 0 ? (
            <Text style={styles.sectionHeading}>
              {t('documentFieldMergeExtractedFieldsTitle')}
            </Text>
          ) : null}
          {extractedFieldGroups.map((group, groupIndex) => (
            <View
              key={`extracted:${group.sourcePageIndex}:${groupIndex}`}
              style={styles.mergeField}
            >
              <Text style={styles.mergeMeta}>
                {t('documentFieldMergeProvenance', {
                  page: group.sourcePageIndex + 1,
                  method: t(methodTranslationKey(group.sourceMethod)),
                })}
              </Text>
              <Text style={styles.mergeMeta}>
                {t(reasonTranslationKey(group.reason))} ·{' '}
                {t(validationTranslationKey(group.validation))}
              </Text>
              {Object.entries(group.value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, value]) => (
                  <View
                    key={`${group.sourcePageIndex}:${key}`}
                    style={styles.extractedFieldEntry}
                  >
                    <Text style={styles.extractedFieldKey} selectable>
                      {key}
                    </Text>
                    <Text style={styles.extractedFieldValue} selectable>
                      {value}
                    </Text>
                  </View>
                ))}
            </View>
          ))}

          {extractedFieldConflicts.length > 0 ? (
            <Text style={styles.conflictsHeading}>
              {t('documentFieldMergeExtractedConflictsTitle')}
            </Text>
          ) : null}
          {extractedFieldConflicts.map((conflict) => (
            <View
              key={`extracted-conflict:${conflict.key}`}
              style={styles.conflict}
            >
              <Text style={styles.conflictField} selectable>
                {conflict.key}
              </Text>
              <Text style={styles.conflictMessage}>
                {t('documentFieldMergeExtractedConflictPreserved')}
              </Text>

              <Text style={styles.decisionSubheading}>
                {t('documentFieldMergeCurrentValueLabel')}
              </Text>
              <Text style={styles.conflictValue} selectable>
                {conflict.currentValue}
              </Text>

              <View style={styles.conflictCandidate}>
                <Text style={styles.decisionSubheading}>
                  {t('documentFieldMergeCandidateValueLabel')}
                </Text>
                <Text style={styles.conflictValue} selectable>
                  {conflict.candidate.value}
                </Text>
                <Text style={styles.mergeMeta}>
                  {t('documentFieldMergeProvenance', {
                    page: conflict.candidate.sourcePageIndex + 1,
                    method: t(
                      methodTranslationKey(
                        conflict.candidate.sourceMethod
                      )
                    ),
                  })}
                </Text>
                <Text style={styles.mergeMeta}>
                  {t(reasonTranslationKey(conflict.candidate.reason))} ·{' '}
                  {t(
                    validationTranslationKey(
                      conflict.candidate.validation
                    )
                  )}
                </Text>
              </View>
            </View>
          ))}

          {scalarConflicts.length > 0 ? (
            <Text style={styles.conflictsHeading}>
              {t('documentFieldMergeConflictsTitle')}
            </Text>
          ) : null}
          {scalarConflicts.map((conflict) => (
            <View key={conflict.field} style={styles.conflict}>
              <Text style={styles.conflictField}>
                {t(fieldTranslationKey(conflict.field))}
              </Text>
              <Text style={styles.conflictMessage}>
                {t('documentFieldMergeConflictMessage')}
              </Text>
              {conflict.candidates.map((candidate, index) => (
                <View
                  key={`${candidate.sourcePageIndex}:${candidate.sourceMethod}:${candidate.normalizedValue}:${index}`}
                  style={styles.conflictCandidate}
                >
                  <Text style={styles.conflictValue} selectable>
                    {displayValue(candidate.value)}
                  </Text>
                  <Text style={styles.mergeMeta}>
                    {t('documentFieldMergeProvenance', {
                      page: candidate.sourcePageIndex + 1,
                      method: t(
                        methodTranslationKey(candidate.sourceMethod)
                      ),
                    })}
                  </Text>
                  <Text style={styles.mergeMeta}>
                    {t(validationTranslationKey(candidate.validation))}
                  </Text>
                  {candidate.confidence !== undefined ? (
                    <Text style={styles.mergeMeta}>
                      {t('documentFieldMergeConfidence', {
                        quality: Math.round(candidate.confidence * 100),
                      })}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ))}
        </View>
      ) : null}

      {ordered.length > 0 ? (
        <>
          <Text style={styles.heading}>{t('documentPageReviewTitle')}</Text>
          {ordered.map((result) => (
            <View
              key={`${result.pageIndex}:${result.imageUri}`}
              style={[
                styles.page,
                result.requiresReview ? styles.pageNeedsReview : undefined,
              ]}
            >
              <View style={styles.header}>
                <Text style={styles.pageTitle}>
                  {t('documentPageLabel', { page: result.pageIndex + 1 })}
                </Text>
                <Text style={styles.method}>
                  {t(methodTranslationKey(result.processingMethod))}
                </Text>
              </View>
              {result.ocrQuality ? (
                <OcrQualityIndicator
                  quality={result.ocrQuality}
                  compact
                />
              ) : null}
              {result.requiresReview ? (
                <Text style={styles.reviewLabel}>
                  {t('documentPageRequiresReview')}
                </Text>
              ) : null}
              {result.warnings.map((warning) => (
                <Text key={warning} style={styles.warning}>
                  {warning === PAGE_WARNING_EMPTY_TEXT
                    ? t('documentPageWarningEmpty')
                    : warning === PAGE_WARNING_CLOUD_FALLBACK
                      ? t('documentPageWarningFallback')
                      : warning === PAGE_WARNING_DUPLICATE
                        ? t('documentPageWarningDuplicate', {
                            page: (result.duplicateOf ?? 0) + 1,
                          })
                        : warning}
                </Text>
              ))}
              {result.error ? (
                <Text style={styles.error}>
                  {t('documentPageError', { error: result.error })}
                </Text>
              ) : null}
              {(() => {
                const layoutLines = structuredPages?.find(
                  (page) => page.pageIndex === result.pageIndex
                )?.lines;
                const formatted = formatOcrPageTextForDisplay(
                  result.rawText,
                  layoutLines
                );
                return (
                  <>
                    {formatted.reformatted ? (
                      <Text style={styles.displayHint}>
                        {t('documentPageOcrDisplayHint')}
                      </Text>
                    ) : null}
                    <Text style={styles.rawText} selectable>
                      {formatted.text.trim() || t('documentPageNoText')}
                    </Text>
                  </>
                );
              })()}
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 14,
    gap: 8,
  },
  heading: {
    ...typography.heading3,
    color: colors.textPrimary,
  },
  merge: {
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.infoSurface,
    gap: 7,
  },
  mergeNeedsReview: {
    borderColor: colors.warning,
    backgroundColor: colors.warningSurface,
  },
  mergeHeading: {
    ...typography.heading3,
    color: colors.textPrimary,
  },
  mergeReviewLabel: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.warning,
  },
  sectionHeading: {
    ...typography.label,
    marginTop: 3,
    color: colors.textSecondary,
  },
  mergeField: {
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: radii.sm,
    padding: spacing.sm,
    backgroundColor: colors.surface,
  },
  mergeFieldConflict: {
    borderColor: colors.warning,
  },
  mergeFieldName: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  decisionLabel: {
    ...typography.caption,
    marginTop: 5,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  mergeFieldValue: {
    ...typography.bodySecondary,
    marginTop: 2,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  absentValue: {
    ...typography.bodySecondary,
    marginTop: 3,
    fontWeight: '700',
    fontStyle: 'italic',
    color: colors.warning,
  },
  appliedDecision: {
    marginTop: 7,
    paddingTop: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.info,
  },
  appliedDecisionPreserved: {
    borderTopColor: colors.warning,
  },
  appliedDecisionLabel: {
    color: colors.info,
  },
  preservedDecisionLabel: {
    color: colors.warning,
  },
  mergeMeta: {
    ...typography.caption,
    marginTop: 3,
    color: colors.textSecondary,
  },
  reliabilityDetails: {
    marginTop: 7,
    paddingTop: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  reliabilityHeading: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  missingSummary: {
    ...typography.caption,
    marginTop: 4,
    color: colors.textSecondary,
  },
  reliabilityMissing: {
    ...typography.caption,
    marginTop: 4,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  reliabilityAttention: {
    ...typography.caption,
    marginTop: 4,
    fontWeight: '700',
    color: colors.warning,
  },
  reliabilityAlternative: {
    marginTop: 5,
    padding: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    backgroundColor: colors.surfaceMuted,
  },
  itemApplication: {
    borderWidth: 1,
    borderColor: colors.info,
    borderRadius: 8,
    padding: 8,
    backgroundColor: colors.infoSurface,
  },
  itemApplicationAttention: {
    borderColor: colors.warning,
    backgroundColor: colors.warningSurface,
  },
  itemApplicationTitle: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  itemApplicationText: {
    ...typography.caption,
    marginTop: 3,
    color: colors.textSecondary,
  },
  itemConflictDetails: {
    marginTop: 8,
    paddingTop: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.warning,
  },
  decisionSubheading: {
    ...typography.caption,
    marginTop: 7,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  itemList: {
    marginTop: 3,
    gap: 4,
  },
  itemEntry: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 6,
    backgroundColor: colors.surface,
  },
  itemDescription: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  proposalSource: {
    marginTop: 3,
    paddingTop: 3,
  },
  extractedFieldEntry: {
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.info,
    paddingTop: 6,
  },
  extractedFieldKey: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  extractedFieldValue: {
    ...typography.bodySecondary,
    marginTop: 2,
    color: colors.textPrimary,
  },
  conflictsHeading: {
    ...typography.label,
    marginTop: 5,
    fontWeight: '700',
    color: colors.danger,
  },
  conflict: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radii.sm,
    padding: spacing.sm,
    backgroundColor: colors.dangerSurface,
  },
  conflictField: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.danger,
  },
  conflictMessage: {
    ...typography.caption,
    marginTop: 3,
    color: colors.danger,
  },
  conflictCandidate: {
    marginTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.danger,
    paddingTop: 6,
  },
  conflictValue: {
    ...typography.bodySecondary,
    fontWeight: '600',
    color: colors.danger,
  },
  page: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceMuted,
  },
  pageNeedsReview: {
    borderColor: colors.warning,
    backgroundColor: colors.warningSurface,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  pageTitle: {
    ...typography.label,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  method: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  reviewLabel: {
    ...typography.caption,
    marginTop: 5,
    fontWeight: '700',
    color: colors.warning,
  },
  warning: {
    ...typography.caption,
    marginTop: 4,
    color: colors.warning,
  },
  error: {
    ...typography.caption,
    marginTop: 4,
    color: colors.danger,
  },
  displayHint: {
    ...typography.caption,
    marginTop: 6,
    color: colors.info,
    fontStyle: 'italic',
  },
  rawText: {
    ...typography.caption,
    marginTop: 7,
    color: colors.textSecondary,
  },
});

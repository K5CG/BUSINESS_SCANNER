import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AnyDocument } from '../types';
import {
  buildDocumentDetailsViewModel,
  type DocumentDetailField,
} from '../lib/document-details-view-model';
import type { DocumentUserEditableField } from '../lib/document-field-merge-application';
import { EditableField } from './EditableField';
import { colors } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';

interface Props {
  document: Exclude<AnyDocument, { type: 'business_card' }>;
  onFieldChange: (field: DocumentUserEditableField, value: string) => void;
  onFocus?: () => void;
  editable?: boolean;
  afterSummary?: React.ReactNode;
}

function ReadOnlyField({ field }: { field: DocumentDetailField }) {
  const { t } = useTranslation();
  return (
    <View
      style={[
        styles.readOnlyField,
        (field.requiresReview || field.conflict) && styles.reviewBorder,
      ]}
    >
      <Text style={styles.fieldLabel}>{t(field.labelKey)}</Text>
      <Text style={styles.fieldValue} selectable>
        {field.value}
      </Text>
      {field.requiresReview || field.conflict ? (
        <Text style={styles.reviewText}>
          {t(field.conflict ? 'documentDetailsConflict' : 'documentDetailsVerify')}
          {field.sourcePage
            ? ` · ${t('documentDetailsSourcePage', { page: field.sourcePage })}`
            : ''}
        </Text>
      ) : null}
    </View>
  );
}

export function DocumentStructuredDetails({
  document,
  onFieldChange,
  onFocus,
  editable = true,
  afterSummary,
}: Props) {
  const { t, i18n } = useTranslation();
  const viewModel = buildDocumentDetailsViewModel(document, i18n.language);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
  const [expandedItemSections, setExpandedItemSections] = useState<Record<string, boolean>>({});

  const toggleItem = (itemId: string) => {
    setExpandedItems((current) => ({
      ...current,
      [itemId]: !current[itemId],
    }));
  };

  return (
    <View style={styles.container}>
      {viewModel.sections.map((section, sectionIndex) => (
        <React.Fragment key={section.id}>
        <View style={styles.sectionCard}>
          {section.items.length ? (
            <TouchableOpacity
              style={styles.itemSectionHeader}
              onPress={() =>
                setExpandedItemSections((current) => ({
                  ...current,
                  [section.id]: !current[section.id],
                }))
              }
              accessibilityRole="button"
              accessibilityState={{ expanded: !!expandedItemSections[section.id] }}
            >
              <View style={styles.itemSectionHeaderText}>
                <Text style={styles.sectionTitle}>{t(section.titleKey)}</Text>
                <Text style={styles.itemSectionMeta}>
                  {t('documentDetailsRowsCount', {
                    count: section.items.length,
                  })}
                </Text>
              </View>
              <Text style={styles.itemChevron}>
                {expandedItemSections[section.id] ? '⌃' : '⌄'}
              </Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.sectionTitle}>{t(section.titleKey)}</Text>
          )}
          {section.fields.map((field) =>
            field.editableField ? (
              <View key={field.id}>
                <EditableField
                  label={t(field.labelKey)}
                  value={field.value}
                  onChangeText={(value) => onFieldChange(field.editableField!, value)}
                  onFocus={onFocus}
                  keyboardType={
                    field.editableField === 'subtotal' ||
                    field.editableField === 'vatAmount' ||
                    field.editableField === 'total'
                      ? 'decimal-pad'
                      : undefined
                  }
                  reviewHighlight={field.requiresReview || field.conflict}
                  editable={editable}
                />
                {field.requiresReview || field.conflict ? (
                  <Text style={styles.inlineReviewText}>
                    {t(field.conflict ? 'documentDetailsConflict' : 'documentDetailsVerify')}
                    {field.sourcePage
                      ? ` · ${t('documentDetailsSourcePage', { page: field.sourcePage })}`
                      : ''}
                  </Text>
                ) : null}
              </View>
            ) : (
              <ReadOnlyField key={field.id} field={field} />
            )
          )}
          {(!section.items.length || expandedItemSections[section.id])
            ? section.items.map((item, index) => {
            const expanded = !!expandedItems[item.id];
            const description = item.fields.find((entry) => entry.labelKey === 'documentDetailsDescription');
            const quantity = item.fields.find((entry) => entry.labelKey === 'documentDetailsQuantity');
            const lineTotal = item.fields.find((entry) => entry.labelKey === 'documentDetailsLineTotal');
            const compactParts = [
              description?.value,
              quantity ? `${t(quantity.labelKey)}: ${quantity.value}` : undefined,
              lineTotal ? `${t(lineTotal.labelKey)}: ${lineTotal.value}` : undefined,
            ].filter((value): value is string => !!value);

            return (
              <View
                key={item.id}
                style={[
                  styles.itemCard,
                  (item.requiresReview || item.conflict) && styles.reviewBorder,
                ]}
              >
                <TouchableOpacity
                  style={styles.itemCompactHeader}
                  onPress={() => toggleItem(item.id)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                >
                  <View style={styles.itemCompactText}>
                    <Text style={styles.itemTitle}>
                      {t('documentDetailsItemNumber', { number: index + 1 })}
                    </Text>
                    {compactParts.length ? (
                      <Text style={styles.itemSummary} numberOfLines={expanded ? undefined : 2}>
                        {compactParts.join(' · ')}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.itemChevron}>{expanded ? '⌃' : '⌄'}</Text>
                </TouchableOpacity>
                {expanded ? (
                  <>
                    {item.fields.map((entry) => (
                      <View key={entry.labelKey} style={styles.itemField}>
                        <Text style={styles.itemLabel}>{t(entry.labelKey)}</Text>
                        <Text style={styles.itemValue} selectable>
                          {entry.value}
                        </Text>
                      </View>
                    ))}
                    {item.requiresReview || item.conflict ? (
                      <Text style={styles.reviewText}>
                        {t(item.conflict ? 'documentDetailsConflict' : 'documentDetailsVerify')}
                      </Text>
                    ) : null}
                  </>
                ) : item.requiresReview || item.conflict ? (
                  <Text style={styles.reviewText}>
                    {t(item.conflict ? 'documentDetailsConflict' : 'documentDetailsVerify')}
                  </Text>
                ) : null}
              </View>
            );
          })
            : null}
        </View>
        {sectionIndex === 0 ? afterSummary : null}
        </React.Fragment>
      ))}

    </View>
  );
}

export function DocumentReviewAlerts({
  document,
}: {
  document: Exclude<AnyDocument, { type: 'business_card' }>;
}) {
  const { t, i18n } = useTranslation();
  const alerts = buildDocumentDetailsViewModel(document, i18n.language).reviewAlerts;
  if (!alerts.length) return null;
  return (
    <View style={styles.alertCard}>
      <Text style={styles.alertTitle}>{t('documentDetailsReviewSection')}</Text>
      {alerts.map((alert) => (
        <View key={alert.id} style={styles.alertEntry}>
          <Text style={styles.alertText}>
            • {t(alert.labelKey)}: {t(alert.conflict ? 'documentDetailsConflict' : 'documentDetailsVerify')}
            {alert.validationStatus
              ? ` · ${t(`documentDetailsStatus_${alert.validationStatus}`)}`
              : ''}
            {alert.sourcePage
              ? ` · ${t('documentDetailsSourcePage', { page: alert.sourcePage })}`
              : ''}
          </Text>
          {alert.alternatives.length ? (
            <Text style={styles.alternativeText} selectable>
              {t('documentDetailsAlternatives', {
                values: alert.alternatives.join(' · '),
              })}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  sectionCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    padding: spacing.lg,
  },
  itemSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  itemSectionHeaderText: { flex: 1 },
  itemSectionMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  sectionTitle: {
    ...typography.heading3,
    color: colors.textPrimary,
    marginBottom: spacing.md,
  },
  readOnlyField: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingVertical: spacing.sm,
  },
  fieldLabel: { ...typography.label, color: colors.textSecondary },
  fieldValue: {
    ...typography.body,
    color: colors.textPrimary,
    marginTop: spacing.xs,
    flexShrink: 1,
  },
  reviewBorder: { borderColor: colors.warning },
  reviewText: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  inlineReviewText: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '700',
    marginTop: -spacing.md,
    marginBottom: spacing.lg,
  },
  itemCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceMuted,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  itemCompactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  itemCompactText: { flex: 1, minWidth: 0 },
  itemTitle: { ...typography.label, color: colors.textPrimary, marginBottom: spacing.xs },
  itemSummary: { ...typography.bodySecondary, color: colors.textSecondary, flexShrink: 1 },
  itemChevron: { ...typography.heading3, color: colors.primary, marginLeft: spacing.sm },
  itemField: { marginBottom: spacing.sm, marginTop: spacing.xs },
  itemLabel: { ...typography.caption, color: colors.textSecondary },
  itemValue: { ...typography.bodySecondary, color: colors.textPrimary, flexShrink: 1 },
  alertCard: {
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radii.lg,
    backgroundColor: colors.warningSurface,
    padding: spacing.lg,
  },
  alertTitle: { ...typography.heading3, color: colors.textPrimary, marginBottom: spacing.sm },
  alertEntry: { marginTop: spacing.xs },
  alertText: { ...typography.bodySecondary, color: colors.textPrimary, marginTop: spacing.xs },
  alternativeText: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    flexShrink: 1,
  },
});

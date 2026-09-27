import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import type { ReconciledField } from '../lib/document-ai-reconciler';
import type { HybridDocumentReviewState } from '../lib/document-hybrid-review';
import { hybridFieldCanAccept } from '../lib/document-hybrid-review';
import { colors } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';

interface Props {
  state: HybridDocumentReviewState;
  onDecision: (path: string, decision: 'accepted' | 'rejected' | 'manual') => void;
  onManualValue: (path: string, value: unknown) => void;
  onAcceptAll: () => void;
  acceptAllDisabled?: boolean;
}

type ReviewGroupId = 'document' | 'parties' | 'totals' | 'other' | 'items';

type ScalarEntry = [string, ReconciledField<unknown>];

const display = (value: unknown): string => {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.map(display).join(' · ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => `${key}: ${String(entry)}`)
      .join(', ');
  }
  return String(value);
};

const editablePrimitive = (field: ReconciledField<unknown>): boolean => {
  const value = field.selectedValue ?? field.localValue ?? field.aiValue;
  return value == null || ['string', 'number', 'boolean'].includes(typeof value);
};

const itemFieldEntries = (item: HybridDocumentReviewState['reconciliation']['items'][number]) => [
  ['itemCode', 'documentDetailsItemCode', item.itemCode],
  ['description', 'documentDetailsDescription', item.description],
  ['quantity', 'documentDetailsQuantity', item.quantity],
  ['unit', 'documentDetailsUnit', item.unit],
  ['unitPrice', 'documentDetailsUnitPrice', item.unitPrice],
  ['discount', 'documentDetailsDiscount', item.discount],
  ['taxableAmount', 'documentDetailsTaxableAmount', item.taxableAmount],
  ['vatRate', 'documentDetailsVatRate', item.vatRate],
  ['lineTotal', 'documentDetailsLineTotal', item.lineTotal],
  ['currency', 'documentDetailsCurrency', item.currency],
] as const;

const groupForPath = (path: string): Exclude<ReviewGroupId, 'items'> => {
  if (/(issuer|supplier|vendor|seller|customer|buyer|recipient|sender|party|registration|taxId|vatNumber|fiscal)/i.test(path)) {
    return 'parties';
  }
  if (/(subtotal|grandTotal|total|vatAmount|vatRate|taxable|discount|currency|amount|tax)/i.test(path)) {
    return 'totals';
  }
  if (/(document|number|issueDate|dueDate|date|pageCount|reference|subject|order|invoice|quote)/i.test(path)) {
    return 'document';
  }
  return 'other';
};

export function DocumentHybridReview({
  state,
  onDecision,
  onManualValue,
  onAcceptAll,
  acceptAllDisabled = false,
}: Props) {
  const { t } = useTranslation();
  const [manualPath, setManualPath] = useState<string | null>(null);
  const [manualScalar, setManualScalar] = useState('');
  const [manualItem, setManualItem] = useState<Record<string, string>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<ReviewGroupId, boolean>>({
    document: false,
    parties: false,
    totals: false,
    other: false,
    items: false,
  });
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});

  const fields = Object.entries(state.reconciliation.fields).filter(([, field]) => field.status !== 'missing') as ScalarEntry[];

  const groupedFields = useMemo(() => {
    const groups: Record<Exclude<ReviewGroupId, 'items'>, ScalarEntry[]> = {
      document: [],
      parties: [],
      totals: [],
      other: [],
    };
    fields.forEach((entry) => groups[groupForPath(entry[0])].push(entry));
    return groups;
  }, [fields]);

  const decisionCounts = useMemo(() => {
    const paths = [
      ...fields.map(([path]) => path),
      ...state.reconciliation.items.map((item) => `items.${item.index}`),
    ];
    return paths.reduce(
      (counts, path) => {
        const decision = state.decisions[path] ?? 'pending';
        if (decision === 'accepted') counts.accepted += 1;
        else if (decision === 'rejected') counts.rejected += 1;
        else if (decision === 'manual') counts.manual += 1;
        else counts.pending += 1;
        return counts;
      },
      { pending: 0, accepted: 0, rejected: 0, manual: 0 }
    );
  }, [fields, state.decisions, state.reconciliation.items]);

  const decisionLabel = (decision: string | undefined) => {
    if (!decision) return t('documentHybridPending');
    return t(`documentHybridDecision_${decision}`);
  };

  const openScalarManual = (path: string, field: ReconciledField<unknown>) => {
    setManualScalar(display(field.selectedValue ?? field.localValue ?? field.aiValue).replace(/^—$/, ''));
    setManualItem({});
    setManualPath(path);
  };

  const openItemManual = (path: string, item: HybridDocumentReviewState['reconciliation']['items'][number]) => {
    const values: Record<string, string> = {};
    itemFieldEntries(item).forEach(([key, , field]) => {
      const value = field.selectedValue ?? field.localValue ?? field.aiValue;
      if (value !== undefined && value !== null) values[key] = String(value);
    });
    setManualScalar('');
    setManualItem(values);
    setManualPath(path);
  };

  const closeManual = () => {
    setManualPath(null);
    setManualScalar('');
    setManualItem({});
  };

  const numericItemKeys = useMemo(
    () => new Set(['quantity', 'unitPrice', 'discount', 'taxableAmount', 'vatRate', 'lineTotal']),
    []
  );

  const toggleGroup = (group: ReviewGroupId) => {
    setExpandedGroups((current) => ({ ...current, [group]: !current[group] }));
  };

  const groupPendingCount = (paths: string[]) =>
    paths.filter((path) => !state.decisions[path] || state.decisions[path] === 'pending').length;

  const renderScalarCard = ([path, field]: ScalarEntry) => {
    const manualOpen = manualPath === path;
    const canManualEdit = editablePrimitive(field);
    const decision = state.decisions[path];
    return (
      <View key={path} style={[styles.card, field.status === 'conflict' && styles.conflict]}>
        <Text style={styles.fieldName}>{t(`documentHybridField_${path}`)}</Text>
        <Text style={styles.status}>{t(`documentHybridStatus_${field.status}`)}</Text>
        <Text style={styles.value}>{t('documentHybridLocal')}: {display(field.localValue)}</Text>
        <Text style={styles.value}>{t('documentHybridAi')}: {display(field.aiValue)}</Text>
        {field.aiEvidence ? <Text style={styles.evidence}>{t('documentHybridEvidence')}: {field.aiEvidence}</Text> : null}
        <Text style={styles.decision}>{decisionLabel(decision)}</Text>

        {manualOpen ? (
          <View style={styles.manualEditor}>
            <TextInput
              autoFocus
              style={styles.manualInput}
              value={manualScalar}
              onChangeText={setManualScalar}
              keyboardType={typeof (field.selectedValue ?? field.localValue ?? field.aiValue) === 'number' ? 'decimal-pad' : 'default'}
              selectTextOnFocus
              accessibilityLabel={t(`documentHybridField_${path}`)}
            />
            <View style={styles.manualEditorActions}>
              <TouchableOpacity style={styles.manualCancel} onPress={closeManual} accessibilityRole="button">
                <Text style={styles.manualText}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.accept}
                onPress={() => {
                  onManualValue(path, manualScalar);
                  closeManual();
                }}
                accessibilityRole="button"
              >
                <Text style={styles.acceptText}>{t('documentHybridApply')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.actions}>
            {canManualEdit ? (
              <TouchableOpacity accessibilityRole="button" style={styles.manual} onPress={() => openScalarManual(path, field)}>
                <Ionicons name="create-outline" size={18} color={colors.primary} accessible={false} />
                <Text style={styles.manualText}>{t('documentHybridManual')}</Text>
              </TouchableOpacity>
            ) : null}
            {decision !== 'rejected' ? (
              <TouchableOpacity accessibilityRole="button" style={styles.reject} onPress={() => onDecision(path, 'rejected')}>
                <Ionicons name="arrow-undo-outline" size={18} color={colors.textSecondary} accessible={false} />
                <Text style={styles.rejectText}>{t('documentHybridReject')}</Text>
              </TouchableOpacity>
            ) : null}
            {decision !== 'accepted' && hybridFieldCanAccept(state, path) ? (
              <TouchableOpacity accessibilityRole="button" style={styles.accept} onPress={() => onDecision(path, 'accepted')}>
                <Text style={styles.acceptText}>{t('documentHybridAccept')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </View>
    );
  };

  const renderGroup = (
    id: Exclude<ReviewGroupId, 'items'>,
    title: string,
    entries: ScalarEntry[]
  ) => {
    if (!entries.length) return null;
    const expanded = expandedGroups[id];
    const pending = groupPendingCount(entries.map(([path]) => path));
    return (
      <View style={styles.group} key={id}>
        <TouchableOpacity
          style={styles.groupHeader}
          onPress={() => toggleGroup(id)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
        >
          <View style={styles.groupHeaderText}>
            <Text style={styles.groupTitle}>{title}</Text>
            <Text style={styles.groupMeta}>
              {t('documentHybridGroupMeta', {
                count: entries.length,
                pending
              })}
            </Text>
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={20} color={colors.primary} />
        </TouchableOpacity>
        {expanded ? <View style={styles.groupContent}>{entries.map(renderScalarCard)}</View> : null}
      </View>
    );
  };

  const items = state.reconciliation.items;
  const itemsExpanded = expandedGroups.items;
  const itemPaths = items.map((item) => `items.${item.index}`);

  return (
    <View style={styles.container}>
      <View style={styles.reviewHeader}>
        <Text style={styles.title}>{t('documentHybridReviewTitle')}</Text>
        <Text style={styles.description}>
          {t('documentHybridReviewDescription', {
          })}
        </Text>
        <Text style={styles.summary}>
          {t('documentHybridReviewSummary', {
            pending: decisionCounts.pending,
            accepted: decisionCounts.accepted,
            rejected: decisionCounts.rejected,
            manual: decisionCounts.manual
          })}
        </Text>
      </View>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={t('documentHybridAcceptAll')}
        style={[styles.acceptAll, acceptAllDisabled && styles.acceptAllDisabled]}
        onPress={onAcceptAll}
        disabled={acceptAllDisabled}
      >
        <Text style={styles.acceptAllText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.72}>
          {t('documentHybridAcceptAll')}
        </Text>
      </TouchableOpacity>
      <Text style={styles.acceptAllHint}>
        {t('documentHybridAcceptAllHint')}
      </Text>

      {renderGroup('document', t('documentHybridGroupDocument'), groupedFields.document)}
      {renderGroup('parties', t('documentHybridGroupParties'), groupedFields.parties)}
      {renderGroup('totals', t('documentHybridGroupTotals'), groupedFields.totals)}
      {renderGroup('other', t('documentHybridGroupOther'), groupedFields.other)}

      {items.length ? (
        <View style={styles.group}>
          <TouchableOpacity
            style={styles.groupHeader}
            onPress={() => toggleGroup('items')}
            accessibilityRole="button"
            accessibilityState={{ expanded: itemsExpanded }}
          >
            <View style={styles.groupHeaderText}>
              <Text style={styles.groupTitle}>{t('documentHybridGroupItems')}</Text>
              <Text style={styles.groupMeta}>
                {t('documentHybridGroupMeta', {
                  count: items.length,
                  pending: groupPendingCount(itemPaths)
                })}
              </Text>
            </View>
            <Ionicons name={itemsExpanded ? 'chevron-up' : 'chevron-down'} size={20} color={colors.primary} />
          </TouchableOpacity>
          {itemsExpanded ? (
            <View style={styles.groupContent}>
              {items.map((item) => {
                const path = `items.${item.index}`;
                const manualOpen = manualPath === path;
                const expanded = !!expandedItems[path] || manualOpen;
                const itemFields = itemFieldEntries(item);
                const description = item.description.aiValue ?? item.description.localValue;
                const quantity = item.quantity.aiValue ?? item.quantity.localValue;
                const lineTotal = item.lineTotal.aiValue ?? item.lineTotal.localValue;
                const compact = [description, quantity != null ? `Q.tà ${display(quantity)}` : null, lineTotal != null ? `Tot. ${display(lineTotal)}` : null]
                  .filter(Boolean)
                  .join(' · ');
                const decision = state.decisions[path];
                return (
                  <View key={path} style={[styles.card, item.requiresReview && styles.conflict]}>
                    <TouchableOpacity
                      style={styles.itemHeader}
                      onPress={() => setExpandedItems((current) => ({ ...current, [path]: !current[path] }))}
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                    >
                      <View style={styles.itemHeaderText}>
                        <Text style={styles.fieldName}>{t('documentDetailsItemNumber', { number: item.index + 1 })}</Text>
                        {compact ? <Text style={styles.itemSummary} numberOfLines={2}>{compact}</Text> : null}
                        <Text style={styles.decision}>{decisionLabel(decision)}</Text>
                      </View>
                      <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.primary} />
                    </TouchableOpacity>

                    {expanded ? (
                      <>
                        {itemFields.map(([, label, value]) => value.localValue !== undefined || value.aiValue !== undefined ? (
                          <Text key={label} style={styles.value}>
                            {t(label)}: {t('documentHybridLocal')} {display(value.localValue)} · {t('documentHybridAi')} {display(value.aiValue)}
                          </Text>
                        ) : null)}

                        {manualOpen ? (
                          <View style={styles.manualEditor}>
                            {itemFields.map(([key, label, field]) => {
                              const hasValue = field.localValue !== undefined || field.aiValue !== undefined || field.selectedValue !== undefined;
                              if (!hasValue) return null;
                              return (
                                <View key={key} style={styles.itemManualField}>
                                  <Text style={styles.itemManualLabel}>{t(label)}</Text>
                                  <TextInput
                                    style={styles.manualInput}
                                    value={manualItem[key] ?? ''}
                                    onChangeText={(value) => setManualItem((current) => ({ ...current, [key]: value }))}
                                    keyboardType={numericItemKeys.has(key) ? 'decimal-pad' : 'default'}
                                    selectTextOnFocus
                                  />
                                </View>
                              );
                            })}
                            <View style={styles.manualEditorActions}>
                              <TouchableOpacity style={styles.manualCancel} onPress={closeManual} accessibilityRole="button">
                                <Text style={styles.manualText}>{t('cancel')}</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.accept}
                                onPress={() => {
                                  onManualValue(path, manualItem);
                                  closeManual();
                                }}
                                accessibilityRole="button"
                              >
                                <Text style={styles.acceptText}>{t('documentHybridApply')}</Text>
                              </TouchableOpacity>
                            </View>
                          </View>
                        ) : (
                          <View style={styles.actions}>
                            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${t('documentHybridManual')} ${item.index + 1}`} style={styles.manual} onPress={() => openItemManual(path, item)}>
                              <Ionicons name="create-outline" size={18} color={colors.primary} accessible={false} />
                              <Text style={styles.manualText}>{t('documentHybridManual')}</Text>
                            </TouchableOpacity>
                            {decision !== 'rejected' ? (
                              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${t('documentHybridReject')} ${item.index + 1}`} style={styles.reject} onPress={() => onDecision(path, 'rejected')}>
                                <Ionicons name="arrow-undo-outline" size={18} color={colors.textSecondary} accessible={false} />
                                <Text style={styles.rejectText}>{t('documentHybridReject')}</Text>
                              </TouchableOpacity>
                            ) : null}
                            {decision !== 'accepted' && hybridFieldCanAccept(state, path) ? (
                              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${t('documentHybridAccept')} ${item.index + 1}`} style={styles.accept} onPress={() => onDecision(path, 'accepted')}>
                                <Text style={styles.acceptText}>{t('documentHybridAccept')}</Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        )}
                      </>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm, marginBottom: spacing.lg, marginTop: spacing.md },
  reviewHeader: { gap: spacing.xs, paddingBottom: spacing.xs },
  title: { ...typography.heading3, color: colors.textPrimary },
  description: { ...typography.bodySecondary, color: colors.textSecondary, flexShrink: 1 },
  summary: { ...typography.caption, color: colors.textPrimary, marginTop: spacing.xs },
  group: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.surface, overflow: 'hidden' },
  groupHeader: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  groupHeaderText: { flex: 1 },
  groupTitle: { ...typography.label, color: colors.textPrimary },
  groupMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  groupContent: { gap: spacing.sm, padding: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  card: { borderWidth: 1, borderColor: colors.info, borderRadius: radii.md, padding: spacing.md, backgroundColor: colors.infoSurface },
  conflict: { borderColor: colors.warning, backgroundColor: colors.warningSurface },
  fieldName: { ...typography.label, color: colors.textPrimary },
  status: { ...typography.caption, color: colors.warning, marginTop: spacing.xs },
  decision: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs },
  value: { ...typography.bodySecondary, color: colors.textPrimary, marginTop: spacing.xs, flexShrink: 1 },
  evidence: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.xs, flexShrink: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  reject: { minHeight: 44, flexGrow: 1, flexDirection: 'row', gap: spacing.xs, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: spacing.md, backgroundColor: colors.surface },
  accept: { minHeight: 44, flexGrow: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.md },
  acceptAll: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.sm, marginTop: spacing.xs },
  acceptAllText: { ...typography.label, color: colors.primary, textAlign: 'center' },
  acceptAllHint: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.xs },
  acceptAllDisabled: { opacity: 0.5 },
  manual: { minHeight: 44, flexGrow: 1, flexDirection: 'row', gap: spacing.xs, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.md },
  manualCancel: { minHeight: 44, flexGrow: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.md },
  rejectText: { ...typography.label, color: colors.textSecondary },
  acceptText: { ...typography.label, color: colors.textOnPrimary },
  manualText: { ...typography.label, color: colors.primary },
  manualEditor: { marginTop: spacing.md, gap: spacing.sm },
  manualInput: { ...typography.input, minHeight: 44, borderWidth: 1, borderColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.textPrimary, backgroundColor: colors.surface },
  manualEditorActions: { flexDirection: 'row', gap: spacing.sm },
  itemManualField: { gap: spacing.xs },
  itemManualLabel: { ...typography.caption, color: colors.textSecondary },
  itemHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  itemHeaderText: { flex: 1 },
  itemSummary: { ...typography.bodySecondary, color: colors.textPrimary, marginTop: spacing.xs },
});

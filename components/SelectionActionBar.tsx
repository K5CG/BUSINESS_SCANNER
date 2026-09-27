import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { colors } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';

interface Props {
  count: number;
  allVisibleSelected: boolean;
  someVisibleSelected?: boolean;
  onSelectAll: () => void;
  onDeselectVisible: () => void;
  onDismiss: () => void;
  onDelete: () => void;
  busy?: boolean;
  busyLabel?: string;
}

export function SelectionActionBar({
  count,
  allVisibleSelected,
  someVisibleSelected = false,
  onSelectAll,
  onDeselectVisible,
  onDismiss,
  onDelete,
  busy = false,
  busyLabel,
}: Props) {
  const { t } = useTranslation();
  if (count <= 0) return null;

  const mixed = someVisibleSelected && !allVisibleSelected;
  const checked: boolean | 'mixed' = allVisibleSelected ? true : mixed ? 'mixed' : false;
  const deleteDisabled = busy || count === 0;

  return (
    <View
      style={styles.bar}
      accessibilityLiveRegion="polite"
      accessibilityLabel={busyLabel}
    >
      <TouchableOpacity
        style={styles.closeButton}
        onPress={onDismiss}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={t('selectionClear')}
        accessibilityState={{ disabled: busy }}
        hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
      >
        <Ionicons name="close" size={18} color={busy ? colors.textDisabled : colors.textSecondary} />
      </TouchableOpacity>

      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={1}>
          {t('selectionSelectedTitle')}
        </Text>
        <Text style={styles.title} numberOfLines={1}>
          {t('selectionSelectAllShort')}
        </Text>
        <Text style={styles.title} numberOfLines={1}>
          {t('delete')}
        </Text>
      </View>

      <View style={styles.controlRow}>
        <View style={styles.cell}>
          <Text
            style={styles.count}
            numberOfLines={1}
            accessibilityRole="text"
            accessibilityLabel={`${t('selectionSelectedTitle')} ${count}`}
          >
            {String(count)}
          </Text>
        </View>

        <View style={styles.cell}>
          <TouchableOpacity
            style={styles.controlHit}
            onPress={() => {
              if (allVisibleSelected) onDeselectVisible();
              else onSelectAll();
            }}
            disabled={busy}
            accessibilityRole="checkbox"
            accessibilityLabel={t('selectionSelectAll')}
            accessibilityState={{ checked, disabled: busy }}
          >
            {allVisibleSelected ? (
              <Ionicons name="checkbox" size={26} color={busy ? colors.textDisabled : colors.primary} />
            ) : mixed ? (
              <View
                style={[styles.indeterminateBox, busy && styles.indeterminateBoxBusy]}
                accessibilityElementsHidden
                importantForAccessibility="no"
              >
                <View style={[styles.indeterminateDash, busy && styles.indeterminateDashBusy]} />
              </View>
            ) : (
              <Ionicons name="square-outline" size={26} color={busy ? colors.textDisabled : colors.primary} />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.cell}>
          <TouchableOpacity
            style={[styles.deleteButton, deleteDisabled && styles.deleteButtonDisabled]}
            onPress={onDelete}
            disabled={deleteDisabled}
            accessibilityRole="button"
            accessibilityLabel={t('selectionDelete')}
            accessibilityState={{ disabled: deleteDisabled }}
          >
            {busy ? (
              <ActivityIndicator size="small" color={colors.textOnPrimary} />
            ) : (
              <Ionicons name="trash-outline" size={18} color={colors.textOnPrimary} />
            )}
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const CONTROL_SIZE = 40;

const styles = StyleSheet.create({
  bar: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingLeft: spacing.sm,
    paddingRight: 28,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radii.md,
  },
  closeButton: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 18,
  },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xs,
  },
  title: {
    ...typography.caption,
    flex: 1,
    color: colors.textSecondary,
    fontWeight: '600',
    textAlign: 'center',
  },
  cell: {
    flex: 1,
    height: CONTROL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: {
    fontSize: 22,
    lineHeight: 26,
    color: colors.textPrimary,
    fontWeight: '700',
    textAlign: 'center',
    minWidth: 28,
    flexShrink: 0,
  },
  controlHit: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indeterminateBox: {
    width: 22,
    height: 22,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indeterminateBoxBusy: {
    borderColor: colors.textDisabled,
  },
  indeterminateDash: {
    width: 12,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.primary,
  },
  indeterminateDashBusy: {
    backgroundColor: colors.textDisabled,
  },
  deleteButton: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: radii.sm,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButtonDisabled: {
    opacity: 0.45,
  },
});

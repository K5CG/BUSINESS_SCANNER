import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import type { ContactExportSortMode } from '../lib/contact-export-sort';
import { colors } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';

interface Props {
  value: ContactExportSortMode;
  onChange: (mode: ContactExportSortMode) => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}

const GROUPS = [
  {
    criterion: 'date',
    labelKey: 'contactsSortDate',
    directions: [
      { mode: 'oldest', icon: 'arrow-up', labelKey: 'exportSortOldest', hintKey: 'sortDateAscendingHint' },
      { mode: 'newest', icon: 'arrow-down', labelKey: 'exportSortNewest', hintKey: 'sortDateDescendingHint' },
    ],
  },
  {
    criterion: 'name',
    labelKey: 'contactsSortName',
    directions: [
      { mode: 'name-asc', icon: 'arrow-up', labelKey: 'exportSortNameAsc', hintKey: 'sortNameAscendingHint' },
      { mode: 'name-desc', icon: 'arrow-down', labelKey: 'exportSortNameDesc', hintKey: 'sortNameDescendingHint' },
    ],
  },
] as const;

export function ContactSortControls({ value, onChange, accessibilityLabel, style }: Props) {
  const { t } = useTranslation();

  return (
    <View
      style={[styles.container, style]}
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
    >
      {GROUPS.map(({ criterion, labelKey, directions }) => {
        const criterionActive = directions.some(({ mode }) => mode === value);
        return (
          <View key={criterion} style={styles.group}>
            <View style={[styles.criterion, criterionActive && styles.criterionActive]}>
              <Text style={[styles.criterionText, criterionActive && styles.criterionTextActive]}>
                {t(labelKey)}
              </Text>
            </View>
            {directions.map(({ mode, icon, labelKey: directionLabelKey, hintKey }) => {
              const selected = value === mode;
              return (
                <TouchableOpacity
                  key={mode}
                  style={[styles.direction, selected && styles.directionActive]}
                  onPress={() => onChange(mode)}
                  accessibilityRole="radio"
                  accessibilityLabel={t(directionLabelKey)}
                  accessibilityHint={t(hintKey)}
                  accessibilityState={{ selected }}
                >
                  <Ionicons
                    name={icon}
                    size={18}
                    color={selected ? colors.textOnPrimary : colors.primary}
                    accessible={false}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: spacing.xxs,
  },
  criterion: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  criterionActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  criterionText: {
    ...typography.caption,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  criterionTextActive: { color: colors.textOnPrimary },
  direction: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  directionActive: { backgroundColor: colors.primary },
});

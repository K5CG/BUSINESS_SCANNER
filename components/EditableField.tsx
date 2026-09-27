import React from 'react';
import { View, Text, TextInput, StyleSheet, TextInputProps, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../lib/ui-theme';
import { radii, spacing, touchTarget, typography } from '../lib/ui-system';
import type { FieldConfidence } from '../lib/extraction-review';
import { ConfidenceBadge } from './ConfidenceBadge';

interface Props extends Pick<TextInputProps, 'keyboardType' | 'multiline' | 'autoCapitalize' | 'onFocus' | 'onBlur'> {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  highlight?: boolean;
  confidence?: FieldConfidence;
  reviewHighlight?: boolean;
  actionIcon?: keyof typeof Ionicons.glyphMap;
  onAction?: () => void;
  editable?: boolean;
}

export function EditableField({
  label,
  value,
  onChangeText,
  placeholder,
  highlight = false,
  confidence,
  reviewHighlight = false,
  actionIcon,
  onAction,
  editable = true,
  keyboardType,
  multiline = false,
  autoCapitalize,
  onFocus,
  onBlur,
}: Props) {
  const emphasized = highlight || reviewHighlight;

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <View style={styles.labelLeft}>
          <Text style={styles.label}>{label}</Text>
          {actionIcon && onAction ? (
            <TouchableOpacity
              onPress={onAction}
              style={styles.actionBtn}
              disabled={!editable}
              accessibilityRole="button"
              accessibilityLabel={`${label}: azione`}
              accessibilityState={{ disabled: !editable }}
            >
              <Ionicons name={actionIcon} size={18} color={colors.primary} />
            </TouchableOpacity>
          ) : null}
        </View>
        {confidence ? <ConfidenceBadge level={confidence} /> : null}
      </View>
      <TextInput
        style={[styles.input, emphasized && styles.inputHighlight, multiline && styles.multiline]}
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={colors.textDisabled}
        keyboardType={keyboardType}
        multiline={multiline}
        autoCapitalize={autoCapitalize}
        editable={editable}
        accessibilityLabel={label}
        accessibilityState={{ disabled: !editable }}
        textAlignVertical={multiline ? 'top' : 'center'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: spacing.lg },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  labelLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  actionBtn: {
    minWidth: touchTarget.minimum,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { ...typography.label, color: colors.textSecondary, flexShrink: 1 },
  input: {
    ...typography.input,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    backgroundColor: colors.surface,
  },
  inputHighlight: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
  },
  multiline: { minHeight: 72, paddingTop: 10 },
});

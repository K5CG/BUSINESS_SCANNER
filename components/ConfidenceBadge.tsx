import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { FieldConfidence } from '../lib/extraction-review';
import { useUiPalette } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';

interface Props {
  level: FieldConfidence;
}

export function ConfidenceBadge({ level }: Props) {
  const { t } = useTranslation();
  const theme = useUiPalette();
  const palette =
    level === 'high'
      ? { bg: theme.successSurface, text: theme.success, border: theme.success }
      : level === 'medium'
        ? { bg: theme.warningSurface, text: theme.warning, border: theme.warning }
        : { bg: theme.dangerSurface, text: theme.danger, border: theme.danger };
  const labelKey =
    level === 'high'
      ? 'confidenceHigh'
      : level === 'medium'
        ? 'confidenceMedium'
        : 'confidenceLow';

  return (
    <View style={[styles.badge, { backgroundColor: palette.bg, borderColor: palette.border }]}>
      <Text style={[styles.text, { color: palette.text }]}>{t(labelKey)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  text: {
    ...typography.caption,
    flexShrink: 0,
    fontWeight: '700',
    textAlign: 'center',
    includeFontPadding: false,
  },
});

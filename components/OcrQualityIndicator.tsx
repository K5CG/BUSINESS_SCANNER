import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { OcrQualityMetadata } from '../types';
import { buildOcrQualityViewModel } from '../lib/ocr-quality-view-model';
import { colors } from '../lib/ui-theme';
import { typography } from '../lib/ui-system';

interface Props {
  quality: OcrQualityMetadata;
  compact?: boolean;
}

export function OcrQualityIndicator({
  quality,
  compact = false,
}: Props) {
  const { i18n } = useTranslation();
  const locale = i18n.language.toLowerCase().startsWith('en') ? 'en' : 'it';
  const viewModel = buildOcrQualityViewModel(quality, locale);
  const reviewLabel =
    locale === 'it' ? 'Verifica consigliata' : 'Review recommended';
  const accessibilityLabel = [
    viewModel.confidenceLabel,
    viewModel.confidenceValue,
    viewModel.estimatedQualityLabel,
    viewModel.estimatedQualityValue,
    viewModel.requiresReview ? reviewLabel : undefined,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.container,
        compact ? styles.containerCompact : undefined,
        viewModel.requiresReview ? styles.containerReview : undefined,
      ]}
    >
      <View style={styles.metric}>
        <Text style={styles.label}>{viewModel.confidenceLabel}</Text>
        {viewModel.confidenceValue ? (
          <Text style={styles.value}>{viewModel.confidenceValue}</Text>
        ) : null}
      </View>

      {viewModel.estimatedQualityLabel ? (
        <View style={styles.metric}>
          <Text style={styles.label}>
            {viewModel.estimatedQualityLabel}
          </Text>
          {viewModel.estimatedQualityValue ? (
            <Text style={styles.value}>
              {viewModel.estimatedQualityValue}
            </Text>
          ) : null}
        </View>
      ) : null}

      {viewModel.requiresReview ? (
        <Text style={styles.review}>{reviewLabel}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    gap: 6,
  },
  containerCompact: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 8,
    marginBottom: 6,
  },
  containerReview: {
    backgroundColor: colors.warningSurface,
    borderColor: colors.warning,
  },
  metric: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  label: {
    ...typography.caption,
    flex: 1,
    color: colors.textSecondary,
  },
  value: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  review: {
    ...typography.caption,
    color: colors.warning,
    fontWeight: '700',
  },
});

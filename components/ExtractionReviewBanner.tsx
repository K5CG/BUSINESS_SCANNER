import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';

interface Props {
  reviewFieldCount: number;
}

export function ExtractionReviewBanner({ reviewFieldCount }: Props) {
  const { t } = useTranslation();

  if (reviewFieldCount <= 0) return null;

  return (
    <View style={styles.banner}>
      <Ionicons name="alert-circle-outline" size={20} color={colors.warning} style={styles.icon} />
      <View style={styles.textWrap}>
        <Text style={styles.title}>{t('extractionReviewBannerTitle')}</Text>
        <Text style={styles.body}>
          {t('extractionReviewBannerBody', { count: reviewFieldCount })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.warningSurface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  icon: {
    marginRight: 10,
    marginTop: 1,
  },
  textWrap: {
    flex: 1,
  },
  title: {
    ...typography.label,
    color: colors.warning,
    marginBottom: 4,
  },
  body: {
    ...typography.bodySecondary,
    color: colors.textPrimary,
  },
});

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BusinessScannerLogo } from './BusinessScannerLogo';
import { LanguagePicker } from './LanguagePicker';
import { useLicense } from './LicenseProvider';
import { trialDurationDaysFallback } from '../lib/license-config';
import { colors } from '../lib/ui-theme';
import { getUiViewportLayout } from '../lib/ui-layout';
import { radii, spacing, touchTarget, typography } from '../lib/ui-system';

function formatDate(date: Date | null, locale: string): string {
  if (!date) return '';
  return date.toLocaleDateString(locale === 'en' ? 'en-GB' : 'it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function resolvedTrialDurationDays(startedAt: string | null, expiresAt: string | null): number {
  if (startedAt && expiresAt) {
    const start = new Date(startedAt).getTime();
    const end = new Date(expiresAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
    }
  }
  return trialDurationDaysFallback();
}

/**
 * Interstitial after trial expiry: explain read/export remains, then continue or activate.
 */
export function LicenseExpiredContinueScreen() {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const responsive = getUiViewportLayout(width, fontScale);
  const { status, dismissExpiredNotice, openActivation } = useLicense();
  const ended = formatDate(status.trialEndsAt, i18n.language);
  const trialDays = resolvedTrialDurationDays(
    status.entitlement.trialStartedAt,
    status.entitlement.trialExpiresAt
  );

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + spacing.md,
          paddingBottom: insets.bottom + spacing.lg,
          paddingHorizontal: responsive.horizontalPadding,
        },
      ]}
    >
      <View style={styles.topRow}>
        <BusinessScannerLogo />
        <LanguagePicker />
      </View>
      <Text style={styles.title}>{t('licenseExpiredTitle')}</Text>
      <Text style={styles.body}>
        {t('licenseExpiredReadOnlyBody', {
          days: trialDays,
          date: ended,
        })}
      </Text>
      <TouchableOpacity
        style={styles.primary}
        onPress={dismissExpiredNotice}
        accessibilityRole="button"
        accessibilityLabel={t('licenseContinueToData')}
      >
        <Text style={styles.primaryText}>
          {t('licenseContinueToData')}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.secondary}
        onPress={openActivation}
        accessibilityRole="button"
        accessibilityLabel={t('licenseActivate')}
      >
        <Text style={styles.secondaryText}>{t('licenseActivate')}</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>{t('licenseContactHint')}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { flexGrow: 1 },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.heading1,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  primaryText: {
    ...typography.button,
    color: colors.textOnPrimary,
  },
  secondary: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    minHeight: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  secondaryText: {
    ...typography.button,
    color: colors.textPrimary,
  },
  hint: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
  },
});

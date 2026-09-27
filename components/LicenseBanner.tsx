import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useLicense } from './LicenseProvider';
import { resolveLicenseBannerAiCredits } from '../lib/license-banner-ai-credits';
import { useUiPalette } from '../lib/ui-theme';
import { isRcTrialScanQuotaAdvertised } from '../lib/release-rc-policy';
import { spacing, typography } from '../lib/ui-system';

export function LicenseBanner() {
  const { t } = useTranslation();
  const palette = useUiPalette();
  const { status, openActivation } = useLicense();

  if (status.access === 'expired' || status.entitlement.status === 'EXPIRED') {
    return (
      <View style={styles.wrap}>
        <Text style={[styles.text, { color: palette.textPrimary }]}>{t('licenseExpiredBanner')}</Text>
        <TouchableOpacity onPress={openActivation} accessibilityRole="button">
          <Text style={[styles.link, { color: palette.primary }]}>{t('licenseActivate')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const trialActive =
    (status.access === 'active' || status.access === 'offline_grace') &&
    status.kind === 'trial';

  if (!trialActive) {
    return null;
  }

  const days = status.daysRemaining;
  const scansUsed = isRcTrialScanQuotaAdvertised() ? status.trialScanCount : null;
  const scansMax = isRcTrialScanQuotaAdvertised() ? status.trialMaxScans : null;
  const scansRemaining = isRcTrialScanQuotaAdvertised()
    ? status.trialScansRemaining
    : null;
  const aiCredits = resolveLicenseBannerAiCredits(status.aiCreditsRemaining);
return (
    <View style={styles.wrap}>
      <Text style={[styles.text, { color: palette.textPrimary }]}>{t('licenseTrialBanner', { days })}</Text>
      {scansUsed !== null && scansMax !== null ? (
        <Text style={[styles.subtext, { color: palette.textSecondary }]}>
          {t('licenseTrialBannerScans', { used: scansUsed, max: scansMax })}
        </Text>
      ) : scansRemaining !== null ? (
        <Text style={[styles.subtext, { color: palette.textSecondary }]}>
          {t('licenseTrialBannerScansRemaining', { remaining: scansRemaining })}
        </Text>
      ) : null}
      {aiCredits !== null ? (
        <Text style={[styles.subtext, { color: palette.textSecondary }]}>
          {t('licenseTrialAiCredits', { credits: aiCredits })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  text: {
    ...typography.caption,
    textAlign: 'center',
  },
  subtext: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  link: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: spacing.xs,
    fontWeight: '700',
  },
});

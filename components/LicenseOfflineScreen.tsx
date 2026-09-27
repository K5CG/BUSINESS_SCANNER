import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BusinessScannerLogo } from './BusinessScannerLogo';
import { useLicense } from './LicenseProvider';
import { colors } from '../lib/ui-theme';
import { radii, spacing, typography } from '../lib/ui-system';

export function LicenseOfflineScreen({
  mode = 'network_unknown',
}: {
  mode?: 'offline_blocked' | 'network_unknown';
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { refresh, loading } = useLicense();

  const bodyKey =
    mode === 'offline_blocked' ? 'licenseOfflineBody' : 'licenseOfflineBody';

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.logoWrap}>
        <BusinessScannerLogo />
      </View>
      <Text style={styles.title}>{t('licenseOfflineTitle')}</Text>
      <Text style={styles.body}>{t(bodyKey)}</Text>
      <TouchableOpacity
        style={styles.button}
        onPress={() => refresh()}
        disabled={loading}
        accessibilityRole="button"
        accessibilityLabel={t('licenseRetry')}
        accessibilityState={{ disabled: loading, busy: loading }}
        accessibilityLiveRegion="polite"
      >
        {loading ? (
          <ActivityIndicator color={colors.textOnPrimary} />
        ) : (
          <Text style={styles.buttonText}>{t('licenseRetry')}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
  },
  logoWrap: { alignItems: 'center', marginBottom: spacing.lg },
  title: {
    ...typography.heading2,
    textAlign: 'center',
    marginBottom: spacing.sm,
    color: colors.textPrimary,
  },
  body: {
    ...typography.body,
    textAlign: 'center',
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    minHeight: 48,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  buttonText: { ...typography.button, color: colors.textOnPrimary },
});

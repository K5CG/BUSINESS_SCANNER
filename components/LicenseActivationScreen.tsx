import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BusinessScannerLogo } from './BusinessScannerLogo';
import { LanguagePicker } from './LanguagePicker';
import { useLicense } from './LicenseProvider';
import { daysForLicenseKind, trialDurationDaysFallback } from '../lib/license-config';
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

function mapError(
  code: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  switch (code) {
    case 'rate_limited':
      return t('licenseErrorRateLimited');
    case 'supabase_not_configured':
      return t('licenseErrorOffline');
    case 'email_required':
      return t('licenseErrorEmailRequired');
    case 'email_invalid':
      return t('licenseErrorEmailInvalid');
    case 'email_mismatch':
      return t('licenseErrorEmailMismatch');
    case 'max_devices':
      return t('licenseErrorMaxDevices');
    case 'empty_key':
      return t('licenseErrorEmpty');
    case 'expired_key':
      return t('licenseErrorExpired');
    case 'revoked':
      return t('licenseErrorRevoked');
    default:
      return t('licenseErrorInvalid');
  }
}

export function LicenseActivationScreen({ voluntary = false }: { voluntary?: boolean }) {
  const { t, i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const responsive = getUiViewportLayout(width, fontScale);
  const { status, activate, closeActivation } = useLicense();
  const [email, setEmail] = useState(status.customerEmail ?? '');
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trialEnded = status.trialEndsAt
    ? formatDate(status.trialEndsAt, i18n.language)
    : '';
  const trialDays = resolvedTrialDurationDays(
    status.entitlement.trialStartedAt,
    status.entitlement.trialExpiresAt
  );

  const onSubmit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await activate(email, key);
      if (!result.ok) {
        setError(mapError(result.error, t));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingHorizontal: responsive.horizontalPadding },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
      <View style={styles.topRow}>
        <BusinessScannerLogo />
        <LanguagePicker />
      </View>

      <Text style={styles.title}>
        {voluntary ? t('licenseActivateTitle') : t('licenseExpiredTitle')}
      </Text>
      <Text style={styles.body}>
        {voluntary
          ? t('licenseActivateBody', { days: trialDays })
          : t('licenseExpiredBody', { days: trialDays, date: trialEnded })}
      </Text>

      <Text style={styles.label}>{t('licenseEmailLabel')}</Text>
      <TextInput
        style={styles.inputEmail}
        value={email}
        onChangeText={setEmail}
        placeholder={t('licenseEmailPlaceholder')}
        placeholderTextColor={colors.textDisabled}
        autoCapitalize="none"
        keyboardType="email-address"
        autoCorrect={false}
        editable={!submitting}
        accessibilityLabel={t('licenseEmailLabel')}
        accessibilityState={{ disabled: submitting }}
      />

      <Text style={styles.label}>{t('licenseKeyLabel')}</Text>
      <TextInput
        style={styles.input}
        value={key}
        onChangeText={setKey}
        placeholder={t('licenseKeyPlaceholder')}
        placeholderTextColor={colors.textDisabled}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!submitting}
        accessibilityLabel={t('licenseKeyLabel')}
        accessibilityState={{ disabled: submitting }}
      />

      {error ? <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">{error}</Text> : null}

      <TouchableOpacity
        style={[styles.button, submitting && styles.buttonDisabled]}
        onPress={onSubmit}
        disabled={submitting}
        accessibilityRole="button"
        accessibilityLabel={t('licenseActivate')}
        accessibilityState={{ disabled: submitting, busy: submitting }}
      >
        {submitting ? (
          <ActivityIndicator color={colors.textDisabled} />
        ) : (
          <Text style={[styles.buttonText, submitting && styles.buttonTextDisabled]}>
            {t('licenseActivate')}
          </Text>
        )}
      </TouchableOpacity>

      <Text style={styles.hint}>{t('licenseContactHint')}</Text>

      {voluntary ? (
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={closeActivation}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel={t('licenseBackToTrial')}
          accessibilityState={{ disabled: submitting }}
        >
          <Text style={styles.cancelText}>{t('licenseBackToTrial')}</Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.typesBox}>
        <Text style={styles.typesTitle}>{t('licenseTypesTitle')}</Text>
        <Text style={styles.typesLine}>{t('licenseTypeTest', { days: daysForLicenseKind('test') })}</Text>
        <Text style={styles.typesLine}>{t('licenseTypePremium', { days: daysForLicenseKind('premium') })}</Text>
      </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollContent: {
    flexGrow: 1,
    paddingVertical: 16,
    justifyContent: 'center',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  title: {
    ...typography.heading1,
    textAlign: 'center',
    marginBottom: spacing.md,
    color: colors.textPrimary,
  },
  body: {
    ...typography.bodySecondary,
    textAlign: 'center',
    color: colors.textSecondary,
    marginBottom: spacing.xxl,
  },
  label: {
    ...typography.label,
    marginBottom: spacing.sm,
    color: colors.textPrimary,
  },
  inputEmail: {
    ...typography.input,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    marginBottom: 16,
  },
  input: {
    ...typography.input,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    letterSpacing: 1,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
  },
  error: {
    ...typography.bodySecondary,
    color: colors.danger,
    marginTop: 10,
    textAlign: 'center',
  },
  button: {
    marginTop: 20,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonDisabled: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  buttonText: {
    ...typography.button,
    color: colors.textOnPrimary,
  },
  buttonTextDisabled: { color: colors.textDisabled },
  hint: {
    ...typography.bodySecondary,
    marginTop: 20,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  cancelButton: {
    marginTop: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
  },
  cancelText: {
    ...typography.button,
    color: colors.primary,
    fontWeight: '600',
  },
  typesBox: {
    marginTop: 20,
    padding: 14,
    backgroundColor: colors.surfaceMuted,
    borderRadius: 10,
    marginBottom: 8,
  },
  typesTitle: {
    ...typography.label,
    marginBottom: 8,
    color: colors.textPrimary,
  },
  typesLine: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});

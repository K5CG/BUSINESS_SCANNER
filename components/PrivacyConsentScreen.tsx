import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  useWindowDimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BusinessScannerLogo } from './BusinessScannerLogo';
import { LanguagePicker } from './LanguagePicker';
import { usePrivacyConsent } from './PrivacyConsentProvider';
import { exitAppSession } from '../lib/app-exit';
import { openPrivacyPolicyUrl } from '../lib/open-privacy-policy';
import { FALLBACK_PRIVACY_POLICY_URL } from '../lib/privacy-config';
import { logPrivacyConsent } from '../lib/privacy-consent-log';
import { colors } from '../lib/ui-theme';
import { getUiViewportLayout } from '../lib/ui-layout';
import { radii, spacing, typography } from '../lib/ui-system';

export function PrivacyConsentScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const responsive = getUiViewportLayout(width, fontScale);
  const { accept, privacyPolicyUrl } = usePrivacyConsent();
  const [submitting, setSubmitting] = useState(false);
  const resolvedPolicyUrl = privacyPolicyUrl || FALLBACK_PRIVACY_POLICY_URL;

  const onDecline = () => {
    Alert.alert(t('privacyDeclineTitle'), t('privacyDeclineMessage'), [
      {
        text: t('privacyDeclineExit'),
        style: 'destructive',
        onPress: () => {
          exitAppSession();
        },
      },
      { text: t('cancel'), style: 'cancel' },
    ]);
  };

  const onAccept = async () => {
    logPrivacyConsent('button_pressed');
    setSubmitting(true);
    try {
      await accept();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logPrivacyConsent('storage_write_failed', {
        stage: 'accept_handler',
        message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      Alert.alert(t('error'), t('privacyConsentSaveError'));
    } finally {
      setSubmitting(false);
    }
  };

  const openPolicyUrl = () => {
    openPrivacyPolicyUrl(resolvedPolicyUrl, () => {
      Alert.alert(t('error'), t('privacyPolicyUrlError'));
    });
  };

  const sections = [
    { title: t('privacyHeader1'), text: t('privacySection1') },
    { title: t('privacyHeader2'), text: t('privacySection2') },
    { title: t('privacyHeader3'), text: t('privacySection3') },
    { title: t('privacyHeader4'), text: t('privacySection4') },
  ];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingHorizontal: responsive.horizontalPadding },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
      >
        <View style={styles.headerBox}>
          <View style={styles.topRow}>
            <BusinessScannerLogo />
            <LanguagePicker />
          </View>
          <Text style={styles.title}>{t('privacyTitle')}</Text>
          <Text style={styles.subtitle} allowFontScaling={false}>{t('privacySubtitle')}</Text>
        </View>

        {sections.map((sec, index) => (
          <View key={index} style={styles.sectionCard}>
            <Text style={styles.sectionHeader}>{sec.title}</Text>
            <Text style={styles.sectionBody} allowFontScaling={false}>{sec.text}</Text>
          </View>
        ))}

        {resolvedPolicyUrl ? (
          <TouchableOpacity
            onPress={openPolicyUrl}
            style={styles.policyButton}
            accessibilityRole="link"
            accessibilityLabel={t('privacyOpenFullPolicy')}
          >
            <Text style={styles.policyButtonText}>{t('privacyOpenFullPolicy')}</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.consentHintBox}>
          <Text style={styles.consentHint} allowFontScaling={false}>{t('privacyConsentHint')}</Text>
        </View>
      </ScrollView>

      <View
        style={[
          styles.actions,
          responsive.stackActions && styles.actionsStacked,
          {
            paddingHorizontal: responsive.horizontalPadding,
            paddingBottom: Math.max(insets.bottom, 12),
          },
        ]}
      >
        <TouchableOpacity
          style={[styles.button, styles.declineButton, responsive.stackActions && styles.buttonStacked]}
          onPress={onDecline}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel={t('privacyDecline')}
          accessibilityState={{ disabled: submitting }}
        >
          <Text style={styles.declineText}>{t('privacyDecline')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.acceptButton, responsive.stackActions && styles.buttonStacked]}
          onPress={onAccept}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel={t('privacyAccept')}
          accessibilityState={{ disabled: submitting, busy: submitting }}
          accessibilityLiveRegion="polite"
        >
          {submitting ? (
            <ActivityIndicator color={colors.textOnPrimary} />
          ) : (
            <Text style={styles.acceptText}>{t('privacyAccept')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    paddingTop: 12,
    paddingBottom: 20,
  },
  headerBox: {
    marginBottom: 20,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    ...typography.heading1,
    color: colors.textPrimary,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.bodySecondary,
    fontSize: 14,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  sectionCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: colors.textPrimary,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  sectionHeader: {
    ...typography.heading3,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  sectionBody: {
    ...typography.bodySecondary,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textSecondary,
  },
  policyButton: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    marginBottom: 16,
  },
  policyButtonText: {
    ...typography.button,
    color: colors.primary,
    textAlign: 'center',
  },
  consentHintBox: {
    backgroundColor: colors.infoSurface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.info,
    padding: spacing.lg,
    marginTop: 4,
    marginBottom: 16,
  },
  consentHint: {
    ...typography.bodySecondary,
    fontSize: 10,
    lineHeight: 14,
    color: colors.info,
    fontWeight: '500',
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionsStacked: {
    flexDirection: 'column',
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
  },
  buttonStacked: {
    flex: 0,
    width: '100%',
  },
  declineButton: {
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  acceptButton: {
    backgroundColor: colors.primary,
  },
  declineText: {
    ...typography.button,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  acceptText: {
    ...typography.button,
    color: colors.textOnPrimary,
  },
});

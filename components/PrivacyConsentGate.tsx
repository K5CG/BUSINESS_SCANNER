import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { usePrivacyConsent } from './PrivacyConsentProvider';
import { PrivacyConsentScreen } from './PrivacyConsentScreen';
import { logPrivacyConsent } from '../lib/privacy-consent-log';
import { colors } from '../lib/ui-theme';

export function PrivacyConsentGate({ children }: { children: React.ReactNode }) {
  const { loading, accepted } = usePrivacyConsent();

  useEffect(() => {
    logPrivacyConsent('gate_render', { loading, accepted });
  }, [loading, accepted]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!accepted) {
    return <PrivacyConsentScreen />;
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});

import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useLicense, isLicenseGateOpen } from './LicenseProvider';
import { LicenseActivationScreen } from './LicenseActivationScreen';
import { LicenseOfflineScreen } from './LicenseOfflineScreen';
import { LicenseExpiredContinueScreen } from './LicenseExpiredContinueScreen';
import { logLicense } from '../lib/license-log';
import { colors } from '../lib/ui-theme';

export function LicenseGate({ children }: { children: React.ReactNode }) {
  const {
    status,
    loading,
    showActivationForm,
    expiredNoticeDismissed,
  } = useLicense();

  useEffect(() => {
    logLicense('ui_state', {
      loading,
      access: status.access,
      gateOpen: isLicenseGateOpen(status),
      showActivationForm,
      expiredNoticeDismissed,
    });
  }, [loading, status.access, showActivationForm, expiredNoticeDismissed]);

  if (loading || status.access === 'loading') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (
    status.access === 'offline_blocked' ||
    status.access === 'network_unknown'
  ) {
    return <LicenseOfflineScreen mode={status.access} />;
  }

  if (status.access === 'revoked') {
    return <LicenseActivationScreen voluntary={false} />;
  }

  if (showActivationForm) {
    return (
      <LicenseActivationScreen
        voluntary={isLicenseGateOpen(status)}
      />
    );
  }

  if (status.access === 'expired' && !expiredNoticeDismissed) {
    return <LicenseExpiredContinueScreen />;
  }

  if (isLicenseGateOpen(status)) {
    return <>{children}</>;
  }

  return <LicenseActivationScreen voluntary={false} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});

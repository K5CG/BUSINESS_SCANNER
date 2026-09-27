import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogBox, Platform } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { initDatabase } from '../lib/storage';
import { runAppBootstrap } from '../lib/app-bootstrap';
import { getSavedLocale } from '../lib/locale-prefs';
import { useContactStore } from '../store/useContactStore';
import i18n from '../i18n';
import { LicenseProvider } from '../components/LicenseProvider';
import { LicenseGate } from '../components/LicenseGate';
import { PrivacyConsentProvider } from '../components/PrivacyConsentProvider';
import { PrivacyConsentGate } from '../components/PrivacyConsentGate';
import { runtimeLogger } from '../lib/safe-runtime-logger';
import { useIsDarkMode, useUiPalette } from '../lib/ui-theme';
import { getNativeUiPolicy } from '../lib/ui-native-policy';
import { ThemePreferenceProvider } from '../components/ThemePreferenceProvider';
import { runHiddenQaFixtureReplayIfRequested } from '../lib/qa-hidden-replay';
import { runHiddenQaRealImageGateIfRequested } from '../lib/qa-real-image-gate';

LogBox.ignoreAllLogs(true);

function RootStack() {
  const insets = useSafeAreaInsets();
  const palette = useUiPalette();
  const topInset = Platform.OS === 'android' ? Math.max(insets.top, 28) : insets.top;
  const nativeUi = getNativeUiPolicy(Platform.OS);

  return (
    <Stack
      screenOptions={{
        orientation: 'portrait_up',
        headerBackTitle: 'Indietro',
        headerTintColor: palette.primary,
        headerTitleStyle: { color: palette.textPrimary },
        headerStyle: { backgroundColor: palette.surface },
        contentStyle: { backgroundColor: palette.background },
        animation: nativeUi.stackAnimation,
        gestureEnabled: nativeUi.stackGesturesEnabled,
        fullScreenGestureEnabled: nativeUi.fullScreenBackGesture,
        headerBackButtonDisplayMode: 'minimal',
        ...(Platform.OS === 'android' && { headerStatusBarHeight: topInset }),
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="scan/[type]" options={{ title: 'Scansiona' }} />
      <Stack.Screen name="document/[id]" options={{ title: 'Documento' }} />
      <Stack.Screen name="contact/[id]" options={{ title: 'Contatto', headerShown: false }} />
      <Stack.Screen name="export/[id]" options={{ title: 'Esporta' }} />
      <Stack.Screen name="scan-legacy" options={{ title: 'Scansiona biglietto' }} />
    </Stack>
  );
}

function AppFrame() {
  const isDarkMode = useIsDarkMode();
  const palette = useUiPalette();
  useEffect(() => {
    void runAppBootstrap(
      {
        initDatabase,
        getSavedLocale,
        changeLanguage: (locale) => i18n.changeLanguage(locale),
        loadContacts: () => useContactStore.getState().loadContacts(),
      },
      i18n.language
    ).then(async () => {
      await runHiddenQaFixtureReplayIfRequested();
      await runHiddenQaRealImageGateIfRequested();
    }).catch((error) => {
      runtimeLogger.error('APP_BOOTSTRAP_FAILED', error, {
        stage: 'bootstrap',
        status: 'failed',
      });
    });
  }, []);

  return (
    <>
      <StatusBar
        style={isDarkMode ? 'light' : 'dark'}
        backgroundColor={Platform.OS === 'android' ? palette.surface : undefined}
        translucent={Platform.OS === 'android' ? false : undefined}
      />
      <PrivacyConsentProvider>
        <PrivacyConsentGate>
          <LicenseProvider>
            <LicenseGate>
              <RootStack />
            </LicenseGate>
          </LicenseProvider>
        </PrivacyConsentGate>
      </PrivacyConsentProvider>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemePreferenceProvider>
        <AppFrame />
      </ThemePreferenceProvider>
    </SafeAreaProvider>
  );
}

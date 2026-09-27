import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  Platform,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import {
  Stack,
  useFocusEffect,
  useLocalSearchParams,
  useNavigation,
  useRouter,
} from 'expo-router';
import type { NavigationAction } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { MultiPageScanner } from '../../components/Camera/MultiPageScanner';
import { DocumentType } from '../../types';
import type { DocumentCategory } from '../../types';
import { defaultCategoryForDocumentType, isDocumentCategory } from '../../lib/document-category';
import { documentScannerSessionKey } from '../../lib/document-scan-navigation';
import type { OperationInvalidationReason } from '../../lib/guarded-operation';
import { planScanExit, type ScanExitGuard } from '../../lib/scan-exit-policy';
import { colors } from '../../lib/ui-theme';
import type { DocumentCaptureMode } from '../../lib/document-capture-orientation';
import { useLicense } from '../../components/LicenseProvider';
import { getEntitlementCapabilities } from '../../lib/entitlement-capabilities';
import { alertTrialExpiredNewAcquisition } from '../../lib/trial-acquisition-guard';

const VALID_TYPES: DocumentType[] = ['business_card', 'quote', 'order', 'invoice', 'free_document'];

export default function ScanScreen() {
  const { type, captureMode: captureModeParam, intent, category: categoryParam, session: scanSessionParam } = useLocalSearchParams<{
    type: string;
    captureMode?: string;
    intent?: string;
    category?: string;
    session?: string;
  }>();
  const router = useRouter();
  const navigation = useNavigation();
  const { t } = useTranslation();
  const { status, openActivation } = useLicense();
  const caps = getEntitlementCapabilities(
    status.entitlement,
    status.aiCreditsRemaining
  );
  const documentType = VALID_TYPES.includes(type as DocumentType)
    ? (type as DocumentType)
    : 'business_card';
  const wantsPdf = intent === 'pdf';
  const documentCategory: DocumentCategory | undefined =
    documentType === 'business_card'
      ? undefined
      : isDocumentCategory(categoryParam)
        ? categoryParam
        : defaultCategoryForDocumentType(documentType);
  const scannerSessionKey = documentScannerSessionKey(
    documentType,
    documentCategory,
    scanSessionParam,
  );

  useEffect(() => {
    const allowed = wantsPdf ? caps.canImportPdf : caps.canCreateNewScan;
    if (allowed) return;
    alertTrialExpiredNewAcquisition(
      t,
      wantsPdf ? 'pdf' : documentType === 'business_card' ? 'card' : 'document',
      openActivation
    );
    router.replace('/(tabs)');
  }, [
    caps.canCreateNewScan,
    caps.canImportPdf,
    documentType,
    openActivation,
    router,
    t,
    wantsPdf,
  ]);

  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const deviceLandscape = windowWidth > windowHeight;
  const [captureMode, setCaptureModeState] = useState<DocumentCaptureMode>(() =>
    captureModeParam === 'landscape-left' ? 'landscape-left' : 'portrait'
  );

  useEffect(() => {
    // Expo Router can reuse the same dynamic /scan/[type] screen instance.
    // A new acquisition session must never inherit the previous scan's
    // orientation/capture state, otherwise the document viewport guard can
    // silently reject the shutter before takePictureAsync is reached.
    setCaptureModeState(
      captureModeParam === 'landscape-left' ? 'landscape-left' : 'portrait'
    );
  }, [scanSessionParam, captureModeParam, documentType]);
  const setCaptureMode = useCallback(
    (mode: DocumentCaptureMode) => {
      setCaptureModeState(mode);
      router.setParams({ captureMode: mode });
      if (documentType !== 'business_card') {
        const lock =
          mode === 'landscape-left'
            ? ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT
            : ScreenOrientation.OrientationLock.PORTRAIT_UP;
        void ScreenOrientation.lockAsync(lock);
      }
    },
    [documentType, router],
  );
  const cancelCurrentRef = useRef<
    ((reason?: OperationInvalidationReason) => void) | null
  >(null);
  const exitGuardRef = useRef<ScanExitGuard | null>(null);
  const exitRequestedRef = useRef(false);
  const discardPromptOpenRef = useRef(false);
  const committedNavigationUntilRef = useRef(0);

  useEffect(() => {
    const lock = documentType !== 'business_card' && captureMode === 'landscape-left'
      // Expo chiama LANDSCAPE_RIGHT la posizione ottenuta ruotando
      // fisicamente il telefono di 90 gradi in senso antiorario.
      ? ScreenOrientation.OrientationLock.LANDSCAPE_RIGHT
      : ScreenOrientation.OrientationLock.PORTRAIT_UP;
    void ScreenOrientation.lockAsync(lock);
    return () => {
      void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    };
  }, [captureMode, documentType]);

  useFocusEffect(
    useCallback(() => {
      exitRequestedRef.current = false;
      discardPromptOpenRef.current = false;
      committedNavigationUntilRef.current = 0;
    }, [])
  );

  const registerCancellation = useCallback(
    (
      cancel: ((reason?: OperationInvalidationReason) => void) | null
    ) => {
      cancelCurrentRef.current = cancel;
    },
    []
  );

  const registerExitGuard = useCallback((guard: ScanExitGuard | null) => {
    exitGuardRef.current = guard;
  }, []);

  const authorizeCommittedNavigation = useCallback(() => {
    // Autorizzazione breve e monouso: vale solo per il replace verso la review
    // immediatamente successivo al commit protetto del record.
    committedNavigationUntilRef.current = Date.now() + 1500;
  }, []);

  const performExit = useCallback(
    (action?: NavigationAction) => {
      if (exitRequestedRef.current) return;
      exitRequestedRef.current = true;

      const guard = exitGuardRef.current;
      if (guard) guard.discardAndCancel('manual');
      else cancelCurrentRef.current?.('manual');

      if (action) {
        navigation.dispatch(action);
      } else if (router.canGoBack()) {
        router.back();
      } else {
        router.replace(
          documentType === 'business_card'
            ? '/(tabs)/contacts'
            : '/(tabs)/documents'
        );
      }
    },
    [documentType, navigation, router]
  );

  const cancelDiscard = useCallback(() => {
    discardPromptOpenRef.current = false;
  }, []);

  const requestExit = useCallback(
    (action?: NavigationAction) => {
      if (exitRequestedRef.current || discardPromptOpenRef.current) return;

      const guard = exitGuardRef.current;
      const plan = planScanExit({
        hasUnsavedPages: guard?.hasUnsavedPages() ?? false,
        isBusy: guard?.isBusy() ?? false,
        hasHistory: Boolean(action) || router.canGoBack(),
        documentType,
      });

      if (plan.invalidateBeforePrompt) {
        guard?.invalidateOperations('manual');
      }

      if (!plan.requiresDiscardConfirmation) {
        performExit(action);
        return;
      }

      discardPromptOpenRef.current = true;
      Alert.alert(
        t('discardScanTitle'),
        t('discardScanMessage'),
        [
          { text: t('cancel'), style: 'cancel', onPress: cancelDiscard },
          {
            text: t('exitScan'),
            style: 'destructive',
            onPress: () => {
              discardPromptOpenRef.current = false;
              performExit(action);
            },
          },
        ],
        { cancelable: true, onDismiss: cancelDiscard }
      );
    },
    [cancelDiscard, documentType, performExit, router, t]
  );

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      requestExit();
      return true;
    });
    return () => sub.remove();
  }, [requestExit]);

  useEffect(
    () =>
      navigation.addListener('beforeRemove', (event) => {
        if (committedNavigationUntilRef.current >= Date.now()) {
          committedNavigationUntilRef.current = 0;
          return;
        }
        if (exitRequestedRef.current) return;

        const guard = exitGuardRef.current;
        if (!guard?.hasUnsavedPages()) {
          if (guard) guard.discardAndCancel('manual');
          else cancelCurrentRef.current?.('manual');
          exitRequestedRef.current = true;
          return;
        }

        event.preventDefault();
        requestExit(event.data.action);
      }),
    [navigation, requestExit]
  );

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: t('scan'),
          headerShown:
            documentType === 'business_card' ||
            captureMode !== 'landscape-left' ||
            !deviceLandscape,
          orientation:
            documentType !== 'business_card' && captureMode === 'landscape-left'
              ? 'landscape_right'
              : 'portrait_up',
          headerLeft: () => (
            <TouchableOpacity
              onPress={() => requestExit()}
              hitSlop={12}
              activeOpacity={0.6}
              style={styles.headerBack}
              accessibilityRole="button"
              accessibilityLabel={t('scanBackLabel')}
              accessibilityHint={t('scanBackHint')}
            >
              <Ionicons name="chevron-back" size={28} color={colors.primary} />
            </TouchableOpacity>
          ),
          gestureEnabled: Platform.OS === 'ios',
          fullScreenGestureEnabled: Platform.OS === 'ios',
        }}
      />
      <MultiPageScanner
        key={scannerSessionKey}
        acquisitionSessionKey={scannerSessionKey}
        documentType={documentType}
        documentCategory={documentCategory}
        autoImportPdf={intent === 'pdf'}
        captureMode={captureMode}
        onCaptureModeChange={setCaptureMode}
        registerCancellation={registerCancellation}
        registerExitGuard={registerExitGuard}
        authorizeCommittedNavigation={authorizeCommittedNavigation}
        onRequestExit={() => requestExit()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerBack: {
    marginLeft: 4,
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
    elevation: 10,
  },
});


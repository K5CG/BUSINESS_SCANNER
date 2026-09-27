import React, { useState, useRef, useLayoutEffect, useMemo, useCallback, useEffect } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  ActivityIndicator,
  FlatList,
  Image,
  Alert,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import Ionicons from '@expo/vector-icons/Ionicons';
import { patchedAutofocusEventProp } from './camera-native-patch';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scanBusinessCardBest, scanDocumentBest } from '../../lib/ocr';
import { isSupabaseConfigured } from '../../lib/config';
import { isRcPdfImportEnabled } from '../../lib/release-rc-policy';
import { pickAndParsePdf } from '../../lib/pdf-import';
import { pdfErrorMessageKey } from '../../lib/pdf-import-local';
import {
  logPdfProgressChange,
  pdfProgressPhaseLabel,
  pdfStageProgress,
  resetPdfProgressDiagnostics,
} from '../../lib/pdf-import-progress';
import { processCapturedScan } from '../../lib/scan-process-workflow';
import { scanBusinessCardQrPayloads } from '../../lib/qr/business-card-qr';
import type { DocumentProcessProgress } from '../../lib/document-process-progress';
import {
  assessCardCropSafety,
  assessDocumentCropSafety,
  prepareScannedImageFromPlan,
  prepareBusinessCardBoundaryRecoveryImage,
  refineBusinessCardBoundary,
  preparePersonPhoto,
  buildScanPlan,
  getImageSize,
  imagePipelineUris,
  normalizeCapturedDocumentOrientation,
  normalizeDocumentReadingOrientation,
  normalizeFullFrameScan,
  rotateImage,
} from '../../lib/image-utils';
import {
  CARD_GEOMETRY_QA_DIAGNOSTICS,
  logCardGeometry,
} from '../../lib/card-capture-diagnostics';
import { saveCardCaptureArtifacts } from '../../lib/card-capture-artifacts';
import {
  cardFocusTracker,
  documentFocusTracker,
} from '../../lib/camera-focus-diagnostics';
import { autoOrientBusinessCardImage } from '../../lib/card-orientation-fix';
import {
  processingMessageKey,
  processingTitleKey,
} from '../../lib/card-processing-labels';
import {
  measurePreparedBusinessCardSharpness,
  shouldUseVerifiedOverlayFallback,
  measureFullFrameSharpness,
  logCaptureDebug,
} from '../../lib/image-sharpness';
import { ensureDatabaseReady } from '../../lib/storage';
import { runtimeLogger } from '../../lib/safe-runtime-logger';
import {
  useDocumentStore,
  DocumentDuplicateCancelledError,
  DocumentDuplicateOpenExistingError,
} from '../../store/useDocumentStore';
import { useContactStore, DuplicateContactCancelledError } from '../../store/useContactStore';
import { DocumentCategory, DocumentType } from '../../types';
import { router, useNavigation, useFocusEffect } from 'expo-router';
import { GeminiConfirmationModal } from '../GeminiConfirmationModal';
import { useLicense } from '../LicenseProvider';
import { Overlay, CardOrientation } from './Overlay';
import { FocusReticle } from './FocusReticle';
import { overlayCardFocusProps } from './camera-focus';
import { useFocusPulse } from './useFocusPulse';
import { useCameraSession } from './useCameraSession';
import { useTranslation } from 'react-i18next';
import {
  cameraCaptureProfile,
  resetCameraZoom,
} from '../../lib/camera-capture-profile';
import {
  logCardCaptureProfile,
  logCardZoomApplied,
  resetActiveCardZoomPlan,
  resolveCardZoomPlan,
  setActiveCardZoomPlan,
  type CardZoomPlan,
} from '../../lib/business-card-zoom-policy';
import {
  BUSINESS_CARD_PREVIEW_STRIP_HEIGHT,
  getBusinessCardViewportInsets,
  getOverlayFrameCenterInView,
  getOverlayFrameRectInView,
  type OverlayViewportInsets,
} from '../../lib/overlay-geometry';
import {
  createLatestOperationController,
  createTemporaryAssetScope,
  finalizeAfterSettlement,
  runTimedOperation,
  type OperationInvalidationReason,
  type TemporaryAssetScope,
} from '../../lib/guarded-operation';
import {
  cleanupScanSessionImageUri,
  copyImageToDraftStorage,
} from '../../lib/draft-image-storage';
import {
  isInactiveScanOperationError,
  yieldToOperationEventLoop,
} from '../../lib/scan-operation-lifecycle';
import { createExclusiveOperationGate } from '../../lib/exclusive-operation-gate';
import { colors } from '../../lib/ui-theme';
import { radii, spacing, typography } from '../../lib/ui-system';
import {
  readCapturedExifOrientation,
  readRawCapturedExifValue,
  withConfirmedDocumentImage,
  type DeviceCaptureOrientation,
  type DocumentCaptureMode,
  type DocumentPageCaptureMetadata,
} from '../../lib/document-capture-orientation';
import { logCameraOrientation } from '../../lib/orientation-capture-log';
import type { ScanExitGuard } from '../../lib/scan-exit-policy';

interface Props {
  documentType: DocumentType;
  /** Persistent user-selected category; does not alter the scanner engine. */
  documentCategory?: DocumentCategory;
  acquisitionSessionKey?: string;
  /** Apre subito l'importazione PDF quando si arriva dal comando dedicato. */
  autoImportPdf?: boolean;
  captureMode: DocumentCaptureMode;
  onCaptureModeChange: (mode: DocumentCaptureMode) => void;
  registerCancellation?: (
    cancel: ((reason?: OperationInvalidationReason) => void) | null
  ) => void;
  registerExitGuard?: (guard: ScanExitGuard | null) => void;
  authorizeCommittedNavigation?: () => void;
  onRequestExit?: () => void;
}

type BusinessScanKind = 'card' | 'person';

const MAX_SHARPNESS_RETRIES = 2;
const CAPTURE_TIMEOUT_MS = 8000;

interface ScanSlot {
  /** Ritaglio mostrato all'utente e salvato come foto principale. */
  uri: string;
  /** Copia usata per OCR iniziale; normalmente coincide con uri. */
  ocrUri?: string;
  /** Originale integro, separato dal ritaglio, per il ri-OCR. */
  originalUri?: string;
  kind: BusinessScanKind;
}

interface CapturedPhoto {
  uri: string;
  width?: number;
  height?: number;
  exif?: Record<string, unknown>;
}

interface CapturedDocumentPage {
  uri: string;
  ocrUri: string;
  originalUri: string;
  metadata: DocumentPageCaptureMetadata;
}

interface PendingDocumentPhoto {
  page: CapturedDocumentPage;
}

function DocumentModeGlyph({
  mode,
  selected,
}: {
  mode: DocumentCaptureMode;
  selected: boolean;
}) {
  return (
    <View
      style={[
        styles.documentModeGlyph,
        mode === 'portrait'
          ? styles.documentModeGlyphPortrait
          : styles.documentModeGlyphLandscape,
        selected && styles.documentModeGlyphSelected,
      ]}
    />
  );
}

export function MultiPageScanner({
  documentType,
  documentCategory,
  acquisitionSessionKey,
  autoImportPdf = false,
  captureMode,
  onCaptureModeChange,
  registerCancellation,
  registerExitGuard,
  authorizeCommittedNavigation,
  onRequestExit,
}: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [isProcessingDoc, setIsProcessingDoc] = useState(false);
  const [processProgress, setProcessProgress] = useState<DocumentProcessProgress | null>(null);
  const {
    cameraActive,
    cameraReady,
    cameraCaptureReady,
    cameraSession,
    cameraMountError,
    cameraStuck,
    onCameraReady: onCameraSessionReady,
    onMountError,
    remountCamera,
  } = useCameraSession(acquisitionSessionKey);
  const {
    autofocus,
    focusPulseKey,
    afState,
    onAutofocusStateChanged,
    prepareForCapture,
    stabilizeFocusProps,
    holdFocusForCapture,
    releaseFocusAfterCapture,
    resetAutofocus,
    onCameraReadyFocus,
    pulseAutofocus,
    getCameraResolutionDiag,
    logFocusTimeline,
  } = useFocusPulse(
    documentType === 'business_card' ? cardFocusTracker : documentFocusTracker
  );
  const captureInProgress = useRef(false);
  const captureOperationsRef = useRef(
    createLatestOperationController()
  );
  const processingGateRef = useRef(createExclusiveOperationGate());
  const pendingProcessSettlementsRef = useRef(new Set<string>());
  const processOperationsRef = useRef(
    createLatestOperationController()
  );
  const sessionAssetScopeRef = useRef<TemporaryAssetScope | null>(null);
  const deferredSessionAssetScopesRef = useRef(
    new Set<TemporaryAssetScope>()
  );
  const mountedRef = useRef(true);
  const screenActiveRef = useRef(false);
  const [businessCardOrientation, setBusinessCardOrientation] = useState<CardOrientation>('landscape');
  const [businessMode, setBusinessMode] = useState<BusinessScanKind>('card');
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [documentPages, setDocumentPages] = useState<CapturedDocumentPage[]>([]);
  const [pendingDocumentPhoto, setPendingDocumentPhoto] = useState<PendingDocumentPhoto | null>(null);
  const [businessScans, setBusinessScans] = useState<ScanSlot[]>([]);
  const [captureHint, setCaptureHint] = useState<string | null>(null);
  const [lowLightNotice, setLowLightNotice] = useState<string | null>(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [cameraZoom, setCameraZoom] = useState(0);
  const [cardZoomPlan, setCardZoomPlan] = useState<CardZoomPlan | null>(null);
  const cardZoomRangeRef = useRef<number | undefined>(undefined);
  const cardZoomPlanRef = useRef<CardZoomPlan | null>(null);
  const [showPdfAiModal, setShowPdfAiModal] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const overlayContextRef = useRef<{
    width: number;
    height: number;
    insets: OverlayViewportInsets;
  }>({ width: 0, height: 0, insets: {} });
  const { addDocument } = useDocumentStore();
  const { setDraftContact } = useContactStore();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { updateAiCreditsRemaining } = useLicense();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const navigation = useNavigation();
  const displayedCaptureMode =
    pendingDocumentPhoto?.page.metadata.selectedCaptureMode ?? captureMode;
  const requestedDocumentLandscape = displayedCaptureMode === 'landscape-left';
  const windowIsLandscape = screenW > screenH;
  const documentWindowModeMaterialized =
    documentType === 'business_card' || requestedDocumentLandscape === windowIsLandscape;
  // During the native portrait <-> landscape transition, keep using the geometry
  // of the window that is actually materialized.  Previously captureMode changed
  // first and the overlay could be computed as landscape on a still-portrait
  // CameraView (or vice versa), producing the intermittent off-centre frame.
  const effectiveDocumentLandscape = documentType !== 'business_card' && (
    documentWindowModeMaterialized ? requestedDocumentLandscape : windowIsLandscape
  );
  const cardOrientation: CardOrientation =
    documentType === 'business_card'
      ? businessCardOrientation
      : effectiveDocumentLandscape
        ? 'landscape'
        : 'portrait';
  const isDocumentLandscape = effectiveDocumentLandscape;
  const images = useMemo(() => documentPages.map((page) => page.uri), [documentPages]);
  const hasUnsavedPagesRef = useRef(false);
  hasUnsavedPagesRef.current =
    documentType === 'business_card'
      ? businessScans.length > 0
      : documentPages.length > 0 || pendingDocumentPhoto != null;
  const busyRef = useRef(false);
  busyRef.current =
    scanning ||
    isProcessingDoc ||
    captureInProgress.current ||
    processingGateRef.current.isLocked();

  const invalidateCaptureOperation = useCallback(
    (reason: OperationInvalidationReason) => {
      const hadCapture = captureInProgress.current;
      captureOperationsRef.current.invalidateCurrent(reason);
      if (hadCapture && mountedRef.current && screenActiveRef.current) {
        setCaptureHint(null);
      }
    },
    []
  );

  const closeSessionAssets = useCallback(() => {
    const scope = sessionAssetScopeRef.current;
    sessionAssetScopeRef.current = null;
    if (!scope) return;
    // La cattura in-flight possiede un captureScope separato: le immagini già
    // accettate dalla sessione possono essere chiuse subito anche se il bridge
    // camera non si assesta mai. Solo la persistenza/processo può ancora usare
    // gli asset di sessione e richiede quindi una chiusura differita.
    if (pendingProcessSettlementsRef.current.size > 0) {
      deferredSessionAssetScopesRef.current.add(scope);
      return;
    }
    void scope.close();
  }, []);

  const flushDeferredSessionAssets = useCallback(() => {
    if (pendingProcessSettlementsRef.current.size > 0) return;
    const deferred = [...deferredSessionAssetScopesRef.current];
    deferredSessionAssetScopesRef.current.clear();
    for (const scope of deferred) void scope.close();
  }, []);

  const trackSessionAsset = useCallback((uri: string) => {
    const scope = sessionAssetScopeRef.current;
    if (scope) {
      scope.track(uri);
      return;
    }
    void cleanupScanSessionImageUri(uri);
  }, []);

  const invalidateCurrentWork = useCallback(
    (reason: OperationInvalidationReason = 'manual') => {
      captureOperationsRef.current.invalidateCurrent(reason);
      processOperationsRef.current.invalidateCurrent(reason);
      processingGateRef.current.invalidateCurrent();
      if (mountedRef.current && screenActiveRef.current) {
        setScanning(false);
        setIsProcessingDoc(false);
        setCaptureHint(null);
      }
    },
    []
  );

  const cancelCurrentWork = useCallback(
    (reason: OperationInvalidationReason = 'manual') => {
      invalidateCurrentWork(reason);
      closeSessionAssets();
    },
    [closeSessionAssets, invalidateCurrentWork]
  );

  useEffect(() => {
    registerCancellation?.(cancelCurrentWork);
    return () => registerCancellation?.(null);
  }, [cancelCurrentWork, registerCancellation]);

  useEffect(() => {
    registerExitGuard?.({
      hasUnsavedPages: () => hasUnsavedPagesRef.current,
      isBusy: () => busyRef.current,
      invalidateOperations: invalidateCurrentWork,
      discardAndCancel: cancelCurrentWork,
    });
    return () => registerExitGuard?.(null);
  }, [cancelCurrentWork, invalidateCurrentWork, registerExitGuard]);

  useEffect(
    () => {
      mountedRef.current = true;
      processingGateRef.current = createExclusiveOperationGate();
      return () => {
        mountedRef.current = false;
        screenActiveRef.current = false;
        captureOperationsRef.current.dispose();
        processOperationsRef.current.dispose();
        closeSessionAssets();
        processingGateRef.current.dispose();
        flushDeferredSessionAssets();
      };
    },
    [closeSessionAssets, flushDeferredSessionAssets]
  );

  const viewportWidth = viewportSize.width || screenW;
  const viewportHeight = viewportSize.height || screenH;
  const viewportHasLayout = viewportSize.width > 0 && viewportSize.height > 0;
  const viewportIsLandscape = viewportSize.width > viewportSize.height;
  const documentViewportModeMaterialized =
    documentType === 'business_card' || (
      viewportHasLayout && viewportIsLandscape === effectiveDocumentLandscape
    );

  // Document capture readiness is derived synchronously from the REAL materialized
  // camera viewport. No timer/state machine can leave the shutter permanently blocked.
  // Fail-closed is preserved: document capture requires cameraReady + coherent viewport.
  const documentOverlayReady =
    documentType === 'business_card' ||
    (cameraReady && documentViewportModeMaterialized);

  /** Riserva dinamica (da overlay-geometry) lo slot anteprime — overlay/crop stabili fronte/retro. */
  const viewportInsets = useMemo(
    (): OverlayViewportInsets =>
      documentType === 'business_card'
        ? getBusinessCardViewportInsets(documentType, true)
        : {},
    [documentType]
  );

  overlayContextRef.current = {
    width: viewportWidth,
    height: viewportHeight,
    insets: viewportInsets,
  };

  const isBusinessCardMode = documentType === 'business_card';

  const showCardOverlay =
    documentType === 'business_card' && businessMode === 'card';

  const captureProfile = useMemo(
    () =>
      cameraCaptureProfile(
        documentType,
        cardOrientation,
        Platform.OS === 'ios' ? 'ios' : 'android',
      ),
    [documentType, cardOrientation],
  );
  const captureProfileRef = useRef(captureProfile);
  captureProfileRef.current = captureProfile;

  useEffect(() => {
    // Cambiando profilo la camera si rimonta: le capacità vanno riosservate,
    // altrimenti il piano resterebbe quello della sessione precedente.
    cardZoomRangeRef.current = undefined;
    setCameraZoom(resetCameraZoom(captureProfile));
  }, [captureProfile]);

  const resetFraming = useCallback(() => {
    // Il ripristino annulla eventuali gesti dell'utente, non il profilo di
    // ripresa del biglietto: quello resta quello risolto sul dispositivo.
    setCameraZoom(cardZoomPlanRef.current?.appliedZoomValue ?? resetCameraZoom(captureProfile));
  }, [captureProfile]);

  // Le capacità di zoom del dispositivo arrivano in modo asincrono, anche dopo
  // l'apertura della camera: il piano va ricalcolato ogni volta che la misura
  // cambia, altrimenti un primo valore incompleto congelerebbe il ripiego 1x.
  // Vale unicamente per il biglietto.
  const handleAutofocusStateChanged = useCallback(
    (event: { nativeEvent: Record<string, unknown> }) => {
      onAutofocusStateChanged(event);
      if (documentType !== 'business_card') return;
      const diag = getCameraResolutionDiag();
      const maxZoomRatio = diag?.maxZoomRatio;
      const currentPlan = cardZoomPlanRef.current;
      // Alcuni device emettono temporaneamente maxZoomRatio=1 durante un nuovo
      // ciclo AF/retry. Se abbiamo già risolto un piano >1x, quel valore non
      // deve azzerare lo zoom e cambiare l'inquadratura tra uno scatto e l'altro.
      if (
        currentPlan &&
        !currentPlan.fallbackUsed &&
        currentPlan.effectiveMagnification > 1 &&
        (maxZoomRatio == null || maxZoomRatio <= 1)
      ) {
        setCameraZoom(currentPlan.appliedZoomValue);
        return;
      }
      if (maxZoomRatio === cardZoomRangeRef.current) return;
      cardZoomRangeRef.current = maxZoomRatio;

      const plan = resolveCardZoomPlan({
        maxZoomRatio,
        minZoomRatio: diag?.minZoomRatio,
      });
      setActiveCardZoomPlan(plan);
      cardZoomPlanRef.current = plan;
      setCardZoomPlan(plan);
      setCameraZoom(plan.appliedZoomValue);
      logCardCaptureProfile(plan);
      logCardZoomApplied({
        expoZoomProp: plan.appliedZoomValue,
        expectedNativeZoomRatio: plan.effectiveMagnification,
        reportedNativeZoomRatio: diag?.zoomRatio ?? null,
      });
    },
    [documentType, getCameraResolutionDiag, onAutofocusStateChanged]
  );

  useEffect(() => {
    if (documentType === 'business_card') return;
    resetActiveCardZoomPlan();
  }, [documentType]);

  // La cornice del biglietto dipende anche dal profilo di ripresa risolto: il
  // piano entra nelle dipendenze perché a 2x il riquadro torna ampio.
  const overlayFrame = useMemo(
    () =>
      getOverlayFrameRectInView(
        viewportWidth,
        viewportHeight,
        documentType,
        cardOrientation,
        viewportInsets,
      ),
    [viewportWidth, viewportHeight, documentType, cardOrientation, viewportInsets, cardZoomPlan]
  );

  const overlayFrameCenter = useMemo(
    () =>
      getOverlayFrameCenterInView(
        viewportWidth,
        viewportHeight,
        documentType,
        cardOrientation,
        viewportInsets,
      ),
    [viewportWidth, viewportHeight, documentType, cardOrientation, viewportInsets, cardZoomPlan]
  );

  const cameraFocusProps = useMemo(
    () =>
      overlayCardFocusProps(
        viewportWidth,
        viewportHeight,
        documentType,
        cardOrientation,
        viewportInsets,
        undefined,
        focusPulseKey
      ),
    [viewportWidth, viewportHeight, documentType, cardOrientation, viewportInsets, focusPulseKey]
  );
  // Il punto di misurazione va passato anche al biglietto: senza, la camera
  // nativa mette a fuoco l'angolo in alto a sinistra dell'anteprima invece del
  // riquadro, e il biglietto resta morbido pur essendo inquadrato bene.
  const cameraViewFocusProps = stabilizeFocusProps(cameraFocusProps);

  useEffect(() => {
    const isCard = documentType === 'business_card';
    cardFocusTracker.setEnabled(isCard);
    documentFocusTracker.setEnabled(!isCard);
    return () => {
      cardFocusTracker.setEnabled(false);
      documentFocusTracker.setEnabled(false);
    };
  }, [documentType]);

  const selectCardOrientation = useCallback(
    (next: CardOrientation) => {
      if (
        captureInProgress.current ||
        processingGateRef.current.isLocked()
      ) {
        return;
      }
      if (next === businessCardOrientation) return;
      invalidateCaptureOperation('orientation_changed');
      setBusinessCardOrientation(next);
    },
    [businessCardOrientation, invalidateCaptureOperation]
  );

  // Backward-compatible identifier used by UI contract tests.
  // We keep it as an alias so the callback identity matches `selectCardOrientation`.
  const toggleOrientation = selectCardOrientation;

  const prevOrientationRef = useRef(cardOrientation);
  useEffect(() => {
    if (!cameraReady) return;
    if (prevOrientationRef.current === cardOrientation) return;
    prevOrientationRef.current = cardOrientation;
    if (documentType !== 'business_card') {
      invalidateCaptureOperation('orientation_changed');
    }
    void pulseAutofocus();
  }, [cardOrientation, cameraReady, documentType, invalidateCaptureOperation, pulseAutofocus]);

  const showOrientationInHeader =
    documentType !== 'business_card' || businessMode === 'card';
  const modeControlsDisabled =
    scanning || isProcessingDoc || pendingDocumentPhoto != null;

  const selectDocumentCaptureMode = useCallback((mode: DocumentCaptureMode) => {
    if (
      documentType === 'business_card' ||
      mode === captureMode ||
      captureInProgress.current ||
      processingGateRef.current.isLocked()
    ) return;
    invalidateCaptureOperation('orientation_changed');
    setCameraZoom(0);
    onCaptureModeChange(mode);
  }, [captureMode, documentType, invalidateCaptureOperation, onCaptureModeChange]);

  useEffect(() => {
    if (documentType === 'business_card' || captureMode !== 'landscape-left') return;
    setCaptureHint(t('rotatePhoneCounterclockwise'));
    const timer = setTimeout(() => setCaptureHint(null), 1800);
    return () => clearTimeout(timer);
  }, [captureMode, documentType, t]);

  // Suggerimento di inquadratura all'apertura: la nitidezza ai bordi migliora
  // se il biglietto viene ripreso da poco più lontano.
  useEffect(() => {
    if (documentType !== 'business_card' || !cameraReady) return;
    setCaptureHint(t('cardFramingHint'));
    const timer = setTimeout(() => setCaptureHint(null), 2600);
    return () => clearTimeout(timer);
  }, [cameraReady, documentType, t]);

  // L'avviso sulla luce nasce durante l'elaborazione, quando la camera non è
  // visibile: il tempo parte solo quando l'utente può davvero leggerlo, e mai
  // insieme al suggerimento di inquadratura.
  useEffect(() => {
    if (!lowLightNotice || scanning || isProcessingDoc || captureHint) return;
    const timer = setTimeout(() => setLowLightNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [captureHint, isProcessingDoc, lowLightNotice, scanning]);

  const importPdf = useCallback(async () => {
    if (
      !screenActiveRef.current ||
      captureInProgress.current ||
      processingGateRef.current.isLocked()
    ) {
      return;
    }
    // L'estrazione del PDF è interamente cloud: senza il permesso dedicato la
    // sospensione AI vale anche qui, altrimenti basterebbe un PDF per aggirarla.
    if (!isRcPdfImportEnabled()) {
      Alert.alert(t('importPdf'), t('pdfImportAiDeferred'));
      return;
    }
    const exclusiveLease = processingGateRef.current.tryAcquire();
    if (!exclusiveLease) return;
    if (!isSupabaseConfigured()) {
      Alert.alert(t('supabaseNotConfiguredTitle'), t('supabaseNotConfiguredMessage'));
      exclusiveLease.release();
      return;
    }

    invalidateCaptureOperation('manual');
    const operation = processOperationsRef.current.begin();
    pendingProcessSettlementsRef.current.add(exclusiveLease.operationId);
    const isBeforeClaimActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    const isClaimCurrent = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isCurrent();
    setScanning(true);
    setIsProcessingDoc(true);
    // Ogni import riparte dalla prima fase: la barra non eredita mai il valore
    // dell'importazione precedente.
    resetPdfProgressDiagnostics();
    const prepareProgress = pdfStageProgress('prepare');
    setProcessProgress(prepareProgress);
    logPdfProgressChange(
      prepareProgress.percent,
      pdfProgressPhaseLabel(prepareProgress.messageKey),
      'real_event'
    );
    let navigated = false;
    try {
      const { document, errorCode, aiCreditsRemaining } = await pickAndParsePdf(
        documentType,
        {
          onProgress: (progress) => {
            if (!mountedRef.current || !operation.isCurrent()) return;
            setProcessProgress((previous) =>
              previous && previous.percent > progress.percent ? previous : progress);
          },
        }
      );
      for (const uri of document?.images ?? []) trackSessionAsset(uri);
      if (!isBeforeClaimActive()) return;
      if (errorCode) {
        Alert.alert(t('pdfErrorTitle'), t(pdfErrorMessageKey(errorCode)));
        return;
      }
      // Nessun codice e nessun documento: l'utente ha chiuso il selettore.
      if (!document) return;
      // Saldo Edge autoritativo dopo addebito riuscito (mai calcolato in locale).
      updateAiCreditsRemaining(aiCreditsRemaining, 'pdf');

      await yieldToOperationEventLoop();
      if (!isBeforeClaimActive()) return;
      if (!operation.tryFinalize()) return;
      const persistProgress = pdfStageProgress('persist');
      setProcessProgress(persistProgress);
      logPdfProgressChange(
        persistProgress.percent,
        pdfProgressPhaseLabel(persistProgress.messageKey),
        'real_event'
      );
      await addDocument(document, {
        operationId: operation.operationId,
        isActive: isClaimCurrent,
      });
      if (!isClaimCurrent()) return;
      // Il cento per cento arriva solo a documento creato: un errore non lo raggiunge mai.
      const doneProgress = pdfStageProgress('done');
      setProcessProgress(doneProgress);
      logPdfProgressChange(
        doneProgress.percent,
        pdfProgressPhaseLabel(doneProgress.messageKey),
        'real_event'
      );
      router.replace(`/document/${document.id}`);
      navigated = true;
    } catch (error) {
      if (error instanceof DocumentDuplicateCancelledError) return;
      if (error instanceof DocumentDuplicateOpenExistingError) {
        router.replace(`/document/${error.existingId}`);
        navigated = true;
        return;
      }
      if (
        isInactiveScanOperationError(error) ||
        !mountedRef.current ||
        !screenActiveRef.current ||
        !operation.isCurrent()
      ) {
        return;
      }
      runtimeLogger.error('PDF_IMPORT_FAILED', error, {
        stage: 'parse',
        status: 'failed',
      });
      Alert.alert(t('pdfErrorTitle'), t('pdfImportFailed'));
    } finally {
      const wasCurrent = processOperationsRef.current.isCurrent(operation);
      if (wasCurrent) processOperationsRef.current.finish(operation);
      if (!navigated) exclusiveLease.release();
      pendingProcessSettlementsRef.current.delete(exclusiveLease.operationId);
      flushDeferredSessionAssets();
      if (
        wasCurrent &&
        !navigated &&
        mountedRef.current &&
        screenActiveRef.current
      ) {
        setScanning(false);
        setIsProcessingDoc(false);
        setProcessProgress(null);
      }
    }
  }, [
    addDocument,
    documentType,
    flushDeferredSessionAssets,
    invalidateCaptureOperation,
    t,
    trackSessionAsset,
  ]);

  const requestPdfImport = useCallback(() => {
    if (scanning || processingGateRef.current.isLocked()) return;
    setShowPdfAiModal(true);
  }, [scanning]);

  const confirmPdfImport = useCallback(() => {
    setShowPdfAiModal(false);
    void importPdf();
  }, [importPdf]);

  // Arrivando dal comando PDF dell'elenco documenti la richiesta di consenso
  // va proposta una sola volta, senza ripresentarsi se l'utente annulla.
  const autoPdfRequestedRef = useRef(false);
  useEffect(() => {
    if (!autoImportPdf || documentType === 'business_card') return;
    if (autoPdfRequestedRef.current) return;
    autoPdfRequestedRef.current = true;
    requestPdfImport();
  }, [autoImportPdf, documentType, requestPdfImport]);

  useLayoutEffect(() => {
    if (isDocumentLandscape) {
      navigation.setOptions({ headerRight: undefined });
      return;
    }
    if (!showOrientationInHeader) {
      navigation.setOptions({ headerRight: undefined });
      return;
    }

    // L'importazione PDF è sempre vissuta qui, accanto ai comandi di
    // orientamento: è il punto in cui si sceglie come acquisire il documento.
    const showPdf = documentType !== 'business_card' && isSupabaseConfigured();

    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerActions}>
          {showPdf ? (
            <TouchableOpacity
              onPress={requestPdfImport}
              disabled={scanning}
              style={[styles.headerPdfBtn, scanning && styles.headerBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel={t('importPdf')}
            >
              <Text style={[styles.headerPdfText, scanning && styles.disabledText]}>
                📄 PDF
              </Text>
            </TouchableOpacity>
          ) : null}
          {documentType === 'business_card' ? (
            (['portrait', 'landscape'] as const).map((mode) => (
              <TouchableOpacity
                key={mode}
                onPress={() => toggleOrientation(mode)}
                disabled={scanning || isProcessingDoc}
                style={[
                  styles.headerDocumentModeButton,
                  (scanning || isProcessingDoc) && styles.headerBtnDisabled,
                  cardOrientation === mode && styles.headerDocumentModeButtonActive,
                ]}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: cardOrientation === mode,
                  disabled: scanning || isProcessingDoc,
                }}
                accessibilityLabel={t(
                  mode === 'portrait' ? 'orientationPortrait' : 'orientationLandscape'
                )}
              >
                <DocumentModeGlyph
                  mode={mode === 'landscape' ? 'landscape-left' : 'portrait'}
                  selected={cardOrientation === mode}
                />
              </TouchableOpacity>
            ))
          ) : (
            (['portrait', 'landscape-left'] as const).map((mode) => (
              <TouchableOpacity
                key={mode}
                onPress={() => selectDocumentCaptureMode(mode)}
                disabled={modeControlsDisabled}
                style={[
                  styles.headerDocumentModeButton,
                  modeControlsDisabled && styles.headerBtnDisabled,
                  displayedCaptureMode === mode && styles.headerDocumentModeButtonActive,
                ]}
                accessibilityRole="radio"
                accessibilityState={{
                  checked: displayedCaptureMode === mode,
                  disabled: modeControlsDisabled,
                }}
                accessibilityLabel={t(
                  mode === 'portrait'
                    ? 'documentCapturePortrait'
                    : 'documentCaptureLandscape',
                )}
                accessibilityHint={t(
                  mode === 'portrait'
                    ? 'documentCapturePortraitHint'
                    : 'documentCaptureLandscapeHint',
                )}
              >
                <DocumentModeGlyph
                  mode={mode}
                  selected={displayedCaptureMode === mode}
                />
              </TouchableOpacity>
            ))
          )}
        </View>
      ),
    });
  }, [
    navigation,
    showOrientationInHeader,
    cardOrientation,
    captureMode,
    displayedCaptureMode,
    selectDocumentCaptureMode,
    toggleOrientation,
    requestPdfImport,
    t,
    documentType,
    scanning,
    isProcessingDoc,
    isDocumentLandscape,
    modeControlsDisabled,
  ]);

  const selectBusinessMode = (mode: BusinessScanKind) => {
    if (
      captureInProgress.current ||
      processingGateRef.current.isLocked()
    ) return;
    invalidateCaptureOperation('mode_changed');
    setBusinessMode(mode);
    if (mode === 'card') {
      setBusinessCardOrientation('landscape');
    }
  };

  const handleCameraReady = useCallback(() => {
    onCameraSessionReady();
    onCameraReadyFocus();
  }, [onCameraSessionReady, onCameraReadyFocus]);

  const handleRemountCamera = useCallback(() => {
    invalidateCaptureOperation('manual');
    remountCamera();
  }, [invalidateCaptureOperation, remountCamera]);

  useFocusEffect(
    useCallback(() => {
      closeSessionAssets();
      sessionAssetScopeRef.current = createTemporaryAssetScope({
        cleanup: cleanupScanSessionImageUri,
      });
      screenActiveRef.current = true;
      setDocumentPages([]);
      setPendingDocumentPhoto(null);
      setBusinessScans([]);
      setScanning(false);
      setIsProcessingDoc(false);
      setCaptureHint(null);
      setLowLightNotice(null);
      setCameraZoom(resetCameraZoom(captureProfileRef.current));
      // Ogni sessione riparte dal profilo prudente: le capacità della camera
      // diranno se il dispositivo può davvero riprendere a circa 2x.
      resetActiveCardZoomPlan();
      setCardZoomPlan(null);
      cardZoomPlanRef.current = null;
      cardZoomRangeRef.current = undefined;
      return () => {
        screenActiveRef.current = false;
        invalidateCaptureOperation('screen_blurred');
        processOperationsRef.current.invalidateCurrent('screen_blurred');
        closeSessionAssets();
        processingGateRef.current.invalidateCurrent();
      };
    }, [closeSessionAssets, invalidateCaptureOperation])
  );


  const capturePhoto = useCallback(async () => {
    const captureBlockReasons = [
      captureInProgress.current ? 'capture_in_progress' : null,
      processingGateRef.current.isLocked() ? 'processing_gate_locked' : null,
      !cameraRef.current ? 'camera_ref_missing' : null,
      !cameraReady ? 'camera_not_ready' : null,
      !cameraCaptureReady ? 'camera_stream_stabilizing' : null,
      documentType !== 'business_card' && !documentViewportModeMaterialized
        ? 'document_viewport_not_materialized'
        : null,
      documentType !== 'business_card' && !documentOverlayReady
        ? 'document_overlay_not_ready'
        : null,
    ].filter((reason): reason is string => Boolean(reason));

    if (captureBlockReasons.length > 0) {
      console.warn('[CameraCapture] blocked', {
        documentType,
        documentCategory: documentCategory ?? null,
        acquisitionSessionKey: acquisitionSessionKey ?? 'legacy',
        reasons: captureBlockReasons,
      });
      return;
    }
    const operation = captureOperationsRef.current.begin();
    const captureScope = createTemporaryAssetScope({
      cleanup: cleanupScanSessionImageUri,
    });
    const isCaptureActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    captureInProgress.current = true;
    const focusTracker =
      documentType === 'business_card' ? cardFocusTracker : documentFocusTracker;
    setScanning(true);
    setCaptureHint(null);

    const { width: vw, height: vh, insets: vi } = overlayContextRef.current;
    const screenWUsed = vw || screenW;
    const screenHUsed = vh || screenH;
    const focusPoint = { nx: overlayFrameCenter.nx, ny: overlayFrameCenter.ny };
    let pendingNativeCapture: Promise<CapturedPhoto> | null = null;
    // A later crop/copy failure is not a shutter failure when we already have
    // a JPEG URI. The error shown to the user must say which step failed.
    let jpegCaptured = false;

    try {
      for (let attempt = 0; attempt <= MAX_SHARPNESS_RETRIES; attempt++) {
        focusTracker.markCaptureRequested();
        const afLock = await prepareForCapture(
          documentType === 'business_card' && attempt === 0
            ? 'card'
            : attempt === 0
              ? 'fast'
              : 'retry'
        );
        if (!isCaptureActive()) return;
        logFocusTimeline('TAKE_PICTURE', `attempt=${attempt} af=${afLock}`);

        const camera = cameraRef.current;
        if (!camera) return;
        // Da qui il fuoco non deve più muoversi: la cattura JPEG è iniziata.
        holdFocusForCapture();
        focusTracker.markJpegStarted();
        const captureTimestamp = Date.now();
        const shutterCaptureMode: DocumentCaptureMode =
          documentType === 'business_card'
            ? captureMode
            : isDocumentLandscape
              ? 'landscape-left'
              : 'portrait';
        if (documentType !== 'business_card' && shutterCaptureMode !== captureMode) {
          console.warn('[DocumentCaptureGeometry] materialized_mode', {
            requestedCaptureMode: captureMode,
            materializedCaptureMode: shutterCaptureMode,
            viewportWidth,
            viewportHeight,
            windowWidth: screenW,
            windowHeight: screenH,
          });
        }
        const shutterDeviceOrientation: DeviceCaptureOrientation =
          shutterCaptureMode === 'landscape-left' ? 'landscape-left' : 'portrait';
        logCameraOrientation('capture_begin', {
          captureMode: shutterCaptureMode,
          deviceOrientation: shutterDeviceOrientation,
          skipProcessing: false,
          quality: 1,
          exif: true,
        });
        logCameraOrientation('device_at_shutter', {
          captureMode: shutterCaptureMode,
          deviceOrientation: shutterDeviceOrientation,
        });
        const nativeCapture = Promise.resolve().then(
          () =>
            camera.takePictureAsync({
              quality: 1,
              base64: false,
              // Su Android skipProcessing lascia i pixel nel verso grezzo del
              // sensore e l'Image React Native non applica l'EXIF in modo
              // affidabile. Per i documenti facciamo materializzare una volta
              // l'orientamento dalla pipeline nativa della camera e non
              // conserviamo un tag EXIF che possa essere reinterpretato.
              exif: true,
              skipProcessing: false,
            }) as Promise<CapturedPhoto>
        );
        pendingNativeCapture = nativeCapture;
        const captureOutcome = await runTimedOperation<CapturedPhoto | null>({
          operationId: `${operation.operationId}-capture-${attempt}`,
          timeoutMs: CAPTURE_TIMEOUT_MS,
          fallback: null,
          isExternallyActive: isCaptureActive,
          task: () => nativeCapture,
          onDiscardedValue: (latePhoto) => {
            if (latePhoto?.uri) captureScope.track(latePhoto.uri);
          },
        });
        if (captureOutcome.status !== 'timed_out') {
          pendingNativeCapture = null;
        }
        // Il JPEG è concluso: solo ora la cattura è davvero eseguita e
        // l'autofocus continuo può riprendere.
        focusTracker.markJpegCompleted(afLock);
        releaseFocusAfterCapture();
        if (captureOutcome.status === 'failed') throw captureOutcome.error;
        if (captureOutcome.status === 'timed_out') {
          throw new Error('Scatto non riuscito. Riprova.');
        }
        if (captureOutcome.status !== 'completed') return;
        const photo = captureOutcome.value;
        if (photo?.uri) captureScope.track(photo.uri);
        if (!isCaptureActive()) return;

        if (!photo?.uri) {
          throw new Error('Foto non acquisita');
        }
        jpegCaptured = true;

        const { width: photoW, height: photoH } = await getImageSize(photo.uri);
        if (!isCaptureActive()) return;
        logCameraOrientation('picture_result', {
          uri: photo.uri,
          photoWidth: photo.width ?? null,
          photoHeight: photo.height ?? null,
          measuredWidth: photoW,
          measuredHeight: photoH,
          deviceOrientation: shutterDeviceOrientation,
          captureMode: shutterCaptureMode,
        });

        if (documentType !== 'business_card') {
          const captureWidth = photo.width && photo.width > 0 ? photo.width : photoW;
          const captureHeight = photo.height && photo.height > 0 ? photo.height : photoH;
          const expectsLandscape = shutterCaptureMode === 'landscape-left';
          const captureOrientation = shutterDeviceOrientation;
          const previewOrientation = expectsLandscape ? 'landscape' : 'portrait';
          const originalExif = readCapturedExifOrientation(photo.exif);
          const rawExif = readRawCapturedExifValue(photo.exif);
          const cameraDiag = getCameraResolutionDiag();
          logCameraOrientation('exif', {
            rawExifOrientation: rawExif,
            sanitizedExifOrientation: originalExif,
            width: captureWidth,
            height: captureHeight,
            cameraProcessingApplied: true,
            deviceOrientation: shutterDeviceOrientation,
            captureMode: shutterCaptureMode,
          });
          const oriented = await normalizeCapturedDocumentOrientation(
            photo.uri,
            {
              width: captureWidth,
              height: captureHeight,
              exifOrientation: originalExif,
              deviceOrientationAtCapture: captureOrientation,
              previewOrientation,
              platform: Platform.OS === 'ios' ? 'ios' : 'android',
              cameraProcessingApplied: true,
              rawCapturePreserved: false,
              captureMode: shutterCaptureMode,
              cameraFacing: captureProfile.facing,
            },
            {
              deviceRotation: captureOrientation,
              displayRotation: null,
              screenOrientation: shutterCaptureMode,
              captureMode: shutterCaptureMode,
              sensorOrientation: cameraDiag?.imageCaptureSize ?? null,
              cameraFacing: captureProfile.facing,
              photoWidth: captureWidth,
              photoHeight: captureHeight,
              exifOrientation: originalExif,
              cameraProcessingApplied: true,
            },
            {
              previousPages: documentPages.map((page) => ({
                rotationApplied: page.metadata.rotationApplied,
                normalizedWidth: page.metadata.canonicalWidth ?? page.metadata.width,
                normalizedHeight: page.metadata.canonicalHeight ?? page.metadata.height,
                sourceWidth: page.metadata.sourceWidth,
                sourceHeight: page.metadata.sourceHeight,
                captureOrientation: page.metadata.captureOrientation,
              })),
            },
          );
          const canonicalUri = oriented.normalizedUri;
          const canonicalWidth = oriented.normalizedWidth;
          const canonicalHeight = oriented.normalizedHeight;
          if (canonicalUri !== photo.uri) {
            captureScope.track(canonicalUri);
          }
          if (!isCaptureActive()) return;

          const ocrPlan = await buildScanPlan(
            canonicalUri,
            canonicalWidth,
            canonicalHeight,
            documentType,
            cardOrientation,
            screenWUsed,
            screenHUsed,
            vi,
            cameraDiag,
          );
          if (ocrPlan.sourceUri && ocrPlan.sourceUri !== canonicalUri) {
            captureScope.track(ocrPlan.sourceUri);
          }
          if (!isCaptureActive()) return;

          const cropSafety = assessDocumentCropSafety(ocrPlan);
          let croppedUri: string | null = null;
          if (cropSafety.useCropForOcr) {
            croppedUri = await prepareScannedImageFromPlan(
              ocrPlan.sourceUri ?? canonicalUri,
              ocrPlan,
            );
            captureScope.track(croppedUri);
            if (!isCaptureActive()) return;
          }
          const preReadingUri = croppedUri ?? canonicalUri;
          const preReadingSize = await getImageSize(preReadingUri);
          if (!isCaptureActive()) return;
          const readingOriented = await normalizeDocumentReadingOrientation(
            preReadingUri,
            preReadingSize.width,
            preReadingSize.height,
          );
          const persistedUri = readingOriented.normalizedUri;
          const ocrUri = persistedUri;
          const persistedSize = {
            width: readingOriented.normalizedWidth,
            height: readingOriented.normalizedHeight,
          };
          if (persistedUri !== preReadingUri) captureScope.track(persistedUri);
          if (!isCaptureActive()) return;

          const combinedRotation = ((oriented.rotationApplied + readingOriented.rotationApplied) % 360) as 0 | 90 | 180 | 270;
          const baseMetadata = withConfirmedDocumentImage(
            {
              ...oriented.metadata,
              sourceWidth: captureWidth,
              sourceHeight: captureHeight,
              originalPersistedWidth: captureWidth,
              originalPersistedHeight: captureHeight,
              cropDecision: cropSafety.cropDecision,
              ocrWidth: persistedSize.width,
              ocrHeight: persistedSize.height,
              persistedWidth: persistedSize.width,
              persistedHeight: persistedSize.height,
            },
            {
              selectedCaptureMode: shutterCaptureMode,
              originalWidth: captureWidth,
              originalHeight: captureHeight,
              canonicalWidth,
              canonicalHeight,
              originalUri: photo.uri,
              canonicalUri,
              previewContentRect: {
                x: 0,
                y: 0,
                width: screenWUsed,
                height: screenHUsed,
              },
              overlayRect: ocrPlan.debug.overlayRect,
            },
          );
          const metadata: DocumentPageCaptureMetadata = {
            ...baseMetadata,
            rotationApplied: combinedRotation,
            captureTimestamp,
            screenOrientationAtCapture: shutterCaptureMode,
            cameraProcessingApplied: true,
            previewWidth: screenWUsed,
            previewHeight: screenHUsed,
            ...(cameraDiag?.previewStreamSize
              ? { previewStreamSize: cameraDiag.previewStreamSize }
              : {}),
            ...(cameraDiag?.imageCaptureSize
              ? { imageCaptureSize: cameraDiag.imageCaptureSize }
              : {}),
            bitmapWidth: ocrPlan.debug.normalizedWidth,
            bitmapHeight: ocrPlan.debug.normalizedHeight,
            ...(ocrPlan.debug.cropRect
              ? { cropRect: { ...ocrPlan.debug.cropRect } }
              : {}),
            ...(cropSafety.cropAreaRatio == null
              ? {}
              : { cropAreaRatio: cropSafety.cropAreaRatio }),
            cropDecision: cropSafety.cropDecision,
            ocrWidth: persistedSize.width,
            ocrHeight: persistedSize.height,
            persistedWidth: persistedSize.width,
            persistedHeight: persistedSize.height,
          };
          logCameraOrientation('preview', {
            uri: persistedUri,
            width: persistedSize.width,
            height: persistedSize.height,
            rotationApplied: combinedRotation,
            deviceOrientation: shutterDeviceOrientation,
          });
          logCameraOrientation('ocr_input', {
            uri: ocrUri,
            width: persistedSize.width,
            height: persistedSize.height,
            sameAsPreview: true,
          });
          trackSessionAsset(photo.uri);
          trackSessionAsset(canonicalUri);
          if (croppedUri) trackSessionAsset(croppedUri);
          if (persistedUri !== preReadingUri) trackSessionAsset(persistedUri);
          if (!operation.tryFinalize()) return;
          captureScope.retain(photo.uri);
          captureScope.retain(canonicalUri);
          if (croppedUri) captureScope.retain(croppedUri);
          if (persistedUri !== preReadingUri) captureScope.retain(persistedUri);
          setPendingDocumentPhoto({
            page: {
              uri: persistedUri,
              ocrUri,
              originalUri: photo.uri,
              metadata,
            },
          });
          return;
        }

        if (documentType === 'business_card' && businessMode === 'person') {
          const sharpness = await measureFullFrameSharpness(photo.uri);
          if (!isCaptureActive()) return;
          const afBypass =
            afLock !== 'FOCUSED_LOCKED' &&
            (afLock === 'TIMEOUT' || afLock === 'PASSIVE_SCAN' || afLock === 'ACTIVE_SCAN') &&
            sharpness.passed;
          if (afBypass) {
            logFocusTimeline(
              'AF_BYPASS_SHARPNESS_OK',
              `af=${afLock} score=${sharpness.score.toFixed(1)}`
            );
          }
          logCaptureDebug({
            originalWidth: photoW,
            originalHeight: photoH,
            cropWidth: sharpness.cropWidth,
            cropHeight: sharpness.cropHeight,
            sharpnessScore: sharpness.score,
            sharpnessPassed: sharpness.passed,
            minZoneScore: sharpness.minZoneScore,
            zoneScores: sharpness.zoneScores,
            retryCount: attempt,
            focusPoint,
            documentType,
            cardOrientation,
            afState: afLock,
            cameraDiag: getCameraResolutionDiag(),
          });

          if (!sharpness.passed) {
            if (attempt < MAX_SHARPNESS_RETRIES) {
              setCaptureHint(t('focusWaitHint'));
              continue;
            }
            Alert.alert(t('error'), t('imageTooSoft'));
            return;
          }

          const preparedPhotoUri = await preparePersonPhoto(
            photo.uri,
            photoW,
            photoH,
            screenWUsed,
            screenHUsed
          );
          captureScope.track(preparedPhotoUri);
          if (!isCaptureActive()) return;
          const imageUris = imagePipelineUris(photo.uri, preparedPhotoUri);
          trackSessionAsset(imageUris.persistenceSourceUri);
          if (!operation.tryFinalize()) return;
          captureScope.retain(imageUris.persistenceSourceUri);
          setBusinessScans((prev) => [
            ...prev,
            { uri: imageUris.persistenceSourceUri, kind: 'person' },
          ]);
          void pulseAutofocus();
          return;
        }

        const captureSourceUri = photo.uri;
        logCardGeometry({
          stage: 'raw_capture',
          viewportWidth: screenWUsed,
          viewportHeight: screenHUsed,
          photoWidth: photoW,
          photoHeight: photoH,
          exifOrientation: readCapturedExifOrientation(photo.exif) ?? null,
          cameraZoom,
          cardOrientation,
        });
        // Image.getSize riflette gli assi realmente visualizzati dopo il
        // processing EXIF di Expo; photo.width/height possono restare sugli
        // assi nativi del sensore su alcuni dispositivi Android.
        let captureWidth = photoW;
        let captureHeight = photoH;

        // CameraX/Expo può consegnare un bitmap orizzontale mentre la
        // CameraView e la cornice erano portrait. In quel caso la mappatura
        // cornice→JPEG non è valida: materializziamo prima l'asse portrait.
        // Il verso di lettura (0/180) è deciso successivamente dall'OCR.
        let captureUriForCardPlan = captureSourceUri;
        if (shutterCaptureMode === 'portrait' && captureWidth > captureHeight) {
          captureUriForCardPlan = await rotateImage(captureSourceUri, 90);
          captureScope.track(captureUriForCardPlan);
          const normalizedSize = await getImageSize(captureUriForCardPlan);
          captureWidth = normalizedSize.width;
          captureHeight = normalizedSize.height;
          console.warn('[BusinessCardOrientation] capture_axis_normalized_before_crop', {
            sourceWidth: photoW,
            sourceHeight: photoH,
            normalizedWidth: captureWidth,
            normalizedHeight: captureHeight,
            captureMode: shutterCaptureMode,
          });
        }

        const cameraDiag = getCameraResolutionDiag();
        const plan = await buildScanPlan(
          captureUriForCardPlan,
          captureWidth,
          captureHeight,
          documentType,
          cardOrientation,
          screenWUsed,
          screenHUsed,
          vi,
          cameraDiag
        );
        if (plan.sourceUri) captureScope.track(plan.sourceUri);
        if (!isCaptureActive()) return;

        const fullFrameUri = plan.sourceUri ?? captureUriForCardPlan;
        // Il ritaglio sulla cornice viene usato solo se la sua geometria è
        // verificabile. Se la mappatura anteprima→pixel non è affidabile si
        // conserva l'inquadratura intera: meglio un'immagine più larga che una
        // porzione sbagliata della scena.
        const cropSafety = assessCardCropSafety(plan);
        const useOverlayCrop = cropSafety.useCropForOcr;

        // P0-BC-01: mai OCR sul fotogramma intero in modalita biglietto.
        if (!useOverlayCrop) {
          console.warn('[BusinessCardBoundary] crop_rejected', {
            cropDecision: cropSafety.cropDecision,
            cropAreaRatio: cropSafety.cropAreaRatio,
            uncertaintyReason: plan.debug.cardMapping?.uncertaintyReason ?? null,
          });
          if (CARD_GEOMETRY_QA_DIAGNOSTICS && plan.debug.cropRect) {
            await saveCardCaptureArtifacts({
              rawUri: fullFrameUri,
              boundaryMode: 'none',
              rejectionReason: 'crop_unreliable',
              photoWidth: plan.debug.normalizedWidth,
              photoHeight: plan.debug.normalizedHeight,
              cropX: plan.debug.cropRect.x,
              cropY: plan.debug.cropRect.y,
              cropWidth: plan.debug.cropRect.width,
              cropHeight: plan.debug.cropRect.height,
            });
            if (!isCaptureActive()) return;
          }
          Alert.alert(
            'Scansione da ripetere',
            'Il contorno del biglietto non e stato rilevato con sufficiente precisione. Inquadra tutto il biglietto dentro la cornice e riprova.'
          );
          return;
        }
        logCardGeometry({
          stage: 'crop_plan',
          viewportWidth: screenWUsed,
          viewportHeight: screenHUsed,
          overlayX: plan.debug.overlayRect.x,
          overlayY: plan.debug.overlayRect.y,
          overlayWidth: plan.debug.overlayRect.width,
          overlayHeight: plan.debug.overlayRect.height,
          photoWidth: photoW,
          photoHeight: photoH,
          normalizedWidth: plan.debug.normalizedWidth,
          normalizedHeight: plan.debug.normalizedHeight,
          previewStreamSize: cameraDiag?.previewStreamSize ?? null,
          imageCaptureSize: cameraDiag?.imageCaptureSize ?? null,
          cropX: plan.debug.cropRect?.x,
          cropY: plan.debug.cropRect?.y,
          cropWidth: plan.debug.cropRect?.width,
          cropHeight: plan.debug.cropRect?.height,
          cropAreaRatio: cropSafety.cropAreaRatio,
          cropDecision: cropSafety.cropDecision,
          cropApplied: useOverlayCrop,
          mappingMode: plan.debug.cardMapping?.mappingMode,
          previewScale: plan.debug.cardMapping?.previewScale,
          previewCropOffsetX: plan.debug.cardMapping?.previewCropOffsetX,
          previewCropOffsetY: plan.debug.cardMapping?.previewCropOffsetY,
          orientationTransformApplied:
            plan.debug.cardMapping?.orientationTransformApplied,
          cropValidated: plan.debug.cardMapping?.cropValidated,
          uncertaintyReason: plan.debug.cardMapping?.uncertaintyReason,
          alignRotation: plan.alignRotation,
          readingRotation: plan.readingRotation,
          cameraZoom,
          cardOrientation,
        });

        let ocrPreparedUri = await prepareScannedImageFromPlan(
          plan.sourceUri ?? photo.uri,
          plan
        );
        const overlayCropUri = ocrPreparedUri;
        captureScope.track(ocrPreparedUri);
        if (!isCaptureActive()) return;

        // P0-BC-01: la cornice camera dimostra solo la mappatura preview→JPEG.
        // Prima dell'OCR deve essere dimostrato anche il bordo fisico del
        // cartoncino. Mai full-frame OCR: se il bordo fisico resta ambiguo,
        // conserviamo solo il crop gia verificato della cornice.
        // Gate strutturale a due livelli: non basta abbassare la confidence.
        // - >= 0.78: comportamento storico, accetta il rettangolo.
        // - 0.70..0.78: accetta SOLO se il supporto rilevato occupa una porzione
        //   ampia del crop overlay. Questo recupera carte inclinate ma complete
        //   senza riaprire il caso di crop mutilati/decentrati a confidence media.
        // Nessuna nuova elaborazione: usa confidence e areaRatio gia calcolati
        // dal detector del boundary.
        const STRONG_RECTANGLE_BOUNDARY_CONFIDENCE = 0.78;
        const CONDITIONAL_RECTANGLE_BOUNDARY_CONFIDENCE = 0.70;
        const CONDITIONAL_RECTANGLE_MIN_AREA_RATIO = 0.72;
        const boundaryIsReliable = (result: Awaited<ReturnType<typeof refineBusinessCardBoundary>>) => {
          if (!result.applied) return false;
          if (result.mode !== 'rectangle_crop') return true;
          const confidence = result.detection?.confidence ?? 0;
          const areaRatio = result.detection?.areaRatio ?? 0;
          return (
            confidence >= STRONG_RECTANGLE_BOUNDARY_CONFIDENCE ||
            (confidence >= CONDITIONAL_RECTANGLE_BOUNDARY_CONFIDENCE &&
              areaRatio >= CONDITIONAL_RECTANGLE_MIN_AREA_RATIO)
          );
        };

        let boundaryRefinement = await refineBusinessCardBoundary(ocrPreparedUri);
        if (!isCaptureActive()) return;
        let boundaryRecoveryUsed = false;

        // Recovery SOLO nei casi ambigui: riusa il medesimo JPEG, amplia una
        // volta il crop e riprova il boundary. Nessun nuovo scatto, nessun OCR
        // aggiuntivo e nessun costo sul percorso normale gia valido.
        if (!boundaryIsReliable(boundaryRefinement)) {
          const recoveryCropUri = await prepareBusinessCardBoundaryRecoveryImage(
            plan.sourceUri ?? photo.uri,
            plan,
          );
          captureScope.track(recoveryCropUri);
          if (!isCaptureActive()) return;

          const recoveredBoundary = await refineBusinessCardBoundary(recoveryCropUri);
          if (!isCaptureActive()) return;
          if (boundaryIsReliable(recoveredBoundary)) {
            boundaryRefinement = recoveredBoundary;
            boundaryRecoveryUsed = true;
            console.warn('[BusinessCardBoundary] same_photo_recovery_applied', {
              mode: recoveredBoundary.mode,
              confidence: recoveredBoundary.detection?.confidence ?? null,
              areaRatio: recoveredBoundary.detection?.areaRatio ?? null,
            });
          }
        }

        let preparedCardUri = boundaryRefinement.uri;
        let overlayFallbackUsed = false;
        let preparedSharpness: Awaited<ReturnType<typeof measurePreparedBusinessCardSharpness>> | undefined;

        if (!boundaryIsReliable(boundaryRefinement)) {
          const overlaySharpness = await measurePreparedBusinessCardSharpness(overlayCropUri);
          if (!isCaptureActive()) return;

          if (shouldUseVerifiedOverlayFallback(overlaySharpness)) {
            // Il bordo fisico puo essere invisibile (carta e sfondo dello stesso
            // colore). La mappatura overlay→JPEG e gia verificata: se il suo
            // contenuto e realmente nitido, usa quel crop senza inventare un
            // contorno e senza obbligare l'utente a ripetere lo scatto.
            preparedCardUri = overlayCropUri;
            preparedSharpness = overlaySharpness;
            overlayFallbackUsed = true;
            console.warn('[BusinessCardBoundary] physical_boundary_fallback_overlay', {
              mode: boundaryRefinement.mode,
              confidence: boundaryRefinement.detection?.confidence ?? null,
              areaRatio: boundaryRefinement.detection?.areaRatio ?? null,
              sharpnessMedian: overlaySharpness.medianZoneScore,
              sharpnessMax: overlaySharpness.maxZoneScore,
            });
          }
        }

        if (!boundaryIsReliable(boundaryRefinement) && !overlayFallbackUsed) {
          console.warn('[BusinessCardBoundary] physical_boundary_rejected_after_recovery', {
            mode: boundaryRefinement.mode,
            confidence: boundaryRefinement.detection?.confidence ?? null,
            areaRatio: boundaryRefinement.detection?.areaRatio ?? null,
          });
          if (CARD_GEOMETRY_QA_DIAGNOSTICS && plan.debug.cropRect) {
            await saveCardCaptureArtifacts({
              rawUri: fullFrameUri,
              overlayCropUri,
              boundaryUri: boundaryRefinement.applied ? boundaryRefinement.uri : undefined,
              boundaryMode: boundaryRefinement.mode,
              boundaryConfidence: boundaryRefinement.detection?.confidence ?? null,
              boundaryAreaRatio: boundaryRefinement.detection?.areaRatio ?? null,
              boundaryRecoveryUsed,
              rejectionReason: 'boundary_unreliable',
              photoWidth: plan.debug.normalizedWidth,
              photoHeight: plan.debug.normalizedHeight,
              cropX: plan.debug.cropRect.x,
              cropY: plan.debug.cropRect.y,
              cropWidth: plan.debug.cropRect.width,
              cropHeight: plan.debug.cropRect.height,
            });
            if (!isCaptureActive()) return;
          }
          Alert.alert(
            'Scansione da ripetere',
            'Il biglietto non e completamente rilevabile. Tienilo tutto dentro la cornice, riduci l inclinazione e riprova.'
          );
          return;
        }

        // La nitidezza va giudicata DOPO aver isolato fisicamente il biglietto:
        // prima del boundary il tappetino puo essere molto piu nitido del testo e
        // falsare il gate. Questa sostituisce (non aggiunge) la vecchia misura.
        if (!preparedSharpness) {
          preparedCardUri = boundaryRefinement.uri;
          preparedSharpness = await measurePreparedBusinessCardSharpness(preparedCardUri);
          if (!isCaptureActive()) return;
        }

        const afLocked = afLock === 'FOCUSED_LOCKED';
        if (
          !afLocked &&
          preparedSharpness.passed &&
          (afLock === 'TIMEOUT' || afLock === 'PASSIVE_SCAN' || afLock === 'ACTIVE_SCAN')
        ) {
          logFocusTimeline(
            'AF_BYPASS_SHARPNESS_OK',
            `af=${afLock} score=${preparedSharpness.score.toFixed(1)}`
          );
        }

        logCaptureDebug({
          originalWidth: photoW,
          originalHeight: photoH,
          cropWidth: preparedSharpness.cropWidth,
          cropHeight: preparedSharpness.cropHeight,
          sharpnessScore: preparedSharpness.score,
          sharpnessPassed: preparedSharpness.passed,
          minZoneScore: preparedSharpness.minZoneScore,
          zoneScores: preparedSharpness.zoneScores,
          retryCount: attempt,
          focusPoint,
          documentType,
          cardOrientation,
          afState: afLock,
          cameraDiag,
        });

        if (!preparedSharpness.passed) {
          logFocusTimeline(
            'PREPARED_CARD_SHARPNESS_REJECT',
            `median=${preparedSharpness.medianZoneScore.toFixed(1)} max=${preparedSharpness.maxZoneScore.toFixed(1)}`
          );

          // In QA salva anche il tentativo RIFIUTATO. Prima di V35 i reject
          // sparivano dai pacchetti e non era possibile confrontarli col retry.
          if (CARD_GEOMETRY_QA_DIAGNOSTICS && plan.debug.cropRect) {
            await saveCardCaptureArtifacts({
              rawUri: fullFrameUri,
              overlayCropUri,
              boundaryUri: preparedCardUri,
              boundaryMode: overlayFallbackUsed ? 'verified_overlay_fallback' : boundaryRefinement.mode,
              boundaryConfidence: boundaryRefinement.detection?.confidence ?? null,
              boundaryAreaRatio: boundaryRefinement.detection?.areaRatio ?? null,
              boundaryRecoveryUsed,
              rejectionReason: 'prepared_image_too_soft',
              preparedSharpnessScore: preparedSharpness.score,
              preparedSharpnessMedian: preparedSharpness.medianZoneScore,
              preparedSharpnessMax: preparedSharpness.maxZoneScore,
              photoWidth: plan.debug.normalizedWidth,
              photoHeight: plan.debug.normalizedHeight,
              cropX: plan.debug.cropRect.x,
              cropY: plan.debug.cropRect.y,
              cropWidth: plan.debug.cropRect.width,
              cropHeight: plan.debug.cropRect.height,
            });
            if (!isCaptureActive()) return;
          }

          Alert.alert(
            'Scansione da ripetere',
            'La foto del biglietto non e abbastanza leggibile. Tienilo tutto dentro la cornice, evita una forte inclinazione e riprova una sola volta.'
          );
          return;
        }

        ocrPreparedUri = preparedCardUri;
        captureScope.track(ocrPreparedUri);
        console.warn('[BusinessCardBoundary] prepared_card_image_selected', {
          mode: overlayFallbackUsed ? 'verified_overlay_fallback' : boundaryRefinement.mode,
          confidence: boundaryRefinement.detection?.confidence ?? null,
          areaRatio: boundaryRefinement.detection?.areaRatio ?? null,
          recovery: boundaryRecoveryUsed,
        });

        const boundaryOutputUri = ocrPreparedUri;

        // Nessuna forzatura di forma: il ritaglio coincide con la cornice, che
        // ha già l'orientamento scelto dall'utente. L'unico raddrizzamento
        // ammesso è quello dedotto dal contenuto, subito sotto.
        ocrPreparedUri = await autoOrientBusinessCardImage(
          ocrPreparedUri,
          cardOrientation,
          {
            operationId: operation.operationId,
            isActive: isCaptureActive,
          }
        );
        captureScope.track(ocrPreparedUri);
        if (!isCaptureActive()) return;

        if (CARD_GEOMETRY_QA_DIAGNOSTICS) {
          const ocrSize = await getImageSize(ocrPreparedUri);
          if (!isCaptureActive()) return;
          logCardGeometry({
            stage: 'ocr_input',
            photoWidth: ocrSize.width,
            photoHeight: ocrSize.height,
            cropApplied: useOverlayCrop,
            cropDecision: cropSafety.cropDecision,
            alignRotation: plan.alignRotation,
            cardOrientation,
          });

          // Salva gli stadi DOPO l'auto-orientamento: il file 04 e la base
          // realmente consegnata a scanBusinessCardBest. Il modulo OCR salva
          // poi anche ogni tentativo ruotato effettivamente passato a ML Kit.
          if (plan.debug.cropRect) {
            await saveCardCaptureArtifacts({
              rawUri: fullFrameUri,
              overlayCropUri: useOverlayCrop ? overlayCropUri : undefined,
              boundaryUri: boundaryOutputUri,
              ocrInputUri: ocrPreparedUri,
              boundaryMode: overlayFallbackUsed ? 'verified_overlay_fallback' : boundaryRefinement.mode,
              boundaryConfidence: boundaryRefinement.detection?.confidence ?? null,
              boundaryAreaRatio: boundaryRefinement.detection?.areaRatio ?? null,
              boundaryRecoveryUsed,
              preparedSharpnessScore: preparedSharpness.score,
              preparedSharpnessMedian: preparedSharpness.medianZoneScore,
              preparedSharpnessMax: preparedSharpness.maxZoneScore,
              photoWidth: plan.debug.normalizedWidth,
              photoHeight: plan.debug.normalizedHeight,
              cropX: plan.debug.cropRect.x,
              cropY: plan.debug.cropRect.y,
              cropWidth: plan.debug.cropRect.width,
              cropHeight: plan.debug.cropRect.height,
            });
            if (!isCaptureActive()) return;
          }
        }

        // UI e salvataggio mostrano il ritaglio; l'originale rimane separato
        // per il ri-OCR. Entrambi escono dalla cache di CameraView subito.
        const imageUris = imagePipelineUris(photo.uri, ocrPreparedUri);
        const [draftPreviewUri, draftOriginalUri] = await Promise.all([
          copyImageToDraftStorage(imageUris.persistenceSourceUri),
          copyImageToDraftStorage(imageUris.originalUri),
        ]);
        captureScope.track(draftPreviewUri);
        captureScope.track(draftOriginalUri);
        trackSessionAsset(draftPreviewUri);
        trackSessionAsset(draftOriginalUri);
        if (!operation.tryFinalize()) return;
        captureScope.retain(draftPreviewUri);
        captureScope.retain(draftOriginalUri);
        setBusinessScans((prev) => [
          ...prev,
          {
            uri: draftPreviewUri,
            ocrUri: draftPreviewUri,
            originalUri: draftOriginalUri,
            kind: 'card',
          },
        ]);
        void pulseAutofocus();
        return;
      }
    } catch (error) {
      if (
        !mountedRef.current ||
        !screenActiveRef.current ||
        !operation.isCurrent()
      ) {
        return;
      }
      runtimeLogger.error(
        jpegCaptured ? 'CAPTURE_PROCESSING_OR_PERSISTENCE_FAILED' : 'CAPTURE_FAILED',
        error,
        {
          source: 'camera',
          stage: jpegCaptured ? 'persist' : 'capture',
          status: 'failed',
        }
      );
      Alert.alert(
        t('error'),
        jpegCaptured ? t('captureProcessingFailed') : t('captureFailed')
      );
    } finally {
      // Anche se lo scatto fallisce o scade, il fuoco non può restare bloccato.
      releaseFocusAfterCapture();
      finalizeAfterSettlement(pendingNativeCapture, () => {
        const wasCurrent = captureOperationsRef.current.isCurrent(operation);
        if (wasCurrent) {
          captureOperationsRef.current.finish(operation);
        }
        captureInProgress.current = false;
        void captureScope.close();
        flushDeferredSessionAssets();
        if (
          wasCurrent &&
          mountedRef.current &&
          screenActiveRef.current
        ) {
          resetAutofocus();
          setScanning(false);
          setCaptureHint(null);
        }
      });
    }
  }, [
    businessMode,
    cameraReady,
    cameraCaptureReady,
    captureMode,
    cardOrientation,
    documentType,
    documentViewportModeMaterialized,
    getCameraResolutionDiag,
    logFocusTimeline,
    overlayFrameCenter.nx,
    overlayFrameCenter.ny,
    prepareForCapture,
    holdFocusForCapture,
    releaseFocusAfterCapture,
    pulseAutofocus,
    resetAutofocus,
    screenH,
    screenW,
    t,
    trackSessionAsset,
    flushDeferredSessionAssets,
  ]);

  const takePicture = useCallback(() => {
    console.warn('[CameraCapture] shutter_press', {
      documentType,
      documentCategory: documentCategory ?? null,
      acquisitionSessionKey: acquisitionSessionKey ?? 'legacy',
      cameraReady,
      cameraCaptureReady,
      scanning,
    });
    void capturePhoto();
  }, [
    acquisitionSessionKey,
    cameraReady,
    cameraCaptureReady,
    capturePhoto,
    documentCategory,
    documentType,
    scanning,
  ]);

  const retakePendingDocument = useCallback(() => {
    const pending = pendingDocumentPhoto;
    if (!pending) return;
    setPendingDocumentPhoto(null);
    void cleanupScanSessionImageUri(pending.page.uri);
    if (pending.page.originalUri !== pending.page.uri) {
      void cleanupScanSessionImageUri(pending.page.originalUri);
    }
  }, [pendingDocumentPhoto]);

  const rotatePendingDocument180 = useCallback(async () => {
    const pending = pendingDocumentPhoto;
    if (!pending) return;
    try {
      const rotatedUri = await rotateImage(pending.page.uri, 180);
      trackSessionAsset(rotatedUri);
      let nextOcrUri = pending.page.ocrUri;
      if (nextOcrUri === pending.page.uri) {
        nextOcrUri = rotatedUri;
      } else {
        nextOcrUri = await rotateImage(nextOcrUri, 180);
        trackSessionAsset(nextOcrUri);
      }
      const applied = ((pending.page.metadata.rotationApplied + 180) % 360) as
        | 0
        | 90
        | 180
        | 270;
      const requested = ((pending.page.metadata.rotationRequested + 180) % 360) as
        | 0
        | 90
        | 180
        | 270;
      setPendingDocumentPhoto({
        page: {
          uri: rotatedUri,
          ocrUri: nextOcrUri,
          originalUri: pending.page.originalUri,
          metadata: {
            ...pending.page.metadata,
            rotationApplied: applied,
            rotationRequested: requested,
            normalizationReason: 'landscape_reading_order_correction',
            canonicalUri: rotatedUri,
            persistedWidth: pending.page.metadata.width,
            persistedHeight: pending.page.metadata.height,
            ocrWidth: pending.page.metadata.ocrWidth,
            ocrHeight: pending.page.metadata.ocrHeight,
          },
        },
      });
    } catch (error) {
      runtimeLogger.error('PENDING_DOCUMENT_ROTATE_180_FAILED', error, {
        source: 'camera',
        stage: 'preview',
        status: 'failed',
      });
      Alert.alert(t('error'), t('captureFailed'));
    }
  }, [pendingDocumentPhoto, t, trackSessionAsset]);

  const confirmPendingDocument = useCallback(() => {
    const pending = pendingDocumentPhoto;
    if (!pending) return;
    setDocumentPages((previous) => [...previous, pending.page]);
    setPendingDocumentPhoto(null);
    void pulseAutofocus();
  }, [pendingDocumentPhoto, pulseAutofocus]);

  const processDocument = async () => {
    if (
      !screenActiveRef.current ||
      captureInProgress.current ||
      processingGateRef.current.isLocked()
    ) return;
    invalidateCaptureOperation('manual');
    const cardSlots = businessScans.filter((slot) => slot.kind === 'card');
    const cardImageUris =
      documentType === 'business_card'
        ? cardSlots.map((slot) => slot.uri)
        : images;
    const cardOcrImageUris =
      documentType === 'business_card'
        ? cardSlots.map((slot) => slot.ocrUri ?? slot.uri)
        : undefined;
    const cardOriginalImageUris =
      documentType === 'business_card'
        ? cardSlots.map((slot) => slot.originalUri ?? slot.uri)
        : undefined;
    const personImageUris =
      documentType === 'business_card'
        ? businessScans.filter((s) => s.kind === 'person').map((s) => s.uri)
        : [];

    if (cardImageUris.length === 0 && personImageUris.length === 0) {
      Alert.alert(t('error'), t('scanAtLeastOne'));
      return;
    }

    if (documentType === 'business_card' && cardImageUris.length === 0) {
      Alert.alert(t('photoKindNoCardTitle'), t('photoKindNoCardMessage'));
    }

    const exclusiveLease = processingGateRef.current.tryAcquire();
    if (!exclusiveLease) return;
    const operation = processOperationsRef.current.begin();
    pendingProcessSettlementsRef.current.add(exclusiveLease.operationId);
    const isProcessActiveBeforeClaim = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    const isClaimCurrent = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isCurrent();
    setScanning(true);
    setIsProcessingDoc(true);
    setProcessProgress({
      stage: 'prepare',
      percent: 0,
      messageKey: 'processing.prepare',
    });
    let navigated = false;
    let currentProcessStage: 'ocr' | 'parse' | 'persist' = 'ocr';
    try {
      let documentScanIndex = 0;
      if (documentType !== 'business_card') {
        documentPages.forEach((page, pageIndex) => {
          if (__DEV__) {
            console.warn(`[ProcessingOrientation] ${JSON.stringify({
              pageIndex,
              frozenPixelRotation: page.metadata.rotationApplied,
              currentDeviceRotation: captureMode,
              currentScreenOrientation: displayedCaptureMode,
              currentOrientationIgnored: true,
            })}`);
          }
        });
      }
      const qrPayloads =
        documentType === 'business_card'
          ? await scanBusinessCardQrPayloads(cardImageUris)
          : [];
      const outcome = await processCapturedScan({
        documentType,
        documentCategory,
        imageUris: cardImageUris,
        ...(documentType === 'business_card' ? { qrPayloads } : {}),
        ...(documentType === 'business_card'
          ? {
              ocrImageUris: cardOcrImageUris,
              originalImageUris: cardOriginalImageUris,
            }
          : {
              ocrImageUris: documentPages.map((page) => page.ocrUri),
              originalImageUris: documentPages.map((page) => page.originalUri),
              pageCaptureMetadata: documentPages.map((page) => page.metadata),
            }),
        personImageUris,
        operation: {
          operationId: operation.operationId,
          isActiveBeforeClaim: isProcessActiveBeforeClaim,
          isClaimCurrent,
          tryFinalize: () => operation.tryFinalize(),
        },
        ports: {
          ensureReady: ensureDatabaseReady,
          scanPage: (imageUri) => {
            currentProcessStage = 'ocr';
            if (documentType === 'business_card') {
              // Questo e' il confine che viene realmente attraversato dal
              // flusso camera -> ML Kit. Il watchdog qui impedisce che una
              // singola rotazione/script nativo renda vana la deadline del
              // workflow superiore. Il risultato tardivo non puo' essere
              // pubblicato o trasformato in un contatto incompleto.
              const perPageBudgetMs = cardImageUris.length <= 1 ? 9_000 : 7_000;
              return runTimedOperation({
                operationId: `${operation.operationId}-business-card-${imageUri}`,
                timeoutMs: perPageBudgetMs,
                fallback: { lines: [], text: '', quality: { heuristicQuality: 0, confidenceType: 'heuristic' as const, qualityReasons: [], requiresReview: true } },
                isExternallyActive: () => operation.isActive(),
                task: () => scanBusinessCardBest(imageUri, operation),
              }).then((outcome) => {
                if (outcome.status === 'timed_out') {
                  console.warn('[BusinessCardOCR] page_timeout', {
                    budgetMs: perPageBudgetMs,
                    pageCount: cardImageUris.length,
                  });
                }
                if (outcome.status === 'failed') throw outcome.error;
                return outcome.value;
              });
            }
            const page = documentPages[documentScanIndex++];
            const width = page?.metadata.canonicalWidth ?? page?.metadata.width;
            const height = page?.metadata.canonicalHeight ?? page?.metadata.height;
            const canonicalOrientationApplied =
              page?.metadata.normalizationReason !== 'normalization_failed_original_preserved'
              && (page?.metadata.rotationApplied ?? 0) >= 0;
            return scanDocumentBest(
              imageUri,
              operation,
              width > 0 && height > 0 ? { width, height } : undefined,
              canonicalOrientationApplied ? [0] : undefined,
            );
          },
          publishBusinessCard: (
            document,
            retainedCardUris,
            retainedPersonUris
          ) => {
            currentProcessStage = 'persist';
            // Il draft conserva URI temporanei. La copia permanente avviene
            // soltanto quando l'utente preme Salva nello store contatti.
            const sessionScope = sessionAssetScopeRef.current;
            if (!sessionScope || !isClaimCurrent()) return false;
            // Il contatto conserva sia preview sia originalImages. Entrambe
            // devono sopravvivere fino al Salva: trattenere solo la preview
            // rendeva l'originale irreperibile nello staging del contatto.
            const retainedBusinessCardUris = new Set([
              ...retainedCardUris,
              ...(document.originalImages ?? []),
            ]);
            for (const uri of retainedBusinessCardUris) sessionScope.retain(uri);
            for (const uri of retainedPersonUris) sessionScope.retain(uri);
            setDraftContact(document);
            return true;
          },
          persistDocument: async (document, guard) => {
            currentProcessStage = 'persist';
            await addDocument(document, guard);
          },
          notifyWarning: (warning, type) => {
            if (warning === 'ocr_empty') {
              Alert.alert(
                'Foto salvata',
                type === 'business_card'
                  ? 'OCR non ha letto testo sul biglietto. Verifica luce e inquadratura, poi riprova.\n\nPuoi compilare i campi manualmente.'
                  : 'L’OCR locale non ha letto testo. Le immagini sono state salvate: puoi controllare e compilare i campi manualmente.'
              );
              return;
            }
            Alert.alert(
              'Poco testo letto',
              'L’OCR locale ha letto poco testo. Controlla i campi manualmente.\n\nConsigli: luce uniforme, stampa su carta, inquadra tutto il foglio.'
            );
          },
          navigate: (targetId, options) => {
            setScanning(false);
            setIsProcessingDoc(false);
            setProcessProgress(null);
            authorizeCommittedNavigation?.();
            const partial = options?.processResult === 'partial_success' ? '?partial=1' : '';
            router.replace(`/document/${targetId}${partial}`);
          },
          onProgress: (progress) => {
            if (progress.stage === 'ocr') currentProcessStage = 'ocr';
            else if (progress.stage === 'persist' || progress.stage === 'done') currentProcessStage = 'persist';
            else currentProcessStage = 'parse';
            if (!mountedRef.current || !operation.isCurrent()) return;
            setProcessProgress((previous) => {
              if (!previous) return progress;
              return {
                ...progress,
                percent: Math.max(previous.percent, progress.percent),
              };
            });
          },
        },
      });
      if (outcome.status === 'ocr_insufficient') {
        Alert.alert(
          t('processing.badImage'),
          undefined,
          [{ text: t('processing.rescan'), style: 'default' }],
        );
        return;
      }
      navigated = outcome.status === 'completed';
    } catch (error) {
      if (error instanceof DuplicateContactCancelledError) return;
      if (error instanceof DocumentDuplicateCancelledError) return;
      if (error instanceof DocumentDuplicateOpenExistingError) {
        router.replace(`/document/${error.existingId}`);
        navigated = true;
        return;
      }
      if (isInactiveScanOperationError(error)) return;
      if (
        !mountedRef.current ||
        !screenActiveRef.current ||
        !operation.isCurrent()
      ) {
        return;
      }
      runtimeLogger.error('SCAN_PROCESS_FAILED', error, {
        stage: currentProcessStage,
        status: 'failed',
      });
      const detail = error instanceof Error ? error.message : String(error);
      Alert.alert(
        'Errore',
        detail.trim()
          ? detail.slice(0, 400)
          : 'Impossibile salvare il documento. Riprova o contatta il supporto se persiste.'
      );
    } finally {
      const wasCurrent = processOperationsRef.current.isCurrent(operation);
      if (wasCurrent) {
        processOperationsRef.current.finish(operation);
      }
      if (!navigated) exclusiveLease.release();
      pendingProcessSettlementsRef.current.delete(exclusiveLease.operationId);
      flushDeferredSessionAssets();
      if (
        wasCurrent &&
        !navigated &&
        mountedRef.current &&
        screenActiveRef.current
      ) {
        setScanning(false);
        setIsProcessingDoc(false);
        setProcessProgress(null);
      }
    }
  };

  const removeImage = (index: number) => {
    if (documentType === 'business_card') {
      const removed = businessScans[index]?.uri;
      const removedOriginal = businessScans[index]?.originalUri;
      setBusinessScans((prev) => prev.filter((_, i) => i !== index));
      if (removed) void cleanupScanSessionImageUri(removed);
      if (removedOriginal && removedOriginal !== removed) {
        void cleanupScanSessionImageUri(removedOriginal);
      }
      return;
    }
    const removed = documentPages[index]?.uri;
    const removedOcr = documentPages[index]?.ocrUri;
    const removedOriginal = documentPages[index]?.originalUri;
    setDocumentPages((prev) => prev.filter((_, i) => i !== index));
    if (removed) void cleanupScanSessionImageUri(removed);
    if (removedOcr && removedOcr !== removed) void cleanupScanSessionImageUri(removedOcr);
    if (removedOriginal && removedOriginal !== removed && removedOriginal !== removedOcr) {
      void cleanupScanSessionImageUri(removedOriginal);
    }
  };

  const previewItems =
    documentType === 'business_card'
      ? businessScans.map((slot) => ({ uri: slot.uri, badge: slot.kind === 'person' ? '👤' : '📇' }))
      : documentPages.map((page) => ({ uri: page.uri, badge: null as string | null }));

  const previewCount = previewItems.length;

  const landscapeHeaderRail = isDocumentLandscape ? (
    <View
      style={[
        styles.landscapeHeaderRail,
        {
          paddingTop: Math.max(insets.top, 4) + 4,
          paddingBottom: Math.max(insets.bottom, 4) + 4,
          paddingLeft: Math.max(insets.left, 4) + 4,
        },
      ]}
    >
      <TouchableOpacity
        onPress={onRequestExit}
        disabled={!onRequestExit}
        hitSlop={8}
        activeOpacity={0.6}
        style={styles.landscapeHeaderBack}
        accessibilityRole="button"
        accessibilityLabel={t('scanBackLabel')}
        accessibilityHint={t('scanBackHint')}
      >
        <Ionicons name="chevron-back" size={24} color={colors.primary} />
      </TouchableOpacity>

      <View style={styles.landscapeModeGroup} accessibilityRole="radiogroup">
        {(['portrait', 'landscape-left'] as const).map((mode) => (
          <TouchableOpacity
            key={mode}
            onPress={() => selectDocumentCaptureMode(mode)}
            disabled={modeControlsDisabled}
            style={[
              styles.landscapeModeButton,
              modeControlsDisabled && styles.headerBtnDisabled,
              displayedCaptureMode === mode && styles.headerDocumentModeButtonActive,
            ]}
            accessibilityRole="radio"
            accessibilityState={{
              checked: displayedCaptureMode === mode,
              disabled: modeControlsDisabled,
            }}
            accessibilityLabel={t(
              mode === 'portrait'
                ? 'documentCapturePortrait'
                : 'documentCaptureLandscape',
            )}
            accessibilityHint={t(
              mode === 'portrait'
                ? 'documentCapturePortraitHint'
                : 'documentCaptureLandscapeHint',
            )}
          >
            <DocumentModeGlyph
              mode={mode}
              selected={displayedCaptureMode === mode}
            />
          </TouchableOpacity>
        ))}
      </View>

      {previewCount > 0 ? (
        <FlatList
          data={previewItems}
          style={styles.landscapePreviewList}
          contentContainerStyle={styles.landscapePreviewContent}
          renderItem={({ item, index }) => (
            <View style={styles.landscapePreviewItem}>
              <Image source={{ uri: item.uri }} style={styles.landscapePreviewImage} resizeMode="contain" />
              <TouchableOpacity
                style={styles.landscapePreviewRemove}
                onPress={() => removeImage(index)}
                accessibilityRole="button"
                accessibilityLabel={`${t('delete')} ${index + 1}`}
              >
                <Ionicons name="close-circle" size={22} color={colors.danger} />
              </TouchableOpacity>
            </View>
          )}
          keyExtractor={(_, index) => index.toString()}
        />
      ) : null}
    </View>
  ) : null;

  useEffect(() => {
    setTorchEnabled(false);
  }, [cameraSession]);

  useEffect(() => {
    if (documentType !== 'business_card' || !cameraReady) return;
    if (overlayFrame.width <= 0 || overlayFrame.height <= 0) return;
    logCardGeometry({
      stage: 'preview',
      viewportWidth: viewportWidth,
      viewportHeight: viewportHeight,
      overlayX: overlayFrame.x,
      overlayY: overlayFrame.y,
      overlayWidth: overlayFrame.width,
      overlayHeight: overlayFrame.height,
      previewStreamSize: getCameraResolutionDiag()?.previewStreamSize ?? null,
      imageCaptureSize: getCameraResolutionDiag()?.imageCaptureSize ?? null,
      cameraZoom,
      cardOrientation,
    });
  }, [
    cameraReady,
    cameraZoom,
    cardOrientation,
    documentType,
    getCameraResolutionDiag,
    overlayFrame,
    viewportHeight,
    viewportWidth,
  ]);

  // L'importazione PDF non passa dalla camera: il consenso deve poter comparire
  // anche quando la schermata mostra il permesso mancante o la conferma foto.
  const pdfConsentModal = (
    <GeminiConfirmationModal
      visible={showPdfAiModal}
      onCancel={() => setShowPdfAiModal(false)}
      onConfirm={confirmPdfImport}
      contentKind="pdf"
      showCredits={false}
    />
  );

  if (!permission) return <View />;
  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer}>
        <Text style={styles.permissionText}>{t('cameraPermissionRequired')}</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={requestPermission}
          accessibilityRole="button"
          accessibilityLabel={t('cameraGrantPermissionAccessibility')}
        >
          <Text style={styles.buttonText}>{t('cameraGrantPermission')}</Text>
        </TouchableOpacity>
        {pdfConsentModal}
      </View>
    );
  }

  if (pendingDocumentPhoto) {
    return (
      <View style={[styles.container, isDocumentLandscape && styles.containerLandscape]}>
        {landscapeHeaderRail}
        <View style={[
          styles.confirmationContainer,
          isDocumentLandscape && styles.confirmationContainerLandscape,
        ]}>
          <Image
            source={{ uri: pendingDocumentPhoto.page.uri }}
            style={[
              styles.confirmationImage,
              isDocumentLandscape && styles.confirmationImageLandscape,
            ]}
            resizeMode="contain"
            accessibilityLabel={t('confirmPhotoHint')}
          />
          <View
            style={[
              styles.confirmationActions,
              isDocumentLandscape && styles.confirmationActionsLandscape,
              {
                ...(isDocumentLandscape
                  ? {
                      width: 96 + Math.max(insets.right, 0),
                      paddingRight: Math.max(insets.right, 4),
                    }
                  : {}),
                paddingBottom:
                  (isDocumentLandscape
                    ? Math.max(insets.bottom, 4)
                    : Math.max(
                        insets.bottom,
                        Platform.OS === 'android' ? 48 : spacing.md,
                      )) + spacing.sm,
              },
            ]}
          >
            <TouchableOpacity
              style={[
                styles.confirmationSecondaryButton,
                isDocumentLandscape && styles.confirmationActionButtonLandscape,
                isDocumentLandscape && styles.confirmationSecondaryButtonLandscape,
              ]}
              onPress={() => {
                void rotatePendingDocument180();
              }}
              disabled={false}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel={t('rotateDocument180')}
              accessibilityState={{ disabled: false }}
            >
              <Text style={[
                styles.confirmationSecondaryText,
                isDocumentLandscape && styles.confirmationSecondaryTextLandscape,
                isDocumentLandscape && styles.confirmationActionTextLandscape,
              ]}>
                {t('rotateDocument180')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.confirmationSecondaryButton,
                isDocumentLandscape && styles.confirmationActionButtonLandscape,
                isDocumentLandscape && styles.confirmationSecondaryButtonLandscape,
              ]}
              onPress={retakePendingDocument}
              disabled={false}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel={t('retakePhoto')}
              accessibilityState={{ disabled: false }}
            >
              <Text style={[
                styles.confirmationSecondaryText,
                isDocumentLandscape && styles.confirmationSecondaryTextLandscape,
                isDocumentLandscape && styles.confirmationActionTextLandscape,
              ]}>
                {t('retakePhoto')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.confirmationPrimaryButton,
                isDocumentLandscape && styles.confirmationActionButtonLandscape,
              ]}
              onPress={confirmPendingDocument}
              disabled={false}
              activeOpacity={0.72}
              accessibilityRole="button"
              accessibilityLabel={t('usePhoto')}
              accessibilityState={{ disabled: false }}
            >
              <Text style={[
                styles.confirmationPrimaryText,
                isDocumentLandscape && styles.confirmationActionTextLandscape,
              ]}>
                {t('usePhoto')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
        {pdfConsentModal}
      </View>
    );
  }

  const controlsBottom = insets.bottom + 12;

  return (
    <View style={[styles.container, isDocumentLandscape && styles.containerLandscape]}>
      {landscapeHeaderRail}
      <View
        style={[
          styles.cameraStage,
          documentType !== 'business_card' &&
            !isDocumentLandscape &&
            styles.cameraStageDocumentPortrait,
        ]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setViewportSize({ width, height });
        }}
      >
        {cameraActive ? (
          <CameraView
            key={`camera-${cameraSession}-${captureProfile.id}`}
            ref={cameraRef}
            style={styles.camera}
            facing={captureProfile.facing}
            mode="picture"
            enableTorch={torchEnabled}
            {...(Platform.OS === 'ios'
              ? {
                  responsiveOrientationWhenOrientationLocked:
                    captureProfile.responsiveOrientationWhenOrientationLocked,
                }
              : {})}
            {...cameraViewFocusProps}
            autofocus={autofocus}
            onCameraReady={handleCameraReady}
            onMountError={({ message }) => onMountError(message)}
            {...patchedAutofocusEventProp(handleAutofocusStateChanged)}
            zoom={showCardOverlay && cameraReady ? cameraZoom : 0}
          />
        ) : (
          // Quando la schermata perde il focus (o si sta rimontando la
          // fotocamera) NON teniamo montata la CameraView con la sola prop
          // `active={false}`: su Android quella non rilascia davvero l'hardware
          // e al ritorno l'anteprima resta NERA. Smontandola del tutto la
          // sessione nativa viene chiusa e riaperta pulita al rientro.
          <View style={styles.camera} />
        )}
        <View style={styles.overlayLayer} pointerEvents="none">
          {viewportWidth > 0 && viewportHeight > 0
            && (showCardOverlay || (documentType !== 'business_card' && documentViewportModeMaterialized && documentOverlayReady)) ? (
            <Overlay
              documentType={documentType}
              cardOrientation={cardOrientation}
              viewportWidth={viewportWidth}
              viewportHeight={viewportHeight}
              viewportInsets={viewportInsets}
            />
          ) : null}
        </View>

        {showCardOverlay && cameraReady && overlayFrame.width > 0 && overlayFrame.height > 0 ? (
          <FocusReticle
            frame={overlayFrame}
            pulseKey={focusPulseKey}
            afState={afState}
          />
        ) : null}

        {cameraReady && !isDocumentLandscape ? (
          <TouchableOpacity
            style={[
              styles.torchButton,
              {
                top: insets.top + 8,
                right: Math.max(insets.right, 8) + 8,
              },
            ]}
            onPress={() => setTorchEnabled((on) => !on)}
            accessibilityRole="button"
            accessibilityLabel={torchEnabled ? t('torchOff') : t('torchOn')}
          >
            <Text style={styles.torchButtonText}>{torchEnabled ? '🔦' : '💡'}</Text>
          </TouchableOpacity>
        ) : null}

        {documentType !== 'business_card' && cameraReady && !isDocumentLandscape ? (
          <TouchableOpacity
            style={[
              styles.resetFramingButton,
              {
                top: insets.top + 60,
                right: Math.max(insets.right, 8) + 8,
              },
            ]}
            onPress={resetFraming}
            accessibilityRole="button"
            accessibilityLabel={t('resetCameraFraming')}
            accessibilityHint={t('resetCameraFramingHint')}
          >
            <Text style={styles.resetFramingText}>1×</Text>
          </TouchableOpacity>
        ) : null}

        {cameraStuck ? (
          <View style={styles.focusHintBanner} accessibilityLiveRegion="assertive">
            <Text style={styles.focusHintText} accessibilityRole="alert">{t('cameraStuckHint')}</Text>
            <TouchableOpacity
              style={styles.remountBtn}
              onPress={handleRemountCamera}
              accessibilityRole="button"
              accessibilityLabel={t('cameraRemount')}
            >
              <Text style={styles.remountBtnText}>{t('cameraRemount')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {cameraMountError ? (
          <View style={styles.focusHintBanner} accessibilityLiveRegion="assertive">
            <Text style={styles.focusHintText} accessibilityRole="alert">Camera: {cameraMountError}</Text>
            <TouchableOpacity
              style={styles.remountBtn}
              onPress={handleRemountCamera}
              accessibilityRole="button"
              accessibilityLabel={t('cameraRemount')}
            >
              <Text style={styles.remountBtnText}>{t('cameraRemount')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {captureHint || lowLightNotice ? (
          <View style={styles.focusHintBanner}>
            <Text style={styles.focusHintText}>{captureHint ?? lowLightNotice}</Text>
          </View>
        ) : null}

        {previewCount > 0 && !isDocumentLandscape && (
          <View
            style={[
              styles.previewContainer,
              documentType !== 'business_card' && styles.previewContainerDocument,
              isDocumentLandscape && styles.previewContainerLandscape,
              isDocumentLandscape
                ? {
                    top: Math.max(insets.top, 4) + 68,
                    bottom: Math.max(insets.bottom, 4) + 4,
                    left: Math.max(insets.left, 4) + 4,
                  }
                : null,
            ]}
          >
            <FlatList
              horizontal={!isDocumentLandscape}
              data={previewItems}
              renderItem={({ item, index }) => (
                <View style={styles.previewItem}>
                  <Image
                    source={{ uri: item.uri }}
                    style={styles.previewImage}
                    resizeMode="contain"
                  />
                  {item.badge ? (
                    <View style={styles.previewBadge}>
                      <Text style={styles.previewBadgeText}>{item.badge}</Text>
                    </View>
                  ) : null}
                  <TouchableOpacity
                    style={styles.removeButton}
                    onPress={() => removeImage(index)}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('delete')} ${index + 1}`}
                  >
                    <View style={styles.removeButtonVisual}>
                      <Text style={styles.removeButtonText}>×</Text>
                    </View>
                  </TouchableOpacity>
                </View>
              )}
              keyExtractor={(_, index) => index.toString()}
            />
          </View>
        )}
      </View>

      {isProcessingDoc ? (
        <View style={styles.processingOverlay}>
          <View
            style={styles.processingCard}
            accessibilityRole="progressbar"
            accessibilityLiveRegion="polite"
            accessibilityLabel={`${t(processingTitleKey(isBusinessCardMode))} ${processProgress?.percent ?? 0}%`}
          >
            <Text style={styles.processingTitle}>
              {t(processingTitleKey(isBusinessCardMode))}
            </Text>
            <View style={styles.processingBarTrack}>
              <View
                style={[
                  styles.processingBarFill,
                  { width: `${Math.min(100, processProgress?.percent ?? 0)}%` },
                ]}
              />
            </View>
            <Text style={styles.processingPercent}>
              {Math.round(processProgress?.percent ?? 0)}%
            </Text>
            <Text style={styles.processingText}>
              {t(
                processingMessageKey(
                  isBusinessCardMode,
                  processProgress?.messageKey ?? 'processing.prepare',
                ),
                processProgress?.messageParams,
              )}
            </Text>
          </View>
        </View>
      ) : null}

      <View
        style={[
          styles.controlsDock,
          isDocumentLandscape && styles.controlsDockLandscape,
          isDocumentLandscape
            ? {
                width: 96 + Math.max(insets.right, 0),
                paddingTop: Math.max(insets.top, 4) + 4,
                paddingRight: Math.max(insets.right, 4) + 4,
                paddingBottom: Math.max(insets.bottom, 4) + 4,
              }
            : { paddingBottom: controlsBottom },
        ]}
      >
        {isDocumentLandscape && cameraReady ? (
          <>
            <TouchableOpacity
              style={styles.landscapeUtilityButton}
              onPress={() => setTorchEnabled((on) => !on)}
              accessibilityRole="button"
              accessibilityLabel={torchEnabled ? t('torchOff') : t('torchOn')}
            >
              <Ionicons
                name={torchEnabled ? 'flash' : 'flash-outline'}
                size={22}
                color={colors.textPrimary}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.landscapeUtilityButton}
              onPress={resetFraming}
              accessibilityRole="button"
              accessibilityLabel={t('resetCameraFraming')}
              accessibilityHint={t('resetCameraFramingHint')}
            >
              <Text style={styles.landscapeUtilityText}>{'1\u00d7'}</Text>
            </TouchableOpacity>
          </>
        ) : null}
        {documentType === 'business_card' ? (
          <View style={styles.modeRow}>
            <TouchableOpacity
              style={[
                styles.modeButton,
                businessMode === 'person' && styles.modeButtonActive,
              ]}
              onPress={() => selectBusinessMode('person')}
              disabled={scanning}
              accessibilityRole="button"
              accessibilityLabel={t('scanModeImage')}
              accessibilityState={{ disabled: scanning, selected: businessMode === 'person' }}
            >
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
                style={[
                  styles.modeButtonText,
                  businessMode === 'person' && styles.modeButtonTextActive,
                ]}
              >
                {t('scanModeImage')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeButton, businessMode === 'card' && styles.modeButtonActive]}
              onPress={() => selectBusinessMode('card')}
              disabled={scanning}
              accessibilityRole="button"
              accessibilityLabel={t('scanModeCard')}
              accessibilityState={{ disabled: scanning, selected: businessMode === 'card' }}
            >
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
                style={[
                  styles.modeButtonText,
                  businessMode === 'card' && styles.modeButtonTextActive,
                ]}
              >
                {t('scanModeCard')}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {previewCount > 0 && (
          <TouchableOpacity
            style={[
              styles.button,
              styles.processButton,
              isDocumentLandscape && styles.landscapeActionButton,
              scanning && styles.buttonDisabled,
            ]}
            onPress={processDocument}
            disabled={scanning}
            accessibilityRole="button"
            accessibilityLabel={t('processCount', { count: previewCount })}
            accessibilityState={{ disabled: scanning, busy: scanning }}
          >
            <Text style={[
              styles.buttonText,
              isDocumentLandscape && styles.landscapeActionText,
              scanning && styles.disabledText,
            ]}>
              {t('processCount', { count: previewCount })}
            </Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[
            styles.button,
            documentType !== 'business_card' &&
              (isDocumentLandscape
                ? styles.landscapeActionButton
                : styles.documentShutterButton),
            (scanning || !cameraCaptureReady) && styles.buttonDisabled,
          ]}
          onPress={takePicture}
          disabled={scanning || !cameraCaptureReady}
          accessibilityRole="button"
          accessibilityLabel={cameraCaptureReady ? t('captureShot') : t('cameraStartingShort')}
          accessibilityState={{ disabled: scanning || !cameraCaptureReady, busy: scanning }}
        >
          {scanning ? (
            <ActivityIndicator color={colors.textDisabled} />
          ) : cameraCaptureReady ? (
            <Ionicons name="camera-outline" size={28} color={colors.textOnPrimary} />
          ) : (
            <Text style={[
              styles.buttonText,
              isDocumentLandscape && styles.landscapeActionText,
              (scanning || !cameraCaptureReady) && styles.disabledText,
            ]}>
              {cameraCaptureReady ? t('captureShot') : t('cameraStartingShort')}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      {pdfConsentModal}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.cameraSurface },
  containerLandscape: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
  },
  landscapeHeaderRail: {
    width: 80,
    marginRight: 16,
    paddingHorizontal: 4,
    backgroundColor: colors.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
    alignItems: 'stretch',
    zIndex: 18,
    elevation: 18,
  },
  landscapeHeaderBack: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  landscapeModeGroup: {
    marginTop: 8,
    gap: 8,
  },
  landscapeModeButton: {
    width: 52,
    height: 52,
    alignSelf: 'center',
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  documentModeGlyph: {
    borderWidth: 2,
    borderColor: colors.textPrimary,
    borderRadius: 2,
  },
  documentModeGlyphPortrait: {
    width: 18,
    height: 26,
  },
  documentModeGlyphLandscape: {
    width: 26,
    height: 18,
  },
  documentModeGlyphSelected: {
    borderColor: colors.textOnPrimary,
  },
  landscapePreviewList: {
    flex: 1,
    marginTop: 8,
  },
  landscapePreviewContent: {
    alignItems: 'center',
    paddingBottom: 6,
    gap: 6,
  },
  landscapePreviewItem: {
    width: 56,
    height: 44,
    borderRadius: 4,
    overflow: 'hidden',
    backgroundColor: colors.cameraSurface,
  },
  landscapePreviewImage: {
    width: '100%',
    height: '100%',
  },
  landscapePreviewRemove: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 44,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
  },
  confirmationContainer: { flex: 1, backgroundColor: colors.cameraSurface },
  confirmationContainerLandscape: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
  },
  confirmationImage: { flex: 1, width: '100%', backgroundColor: colors.cameraSurface },
  confirmationImageLandscape: { width: undefined },
  confirmationActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  confirmationActionsLandscape: {
    flexDirection: 'column',
    width: 96,
    paddingTop: 8,
    paddingHorizontal: 6,
    gap: 8,
    backgroundColor: colors.surface,
    marginLeft: 16,
  },
  confirmationSecondaryButton: {
    flex: 1,
    minHeight: 46,
    maxWidth: 180,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmationSecondaryText: { ...typography.body, color: colors.textPrimary, fontWeight: '700' },
  confirmationPrimaryButton: {
    flex: 1,
    minHeight: 46,
    maxWidth: 180,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.xl,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmationPrimaryText: { ...typography.body, color: colors.textOnPrimary, fontWeight: '700' },
  confirmationActionButtonLandscape: {
    flex: 0,
    width: 76,
    minHeight: 48,
    paddingHorizontal: 5,
  },
  confirmationSecondaryButtonLandscape: {
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  confirmationSecondaryTextLandscape: {
    color: colors.textPrimary,
  },
  confirmationActionTextLandscape: {
    ...typography.caption,
    textAlign: 'center',
  },
  cameraStage: { flex: 1, position: 'relative', overflow: 'hidden' },
  cameraStageDocumentPortrait: { marginBottom: 8 },
  camera: { ...StyleSheet.absoluteFillObject },
  overlayLayer: { ...StyleSheet.absoluteFillObject },
  permissionContainer: {
    flex: 1,
    backgroundColor: colors.background,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  permissionText: { ...typography.body, color: colors.textPrimary, marginBottom: spacing.xl, textAlign: 'center' },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 4,
  },
  headerDocumentModeButton: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerDocumentModeButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  headerPdfBtn: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: colors.primary,
    borderRadius: radii.sm,
  },
  headerPdfText: { ...typography.caption, color: colors.textOnPrimary, fontWeight: '700' },
  headerBtnDisabled: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  disabledText: { color: colors.textDisabled },
  focusHintBanner: {
    position: 'absolute',
    top: '42%',
    left: 20,
    right: 20,
    backgroundColor: 'rgba(255, 149, 0, 0.92)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radii.md,
    zIndex: 12,
  },
  focusHintText: {
    ...typography.label,
    color: colors.cameraText,
    fontWeight: '700',
    textAlign: 'center',
  },
  torchButton: {
    position: 'absolute',
    right: 16,
    zIndex: 14,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  torchButtonText: {
    fontSize: 20,
  },
  resetFramingButton: {
    position: 'absolute',
    right: 16,
    zIndex: 14,
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 8,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  resetFramingText: {
    ...typography.label,
    color: colors.cameraText,
    fontWeight: '700',
  },
  remountBtn: {
    marginTop: 8,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radii.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
  remountBtnText: {
    ...typography.label,
    color: colors.warning,
    fontWeight: '700',
  },
  processingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  processingCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    paddingHorizontal: 28,
    paddingVertical: 24,
    alignItems: 'stretch',
    minWidth: 280,
    maxWidth: '85%',
  },
  processingTitle: {
    ...typography.heading3,
    color: colors.textPrimary,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  processingBarTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceMuted,
    overflow: 'hidden',
  },
  processingBarFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  processingPercent: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    fontWeight: '700',
  },
  processingText: {
    ...typography.bodySecondary,
    marginTop: spacing.md,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  pdfImportButton: {
    position: 'absolute',
    top: 12,
    left: 16,
    backgroundColor: 'rgba(88, 86, 214, 0.88)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
  },
  pdfImportText: { ...typography.caption, color: colors.cameraText, fontWeight: '600' },
  previewContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: BUSINESS_CARD_PREVIEW_STRIP_HEIGHT,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  previewContainerDocument: {
    backgroundColor: 'transparent',
  },
  previewContainerLandscape: {
    top: 0,
    right: 'auto',
    bottom: 0,
    width: BUSINESS_CARD_PREVIEW_STRIP_HEIGHT,
    height: 'auto',
  },
  previewItem: {
    width: 60,
    height: 60,
    margin: 10,
    borderRadius: 5,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: colors.cameraSurface,
  },
  previewImage: { width: '100%', height: '100%' },
  previewBadge: {
    position: 'absolute',
    bottom: 2,
    left: 2,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  previewBadgeText: { ...typography.caption, color: colors.cameraText },
  removeButton: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 44,
    height: 44,
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
  },
  removeButtonVisual: {
    backgroundColor: 'rgba(255,0,0,0.8)',
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeButtonText: { ...typography.body, color: colors.cameraText, fontWeight: '700' },
  controlsDock: {
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  controlsDockLandscape: {
    marginLeft: 16,
    paddingHorizontal: 4,
    flexDirection: 'column',
    flexWrap: 'nowrap',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 8,
    backgroundColor: colors.surface,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
    zIndex: 16,
    elevation: 16,
  },
  landscapeActionButton: {
    width: 76,
    minHeight: 48,
    paddingHorizontal: 4,
    paddingVertical: 6,
    borderRadius: radii.lg,
  },
  documentShutterButton: {
    width: 72,
    minWidth: 72,
    height: 56,
    paddingHorizontal: 0,
    paddingVertical: 0,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  landscapeActionText: {
    ...typography.caption,
    textAlign: 'center',
  },
  landscapeUtilityButton: {
    width: 48,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  landscapeUtilityText: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  modeRow: {
    flexDirection: 'row',
    width: '100%',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 4,
  },
  modeButton: {
    flex: 1,
    maxWidth: 160,
    backgroundColor: 'rgba(0,0,0,0.52)',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 22,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  modeButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.cameraText,
    borderWidth: 2,
  },
  modeButtonText: {
    ...typography.button,
    color: colors.cameraText,
    fontWeight: '600',
  },
  modeButtonTextActive: {
    color: colors.textOnPrimary,
  },
  button: {
    backgroundColor: colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderRadius: 25,
    minWidth: 100,
    alignItems: 'center',
  },
  personButton: { backgroundColor: colors.info },
  processButton: { backgroundColor: colors.success },
  buttonDisabled: { backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  buttonText: { ...typography.button, color: colors.textOnPrimary, fontWeight: '600' },
});

import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';

import {
  View,
  StyleSheet,
  TouchableOpacity,
  Text,
  ActivityIndicator,
  Alert,
  useWindowDimensions,
} from 'react-native';

import { CameraView, useCameraPermissions } from 'expo-camera';
import { useTranslation } from 'react-i18next';

import { patchedAutofocusEventProp } from './camera-native-patch';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { scanBusinessCardBest } from '../../lib/ocr';

import { parseCard, buildCardTitle } from '../../lib/parser';

import { imagePipelineUris, prepareScannedImage } from '../../lib/image-utils';

import { runtimeLogger } from '../../lib/safe-runtime-logger';
import { typography } from '../../lib/ui-system';

import { useContactStore } from '../../store/useContactStore';

import { router, useFocusEffect } from 'expo-router';

import { Overlay, CardOrientation } from './Overlay';

import { FocusReticle } from './FocusReticle';

import { overlayCardFocusProps } from './camera-focus';

import { useFocusPulse } from './useFocusPulse';

import { getOverlayFrameRect } from '../../lib/overlay-geometry';
import {
  createLatestOperationController,
  createTemporaryAssetScope,
  finalizeAfterSettlement,
  runTimedOperation,
  type OperationInvalidationReason,
} from '../../lib/guarded-operation';
import { cleanupTemporaryImageUri } from '../../lib/temporary-image-cleanup';
import { yieldToOperationEventLoop } from '../../lib/scan-operation-lifecycle';
import { initializeParsedContactReviewState } from '../../lib/contact-review-state';



/** Legacy single-page business card scanner */

interface CapturedPhoto {
  uri: string;
  width?: number;
  height?: number;
}

interface Props {
  registerCancellation?: (
    cancel: ((reason?: OperationInvalidationReason) => void) | null
  ) => void;
}

export function CardScanner({ registerCancellation }: Props) {

  const { t } = useTranslation();

  const [permission, requestPermission] = useCameraPermissions();

  const [scanning, setScanning] = useState(false);

  const [cameraReady, setCameraReady] = useState(false);

  const [cardOrientation, setCardOrientation] = useState<CardOrientation>('landscape');

  const { autofocus, focusPulseKey, afState, onAutofocusStateChanged, pulseAutofocus, prepareForCapture, resetAutofocus } =
    useFocusPulse();

  const cameraRef = useRef<CameraView>(null);
  const scanOperationsRef = useRef(createLatestOperationController());
  const mountedRef = useRef(true);
  const screenActiveRef = useRef(false);
  const scanInProgressRef = useRef(false);

  const { setDraftContact } = useContactStore();

  const insets = useSafeAreaInsets();

  const { width: screenW, height: screenH } = useWindowDimensions();

  const cancelCurrentWork = useCallback(
    (reason: OperationInvalidationReason = 'manual') => {
      scanOperationsRef.current.invalidateCurrent(reason);
    },
    []
  );

  useEffect(() => {
    registerCancellation?.(cancelCurrentWork);
    return () => registerCancellation?.(null);
  }, [cancelCurrentWork, registerCancellation]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      screenActiveRef.current = false;
      scanOperationsRef.current.dispose();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      screenActiveRef.current = true;
      return () => {
        screenActiveRef.current = false;
        cancelCurrentWork('screen_blurred');
      };
    }, [cancelCurrentWork])
  );



  const viewportInsets = useMemo(
    () => ({ top: insets.top + 52, bottom: insets.bottom + 100, horizontal: 16 }),
    [insets.top, insets.bottom]
  );



  const overlayFrame = useMemo(
    () => getOverlayFrameRect(screenW, screenH, 'business_card', cardOrientation, viewportInsets),
    [screenW, screenH, cardOrientation, viewportInsets]
  );



  const cameraFocusProps = useMemo(
    () => overlayCardFocusProps(screenW, screenH, 'business_card', cardOrientation, viewportInsets),
    [screenW, screenH, cardOrientation, viewportInsets]
  );



  const scan = async () => {

    if (
      !cameraRef.current ||
      !screenActiveRef.current ||
      scanInProgressRef.current ||
      scanning ||
      !cameraReady
    ) {
      return;
    }

    const operation = scanOperationsRef.current.begin();
    const scanScope = createTemporaryAssetScope({
      cleanup: cleanupTemporaryImageUri,
    });
    const isScanActive = () =>
      mountedRef.current &&
      screenActiveRef.current &&
      operation.isActive();
    let pendingNativeCapture: Promise<CapturedPhoto> | null = null;

    // V101: traccia la fase corrente per log di errore preciso
    let currentStage: 'capture' | 'prepare_image' | 'ocr' | 'parse' | 'persist' = 'capture';

    scanInProgressRef.current = true;
    setScanning(true);

    try {

      await prepareForCapture('fast');
      if (!isScanActive()) return;

      const camera = cameraRef.current;
      if (!camera) return;

      // FASE: capture
      currentStage = 'capture';
      const nativeCapture = Promise.resolve().then(
        () =>
          camera.takePictureAsync({
            quality: 1,
            base64: false,
            // La camera applica EXIF prima che crop e resize decidano gli assi.
            skipProcessing: false,
          }) as Promise<CapturedPhoto>
      );
      pendingNativeCapture = nativeCapture;
      const captureOutcome = await runTimedOperation<CapturedPhoto | null>({
        operationId: `${operation.operationId}-capture`,
        timeoutMs: 8000,
        fallback: null,
        isExternallyActive: isScanActive,
        task: () => nativeCapture,
        onDiscardedValue: (latePhoto) => {
          if (latePhoto?.uri) scanScope.track(latePhoto.uri);
        },
      });
      if (captureOutcome.status !== 'timed_out') {
        pendingNativeCapture = null;
      }
      if (captureOutcome.status === 'failed') throw captureOutcome.error;
      if (captureOutcome.status === 'timed_out') {
        throw new Error('Scatto non riuscito. Riprova.');
      }
      if (captureOutcome.status !== 'completed') return;
      const photo = captureOutcome.value;
      if (photo?.uri) scanScope.track(photo.uri);
      if (!isScanActive()) return;



      if (!photo?.uri) {
        throw new Error('Foto non acquisita');
      }

      // FASE: prepare_image (crop, orientamento EXIF, resize)
      currentStage = 'prepare_image';
      const ocrPreparedUri = await prepareScannedImage(
        photo.uri,
        photo.width ?? 0,
        photo.height ?? 0,
        'business_card',
        cardOrientation,
        screenW,
        screenH,
        viewportInsets
      );
      scanScope.track(ocrPreparedUri);
      if (!isScanActive()) return;

      const imageUris = imagePipelineUris(photo.uri, ocrPreparedUri);

      // FASE: ocr
      currentStage = 'ocr';
      const ocr = await scanBusinessCardBest(
        imageUris.ocrPreparedUri,
        operation
      );
      if (!isScanActive()) return;

      const rawText = ocr.text.trim() || ocr.lines.map((l) => l.text).join('\n');

      // FASE: parse
      currentStage = 'parse';
      const contact = parseCard(ocr.lines, rawText);

      // FASE: persist (composizione stato e navigazione)
      currentStage = 'persist';
      const card = initializeParsedContactReviewState({
        ...contact,
        type: 'business_card' as const,
        title: buildCardTitle(contact.company, contact.firstName, contact.lastName),
        // La saga Fase 1 promuove questa sorgente temporanea nello storage
        // definitivo soltanto al salvataggio esplicito del contatto.
        images: [imageUris.persistenceSourceUri],
        ocrQuality: ocr.quality,
      });

      await yieldToOperationEventLoop();
      if (!isScanActive()) return;
      if (!operation.tryFinalize()) return;
      scanScope.retain(imageUris.persistenceSourceUri);
      setDraftContact(card);

      if (ocr.lines.length === 0 && !ocr.text.trim()) {
        Alert.alert(t('cameraPhotoSavedTitle'), t('cameraOcrUnavailableNativeBuild'));
      }

      router.replace(`/document/${card.id}`);

    } catch (error) {
      if (
        !mountedRef.current ||
        !screenActiveRef.current ||
        !operation.isCurrent()
      ) return;

      // V101: stage preciso — non sempre 'parse'
      runtimeLogger.error('CARD_SCAN_FAILED', error, {
        stage: currentStage,
        status: 'failed',
      });

      Alert.alert(t('error'), t('cardScanFailed'));

    } finally {
      finalizeAfterSettlement(pendingNativeCapture, () => {
        const wasCurrent = scanOperationsRef.current.isCurrent(operation);
        if (wasCurrent) {
          scanOperationsRef.current.finish(operation);
        }
        scanInProgressRef.current = false;
        void scanScope.close();
        if (
          wasCurrent &&
          mountedRef.current &&
          screenActiveRef.current
        ) {
          resetAutofocus();
          setScanning(false);
        }
      });

    }

  };



  if (!permission) return <View />;

  if (!permission.granted) {

    return (

      <View style={styles.permissionContainer}>

        <Text style={styles.permissionText}>{t('cameraPermissionDenied')}</Text>

        <TouchableOpacity style={styles.button} onPress={requestPermission}>

          <Text style={styles.buttonText}>{t('cameraGrantPermission')}</Text>

        </TouchableOpacity>

      </View>

    );

  }



  const controlsBottom = insets.bottom + 24;



  return (

    <View style={styles.container}>

      <CameraView

        ref={cameraRef}

        style={styles.camera}

        facing="back"

        mode="picture"

        autofocus={autofocus}

        {...cameraFocusProps}

        onCameraReady={() => {

          setCameraReady(true);

          void pulseAutofocus();

        }}

        {...patchedAutofocusEventProp(onAutofocusStateChanged)}

      />

      <View style={styles.overlayLayer} pointerEvents="none">

        <Overlay

          documentType="business_card"

          cardOrientation={cardOrientation}

          viewportWidth={screenW}

          viewportHeight={screenH}

          viewportInsets={viewportInsets}

        />

        {cameraReady ? (

          <FocusReticle

            frame={overlayFrame}

            pulseKey={focusPulseKey}

            afState={afState}

          />

        ) : null}

      </View>



      <TouchableOpacity

        style={[styles.orientationToggle, { top: insets.top + 12 }]}
        disabled={scanning}

        onPress={() => {
          if (scanInProgressRef.current) return;
          scanOperationsRef.current.invalidateCurrent('orientation_changed');
          setCardOrientation((prev) =>
            prev === 'landscape' ? 'portrait' : 'landscape'
          );
        }}

      >

        <Text style={styles.orientationText}>

          {cardOrientation === 'landscape' ? '↔ Orizzontale' : '↕ Verticale'}

        </Text>

      </TouchableOpacity>



      <View style={[styles.controls, { bottom: controlsBottom }]}>

        <TouchableOpacity

          style={[styles.button, (scanning || !cameraReady) && styles.buttonDisabled]}

          onPress={scan}

          disabled={scanning || !cameraReady}

        >

          {scanning ? (

            <ActivityIndicator color="#fff" />

          ) : (

            <Text style={styles.buttonText}>

              {cameraReady ? 'Scansiona' : 'Avvio camera...'}

            </Text>

          )}

        </TouchableOpacity>

      </View>

    </View>

  );

}



const styles = StyleSheet.create({

  container: { flex: 1 },

  camera: { ...StyleSheet.absoluteFillObject },

  overlayLayer: { ...StyleSheet.absoluteFillObject },

  permissionContainer: {

    flex: 1,

    justifyContent: 'center',

    alignItems: 'center',

    padding: 20,

  },

  permissionText: { ...typography.body, marginBottom: 20 },

  orientationToggle: {

    position: 'absolute',

    right: 16,

    backgroundColor: 'rgba(0,0,0,0.65)',

    paddingHorizontal: 14,

    paddingVertical: 8,

    borderRadius: 20,

  },

  orientationText: { ...typography.caption, color: '#fff', fontWeight: '600' },

  controls: {

    position: 'absolute',

    left: 0,

    right: 0,

    alignItems: 'center',

  },

  button: {

    backgroundColor: '#007AFF',

    paddingHorizontal: 40,

    paddingVertical: 15,

    borderRadius: 25,

  },

  buttonDisabled: { opacity: 0.6 },

  buttonText: { ...typography.button, color: '#fff' },

});

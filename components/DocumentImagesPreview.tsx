import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Image,
  ActivityIndicator,
  Alert,
} from 'react-native';
import ImageView from 'react-native-image-viewing';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, useUiPalette } from '../lib/ui-theme';
import { useTranslation } from 'react-i18next';
import { resolveImageUri } from '../lib/image-uri';
import { rotateImage } from '../lib/image-utils';
import { createLatestOperationController } from '../lib/guarded-operation';
import { cleanupTemporaryImageUri } from '../lib/temporary-image-cleanup';
import { spacing, typography } from '../lib/ui-system';

interface Props {
  images: string[];
  /** Original copy, used only when the derived preview is unreadable. */
  originalImages?: string[];
  /** Persiste rotazione e aggiorna contatto (ri-OCR opzionale nel callback). */
  onImageRotated?: (
    index: number,
    rotatedUri: string
  ) => Promise<void | (() => void)>;
  /** Blocca gli editor correlati per l'intera rotazione/OCR/persistenza. */
  onRotationStateChange?: (running: boolean) => void;
  disabled?: boolean;
}

export function DocumentImagesPreview({
  images,
  originalImages,
  onImageRotated,
  onRotationStateChange,
  disabled = false,
}: Props) {
  const palette = useUiPalette();
  const { t } = useTranslation();
  const rotationEnabled = Boolean(onImageRotated);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [displayUri, setDisplayUri] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const [useOriginalFallback, setUseOriginalFallback] = useState<Record<number, boolean>>({});
  const mountedRef = useRef(true);
  const rotateOperationsRef = useRef(createLatestOperationController());
  const ownedPreviewUrisRef = useRef(new Set<string>());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      rotateOperationsRef.current.dispose();
      for (const uri of ownedPreviewUrisRef.current) {
        void cleanupTemporaryImageUri(uri);
      }
      ownedPreviewUrisRef.current.clear();
    };
  }, []);

  useEffect(() => {
    setFailed({});
    setUseOriginalFallback({});
  }, [images, originalImages]);

  const resolvedImageAt = useCallback((index: number) => {
    const preview = images[index];
    const original = originalImages?.[index];
    const selected = useOriginalFallback[index] && original ? original : preview;
    return selected ? resolveImageUri(selected) : '';
  }, [images, originalImages, useOriginalFallback]);

  const viewerImages = useMemo(
    () => images.map((_, index) => ({ uri: resolvedImageAt(index) })),
    [images, resolvedImageAt]
  );

  const activeUri =
    displayUri ?? viewerImages[viewerIndex]?.uri ?? viewerImages[0]?.uri ?? '';

  const openViewer = (index: number) => {
    setViewerIndex(index);
    setDisplayUri(viewerImages[index]?.uri ?? null);
    setViewerVisible(true);
  };

  const closeViewer = () => {
    setViewerVisible(false);
    setDisplayUri(null);
  };

  const rotateViewer = useCallback(async () => {
    if (!activeUri || disabled || rotating || !mountedRef.current) return;
    const operation = rotateOperationsRef.current.begin();
    const isActive = () => mountedRef.current && operation.isActive();
    onRotationStateChange?.(true);
    setRotating(true);
    try {
      const rotated = await rotateImage(activeUri, 90);
      if (!isActive()) {
        void cleanupTemporaryImageUri(rotated);
        return;
      }
      if (onImageRotated) {
        const afterViewerClose = await onImageRotated(viewerIndex, rotated);
        if (!isActive()) return;
        setViewerVisible(false);
        setDisplayUri(null);
        afterViewerClose?.();
      } else {
        ownedPreviewUrisRef.current.add(rotated);
      }
      if (!isActive()) return;
      // Aggiorna la preview solo dopo il commit applicativo riuscito.
      if (!onImageRotated) setDisplayUri(rotated);
    } catch {
      if (!isActive()) return;
      Alert.alert(t('error'), t('captureFailed'));
    } finally {
      const wasCurrent =
        rotateOperationsRef.current.isCurrent(operation);
      if (wasCurrent) rotateOperationsRef.current.finish(operation);
      if (wasCurrent) onRotationStateChange?.(false);
      if (wasCurrent && mountedRef.current) setRotating(false);
    }
  }, [
    activeUri,
    disabled,
    rotating,
    onImageRotated,
    onRotationStateChange,
    viewerIndex,
    t,
  ]);

  if (images.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{t('scannedPhotos')}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {images.map((uri, index) => {
          const resolved = resolvedImageAt(index);
          const broken = failed[index];
          const hasOriginalFallback = Boolean(
            originalImages?.[index] && originalImages[index] !== uri
          );

          return (
            <TouchableOpacity
              key={`${uri}-${index}`}
              onPress={() => !broken && openViewer(index)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={`${t('scannedPhotos')} ${index + 1}`}
              accessibilityState={{ disabled: broken }}
            >
              {broken ? (
                <View style={[styles.thumbnail, styles.placeholder]}>
                  <Ionicons name="image-outline" size={28} color={colors.textDisabled} />
                </View>
              ) : (
                <Image
                  source={{ uri: resolved }}
                  style={styles.thumbnail}
                  resizeMode="contain"
                  onError={() => {
                    if (!useOriginalFallback[index] && hasOriginalFallback) {
                      setUseOriginalFallback((previous) => ({ ...previous, [index]: true }));
                      return;
                    }
                    setFailed((previous) => ({ ...previous, [index]: true }));
                  }}
                />
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ImageView
        images={[{ uri: activeUri }]}
        imageIndex={0}
        visible={viewerVisible}
        onRequestClose={closeViewer}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
        presentationStyle="overFullScreen"
        backgroundColor={palette.cameraSurface}
        FooterComponent={rotationEnabled ? () => (
          <View style={styles.viewerFooter}>
            <TouchableOpacity
              style={styles.rotateBtn}
              onPress={rotateViewer}
              disabled={disabled || rotating}
              accessibilityRole="button"
              accessibilityLabel={t('rotateImage')}
              accessibilityState={{ disabled: disabled || rotating, busy: rotating }}
            >
              {rotating ? (
                <ActivityIndicator color={colors.cameraText} size="small" />
              ) : (
                <>
                  <Ionicons name="refresh" size={20} color={colors.cameraText} />
                  <Text style={styles.rotateText}>{t('rotateImage')}</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={styles.footerHint}>{t('imageViewerHint')}</Text>
          </View>
        ) : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 20 },
  label: { ...typography.label, color: colors.textSecondary, marginBottom: spacing.sm },
  scroll: { flexGrow: 0, height: 90 },
  scrollContent: { alignItems: 'center' },
  thumbnail: {
    width: 120,
    height: 90,
    borderRadius: 8,
    marginRight: 10,
    backgroundColor: colors.surfaceMuted,
  },
  placeholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerFooter: {
    alignItems: 'center',
    paddingBottom: 28,
    paddingTop: 8,
    gap: 10,
  },
  rotateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.overlay,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
    minWidth: 120,
    justifyContent: 'center',
  },
  rotateText: { ...typography.button, color: colors.cameraText },
  footerHint: {
    color: colors.textDisabled,
    ...typography.caption,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
});

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { DocumentType, CardOrientation } from '../../types';
import { getOverlayFrameRectInView, OverlayViewportInsets, type PreviewLayout } from '../../lib/overlay-geometry';

export type { CardOrientation };

interface OverlayProps {
  documentType?: DocumentType;
  cardOrientation?: CardOrientation;
  viewportWidth: number;
  viewportHeight: number;
  viewportInsets?: OverlayViewportInsets;
  previewLayout?: PreviewLayout;
}

const OVERLAY_CONFIG: Record<DocumentType, { borderColor: string }> = {
  business_card: { borderColor: '#007AFF' },
  quote: { borderColor: '#5856D6' },
  order: { borderColor: '#FF9500' },
  invoice: { borderColor: '#FF3B30' },
  free_document: { borderColor: '#34C759' },
};

export function Overlay({
  documentType = 'business_card',
  cardOrientation = 'landscape',
  viewportWidth,
  viewportHeight,
  viewportInsets,
  previewLayout,
}: OverlayProps) {
  const frame = getOverlayFrameRectInView(
    viewportWidth,
    viewportHeight,
    documentType,
    cardOrientation,
    viewportInsets,
    previewLayout
  );
  const config = OVERLAY_CONFIG[documentType];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.dim, { top: 0, left: 0, right: 0, height: frame.y }]} />
      <View
        style={[
          styles.dim,
          { top: frame.y + frame.height, left: 0, right: 0, bottom: 0 },
        ]}
      />
      <View
        style={[
          styles.dim,
          { top: frame.y, left: 0, width: frame.x, height: frame.height },
        ]}
      />
      <View
        style={[
          styles.dim,
          {
            top: frame.y,
            left: frame.x + frame.width,
            right: 0,
            height: frame.height,
          },
        ]}
      />
      <View
        style={[
          styles.frame,
          {
            top: frame.y,
            left: frame.x,
            width: frame.width,
            height: frame.height,
            borderColor: config.borderColor,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  dim: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  frame: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 8,
    backgroundColor: 'transparent',
  },
});

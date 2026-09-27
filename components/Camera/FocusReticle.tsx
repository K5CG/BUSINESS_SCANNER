import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { AfState } from '../../lib/camera-focus-gate';

interface Props {
  /** Rettangolo del biglietto (stesso del riquadro verde). */
  frame: { x: number; y: number; width: number; height: number };
  pulseKey: number;
  afState?: AfState;
}

const STATE_COLOR: Partial<Record<AfState, string>> = {
  ACTIVE_SCAN: '#FFD60A',
  FOCUSED_LOCKED: '#34C759',
  NOT_FOCUSED_LOCKED: '#FF453A',
  TIMEOUT: '#FF9F0A',
};

/** Bordo AF = area intera del biglietto (5+ punti messa a fuoco), non un quadratino centrale. */
export function FocusReticle({ frame, pulseKey, afState = 'PASSIVE_SCAN' }: Props) {
  const opacity = useRef(new Animated.Value(0.85)).current;

  useEffect(() => {
    opacity.setValue(1);
    Animated.timing(opacity, {
      toValue: afState === 'FOCUSED_LOCKED' ? 0.45 : 0.75,
      duration: 500,
      useNativeDriver: true,
    }).start();
  }, [pulseKey, afState, opacity]);

  const borderColor = STATE_COLOR[afState] ?? '#FFD60A88';
  const label =
    afState === 'FOCUSED_LOCKED'
      ? 'AF card'
      : afState === 'ACTIVE_SCAN'
        ? 'AF scan'
        : 'AF area';

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        {
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          opacity,
        },
      ]}
    >
      <View
        style={[
          styles.box,
          {
            borderColor,
            width: frame.width,
            height: frame.height,
          },
        ]}
      />
      <Text style={[styles.label, { color: borderColor }]}>{label}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
  },
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 8,
    borderStyle: 'solid',
  },
  label: {
    position: 'absolute',
    top: -20,
    alignSelf: 'center',
    width: '100%',
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});

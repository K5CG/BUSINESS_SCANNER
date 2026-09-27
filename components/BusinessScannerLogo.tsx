import React from 'react';
import { Image, StyleSheet } from 'react-native';
import { useIsDarkMode } from '../lib/ui-theme';

const DEFAULT_LOGO_WIDTH = 88;
const LOGO_ASPECT_RATIO = 88 / 45;
const LIGHT_LOGO = require('../assets/logo-wordmark.png');
const DARK_LOGO = require('../assets/logo-wordmark-dark.png');

export function BusinessScannerLogo({ width = DEFAULT_LOGO_WIDTH }: { width?: number }) {
  const isDarkMode = useIsDarkMode();
  const safeWidth = Math.max(48, width);

  return (
    <Image
      source={isDarkMode ? DARK_LOGO : LIGHT_LOGO}
      style={[styles.logo, { width: safeWidth, height: safeWidth / LOGO_ASPECT_RATIO }]}
      resizeMode='contain'
      fadeDuration={0}
      accessibilityLabel='Business Scanner'
    />
  );
}

const styles = StyleSheet.create({
  logo: {},
});

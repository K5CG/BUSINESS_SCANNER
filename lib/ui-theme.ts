import {
  DynamicColorIOS,
  Platform,
  PlatformColor,
  type ColorValue,
  useColorScheme,
} from 'react-native';
import { darkColors, lightColors, type UiColorName, type UiPalette } from './ui-tokens';

const androidResourceNames: Record<UiColorName, string> = {
  textPrimary: 'ui_text_primary',
  textSecondary: 'ui_text_secondary',
  textDisabled: 'ui_text_disabled',
  background: 'ui_background',
  surface: 'ui_surface',
  surfaceMuted: 'ui_surface_muted',
  border: 'ui_border',
  primary: 'ui_primary',
  primaryPressed: 'ui_primary_pressed',
  textOnPrimary: 'ui_text_on_primary',
  danger: 'ui_danger',
  dangerSurface: 'ui_danger_surface',
  warning: 'ui_warning',
  warningSurface: 'ui_warning_surface',
  success: 'ui_success',
  successSurface: 'ui_success_surface',
  info: 'ui_info',
  infoSurface: 'ui_info_surface',
  overlay: 'ui_overlay',
  scrim: 'ui_scrim',
  cameraText: 'ui_camera_text',
  cameraMuted: 'ui_camera_muted',
  cameraSurface: 'ui_camera_surface',
};

function adaptiveColor(name: UiColorName): ColorValue {
  if (Platform.OS === 'ios' && typeof DynamicColorIOS === 'function') {
    return DynamicColorIOS({ light: lightColors[name], dark: darkColors[name] });
  }
  if (Platform.OS === 'android' && typeof PlatformColor === 'function') {
    return PlatformColor(`@color/${androidResourceNames[name]}`);
  }
  return lightColors[name];
}

export const colors: Record<UiColorName, ColorValue> = Object.freeze(
  Object.fromEntries(
    (Object.keys(lightColors) as UiColorName[]).map((name) => [name, adaptiveColor(name)])
  ) as Record<UiColorName, ColorValue>
);

export function useUiPalette(): UiPalette {
  return useColorScheme() === 'dark' ? darkColors : lightColors;
}

export function useIsDarkMode(): boolean {
  return useColorScheme() === 'dark';
}

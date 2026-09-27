import * as FileSystem from 'expo-file-system/legacy';
import { runtimeLogger } from './safe-runtime-logger';

export type ThemePreference = 'system' | 'light' | 'dark';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

function preferenceFileUri(): string | null {
  const root = FileSystem.documentDirectory;
  return root ? `${root}theme-preference.txt` : null;
}

export function normalizeThemePreference(value: string): ThemePreference {
  return value === 'light' || value === 'dark' ? value : DEFAULT_THEME_PREFERENCE;
}

export async function getSavedThemePreference(): Promise<ThemePreference> {
  const uri = preferenceFileUri();
  if (!uri) return DEFAULT_THEME_PREFERENCE;

  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return DEFAULT_THEME_PREFERENCE;
    return normalizeThemePreference((await FileSystem.readAsStringAsync(uri)).trim());
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export async function saveThemePreference(preference: ThemePreference): Promise<void> {
  const uri = preferenceFileUri();
  if (!uri) return;

  try {
    await FileSystem.writeAsStringAsync(uri, preference);
  } catch (error) {
    runtimeLogger.warn('THEME_PREFERENCE_SAVE_FAILED', error, {
      source: 'filesystem',
      stage: 'write',
      status: 'failed',
    });
  }
}

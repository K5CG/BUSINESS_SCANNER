import * as FileSystem from 'expo-file-system/legacy';
import { runtimeLogger } from './safe-runtime-logger';

export type AppLocale = 'it' | 'en';

export const DEFAULT_LOCALE: AppLocale = 'it';

function localeFileUri(): string | null {
  const root = FileSystem.documentDirectory;
  if (!root) return null;
  return `${root}locale.txt`;
}

export function getSystemLocale(): AppLocale {
  try {
    const sysLocale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    if (sysLocale.toLowerCase().startsWith('it')) {
      return 'it';
    }
    return 'en';
  } catch {
    return 'it';
  }
}

export async function getSavedLocale(): Promise<AppLocale> {
  const uri = localeFileUri();
  const defaultLoc = getSystemLocale();
  if (!uri) return defaultLoc;

  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return defaultLoc;

    const code = (await FileSystem.readAsStringAsync(uri)).trim();
    return code === 'en' ? 'en' : 'it';
  } catch {
    return defaultLoc;
  }
}

export async function saveLocale(locale: AppLocale): Promise<void> {
  const uri = localeFileUri();
  if (!uri) return;

  try {
    await FileSystem.writeAsStringAsync(uri, locale);
  } catch (error) {
    runtimeLogger.warn('LOCALE_SAVE_FAILED', error, {
      source: 'filesystem',
      stage: 'write',
      status: 'failed',
    });
  }
}

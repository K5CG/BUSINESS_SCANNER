import * as FileSystem from 'expo-file-system/legacy';
import { runtimeLogger } from './safe-runtime-logger';

export interface AiNoticePreference {
  skipExtendedNotice: boolean;
}

function prefFileUri(): string | null {
  const root = FileSystem.documentDirectory;
  if (!root) return null;
  return `${root}ai-notice-preference.json`;
}

export async function getAiNoticePreference(): Promise<AiNoticePreference> {
  const uri = prefFileUri();
  if (!uri) return { skipExtendedNotice: false };

  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return { skipExtendedNotice: false };

    const raw = await FileSystem.readAsStringAsync(uri);
    const parsed = JSON.parse(raw) as AiNoticePreference;
    return { skipExtendedNotice: Boolean(parsed?.skipExtendedNotice) };
  } catch {
    return { skipExtendedNotice: false };
  }
}

export async function saveAiNoticePreference(skipExtendedNotice: boolean): Promise<void> {
  const uri = prefFileUri();
  if (!uri) return;

  try {
    await FileSystem.writeAsStringAsync(
      uri,
      JSON.stringify({ skipExtendedNotice }, null, 2)
    );
  } catch (error) {
    runtimeLogger.warn('AI_NOTICE_SAVE_FAILED', error, {
      source: 'filesystem',
      stage: 'write',
      status: 'failed',
    });
  }
}

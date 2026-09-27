import { NativeModules, Platform } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

const KEEP_AWAKE_TAG = 'contacts-export';

type ScreenWakeNative = {
  acquire?: () => void;
  release?: () => void;
};

const screenWake = NativeModules.ScreenWake as ScreenWakeNative | undefined;

export async function acquireScreenWake(): Promise<void> {
  await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
  if (Platform.OS === 'android') {
    screenWake?.acquire?.();
  }
}

export async function releaseScreenWake(): Promise<void> {
  if (Platform.OS === 'android') {
    screenWake?.release?.();
  }
  await deactivateKeepAwake(KEEP_AWAKE_TAG);
}

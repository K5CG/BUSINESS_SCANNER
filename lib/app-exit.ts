import { BackHandler, Platform } from 'react-native';
import { exitAppSessionSideEffects } from './app-exit-policy';

export { exitAppSessionSideEffects };

/**
 * Close the current app session only.
 * Must NOT clear SecureStore, privacy consent, installation id, trial, license, or local data.
 *
 * Android: BackHandler.exitApp() finishes the current activity (data preserved).
 * The task may remain in Recents. finishAndRemoveTask() is not wired: android/
 * is prebuild-generated and this repo has no native exit module. Do not use
 * process-kill or JVM halt APIs.
 * iOS: no forced process kill — returns attempted:false; UI must stay stable.
 */
export function exitAppSession(): { attempted: boolean; platform: string } {
  if (Platform.OS === 'android') {
    BackHandler.exitApp();
    return { attempted: true, platform: 'android' };
  }
  return { attempted: false, platform: Platform.OS };
}

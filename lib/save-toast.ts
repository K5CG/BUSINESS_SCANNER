import { Platform, ToastAndroid } from 'react-native';

/** Messaggio breve senza popup bloccante (Android). */
export function showSaveToast(message: string): void {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
  }
}

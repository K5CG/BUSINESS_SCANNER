import { CameraView } from 'expo-camera';

/** Props native patch v4 non presenti nei tipi expo-camera. */
export function patchedAutofocusEventProp(
  handler: (event: { nativeEvent: Record<string, unknown> }) => void
): Record<string, unknown> {
  return { onAutofocusStateChanged: handler };
}

export async function getAvailablePictureSizesAsync(): Promise<string[]> {
  const fn = (
    CameraView as unknown as { getAvailablePictureSizesAsync?: () => Promise<string[]> }
  ).getAvailablePictureSizesAsync;
  return (await fn?.()) ?? [];
}

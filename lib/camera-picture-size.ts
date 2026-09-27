import { pickMaxPictureSize } from './camera-focus-gate';
import type { FocusGate } from './camera-focus-gate';

/** Seleziona la risoluzione JPEG massima supportata dal sensore. */
export async function selectMaxPictureSize(
  getSizes: () => Promise<string[] | undefined>,
  gate?: Pick<FocusGate, 'setPictureSizeDiag'>
): Promise<string | undefined> {
  try {
    const sizes = (await getSizes()) ?? [];
    const max = pickMaxPictureSize(sizes);
    if (max) gate?.setPictureSizeDiag(max);
    return max;
  } catch {
    return undefined;
  }
}

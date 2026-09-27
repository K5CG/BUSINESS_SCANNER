import type { BaseDocument } from '../types';

type DocumentAssetSet = Pick<BaseDocument, 'images' | 'originalImages'>;

export function collectDocumentAssetUris(document: DocumentAssetSet): string[] {
  return [...document.images, ...(document.originalImages ?? [])];
}

export function splitFinalDocumentAssetUris(
  finalUris: readonly string[],
  displayedPageCount: number,
  hasOriginalImages: boolean,
): { images: string[]; originalImages?: string[] } {
  if (!Number.isSafeInteger(displayedPageCount) || displayedPageCount < 0) {
    throw new Error('Numero pagine persistenti non valido');
  }
  const expectedCount = hasOriginalImages ? displayedPageCount * 2 : displayedPageCount;
  if (finalUris.length !== expectedCount) {
    throw new Error('Asset finali non allineati alle pagine del documento');
  }
  return {
    images: finalUris.slice(0, displayedPageCount),
    ...(hasOriginalImages
      ? { originalImages: finalUris.slice(displayedPageCount) }
      : {}),
  };
}

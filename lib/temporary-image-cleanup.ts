import * as FileSystem from 'expo-file-system/legacy';
import { resolveImageUri } from './image-uri';

function normalizedDirectoryUri(uri: string): string {
  const normalized = resolveImageUri(uri.trim());
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function isTemporaryCacheFileUri(
  uri: string,
  cacheDirectory: string | null | undefined,
  allowedExtension: RegExp
): boolean {
  if (!uri.trim() || !cacheDirectory?.trim()) return false;
  const normalized = resolveImageUri(uri.trim());
  const root = normalizedDirectoryUri(cacheDirectory);
  if (!normalized.startsWith(root)) return false;

  const relative = normalized.slice(root.length);
  if (!relative || relative.endsWith('/')) return false;
  let decodedRelative: string;
  try {
    decodedRelative = decodeURIComponent(relative);
  } catch {
    return false;
  }
  if (
    decodedRelative.includes('\0') ||
    decodedRelative.startsWith('/') ||
    decodedRelative.startsWith('\\')
  ) {
    return false;
  }
  const segments = decodedRelative.split(/[\\/]/);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    return false;
  }
  return allowedExtension.test(decodedRelative);
}

export function isTemporaryCacheImageUri(
  uri: string,
  cacheDirectory: string | null | undefined
): boolean {
  return isTemporaryCacheFileUri(
    uri,
    cacheDirectory,
    /\.(?:jpe?g|png|webp)$/i
  );
}

export function isTemporaryCachePdfUri(
  uri: string,
  cacheDirectory: string | null | undefined
): boolean {
  return isTemporaryCacheFileUri(uri, cacheDirectory, /\.pdf$/i);
}

export function createTemporaryImageCleaner(options: {
  cacheDirectory: string | null | undefined;
  deleteUri: (uri: string) => Promise<void>;
}): (uri: string) => Promise<void> {
  return async (uri: string) => {
    if (!isTemporaryCacheImageUri(uri, options.cacheDirectory)) return;
    await options.deleteUri(resolveImageUri(uri.trim()));
  };
}

export const cleanupTemporaryImageUri = createTemporaryImageCleaner({
  cacheDirectory: FileSystem.cacheDirectory,
  deleteUri: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
});

export async function cleanupTemporaryPdfUri(uri: string): Promise<void> {
  if (!isTemporaryCachePdfUri(uri, FileSystem.cacheDirectory)) return;
  await FileSystem.deleteAsync(resolveImageUri(uri.trim()), {
    idempotent: true,
  });
}

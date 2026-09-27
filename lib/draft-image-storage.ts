import * as FileSystem from 'expo-file-system/legacy';
import { createId } from './id';
import { resolveImageUri } from './image-uri';
import { cleanupTemporaryImageUri } from './temporary-image-cleanup';

const DRAFT_DIRECTORY_NAME = 'scan-drafts';

function draftDirectoryUri(): string {
  const root = FileSystem.documentDirectory;
  if (!root) throw new Error('Storage bozze non disponibile');
  return `${root}${DRAFT_DIRECTORY_NAME}/`;
}

function normalized(uri: string): string {
  return resolveImageUri(uri.trim());
}

/** CameraView usa una cache che può sparire quando la schermata si smonta. */
export async function copyImageToDraftStorage(sourceUri: string): Promise<string> {
  const source = normalized(sourceUri);
  if (!source) throw new Error('URI immagine bozza mancante');
  const directory = draftDirectoryUri();
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const target = `${directory}${createId()}.jpg`;
  await FileSystem.copyAsync({ from: source, to: target });
  const info = await FileSystem.getInfoAsync(target);
  if (!info.exists) throw new Error('Copia immagine bozza non disponibile');
  return target;
}

export function isDraftImageUri(uri: string): boolean {
  try {
    return normalized(uri).startsWith(draftDirectoryUri());
  } catch {
    return false;
  }
}

/** Pulisce cache effimera e copie private create per la bozza. */
export async function cleanupScanSessionImageUri(uri: string): Promise<void> {
  if (isDraftImageUri(uri)) {
    await FileSystem.deleteAsync(normalized(uri), { idempotent: true });
    return;
  }
  await cleanupTemporaryImageUri(uri);
}

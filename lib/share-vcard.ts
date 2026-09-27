import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { BusinessCard } from '../types';
import { buildVCardFileName, exportToVCard } from './export-vcard';
import { runtimeLogger } from './safe-runtime-logger';

export const VCARD_SHARE_MIME_TYPE = 'text/vcard';
export const VCARD_SHARE_UTI = 'public.vcard';

export async function shareContactVCardFile(contact: BusinessCard): Promise<boolean> {
  const content = exportToVCard(contact);
  const fileName = buildVCardFileName(contact);
  const dir = new Directory(Paths.cache, 'vcf-export');
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  const file = new File(dir, fileName);
  if (file.exists) {
    file.delete();
  }
  file.create();
  file.write(content);

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) return false;
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: VCARD_SHARE_MIME_TYPE,
      UTI: VCARD_SHARE_UTI,
      dialogTitle: fileName,
    });
    return true;
  } catch (error) {
    runtimeLogger.warn('QA_SHARE_FAILED', error, {
      source: 'filesystem',
      stage: 'write',
      status: 'failed',
    });
    return false;
  }
}

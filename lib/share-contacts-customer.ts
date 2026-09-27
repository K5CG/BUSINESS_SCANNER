import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { BusinessCard } from '../types';
import {
  buildCustomerContactsCsv,
  buildCustomerContactsExportFileName,
  buildCustomerContactsXlsxBytes,
  type CustomerContactExportFormat,
  type CustomerContactExportScope,
  type CustomerExportLocale,
} from './export-contacts-customer';
import { runtimeLogger } from './safe-runtime-logger';

export const XLSX_SHARE_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const XLSX_SHARE_UTI = 'org.openxmlformats.spreadsheetml.sheet';
export const CSV_SHARE_MIME_TYPE = 'text/csv';
export const CSV_SHARE_UTI = 'public.comma-separated-values-text';

export type CustomerContactsShareStatus = 'shared' | 'unavailable' | 'cancelled' | 'failed';

export async function shareCustomerContactsExport(options: {
  contacts: BusinessCard[];
  format: CustomerContactExportFormat;
  scope: CustomerContactExportScope;
  locale?: CustomerExportLocale;
  exportedAt?: Date;
}): Promise<CustomerContactsShareStatus> {
  if (options.contacts.length === 0) {
    return 'failed';
  }

  const locale = options.locale ?? 'it';
  const fileName = buildCustomerContactsExportFileName(
    options.scope,
    options.format,
    options.exportedAt ?? new Date()
  );

  try {
    const dir = new Directory(Paths.cache, 'contacts-export');
    if (!dir.exists) {
      dir.create({ intermediates: true });
    }
    const file = new File(dir, fileName);
    if (file.exists) {
      file.delete();
    }
    file.create();
    if (options.format === 'xlsx') {
      file.write(buildCustomerContactsXlsxBytes(options.contacts, locale));
    } else {
      file.write(buildCustomerContactsCsv(options.contacts, locale));
    }

    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) return 'unavailable';

    await Sharing.shareAsync(file.uri, {
      mimeType: options.format === 'xlsx' ? XLSX_SHARE_MIME_TYPE : CSV_SHARE_MIME_TYPE,
      UTI: options.format === 'xlsx' ? XLSX_SHARE_UTI : CSV_SHARE_UTI,
      dialogTitle: fileName,
    });
    return 'shared';
  } catch (error) {
    if (isShareCancellation(error)) return 'cancelled';
    runtimeLogger.warn('CONTACT_EXPORT_FAILED', error, {
      source: 'filesystem',
      stage: 'write',
      status: 'failed',
    });
    return 'failed';
  }
}

function isShareCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /cancel|dismiss|did not share|sharing.*abort/i.test(message);
}

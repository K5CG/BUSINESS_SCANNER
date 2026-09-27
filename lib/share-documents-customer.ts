import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { customerExportLocale } from './export-contacts-customer';
import {
  PDF_SHARE_MIME_TYPE,
  PDF_SHARE_UTI,
  buildCustomerDocumentsExportFileName,
  buildCustomerDocumentsPdfBytes,
  buildCustomerDocumentsXlsxBytes,
  type CustomerDocumentExportFormat,
  type CustomerDocumentExportScope,
  type CustomerStoredDocument,
} from './export-documents-customer';
import { runtimeLogger } from './safe-runtime-logger';
import { XLSX_SHARE_MIME_TYPE, XLSX_SHARE_UTI } from './share-contacts-customer';

export type CustomerDocumentsShareStatus = 'shared' | 'unavailable' | 'cancelled' | 'failed';

export async function shareCustomerDocumentsExport(options: {
  documents: CustomerStoredDocument[];
  format: CustomerDocumentExportFormat;
  scope: CustomerDocumentExportScope;
  locale?: ReturnType<typeof customerExportLocale>;
  exportedAt?: Date;
}): Promise<CustomerDocumentsShareStatus> {
  if (options.documents.length === 0) return 'failed';

  const locale = options.locale ?? 'it';
  const fileName = buildCustomerDocumentsExportFileName(
    options.scope,
    options.format,
    options.exportedAt ?? new Date()
  );

  try {
    const dir = new Directory(Paths.cache, 'documents-export');
    if (!dir.exists) {
      dir.create({ intermediates: true });
    }
    const file = new File(dir, fileName);
    if (file.exists) {
      file.delete();
    }
    file.create();
    if (options.format === 'xlsx') {
      file.write(buildCustomerDocumentsXlsxBytes(options.documents, locale));
    } else {
      file.write(await buildCustomerDocumentsPdfBytes(options.documents, locale));
    }

    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) return 'unavailable';

    await Sharing.shareAsync(file.uri, {
      mimeType: options.format === 'xlsx' ? XLSX_SHARE_MIME_TYPE : PDF_SHARE_MIME_TYPE,
      UTI: options.format === 'xlsx' ? XLSX_SHARE_UTI : PDF_SHARE_UTI,
      dialogTitle: fileName,
    });
    return 'shared';
  } catch (error) {
    if (isShareCancellation(error)) return 'cancelled';
    runtimeLogger.warn('QA_SHARE_FAILED', error, {
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

import { Directory, File, Paths } from 'expo-file-system';
import { zipSync } from 'fflate';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import type { AnyDocument, FreeDocument, InvoiceDocument, OrderDocument, QuoteDocument } from '../types';
import { resolveImageUri } from './image-uri';
import { qaImageFilename } from './export-qa';
import { documentDateOnlyText } from './document-date-only';

type StoredDocument = QuoteDocument | OrderDocument | InvoiceDocument | FreeDocument;

const CSV_COLUMNS = [
  'id',
  'type',
  'createdAt',
  'updatedAt',
  'title',
  'documentNumber',
  'documentDate',
  'customerName',
  'total',
  'subtotal',
  'vatAmount',
  'currency',
  'itemCount',
  'notes',
  'rawText',
  'confidenceSummary',
  'structuredComplete',
  'structuredRequiresReview',
  'structuredReasons',
  'structuredItemCount',
  'canonicalFieldSource',
  'imageCount',
  'imageFilenames',
] as const;

function textEncoder(): (value: string) => Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    const encoder = new TextEncoder();
    return (value) => encoder.encode(value);
  }
  return (value) => {
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return new Uint8Array(bytes);
  };
}

const encodeText = textEncoder();

function csvEscape(
  value: string | number | boolean | undefined | null
): string {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** Il giorno del documento non è un istante: esportarlo in UTC lo sposterebbe. */
function formatDateOnly(value: Date | string | undefined): string {
  return documentDateOnlyText(value) ?? '';
}

function formatIsoDate(value: Date | string | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function formatDisplayDate(value: Date | string | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function confidenceSummary(doc: StoredDocument): string {
  return Object.entries(doc.confidence ?? {})
    .map(([key, score]) => `${key}:${score}`)
    .join('; ');
}

function documentNumber(doc: StoredDocument): string {
  if (doc.type === 'quote') return doc.quoteNumber ?? '';
  if (doc.type === 'order') return doc.orderNumber ?? '';
  if (doc.type === 'invoice') return doc.invoiceNumber ?? '';
  return doc.documentNumber ?? '';
}

function documentDate(doc: StoredDocument): Date | undefined {
  if (doc.type === 'quote') return doc.quoteDate;
  if (doc.type === 'order') return doc.orderDate;
  if (doc.type === 'invoice') return doc.invoiceDate;
  return doc.documentDate;
}

function customerName(doc: StoredDocument): string {
  if (doc.type === 'free_document') return doc.subject ?? '';
  return doc.customerName ?? '';
}

function totalValue(doc: StoredDocument): number | '' {
  if (doc.type === 'free_document') return '';
  return doc.total ?? '';
}

function itemCount(doc: StoredDocument): number {
  if (doc.type === 'free_document') return Object.keys(doc.extractedFields ?? {}).length;
  return doc.items?.length ?? 0;
}

function structuredSummary(doc: StoredDocument): {
  complete: boolean | '';
  requiresReview: boolean | '';
  reasons: string;
  itemCount: number;
  canonicalFieldSource: string;
} {
  const structured = doc.structuredExtraction;
  if (!structured) {
    return { complete: '', requiresReview: '', reasons: '', itemCount: 0, canonicalFieldSource: 'legacy_only' };
  }
  const deferred = structured.reasons.includes('structured_extraction_deferred_on_scan');
  const reliability = doc.fieldReliability ?? {};
  const canonicalFields = Object.entries(reliability)
    .filter(([, value]) => value?.source === 'local_ocr' && !value.requiresReview)
    .map(([key]) => key);
  return {
    complete: structured.complete,
    requiresReview: structured.requiresReview,
    reasons: structured.reasons.join('; '),
    itemCount: structured.items.length,
    canonicalFieldSource: deferred
      ? 'legacy_fallback'
      : canonicalFields.length > 0
        ? `structured:${canonicalFields.join(',')}`
        : 'structured',
  };
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readImageBytes(uri: string): Promise<Uint8Array | null> {
  const resolved = resolveImageUri(uri);
  try {
    const info = await FileSystem.getInfoAsync(resolved);
    if (!info.exists) return null;
    const base64 = await FileSystem.readAsStringAsync(resolved, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return base64ToUint8(base64);
  } catch {
    return null;
  }
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function serializeDocumentForQaJson(doc: StoredDocument): Record<string, unknown> {
  const structured = structuredSummary(doc);
  return {
    ...doc,
    createdAt: formatIsoDate(doc.createdAt),
    updatedAt: formatIsoDate(doc.updatedAt),
    quoteDate: doc.type === 'quote' ? formatDateOnly(doc.quoteDate) : undefined,
    orderDate: doc.type === 'order' ? formatDateOnly(doc.orderDate) : undefined,
    invoiceDate: doc.type === 'invoice' ? formatDateOnly(doc.invoiceDate) : undefined,
    documentDate: doc.type === 'free_document' ? formatDateOnly(doc.documentDate) : undefined,
    structuredComplete: structured.complete,
    structuredRequiresReview: structured.requiresReview,
    structuredReasons: structured.reasons,
    structuredItemCount: structured.itemCount,
    canonicalFieldSource: structured.canonicalFieldSource,
  };
}

export function buildDocumentsCsv(documents: StoredDocument[]): string {
  const rows = documents.map((doc) => {
    const imageNames = (doc.images ?? []).map((_, index, all) =>
      qaImageFilename(doc.id, index, all.length)
    );
    const structured = structuredSummary(doc);
    return [
      doc.id,
      doc.type,
      formatIsoDate(doc.createdAt),
      formatIsoDate(doc.updatedAt),
      doc.title ?? '',
      documentNumber(doc),
      formatDisplayDate(documentDate(doc)),
      customerName(doc),
      totalValue(doc),
      doc.type === 'free_document' ? '' : doc.subtotal ?? '',
      doc.type === 'free_document' ? '' : doc.vatAmount ?? '',
      doc.type === 'free_document' ? '' : doc.currency ?? '',
      itemCount(doc),
      doc.notes ?? '',
      doc.rawText ?? '',
      confidenceSummary(doc),
      structured.complete,
      structured.requiresReview,
      structured.reasons,
      structured.itemCount,
      structured.canonicalFieldSource,
      String(doc.images?.length ?? 0),
      imageNames.join('; '),
    ]
      .map(csvEscape)
      .join(',');
  });
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

export function buildDocumentsJson(documents: StoredDocument[]): string {
  return JSON.stringify(documents.map(serializeDocumentForQaJson), null, 2);
}

function buildReadme(documents: StoredDocument[], exportedAt: Date): string {
  const stamp = exportedAt.toISOString();
  const counts = {
    quote: documents.filter((d) => d.type === 'quote').length,
    order: documents.filter((d) => d.type === 'order').length,
    invoice: documents.filter((d) => d.type === 'invoice').length,
    free_document: documents.filter((d) => d.type === 'free_document').length,
  };
  return [
    'Business Scanner — Export QA documenti',
    `Data export: ${stamp}`,
    `Documenti esportati: ${documents.length}`,
    `- Preventivi: ${counts.quote}`,
    `- Ordini: ${counts.order}`,
    `- Fatture: ${counts.invoice}`,
    `- Documenti liberi: ${counts.free_document}`,
    '',
    'Contenuto ZIP:',
    '- documents.csv / documents.json — dati estratti + OCR grezzo',
    '- manifest.json — indice id → file',
    '- raw-text/ — OCR grezzo per documento',
    '- images/ — scan JPEG',
    '',
    'Colonne principali: type, documentNumber, documentDate, customerName, total, rawText',
  ].join('\n');
}

export interface DocumentsQaExportProgress {
  phase: 'text' | 'images' | 'zip';
  current: number;
  total: number;
}

export interface DocumentsQaExportResult {
  zipPath: string;
  fileName: string;
  documentCount: number;
  sizeBytes: number;
}

export async function exportDocumentsQa(
  documents: StoredDocument[],
  onProgress?: (progress: DocumentsQaExportProgress) => void
): Promise<DocumentsQaExportResult> {
  const exportedAt = new Date();
  const stamp = exportedAt.toISOString().replace(/[:.]/g, '-');
  const fileName = `qa-documents-export_all_${stamp}.zip`;
  const zipEntries: Record<string, Uint8Array> = {
    'documents.csv': encodeText(buildDocumentsCsv(documents)),
    'documents.json': encodeText(buildDocumentsJson(documents)),
    'manifest.json': encodeText(
      JSON.stringify(
        {
          exportedAt: exportedAt.toISOString(),
          documentCount: documents.length,
          documents: documents.map((doc) => ({
            id: doc.id,
            type: doc.type,
            title: doc.title,
            rawTextFile: `raw-text/${doc.id}.txt`,
            imageFiles: (doc.images ?? []).map(
              (_, index, all) => `images/${qaImageFilename(doc.id, index, all.length)}`
            ),
            originalImageFiles: (doc.originalImages ?? []).map(
              (_, index, all) => `original-images/${qaImageFilename(doc.id, index, all.length)}`
            ),
            pageCaptureMetadata: doc.pageCaptureMetadata ?? [],
          })),
        },
        null,
        2
      )
    ),
    'README_QA.txt': encodeText(buildReadme(documents, exportedAt)),
  };

  const total = documents.length;
  onProgress?.({ phase: 'text', current: 0, total });

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    if (doc.rawText?.trim()) {
      zipEntries[`raw-text/${doc.id}.txt`] = encodeText(doc.rawText.trim());
    }
    for (let index = 0; index < (doc.images ?? []).length; index++) {
      const filename = qaImageFilename(doc.id, index, doc.images.length);
      const bytes = await readImageBytes(doc.images[index]);
      if (!bytes) throw new Error(`Immagine QA non leggibile: ${doc.id}/${index}`);
      zipEntries[`images/${filename}`] = bytes;
    }
    for (let index = 0; index < (doc.originalImages ?? []).length; index++) {
      const filename = qaImageFilename(doc.id, index, doc.originalImages!.length);
      const bytes = await readImageBytes(doc.originalImages![index]);
      if (!bytes) throw new Error(`Originale QA non leggibile: ${doc.id}/${index}`);
      zipEntries[`original-images/${filename}`] = bytes;
    }
    onProgress?.({ phase: 'images', current: i + 1, total });
    await yieldToMain();
  }

  onProgress?.({ phase: 'zip', current: total, total });
  const exportsDir = new Directory(Paths.document, 'qa-exports');
  if (!exportsDir.exists) exportsDir.create({ intermediates: true });
  const zipFile = new File(exportsDir, fileName);
  const zipped = zipSync(zipEntries, { level: 0 });
  zipFile.create();
  zipFile.write(zipped);
  const info = zipFile.info();
  return {
    zipPath: zipFile.uri,
    fileName,
    documentCount: documents.length,
    sizeBytes: info.exists && typeof info.size === 'number' ? info.size : zipped.length,
  };
}

export async function shareDocumentsQaZip(zipPath: string): Promise<boolean> {
  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) return false;
  try {
    await Sharing.shareAsync(zipPath, {
      mimeType: 'application/zip',
      dialogTitle: 'Export diagnostico',
      UTI: 'public.zip-archive',
    });
    return true;
  } catch {
    return false;
  }
}

export function isStoredDocument(doc: AnyDocument): doc is StoredDocument {
  return (
    doc.type === 'quote' ||
    doc.type === 'order' ||
    doc.type === 'invoice' ||
    doc.type === 'free_document'
  );
}

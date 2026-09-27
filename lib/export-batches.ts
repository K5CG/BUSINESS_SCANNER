import type { BusinessCard } from '../types';

export const EXPORT_BATCH_SIZE = 30;

export interface ExportBatch {
  /** Numero blocco (1-based). */
  index: number;
  /** Posizione primo biglietto nell'elenco app (1-based). */
  from: number;
  /** Posizione ultimo biglietto nell'elenco app (1-based). */
  to: number;
  contacts: BusinessCard[];
}

export function splitContactsIntoExportBatches(
  contacts: BusinessCard[],
  batchSize = EXPORT_BATCH_SIZE
): ExportBatch[] {
  if (contacts.length === 0) return [];

  const batches: ExportBatch[] = [];
  for (let start = 0; start < contacts.length; start += batchSize) {
    const slice = contacts.slice(start, start + batchSize);
    batches.push({
      index: batches.length + 1,
      from: start + 1,
      to: start + slice.length,
      contacts: slice,
    });
  }
  return batches;
}

export function formatExportBatchRange(from: number, to: number): string {
  return `${from}_${to}`;
}

export function formatExportBatchFileName(from: number, to: number, exportedAt: Date): string {
  const stamp = exportedAt.toISOString().replace(/[:.]/g, '-');
  return `qa-contacts-export_${formatExportBatchRange(from, to)}_${stamp}.zip`;
}

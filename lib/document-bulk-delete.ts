import type { DeletePersistenceResult } from './persistence';

export interface BulkDocumentDeleteFailure {
  id: string;
  error: unknown;
}

export interface BulkDocumentDeleteResult {
  requested: number;
  deletedIds: string[];
  failed: BulkDocumentDeleteFailure[];
  cleanupPendingIds: string[];
}

export async function deleteDocumentsIndividually(
  ids: readonly string[],
  remove: (id: string) => Promise<DeletePersistenceResult>,
  onProgress?: (current: number, total: number) => void,
): Promise<BulkDocumentDeleteResult> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const deletedIds: string[] = [];
  const failed: BulkDocumentDeleteFailure[] = [];
  const cleanupPendingIds: string[] = [];

  for (let index = 0; index < uniqueIds.length; index += 1) {
    const id = uniqueIds[index];
    try {
      const result = await remove(id);
      if (!result.deleted) {
        failed.push({ id, error: new Error('document_not_deleted') });
        continue;
      }
      deletedIds.push(id);
      if (result.cleanupPending) cleanupPendingIds.push(id);
    } catch (error) {
      failed.push({ id, error });
    } finally {
      onProgress?.(index + 1, uniqueIds.length);
    }
  }

  return { requested: uniqueIds.length, deletedIds, failed, cleanupPendingIds };
}

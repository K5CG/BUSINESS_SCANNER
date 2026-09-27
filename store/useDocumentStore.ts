import { create } from 'zustand';
import { AnyDocument } from '../types';
import { getAllDocuments } from '../lib/storage';
import {
  compensateCreatedDocumentWithAssets,
  createDocumentWithAssets,
  type DeletePersistenceResult,
  deleteDocumentWithAssets,
  updateDocumentWithAssetCleanup,
} from '../lib/persistence';
import {
  commitCreatedRecordIfActive,
  commitExistingRecordIfActive,
  isInactiveScanOperationError,
  runActiveOperationStep,
  type ActiveOperationGuard,
  withPersistenceRevision,
} from '../lib/scan-operation-lifecycle';
import {
  deleteDocumentsIndividually,
  type BulkDocumentDeleteResult,
} from '../lib/document-bulk-delete';
import {
  DocumentDuplicateCancelledError,
  DocumentDuplicateOpenExistingError,
  isDocumentDuplicateDecisionError,
  resolveDocumentDuplicate,
} from '../lib/document-duplicate-guard';

export {
  DocumentDuplicateCancelledError,
  DocumentDuplicateOpenExistingError,
};

interface DocumentStore {
  documents: AnyDocument[];
  currentDocument: AnyDocument | null;
  loading: boolean;
  error: string | null;

  loadDocuments: () => Promise<void>;
  addDocument: (
    document: AnyDocument,
    operation?: ActiveOperationGuard
  ) => Promise<AnyDocument>;
  updateDocument: (
    document: AnyDocument,
    operation?: ActiveOperationGuard
  ) => Promise<AnyDocument>;
  removeDocument: (
    id: string,
    operation?: ActiveOperationGuard
  ) => Promise<DeletePersistenceResult>;
  removeDocuments: (
    ids: readonly string[],
    onProgress?: (current: number, total: number) => void,
  ) => Promise<BulkDocumentDeleteResult>;
  setCurrentDocument: (document: AnyDocument | null) => void;
}

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  documents: [],
  currentDocument: null,
  loading: false,
  error: null,

  loadDocuments: async () => {
    set({ loading: true, error: null });
    try {
      const documents = await getAllDocuments();
      set({ documents, loading: false });
    } catch (error) {
      set({ error: 'Errore nel caricamento dei documenti', loading: false });
      throw error;
    }
  },

  addDocument: async (document, operation) => {
    try {
      const cached = get().documents;
      const existing = await runActiveOperationStep(operation, () =>
        cached.length > 0 ? Promise.resolve(cached) : getAllDocuments()
      );
      const resolution = await runActiveOperationStep(operation, () =>
        resolveDocumentDuplicate(document, {
          existing,
          excludeDocumentId: document.id,
        })
      );
      if (resolution.decision === 'cancel') {
        throw new DocumentDuplicateCancelledError();
      }
      if (resolution.decision === 'open_existing') {
        throw new DocumentDuplicateOpenExistingError(resolution.match.document.id);
      }
      const candidate = operation
        ? withPersistenceRevision(document, operation.operationId)
        : document;
      const publish = (persisted: AnyDocument) =>
        set((state) => ({
          documents: [
            persisted,
            ...state.documents.filter((item) => item.id !== persisted.id),
          ],
          error: null,
        }));
      if (!operation) {
        const persisted = await createDocumentWithAssets(candidate);
        publish(persisted);
        return persisted;
      }
      return await commitCreatedRecordIfActive({
        ...operation,
        compensationTarget: candidate,
        persist: () => createDocumentWithAssets(candidate),
        compensate: compensateCreatedDocumentWithAssets,
        publish,
      });
    } catch (error) {
      if (isInactiveScanOperationError(error)) throw error;
      if (isDocumentDuplicateDecisionError(error)) throw error;
      set({ error: 'Errore nel salvataggio del documento' });
      throw error;
    }
  },

  updateDocument: async (document, operation) => {
    try {
      const updatedBase = { ...document, updatedAt: new Date() };
      const updated = operation
        ? withPersistenceRevision(updatedBase, operation.operationId)
        : updatedBase;
      const publish = (persisted: AnyDocument) =>
        set((state) => ({
          documents: state.documents.map((d) =>
            d.id === persisted.id ? persisted : d
          ),
          error: null,
        }));
      if (!operation) {
        const persisted = await updateDocumentWithAssetCleanup(updated);
        publish(persisted);
        return persisted;
      }
      return await commitExistingRecordIfActive({
        ...operation,
        persist: () => updateDocumentWithAssetCleanup(updated),
        publish,
      });
    } catch (error) {
      if (isInactiveScanOperationError(error)) throw error;
      set({ error: "Errore nell'aggiornamento del documento" });
      throw error;
    }
  },

  removeDocument: async (id, operation) => {
    try {
      const publish = (result: DeletePersistenceResult) =>
        set((state) => ({
          documents: state.documents.filter((d) => d.id !== id),
          currentDocument:
            state.currentDocument?.id === id ? null : state.currentDocument,
          error: null,
        }));
      if (!operation) {
        const result = await deleteDocumentWithAssets(id);
        publish(result);
        return result;
      }
      return await commitExistingRecordIfActive({
        ...operation,
        persist: () => deleteDocumentWithAssets(id),
        publish,
      });
    } catch (error) {
      if (isInactiveScanOperationError(error)) throw error;
      set({ error: "Errore nell'eliminazione del documento" });
      throw error;
    }
  },

  removeDocuments: async (ids, onProgress) => {
    const result = await deleteDocumentsIndividually(ids, deleteDocumentWithAssets, onProgress);
    const deleted = new Set(result.deletedIds);
    set((state) => ({
      documents: state.documents.filter((document) => !deleted.has(document.id)),
      currentDocument: state.currentDocument && deleted.has(state.currentDocument.id)
        ? null
        : state.currentDocument,
      error: result.failed.length > 0 ? "Eliminazione parziale dei documenti" : null,
    }));
    return result;
  },

  setCurrentDocument: (document) => set({ currentDocument: document }),
}));

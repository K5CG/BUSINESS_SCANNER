import { create } from 'zustand';
import { BusinessCard } from '../types';
import { getAllContacts } from '../lib/storage';
import {
  compensateCreatedContactWithAssets,
  createContactWithAssets,
  type DeletePersistenceResult,
  deleteContactWithAssets,
  updateContactWithAssetCleanup,
} from '../lib/persistence';
import { rotateBusinessCardImagePage } from '../lib/contact-reparse';
import {
  guardBusinessCardDuplicate,
  DuplicateContactCancelledError,
  resolveBusinessCardDuplicate,
} from '../lib/duplicate-contact-guard';
import {
  planContactDuplicateResolution,
} from '../lib/contact-duplicate-resolution';
import { StaleContactUpdateError } from '../lib/contact-update-precondition';
import {
  commitCreatedRecordIfActive,
  commitExistingRecordIfActive,
  isInactiveScanOperationError,
  runActiveOperationStep,
  type ActiveOperationGuard,
  withPersistenceRevision,
} from '../lib/scan-operation-lifecycle';

export { DuplicateContactCancelledError };

export class DuplicateContactStaleError extends Error {
  constructor() {
    super('DUPLICATE_CONTACT_STALE');
    this.name = 'DuplicateContactStaleError';
  }
}

interface ContactStore {
  contacts: BusinessCard[];
  /** Biglietto in revisione dopo OCR — non ancora in rubrica finché l'utente non preme Salva. */
  draftContact: BusinessCard | null;
  loading: boolean;
  error: string | null;

  loadContacts: () => Promise<void>;
  setDraftContact: (contact: BusinessCard | null) => void;
  clearDraftContact: (expectedId?: string) => boolean;
  addContact: (
    contact: BusinessCard,
    operation?: ActiveOperationGuard
  ) => Promise<BusinessCard>;
  updateContact: (
    contact: BusinessCard,
    operation?: ActiveOperationGuard
  ) => Promise<BusinessCard>;
  rotateContactImagePage: (
    contact: BusinessCard,
    pageIndex: number,
    rotatedUri: string,
    operation?: ActiveOperationGuard
  ) => Promise<BusinessCard>;
  removeContact: (
    id: string,
    operation?: ActiveOperationGuard
  ) => Promise<DeletePersistenceResult>;
}

export const useContactStore = create<ContactStore>((set, get) => ({
  contacts: [],
  draftContact: null,
  loading: false,
  error: null,

  loadContacts: async () => {
    const hasCached = get().contacts.length > 0;
    if (!hasCached) {
      set({ loading: true, error: null });
    }
    try {
      const contacts = await getAllContacts();
      set({ contacts, loading: false, error: null });
    } catch (error) {
      set({ error: 'Errore nel caricamento dei contatti', loading: false });
      throw error;
    }
  },

  setDraftContact: (contact) => {
    set({ draftContact: contact, error: null });
  },

  clearDraftContact: (expectedId) => {
    let cleared = false;
    set((state) => {
      if (
        expectedId &&
        state.draftContact?.id !== expectedId
      ) {
        return state;
      }
      cleared = state.draftContact !== null;
      return { draftContact: null };
    });
    return cleared;
  },

  addContact: async (contact, operation) => {
    try {
      const cached = get().contacts;
      const existing = await runActiveOperationStep(operation, () =>
        cached.length > 0 ? Promise.resolve(cached) : getAllContacts()
      );
      const resolution = await runActiveOperationStep(operation, () =>
        resolveBusinessCardDuplicate(contact, undefined, existing)
      );
      if (resolution.decision === 'cancel') {
        throw new DuplicateContactCancelledError();
      }
      if (resolution.decision === 'update_existing') {
        if (resolution.selectedFields.length === 0) {
          throw new DuplicateContactCancelledError();
        }
        const plan = planContactDuplicateResolution({
          action: 'update_existing',
          existingContact: resolution.duplicate.contact,
          sourceDraft: contact,
          selectedFields: resolution.selectedFields,
        });
        if (plan.action !== 'update_existing') {
          throw new Error('Piano deduplica non coerente');
        }
        const updatedBase = {
          ...plan.plannedRecord,
          updatedAt: new Date(),
        };
        const updated = operation
          ? withPersistenceRevision(updatedBase, operation.operationId)
          : updatedBase;
        const publishUpdated = (persisted: BusinessCard) =>
          set((state) => ({
            contacts: state.contacts.some((item) => item.id === persisted.id)
              ? state.contacts.map((item) =>
                  item.id === persisted.id ? persisted : item
                )
              : [persisted, ...state.contacts],
            draftContact:
              state.draftContact?.id === contact.id
                ? null
                : state.draftContact,
            error: null,
          }));
        if (!operation) {
          const persisted = await updateContactWithAssetCleanup(updated, {
            expectedFingerprint: resolution.targetFingerprint,
          });
          publishUpdated(persisted);
          return persisted;
        }
        return await commitExistingRecordIfActive({
          ...operation,
          persist: () =>
            updateContactWithAssetCleanup(updated, {
              expectedFingerprint: resolution.targetFingerprint,
            }),
          publish: publishUpdated,
        });
      }
      const candidate = operation
        ? withPersistenceRevision(contact, operation.operationId)
        : contact;
      const publish = (persisted: BusinessCard) =>
        set((state) => ({
          contacts: [
            persisted,
            ...state.contacts.filter((c) => c.id !== persisted.id),
          ],
          draftContact:
            state.draftContact?.id === persisted.id
              ? null
              : state.draftContact,
          error: null,
        }));
      if (!operation) {
        const persisted = await createContactWithAssets(candidate);
        publish(persisted);
        return persisted;
      }
      return await commitCreatedRecordIfActive({
        ...operation,
        compensationTarget: candidate,
        persist: () => createContactWithAssets(candidate),
        compensate: compensateCreatedContactWithAssets,
        publish,
      });
    } catch (error) {
      if (error instanceof DuplicateContactCancelledError) {
        throw error;
      }
      if (error instanceof StaleContactUpdateError) {
        throw new DuplicateContactStaleError();
      }
      if (isInactiveScanOperationError(error)) throw error;
      set({ error: 'Errore nel salvataggio del contatto' });
      throw error;
    }
  },

  updateContact: async (contact, operation) => {
    try {
      const updatedBase = { ...contact, updatedAt: new Date() };
      const updated = operation
        ? withPersistenceRevision(updatedBase, operation.operationId)
        : updatedBase;
      const cached = get().contacts;
      const existing = await runActiveOperationStep(operation, () =>
        cached.length > 0 ? Promise.resolve(cached) : getAllContacts()
      );
      const allowed = await runActiveOperationStep(operation, () =>
        guardBusinessCardDuplicate(updated, updated.id, existing)
      );
      if (!allowed) {
        throw new DuplicateContactCancelledError();
      }
      const publish = (persisted: BusinessCard) =>
        set((state) => ({
          contacts: state.contacts.map((c) =>
            c.id === persisted.id ? persisted : c
          ),
          error: null,
        }));
      if (!operation) {
        const persisted = await updateContactWithAssetCleanup(updated);
        publish(persisted);
        return persisted;
      }
      return await commitExistingRecordIfActive({
        ...operation,
        persist: () => updateContactWithAssetCleanup(updated),
        publish,
      });
    } catch (error) {
      if (error instanceof DuplicateContactCancelledError) {
        throw error;
      }
      if (isInactiveScanOperationError(error)) throw error;
      set({ error: "Errore nell'aggiornamento del contatto" });
      throw error;
    }
  },

  rotateContactImagePage: async (
    contact,
    pageIndex,
    rotatedUri,
    operation
  ) => {
    try {
      const persist = () =>
        rotateBusinessCardImagePage(
          operation
            ? withPersistenceRevision(contact, operation.operationId)
            : contact,
          pageIndex,
          rotatedUri,
          async (candidate) => {
            const cached = get().contacts;
            const existing = await runActiveOperationStep(operation, () =>
              cached.length > 0 ? Promise.resolve(cached) : getAllContacts()
            );
            const allowed = await runActiveOperationStep(operation, () =>
              guardBusinessCardDuplicate(
                candidate,
                candidate.id,
                existing
              )
            );
            if (!allowed) throw new DuplicateContactCancelledError();
          }
        );
      const publish = (persisted: BusinessCard) =>
        set((state) => ({
          contacts: state.contacts.some((item) => item.id === persisted.id)
            ? state.contacts.map((item) =>
                item.id === persisted.id ? persisted : item
              )
            : [persisted, ...state.contacts],
          error: null,
        }));
      if (!operation) {
        const persisted = await persist();
        publish(persisted);
        return persisted;
      }
      return await commitExistingRecordIfActive({
        ...operation,
        persist,
        publish,
      });
    } catch (error) {
      if (error instanceof DuplicateContactCancelledError) throw error;
      if (isInactiveScanOperationError(error)) throw error;
      set({ error: "Errore nell'aggiornamento del contatto" });
      throw error;
    }
  },

  removeContact: async (id, operation) => {
    try {
      const publish = (result: DeletePersistenceResult) =>
        set((state) => ({
          contacts: state.contacts.filter((c) => c.id !== id),
          draftContact:
            state.draftContact?.id === id ? null : state.draftContact,
          error: null,
        }));
      if (!operation) {
        const result = await deleteContactWithAssets(id);
        publish(result);
        return result;
      }
      return await commitExistingRecordIfActive({
        ...operation,
        persist: () => deleteContactWithAssets(id),
        publish,
      });
    } catch (error) {
      if (isInactiveScanOperationError(error)) throw error;
      set({ error: "Errore nell'eliminazione del contatto" });
      throw error;
    }
  },
}));

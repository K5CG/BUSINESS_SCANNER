import type { AnyDocument, BusinessCard } from '../types';
import * as FileSystem from 'expo-file-system/legacy';
import {
  clearAllContacts,
  deleteContact,
  deleteDocument,
  ensureDatabaseReady,
  getAllContacts,
  getAllLiveAssetRecordsSnapshot,
  getContactById,
  getDocumentOnlyById,
  hasStoredContactPayload,
  hasStoredDocumentPayload,
  hasLegacyBusinessCardDocument,
  saveContact,
  saveDocument,
  type StoredLiveAssetRecord,
} from './storage';
import {
  finalContactPhotoUri,
  finalImageUris,
  finalizeStagedRecordDeletion,
  isPermanentRecordAssetUri,
  promoteStagedRecordAssets,
  recoverImageStorage,
  recoverImageStorageStagingOnly,
  recordAssetsDirectoryUri,
  removeUnreferencedManagedAssets,
  restoreStagedRecordDeletion,
  rollbackStagedRecordAssets,
  stageRecordAssets,
  stageRecordDirectoryForDeletion,
  stageRecordImagePage,
  type LiveAssetRecord,
  type StagedRecordAssets,
  type StagedRecordDeletion,
} from './image-storage';
import {
  runAssetDeleteSaga,
  runAssetBatchDeleteSaga,
  runAssetSaveSaga,
  type AssetDeleteResult,
} from './asset-persistence-core';
import { createAsyncMutex } from './async-mutex';
import {
  assertFreshAssetRevision,
  otherOwnerUsesDirectory,
  ownersOutsideConfirmedContactDeletion,
} from './asset-path-policy';
import { alignPageExtractionImageUris } from './document-page-extraction';
import { sanitizeBusinessCardEmailState } from './email-evidence';
import { hasSamePersistenceRevision } from './scan-operation-lifecycle';
import { prepareBusinessCardForPersistence } from './contact-review-state';
import { assertContactUpdatePrecondition } from './contact-update-precondition';
import {
  collectDocumentAssetUris,
  splitFinalDocumentAssetUris,
} from './document-asset-routing';
import { resolveImageUri } from './image-uri';

type RecordKind = 'contact' | 'document';

export interface DeletePersistenceResult extends AssetDeleteResult {
  deleted: boolean;
}

export interface ClearContactsPersistenceResult extends AssetDeleteResult {
  removed: number;
}

export interface CreatedRecordCompensationResult extends AssetDeleteResult {
  status: 'deleted' | 'already_absent' | 'superseded';
}

const persistenceMutex = createAsyncMutex();

async function runPersistenceOperation<T>(task: () => Promise<T>): Promise<T> {
  // initDatabase include il recovery single-flight: nessuna saga file puo
  // iniziare prima che lo stato precedente sia stato riconciliato.
  await ensureDatabaseReady();
  return persistenceMutex.runExclusive(task);
}

/**
 * Esegue una lettura dietro la stessa barriera globale delle saghe di
 * persistenza. Una schermata riaperta non può quindi osservare un record
 * precedente mentre un commit non interrompibile della vecchia istanza è
 * ancora in corso.
 */
export async function readAfterPersistenceSettles<T>(
  read: () => Promise<T>
): Promise<T> {
  return runPersistenceOperation(read);
}

function asLiveRecord(record: AnyDocument): LiveAssetRecord {
  if (
    typeof record.id !== 'string' ||
    !Array.isArray(record.images) ||
    record.images.some((uri) => typeof uri !== 'string')
  ) {
    throw new Error('Riferimenti immagini del record non validi');
  }
  const contactPhotoUri =
    record.type === 'business_card' ? (record as BusinessCard).contactPhotoUri : undefined;
  if (contactPhotoUri != null && typeof contactPhotoUri !== 'string') {
    throw new Error('Riferimento foto contatto non valido');
  }
  return {
    id: record.id,
    images: [...record.images, ...(record.originalImages ?? [])],
    contactPhotoUri,
  };
}

function withFinalContactAssets(
  contact: BusinessCard,
  token: StagedRecordAssets
): BusinessCard {
  const photoUri = finalContactPhotoUri(token);
  const routed = splitFinalDocumentAssetUris(
    finalImageUris(token),
    contact.images.length,
    Array.isArray(contact.originalImages),
  );
  const { contactPhotoUri: _temporaryPhoto, ...rest } = contact;
  return {
    ...rest,
    images: routed.images,
    ...(routed.originalImages ? { originalImages: routed.originalImages } : {}),
    ...(photoUri ? { contactPhotoUri: photoUri } : {}),
  };
}

/**
 * A displayed draft card must remain savable even if an old build already
 * removed its optional original OCR backup. New captures retain both assets;
 * this is a recovery boundary for historical drafts, not a silent substitute.
 */
async function withoutUnavailableContactOriginals(contact: BusinessCard): Promise<BusinessCard> {
  const originals = contact.originalImages ?? [];
  if (originals.length === 0) return contact;
  const availability = await Promise.all(
    originals.map(async (uri) => {
      try {
        return (await FileSystem.getInfoAsync(resolveImageUri(uri))).exists;
      } catch {
        return false;
      }
    })
  );
  if (availability.every(Boolean)) return contact;
  console.warn('[AssetPersistence] original_backups_unavailable_preserving_preview', {
    recordId: contact.id,
    originalCount: originals.length,
    unavailableCount: availability.filter((exists) => !exists).length,
  });
  const { originalImages: _discardedOriginals, ...previewOnly } = contact;
  return previewOnly;
}

function withFinalDocumentAssets(
  document: AnyDocument,
  token: StagedRecordAssets
): AnyDocument {
  const allFinal = finalImageUris(token);
  const pageCount = document.images.length;
  const routed = splitFinalDocumentAssetUris(
    allFinal,
    pageCount,
    Array.isArray(document.originalImages),
  );
  return withAlignedDocumentAssetUris(
    {
      ...document,
      ...(routed.originalImages ? { originalImages: routed.originalImages } : {}),
      ...(document.pageCaptureMetadata
        ? {
            pageCaptureMetadata: document.pageCaptureMetadata.map((metadata, index) => ({
              ...metadata,
              canonicalUri: routed.images[index] ?? metadata.canonicalUri,
              originalUri: routed.originalImages?.[index] ?? metadata.originalUri,
            })),
          }
        : {}),
    },
    routed.images
  );
}

/**
 * Helper puro usato nello stage della saga: immagini e diagnostica per-pagina
 * vengono preparate nello stesso candidato che sarà poi promosso e persistito.
 */
export function withAlignedDocumentAssetUris(
  document: AnyDocument,
  images: readonly string[]
): AnyDocument {
  const finalImages = [...images];
  return {
    ...document,
    images: finalImages,
    ...(document.pageExtractions
      ? {
          pageExtractions: alignPageExtractionImageUris(
            document.pageExtractions,
            finalImages
          ),
        }
      : {}),
  };
}

function requiresAssetMigration(record: AnyDocument): boolean {
  if (collectDocumentAssetUris(record).some((uri) => !isPermanentRecordAssetUri(uri, record.id))) {
    return true;
  }
  return (
    record.type === 'business_card' &&
    !!record.contactPhotoUri &&
    !isPermanentRecordAssetUri(record.contactPhotoUri, record.id)
  );
}

async function saveContactReconciled(contact: BusinessCard): Promise<void> {
  try {
    await saveContact(contact);
  } catch (error) {
    if (!(await hasStoredContactPayload(contact))) throw error;
  }
}

async function saveDocumentReconciled(document: AnyDocument): Promise<void> {
  try {
    await saveDocument(document);
  } catch (error) {
    if (!(await hasStoredDocumentPayload(document))) throw error;
  }
}

async function cleanupReplacedAssets(
  recordId: string,
  previous: LiveAssetRecord | null,
  next: LiveAssetRecord
): Promise<void> {
  if (!previous) return;
  // LiveAssetRecord espone già gli originali dentro images.
  const nextReferences = new Set([...next.images, next.contactPhotoUri].filter(Boolean));
  const candidates = [...previous.images, previous.contactPhotoUri].filter(
    (uri): uri is string => typeof uri === 'string' && !nextReferences.has(uri)
  );
  if (candidates.length === 0) return;

  try {
    const liveRecords = await getAllLiveAssetRecordsSnapshot();
    await removeUnreferencedManagedAssets(recordId, candidates, liveRecords);
  } catch {
    // Riferimenti incerti: preserva. Il prossimo recovery ritenta.
  }
}

async function createContactUnlocked(contact: BusinessCard): Promise<BusinessCard> {
  const savableContact = await withoutUnavailableContactOriginals(contact);
  let token: StagedRecordAssets | null = null;
  let persisted: BusinessCard | null = null;
  await runAssetSaveSaga({
    stage: async () => {
      token = await stageRecordAssets(
        savableContact.id,
        collectDocumentAssetUris(savableContact),
        savableContact.contactPhotoUri
      );
      persisted = withFinalContactAssets(savableContact, token);
    },
    promote: async () => {
      if (!token) throw new Error('Staging contatto mancante');
      await promoteStagedRecordAssets(token);
    },
    persist: async () => {
      if (!persisted) throw new Error('Contatto persistente mancante');
      await saveContact(persisted);
    },
    isPersisted: async () => !!persisted && hasStoredContactPayload(persisted),
    rollbackAssets: async () => {
      if (token) await rollbackStagedRecordAssets(token);
    },
  });
  if (!persisted) throw new Error('Salvataggio contatto incompleto');
  return persisted;
}

async function createDocumentUnlocked(document: AnyDocument): Promise<AnyDocument> {
  let token: StagedRecordAssets | null = null;
  let persisted: AnyDocument | null = null;
  await runAssetSaveSaga({
    stage: async () => {
      token = await stageRecordAssets(document.id, collectDocumentAssetUris(document));
      persisted = withFinalDocumentAssets(document, token);
    },
    promote: async () => {
      if (!token) throw new Error('Staging documento mancante');
      await promoteStagedRecordAssets(token);
    },
    persist: async () => {
      if (!persisted) throw new Error('Documento persistente mancante');
      await saveDocument(persisted);
    },
    isPersisted: async () => !!persisted && hasStoredDocumentPayload(persisted),
    rollbackAssets: async () => {
      if (token) await rollbackStagedRecordAssets(token);
    },
  });
  if (!persisted) throw new Error('Salvataggio documento incompleto');
  return persisted;
}

async function updateContactUnlocked(
  contact: BusinessCard,
  expectedFingerprint?: string
): Promise<BusinessCard> {
  const previous = await getContactById(contact.id);
  if (!previous) throw new Error('Contatto da aggiornare non trovato');
  assertContactUpdatePrecondition(previous, expectedFingerprint);
  let persisted = contact;

  if (requiresAssetMigration(contact)) {
    let token: StagedRecordAssets | null = null;
    await runAssetSaveSaga({
      stage: async () => {
        token = await stageRecordAssets(contact.id, collectDocumentAssetUris(contact), contact.contactPhotoUri);
        persisted = withFinalContactAssets(contact, token);
      },
      promote: async () => {
        if (!token) throw new Error('Staging aggiornamento contatto mancante');
        await promoteStagedRecordAssets(token);
      },
      persist: async () => saveContact(persisted),
      isPersisted: async () => hasStoredContactPayload(persisted),
      rollbackAssets: async () => {
        if (token) await rollbackStagedRecordAssets(token);
      },
    });
  } else {
    await saveContactReconciled(contact);
  }

  await cleanupReplacedAssets(
    contact.id,
    previous ? asLiveRecord(previous) : null,
    asLiveRecord(persisted)
  );
  return persisted;
}

async function updateDocumentUnlocked(document: AnyDocument): Promise<AnyDocument> {
  const previous = await getDocumentOnlyById(document.id);
  if (!previous) throw new Error('Documento da aggiornare non trovato');
  let persisted = document;

  if (requiresAssetMigration(document)) {
    let token: StagedRecordAssets | null = null;
    await runAssetSaveSaga({
      stage: async () => {
        token = await stageRecordAssets(document.id, collectDocumentAssetUris(document));
        persisted = withFinalDocumentAssets(document, token);
      },
      promote: async () => {
        if (!token) throw new Error('Staging aggiornamento documento mancante');
        await promoteStagedRecordAssets(token);
      },
      persist: async () => saveDocument(persisted),
      isPersisted: async () => hasStoredDocumentPayload(persisted),
      rollbackAssets: async () => {
        if (token) await rollbackStagedRecordAssets(token);
      },
    });
  } else {
    await saveDocumentReconciled(document);
  }

  await cleanupReplacedAssets(
    document.id,
    previous ? asLiveRecord(previous) : null,
    asLiveRecord(persisted)
  );
  return persisted;
}

export async function createContactWithAssets(contact: BusinessCard): Promise<BusinessCard> {
  const safeContact = prepareBusinessCardForPersistence(
    sanitizeBusinessCardEmailState(contact)
  );
  return runPersistenceOperation(() => createContactUnlocked(safeContact));
}

export async function createDocumentWithAssets(document: AnyDocument): Promise<AnyDocument> {
  return runPersistenceOperation(() => createDocumentUnlocked(document));
}

export async function updateContactWithAssetCleanup(
  contact: BusinessCard,
  options: { expectedFingerprint?: string } = {}
): Promise<BusinessCard> {
  const safeContact = prepareBusinessCardForPersistence(
    sanitizeBusinessCardEmailState(contact)
  );
  return runPersistenceOperation(() =>
    updateContactUnlocked(safeContact, options.expectedFingerprint)
  );
}

export async function updateDocumentWithAssetCleanup(
  document: AnyDocument
): Promise<AnyDocument> {
  return runPersistenceOperation(() => updateDocumentUnlocked(document));
}

function shouldPreserveDirectoryFromSnapshot(
  snapshot: readonly StoredLiveAssetRecord[],
  kind: RecordKind,
  recordId: string
): boolean {
  try {
    const effectiveSnapshot =
      kind === 'contact'
        ? snapshot.filter(
            (record) =>
              !(
                record.owner === 'document' &&
                record.recordType === 'business_card' &&
                record.id === recordId
              )
          )
        : snapshot;
    return otherOwnerUsesDirectory(
      effectiveSnapshot,
      kind,
      recordId,
      recordAssetsDirectoryUri(recordId)
    );
  } catch {
    return true;
  }
}

function snapshotRecordIsDeleteTarget(
  record: StoredLiveAssetRecord,
  kind: RecordKind,
  recordId: string
): boolean {
  if (record.id !== recordId) return false;
  if (record.owner === kind) return true;
  return (
    kind === 'contact' &&
    record.owner === 'document' &&
    record.recordType === 'business_card'
  );
}

function assetReferencesOf(records: readonly LiveAssetRecord[]): string[] {
  return records.flatMap((record) =>
    [...record.images, record.contactPhotoUri].filter(
      (uri): uri is string => typeof uri === 'string' && !!uri.trim()
    )
  );
}

async function deleteRecordUnlocked(
  kind: RecordKind,
  recordId: string
): Promise<DeletePersistenceResult> {
  const existing =
    kind === 'contact'
      ? await getContactById(recordId)
      : await getDocumentOnlyById(recordId);
  if (!existing) {
    return { deleted: false, cleanupPending: false };
  }

  let snapshot: StoredLiveAssetRecord[] = [];
  let preserveAssets = true;
  let preservationUncertain = false;
  let targetAssetReferences: string[] = [];
  try {
    snapshot = await getAllLiveAssetRecordsSnapshot();
    targetAssetReferences = assetReferencesOf(
      snapshot.filter((record) =>
        snapshotRecordIsDeleteTarget(record, kind, recordId)
      )
    );
    preserveAssets = shouldPreserveDirectoryFromSnapshot(snapshot, kind, recordId);
  } catch {
    // Il record puo essere eliminato, ma asset incerti non vengono toccati.
    preservationUncertain = true;
  }
  let deletion: StagedRecordDeletion | null = null;

  const result = await runAssetDeleteSaga({
    stageAssets: async () => {
      if (!preserveAssets) {
        deletion = await stageRecordDirectoryForDeletion(recordId);
      }
    },
    deleteRecord: async () => {
      if (kind === 'contact') await deleteContact(recordId);
      else await deleteDocument(recordId);
    },
    isDeleted: async () =>
      kind === 'contact'
        ? (await getContactById(recordId)) == null &&
          !(await hasLegacyBusinessCardDocument(recordId))
        : (await getDocumentOnlyById(recordId)) == null,
    restoreAssets: async () => restoreStagedRecordDeletion(deletion),
    finalizeAssets: async () => finalizeStagedRecordDeletion(deletion),
  });
  let cleanupPending = result.cleanupPending || preservationUncertain;
  if (preserveAssets && !preservationUncertain && targetAssetReferences.length > 0) {
    try {
      const liveAfterDelete = await getAllLiveAssetRecordsSnapshot();
      const complete = await removeUnreferencedManagedAssets(
        recordId,
        targetAssetReferences,
        liveAfterDelete
      );
      cleanupPending ||= !complete;
    } catch {
      cleanupPending = true;
    }
  }
  return {
    deleted: true,
    cleanupPending,
  };
}

export async function deleteContactWithAssets(
  recordId: string
): Promise<DeletePersistenceResult> {
  return runPersistenceOperation(() => deleteRecordUnlocked('contact', recordId));
}

export async function deleteDocumentWithAssets(
  recordId: string
): Promise<DeletePersistenceResult> {
  return runPersistenceOperation(() => deleteRecordUnlocked('document', recordId));
}

async function compensateCreatedRecordUnlocked(
  kind: RecordKind,
  expected: AnyDocument
): Promise<CreatedRecordCompensationResult> {
  const current =
    kind === 'contact'
      ? await getContactById(expected.id)
      : await getDocumentOnlyById(expected.id);

  if (!current) {
    return { status: 'already_absent', cleanupPending: false };
  }
  if (!hasSamePersistenceRevision(current, expected)) {
    // Un retry o una modifica successiva possiede ormai il record. La
    // compensazione dell'operazione vecchia non deve cancellarlo.
    return { status: 'superseded', cleanupPending: false };
  }

  const deletion = await deleteRecordUnlocked(kind, expected.id);
  return {
    status: deletion.deleted ? 'deleted' : 'already_absent',
    cleanupPending: deletion.cleanupPending,
  };
}

export async function compensateCreatedContactWithAssets(
  contact: BusinessCard
): Promise<CreatedRecordCompensationResult> {
  return runPersistenceOperation(() =>
    compensateCreatedRecordUnlocked('contact', contact)
  );
}

export async function compensateCreatedDocumentWithAssets(
  document: AnyDocument
): Promise<CreatedRecordCompensationResult> {
  return runPersistenceOperation(() =>
    compensateCreatedRecordUnlocked('document', document)
  );
}

async function clearAllContactsUnlocked(): Promise<ClearContactsPersistenceResult> {
  const contacts = await getAllContacts();
  if (contacts.length === 0) return { removed: 0, cleanupPending: false };
  // Snapshot fail-closed, incluse righe document legacy nascoste alla UI.
  const snapshot = await getAllLiveAssetRecordsSnapshot();
  const targetIds = new Set(contacts.map((contact) => contact.id));
  const externalOwners = ownersOutsideConfirmedContactDeletion(snapshot, targetIds);
  const candidatesById = new Map<string, string[]>();
  for (const recordId of targetIds) {
    candidatesById.set(
      recordId,
      assetReferencesOf(
        snapshot.filter((record) =>
          snapshotRecordIsDeleteTarget(record, 'contact', recordId)
        )
      )
    );
  }
  const preservedIds = new Set<string>();
  const uncertainPreservedIds = new Set<string>();
  const result = await runAssetBatchDeleteSaga({
    items: [...targetIds],
    stageItem: async (recordId) => {
      let preserve = true;
      try {
        preserve = otherOwnerUsesDirectory(
          externalOwners,
          'contact',
          recordId,
          recordAssetsDirectoryUri(recordId)
        );
      } catch {
        preserve = true;
        uncertainPreservedIds.add(recordId);
      }
      if (preserve) preservedIds.add(recordId);
      return preserve ? null : stageRecordDirectoryForDeletion(recordId);
    },
    deleteRecords: async () => {
      await clearAllContacts([...targetIds]);
    },
    areDeleted: async () =>
      (
        await Promise.all(
          [...targetIds].map(async (id) => ({
            contact: await getContactById(id),
            legacy: await hasLegacyBusinessCardDocument(id),
          }))
        )
      ).every(({ contact, legacy }) => contact == null && !legacy),
    restoreItem: restoreStagedRecordDeletion,
    finalizeItem: finalizeStagedRecordDeletion,
  });
  let cleanupPending = result.cleanupPending || uncertainPreservedIds.size > 0;
  if (preservedIds.size > uncertainPreservedIds.size) {
    try {
      const liveAfterDelete = await getAllLiveAssetRecordsSnapshot();
      for (const recordId of preservedIds) {
        if (uncertainPreservedIds.has(recordId)) continue;
        const complete = await removeUnreferencedManagedAssets(
          recordId,
          candidatesById.get(recordId) ?? [],
          liveAfterDelete
        );
        cleanupPending ||= !complete;
      }
    } catch {
      cleanupPending = true;
    }
  }
  return { removed: contacts.length, cleanupPending };
}

export async function clearAllContactsWithAssets(): Promise<ClearContactsPersistenceResult> {
  return runPersistenceOperation(clearAllContactsUnlocked);
}

export async function recoverPersistenceAssets(): Promise<void> {
  await ensureDatabaseReady();
  await persistenceMutex.runExclusive(async () => {
    try {
      await recoverImageStorage(await getAllLiveAssetRecordsSnapshot());
    } catch {
      await recoverImageStorageStagingOnly();
    }
  });
}

export type PrepareRotatedContact = (contactWithStagedPage: BusinessCard) => Promise<BusinessCard>;
export type ValidateRotatedContact = (candidate: BusinessCard) => Promise<void>;

export async function replaceSavedContactImagePage(
  card: BusinessCard,
  pageIndex: number,
  rotatedUri: string,
  prepare: PrepareRotatedContact,
  validate?: ValidateRotatedContact
): Promise<BusinessCard> {
  return runPersistenceOperation(async () => {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= card.images.length) {
      throw new Error('Indice pagina da ruotare non valido');
    }
    const previous = await getContactById(card.id);
    if (!previous) throw new Error('Contatto da ruotare non trovato');
    assertFreshAssetRevision(previous, card);

    let token: StagedRecordAssets | null = null;
    let candidate: BusinessCard | null = null;
    await runAssetSaveSaga({
      stage: async () => {
        token = await stageRecordImagePage(card.id, pageIndex, rotatedUri);
        const stagedUri = token.assets[0]?.stagedUri;
        const finalUri = token.assets[0]?.finalUri;
        if (!stagedUri || !finalUri) throw new Error('Staging rotazione incompleto');
        const stagedImages = [...card.images];
        stagedImages[pageIndex] = stagedUri;
        const prepared = await prepare({ ...card, images: stagedImages });
        if (
          prepared.id !== card.id ||
          prepared.type !== 'business_card' ||
          prepared.contactPhotoUri !== card.contactPhotoUri ||
          !Array.isArray(prepared.images) ||
          prepared.images.length !== card.images.length ||
          prepared.images.some((uri) => typeof uri !== 'string') ||
          prepared.images.some(
            (uri, index) => index !== pageIndex && uri !== stagedImages[index]
          )
        ) {
          throw new Error('Risultato OCR rotazione non valido');
        }
        const finalImages = [...prepared.images];
        finalImages[pageIndex] = finalUri;
        candidate = prepareBusinessCardForPersistence(
          sanitizeBusinessCardEmailState({
            ...prepared,
            images: finalImages,
          })
        );
        if (validate) await validate(candidate);
      },
      promote: async () => {
        if (!token) throw new Error('Staging rotazione mancante');
        await promoteStagedRecordAssets(token);
      },
      persist: async () => {
        if (!candidate) throw new Error('Contatto ruotato mancante');
        await saveContact(candidate);
      },
      isPersisted: async () => !!candidate && hasStoredContactPayload(candidate),
      rollbackAssets: async () => {
        if (token) await rollbackStagedRecordAssets(token);
      },
    });

    if (!candidate) throw new Error('Rotazione contatto incompleta');
    await cleanupReplacedAssets(card.id, asLiveRecord(previous), asLiveRecord(candidate));
    return candidate;
  });
}

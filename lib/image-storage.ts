import * as FileSystem from 'expo-file-system/legacy';
import { resolveImageUri } from './image-uri';
import { createId } from './id';
import {
  assertAssetTokenPaths,
  assertDeletionTokenPaths,
  isManagedAssetFileName,
  isSafeUuid,
  normalizeAssetReferenceForScansRoot,
  ownerReferencesAllowPerFileSweep,
  selectOrphanRecordDirectoryUris,
  selectUnreferencedManagedAssetUris,
} from './asset-path-policy';

export interface StagedAsset {
  sourceUri: string;
  stagedUri: string;
  finalUri: string;
  pageIndex?: number;
  kind: 'page' | 'contact-photo';
}

export interface StagedRecordAssets {
  recordId: string;
  operationId: string;
  stagingDirectoryUri: string;
  finalDirectoryUri: string;
  assets: StagedAsset[];
}

export interface StagedRecordDeletion {
  recordId: string;
  operationId: string;
  originalDirectoryUri: string;
  trashedDirectoryUri: string;
}

export interface LiveAssetRecord {
  id: string;
  images: readonly string[];
  contactPhotoUri?: string;
}

const issuedAssetTokens = new WeakSet<StagedRecordAssets>();
const issuedDeletionTokens = new WeakSet<StagedRecordDeletion>();
const promotedAssetsByToken = new WeakMap<StagedRecordAssets, Set<string>>();

function requireDocumentDirectory(): string {
  const root = FileSystem.documentDirectory;
  if (!root) {
    throw new Error('Storage permanente non disponibile');
  }
  return root;
}

function assertSafeRecordId(recordId: string): void {
  // Tutti i record creati dall'app usano createId() (UUID v4). La stessa
  // regola rende deterministico e sicuro anche lo sweep degli orfani.
  if (!isSafeUuid(recordId)) {
    throw new Error('ID record non valido per lo storage immagini');
  }
}

function assertPageIndex(pageIndex: number): void {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error('Indice pagina non valido');
  }
}

function createOperationId(): string {
  return createId();
}

function scansRootUri(): string {
  return `${requireDocumentDirectory()}scans/`;
}

export function recordAssetsDirectoryUri(recordId: string): string {
  assertSafeRecordId(recordId);
  return `${scansRootUri()}${recordId}/`;
}

export function resolvePersistedAssetUri(uri: string): string {
  const normalized = resolveImageUri(uri);
  try {
    return normalizeAssetReferenceForScansRoot(normalized, scansRootUri());
  } catch {
    return normalized;
  }
}

function stagingRootUri(): string {
  return `${scansRootUri()}.staging/`;
}

function trashRootUri(): string {
  return `${scansRootUri()}.trash/`;
}

async function pathExists(uri: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists;
}

async function removeIdempotently(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

function validateAssetToken(token: StagedRecordAssets): void {
  assertAssetTokenPaths(scansRootUri(), token);
  if (!issuedAssetTokens.has(token)) throw new Error('Token asset non emesso');
}

function validateDeletionToken(token: StagedRecordDeletion): void {
  assertDeletionTokenPaths(scansRootUri(), token);
  if (!issuedDeletionTokens.has(token)) throw new Error('Token eliminazione non emesso');
}

function normalizedSourceUri(sourceUri: string): string {
  const resolved = resolveImageUri(sourceUri.trim());
  if (!resolved) throw new Error('URI immagine sorgente mancante');
  return resolved;
}

/**
 * Copia tutte le sorgenti in staging. Ogni fallimento e fatale: non vengono
 * mai restituiti URI temporanei/content come se fossero asset permanenti.
 */
export async function stageRecordAssets(
  recordId: string,
  sourceImages: readonly string[],
  sourceContactPhotoUri?: string
): Promise<StagedRecordAssets> {
  assertSafeRecordId(recordId);
  const operationId = createOperationId();
  const stagingDirectoryUri = `${stagingRootUri()}${operationId}/`;
  const finalDirectoryUri = recordAssetsDirectoryUri(recordId);
  const assets: StagedAsset[] = [];

  sourceImages.forEach((_source, pageIndex) => {
    assertPageIndex(pageIndex);
    assets.push({
      kind: 'page',
      pageIndex,
      sourceUri: normalizedSourceUri(sourceImages[pageIndex]!),
      stagedUri: `${stagingDirectoryUri}page-${pageIndex}.jpg`,
      finalUri: `${finalDirectoryUri}page-${pageIndex}-${operationId}.jpg`,
    });
  });

  if (sourceContactPhotoUri?.trim()) {
    assets.push({
      kind: 'contact-photo',
      sourceUri: normalizedSourceUri(sourceContactPhotoUri),
      stagedUri: `${stagingDirectoryUri}contact-photo.jpg`,
      finalUri: `${finalDirectoryUri}contact-photo-${operationId}.jpg`,
    });
  }

  const token: StagedRecordAssets = {
    recordId,
    operationId,
    stagingDirectoryUri,
    finalDirectoryUri,
    assets,
  };
  issuedAssetTokens.add(token);
  promotedAssetsByToken.set(token, new Set());

  if (assets.length === 0) return token;

  if (await pathExists(stagingDirectoryUri)) {
    throw new Error('Collisione operation ID nello staging');
  }
  let stagingCreated = false;
  try {
    await FileSystem.makeDirectoryAsync(stagingDirectoryUri, { intermediates: true });
    stagingCreated = true;
    for (const asset of assets) {
      try {
        await FileSystem.copyAsync({ from: asset.sourceUri, to: asset.stagedUri });
      } catch (error) {
        // Diagnostica strutturale: non espone OCR o dati del biglietto, ma
        // identifica con certezza lo stadio e la pagina che non si e copiata.
        console.warn('[AssetPersistence] stage_copy_failed', {
          recordId,
          kind: asset.kind,
          pageIndex: asset.pageIndex ?? null,
          sourceScheme: asset.sourceUri.split(':', 1)[0] ?? 'unknown',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    return token;
  } catch (error) {
    if (stagingCreated) {
      try {
        await removeIdempotently(stagingDirectoryUri);
      } catch {
        // Il recovery startup ritenta la pulizia dello staging.
      }
    }
    throw new Error('Copia immagini nello staging fallita', { cause: error });
  }
}

/** Staging versionato di una sola pagina (rotazione di un record gia salvato). */
export async function stageRecordImagePage(
  recordId: string,
  pageIndex: number,
  sourceUri: string
): Promise<StagedRecordAssets> {
  assertSafeRecordId(recordId);
  assertPageIndex(pageIndex);
  const operationId = createOperationId();
  const stagingDirectoryUri = `${stagingRootUri()}${operationId}/`;
  const finalDirectoryUri = recordAssetsDirectoryUri(recordId);
  const asset: StagedAsset = {
    kind: 'page',
    pageIndex,
    sourceUri: normalizedSourceUri(sourceUri),
    stagedUri: `${stagingDirectoryUri}page-${pageIndex}.jpg`,
    finalUri: `${finalDirectoryUri}page-${pageIndex}-${operationId}.jpg`,
  };
  const token: StagedRecordAssets = {
    recordId,
    operationId,
    stagingDirectoryUri,
    finalDirectoryUri,
    assets: [asset],
  };
  issuedAssetTokens.add(token);
  promotedAssetsByToken.set(token, new Set());

  if (await pathExists(stagingDirectoryUri)) {
    throw new Error('Collisione operation ID nello staging');
  }
  let stagingCreated = false;
  try {
    await FileSystem.makeDirectoryAsync(stagingDirectoryUri, { intermediates: true });
    stagingCreated = true;
    await FileSystem.copyAsync({ from: asset.sourceUri, to: asset.stagedUri });
    return token;
  } catch (error) {
    if (stagingCreated) {
      try {
        await removeIdempotently(stagingDirectoryUri);
      } catch {
        // Recovery startup.
      }
    }
    throw new Error('Copia pagina nello staging fallita', { cause: error });
  }
}

/**
 * Promuove file versionati senza sovrascrivere asset esistenti.
 */
export async function promoteStagedRecordAssets(token: StagedRecordAssets): Promise<void> {
  validateAssetToken(token);
  if (token.assets.length === 0) return;

  const promoted: string[] = [];
  const ownedPromoted = promotedAssetsByToken.get(token)!;
  try {
    await FileSystem.makeDirectoryAsync(token.finalDirectoryUri, { intermediates: true });
    for (const asset of token.assets) {
      if (await pathExists(asset.finalUri)) {
        throw new Error(`Collisione asset finale: ${asset.finalUri}`);
      }
      await FileSystem.moveAsync({ from: asset.stagedUri, to: asset.finalUri });
      promoted.push(asset.finalUri);
      ownedPromoted.add(asset.finalUri);
    }
    await removeIdempotently(token.stagingDirectoryUri);
  } catch (error) {
    for (const finalUri of promoted) {
      try {
        await removeIdempotently(finalUri);
        ownedPromoted.delete(finalUri);
      } catch {
        // Recovery elimina eventuali versioni non referenziate.
      }
    }
    try {
      await removeIdempotently(token.stagingDirectoryUri);
    } catch {
      // Recovery startup.
    }
    throw new Error('Promozione immagini fallita', { cause: error });
  }
}

export async function rollbackStagedRecordAssets(token: StagedRecordAssets): Promise<void> {
  validateAssetToken(token);

  const failures: unknown[] = [];
  const ownedPromoted = promotedAssetsByToken.get(token) ?? new Set<string>();
  for (const finalUri of ownedPromoted) {
    try {
      await removeIdempotently(finalUri);
      ownedPromoted.delete(finalUri);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await removeIdempotently(token.stagingDirectoryUri);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new Error('Rollback immagini incompleto', { cause: failures[0] });
  }
}

export function finalImageUris(token: StagedRecordAssets): string[] {
  validateAssetToken(token);
  return token.assets
    .filter((asset) => asset.kind === 'page')
    .sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0))
    .map((asset) => asset.finalUri);
}

export function finalContactPhotoUri(token: StagedRecordAssets): string | undefined {
  validateAssetToken(token);
  return token.assets.find((asset) => asset.kind === 'contact-photo')?.finalUri;
}

export function recordReferencesPromotedAssets(
  record: LiveAssetRecord | null,
  token: StagedRecordAssets
): boolean {
  validateAssetToken(token);
  if (!record || record.id !== token.recordId) return false;
  const expectedImages = finalImageUris(token);
  if (
    record.images.length !== expectedImages.length ||
    record.images.some((uri, index) => uri !== expectedImages[index])
  ) {
    return false;
  }
  return record.contactPhotoUri === finalContactPhotoUri(token);
}

export function recordReferencesEveryPromotedAsset(
  record: LiveAssetRecord | null,
  token: StagedRecordAssets
): boolean {
  validateAssetToken(token);
  if (!record || record.id !== token.recordId) return false;
  return token.assets.every((asset) => {
    if (asset.kind === 'contact-photo') {
      return record.contactPhotoUri === asset.finalUri;
    }
    return record.images[asset.pageIndex ?? -1] === asset.finalUri;
  });
}

export async function stageRecordDirectoryForDeletion(
  recordId: string
): Promise<StagedRecordDeletion | null> {
  assertSafeRecordId(recordId);
  const originalDirectoryUri = recordAssetsDirectoryUri(recordId);
  if (!(await pathExists(originalDirectoryUri))) return null;

  const operationId = createOperationId();
  const recordTrashRoot = `${trashRootUri()}${recordId}/`;
  const trashedDirectoryUri = `${recordTrashRoot}${operationId}/`;
  if (await pathExists(trashedDirectoryUri)) {
    throw new Error('Collisione operation ID nel cestino');
  }
  await FileSystem.makeDirectoryAsync(recordTrashRoot, { intermediates: true });
  const token: StagedRecordDeletion = {
    recordId,
    operationId,
    originalDirectoryUri,
    trashedDirectoryUri,
  };
  issuedDeletionTokens.add(token);
  try {
    await FileSystem.moveAsync({ from: originalDirectoryUri, to: trashedDirectoryUri });
    return token;
  } catch (error) {
    // moveAsync puo avere esito ambiguo: se lo spostamento e avvenuto,
    // ripristina subito per non lasciare un record vivo senza immagini.
    try {
      if (
        (await pathExists(trashedDirectoryUri)) &&
        !(await pathExists(originalDirectoryUri))
      ) {
        await FileSystem.moveAsync({
          from: trashedDirectoryUri,
          to: originalDirectoryUri,
        });
      }
    } catch {
      // Il recovery vede il record ancora vivo e ritenta il ripristino.
    }
    throw error;
  }
}

export async function restoreStagedRecordDeletion(
  token: StagedRecordDeletion | null
): Promise<void> {
  if (!token) return;
  validateDeletionToken(token);
  if (!(await pathExists(token.trashedDirectoryUri))) return;
  if (await pathExists(token.originalDirectoryUri)) {
    throw new Error('Ripristino immagini non sicuro: directory finale gia presente');
  }
  await FileSystem.moveAsync({
    from: token.trashedDirectoryUri,
    to: token.originalDirectoryUri,
  });
}

export async function finalizeStagedRecordDeletion(
  token: StagedRecordDeletion | null
): Promise<void> {
  if (!token) return;
  validateDeletionToken(token);
  await removeIdempotently(token.trashedDirectoryUri);
}

export function isReferenceInsideRecordDirectory(uri: string, recordId: string): boolean {
  if (typeof uri !== 'string' || !uri.trim()) return false;
  try {
    return normalizeAssetReferenceForScansRoot(
      resolveImageUri(uri.trim()),
      scansRootUri()
    ).startsWith(recordAssetsDirectoryUri(recordId));
  } catch {
    return false;
  }
}

export function isPermanentRecordAssetUri(uri: string, recordId: string): boolean {
  if (typeof uri !== 'string' || !uri.trim()) return false;
  try {
    const directory = recordAssetsDirectoryUri(recordId);
    const normalized = resolveImageUri(uri.trim());
    if (!normalized.startsWith(directory)) return false;
    const name = normalized.slice(directory.length);
    if (!name || name.includes('/') || name.includes('\\')) return false;
    return (
      isManagedAssetFileName(name)
    );
  } catch {
    return false;
  }
}

export function hasReferenceInsideRecordDirectory(
  records: readonly LiveAssetRecord[],
  recordId: string
): boolean {
  return records.some((record) => {
    const refs = [...record.images, record.contactPhotoUri].filter(
      (value): value is string => typeof value === 'string'
    );
    return refs.some((uri) => isReferenceInsideRecordDirectory(uri, recordId));
  });
}

export async function removeUnreferencedManagedAssets(
  recordId: string,
  candidateUris: readonly string[],
  liveRecords: readonly LiveAssetRecord[]
): Promise<boolean> {
  const directory = recordAssetsDirectoryUri(recordId);
  const liveReferences = collectLiveReferences(liveRecords);
  let complete = true;
  for (const candidate of candidateUris) {
    if (typeof candidate !== 'string') continue;
    const normalized = resolvePersistedAssetUri(candidate.trim());
    if (!normalized.startsWith(directory) || liveReferences.has(normalized)) continue;
    const name = normalized.slice(directory.length);
    if (name.includes('/') || !isManagedAssetFileName(name)) continue;
    try {
      await removeIdempotently(normalized);
    } catch {
      // Recovery startup elimina la versione non referenziata.
      complete = false;
    }
  }
  return complete;
}

function collectLiveReferences(records: readonly LiveAssetRecord[]): Set<string> {
  const result = new Set<string>();
  const root = scansRootUri();
  for (const record of records) {
    for (const uri of record.images) {
      if (typeof uri === 'string' && uri.trim()) {
        result.add(
          normalizeAssetReferenceForScansRoot(resolveImageUri(uri.trim()), root)
        );
      }
    }
    if (typeof record.contactPhotoUri === 'string' && record.contactPhotoUri.trim()) {
      result.add(
        normalizeAssetReferenceForScansRoot(
          resolveImageUri(record.contactPhotoUri.trim()),
          root
        )
      );
    }
  }
  return result;
}

async function recoverTrash(
  records: readonly LiveAssetRecord[],
  references: ReadonlySet<string>
): Promise<void> {
  const root = trashRootUri();
  let recordIds: string[];
  try {
    recordIds = await FileSystem.readDirectoryAsync(root);
  } catch {
    return;
  }

  const liveIds = new Set(records.map((record) => record.id));
  for (const recordId of recordIds) {
    if (!isSafeUuid(recordId)) continue;
    const originalDirectory = recordAssetsDirectoryUri(recordId);
    const referenced =
      liveIds.has(recordId) ||
      [...references].some((uri) => uri.startsWith(originalDirectory));
    const recordTrash = `${root}${recordId}/`;
    if (!referenced) {
      try {
        await removeIdempotently(recordTrash);
      } catch {
        // Ritentato al prossimo avvio.
      }
      continue;
    }

    let operations: string[];
    try {
      operations = await FileSystem.readDirectoryAsync(recordTrash);
    } catch {
      continue;
    }
    if (await pathExists(originalDirectory)) {
      // Non possiamo provare quale directory contenga tutti i file vivi:
      // preserva il trash anziche rischiare una perdita.
      continue;
    }
    if (operations.length !== 1 || !isSafeUuid(operations[0]!)) {
      continue;
    }
    try {
      await FileSystem.moveAsync({
        from: `${recordTrash}${operations[0]}/`,
        to: originalDirectory,
      });
    } catch {
      // Stato incerto: preserva per il prossimo recovery.
    }
  }
}

async function recoverFinalDirectories(
  records: readonly LiveAssetRecord[],
  references: ReadonlySet<string>
): Promise<void> {
  const root = scansRootUri();
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(root);
  } catch {
    return;
  }
  const liveIds = new Set(records.map((record) => record.id));
  const orphanDirectories = new Set(
    selectOrphanRecordDirectoryUris(root, names, liveIds, references)
  );

  for (const name of names) {
    if (name === '.staging' || name === '.trash' || !isSafeUuid(name)) continue;
    const directory = recordAssetsDirectoryUri(name);

    if (orphanDirectories.has(directory)) {
      try {
        await removeIdempotently(directory);
      } catch {
        // Ritentato al prossimo avvio.
      }
      continue;
    }

    let assetNames: string[];
    try {
      assetNames = await FileSystem.readDirectoryAsync(directory);
    } catch {
      // Listing incerto: preserva l'intera directory.
      continue;
    }
    if (!ownerReferencesAllowPerFileSweep(records, name, directory)) {
      // URI temp, vecchia sandbox o payload incoerente: non dedurre che i
      // file locali siano orfani.
      continue;
    }
    for (const uri of selectUnreferencedManagedAssetUris(
      directory,
      assetNames,
      references
    )) {
      try {
        await removeIdempotently(uri);
      } catch {
        // Ritentato al prossimo avvio.
      }
    }
  }
}

/**
 * Recovery idempotente. Il chiamante deve invocarlo solo dopo aver letto con
 * successo tutti i record: se il parsing DB e incerto, non deve chiamarlo.
 */
export async function recoverImageStorage(records: readonly LiveAssetRecord[]): Promise<void> {
  const references = collectLiveReferences(records);
  try {
    await removeIdempotently(stagingRootUri());
  } catch {
    // Non bloccare bootstrap; il prossimo avvio ritenta.
  }
  await recoverTrash(records, references);
  await recoverFinalDirectories(records, references);
}

/** Sicuro anche quando il DB non e leggibile: lo staging non e mai referenziato. */
export async function recoverImageStorageStagingOnly(): Promise<void> {
  try {
    await removeIdempotently(stagingRootUri());
  } catch {
    // Non bloccare bootstrap; il prossimo avvio ritenta.
  }
}

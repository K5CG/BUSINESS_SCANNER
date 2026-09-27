const UUID_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, 'i');
const VERSIONED_PAGE_RE = new RegExp(`^page-(\\d+)-(${UUID_SOURCE})\\.jpg$`, 'i');
const VERSIONED_PHOTO_RE = new RegExp(`^contact-photo-(${UUID_SOURCE})\\.jpg$`, 'i');
const LEGACY_PAGE_RE = /^page-(\d+)\.jpg$/;
const LEGACY_PHOTO_RE = /^contact-photo\.jpg$/;

export interface AssetTokenShape {
  recordId: string;
  operationId: string;
  stagingDirectoryUri: string;
  finalDirectoryUri: string;
  assets: ReadonlyArray<{
    kind: 'page' | 'contact-photo';
    pageIndex?: number;
    stagedUri: string;
    finalUri: string;
  }>;
}

export interface DeletionTokenShape {
  recordId: string;
  operationId: string;
  originalDirectoryUri: string;
  trashedDirectoryUri: string;
}

export function isSafeUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isManagedAssetFileName(name: string): boolean {
  return (
    VERSIONED_PAGE_RE.test(name) ||
    VERSIONED_PHOTO_RE.test(name) ||
    LEGACY_PAGE_RE.test(name) ||
    LEGACY_PHOTO_RE.test(name)
  );
}

function assertPageIndex(pageIndex: number): void {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error('Indice pagina non valido');
  }
}

export function assertAssetTokenPaths(scansRootUri: string, token: AssetTokenShape): void {
  if (!isSafeUuid(token.recordId) || !isSafeUuid(token.operationId)) {
    throw new Error('ID token asset non valido');
  }
  const staging = `${scansRootUri}.staging/${token.operationId}/`;
  const finalDirectory = `${scansRootUri}${token.recordId}/`;
  if (
    token.stagingDirectoryUri !== staging ||
    token.finalDirectoryUri !== finalDirectory
  ) {
    throw new Error('Directory del token asset non valide');
  }

  const identities = new Set<string>();
  for (const asset of token.assets) {
    let identity: string;
    let stagedUri: string;
    let finalUri: string;
    if (asset.kind === 'page') {
      if (asset.pageIndex == null) throw new Error('Indice pagina del token mancante');
      assertPageIndex(asset.pageIndex);
      identity = `page:${asset.pageIndex}`;
      stagedUri = `${staging}page-${asset.pageIndex}.jpg`;
      finalUri =
        `${finalDirectory}page-${asset.pageIndex}-${token.operationId}.jpg`;
    } else if (asset.kind === 'contact-photo') {
      if (asset.pageIndex != null) throw new Error('Indice inatteso sulla foto contatto');
      identity = 'contact-photo';
      stagedUri = `${staging}contact-photo.jpg`;
      finalUri = `${finalDirectory}contact-photo-${token.operationId}.jpg`;
    } else {
      throw new Error('Tipo asset del token non valido');
    }
    if (identities.has(identity)) throw new Error('Asset duplicato nel token');
    identities.add(identity);
    if (asset.stagedUri !== stagedUri || asset.finalUri !== finalUri) {
      throw new Error('Percorso asset del token non valido');
    }
  }
}

export function assertDeletionTokenPaths(
  scansRootUri: string,
  token: DeletionTokenShape
): void {
  if (!isSafeUuid(token.recordId) || !isSafeUuid(token.operationId)) {
    throw new Error('ID token eliminazione non valido');
  }
  if (
    token.originalDirectoryUri !== `${scansRootUri}${token.recordId}/` ||
    token.trashedDirectoryUri !==
      `${scansRootUri}.trash/${token.recordId}/${token.operationId}/`
  ) {
    throw new Error('Percorso token eliminazione non valido');
  }
}

export function selectUnreferencedManagedAssetUris(
  directoryUri: string,
  assetNames: readonly string[],
  liveReferences: ReadonlySet<string>
): string[] {
  return assetNames
    .filter(isManagedAssetFileName)
    .map((name) => `${directoryUri}${name}`)
    .filter((uri) => !liveReferences.has(uri));
}

export interface AssetOwnerRecord {
  owner: 'contact' | 'document';
  id: string;
  images: readonly string[];
  contactPhotoUri?: string;
  recordType?: string;
}

export interface DirectoryReferenceRecord {
  id: string;
  images: readonly string[];
  contactPhotoUri?: string;
}

export function normalizeAssetReference(uri: string): string {
  if (uri.startsWith('file:/') && !uri.startsWith('file://')) {
    return uri.replace(/^file:\/*/, 'file:///');
  }
  if (uri.startsWith('/')) return `file://${uri}`;
  return uri;
}

export function normalizeAssetReferenceForScansRoot(
  uri: string,
  scansRootUri: string
): string {
  const normalized = normalizeAssetReference(uri.trim());
  const match = normalized.match(/\/scans\/([^/]+)\/([^/?#]+)$/);
  if (
    match &&
    isSafeUuid(match[1]!) &&
    isManagedAssetFileName(match[2]!)
  ) {
    return `${scansRootUri}${match[1]}/${match[2]}`;
  }
  return normalized;
}

export function otherOwnerUsesDirectory(
  records: readonly AssetOwnerRecord[],
  targetOwner: AssetOwnerRecord['owner'],
  targetId: string,
  directoryUri: string
): boolean {
  const scansRootUri = directoryUri.slice(0, -(targetId.length + 1));
  return records
    .filter((record) => !(record.owner === targetOwner && record.id === targetId))
    .some((record) => {
      if (record.id === targetId) return true;
      const references = [...record.images, record.contactPhotoUri].filter(
        (value): value is string => typeof value === 'string'
      );
      return references.some((uri) =>
        normalizeAssetReferenceForScansRoot(uri, scansRootUri).startsWith(directoryUri)
      );
    });
}

export function ownersOutsideConfirmedContactDeletion(
  records: readonly AssetOwnerRecord[],
  confirmedContactIds: ReadonlySet<string>
): AssetOwnerRecord[] {
  return records.filter((record) => {
    if (record.owner === 'contact') return !confirmedContactIds.has(record.id);
    return !(
      record.recordType === 'business_card' &&
      confirmedContactIds.has(record.id)
    );
  });
}

export function selectOrphanRecordDirectoryUris(
  scansRootUri: string,
  directoryNames: readonly string[],
  liveRecordIds: ReadonlySet<string>,
  liveReferences: ReadonlySet<string>
): string[] {
  return directoryNames
    .filter(isSafeUuid)
    .map((name) => ({ name, uri: `${scansRootUri}${name}/` }))
    .filter(
      ({ name, uri }) =>
        !liveRecordIds.has(name) &&
        ![...liveReferences].some((reference) => reference.startsWith(uri))
    )
    .map(({ uri }) => uri);
}

export function ownerReferencesAllowPerFileSweep(
  records: readonly DirectoryReferenceRecord[],
  recordId: string,
  directoryUri: string
): boolean {
  const owners = records.filter((record) => record.id === recordId);
  if (owners.length === 0) return true;
  const references = owners.flatMap((record) =>
    [...record.images, record.contactPhotoUri].filter(
      (value): value is string => typeof value === 'string' && !!value.trim()
    )
  );
  if (references.length === 0) return false;
  const scansRootUri = directoryUri.slice(0, -(recordId.length + 1));
  return references.every((uri) =>
    normalizeAssetReferenceForScansRoot(uri, scansRootUri).startsWith(directoryUri)
  );
}

export function assertFreshAssetRevision(
  persisted: { updatedAt: Date | string; images: readonly string[] },
  requested: { updatedAt: Date | string; images: readonly string[] }
): void {
  if (
    new Date(persisted.updatedAt).getTime() !== new Date(requested.updatedAt).getTime() ||
    persisted.images.length !== requested.images.length ||
    persisted.images.some((uri, index) => uri !== requested.images[index])
  ) {
    throw new Error('Revisione asset non aggiornata');
  }
}

import type {
  AnyDocument,
  BusinessCard,
  OcrLine,
  QuoteDocument,
} from '../../types';
import {
  runAssetDeleteSaga,
  runAssetSaveSaga,
  type AssetDeleteResult,
} from '../../lib/asset-persistence-core';
import { alignPageExtractionImageUris } from '../../lib/document-page-extraction';
import {
  commitCreatedRecordIfActive,
  hasSamePersistenceRevision,
  withPersistenceRevision,
  type ActiveOperationGuard,
} from '../../lib/scan-operation-lifecycle';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function ocrLines(textLines: readonly string[]): OcrLine[] {
  return textLines.map((text, index) => ({
    text,
    confidence: 0.85,
    boundingBox: {
      x: 10,
      y: 10 + index * 22,
      width: Math.max(100, text.length * 7),
      height: 18,
    },
  }));
}

export function testCard(
  overrides: Partial<BusinessCard> = {}
): BusinessCard {
  const createdAt = new Date('2026-07-25T08:00:00.000Z');
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'business_card',
    title: 'Acme - Mario Rossi',
    images: ['file:///capture/card-front.jpg'],
    rawText: 'Mario Rossi\nACME S.R.L.',
    confidence: {},
    createdAt,
    updatedAt: createdAt,
    firstName: 'Mario',
    lastName: 'Rossi',
    role: 'Direttore',
    company: 'Acme',
    emails: ['mario.rossi@acme.example'],
    phones: [],
    ...overrides,
  };
}

export function testQuote(
  overrides: Partial<QuoteDocument> = {}
): QuoteDocument {
  const createdAt = new Date('2026-07-25T08:00:00.000Z');
  return {
    id: '22222222-2222-4222-8222-222222222222',
    type: 'quote',
    title: 'Preventivo Q-1',
    images: ['file:///capture/quote-1.jpg'],
    rawText: 'Preventivo Q-1',
    confidence: {},
    createdAt,
    updatedAt: createdAt,
    quoteNumber: 'Q-1',
    quoteDate: new Date('2026-07-24T00:00:00.000Z'),
    items: [],
    ...overrides,
  };
}

export interface WorkflowEffects {
  published: Map<string, AnyDocument>;
  navigations: string[];
  warnings: string[];
}

export function createWorkflowEffects(): WorkflowEffects {
  return {
    published: new Map(),
    navigations: [],
    warnings: [],
  };
}

function assetRevision(record: AnyDocument): string {
  const revision = record.persistenceRevision?.trim();
  if (!revision) throw new Error('PERSISTENCE_REVISION_REQUIRED');
  return encodeURIComponent(revision);
}

function finalImageUri(
  record: AnyDocument,
  index: number
): string {
  return `file:///permanent/${record.id}/${assetRevision(record)}/page-${index + 1}.jpg`;
}

function stagingImageUri(
  record: AnyDocument,
  index: number
): string {
  return `file:///staging/${record.id}/${assetRevision(record)}/page-${index + 1}.jpg`;
}

function finalPhotoUri(record: AnyDocument): string {
  return `file:///permanent/${record.id}/${assetRevision(record)}/contact-photo.jpg`;
}

function stagingPhotoUri(record: AnyDocument): string {
  return `file:///staging/${record.id}/${assetRevision(record)}/contact-photo.jpg`;
}

function withPermanentAssetUris(
  record: AnyDocument,
  images: string[],
  contactPhotoUri: string | undefined
): AnyDocument {
  if (record.type === 'business_card') {
    return {
      ...record,
      images,
      ...(contactPhotoUri
        ? { contactPhotoUri }
        : { contactPhotoUri: undefined }),
    };
  }
  return {
    ...record,
    images,
    ...(record.pageExtractions
      ? {
          pageExtractions: alignPageExtractionImageUris(
            record.pageExtractions,
            images
          ),
        }
      : {}),
  };
}

export class MemoryPersistenceAdapter {
  readonly sources = new Set<string>();
  readonly staging = new Set<string>();
  readonly finals = new Set<string>();
  readonly trash = new Set<string>();
  readonly records = new Map<string, AnyDocument>();
  readonly events: string[] = [];

  failCopyAt?: number;
  failDatabase = false;
  databaseStarted?: Deferred<void>;
  holdDatabase?: Deferred<void>;

  seedSources(uris: readonly string[]): void {
    for (const uri of uris) this.sources.add(uri);
  }

  async save(record: AnyDocument): Promise<AnyDocument> {
    const ownedStaging = new Set<string>();
    const ownedFinals = new Set<string>();
    let persisted: AnyDocument | undefined;

    await runAssetSaveSaga({
      stage: async () => {
        const finalImages = record.images.map((_, index) =>
          finalImageUri(record, index)
        );
        const finalPhoto =
          record.type === 'business_card' && record.contactPhotoUri
            ? finalPhotoUri(record)
            : undefined;
        persisted = withPermanentAssetUris(
          record,
          finalImages,
          finalPhoto
        );

        const sourceUris = [
          ...record.images,
          ...(record.type === 'business_card' && record.contactPhotoUri
            ? [record.contactPhotoUri]
            : []),
        ];
        for (let index = 0; index < sourceUris.length; index += 1) {
          const source = sourceUris[index];
          const copyNumber = index + 1;
          this.events.push(`copy:${source}`);
          if (this.failCopyAt === copyNumber) {
            throw new Error(`COPY_FAILED:${copyNumber}`);
          }
          if (!this.sources.has(source)) {
            throw new Error(`SOURCE_MISSING:${source}`);
          }
          const stagingUri =
            index < record.images.length
              ? stagingImageUri(record, index)
              : stagingPhotoUri(record);
          this.staging.add(stagingUri);
          ownedStaging.add(stagingUri);
        }
      },
      promote: async () => {
        this.events.push('promote');
        const finalUris = [
          ...record.images.map((_, index) =>
            finalImageUri(record, index)
          ),
          ...(record.type === 'business_card' && record.contactPhotoUri
            ? [finalPhotoUri(record)]
            : []),
        ];
        for (const uri of finalUris) {
          if (this.finals.has(uri)) {
            throw new Error(`FINAL_ASSET_COLLISION:${uri}`);
          }
        }
        for (const stagingUri of ownedStaging) {
          this.staging.delete(stagingUri);
        }
        for (const uri of finalUris) {
          this.finals.add(uri);
          ownedFinals.add(uri);
        }
      },
      persist: async () => {
        this.events.push('db:insert');
        this.databaseStarted?.resolve(undefined);
        if (this.holdDatabase) await this.holdDatabase.promise;
        if (this.failDatabase) throw new Error('DB_INSERT_FAILED');
        if (!persisted) throw new Error('PERSISTED_RECORD_MISSING');
        this.records.set(record.id, persisted);
      },
      isPersisted: async () => {
        const current = this.records.get(record.id);
        return (
          current?.persistenceRevision !== undefined &&
          current.persistenceRevision === record.persistenceRevision
        );
      },
      rollbackAssets: async () => {
        this.events.push('rollback:assets');
        for (const uri of ownedStaging) this.staging.delete(uri);
        for (const uri of ownedFinals) this.finals.delete(uri);
      },
    });

    if (!persisted) throw new Error('PERSISTED_RECORD_MISSING');
    return persisted;
  }

  async compensate(record: AnyDocument): Promise<void> {
    this.events.push('compensate:record');
    const current = this.records.get(record.id);
    if (!current || !hasSamePersistenceRevision(current, record)) return;
    this.records.delete(record.id);
    for (const uri of [
      ...current.images,
      ...(current.type === 'business_card' && current.contactPhotoUri
        ? [current.contactPhotoUri]
        : []),
    ]) {
      this.finals.delete(uri);
    }
  }

  async delete(recordId: string): Promise<AssetDeleteResult> {
    const record = this.records.get(recordId);
    const recordFinals = record
      ? [
          ...record.images,
          ...(record.type === 'business_card' && record.contactPhotoUri
            ? [record.contactPhotoUri]
            : []),
        ]
      : [];
    const stagedTrash = new Set<string>();

    return runAssetDeleteSaga({
      stageAssets: async () => {
        this.events.push('delete:stage');
        for (const finalUri of recordFinals) {
          if (!this.finals.has(finalUri)) continue;
          const trashUri = finalUri.replace(
            'file:///permanent/',
            'file:///trash/'
          );
          this.finals.delete(finalUri);
          this.trash.add(trashUri);
          stagedTrash.add(trashUri);
        }
      },
      deleteRecord: async () => {
        this.events.push('db:delete');
        this.records.delete(recordId);
      },
      isDeleted: async () => !this.records.has(recordId),
      restoreAssets: async () => {
        this.events.push('delete:restore');
        for (const trashUri of stagedTrash) {
          this.trash.delete(trashUri);
          this.finals.add(
            trashUri.replace('file:///trash/', 'file:///permanent/')
          );
        }
      },
      finalizeAssets: async () => {
        this.events.push('delete:finalize');
        for (const trashUri of stagedTrash) this.trash.delete(trashUri);
      },
    });
  }
}

export async function persistCreatedRecord(
  adapter: MemoryPersistenceAdapter,
  effects: WorkflowEffects,
  record: AnyDocument,
  operation: ActiveOperationGuard
): Promise<AnyDocument> {
  const ownedRecord = withPersistenceRevision(
    record,
    operation.operationId
  );
  return commitCreatedRecordIfActive({
    operationId: operation.operationId,
    isActive: operation.isActive,
    compensationTarget: ownedRecord,
    persist: () => adapter.save(ownedRecord),
    compensate: (persisted) => adapter.compensate(persisted),
    publish: (persisted) => {
      adapter.events.push('store:publish');
      effects.published.set(persisted.id, persisted);
    },
  });
}

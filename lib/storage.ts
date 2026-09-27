import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { BusinessCard, AnyDocument } from '../types';
import {
  documentDateFromStored,
  withDocumentDateOnlyFields,
} from './document-date-only';
import {
  recoverImageStorage,
  recoverImageStorageStagingOnly,
  resolvePersistedAssetUri,
  type LiveAssetRecord,
} from './image-storage';

let db: SQLite.SQLiteDatabase | null = null;
let dbReadyPromise: Promise<void> | null = null;

type SqlWriteRunner = Pick<SQLite.SQLiteDatabase, 'runAsync'>;

export interface StoredLiveAssetRecord extends LiveAssetRecord {
  owner: 'contact' | 'document';
  recordType?: string;
}

function toDate(value: Date | string | unknown): Date {
  if (value instanceof Date) return value;
  return new Date(value as string);
}

function serializeRecord(record: Record<string, unknown>): string {
  const out: Record<string, unknown> = { ...record };
  if (record.createdAt != null) out.createdAt = toDate(record.createdAt).toISOString();
  if (record.updatedAt != null) out.updatedAt = toDate(record.updatedAt).toISOString();
  return JSON.stringify(out);
}

/** Le date del documento sono giorni di calendario: si salvano come tali. */
function serializeDocumentRecord(record: Record<string, unknown>): string {
  return serializeRecord(withDocumentDateOnlyFields(record));
}

/** Riduce il JSON salvato (rawText duplicato in extractionReview, reasons verbose). */
function trimExtractionReviewForStorage(review: unknown): unknown {
  if (!review || typeof review !== 'object') return review;
  const source = review as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'rawText') continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && 'reasons' in value) {
      const { reasons: _reasons, ...fieldRest } = value as Record<string, unknown>;
      out[key] = fieldRest;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function serializeContactPayload(contact: BusinessCard): string {
  const record = { ...contact } as Record<string, unknown>;
  if (record.extractionReview) {
    record.extractionReview = trimExtractionReviewForStorage(record.extractionReview);
  }
  return serializeRecord(record);
}

function parseLiveAssetPayload(
  primaryKey: string,
  data: string,
  owner: StoredLiveAssetRecord['owner'],
  sqlType?: string
): StoredLiveAssetRecord {
  const record = JSON.parse(data) as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    record.id !== primaryKey ||
    !Array.isArray(record.images) ||
    record.images.some((uri) => typeof uri !== 'string')
  ) {
    throw new Error('Payload asset DB non valido');
  }
  if (record.contactPhotoUri != null && typeof record.contactPhotoUri !== 'string') {
    throw new Error('Payload foto contatto DB non valido');
  }
  if (
    record.originalImages != null &&
    (!Array.isArray(record.originalImages) || record.originalImages.some((uri) => typeof uri !== 'string'))
  ) {
    throw new Error('Payload immagini originali DB non valido');
  }
  if (
    sqlType != null &&
    (typeof record.type !== 'string' || record.type !== sqlType)
  ) {
    throw new Error('Tipo payload DB incoerente');
  }
  return {
    id: record.id,
    images: [
      ...(record.images as string[]),
      ...(Array.isArray(record.originalImages) ? record.originalImages as string[] : []),
    ].map(resolvePersistedAssetUri),
    contactPhotoUri:
      typeof record.contactPhotoUri === 'string'
        ? resolvePersistedAssetUri(record.contactPhotoUri)
        : undefined,
    owner,
    recordType: typeof record.type === 'string' ? record.type : undefined,
  };
}

async function readAllLiveAssetRecords(
  database: SQLite.SQLiteDatabase
): Promise<StoredLiveAssetRecord[]> {
  const [contactRows, documentRows] = await Promise.all([
    database.getAllAsync<{ id: string; data: string }>('SELECT id, data FROM contacts'),
    database.getAllAsync<{ id: string; type: string; data: string }>(
      'SELECT id, type, data FROM documents'
    ),
  ]);
  return [
    ...contactRows.map((row) => parseLiveAssetPayload(row.id, row.data, 'contact')),
    ...documentRows.map((row) =>
      parseLiveAssetPayload(row.id, row.data, 'document', row.type)
    ),
  ];
}

async function recoverAssetsFromDatabase(database: SQLite.SQLiteDatabase): Promise<void> {
  try {
    const records = await readAllLiveAssetRecords(database);
    await recoverImageStorage(records);
  } catch {
    // Con JSON/listing incerto si elimina solo staging, mai directory finali.
    await recoverImageStorageStagingOnly();
  }
}

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!db) {
    db = await SQLite.openDatabaseAsync('business_card_scanner.db');
  }
  return db;
}

export async function initDatabase(): Promise<void> {
  if (dbReadyPromise) {
    await dbReadyPromise;
    return;
  }

  dbReadyPromise = (async () => {
    try {
      const database = await getDb();

      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          createdAt TEXT,
          updatedAt TEXT
        );
      `);

      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT,
          images TEXT,
          rawText TEXT,
          confidence TEXT,
          data TEXT,
          createdAt TEXT,
          updatedAt TEXT
        );
      `);

      // Recovery nella single-flight: ogni write che chiama
      // ensureDatabaseReady attende la riconciliazione degli asset.
      await recoverAssetsFromDatabase(database);
    } catch (error) {
      dbReadyPromise = null;
      throw error;
    }
  })();

  await dbReadyPromise;
}

export async function ensureDatabaseReady(): Promise<void> {
  await initDatabase();
}

/**
 * Snapshot fail-closed di tutti gli owner, incluse righe legacy nascoste alla UI.
 */
export async function getAllLiveAssetRecordsSnapshot(): Promise<StoredLiveAssetRecord[]> {
  await ensureDatabaseReady();
  return readAllLiveAssetRecords(await getDb());
}

function reviveDocument(data: AnyDocument): AnyDocument {
  const doc = { ...data };
  if (Array.isArray(doc.images)) {
    doc.images = doc.images.map(resolvePersistedAssetUri);
  }
  if (Array.isArray(doc.originalImages)) {
    doc.originalImages = doc.originalImages.map(resolvePersistedAssetUri);
  }
  if (doc.type === 'business_card' && doc.contactPhotoUri) {
    doc.contactPhotoUri = resolvePersistedAssetUri(doc.contactPhotoUri);
  }
  if (doc.createdAt) doc.createdAt = new Date(doc.createdAt as unknown as string);
  if (doc.updatedAt) doc.updatedAt = new Date(doc.updatedAt as unknown as string);

  if (doc.type === 'quote' && doc.quoteDate) {
    doc.quoteDate = documentDateFromStored(doc.quoteDate);
    if (doc.validUntil) doc.validUntil = documentDateFromStored(doc.validUntil);
  }
  if (doc.type === 'order' && doc.orderDate) {
    doc.orderDate = documentDateFromStored(doc.orderDate);
    if (doc.deliveryDate) doc.deliveryDate = documentDateFromStored(doc.deliveryDate);
  }
  if (doc.type === 'invoice' && doc.invoiceDate) {
    doc.invoiceDate = documentDateFromStored(doc.invoiceDate);
    if (doc.dueDate) doc.dueDate = documentDateFromStored(doc.dueDate);
  }
  if (doc.type === 'free_document' && doc.documentDate) {
    doc.documentDate = documentDateFromStored(doc.documentDate);
  }

  return doc;
}

async function runExclusiveWrite<T>(
  task: (runner: SqlWriteRunner) => Promise<T>
): Promise<T> {
  await ensureDatabaseReady();
  const database = await getDb();
  let result!: T;

  if (Platform.OS === 'web') {
    // expo-sqlite non supporta la connessione esclusiva sul web.
    await database.withTransactionAsync(async () => {
      result = await task(database);
    });
  } else {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      result = await task(transaction);
    });
  }
  return result;
}

async function insertContact(database: SqlWriteRunner, contact: BusinessCard): Promise<void> {
  const payload = serializeContactPayload(contact);
  const createdAt = toDate(contact.createdAt);
  const updatedAt = toDate(contact.updatedAt);

  await database.runAsync(
    `INSERT OR REPLACE INTO contacts (id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)`,
    [contact.id, payload, createdAt.toISOString(), updatedAt.toISOString()]
  );
}

async function insertDocument(database: SqlWriteRunner, document: AnyDocument): Promise<void> {
  const payload = serializeDocumentRecord(document as unknown as Record<string, unknown>);
  const createdAt = toDate(document.createdAt);
  const updatedAt = toDate(document.updatedAt);

  await database.runAsync(
    `INSERT OR REPLACE INTO documents (
      id, type, title, images, rawText, confidence, data, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      document.id,
      document.type,
      document.title ?? '',
      JSON.stringify(document.images ?? []),
      document.rawText ?? '',
      JSON.stringify(document.confidence ?? {}),
      payload,
      createdAt.toISOString(),
      updatedAt.toISOString(),
    ]
  );
}

export async function saveContact(contact: BusinessCard): Promise<void> {
  await runExclusiveWrite((transaction) => insertContact(transaction, contact));
}

export async function getAllContacts(): Promise<BusinessCard[]> {
  await ensureDatabaseReady();
  const database = await getDb();
  const rows = await database.getAllAsync<{ data: string }>(
    'SELECT data FROM contacts ORDER BY updatedAt DESC'
  );
  return rows.map((row) => {
    const contact = JSON.parse(row.data) as BusinessCard;
    contact.images = Array.isArray(contact.images)
      ? contact.images.map(resolvePersistedAssetUri)
      : [];
    if (contact.contactPhotoUri) {
      contact.contactPhotoUri = resolvePersistedAssetUri(contact.contactPhotoUri);
    }
    contact.createdAt = new Date(contact.createdAt);
    contact.updatedAt = new Date(contact.updatedAt);
    return contact;
  });
}

export async function getContactById(id: string): Promise<BusinessCard | null> {
  await ensureDatabaseReady();
  const database = await getDb();
  const row = await database.getFirstAsync<{ data: string }>(
    'SELECT data FROM contacts WHERE id = ?',
    [id]
  );
  if (!row) return null;
  const contact = JSON.parse(row.data) as BusinessCard;
  contact.images = Array.isArray(contact.images)
    ? contact.images.map(resolvePersistedAssetUri)
    : [];
  if (contact.contactPhotoUri) {
    contact.contactPhotoUri = resolvePersistedAssetUri(contact.contactPhotoUri);
  }
  contact.createdAt = new Date(contact.createdAt);
  contact.updatedAt = new Date(contact.updatedAt);
  return contact;
}

export async function hasStoredContactPayload(contact: BusinessCard): Promise<boolean> {
  await ensureDatabaseReady();
  const database = await getDb();
  const row = await database.getFirstAsync<{ data: string }>(
    'SELECT data FROM contacts WHERE id = ?',
    [contact.id]
  );
  return row?.data === serializeContactPayload(contact);
}

export async function deleteContact(id: string): Promise<void> {
  await runExclusiveWrite(async (transaction) => {
    await transaction.runAsync('DELETE FROM contacts WHERE id = ?', [id]);
    await transaction.runAsync(
      "DELETE FROM documents WHERE id = ? AND type = 'business_card'",
      [id]
    );
  });
}

/** Elimina tutti i contatti (tabella contacts). Restituisce il numero di righe rimosse. */
export async function clearAllContacts(contactIds: readonly string[]): Promise<number> {
  if (contactIds.length === 0) return 0;
  return runExclusiveWrite(async (transaction) => {
    let removed = 0;
    for (const id of contactIds) {
      const result = await transaction.runAsync('DELETE FROM contacts WHERE id = ?', [id]);
      removed += result.changes ?? 0;
      await transaction.runAsync(
        "DELETE FROM documents WHERE id = ? AND type = 'business_card'",
        [id]
      );
    }
    return removed;
  });
}

export async function hasLegacyBusinessCardDocument(id: string): Promise<boolean> {
  await ensureDatabaseReady();
  const database = await getDb();
  const row = await database.getFirstAsync<{ id: string }>(
    "SELECT id FROM documents WHERE id = ? AND type = 'business_card'",
    [id]
  );
  return !!row;
}

export async function saveDocument(document: AnyDocument): Promise<void> {
  await runExclusiveWrite((transaction) => insertDocument(transaction, document));
}

export async function getAllDocuments(): Promise<AnyDocument[]> {
  await ensureDatabaseReady();
  const database = await getDb();
  const rows = await database.getAllAsync<{ data: string }>(
    "SELECT * FROM documents WHERE type != 'business_card' ORDER BY updatedAt DESC"
  );

  return rows.map((row) => reviveDocument(JSON.parse(row.data)));
}

export async function getDocumentById(id: string): Promise<AnyDocument | null> {
  await ensureDatabaseReady();
  const database = await getDb();
  const row = await database.getFirstAsync<{ data: string; rawText: string | null }>(
    'SELECT * FROM documents WHERE id = ?',
    [id]
  );
  if (row) {
    const doc = reviveDocument(JSON.parse(row.data) as AnyDocument);
    if (!doc.rawText?.trim() && row.rawText?.trim()) {
      doc.rawText = row.rawText.trim();
    }
    return doc;
  }
  return getContactById(id);
}

export async function getDocumentOnlyById(id: string): Promise<AnyDocument | null> {
  await ensureDatabaseReady();
  const database = await getDb();
  const row = await database.getFirstAsync<{ data: string; rawText: string | null }>(
    "SELECT data, rawText FROM documents WHERE id = ? AND type != 'business_card'",
    [id]
  );
  if (!row) return null;
  const document = reviveDocument(JSON.parse(row.data) as AnyDocument);
  if (!document.rawText?.trim() && row.rawText?.trim()) {
    document.rawText = row.rawText.trim();
  }
  return document;
}

export async function hasStoredDocumentPayload(document: AnyDocument): Promise<boolean> {
  await ensureDatabaseReady();
  const database = await getDb();
  const row = await database.getFirstAsync<{ data: string }>(
    "SELECT data FROM documents WHERE id = ? AND type != 'business_card'",
    [document.id]
  );
  return row?.data === serializeRecord(document as unknown as Record<string, unknown>);
}

export async function deleteDocument(id: string): Promise<void> {
  await runExclusiveWrite(async (transaction) => {
    await transaction.runAsync('DELETE FROM documents WHERE id = ?', [id]);
  });
}

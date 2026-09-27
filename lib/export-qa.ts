import { Directory, File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { zipSync } from 'fflate';
import { formatExportBatchFileName } from './export-batches';
import type { BusinessCard, Phone } from '../types';
import { resolveImageUri } from './image-uri';
import { PARSER_BUILD_ID } from './parser-version';
import {
  getSafeContactEmails,
  isActionableEmailEvidence,
} from './email-evidence';
import { redactContactReviewStateForExport } from './contact-review-state';
import { runtimeLogger } from './safe-runtime-logger';

const CSV_COLUMNS = [
  'id',
  'createdAt',
  'updatedAt',
  'title',
  'company',
  'firstName',
  'lastName',
  'role',
  'emails',
  'phones',
  'website',
  'addressFormatted',
  'street',
  'postalCode',
  'city',
  'province',
  'country',
  'vatNumber',
  'taxCode',
  'notes',
  'rawText',
  'confidenceSummary',
  'reviewFields',
  'imageCount',
  'imageFilenames',
  'contactPhotoFilename',
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

function csvEscape(value: string | number | undefined | null): string {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function formatIsoDate(value: Date | string | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function formatEmails(emails: string[]): string {
  return (emails ?? []).join('; ');
}

function formatPhones(phones: Phone[]): string {
  return (phones ?? [])
    .map((phone) => (phone.type ? `${phone.number} (${phone.type})` : phone.number))
    .join('; ');
}

function confidenceSummary(card: BusinessCard): string {
  const entries = Object.entries(card.confidence ?? {});
  if (entries.length === 0) return '';
  return entries.map(([key, score]) => `${key}:${score}`).join('; ');
}

function reviewFields(card: BusinessCard): string {
  return card.extractionReview?.reviewFields?.join('; ') ?? '';
}

/** Nome file immagine nello ZIP QA (fronte/retro se due facciate, altrimenti progressivo). */
export function qaImageFilename(contactId: string, index: number, total: number): string {
  if (total >= 2 && index === 0) return `${contactId}_front_1.jpg`;
  if (total >= 2 && index === 1) return `${contactId}_back_2.jpg`;
  return `${contactId}_${index + 1}.jpg`;
}

export function qaContactPhotoFilename(contactId: string): string {
  return `${contactId}_contact_photo.jpg`;
}

export function qaImageFilenames(contactId: string, imageCount: number): string[] {
  return Array.from({ length: imageCount }, (_, index) => qaImageFilename(contactId, index, imageCount));
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  } catch (error) {
    runtimeLogger.warn('QA_IMAGE_SKIPPED', error, {
      source: 'filesystem',
      stage: 'read',
      status: 'skipped',
    });
    return null;
  }
}

export function serializeContactForQaJson(card: BusinessCard): Record<string, unknown> {
  const emails = getSafeContactEmails(card);
  const allowed = new Set(emails.map((email) => email.trim().toLowerCase()));
  const emailEvidence =
    card.emailEvidence === undefined
      ? undefined
      : card.emailEvidence.filter(
          (item) =>
            isActionableEmailEvidence(item) &&
            allowed.has(item.value.trim().toLowerCase())
        );
  const extractionReview = card.extractionReview
    ? {
        ...card.extractionReview,
        emails: {
          ...card.extractionReview.emails,
          value: emails,
        },
        ...(card.extractionReview.emailEvidence === undefined
          ? {}
          : {
              emailEvidence: card.extractionReview.emailEvidence.filter(
                (item) =>
                  isActionableEmailEvidence(item) &&
                  allowed.has(item.value.trim().toLowerCase())
              ),
            }),
      }
    : card.extractionReview;
  const contactReviewState = redactContactReviewStateForExport(
    card,
    emails
  );

  return {
    ...card,
    emails,
    ...(emailEvidence === undefined ? {} : { emailEvidence }),
    ...(extractionReview === undefined ? {} : { extractionReview }),
    ...(contactReviewState === undefined ? {} : { contactReviewState }),
    createdAt: formatIsoDate(card.createdAt),
    updatedAt: formatIsoDate(card.updatedAt),
  };
}

export function buildContactsCsv(contacts: BusinessCard[]): string {
  const rows = contacts.map((card) => {
    const imageNames = qaImageFilenames(card.id, card.images?.length ?? 0);
    const contactPhotoName = card.contactPhotoUri ? qaContactPhotoFilename(card.id) : '';
    const address = card.address;
    return [
      card.id,
      formatIsoDate(card.createdAt),
      formatIsoDate(card.updatedAt),
      card.title ?? '',
      card.company ?? '',
      card.firstName ?? '',
      card.lastName ?? '',
      card.role ?? '',
      formatEmails(getSafeContactEmails(card)),
      formatPhones(card.phones),
      card.website ?? '',
      address?.full ?? '',
      address?.street ?? '',
      address?.postalCode ?? '',
      address?.city ?? '',
      address?.region ?? '',
      address?.country ?? '',
      card.vatNumber ?? '',
      card.taxCode ?? '',
      card.notes ?? '',
      card.rawText ?? '',
      confidenceSummary(card),
      reviewFields(card),
      String(card.images?.length ?? 0),
      imageNames.join('; '),
      contactPhotoName,
    ]
      .map(csvEscape)
      .join(',');
  });

  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}

export function buildContactsJson(contacts: BusinessCard[]): string {
  return JSON.stringify(contacts.map(serializeContactForQaJson), null, 2);
}

export interface QaManifestEntry {
  id: string;
  title: string;
  /** Percorsi relativi nel ZIP — file JPEG reali, non embedded nel CSV. */
  cardImageFiles: string[];
  contactPhotoFile: string | null;
  rawTextFile: string;
}

export interface QaManifest {
  exportedAt: string;
  contactCount: number;
  parserBuildId: string;
  batchRange?: { from: number; to: number; totalInApp?: number };
  files: {
    csv: string;
    json: string;
    readme: string;
    imagesDir: string;
  };
  contacts: QaManifestEntry[];
}

export function buildQaManifest(
  contacts: BusinessCard[],
  exportedAt: Date,
  batch?: QaExportBatchMeta
): QaManifest {
  return {
    exportedAt: exportedAt.toISOString(),
    contactCount: contacts.length,
    parserBuildId: PARSER_BUILD_ID,
    batchRange:
      batch != null
        ? { from: batch.from, to: batch.to, totalInApp: batch.totalInApp }
        : undefined,
    files: {
      csv: 'contacts.csv',
      json: 'contacts.json',
      readme: 'README_QA.txt',
      imagesDir: 'images/',
    },
    contacts: contacts.map((card) => {
      const cardImageFiles = qaImageFilenames(card.id, card.images?.length ?? 0).map(
        (name) => `images/${name}`
      );
      return {
        id: card.id,
        title: card.title ?? '',
        cardImageFiles,
        contactPhotoFile: card.contactPhotoUri ? `images/${qaContactPhotoFilename(card.id)}` : null,
        rawTextFile: `raw-text/${card.id}.txt`,
      };
    }),
  };
}

export function buildReadmeQa(contactCount: number, exportedAt: Date): string {
  const stamp = exportedAt.toISOString();
  return [
    'Business Scanner — Export QA contatti',
    `Data export: ${stamp}`,
    `Contatti esportati: ${contactCount}`,
    `Parser build: ${PARSER_BUILD_ID}`,
    '',
    'Contenuto ZIP:',
    '- contacts.csv     Tabella testuale (Excel / analisi rapida) — NON contiene i pixel delle foto',
    '- contacts.json    Dump completo per script bulk / replay parser',
    '- manifest.json    Indice id → file immagini e rawText (utile per automazione)',
    '- raw-text/        Un file .txt per contatto con OCR grezzo',
    '- images/          File JPEG reali (biglietto fronte/retro + eventuale foto contatto)',
    '- README_QA.txt    Questo file',
    '',
    'IMPORTANTE — dove sono le immagini?',
    'Le foto NON sono dentro il CSV (impossibile in CSV).',
    'Il CSV ha solo colonne imageFilenames e contactPhotoFilename con i NOMI dei file.',
    'I file JPEG veri sono nella cartella images/ dello ZIP.',
    'Per bulk: usa manifest.json o contacts.json + cartella images/.',
    '',
    'Colonne contacts.csv:',
    '- id                 Identificativo univoco contatto',
    '- createdAt          Data creazione (ISO 8601)',
    '- updatedAt          Ultimo aggiornamento (ISO 8601)',
    '- title              Titolo visualizzato in app',
    '- company            Ragione sociale',
    '- firstName          Nome',
    '- lastName           Cognome',
    '- role               Ruolo / qualifica',
    '- emails             Email separate da ;',
    '- phones             Telefoni (numero e tipo) separati da ;',
    '- website            Sito web',
    '- addressFormatted   Indirizzo formattato completo',
    '- street             Via',
    '- postalCode         CAP',
    '- city               Città',
    '- province           Provincia / regione (campo region)',
    '- country            Paese',
    '- vatNumber          Partita IVA',
    '- taxCode            Codice fiscale',
    '- notes              Note utente',
    '- rawText            Testo OCR grezzo',
    '- confidenceSummary  Punteggi parser (campo:valore) se presenti',
    '- reviewFields       Campi segnalati per revisione (extractionReview)',
    '- imageCount         Numero immagini biglietto',
    '- imageFilenames     Nomi file in images/ (solo riferimento testuale)',
    '- contactPhotoFilename Nome foto volto/contatto in images/ (se presente)',
    '',
    'Naming immagini:',
    '- 2 facciate: {id}_front_1.jpg, {id}_back_2.jpg',
    '- Altre quantità: {id}_1.jpg, {id}_2.jpg, ...',
    '',
    'Export diagnostico QA — non modificare i dati in app.',
  ].join('\n');
}

export interface QaExportBatchMeta {
  from: number;
  to: number;
  totalInApp?: number;
}

export interface QaExportResult {
  zipPath: string;
  fileName: string;
  contactCount: number;
  sizeBytes: number;
}

export interface QaExportProgress {
  phase: 'text' | 'images' | 'zip';
  current: number;
  total: number;
}

export async function buildContactsQaZip(
  contacts: BusinessCard[],
  onProgress?: (progress: QaExportProgress) => void,
  batch?: QaExportBatchMeta
): Promise<QaExportResult> {
  const exportedAt = new Date();
  const manifest = buildQaManifest(contacts, exportedAt, batch);
  const zipEntries: Record<string, Uint8Array> = {
    'contacts.csv': encodeText(buildContactsCsv(contacts)),
    'contacts.json': encodeText(buildContactsJson(contacts)),
    'manifest.json': encodeText(JSON.stringify(manifest, null, 2)),
    'README_QA.txt': encodeText(buildReadmeQa(contacts.length, exportedAt)),
  };

  const total = contacts.length;
  onProgress?.({ phase: 'text', current: 0, total });

  for (let contactIndex = 0; contactIndex < contacts.length; contactIndex++) {
    const contact = contacts[contactIndex];

    if (contact.rawText?.trim()) {
      zipEntries[`raw-text/${contact.id}.txt`] = encodeText(contact.rawText.trim());
    }

    const images = contact.images ?? [];
    for (let index = 0; index < images.length; index++) {
      const filename = qaImageFilename(contact.id, index, images.length);
      const bytes = await readImageBytes(images[index]);
      if (bytes) {
        zipEntries[`images/${filename}`] = bytes;
      }
    }

    if (contact.contactPhotoUri) {
      const photoName = qaContactPhotoFilename(contact.id);
      const photoBytes = await readImageBytes(contact.contactPhotoUri);
      if (photoBytes) {
        zipEntries[`images/${photoName}`] = photoBytes;
      }
    }

    onProgress?.({ phase: 'images', current: contactIndex + 1, total });
    await yieldToMain();
  }

  onProgress?.({ phase: 'zip', current: total, total });

  const exportsDir = new Directory(Paths.document, 'qa-exports');
  if (!exportsDir.exists) {
    exportsDir.create({ intermediates: true });
  }

  const stamp = exportedAt.toISOString().replace(/[:.]/g, '-');
  const fileName =
    batch != null
      ? formatExportBatchFileName(batch.from, batch.to, exportedAt)
      : `qa-contacts-export_all_${stamp}.zip`;
  const zipFile = new File(exportsDir, fileName);
  const zipped = zipSync(zipEntries, { level: 0 });
  zipFile.create();
  zipFile.write(zipped);

  const zipPath = zipFile.uri;
  const info = zipFile.info();
  return {
    zipPath,
    fileName,
    contactCount: contacts.length,
    sizeBytes: info.exists && typeof info.size === 'number' ? info.size : zipped.length,
  };
}

export async function shareContactsQaZip(zipPath: string): Promise<boolean> {
  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) return false;
  try {
    await Sharing.shareAsync(zipPath, {
      mimeType: 'application/zip',
      dialogTitle: 'Export diagnostico',
      UTI: 'public.zip-archive',
    });
    return true;
  } catch (error) {
    runtimeLogger.warn('QA_SHARE_FAILED', error, {
      source: 'filesystem',
      stage: 'write',
      status: 'failed',
    });
    return false;
  }
}

export async function exportContactsQa(
  contacts: BusinessCard[],
  onProgress?: (progress: QaExportProgress) => void,
  batch?: QaExportBatchMeta
): Promise<QaExportResult> {
  return buildContactsQaZip(contacts, onProgress, batch);
}

/** @deprecated Usa exportContactsQa */
export async function exportAndShareContactsQa(contacts: BusinessCard[]): Promise<void> {
  await exportContactsQa(contacts);
}

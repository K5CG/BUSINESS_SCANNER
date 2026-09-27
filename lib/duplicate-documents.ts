import { AnyDocument, BusinessCard } from '../types';
import { normalizeEmail } from './duplicate-contacts-core';
import { getSafeContactEmails } from './email-evidence';

export type DocumentDuplicateKind = 'strong' | 'possible';

export interface DocumentDuplicateMatch {
  kind: DocumentDuplicateKind;
  document: AnyDocument;
  number?: string;
}

export interface FindDocumentDuplicateOptions {
  excludeDocumentId?: string;
}

const GENERIC_IDENTITY_LABELS = new Set([
  'ordine',
  'preventivo',
  'fattura',
  'documento',
  'order',
  'quote',
  'invoice',
  'customer ref',
  'customer ref.',
  'riferimento cliente',
]);

const IBAN_RE = /^[a-z]{2}\d{2}[a-z0-9]{10,30}$/;
const VAT_RE = /^(it)?\d{11}$/;
const TAX_CODE_RE = /^[a-z]{6}\d{2}[a-z]\d{2}[a-z]\d{3}[a-z]$/;

/** Normalizza un numero documento senza togliere caratteri significativi. */
export function normalizeDocumentIdentityNumber(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([/\-.])\s*/g, '$1');
}

function normalizePersonToken(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getCanonicalDocumentNumber(doc: AnyDocument): string | undefined {
  if (doc.type === 'quote') return doc.quoteNumber;
  if (doc.type === 'order') return doc.orderNumber;
  if (doc.type === 'invoice') return doc.invoiceNumber;
  if (doc.type === 'free_document') return doc.documentNumber;
  return undefined;
}

export function isRejectedDocumentIdentityValue(value: string): boolean {
  const compact = value.normalize('NFKC').replace(/\s+/g, '');
  const normalized = normalizeDocumentIdentityNumber(value);
  if (!normalized) return true;
  if (GENERIC_IDENTITY_LABELS.has(normalized)) return true;
  if (normalized === '122') return true;
  if (IBAN_RE.test(compact.toLowerCase())) return true;
  if (VAT_RE.test(compact.toLowerCase())) return true;
  if (TAX_CODE_RE.test(compact.toLowerCase())) return true;
  return false;
}

export function getReliableDocumentIdentityNumber(
  doc: AnyDocument
): string | undefined {
  const raw = getCanonicalDocumentNumber(doc)?.trim();
  if (!raw || isRejectedDocumentIdentityValue(raw)) return undefined;
  const reliability = doc.fieldReliability?.documentNumber;
  if (
    reliability &&
    reliability.source !== 'user' &&
    (reliability.validationStatus === 'invalid' ||
      reliability.validationStatus === 'missing')
  ) {
    return undefined;
  }
  return raw;
}

export function getDocumentIdentityKey(doc: AnyDocument): string | undefined {
  const number = getReliableDocumentIdentityNumber(doc);
  if (!number || doc.type === 'business_card') return undefined;
  return `${doc.type}:${normalizeDocumentIdentityNumber(number)}`;
}

export function getDocumentDuplicateKey(doc: AnyDocument): string {
  if (doc.type === 'business_card') {
    const card = doc as BusinessCard;
    const safeEmails = getSafeContactEmails(card);
    const email = safeEmails[0] ? normalizeEmail(safeEmails[0]) : '';
    if (email) return `${doc.type}:${email}`;
    return `${doc.type}:${doc.title.trim().toLowerCase()}`;
  }
  const identity = getDocumentIdentityKey(doc);
  if (identity) return identity;
  return `${doc.type}:${doc.id}`;
}

/** Raggruppa solo duplicati forti (stesso tipo + stesso numero, o stessa email card). */
export function findDuplicateGroups(documents: AnyDocument[]): AnyDocument[][] {
  const groups = new Map<string, AnyDocument[]>();

  for (const doc of documents) {
    const key = getDocumentDuplicateKey(doc);
    if (key.endsWith(`:${doc.id}`)) continue;
    const list = groups.get(key) ?? [];
    list.push(doc);
    groups.set(key, list);
  }

  return [...groups.values()].filter((group) => group.length > 1);
}

/** Restituisce la copia più recente. Non elimina nulla da sola. */
export function pickDuplicateToRemove(group: AnyDocument[]): AnyDocument {
  return [...group].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0];
}

function documentCustomerName(doc: AnyDocument): string | undefined {
  if (
    doc.type === 'quote' ||
    doc.type === 'order' ||
    doc.type === 'invoice'
  ) {
    const name = doc.customerName?.trim();
    return name || undefined;
  }
  return undefined;
}

function documentIssueDate(doc: AnyDocument): Date | undefined {
  if (doc.type === 'quote') return doc.quoteDate;
  if (doc.type === 'order') return doc.orderDate;
  if (doc.type === 'invoice') return doc.invoiceDate;
  if (doc.type === 'free_document') return doc.documentDate;
  return undefined;
}

function documentTotal(doc: AnyDocument): number | undefined {
  if (
    doc.type === 'quote' ||
    doc.type === 'order' ||
    doc.type === 'invoice'
  ) {
    return typeof doc.total === 'number' && Number.isFinite(doc.total)
      ? doc.total
      : undefined;
  }
  return undefined;
}

function sameCalendarDay(left?: Date, right?: Date): boolean {
  if (!(left instanceof Date) || !(right instanceof Date)) return false;
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return false;
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function sameMoney(left?: number, right?: number): boolean {
  if (left === undefined || right === undefined) return false;
  return Math.round(left * 100) === Math.round(right * 100);
}

function countSecondarySignals(
  candidate: AnyDocument,
  existing: AnyDocument
): number {
  let score = 0;
  const candidateCustomer = documentCustomerName(candidate);
  const existingCustomer = documentCustomerName(existing);
  if (
    candidateCustomer &&
    existingCustomer &&
    normalizePersonToken(candidateCustomer) ===
      normalizePersonToken(existingCustomer)
  ) {
    score += 1;
  }
  if (sameCalendarDay(documentIssueDate(candidate), documentIssueDate(existing))) {
    score += 1;
  }
  if (sameMoney(documentTotal(candidate), documentTotal(existing))) {
    score += 1;
  }
  return score;
}

export function findDocumentDuplicateMatch(
  candidate: AnyDocument,
  existing: readonly AnyDocument[],
  options: FindDocumentDuplicateOptions = {}
): DocumentDuplicateMatch | null {
  if (candidate.type === 'business_card') return null;

  const excludeId = options.excludeDocumentId ?? candidate.id;
  const pool = existing.filter(
    (doc) => doc.id !== excludeId && doc.type === candidate.type
  );

  const candidateNumber = getReliableDocumentIdentityNumber(candidate);
  if (candidateNumber) {
    const normalized = normalizeDocumentIdentityNumber(candidateNumber);
    const strong = pool.find((doc) => {
      const other = getReliableDocumentIdentityNumber(doc);
      return other !== undefined && normalizeDocumentIdentityNumber(other) === normalized;
    });
    if (strong) {
      return {
        kind: 'strong',
        document: strong,
        number: getReliableDocumentIdentityNumber(strong) ?? candidateNumber,
      };
    }
    return null;
  }

  if (candidate.type === 'free_document') return null;

  const possible = pool.find((doc) => {
    if (getReliableDocumentIdentityNumber(doc)) return false;
    return countSecondarySignals(candidate, doc) >= 2;
  });
  if (!possible) return null;
  return { kind: 'possible', document: possible };
}

export function shouldPersistAfterDocumentDuplicateDecision(
  decision: 'none' | 'open_existing' | 'save_anyway' | 'cancel'
): boolean {
  return decision === 'none' || decision === 'save_anyway';
}

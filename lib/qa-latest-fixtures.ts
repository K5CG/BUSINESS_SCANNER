import type { AnyDocument } from '../types';
import type { CanonicalOcrPageInput } from './document-canonical-parse';
import { canonicalPagesFromPersistedDocument } from './document-canonical-parse';

export const LATEST_QA_ARCHIVE = 'qa-documents-export_all_2026-08-17T16-05-06-630Z.zip';
export const LATEST_QA_DIR = 'test-data/qa-2026-08-17T16-05-06';
export const LATEST_QA_FIXTURE_DIR = `${LATEST_QA_DIR}/fixtures`;

export interface LatestQaPersistedView {
  customer: string | null;
  issuer: string | null;
  items: number;
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
  documentNumber: string | null;
  currency: string | null;
  reasons: string[];
  structuredCustomer: string | null;
  structuredSubtotal: number | null;
  structuredDiscount: number | null;
  structuredVat: number | null;
  structuredTotal: number | null;
  structuredItemCount: number;
}

export interface LatestQaFixture {
  id: string;
  type: string;
  title: string;
  language?: string;
  createdAt?: string;
  updatedAt?: string;
  pages: CanonicalOcrPageInput[];
  persisted: LatestQaPersistedView;
  pageCaptureMetadata?: AnyDocument['pageCaptureMetadata'];
  rawText: string;
}

export function documentNumberOf(document: AnyDocument): string | undefined {
  if (document.type === 'quote') return document.quoteNumber;
  if (document.type === 'order') return document.orderNumber;
  if (document.type === 'invoice') return document.invoiceNumber;
  return undefined;
}


function commercialDocumentView(document: AnyDocument): {
  customerName: string | null;
  items: number;
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
  currency: string | null;
} {
  if (document.type === 'quote' || document.type === 'order' || document.type === 'invoice') {
    return {
      customerName: document.customerName ?? null,
      items: document.items?.length ?? 0,
      subtotal: document.subtotal ?? null,
      vatAmount: document.vatAmount ?? null,
      total: document.total ?? null,
      currency: document.currency ?? null,
    };
  }
  return { customerName: null, items: 0, subtotal: null, vatAmount: null, total: null, currency: null };
}

export function persistedViewFromDocument(document: AnyDocument): LatestQaPersistedView {
  const commercial = commercialDocumentView(document);
  const structured = document.structuredExtraction;
  return {
    customer: commercial.customerName,
    issuer: document.structuredExtraction?.issuer?.name?.normalizedValue ?? null,
    items: commercial.items,
    subtotal: commercial.subtotal,
    vatAmount: commercial.vatAmount,
    total: commercial.total,
    documentNumber: documentNumberOf(document) ?? null,
    currency: commercial.currency,
    reasons: structured?.reasons ?? [],
    structuredCustomer: structured?.customer?.name?.normalizedValue ?? null,
    structuredSubtotal: structured?.summary.subtotal?.normalizedValue ?? null,
    structuredDiscount: structured?.summary.discountTotal?.normalizedValue ?? null,
    structuredVat: structured?.summary.vatAmount?.normalizedValue ?? null,
    structuredTotal: structured?.summary.total?.normalizedValue ?? null,
    structuredItemCount: structured?.items.length ?? 0,
  };
}

export function fixtureFromPersistedDocument(document: AnyDocument): LatestQaFixture {
  return {
    id: document.id,
    type: document.type,
    title: document.title ?? '',
    language: document.structuredExtraction?.language?.primaryLanguage,
    createdAt: document.createdAt instanceof Date
      ? document.createdAt.toISOString()
      : String(document.createdAt ?? ''),
    updatedAt: document.updatedAt instanceof Date
      ? document.updatedAt.toISOString()
      : String(document.updatedAt ?? ''),
    pages: canonicalPagesFromPersistedDocument(document),
    persisted: persistedViewFromDocument(document),
    pageCaptureMetadata: document.pageCaptureMetadata,
    rawText: (document.structuredExtraction?.pages ?? [])
      .map((page) => page.lines.map((line) => line.text).join('\n'))
      .join('\n\n'),
  };
}

export function slimDocumentForReplay(document: AnyDocument): AnyDocument {
  return {
    ...document,
    images: [],
    originalImages: undefined,
  };
}

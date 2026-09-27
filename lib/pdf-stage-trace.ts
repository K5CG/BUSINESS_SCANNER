import type { AnyDocument } from '../types';
import type { GeminiDocumentExtract } from './gemini-document-extract';
import type { StructuredDocumentExtraction } from './document-structure';
import { PDF_LOCAL_DIAGNOSTICS } from './pdf-import-local';
import { documentDateOnlyText } from './document-date-only';
import { isQaLogEnabled } from './release-diagnostics';

/**
 * Fotografia degli stessi campi nei momenti chiave dell'import PDF, cosi' un valore
 * che nasce, cambia o sparisce si vede confrontando le righe di log. La prima
 * fotografia precede il completamento locale: serve a giudicare il servizio AI
 * per quello che ha davvero restituito.
 *
 * Production/store: silent unless QA diagnostics are explicitly enabled.
 * Never emits raw PDF text; QA snapshots use presence flags for party fields.
 */
export type PdfStageName =
  | 'GEMINI_PROVIDER_NORMALIZED'
  | 'AFTER_PDF_HARDENING'
  | 'AFTER_BUILD_DOCUMENT'
  | 'AFTER_STRUCTURED_PARITY';

export interface PdfStageSnapshot {
  documentType: string | null;
  issuer: string | null;
  customer: string | null;
  documentNumber: string | null;
  date: string | null;
  subject: string | null;
  items: number;
  subtotal: number | null;
  vat: number | null;
  total: number | null;
  currency: string | null;
}

/** Le righe di log restano leggibili in logcat: i testi lunghi vengono troncati. */
const MAX_TEXT_LENGTH = 40;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT_LENGTH ? `${trimmed.slice(0, MAX_TEXT_LENGTH)}...` : trimmed;
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dateText(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? 'invalid_date'
      : documentDateOnlyText(value) ?? null;
  }
  return text(value);
}

export function geminiStageSnapshot(extract: GeminiDocumentExtract): PdfStageSnapshot {
  const structured = extract.structured;
  return {
    documentType: text(structured?.document.documentType?.value),
    issuer: text(structured?.issuer?.name?.value),
    customer: text(extract.customerName ?? structured?.customer?.name?.value),
    documentNumber: text(extract.documentNumber ?? structured?.document.documentNumber?.value),
    date: text(extract.date ?? structured?.document.issueDate?.value),
    subject: text(structured?.document.subject?.value),
    items: extract.items?.length ?? structured?.items.length ?? 0,
    subtotal: amount(extract.subtotal ?? structured?.summary.subtotal?.value),
    vat: amount(extract.vatAmount ?? structured?.summary.vatAmount?.value),
    total: amount(extract.total ?? structured?.summary.total?.value),
    currency: text(
      structured?.document.currency?.value ?? structured?.summary.currency?.value
    ),
  };
}

interface DocumentFieldsView {
  quoteNumber?: string;
  orderNumber?: string;
  invoiceNumber?: string;
  documentNumber?: string;
  quoteDate?: Date;
  orderDate?: Date;
  invoiceDate?: Date;
  documentDate?: Date;
  customerName?: string;
  items?: readonly unknown[];
  subtotal?: number;
  vatAmount?: number;
  total?: number;
  currency?: string;
  structuredExtraction?: StructuredDocumentExtraction;
}

export function documentStageSnapshot(document: AnyDocument): PdfStageSnapshot {
  const view = document as DocumentFieldsView;
  const extraction = view.structuredExtraction;
  return {
    documentType: text(document.type),
    issuer: text(extraction?.issuer?.name?.normalizedValue),
    customer: text(view.customerName ?? extraction?.customer?.name?.normalizedValue),
    documentNumber: text(
      view.quoteNumber ?? view.orderNumber ?? view.invoiceNumber ?? view.documentNumber
    ),
    date: dateText(view.quoteDate ?? view.orderDate ?? view.invoiceDate ?? view.documentDate),
    subject: text(extraction?.metadata?.subject?.normalizedValue),
    items: view.items?.length ?? 0,
    subtotal: amount(view.subtotal),
    vat: amount(view.vatAmount),
    total: amount(view.total),
    currency: text(view.currency ?? extraction?.summary?.currency?.normalizedValue),
  };
}

/** Sanitized log payload: counts/amounts only — no party names or document numbers. */
function safeStageLogPayload(stage: PdfStageName, snapshot: PdfStageSnapshot) {
  return {
    stage,
    documentType: snapshot.documentType,
    hasIssuer: Boolean(snapshot.issuer),
    hasCustomer: Boolean(snapshot.customer),
    hasDocumentNumber: Boolean(snapshot.documentNumber),
    hasDate: Boolean(snapshot.date),
    hasSubject: Boolean(snapshot.subject),
    items: snapshot.items,
    subtotal: snapshot.subtotal,
    vat: snapshot.vat,
    total: snapshot.total,
    currency: snapshot.currency,
  };
}

export function logPdfStage(stage: PdfStageName, snapshot: PdfStageSnapshot): void {
  if (!PDF_LOCAL_DIAGNOSTICS || !isQaLogEnabled()) return;
  console.warn(`[PdfStage] ${JSON.stringify(safeStageLogPayload(stage, snapshot))}`);
}

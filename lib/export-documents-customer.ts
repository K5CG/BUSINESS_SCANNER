import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';
import type {
  FreeDocument,
  InvoiceDocument,
  OrderDocument,
  QuoteDocument,
} from '../types';
import {
  XLSX_DATE_FORMAT,
  XLSX_DATETIME_FORMAT,
  formatCustomerDocumentDate,
  formatCustomerExportMoney,
  formatCustomerExportMoneyWithCurrency,
  formatCustomerExportPercent,
  formatCustomerExportQuantity,
  formatCustomerExportTimestamp,
  normalizeCustomerExportCurrency,
  toCustomerExcelDate,
} from './export-customer-format';
import {
  formatCustomerExportFileDate,
  type CustomerContactExportScope,
  type CustomerExportLocale,
} from './export-contacts-customer';

export type CustomerStoredDocument =
  | QuoteDocument
  | OrderDocument
  | InvoiceDocument
  | FreeDocument;

export type CustomerDocumentExportFormat = 'xlsx' | 'pdf';
export type CustomerDocumentExportScope = CustomerContactExportScope;
export type CustomerExportScalar = string | number | Date;

export const CUSTOMER_SUMMARY_SHEET_NAME = 'Riepilogo';
export const CUSTOMER_DOCUMENT_ITEMS_SHEET_NAME = 'Righe';
export const CUSTOMER_DETAILS_SHEET_NAME_IT = 'Dettagli';
export const CUSTOMER_DETAILS_SHEET_NAME_EN = 'Details';
export const PDF_SHARE_MIME_TYPE = 'application/pdf';
export const PDF_SHARE_UTI = 'com.adobe.pdf';

export const XLSX_MONEY_FORMAT = '#,##0.00';
export const XLSX_QUANTITY_INTEGER_FORMAT = '0';
export const XLSX_QUANTITY_DECIMAL_FORMAT = '0.00';
/** @deprecated Use integer/decimal quantity formats per cell. */
export const XLSX_QUANTITY_FORMAT = XLSX_QUANTITY_INTEGER_FORMAT;
export const XLSX_PERCENT_FORMAT = '0%';
export const XLSX_PERCENT_FRACTION_FORMAT = '0.##%';

export function customerDetailsSheetName(locale: CustomerExportLocale = 'it'): string {
  return locale === 'en' ? CUSTOMER_DETAILS_SHEET_NAME_EN : CUSTOMER_DETAILS_SHEET_NAME_IT;
}

export const CUSTOMER_DOCUMENT_EXPORT_KEYS = [
  'type',
  'title',
  'number',
  'date',
  'validUntil',
  'deliveryDate',
  'dueDate',
  'customerName',
  'customerVat',
  'subject',
  'shippingAddress',
  'subtotal',
  'vatRate',
  'vatAmount',
  'total',
  'currency',
  'notes',
  'extractedSummary',
  'createdAt',
  'updatedAt',
] as const;

export const CUSTOMER_DETAILS_KEYS = [
  'type',
  'number',
  'validUntil',
  'deliveryDate',
  'dueDate',
  'customerVat',
  'subject',
  'shippingAddress',
  'notes',
  'extractedSummary',
  'createdAt',
  'updatedAt',
] as const;

export type CustomerDetailsExportKey = (typeof CUSTOMER_DETAILS_KEYS)[number];
export type CustomerDetailsExportRow = Record<CustomerDetailsExportKey, CustomerExportScalar>;

export type CustomerDocumentExportKey = (typeof CUSTOMER_DOCUMENT_EXPORT_KEYS)[number];
export type CustomerDocumentExportRow = Record<CustomerDocumentExportKey, CustomerExportScalar>;

export const CUSTOMER_SUMMARY_KEYS = [
  'type',
  'number',
  'title',
  'date',
  'customerName',
  'supplier',
  'subtotal',
  'vatRate',
  'vatAmount',
  'total',
  'currency',
] as const;

export type CustomerSummaryExportKey = (typeof CUSTOMER_SUMMARY_KEYS)[number];
export type CustomerSummaryExportRow = Record<CustomerSummaryExportKey, CustomerExportScalar>;

export const CUSTOMER_DOCUMENT_ITEM_KEYS = [
  'documentLabel',
  'documentType',
  'description',
  'quantity',
  'unitPrice',
  'vatRate',
  'lineTotal',
] as const;

export type CustomerDocumentItemExportKey = (typeof CUSTOMER_DOCUMENT_ITEM_KEYS)[number];
export type CustomerDocumentItemExportRow = Record<CustomerDocumentItemExportKey, CustomerExportScalar>;

const DETAILS_DATE_KEYS = new Set<string>(['validUntil', 'deliveryDate', 'dueDate']);
const DETAILS_DATETIME_KEYS = new Set<string>(['createdAt', 'updatedAt']);
const SUMMARY_NUMERIC_KEYS = new Set<string>(['subtotal', 'vatAmount', 'total']);
const SUMMARY_PERCENT_KEYS = new Set<string>(['vatRate']);
const SUMMARY_DATE_KEYS = new Set<string>(['date']);
const ITEM_NUMERIC_KEYS = new Set<string>(['quantity', 'unitPrice', 'lineTotal']);
const ITEM_PERCENT_KEYS = new Set<string>(['vatRate']);
const MEANINGFUL_DETAILS_KEYS: CustomerDetailsExportKey[] = [
  'validUntil',
  'deliveryDate',
  'dueDate',
  'customerVat',
  'subject',
  'shippingAddress',
  'notes',
  'extractedSummary',
];

const DETAILS_HEADERS_IT: Record<CustomerDetailsExportKey, string> = {
  type: 'Tipo',
  number: 'Numero',
  validUntil: 'Validità',
  deliveryDate: 'Consegna',
  dueDate: 'Scadenza',
  customerVat: 'P.IVA cliente',
  subject: 'Oggetto',
  shippingAddress: 'Indirizzo spedizione',
  notes: 'Note',
  extractedSummary: 'Campi',
  createdAt: 'Data creazione',
  updatedAt: 'Ultima modifica',
};

const DETAILS_HEADERS_EN: Record<CustomerDetailsExportKey, string> = {
  type: 'Type',
  number: 'Number',
  validUntil: 'Valid until',
  deliveryDate: 'Delivery',
  dueDate: 'Due date',
  customerVat: 'Customer VAT',
  subject: 'Subject',
  shippingAddress: 'Shipping address',
  notes: 'Notes',
  extractedSummary: 'Fields',
  createdAt: 'Created',
  updatedAt: 'Last modified',
};

const SUMMARY_HEADERS_IT: Record<CustomerSummaryExportKey, string> = {
  type: 'Tipo',
  number: 'Numero',
  title: 'Titolo',
  date: 'Data',
  customerName: 'Cliente',
  supplier: 'Fornitore',
  subtotal: 'Subtotale',
  vatRate: 'Aliquota IVA %',
  vatAmount: 'Importo IVA',
  total: 'Totale',
  currency: 'Valuta',
};

const SUMMARY_HEADERS_EN: Record<CustomerSummaryExportKey, string> = {
  type: 'Type',
  number: 'Number',
  title: 'Title',
  date: 'Date',
  customerName: 'Customer',
  supplier: 'Supplier',
  subtotal: 'Subtotal',
  vatRate: 'VAT rate %',
  vatAmount: 'VAT amount',
  total: 'Total',
  currency: 'Currency',
};

const ITEM_HEADERS_IT: Record<CustomerDocumentItemExportKey, string> = {
  documentLabel: 'Documento',
  documentType: 'Tipo',
  description: 'Descrizione',
  quantity: 'Quantità',
  unitPrice: 'Prezzo unitario',
  vatRate: 'Aliquota IVA %',
  lineTotal: 'Totale riga',
};

const ITEM_HEADERS_EN: Record<CustomerDocumentItemExportKey, string> = {
  documentLabel: 'Document',
  documentType: 'Type',
  description: 'Description',
  quantity: 'Quantity',
  unitPrice: 'Unit price',
  vatRate: 'VAT rate %',
  lineTotal: 'Line total',
};

const DETAILS_COL_WIDTHS: Record<CustomerDetailsExportKey, number> = {
  type: 14,
  number: 16,
  validUntil: 14,
  deliveryDate: 14,
  dueDate: 14,
  customerVat: 16,
  subject: 24,
  shippingAddress: 28,
  notes: 28,
  extractedSummary: 32,
  createdAt: 18,
  updatedAt: 18,
};

const SUMMARY_COL_WIDTHS: Record<CustomerSummaryExportKey, number> = {
  type: 14,
  number: 16,
  title: 32,
  date: 14,
  customerName: 28,
  supplier: 28,
  subtotal: 14,
  vatRate: 12,
  vatAmount: 14,
  total: 14,
  currency: 8,
};

const ITEM_COL_WIDTHS: Record<CustomerDocumentItemExportKey, number> = {
  documentLabel: 16,
  documentType: 14,
  description: 36,
  quantity: 10,
  unitPrice: 14,
  vatRate: 10,
  lineTotal: 14,
};

const TYPE_LABELS_IT: Record<CustomerStoredDocument['type'], string> = {
  quote: 'Preventivo',
  order: 'Ordine',
  invoice: 'Fattura',
  free_document: 'Altro',
};

const TYPE_LABELS_EN: Record<CustomerStoredDocument['type'], string> = {
  quote: 'Quote',
  order: 'Order',
  invoice: 'Invoice',
  free_document: 'Other',
};

const QA_FIELD_KEY = /raw|confidence|evidence|debug|ocr|parser|review|coherence/i;

export function documentTypeLabel(
  type: CustomerStoredDocument['type'],
  locale: CustomerExportLocale = 'it'
): string {
  return (locale === 'en' ? TYPE_LABELS_EN : TYPE_LABELS_IT)[type];
}

export function customerDetailsHeaders(locale: CustomerExportLocale = 'it'): string[] {
  const labels = locale === 'en' ? DETAILS_HEADERS_EN : DETAILS_HEADERS_IT;
  return CUSTOMER_DETAILS_KEYS.map((key) => labels[key]);
}

export function customerSummaryHeaders(locale: CustomerExportLocale = 'it'): string[] {
  const labels = locale === 'en' ? SUMMARY_HEADERS_EN : SUMMARY_HEADERS_IT;
  return CUSTOMER_SUMMARY_KEYS.map((key) => labels[key]);
}

export function customerDocumentItemHeaders(locale: CustomerExportLocale = 'it'): string[] {
  const labels = locale === 'en' ? ITEM_HEADERS_EN : ITEM_HEADERS_IT;
  return CUSTOMER_DOCUMENT_ITEM_KEYS.map((key) => labels[key]);
}

export function buildCustomerDocumentsExportFileName(
  scope: CustomerDocumentExportScope,
  format: CustomerDocumentExportFormat,
  exportedAt: Date = new Date()
): string {
  const stamp = formatCustomerExportFileDate(exportedAt);
  const ext = format === 'xlsx' ? 'xlsx' : 'pdf';
  if (scope.kind === 'selected') {
    return `MyBizScanner_Documents_Selected_${stamp}.${ext}`;
  }
  if (scope.kind === 'batch') {
    return `MyBizScanner_Documents_${scope.from}-${scope.to}_${stamp}.${ext}`;
  }
  return `MyBizScanner_Documents_${stamp}.${ext}`;
}

export function mapDocumentToCustomerExportRow(
  document: CustomerStoredDocument,
  locale: CustomerExportLocale = 'it'
): CustomerDocumentExportRow {
  return {
    type: documentTypeLabel(document.type, locale),
    title: text(document.title),
    number: documentNumber(document),
    date: toCustomerExcelDate(documentDate(document), 'date'),
    validUntil:
      document.type === 'quote' ? toCustomerExcelDate(document.validUntil, 'date') : '',
    deliveryDate:
      document.type === 'order' ? toCustomerExcelDate(document.deliveryDate, 'date') : '',
    dueDate:
      document.type === 'invoice' ? toCustomerExcelDate(document.dueDate, 'date') : '',
    customerName: isCommercial(document) ? text(document.customerName) : '',
    customerVat: isCommercial(document) ? text(document.customerVat) : '',
    subject: document.type === 'free_document' ? text(document.subject) : '',
    shippingAddress: document.type === 'order' ? text(document.shippingAddress?.full) : '',
    subtotal: isCommercial(document) ? numericOrEmpty(document.subtotal) : '',
    vatRate: '',
    vatAmount: isCommercial(document) ? numericOrEmpty(document.vatAmount) : '',
    total: isCommercial(document) ? numericOrEmpty(document.total) : '',
    currency: isCommercial(document) ? normalizeCustomerExportCurrency(document.currency) : '',
    notes: text(document.notes),
    extractedSummary:
      document.type === 'free_document' ? summarizeExtractedFields(document.extractedFields) : '',
    createdAt: toCustomerExcelDate(document.createdAt, 'datetime'),
    updatedAt: toCustomerExcelDate(document.updatedAt, 'datetime'),
  };
}

export function mapDocumentToSummaryExportRow(
  document: CustomerStoredDocument,
  locale: CustomerExportLocale = 'it'
): CustomerSummaryExportRow {
  const full = mapDocumentToCustomerExportRow(document, locale);
  return {
    type: full.type,
    number: full.number,
    title: full.title,
    date: full.date,
    customerName: full.customerName,
    supplier: '',
    subtotal: full.subtotal,
    vatRate: full.vatRate,
    vatAmount: full.vatAmount,
    total: full.total,
    currency: full.currency,
  };
}

export function mapDocumentToDetailsExportRow(
  document: CustomerStoredDocument,
  locale: CustomerExportLocale = 'it'
): CustomerDetailsExportRow {
  const full = mapDocumentToCustomerExportRow(document, locale);
  return {
    type: full.type,
    number: full.number,
    validUntil: full.validUntil,
    deliveryDate: full.deliveryDate,
    dueDate: full.dueDate,
    customerVat: full.customerVat,
    subject: full.subject,
    shippingAddress: full.shippingAddress,
    notes: full.notes,
    extractedSummary: full.extractedSummary,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
  };
}

export function documentHasMeaningfulDetails(
  document: CustomerStoredDocument,
  locale: CustomerExportLocale = 'it'
): boolean {
  const row = mapDocumentToDetailsExportRow(document, locale);
  return MEANINGFUL_DETAILS_KEYS.some((key) => {
    const value = row[key];
    if (value instanceof Date) return true;
    if (typeof value === 'number') return Number.isFinite(value);
    return String(value ?? '').trim().length > 0;
  });
}
export function mapDocumentItemsToCustomerExportRows(
  document: CustomerStoredDocument,
  locale: CustomerExportLocale = 'it'
): CustomerDocumentItemExportRow[] {
  if (!isCommercial(document)) return [];
  return document.items.map((item) => ({
    documentLabel: documentNumber(document) || text(document.title),
    documentType: documentTypeLabel(document.type, locale),
    description: text(item.description),
    quantity: numericOrEmpty(item.quantity),
    unitPrice: numericOrEmpty(item.unitPrice),
    vatRate: numericOrEmpty(item.vatRate),
    lineTotal: numericOrEmpty(item.total),
  }));
}

export function buildCustomerDocumentsXlsxBytes(
  documents: CustomerStoredDocument[],
  locale: CustomerExportLocale = 'it'
): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const summarySheet = buildSummarySheet(documents, locale);
  XLSX.utils.book_append_sheet(workbook, summarySheet, CUSTOMER_SUMMARY_SHEET_NAME);

  const itemRows = documents.flatMap((document) =>
    mapDocumentItemsToCustomerExportRows(document, locale)
  );
  if (itemRows.length > 0) {
    const itemAoa: CustomerExportScalar[][] = [
      customerDocumentItemHeaders(locale),
      ...itemRows.map((row) => CUSTOMER_DOCUMENT_ITEM_KEYS.map((key) => row[key])),
    ];
    const itemSheet = XLSX.utils.aoa_to_sheet(itemAoa);
    applyWorksheetCellTypes(itemSheet, CUSTOMER_DOCUMENT_ITEM_KEYS, {
      numericKeys: ITEM_NUMERIC_KEYS,
      percentKeys: ITEM_PERCENT_KEYS,
      locale,
    });
    itemSheet['!cols'] = columnWidthsForKeys(CUSTOMER_DOCUMENT_ITEM_KEYS, ITEM_COL_WIDTHS, itemAoa);
    applyHeaderChrome(itemSheet, itemAoa.length);
    XLSX.utils.book_append_sheet(workbook, itemSheet, CUSTOMER_DOCUMENT_ITEMS_SHEET_NAME);
  }

  const detailsDocuments = documents.filter((document) => documentHasMeaningfulDetails(document, locale));
  if (detailsDocuments.length > 0) {
    const detailsAoa: CustomerExportScalar[][] = [
      customerDetailsHeaders(locale),
      ...detailsDocuments.map((document) =>
        CUSTOMER_DETAILS_KEYS.map((key) => mapDocumentToDetailsExportRow(document, locale)[key])
      ),
    ];
    const detailsSheet = XLSX.utils.aoa_to_sheet(detailsAoa);
    applyWorksheetCellTypes(detailsSheet, CUSTOMER_DETAILS_KEYS, {
      numericKeys: new Set<string>(),
      dateKeys: DETAILS_DATE_KEYS,
      datetimeKeys: DETAILS_DATETIME_KEYS,
      locale,
    });
    detailsSheet['!cols'] = columnWidthsForKeys(CUSTOMER_DETAILS_KEYS, DETAILS_COL_WIDTHS, detailsAoa);
    applyHeaderChrome(detailsSheet, detailsAoa.length);
    XLSX.utils.book_append_sheet(workbook, detailsSheet, customerDetailsSheetName(locale));
  }

  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellDates: true });
  return toUint8Array(output);
}

function buildSummarySheet(
  documents: CustomerStoredDocument[],
  locale: CustomerExportLocale
): XLSX.WorkSheet {
  const rows = documents.map((document) => mapDocumentToSummaryExportRow(document, locale));
  const aoa: CustomerExportScalar[][] = [
    customerSummaryHeaders(locale),
    ...rows.map((row) => CUSTOMER_SUMMARY_KEYS.map((key) => row[key])),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  applyWorksheetCellTypes(sheet, CUSTOMER_SUMMARY_KEYS, {
    numericKeys: SUMMARY_NUMERIC_KEYS,
    percentKeys: SUMMARY_PERCENT_KEYS,
    dateKeys: SUMMARY_DATE_KEYS,
    locale,
  });
  const dataRowCount = documents.length;
  sheet['!cols'] = columnWidthsForKeys(CUSTOMER_SUMMARY_KEYS, SUMMARY_COL_WIDTHS, aoa);
  applyHeaderChrome(sheet, dataRowCount + 1);
  return sheet;
}

export async function buildCustomerDocumentsPdfBytes(
  documents: CustomerStoredDocument[],
  locale: CustomerExportLocale = 'it'
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const labels = locale === 'en' ? PDF_LABELS_EN : PDF_LABELS_IT;

  for (const document of documents) {
    const layout = createPdfLayout(pdf, font, fontBold);
    layout.draw('MyBizScanner', { bold: true, size: 16, gap: 2 });
    layout.draw(labels.reportSubtitle, { size: 11, gap: 12 });
    const heading = [documentTypeLabel(document.type, locale), documentNumber(document)]
      .filter(Boolean)
      .join(' ');
    layout.draw(heading, { bold: true, size: 13, gap: 10 });

    drawKv(layout, labels.title, text(document.title));
    drawKv(layout, labels.date, formatCustomerDocumentDate(documentDate(document), locale));
    if (document.type === 'quote') {
      drawKv(layout, labels.validUntil, formatCustomerDocumentDate(document.validUntil, locale));
    }
    if (document.type === 'order') {
      drawKv(layout, labels.deliveryDate, formatCustomerDocumentDate(document.deliveryDate, locale));
      drawKv(layout, labels.shippingAddress, text(document.shippingAddress?.full));
    }
    if (document.type === 'invoice') {
      drawKv(layout, labels.dueDate, formatCustomerDocumentDate(document.dueDate, locale));
    }
    if (isCommercial(document)) {
      drawKv(layout, labels.customer, text(document.customerName));
      drawKv(layout, labels.customerVat, text(document.customerVat));
      drawKv(layout, labels.currency, normalizeCustomerExportCurrency(document.currency));
    }
    if (document.type === 'free_document') {
      drawKv(layout, labels.subject, text(document.subject));
    }

    if (isCommercial(document) && document.items.length > 0) {
      layout.y -= 8;
      layout.draw(labels.lines, { bold: true, size: 11, gap: 6 });
      drawItemTable(layout, document, locale);
    }

    if (isCommercial(document)) {
      if (document.items.length === 0) {
        layout.y -= 10;
      }
      layout.draw(labels.totals, { bold: true, size: 11, gap: 6 });
      const currency = document.currency;
      drawKv(layout, labels.subtotal, money(document.subtotal, locale, currency));
      drawKv(layout, labels.vatAmount, money(document.vatAmount, locale, currency));
      drawKv(layout, labels.total, money(document.total, locale, currency), true);
    }

    if (document.type === 'free_document') {
      const fields = Object.entries(document.extractedFields ?? {}).filter(
        ([key, value]) => text(value) && !QA_FIELD_KEY.test(key)
      );
      if (fields.length > 0) {
        layout.y -= 6;
        layout.draw(labels.fields, { bold: true, size: 11, gap: 4 });
        for (const [key, value] of fields) {
          drawKv(layout, key, value);
        }
      }
    }

    drawKv(layout, labels.notes, text(document.notes));
    drawKv(layout, labels.createdAt, formatCustomerExportTimestamp(document.createdAt, locale));
    drawKv(layout, labels.updatedAt, formatCustomerExportTimestamp(document.updatedAt, locale));
  }

  return pdf.save();
}

const PDF_LABELS_IT = {
  reportSubtitle: 'Report documenti',
  title: 'Titolo',
  date: 'Data',
  validUntil: 'Validità',
  deliveryDate: 'Consegna',
  dueDate: 'Scadenza',
  shippingAddress: 'Indirizzo spedizione',
  customer: 'Cliente',
  customerVat: 'P.IVA cliente',
  subject: 'Oggetto',
  lines: 'Righe',
  totals: 'Totali',
  subtotal: 'Subtotale',
  vatRate: 'Aliquota IVA',
  vatAmount: 'Importo IVA',
  total: 'Totale',
  currency: 'Valuta',
  fields: 'Campi rilevati',
  notes: 'Note',
  createdAt: 'Data creazione',
  updatedAt: 'Ultima modifica',
};

const PDF_LABELS_EN = {
  reportSubtitle: 'Document report',
  title: 'Title',
  date: 'Date',
  validUntil: 'Valid until',
  deliveryDate: 'Delivery',
  dueDate: 'Due date',
  shippingAddress: 'Shipping address',
  customer: 'Customer',
  customerVat: 'Customer VAT',
  subject: 'Subject',
  lines: 'Line items',
  totals: 'Totals',
  subtotal: 'Subtotal',
  vatRate: 'VAT rate',
  vatAmount: 'VAT amount',
  total: 'Total',
  currency: 'Currency',
  fields: 'Extracted fields',
  notes: 'Notes',
  createdAt: 'Created',
  updatedAt: 'Last modified',
};

export function sanitizePdfWinAnsi(value: string): string {
  const replacements: Record<string, string> = {
    '\u2018': "'",
    '\u2019': "'",
    '\u201C': '"',
    '\u201D': '"',
    '\u2013': '-',
    '\u2014': '-',
    '\u2026': '...',
    '\u00A0': ' ',
    '\u20AC': 'EUR',
  };
  let out = '';
  for (const char of value.normalize('NFC')) {
    if (replacements[char]) {
      out += replacements[char];
      continue;
    }
    const code = char.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126) || (code >= 160 && code <= 255)) {
      out += char;
      continue;
    }
    out += '?';
  }
  return out;
}

type PdfLayout = {
  page: PDFPage;
  y: number;
  font: PDFFont;
  fontBold: PDFFont;
  pdf: PDFDocument;
  draw: (next: string, options?: { bold?: boolean; size?: number; gap?: number }) => void;
  ensureSpace: (needed: number) => boolean;
  newPage: () => void;
};

const PAGE_TOP = 800;
const PAGE_BOTTOM = 48;
const PAGE_LEFT = 40;
const CONTENT_WIDTH = 515;

function createPdfLayout(pdf: PDFDocument, font: PDFFont, fontBold: PDFFont): PdfLayout {
  const layout: PdfLayout = {
    pdf,
    font,
    fontBold,
    page: pdf.addPage([595.28, 841.89]),
    y: PAGE_TOP,
    draw(next, options) {
      const size = options?.size ?? 10;
      const used = options?.bold ? fontBold : font;
      const lines = wrapPdfText(sanitizePdfWinAnsi(next), used, size, CONTENT_WIDTH);
      for (const line of lines) {
        layout.ensureSpace(size + 4);
        layout.page.drawText(line, {
          x: PAGE_LEFT,
          y: layout.y,
          size,
          font: used,
          color: rgb(0.12, 0.12, 0.12),
        });
        layout.y -= size + 4;
      }
      layout.y -= options?.gap ?? 2;
    },
    ensureSpace(needed) {
      if (layout.y - needed >= PAGE_BOTTOM) return false;
      layout.newPage();
      return true;
    },
    newPage() {
      layout.page = pdf.addPage([595.28, 841.89]);
      layout.y = PAGE_TOP;
    },
  };
  return layout;
}

function drawKv(layout: PdfLayout, label: string, value: string, emphasize = false): void {
  if (!value) return;
  layout.draw(`${label}: ${value}`, { bold: emphasize, size: emphasize ? 11 : 10 });
}

const ITEM_COLUMNS = [
  { key: 'description', width: 245, align: 'left' as const },
  { key: 'quantity', width: 48, align: 'right' as const },
  { key: 'unitPrice', width: 78, align: 'right' as const },
  { key: 'vatRate', width: 52, align: 'right' as const },
  { key: 'lineTotal', width: 92, align: 'right' as const },
];

export const PDF_ITEM_ROW = {
  size: 9,
  lineGap: 12,
  paddingTop: 0,
  descenderGuard: 3,
  gapBeforeDivider: 8,
  afterDivider: 8,
  dividerThickness: 0.35,
  lastRowExtraGap: 14,
} as const;

export const PDF_ITEM_HEADER = {
  size: 9,
  lineGap: 12,
  paddingTop: 6,
  paddingBottom: 6,
  afterUnderline: 10,
  topRuleThickness: 0.6,
  underlineThickness: 0.45,
} as const;

export type PdfItemRowMetrics = {
  descriptionLineCount: number;
  descriptionContentHeight: number;
  numericContentHeight: number;
  contentHeight: number;
  paddingTop: number;
  paddingBottom: number;
  firstLineOffset: number;
  dividerYFromTop: number;
  afterDivider: number;
  rowHeight: number;
  last: boolean;
};

export function pdfItemHeaderMetrics(): {
  contentHeight: number;
  paddingTop: number;
  paddingBottom: number;
  firstLineOffset: number;
  underlineYFromTop: number;
  afterUnderline: number;
  rowHeight: number;
} {
  const contentHeight = PDF_ITEM_HEADER.size;
  const firstLineOffset = PDF_ITEM_HEADER.paddingTop + PDF_ITEM_HEADER.size;
  const underlineYFromTop =
    PDF_ITEM_HEADER.topRuleThickness +
    firstLineOffset +
    PDF_ITEM_HEADER.paddingBottom;
  return {
    contentHeight,
    paddingTop: PDF_ITEM_HEADER.paddingTop,
    paddingBottom: PDF_ITEM_HEADER.paddingBottom,
    firstLineOffset: PDF_ITEM_HEADER.topRuleThickness + firstLineOffset,
    underlineYFromTop,
    afterUnderline: PDF_ITEM_HEADER.afterUnderline,
    rowHeight: underlineYFromTop + PDF_ITEM_HEADER.underlineThickness + PDF_ITEM_HEADER.afterUnderline,
  };
}

export function pdfItemRowMetrics(
  descriptionLineCount: number,
  options: { last?: boolean } = {}
): PdfItemRowMetrics {
  const last = options.last === true;
  const lines = Math.max(1, descriptionLineCount);
  const firstLineOffset = PDF_ITEM_ROW.paddingTop + PDF_ITEM_ROW.size;
  const descriptionContentHeight =
    PDF_ITEM_ROW.size + (lines - 1) * PDF_ITEM_ROW.lineGap + PDF_ITEM_ROW.descenderGuard;
  const numericContentHeight = PDF_ITEM_ROW.size + PDF_ITEM_ROW.descenderGuard;
  const contentHeight = Math.max(descriptionContentHeight, numericContentHeight);
  const dividerYFromTop = firstLineOffset + (lines - 1) * PDF_ITEM_ROW.lineGap + PDF_ITEM_ROW.descenderGuard + PDF_ITEM_ROW.gapBeforeDivider;
  const afterDivider = last ? 0 : PDF_ITEM_ROW.afterDivider;
  const rowHeight = last
    ? firstLineOffset + (lines - 1) * PDF_ITEM_ROW.lineGap + PDF_ITEM_ROW.descenderGuard + PDF_ITEM_ROW.lastRowExtraGap
    : dividerYFromTop + PDF_ITEM_ROW.dividerThickness + PDF_ITEM_ROW.afterDivider;
  return {
    descriptionLineCount: lines,
    descriptionContentHeight,
    numericContentHeight,
    contentHeight,
    paddingTop: PDF_ITEM_ROW.paddingTop,
    paddingBottom: last ? PDF_ITEM_ROW.lastRowExtraGap : PDF_ITEM_ROW.gapBeforeDivider,
    firstLineOffset,
    dividerYFromTop,
    afterDivider,
    rowHeight,
    last,
  };
}

function drawItemTable(
  layout: PdfLayout,
  document: QuoteDocument | OrderDocument | InvoiceDocument,
  locale: CustomerExportLocale
): void {
  const headers =
    locale === 'en'
      ? ['Description', 'Qty', 'Unit price', 'VAT %', 'Total']
      : ['Descrizione', 'Q.tà', 'Prezzo', 'IVA %', 'Totale'];
  const size = PDF_ITEM_ROW.size;

  const drawHeader = () => {
    const headerMetrics = pdfItemHeaderMetrics();
    layout.ensureSpace(headerMetrics.rowHeight);
    const topY = layout.y;
    layout.y = topY;
    drawTableRule(layout, PDF_ITEM_HEADER.topRuleThickness);
    layout.y = topY - headerMetrics.firstLineOffset;
    drawAlignedRow(layout, headers, true, PDF_ITEM_HEADER.size, [sanitizePdfWinAnsi(headers[0])]);
    layout.y = topY - headerMetrics.underlineYFromTop;
    drawTableRule(layout, PDF_ITEM_HEADER.underlineThickness);
    layout.y = topY - headerMetrics.rowHeight;
  };

  drawHeader();

  document.items.forEach((item, itemIndex) => {
    const last = itemIndex === document.items.length - 1;
    const values = [
      text(item.description),
      finite(item.quantity) ? formatCustomerExportQuantity(item.quantity, locale) : '',
      finite(item.unitPrice) ? formatCustomerExportMoney(item.unitPrice, locale) : '',
      finite(item.vatRate) ? formatCustomerExportPercent(item.vatRate, locale) : '',
      finite(item.total) ? formatCustomerExportMoney(item.total, locale) : '',
    ];
    const descLines = wrapPdfText(
      sanitizePdfWinAnsi(values[0]),
      layout.font,
      size,
      ITEM_COLUMNS[0].width - 6
    );
    const metrics = pdfItemRowMetrics(descLines.length, { last });
    if (layout.y - metrics.rowHeight < PAGE_BOTTOM) {
      layout.newPage();
      drawHeader();
    }
    const topY = layout.y;
    layout.y = topY - metrics.firstLineOffset;
    drawAlignedRow(layout, values, false, size, descLines);
    if (!last) {
      layout.y = topY - metrics.dividerYFromTop;
      drawTableRule(layout, PDF_ITEM_ROW.dividerThickness);
    }
    layout.y = topY - metrics.rowHeight;
  });
}

function drawAlignedRow(
  layout: PdfLayout,
  values: string[],
  bold: boolean,
  size: number,
  descriptionLines: string[]
): void {
  const font = bold ? layout.fontBold : layout.font;
  let x = PAGE_LEFT;
  values.forEach((value, index) => {
    const column = ITEM_COLUMNS[index];
    if (index === 0) {
      descriptionLines.forEach((line, lineIndex) => {
        layout.page.drawText(line, {
          x: x + 2,
          y: layout.y - lineIndex * PDF_ITEM_ROW.lineGap,
          size,
          font,
          color: rgb(0.12, 0.12, 0.12),
        });
      });
    } else {
      const cell = sanitizePdfWinAnsi(value);
      const textWidth = font.widthOfTextAtSize(cell, size);
      const drawX =
        column.align === 'right' ? x + column.width - textWidth - 2 : x + 2;
      layout.page.drawText(cell, {
        x: drawX,
        y: layout.y,
        size,
        font,
        color: rgb(0.12, 0.12, 0.12),
      });
    }
    x += column.width;
  });
}

function drawTableRule(layout: PdfLayout, thickness: number): void {
  layout.page.drawLine({
    start: { x: PAGE_LEFT, y: layout.y },
    end: { x: PAGE_LEFT + CONTENT_WIDTH, y: layout.y },
    thickness,
    color: rgb(0.78, 0.78, 0.78),
  });
}

export function wrapPdfText(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const paragraphs = normalized.split('\n');
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) {
        current = next;
        continue;
      }
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
      } else {
        let chunk = '';
        for (const char of word) {
          const trial = chunk + char;
          if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
            chunk = trial;
          } else {
            if (chunk) lines.push(chunk);
            chunk = char;
          }
        }
        current = chunk;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

function isCommercial(
  document: CustomerStoredDocument
): document is QuoteDocument | OrderDocument | InvoiceDocument {
  return document.type === 'quote' || document.type === 'order' || document.type === 'invoice';
}

function documentNumber(document: CustomerStoredDocument): string {
  if (document.type === 'quote') return text(document.quoteNumber);
  if (document.type === 'order') return text(document.orderNumber);
  if (document.type === 'invoice') return text(document.invoiceNumber);
  return text(document.documentNumber);
}

function documentDate(document: CustomerStoredDocument): Date | string | undefined {
  if (document.type === 'quote') return document.quoteDate;
  if (document.type === 'order') return document.orderDate;
  if (document.type === 'invoice') return document.invoiceDate;
  return document.documentDate;
}

function summarizeExtractedFields(fields: Record<string, string> | undefined): string {
  if (!fields) return '';
  return Object.entries(fields)
    .filter(([key, value]) => text(value) && !QA_FIELD_KEY.test(key))
    .map(([key, value]) => `${key}: ${text(value)}`)
    .join('; ');
}

function money(
  value: number | undefined,
  locale: CustomerExportLocale,
  currency: string | undefined
): string {
  if (!finite(value)) return '';
  return formatCustomerExportMoneyWithCurrency(value, locale, currency);
}

function finite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function numericOrEmpty(value: number | undefined): number | '' {
  return finite(value) ? value : '';
}

function text(value: string | undefined): string {
  return value?.trim() ?? '';
}

function coerceWorksheetDate(value: unknown): Date | number | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function applyHeaderChrome(worksheet: XLSX.WorkSheet, headerAndDataRowCount: number): void {
  const lastCol = worksheet['!ref'] ? XLSX.utils.decode_range(worksheet['!ref']).e.c : 0;
  const dataEnd = Math.max(1, headerAndDataRowCount);
  const dataRef = `A1:${XLSX.utils.encode_col(lastCol)}${dataEnd}`;
  worksheet['!autofilter'] = { ref: dataRef };
  worksheet['!views'] = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }];
}

function applyWorksheetCellTypes(
  worksheet: XLSX.WorkSheet,
  keys: readonly string[],
  options: {
    numericKeys: Set<string>;
    percentKeys?: Set<string>;
    dateKeys?: Set<string>;
    datetimeKeys?: Set<string>;
    locale: CustomerExportLocale;
  }
): void {
  const ref = worksheet['!ref'];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  const dateKeys = options.dateKeys ?? new Set<string>();
  const datetimeKeys = options.datetimeKeys ?? new Set<string>();
  const percentKeys = options.percentKeys ?? new Set<string>();
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = worksheet[address];
      if (!cell) continue;
      const key = keys[col];
      if (row === 0) {
        cell.t = 's';
        cell.v = String(cell.v ?? '');
        delete cell.w;
        delete cell.z;
        continue;
      }
      if (dateKeys.has(key) || datetimeKeys.has(key)) {
        const dateValue = coerceWorksheetDate(cell.v);
        if (dateValue == null) {
          cell.t = 's';
          cell.v = '';
          delete cell.w;
          delete cell.z;
          continue;
        }
        if (dateValue instanceof Date) {
          cell.t = 'd';
          cell.v = dateValue;
        } else {
          cell.t = 'n';
          cell.v = dateValue;
        }
        cell.z = datetimeKeys.has(key) ? XLSX_DATETIME_FORMAT[options.locale] : XLSX_DATE_FORMAT[options.locale];
        delete cell.w;
        continue;
      }
      if (!options.numericKeys.has(key) && !percentKeys.has(key)) {
        cell.t = 's';
        cell.v = String(cell.v ?? '');
        delete cell.w;
        delete cell.z;
        continue;
      }
      if (cell.v === '' || cell.v == null) {
        cell.t = 's';
        cell.v = '';
        delete cell.w;
        delete cell.z;
        continue;
      }
      const numeric = typeof cell.v === 'number' ? cell.v : Number(cell.v);
      if (!Number.isFinite(numeric)) {
        cell.t = 's';
        cell.v = String(cell.v ?? '');
        delete cell.w;
        delete cell.z;
        continue;
      }
      cell.t = 'n';
      if (percentKeys.has(key)) {
        cell.v = numeric / 100;
        cell.z = isWholePercentRate(numeric) ? XLSX_PERCENT_FORMAT : XLSX_PERCENT_FRACTION_FORMAT;
      } else {
        cell.v = numeric;
        cell.z = numberFormatForKey(key, numeric);
      }
      delete cell.w;
    }
  }
}

function isWholePercentRate(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-9;
}

function isWholeQuantity(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-9;
}

function numberFormatForKey(key: string, value: number): string {
  if (key === 'quantity') {
    return isWholeQuantity(value) ? XLSX_QUANTITY_INTEGER_FORMAT : XLSX_QUANTITY_DECIMAL_FORMAT;
  }
  return XLSX_MONEY_FORMAT;
}

function columnWidthsForKeys<K extends string>(
  keys: readonly K[],
  defaults: Record<K, number>,
  aoa: CustomerExportScalar[][]
): Array<{ wch: number }> {
  return keys.map((key, index) => {
    let width = defaults[key];
    for (const row of aoa) {
      const cell = row[index];
      const length = String(cell ?? '').length + 2;
      width = Math.max(width, Math.min(key === 'description' ? 40 : key === 'extractedSummary' || key === 'notes' || key === 'shippingAddress' ? 36 : 28, length));
    }
    return { wch: width };
  });
}

function toUint8Array(output: unknown): Uint8Array {
  if (output instanceof Uint8Array) return output;
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (Array.isArray(output)) return Uint8Array.from(output);
  if (output && typeof output === 'object' && ArrayBuffer.isView(output)) {
    const view = output as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error('Unexpected XLSX output');
}

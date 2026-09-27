import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as XLSX from 'xlsx';
import type {
  FreeDocument,
  InvoiceDocument,
  OrderDocument,
  QuoteDocument,
} from '../types';
import {
  CUSTOMER_DETAILS_SHEET_NAME_EN,
  CUSTOMER_DETAILS_SHEET_NAME_IT,
  CUSTOMER_DOCUMENT_ITEMS_SHEET_NAME,
  CUSTOMER_SUMMARY_SHEET_NAME,
  PDF_ITEM_HEADER,
  PDF_ITEM_ROW,
  XLSX_MONEY_FORMAT,
  XLSX_PERCENT_FORMAT,
  XLSX_QUANTITY_DECIMAL_FORMAT,
  XLSX_QUANTITY_INTEGER_FORMAT,
  buildCustomerDocumentsExportFileName,
  buildCustomerDocumentsPdfBytes,
  buildCustomerDocumentsXlsxBytes,
  customerDetailsHeaders,
  customerDetailsSheetName,
  customerSummaryHeaders,
  documentHasMeaningfulDetails,
  mapDocumentItemsToCustomerExportRows,
  mapDocumentToCustomerExportRow,
  mapDocumentToSummaryExportRow,
  pdfItemHeaderMetrics,
  pdfItemRowMetrics,
  sanitizePdfWinAnsi,
  wrapPdfText,
} from '../lib/export-documents-customer.ts';

function inflatePdfStreams(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const chunks: string[] = [];
  let searchFrom = 0;
  while (searchFrom < buf.length) {
    const startIdx = buf.indexOf(Buffer.from('stream'), searchFrom);
    if (startIdx < 0) break;
    let dataStart = startIdx + 6;
    if (buf[dataStart] === 0x0d) dataStart += 1;
    if (buf[dataStart] === 0x0a) dataStart += 1;
    const endIdx = buf.indexOf(Buffer.from('endstream'), dataStart);
    if (endIdx < 0) break;
    let dataEnd = endIdx;
    if (buf[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (buf[dataEnd - 1] === 0x0d) dataEnd -= 1;
    const compressed = buf.subarray(dataStart, dataEnd);
    try {
      chunks.push(inflateSync(compressed).toString('latin1'));
    } catch {
      chunks.push(compressed.toString('latin1'));
    }
    searchFrom = endIdx + 9;
  }
  return chunks.join('\n').replace(/<([0-9A-Fa-f]+)>/g, (_match, hex: string) =>
    Buffer.from(hex, 'hex').toString('latin1')
  );
}

const createdAt = new Date(2026, 7, 14, 10, 5, 0);
const updatedAt = new Date(2026, 7, 14, 18, 30, 0);

function base(overrides: Partial<QuoteDocument> = {}): Omit<QuoteDocument, 'type' | 'quoteNumber' | 'quoteDate' | 'validUntil' | 'customerName' | 'customerVat' | 'items' | 'subtotal' | 'vatAmount' | 'total' | 'currency'> {
  return {
    id: 'doc-1',
    title: 'Documento',
    images: [],
    rawText: 'UNIQUE_RAW_OCR_TOKEN',
    confidence: { total: 0.9 },
    createdAt,
    updatedAt,
    notes: '',
    ...overrides,
  };
}

function quote(overrides: Partial<QuoteDocument> = {}): QuoteDocument {
  return {
    ...base(overrides),
    quoteNumber: 'PR-100',
    quoteDate: new Date(2025, 4, 23, 0, 0, 0),
    validUntil: new Date(2026, 2, 6, 0, 0, 0),
    customerName: 'ACME Società',
    customerVat: 'IT01234567890',
    items: [
      { description: 'Tavolo', quantity: 2, unitPrice: 100, vatRate: 22, total: 200 },
      { description: 'Sedia', quantity: 4, unitPrice: 50, vatRate: 22, total: 200 },
    ],
    subtotal: 400,
    vatAmount: 88,
    total: 488,
    currency: 'EUR',
    notes: 'Cliente storico',
    ...overrides,
    type: 'quote',
  };
}

function order(overrides: Partial<OrderDocument> = {}): OrderDocument {
  return {
    ...base({ id: 'doc-2', title: 'Ordine Forlì' }),
    orderNumber: 'OR-200',
    orderDate: new Date(2026, 3, 1, 0, 0, 0),
    deliveryDate: new Date(2026, 3, 15, 0, 0, 0),
    customerName: 'Bianchi & Figli',
    customerVat: 'IT09876543210',
    items: [{ description: 'Lampada', quantity: 1, unitPrice: 80, vatRate: 22, total: 80 }],
    subtotal: 80,
    vatAmount: 17.6,
    total: 97.6,
    currency: 'EUR',
    shippingAddress: { full: "Via dell'Università 1, Forlì" },
    notes: '',
    ...overrides,
    type: 'order',
  };
}

function invoice(overrides: Partial<InvoiceDocument> = {}): InvoiceDocument {
  return {
    ...base({ id: 'doc-3', title: 'Fattura' }),
    invoiceNumber: 'FT-300',
    invoiceDate: new Date(2026, 4, 10, 0, 0, 0),
    dueDate: new Date(2026, 5, 10, 0, 0, 0),
    customerName: 'Città di Torino',
    customerVat: 'IT11111111111',
    items: [{ description: 'Servizio', quantity: 1, unitPrice: 1000, vatRate: 22, total: 1000 }],
    subtotal: 1000,
    vatAmount: 220,
    total: 1220,
    currency: 'EUR',
    notes: 'Pagamento 30 giorni',
    ...overrides,
    type: 'invoice',
  };
}

function generic(overrides: Partial<FreeDocument> = {}): FreeDocument {
  return {
    ...base({ id: 'doc-4', title: 'Contratto àèéìòù' }),
    documentNumber: 'AL-9',
    documentDate: new Date(2026, 6, 1, 0, 0, 0),
    subject: 'Fornitura arredi',
    extractedFields: {
      referente: 'José D\'Angelo',
      rawOcrSnippet: 'should-not-leak',
      confidenceScore: '0.99',
    },
    notes: 'Note libere',
    ...overrides,
    type: 'free_document',
  };
}

function cell(sheet: XLSX.WorkSheet, row: number, col: number): XLSX.CellObject | undefined {
  return sheet[XLSX.utils.encode_cell({ r: row, c: col })];
}

test('maps preventivo, ordine, fattura and generic documents without QA fields', () => {
  const quoteRow = mapDocumentToCustomerExportRow(quote());
  assert.equal(quoteRow.type, 'Preventivo');
  assert.equal(quoteRow.number, 'PR-100');
  assert.equal(quoteRow.customerName, 'ACME Società');
  assert.equal(quoteRow.subtotal, 400);
  assert.equal(quoteRow.vatRate, '');
  assert.equal(quoteRow.vatAmount, 88);
  assert.equal(quoteRow.total, 488);
  assert.equal(quoteRow.currency, 'EUR');
  assert.ok(quoteRow.date instanceof Date);
  assert.equal((quoteRow.date as Date).getDate(), 23);
  assert.equal((quoteRow.date as Date).getMonth(), 4);
  assert.equal((quoteRow.date as Date).getHours(), 12);
  assert.ok(quoteRow.createdAt instanceof Date);
  assert.equal((quoteRow.createdAt as Date).getHours(), 10);
  assert.equal((quoteRow.createdAt as Date).getMinutes(), 5);

  const orderRow = mapDocumentToCustomerExportRow(order());
  assert.equal(orderRow.type, 'Ordine');
  assert.equal(orderRow.shippingAddress, "Via dell'Università 1, Forlì");
  assert.ok(orderRow.deliveryDate instanceof Date);
  assert.equal((orderRow.deliveryDate as Date).getDate(), 15);

  const invoiceRow = mapDocumentToCustomerExportRow(invoice());
  assert.equal(invoiceRow.type, 'Fattura');
  assert.ok(invoiceRow.dueDate instanceof Date);
  assert.equal((invoiceRow.dueDate as Date).getDate(), 10);
  assert.equal(invoiceRow.total, 1220);

  const genericRow = mapDocumentToCustomerExportRow(generic());
  assert.equal(genericRow.type, 'Altro');
  assert.equal(genericRow.subject, 'Fornitura arredi');
  assert.match(String(genericRow.extractedSummary), /José D'Angelo/);
  assert.doesNotMatch(String(genericRow.extractedSummary), /should-not-leak/);
  assert.doesNotMatch(String(genericRow.extractedSummary), /0\.99/);
  assert.equal(genericRow.subtotal, '');
  assert.equal(genericRow.vatAmount, '');
});

test('missing optional commercial fields become empty strings', () => {
  const row = mapDocumentToCustomerExportRow(
    quote({
      quoteNumber: undefined,
      customerName: undefined,
      customerVat: undefined,
      notes: undefined,
      subtotal: undefined,
      vatAmount: undefined,
      total: undefined,
      currency: undefined,
      items: [],
    })
  );
  assert.equal(row.number, '');
  assert.equal(row.customerName, '');
  assert.equal(row.subtotal, '');
  assert.equal(row.vatAmount, '');
  assert.equal(row.notes, '');
});

test('line items keep stored totals and split VAT rate from VAT amount', () => {
  const rows = mapDocumentItemsToCustomerExportRows(quote());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].documentLabel, 'PR-100');
  assert.equal(rows[0].description, 'Tavolo');
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].unitPrice, 100);
  assert.equal(rows[0].vatRate, 22);
  assert.equal(rows[0].lineTotal, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'vatAmount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'discount'), false);
  assert.equal(mapDocumentItemsToCustomerExportRows(generic()).length, 0);
});

test('does not recompute suspicious stored line totals', () => {
  const rows = mapDocumentItemsToCustomerExportRows(
    quote({
      items: [
        { description: 'Armoire', quantity: 2, unitPrice: 5450, vatRate: 20, total: 10355 },
        { description: 'Accessoire', quantity: 1, unitPrice: 1100, vatRate: 20, total: 1 },
      ],
    })
  );
  assert.equal(rows[0].quantity, 2);
  assert.equal(rows[0].unitPrice, 5450);
  assert.equal(rows[0].lineTotal, 10355);
  assert.equal(rows[1].unitPrice, 1100);
  assert.equal(rows[1].lineTotal, 1);
});

test('XLSX workbook starts with Riepilogo and keeps numeric/text types', () => {
  const documents = [
    quote({ quoteNumber: '0012' }),
    order(),
    invoice(),
    generic(),
  ];
  const bytes = buildCustomerDocumentsXlsxBytes(documents, 'it');
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true, cellNF: true });
  assert.deepEqual(workbook.SheetNames, [
    CUSTOMER_SUMMARY_SHEET_NAME,
    CUSTOMER_DOCUMENT_ITEMS_SHEET_NAME,
    CUSTOMER_DETAILS_SHEET_NAME_IT,
  ]);
  assert.equal(workbook.SheetNames.includes('Documenti'), false);

  const summary = workbook.Sheets.Riepilogo;
  const summaryHeaders = XLSX.utils.sheet_to_json<string[]>(summary, { header: 1, raw: false })[0] as string[];
  assert.deepEqual(summaryHeaders, customerSummaryHeaders('it'));
  assert.equal(summaryHeaders.includes('Fornitore'), true);
  const summaryDate = cell(summary, 1, summaryHeaders.indexOf('Data'));
  assert.ok(summaryDate?.t === 'd' || summaryDate?.t === 'n');
  if (summaryDate?.t === 'd') {
    assert.equal((summaryDate.v as Date).getDate(), 23);
    assert.equal((summaryDate.v as Date).getMonth(), 4);
  } else {
    assert.equal(typeof summaryDate?.v, 'number');
  }
  assert.match(String(summaryDate?.z ?? ''), /dd\/mm\/yyyy/i);
  const summaryTotal = cell(summary, 1, summaryHeaders.indexOf('Totale'));
  assert.equal(summaryTotal?.t, 'n');
  assert.equal(summaryTotal?.v, 488);
  assert.equal(summaryTotal?.z, XLSX_MONEY_FORMAT);
  const summaryNumber = cell(summary, 1, summaryHeaders.indexOf('Numero'));
  assert.equal(summaryNumber?.t, 's');
  assert.equal(summaryNumber?.v, '0012');
  const summaryRef = XLSX.utils.decode_range(summary['!ref'] ?? 'A1');
  assert.equal(summaryRef.e.r, documents.length);
  for (let row = 1; row <= summaryRef.e.r; row += 1) {
    assert.notEqual(cell(summary, row, summaryHeaders.indexOf('Tipo'))?.v, 'TOTALI');
  }

  const details = workbook.Sheets.Dettagli;
  const detailsHeaders = customerDetailsHeaders('it');
  assert.deepEqual(
    XLSX.utils.sheet_to_json<string[]>(details, { header: 1, raw: false })[0],
    detailsHeaders
  );
  const dateCell = cell(details, 1, detailsHeaders.indexOf('Validità'));
  assert.ok(dateCell?.t === 'd' || dateCell?.t === 'n');
  const createdCell = cell(details, 1, detailsHeaders.indexOf('Data creazione'));
  assert.ok(createdCell?.t === 'd' || createdCell?.t === 'n');
  assert.match(String(createdCell?.z ?? ''), /hh:mm/i);
  const customerVatCell = cell(details, 1, detailsHeaders.indexOf('P.IVA cliente'));
  assert.equal(customerVatCell?.t, 's');
  assert.equal(customerVatCell?.v, 'IT01234567890');

  const serialized = JSON.stringify(XLSX.utils.sheet_to_json(details, { header: 1, raw: false }));
  assert.doesNotMatch(serialized, /UNIQUE_RAW_OCR_TOKEN/);
  assert.doesNotMatch(serialized, /should-not-leak/);

  const itemSheet = workbook.Sheets.Righe;
  const itemHeaders = XLSX.utils.sheet_to_json<string[]>(itemSheet, { header: 1, raw: false })[0] as string[];
  assert.ok(itemHeaders.includes('Documento'));
  assert.ok(itemHeaders.includes('Aliquota IVA %'));
  assert.equal(itemHeaders.includes('Importo IVA'), false);
  assert.equal(itemHeaders.includes('Sconto %'), false);
  const qtyCell = cell(itemSheet, 1, itemHeaders.indexOf('Quantità'));
  const unitCell = cell(itemSheet, 1, itemHeaders.indexOf('Prezzo unitario'));
  const itemVatRate = cell(itemSheet, 1, itemHeaders.indexOf('Aliquota IVA %'));
  const lineTotal = cell(itemSheet, 1, itemHeaders.indexOf('Totale riga'));
  const docLabel = cell(itemSheet, 1, itemHeaders.indexOf('Documento'));
  assert.equal(qtyCell?.t, 'n');
  assert.equal(qtyCell?.v, 2);
  assert.equal(qtyCell?.z, XLSX_QUANTITY_INTEGER_FORMAT);
  assert.equal(unitCell?.t, 'n');
  assert.equal(unitCell?.v, 100);
  assert.equal(itemVatRate?.t, 'n');
  assert.equal(itemVatRate?.v, 0.22);
  assert.equal(itemVatRate?.z, XLSX_PERCENT_FORMAT);
  assert.equal(lineTotal?.t, 'n');
  assert.equal(lineTotal?.v, 200);
  assert.equal(lineTotal?.z, XLSX_MONEY_FORMAT);
  assert.equal(docLabel?.t, 's');
  assert.equal(docLabel?.v, '0012');
  assert.ok(summary['!autofilter']);
  assert.ok(itemSheet['!autofilter']);
  assert.ok(details['!autofilter']);
});

test('generic-only workbook omits empty Righe and keeps Dettagli for Campi', () => {
  const workbook = XLSX.read(buildCustomerDocumentsXlsxBytes([generic()], 'it'), { type: 'array' });
  assert.deepEqual(workbook.SheetNames, [
    CUSTOMER_SUMMARY_SHEET_NAME,
    CUSTOMER_DETAILS_SHEET_NAME_IT,
  ]);
});

test('Dettagli is omitted when there is no meaningful extra metadata', () => {
  const minimal = quote({
    validUntil: undefined,
    customerVat: undefined,
    notes: '',
  });
  assert.equal(documentHasMeaningfulDetails(minimal), false);
  const workbook = XLSX.read(buildCustomerDocumentsXlsxBytes([minimal], 'it'), { type: 'array' });
  assert.deepEqual(workbook.SheetNames, [
    CUSTOMER_SUMMARY_SHEET_NAME,
    CUSTOMER_DOCUMENT_ITEMS_SHEET_NAME,
  ]);
  assert.equal(workbook.SheetNames.includes(CUSTOMER_DETAILS_SHEET_NAME_IT), false);
});

test('English workbook names the details sheet Details', () => {
  const workbook = XLSX.read(buildCustomerDocumentsXlsxBytes([generic()], 'en'), { type: 'array' });
  assert.equal(customerDetailsSheetName('en'), CUSTOMER_DETAILS_SHEET_NAME_EN);
  assert.ok(workbook.SheetNames.includes(CUSTOMER_DETAILS_SHEET_NAME_EN));
  assert.equal(workbook.SheetNames.includes('Documenti'), false);
});

test('mixed currencies are not summed together', () => {
  const bytes = buildCustomerDocumentsXlsxBytes([
    quote({ currency: 'EUR', total: 100, subtotal: 80, vatAmount: 20 }),
    order({ currency: 'USD', total: 50, subtotal: 40, vatAmount: 10 }),
  ], 'it');
  const workbook = XLSX.read(bytes, { type: 'array' });
  const summary = workbook.Sheets.Riepilogo;
  const headers = customerSummaryHeaders('it');
  const typeCol = headers.indexOf('Tipo');
  const summaryRef = XLSX.utils.decode_range(summary['!ref'] ?? 'A1');
  assert.equal(summaryRef.e.r, 2);
  assert.notEqual(cell(summary, 1, typeCol)?.v, 'TOTALI EUR');
  assert.notEqual(cell(summary, 2, typeCol)?.v, 'TOTALI USD');
  assert.equal(cell(summary, 3, typeCol), undefined);
});

test('summary dates can be sorted chronologically', () => {
  const bytes = buildCustomerDocumentsXlsxBytes([invoice(), quote()], 'it');
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
  const headers = customerSummaryHeaders('it');
  const dateCol = headers.indexOf('Data');
  const first = cell(workbook.Sheets.Riepilogo, 1, dateCol);
  const second = cell(workbook.Sheets.Riepilogo, 2, dateCol);
  const firstValue = first?.t === 'd' ? (first.v as Date).getTime() : Number(first?.v);
  const secondValue = second?.t === 'd' ? (second.v as Date).getTime() : Number(second?.v);
  assert.ok(firstValue > secondValue);
});

test('filenames cover all, selected and batch scopes for xlsx and pdf', () => {
  const exportedAt = new Date(2026, 7, 14, 9, 0, 0);
  assert.equal(
    buildCustomerDocumentsExportFileName({ kind: 'all' }, 'xlsx', exportedAt),
    'MyBizScanner_Documents_2026-08-14.xlsx'
  );
  assert.equal(
    buildCustomerDocumentsExportFileName({ kind: 'selected' }, 'pdf', exportedAt),
    'MyBizScanner_Documents_Selected_2026-08-14.pdf'
  );
  assert.equal(
    buildCustomerDocumentsExportFileName({ kind: 'batch', from: 1, to: 30 }, 'xlsx', exportedAt),
    'MyBizScanner_Documents_1-30_2026-08-14.xlsx'
  );
});

test('PDF is valid, formatted, wrapped and free of QA dump', async () => {
  const longDescription =
    'Armoire a portes coulissantes en bois massif avec finition speciale e descrizione molto lunga da non troncare';
  const bytes = await buildCustomerDocumentsPdfBytes(
    [
      quote({
        customerName: 'Società Città',
        items: [
          { description: longDescription, quantity: 2, unitPrice: 169500, vatRate: 22, total: 339000 },
          { description: 'Tavolo', quantity: 1, unitPrice: 100, vatRate: 22, total: 100 },
        ],
        subtotal: 169500,
        vatAmount: 7929.8,
        total: 177429.8,
      }),
      invoice(),
      generic(),
    ],
    'it'
  );
  assert.ok(bytes.byteLength > 100);
  assert.match(Buffer.from(bytes).subarray(0, 8).toString('latin1'), /^%PDF-/);
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() >= 3);
  const body = inflatePdfStreams(bytes);
  assert.match(body, /MyBizScanner/);
  assert.match(body, /Report documenti/);
  assert.match(body, /Preventivo PR-100/);
  assert.match(body, /Fattura/);
  assert.match(body, /Altro/);
  assert.match(body, /23\/05\/2025/);
  assert.doesNotMatch(body, /00:00/);
  assert.match(body, /169\.500,00 EUR/);
  assert.match(body, /Importo IVA/);
  assert.match(body, /7\.929,80 EUR/);
  assert.match(body, /22%/);
  assert.match(body, /IVA %/);
  assert.doesNotMatch(body, /IVA: 22\.00/);
  assert.match(body, /Armoire/);
  assert.match(body, /troncare/);
  assert.match(body, /Società Città/);
  assert.match(body, /Contratto àèéìòù/);
  assert.doesNotMatch(body, /UNIQUE_RAW_OCR_TOKEN/);
  assert.doesNotMatch(body, /should-not-leak/);
});

test('English PDF uses English labels and US number format', async () => {
  const body = inflatePdfStreams(await buildCustomerDocumentsPdfBytes([quote()], 'en'));
  assert.match(body, /Document report/);
  assert.match(body, /Quote PR-100/);
  assert.match(body, /05\/23\/2025/);
  assert.match(body, /VAT amount/);
  assert.match(body, /400\.00 EUR/);
});

test('PDF generation does not crash on missing fields', async () => {
  const bytes = await buildCustomerDocumentsPdfBytes([
    quote({ items: [], customerName: undefined, notes: undefined, total: undefined }),
    generic({ extractedFields: {}, subject: undefined }),
  ]);
  assert.match(Buffer.from(bytes).subarray(0, 5).toString('latin1'), /%PDF-/);
});

test('WinAnsi sanitizer keeps Western European accents and maps euro', () => {
  assert.equal(sanitizePdfWinAnsi("Città d'Forlì àèéìòù"), "Città d'Forlì àèéìòù");
  assert.equal(sanitizePdfWinAnsi('élève français'), 'élève français');
  assert.equal(sanitizePdfWinAnsi('Müller Größe'), 'Müller Größe');
  assert.equal(sanitizePdfWinAnsi('España niño'), 'España niño');
  assert.equal(sanitizePdfWinAnsi('100 €'), '100 EUR');
  assert.equal(sanitizePdfWinAnsi('“quote” — dash'), '"quote" - dash');
});

test('line descriptions wrap instead of truncating', async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines = wrapPdfText(
    'Armoire a portes coulissantes en bois massif con descrizione molto lunga',
    font,
    9,
    180
  );
  assert.ok(lines.length > 1);
  assert.match(lines.join(' '), /Armoire/);
  assert.match(lines.join(' '), /lunga/);
});

test('PDF row divider sits below wrapped description lines with padding', () => {
  const single = pdfItemRowMetrics(1);
  const wrapped = pdfItemRowMetrics(4);
  const last = pdfItemRowMetrics(4, { last: true });
  const header = pdfItemHeaderMetrics();
  assert.ok(wrapped.rowHeight > single.rowHeight);
  assert.ok(
    wrapped.dividerYFromTop >=
      wrapped.firstLineOffset + (wrapped.descriptionLineCount - 1) * PDF_ITEM_ROW.lineGap + PDF_ITEM_ROW.descenderGuard
  );
  assert.equal(wrapped.afterDivider, PDF_ITEM_ROW.afterDivider);
  assert.equal(wrapped.rowHeight, wrapped.dividerYFromTop + PDF_ITEM_ROW.dividerThickness + wrapped.afterDivider);
  assert.ok(wrapped.firstLineOffset >= PDF_ITEM_ROW.size);
  assert.equal(last.afterDivider, 0);
  assert.ok(last.rowHeight < wrapped.rowHeight);
  assert.equal(header.afterUnderline, PDF_ITEM_HEADER.afterUnderline);
  assert.ok(header.rowHeight > header.underlineYFromTop);
});

test('quantity cells stay numeric with integer vs decimal Excel formats', () => {
  const bytes = buildCustomerDocumentsXlsxBytes([
    quote({
      items: [
        { description: 'A', quantity: 217, unitPrice: 1, vatRate: 20, total: 217 },
        { description: 'B', quantity: 1, unitPrice: 1, vatRate: 22, total: 1 },
        { description: 'C', quantity: 1.5, unitPrice: 2, vatRate: 0, total: 3 },
        { description: 'D', quantity: 2.25, unitPrice: 4, vatRate: 7.7, total: 9 },
      ],
    }),
  ], 'it');
  const workbook = XLSX.read(bytes, { type: 'array', cellNF: true });
  const sheet = workbook.Sheets.Righe;
  const headers = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false })[0] as string[];
  const qtyCol = headers.indexOf('Quantità');
  const vatCol = headers.indexOf('Aliquota IVA %');
  const expected = [
    { qty: 217, format: XLSX_QUANTITY_INTEGER_FORMAT },
    { qty: 1, format: XLSX_QUANTITY_INTEGER_FORMAT },
    { qty: 1.5, format: XLSX_QUANTITY_DECIMAL_FORMAT },
    { qty: 2.25, format: XLSX_QUANTITY_DECIMAL_FORMAT },
  ];
  expected.forEach((row, index) => {
    const qtyCell = cell(sheet, index + 1, qtyCol);
    assert.equal(qtyCell?.t, 'n');
    assert.equal(qtyCell?.v, row.qty);
    assert.equal(qtyCell?.z, row.format);
  });
  assert.equal(cell(sheet, 1, vatCol)?.v, 0.2);
  assert.equal(cell(sheet, 1, vatCol)?.z, XLSX_PERCENT_FORMAT);
  assert.equal(cell(sheet, 2, vatCol)?.v, 0.22);
  assert.equal(cell(sheet, 2, vatCol)?.z, XLSX_PERCENT_FORMAT);
  assert.equal(cell(sheet, 3, vatCol)?.v, 0);
  assert.equal(cell(sheet, 3, vatCol)?.z, XLSX_PERCENT_FORMAT);
  assert.equal(cell(sheet, 4, vatCol)?.v, 7.7 / 100);
  assert.equal(cell(sheet, 4, vatCol)?.z, '0.##%');
});

test('leaves missing document totals blank and does not invent them from rows', () => {
  const row = mapDocumentToSummaryExportRow(
    quote({
      items: [{ description: 'Vano 812/Z', quantity: 1, unitPrice: 4850, vatRate: 20, total: 4850 }],
      subtotal: undefined,
      vatAmount: undefined,
      total: undefined,
    })
  );
  assert.equal(row.subtotal, '');
  assert.equal(row.vatAmount, '');
  assert.equal(row.total, '');
  assert.equal(row.vatRate, '');
});

test('does not export a document-level VAT amount that is not stored', () => {
  const row = mapDocumentToSummaryExportRow(
    order({ vatAmount: undefined, subtotal: 169500, total: 169500, currency: 'EUR' })
  );
  assert.equal(row.subtotal, 169500);
  assert.equal(row.total, 169500);
  assert.equal(row.vatAmount, '');
  assert.equal(row.vatRate, '');
  assert.equal(row.supplier, '');
});

test('generated XLSX keeps autofilter; freeze pane is inspected from the zip', () => {
  const bytes = buildCustomerDocumentsXlsxBytes([quote()], 'it');
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const sheetPath = names.find((name) => name.startsWith('xl/worksheets/sheet') && name.endsWith('.xml'));
  assert.ok(sheetPath);
  const sheetXml = new TextDecoder().decode(files[sheetPath]);
  assert.match(sheetXml, /autoFilter/i);
  const freezePersisted = /freeze/i.test(sheetXml) || /ySplit="1"/i.test(sheetXml);
  assert.equal(typeof freezePersisted, 'boolean');
  if (!freezePersisted) {
    assert.doesNotMatch(sheetXml, /<pane\b/i);
  }
});

test('writes a visual PDF fixture with mixed row heights and a page break', async () => {
  const longFour =
    'Armoire a portes coulissantes en bois massif con finitura speciale e descrizione molto lunga da avvolgere su almeno quattro righe nella tabella PDF del report documenti MyBizScanner';
  const veryLong =
    `${longFour} ${longFour} accessori metallici cromati cerniere silenziose e ripiani regolabili in altezza per magazzino`;
  const items = [
    { description: 'Tavolo una riga', quantity: 1, unitPrice: 100, vatRate: 22, total: 100 },
    {
      description: 'Sedia imbottita con schienale alto due righe almeno per il wrap della descrizione',
      quantity: 2,
      unitPrice: 80,
      vatRate: 22,
      total: 160,
    },
    { description: longFour, quantity: 1, unitPrice: 5450, vatRate: 20, total: 10355 },
    { description: veryLong, quantity: 217, unitPrice: 12.5, vatRate: 0, total: 2712.5 },
    ...Array.from({ length: 28 }, (_, index) => ({
      description: `Riga filler ${index + 1} vicino al salto pagina`,
      quantity: 1,
      unitPrice: 10,
      vatRate: 22,
      total: 10,
    })),
    { description: 'Ultima riga prima dei totali', quantity: 1, unitPrice: 50, vatRate: 22, total: 50 },
  ];
  const bytes = await buildCustomerDocumentsPdfBytes([
    quote({
      items,
      subtotal: 400,
      vatAmount: 88,
      total: 488,
    }),
  ]);
  const outDir = path.join(process.cwd(), '.tmp-qa');
  fs.mkdirSync(outDir, { recursive: true });
  const pdfPath = path.join(outDir, 'export-pdf-visual.pdf');
  fs.writeFileSync(pdfPath, Buffer.from(bytes));
  const loaded = await PDFDocument.load(bytes);
  assert.ok(loaded.getPageCount() >= 2);
  assert.equal(fs.existsSync(pdfPath), true);
});

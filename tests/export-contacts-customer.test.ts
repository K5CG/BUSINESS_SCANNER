import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as XLSX from 'xlsx';
import type { BusinessCard, Phone } from '../types';
import type { EmailEvidenceMetadata } from '../lib/email-evidence.ts';
import {
  CSV_UTF8_BOM,
  CUSTOMER_CONTACT_EXPORT_KEYS,
  CUSTOMER_CONTACTS_SHEET_NAME,
  buildCustomerContactsCsv,
  buildCustomerContactsExportFileName,
  buildCustomerContactsXlsxBytes,
  customerContactHeaders,
  escapeCsvCell,
  formatContactExportDate,
  mapContactToCustomerExportRow,
} from '../lib/export-contacts-customer.ts';

const root = process.cwd();
const createdAt = new Date(2026, 7, 14, 10, 5, 0);
const updatedAt = new Date(2026, 7, 14, 18, 30, 0);

function confirmedEmail(value: string): EmailEvidenceMetadata {
  return {
    value,
    rawValue: value,
    origin: 'user',
    pageIndex: 0,
    lineId: 1,
    rawOcr: value,
    transformations: ['user_confirmed'],
    confidence: 1,
    validationStatus: 'valid',
    requiresReview: false,
    confirmed: true,
  };
}

function rejectedEmail(value: string): EmailEvidenceMetadata {
  return {
    value,
    rawValue: value,
    origin: 'inferred',
    pageIndex: 0,
    lineId: 2,
    rawOcr: value,
    transformations: [],
    confidence: 0.2,
    validationStatus: 'invalid',
    requiresReview: true,
    confirmed: false,
  };
}

function card(overrides: Partial<BusinessCard> = {}): BusinessCard {
  return {
    id: 'contact-1',
    type: 'business_card',
    title: 'Mario Rossi - Acme',
    images: [],
    rawText: 'UNIQUE_RAW_OCR_TOKEN',
    confidence: { firstName: 0.99 },
    createdAt,
    updatedAt,
    firstName: 'Mario',
    lastName: 'Rossi',
    role: 'Direttore',
    company: 'Acme S.p.A.',
    emails: ['mario@acme.it'],
    emailEvidence: [confirmedEmail('mario@acme.it')],
    phones: [{ number: '+39 011 123456', type: 'work' }],
    website: 'https://acme.it',
    notes: 'Cliente storico',
    lastParserBuildId: 'parser-secret',
    ...overrides,
  };
}

test('maps a normal contact to customer-oriented columns', () => {
  const row = mapContactToCustomerExportRow(card());
  assert.equal(row.firstName, 'Mario');
  assert.equal(row.lastName, 'Rossi');
  assert.equal(row.company, 'Acme S.p.A.');
  assert.equal(row.role, 'Direttore');
  assert.equal(row.email, 'mario@acme.it');
  assert.equal(row.otherEmails, '');
  assert.equal(row.phone, '+39 011 123456');
  assert.equal(row.otherPhones, '');
  assert.equal(row.fax, '');
  assert.equal(row.website, 'https://acme.it');
  assert.equal(row.notes, 'Cliente storico');
  assert.equal(row.createdAt, '2026-08-14 10:05');
  assert.equal(row.updatedAt, '2026-08-14 18:30');
  assert.deepEqual(Object.keys(row), [...CUSTOMER_CONTACT_EXPORT_KEYS]);
});

test('splits multiple safe emails and excludes rejected evidence', () => {
  const row = mapContactToCustomerExportRow(
    card({
      emails: ['mario@acme.it', 'info@acme.it', 'bad@acme.it'],
      emailEvidence: [
        confirmedEmail('mario@acme.it'),
        confirmedEmail('info@acme.it'),
        rejectedEmail('bad@acme.it'),
      ],
    })
  );
  assert.equal(row.email, 'mario@acme.it');
  assert.equal(row.otherEmails, 'info@acme.it');
  assert.doesNotMatch(row.email + row.otherEmails, /bad@acme\.it/);
});

test('omits unconfirmed emails when evidence is missing', () => {
  const row = mapContactToCustomerExportRow(
    card({
      emails: ['legacy@acme.it'],
      emailEvidence: undefined,
    })
  );
  assert.equal(row.email, '');
  assert.equal(row.otherEmails, '');
});

test('maps work, mobile and fax without inventing unknown types', () => {
  const phones: Phone[] = [
    { number: '+39 333 111', type: 'mobile' },
    { number: '+39 011 222', type: 'work' },
    { number: '+39 011 333', type: 'fax' },
    { number: '+39 011 444' },
  ];
  const row = mapContactToCustomerExportRow(card({ phones }));
  assert.equal(row.phone, '+39 333 111');
  assert.equal(row.otherPhones, 'work: +39 011 222; +39 011 444');
  assert.equal(row.fax, '+39 011 333');
});

test('joins multiple fax values', () => {
  const row = mapContactToCustomerExportRow(
    card({
      phones: [
        { number: '111', type: 'work' },
        { number: '900', type: 'fax' },
        { number: '901', type: 'fax' },
      ],
    })
  );
  assert.equal(row.phone, '111');
  assert.equal(row.fax, '900; 901');
});

test('uses structured address fields when present', () => {
  const row = mapContactToCustomerExportRow(
    card({
      address: {
        street: 'Via Roma',
        civicNumber: '12',
        postalCode: '10100',
        city: 'Torino',
        full: 'Via Roma 12, 10100 Torino',
      },
    })
  );
  assert.equal(row.street, 'Via Roma');
  assert.equal(row.civicNumber, '12');
  assert.equal(row.postalCode, '10100');
  assert.equal(row.city, 'Torino');
  assert.equal(row.fullAddress, 'Via Roma 12, 10100 Torino');
});

test('leaves structured address columns blank when only full exists', () => {
  const row = mapContactToCustomerExportRow(
    card({
      address: { full: 'Commonwealth Avenue, Nr. 755 - 02215 - Boston' },
    })
  );
  assert.equal(row.street, '');
  assert.equal(row.civicNumber, '');
  assert.equal(row.postalCode, '');
  assert.equal(row.city, '');
  assert.equal(row.fullAddress, 'Commonwealth Avenue, Nr. 755 - 02215 - Boston');
});

test('keeps commas, quotes, newlines and accented characters', () => {
  const row = mapContactToCustomerExportRow(
    card({
      firstName: 'José',
      lastName: 'D\'Angelo',
      company: 'Rossi, Bianchi & "Figli"',
      notes: 'Linea 1\nLinea 2',
      address: { full: 'Via "Garibaldi", 1' },
    })
  );
  assert.equal(row.firstName, 'José');
  assert.equal(row.lastName, "D'Angelo");
  assert.equal(row.company, 'Rossi, Bianchi & "Figli"');
  assert.equal(row.notes, 'Linea 1\nLinea 2');
  assert.equal(row.fullAddress, 'Via "Garibaldi", 1');
});

test('missing optional fields become empty strings', () => {
  const row = mapContactToCustomerExportRow(
    card({
      role: '',
      website: undefined,
      notes: undefined,
      phones: [],
      emails: [],
      emailEvidence: [],
      address: undefined,
    })
  );
  assert.equal(row.role, '');
  assert.equal(row.website, '');
  assert.equal(row.notes, '');
  assert.equal(row.phone, '');
  assert.equal(row.email, '');
  assert.equal(row.street, '');
  assert.equal(row.fullAddress, '');
});

test('formats created and updated dates as YYYY-MM-DD HH:mm', () => {
  assert.equal(formatContactExportDate(createdAt), '2026-08-14 10:05');
  assert.equal(formatContactExportDate('not-a-date'), '');
  assert.equal(formatContactExportDate(undefined), '');
});

test('CSV uses Italian header order, quoting, BOM and no QA fields', () => {
  const csv = buildCustomerContactsCsv([
    card({
      firstName: 'José',
      company: 'Rossi, Bianchi & "Figli"',
      notes: 'Linea 1\nLinea 2',
      emails: ['mario@acme.it', 'bad@acme.it'],
      emailEvidence: [confirmedEmail('mario@acme.it'), rejectedEmail('bad@acme.it')],
    }),
    card({
      id: 'contact-2',
      firstName: 'Anna',
      lastName: 'Verdi',
      company: 'Beta',
      emails: ['anna@beta.it'],
      emailEvidence: [confirmedEmail('anna@beta.it')],
    }),
  ]);

  assert.ok(csv.startsWith(CSV_UTF8_BOM));
  assert.equal(Buffer.from(csv, 'utf8')[0], 0xef);
  assert.equal(Buffer.from(csv, 'utf8')[1], 0xbb);
  assert.equal(Buffer.from(csv, 'utf8')[2], 0xbf);

  const body = csv.slice(CSV_UTF8_BOM.length);
  const lines = body.trimEnd().split('\r\n');
  assert.equal(lines[0], customerContactHeaders('it').map(escapeCsvCell).join(','));
  assert.deepEqual(customerContactHeaders('it'), [
    'Nome',
    'Cognome',
    'Azienda',
    'Ruolo',
    'Email',
    'Altre email',
    'Telefono',
    'Altri telefoni',
    'Fax',
    'Sito web',
    'Via',
    'Numero civico',
    'CAP',
    'Città',
    'Indirizzo completo',
    'Note',
    'Data creazione',
    'Ultima modifica',
  ]);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /"José"/);
  assert.match(lines[1], /"Rossi, Bianchi & ""Figli"""/);
  assert.match(lines[1], /"Linea 1\nLinea 2"/);
  assert.match(lines[2], /"Anna"/);
  assert.doesNotMatch(csv, /UNIQUE_RAW_OCR_TOKEN/);
  assert.doesNotMatch(csv, /parser-secret/);
  assert.doesNotMatch(csv, /bad@acme\.it/);
  assert.doesNotMatch(csv, /extractionReview/);
  assert.doesNotMatch(csv, /emailEvidence/);
  assert.doesNotMatch(csv, /rawText/);
});

test('XLSX workbook has Contatti sheet and the same customer values', () => {
  const contacts = [
    card({
      phones: [
        { number: '111', type: 'mobile' },
        { number: '222', type: 'work' },
        { number: '900', type: 'fax' },
      ],
      address: { postalCode: '00100', full: 'Roma' },
    }),
  ];
  const bytes = buildCustomerContactsXlsxBytes(contacts, 'it');
  const workbook = XLSX.read(bytes, { type: 'array' });
  assert.deepEqual(workbook.SheetNames, [CUSTOMER_CONTACTS_SHEET_NAME]);
  const rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Contatti, {
    header: 1,
    raw: false,
    defval: '',
  });
  assert.deepEqual(rows[0], customerContactHeaders('it'));
  assert.equal(rows[1][0], 'Mario');
  assert.equal(rows[1][6], '111');
  assert.equal(rows[1][7], 'work: 222');
  assert.equal(rows[1][8], '900');
  assert.equal(rows[1][12], '00100');
  const csv = buildCustomerContactsCsv(contacts, 'it');
  const csvValues = csv
    .slice(CSV_UTF8_BOM.length)
    .trimEnd()
    .split('\r\n')[1]
    .split(',')
    .map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"'));
  assert.equal(csvValues[0], rows[1][0]);
  assert.equal(csvValues[6], rows[1][6]);
  assert.doesNotMatch(JSON.stringify(rows), /UNIQUE_RAW_OCR_TOKEN/);
});

test('filenames cover all, selected and batch scopes', () => {
  const exportedAt = new Date(2026, 7, 14, 9, 0, 0);
  assert.equal(
    buildCustomerContactsExportFileName({ kind: 'all' }, 'xlsx', exportedAt),
    'MyBizScanner_Contacts_2026-08-14.xlsx'
  );
  assert.equal(
    buildCustomerContactsExportFileName({ kind: 'selected' }, 'csv', exportedAt),
    'MyBizScanner_Contacts_Selected_2026-08-14.csv'
  );
  assert.equal(
    buildCustomerContactsExportFileName({ kind: 'batch', from: 1, to: 30 }, 'xlsx', exportedAt),
    'MyBizScanner_Contacts_1-30_2026-08-14.xlsx'
  );
});

test('Contacts UI uses one Esporta hub with Excel, CSV and diagnostic support', () => {
  const contacts = fs.readFileSync(path.join(root, 'app/(tabs)/contacts.tsx'), 'utf8');
  assert.match(contacts, /ExportHubMenu/);
  assert.match(contacts, /t\('export'\)/);
  assert.match(contacts, /EXPORT_HUB_ICONS\.xlsx/);
  assert.match(contacts, /EXPORT_HUB_ICONS\.csv/);
  assert.match(contacts, /EXPORT_HUB_ICONS\.diagnostic/);
  assert.match(contacts, /shareCustomerContactsExport/);
  assert.match(contacts, /confirmDiagnosticExport/);
  assert.match(contacts, /exportContactsQa/);
  assert.doesNotMatch(contacts, /download-outline/);
  assert.doesNotMatch(contacts, /t\('exportContacts'\)/);
  assert.doesNotMatch(contacts, /pdf/i);

  const it = JSON.parse(fs.readFileSync(path.join(root, 'i18n/it.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n/en.json'), 'utf8'));
  assert.equal(it.export, 'Esporta');
  assert.equal(it.exportDataSection, 'Esporta dati');
  assert.equal(it.exportSupportSection, 'Assistenza');
  assert.equal(it.exportQa, 'Export diagnostico');
  assert.equal(it.exportCustomerFormatXlsx, 'Excel (.xlsx)');
  assert.equal(it.exportCustomerFormatCsv, 'CSV');
  assert.equal(it.exportCustomerNoContacts, 'Nessun contatto da esportare.');
  assert.equal(en.export, 'Export');
  assert.equal(en.exportDataSection, 'Export data');
  assert.equal(en.exportSupportSection, 'Support');
  assert.equal(en.exportQa, 'Diagnostic export');
  assert.equal(en.exportCustomerNoContacts, 'No contacts to export.');
});

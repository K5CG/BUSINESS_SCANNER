import * as XLSX from 'xlsx';
import type { BusinessCard, Phone } from '../types';
import { getSafeContactEmails } from './email-evidence';

export const CUSTOMER_CONTACTS_SHEET_NAME = 'Contatti';
export const CSV_UTF8_BOM = '\uFEFF';
export const CUSTOMER_EXPORT_VALUE_SEPARATOR = '; ';

export const CUSTOMER_CONTACT_EXPORT_KEYS = [
  'firstName',
  'lastName',
  'company',
  'role',
  'email',
  'otherEmails',
  'phone',
  'otherPhones',
  'fax',
  'website',
  'street',
  'civicNumber',
  'postalCode',
  'city',
  'fullAddress',
  'notes',
  'createdAt',
  'updatedAt',
] as const;

export type CustomerContactExportKey = (typeof CUSTOMER_CONTACT_EXPORT_KEYS)[number];
export type CustomerContactExportRow = Record<CustomerContactExportKey, string>;
export type CustomerExportLocale = 'it' | 'en';
export type CustomerContactExportFormat = 'xlsx' | 'csv';
export type CustomerContactExportScope =
  | { kind: 'all' }
  | { kind: 'selected' }
  | { kind: 'batch'; from: number; to: number };

export const CUSTOMER_CONTACT_HEADERS_IT: Record<CustomerContactExportKey, string> = {
  firstName: 'Nome',
  lastName: 'Cognome',
  company: 'Azienda',
  role: 'Ruolo',
  email: 'Email',
  otherEmails: 'Altre email',
  phone: 'Telefono',
  otherPhones: 'Altri telefoni',
  fax: 'Fax',
  website: 'Sito web',
  street: 'Via',
  civicNumber: 'Numero civico',
  postalCode: 'CAP',
  city: 'Città',
  fullAddress: 'Indirizzo completo',
  notes: 'Note',
  createdAt: 'Data creazione',
  updatedAt: 'Ultima modifica',
};

export const CUSTOMER_CONTACT_HEADERS_EN: Record<CustomerContactExportKey, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  company: 'Company',
  role: 'Role',
  email: 'Email',
  otherEmails: 'Other emails',
  phone: 'Phone',
  otherPhones: 'Other phones',
  fax: 'Fax',
  website: 'Website',
  street: 'Street',
  civicNumber: 'Street number',
  postalCode: 'Postal code',
  city: 'City',
  fullAddress: 'Full address',
  notes: 'Notes',
  createdAt: 'Created',
  updatedAt: 'Last modified',
};

const KNOWN_VOICE_PHONE_TYPES = new Set(['mobile', 'work', 'other']);

export function customerExportLocale(language: string | undefined): CustomerExportLocale {
  return (language ?? '').toLowerCase().startsWith('en') ? 'en' : 'it';
}

export function customerContactHeaders(locale: CustomerExportLocale = 'it'): string[] {
  const labels = locale === 'en' ? CUSTOMER_CONTACT_HEADERS_EN : CUSTOMER_CONTACT_HEADERS_IT;
  return CUSTOMER_CONTACT_EXPORT_KEYS.map((key) => labels[key]);
}

export function formatContactExportDate(value: Date | string | undefined): string {
  const date = coerceExportDate(value);
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatCustomerExportFileDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function buildCustomerContactsExportFileName(
  scope: CustomerContactExportScope,
  format: CustomerContactExportFormat,
  exportedAt: Date = new Date()
): string {
  const stamp = formatCustomerExportFileDate(exportedAt);
  const ext = format === 'xlsx' ? 'xlsx' : 'csv';
  if (scope.kind === 'selected') {
    return `MyBizScanner_Contacts_Selected_${stamp}.${ext}`;
  }
  if (scope.kind === 'batch') {
    return `MyBizScanner_Contacts_${scope.from}-${scope.to}_${stamp}.${ext}`;
  }
  return `MyBizScanner_Contacts_${stamp}.${ext}`;
}

export function mapContactToCustomerExportRow(contact: BusinessCard): CustomerContactExportRow {
  const emails = getSafeContactEmails(contact);
  const phones = mapCustomerPhones(contact.phones);
  const address = contact.address;
  return {
    firstName: text(contact.firstName),
    lastName: text(contact.lastName),
    company: text(contact.company),
    role: text(contact.role),
    email: emails[0] ?? '',
    otherEmails: emails.slice(1).join(CUSTOMER_EXPORT_VALUE_SEPARATOR),
    phone: phones.phone,
    otherPhones: phones.otherPhones,
    fax: phones.fax,
    website: text(contact.website),
    street: text(address?.street),
    civicNumber: text(address?.civicNumber),
    postalCode: text(address?.postalCode),
    city: text(address?.city),
    fullAddress: text(address?.full),
    notes: text(contact.notes),
    createdAt: formatContactExportDate(contact.createdAt),
    updatedAt: formatContactExportDate(contact.updatedAt),
  };
}

export function customerExportRowValues(row: CustomerContactExportRow): string[] {
  return CUSTOMER_CONTACT_EXPORT_KEYS.map((key) => row[key]);
}

export function escapeCsvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildCustomerContactsCsv(
  contacts: BusinessCard[],
  locale: CustomerExportLocale = 'it'
): string {
  const headerLine = customerContactHeaders(locale).map(escapeCsvCell).join(',');
  const dataLines = contacts.map((contact) =>
    customerExportRowValues(mapContactToCustomerExportRow(contact)).map(escapeCsvCell).join(',')
  );
  return `${CSV_UTF8_BOM}${[headerLine, ...dataLines].join('\r\n')}\r\n`;
}

export function buildCustomerContactsAoa(
  contacts: BusinessCard[],
  locale: CustomerExportLocale = 'it'
): string[][] {
  return [
    customerContactHeaders(locale),
    ...contacts.map((contact) => customerExportRowValues(mapContactToCustomerExportRow(contact))),
  ];
}

export function buildCustomerContactsXlsxBytes(
  contacts: BusinessCard[],
  locale: CustomerExportLocale = 'it'
): Uint8Array {
  const aoa = buildCustomerContactsAoa(contacts, locale);
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  forceWorksheetTextCells(worksheet);
  worksheet['!cols'] = columnWidths(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, CUSTOMER_CONTACTS_SHEET_NAME);
  const output = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellDates: false });
  return toUint8Array(output);
}

function mapCustomerPhones(phones: Phone[] | undefined): {
  phone: string;
  otherPhones: string;
  fax: string;
} {
  const list = (phones ?? []).filter((item) => text(item.number).length > 0);
  const voice = list.filter((item) => item.type !== 'fax');
  const fax = list.filter((item) => item.type === 'fax');
  return {
    phone: text(voice[0]?.number),
    otherPhones: voice.slice(1).map(formatAdditionalPhone).join(CUSTOMER_EXPORT_VALUE_SEPARATOR),
    fax: fax.map((item) => text(item.number)).join(CUSTOMER_EXPORT_VALUE_SEPARATOR),
  };
}

function formatAdditionalPhone(phone: Phone): string {
  const number = text(phone.number);
  if (phone.type && KNOWN_VOICE_PHONE_TYPES.has(phone.type)) {
    return `${phone.type}: ${number}`;
  }
  return number;
}

function text(value: string | undefined): string {
  return value?.trim() ?? '';
}

function coerceExportDate(value: Date | string | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function forceWorksheetTextCells(worksheet: XLSX.WorkSheet): void {
  const ref = worksheet['!ref'];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = worksheet[address];
      if (!cell) continue;
      cell.t = 's';
      cell.v = String(cell.v ?? '');
      delete cell.w;
      delete cell.z;
    }
  }
}

function columnWidths(aoa: string[][]): Array<{ wch: number }> {
  const columnCount = aoa[0]?.length ?? 0;
  return Array.from({ length: columnCount }, (_, index) => {
    let maxLen = 12;
    for (const row of aoa) {
      const cell = row[index] ?? '';
      maxLen = Math.max(maxLen, Math.min(40, cell.length + 2));
    }
    return { wch: maxLen };
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

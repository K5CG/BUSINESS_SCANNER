import type { BusinessCard, Phone } from '../types';
import { getSafeContactEmails } from './email-evidence';

/** RFC 2426 text escaping for vCard 3.0 values. */
export function escapeVCardText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\n|\r/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

export function vCardTelType(
  type: Phone['type'] | undefined
): 'CELL' | 'WORK' | 'FAX' | undefined {
  if (type === 'mobile') return 'CELL';
  if (type === 'work') return 'WORK';
  if (type === 'fax') return 'FAX';
  return undefined;
}

function vCardTelLine(phone: Phone): string | null {
  const number = phone.number?.trim();
  if (!number) return null;
  const mapped = vCardTelType(phone.type);
  const escaped = escapeVCardText(number);
  return mapped ? `TEL;TYPE=${mapped}:${escaped}` : `TEL:${escaped}`;
}

export function sanitizeVCardFileToken(value: string): string {
  return value
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f.]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
}

export function buildVCardFileName(contact: Pick<BusinessCard, 'firstName' | 'lastName'>): string {
  const first = sanitizeVCardFileToken(contact.firstName ?? '');
  const last = sanitizeVCardFileToken(contact.lastName ?? '');
  const stem = [first, last].filter(Boolean).join('_') || 'Contact';
  return `MyBizScanner_${stem}.vcf`;
}

export function exportToVCard(contact: BusinessCard): string {
  const emails = getSafeContactEmails(contact);
  const firstName = contact.firstName ?? '';
  const lastName = contact.lastName ?? '';
  const displayName = [firstName, lastName].filter((part) => part.trim()).join(' ').trim();
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapeVCardText(displayName)}`,
    `N:${escapeVCardText(lastName)};${escapeVCardText(firstName)};;;`,
  ];

  if (contact.company?.trim()) lines.push(`ORG:${escapeVCardText(contact.company.trim())}`);
  if (contact.role?.trim()) lines.push(`TITLE:${escapeVCardText(contact.role.trim())}`);
  emails.forEach((email) => lines.push(`EMAIL:${escapeVCardText(email)}`));
  contact.phones.forEach((phone) => {
    const line = vCardTelLine(phone);
    if (line) lines.push(line);
  });
  if (contact.website?.trim()) lines.push(`URL:${escapeVCardText(contact.website.trim())}`);
  if (contact.address?.full?.trim()) {
    lines.push(`ADR:;;${escapeVCardText(contact.address.full.trim())};;;;`);
  }
  if (contact.notes?.trim()) lines.push(`NOTE:${escapeVCardText(contact.notes)}`);

  lines.push('END:VCARD');
  return `${lines.join('\r\n')}\r\n`;
}

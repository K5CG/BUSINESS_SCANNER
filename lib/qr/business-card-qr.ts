import { Camera } from 'expo-camera';
import type { Address, BusinessCard, Phone } from '../../types';
import type { EmailEvidenceMetadata } from '../email-evidence';
import {
  isValidEmailFormat,
  normalizeEmail,
} from '../parser-engine/validators/email';

interface QrContactData {
  firstName: string;
  lastName: string;
  role: string;
  company: string;
  emails: string[];
  phones: Phone[];
  address?: Address;
  website?: string;
  notes?: string;
}

interface BarcodeResultWithRaw {
  data?: string;
  raw?: string;
  extra?: { raw?: string; rawValue?: string };
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function validEmailsFromValue(value: string): string[] {
  const matches = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi) ?? [];
  return uniqueStrings(
    matches
      .map((email) => normalizeEmail(email))
      .filter(isValidEmailFormat),
  );
}

function unescapeValue(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\:/g, ':')
    .replace(/\\\\/g, '\\')
    .trim();
}

function splitEscaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === separator) {
      parts.push(unescapeValue(current));
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  parts.push(unescapeValue(current));
  return parts;
}

function splitDisplayName(fullName: string): { firstName: string; lastName: string } {
  const normalized = fullName.trim().replace(/\s+/g, ' ');
  if (!normalized) return { firstName: '', lastName: '' };
  const parts = normalized.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1],
  };
}

function phoneType(types: string[]): Phone['type'] {
  if (types.includes('CELL') || types.includes('MOBILE')) return 'mobile';
  if (types.includes('FAX')) return 'fax';
  if (types.includes('WORK')) return 'work';
  return 'other';
}

function unfoldVCard(raw: string): string[] {
  const physical = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines.map((line) => line.trim()).filter(Boolean);
}

function propertyName(left: string): string {
  const raw = left.split(';', 1)[0].trim();
  return (raw.includes('.') ? raw.slice(raw.lastIndexOf('.') + 1) : raw).toUpperCase();
}

function propertyTypes(left: string): string[] {
  return left
    .split(';')
    .slice(1)
    .flatMap((part) => {
      const [key, rawValue] = part.split('=', 2);
      if (!rawValue) return [key];
      return key.toUpperCase() === 'TYPE' ? rawValue.split(',') : [];
    })
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function addressFromVCard(value: string): Address | undefined {
  const parts = splitEscaped(value, ';');
  const [, extended = '', street = '', city = '', region = '', postalCode = '', country = ''] = parts;
  const streetValue = [street, extended].filter(Boolean).join(' ').trim();
  const full = [streetValue, postalCode, city, region, country].filter(Boolean).join(', ');
  if (!full) return undefined;
  return {
    street: streetValue || undefined,
    city: city || undefined,
    postalCode: postalCode || undefined,
    region: region || undefined,
    country: country || undefined,
    full,
  };
}

function parseVCard(raw: string): QrContactData | null {
  if (!/^BEGIN:VCARD(?:\r?\n|$)/i.test(raw.trim())) return null;

  let firstName = '';
  let lastName = '';
  let formattedName = '';
  let role = '';
  let company = '';
  let address: Address | undefined;
  let website = '';
  let notes = '';
  const emails: string[] = [];
  const phones: Phone[] = [];

  for (const line of unfoldVCard(raw)) {
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) continue;
    const left = line.slice(0, colonIndex);
    const encodedValue = line.slice(colonIndex + 1);
    const value = unescapeValue(encodedValue);
    const name = propertyName(left);

    if (name === 'N') {
      const [family = '', given = '', additional = '', prefix = '', suffix = ''] = splitEscaped(encodedValue, ';');
      firstName = [prefix, given, additional].filter(Boolean).join(' ').trim();
      lastName = [family, suffix].filter(Boolean).join(' ').trim();
    } else if (name === 'FN') {
      formattedName = value;
    } else if (name === 'ORG') {
      company = splitEscaped(encodedValue, ';').filter(Boolean).join(' - ');
    } else if (name === 'TITLE' || name === 'ROLE') {
      if (!role) role = value;
    } else if (name === 'EMAIL') {
      emails.push(...validEmailsFromValue(value.replace(/^mailto:/i, '').trim()));
    } else if (name === 'TEL') {
      const number = value.replace(/^tel:/i, '').trim();
      if (number) phones.push({ number, type: phoneType(propertyTypes(left)) });
    } else if (name === 'ADR') {
      if (!address) address = addressFromVCard(encodedValue);
    } else if (name === 'URL') {
      if (!website) website = value;
    } else if (name === 'NOTE') {
      if (!notes) notes = value;
    }
  }

  if (!firstName && !lastName && formattedName) {
    ({ firstName, lastName } = splitDisplayName(formattedName));
  }

  return {
    firstName,
    lastName,
    role,
    company,
    emails: uniqueStrings(emails),
    phones: phones.filter(
      (phone, index, all) =>
        all.findIndex((candidate) => candidate.number.toLowerCase() === phone.number.toLowerCase()) === index,
    ),
    address,
    website: website || undefined,
    notes: notes || undefined,
  };
}

function parseMecardFields(raw: string): Map<string, string[]> {
  const body = raw.trim().replace(/^MECARD:/i, '').replace(/;\s*$/, '');
  const fields = new Map<string, string[]>();
  for (const segment of splitEscaped(body, ';')) {
    const colon = segment.indexOf(':');
    if (colon <= 0) continue;
    const key = segment.slice(0, colon).trim().toUpperCase();
    const value = unescapeValue(segment.slice(colon + 1));
    if (!value) continue;
    const current = fields.get(key) ?? [];
    current.push(value);
    fields.set(key, current);
  }
  return fields;
}

function parseMeCard(raw: string): QrContactData | null {
  if (!/^MECARD:/i.test(raw.trim())) return null;
  const fields = parseMecardFields(raw);
  const name = fields.get('N')?.[0]?.trim() ?? '';
  let firstName = '';
  let lastName = '';
  if (name.includes(',')) {
    const [family = '', given = ''] = name.split(',', 2).map((value) => value.trim());
    firstName = given;
    lastName = family;
  } else {
    ({ firstName, lastName } = splitDisplayName(name));
  }

  const addressText = fields.get('ADR')?.[0]?.trim() ?? '';
  return {
    firstName,
    lastName,
    role: fields.get('TITLE')?.[0]?.trim() ?? '',
    company: fields.get('ORG')?.[0]?.trim() ?? '',
    emails: uniqueStrings((fields.get('EMAIL') ?? []).flatMap(validEmailsFromValue)),
    phones: uniqueStrings(fields.get('TEL') ?? []).map((number) => ({
      number,
      type: 'other' as const,
    })),
    address: addressText ? { full: addressText } : undefined,
    website: fields.get('URL')?.[0]?.trim() || undefined,
    notes: fields.get('NOTE')?.[0]?.trim() || undefined,
  };
}

export function parseContactPayload(raw: string): QrContactData | null {
  return parseVCard(raw) ?? parseMeCard(raw);
}

function rawBarcodePayload(result: unknown): string {
  const value = result as BarcodeResultWithRaw;
  const candidates = [value.raw, value.extra?.rawValue, value.extra?.raw, value.data];
  for (const candidate of candidates) {
    const payload = clean(candidate);
    if (payload) return payload;
  }
  return '';
}

/** Reads QR from already captured card images. Never opens another camera or invokes OCR. */
export async function scanBusinessCardQrPayloads(
  imageUris: readonly string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const payloads: string[] = [];

  for (const imageUri of imageUris) {
    try {
      const results = await Camera.scanFromURLAsync(imageUri, ['qr']);
      for (const result of results) {
        const payload = rawBarcodePayload(result);
        if (!payload || seen.has(payload)) continue;
        seen.add(payload);
        payloads.push(payload);
      }
    } catch (error) {
      console.warn('[BusinessCardQR] image_scan_skipped', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.warn('[BusinessCardQR] scan_complete', {
    images: imageUris.length,
    qrCount: payloads.length,
    structuredContacts: payloads.filter((payload) => Boolean(parseContactPayload(payload))).length,
  });
  return payloads;
}

function normalizedComparable(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[\s.,;:/\\()\-]+/g, '');
}

function phoneKey(value: string): string {
  let digits = value.trim().replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits;
}

function mergePhonesAuthoritative(
  current: readonly Phone[],
  incoming: readonly Phone[],
): Phone[] {
  if (!incoming.length) return current.map((phone) => ({ ...phone }));

  const qrPhones = incoming
    .filter((phone) => Boolean(phoneKey(phone.number)))
    .filter(
      (phone, index, all) =>
        all.findIndex((candidate) => phoneKey(candidate.number) === phoneKey(phone.number)) === index,
    )
    .map((phone) => ({ ...phone }));

  const qrKeys = new Set(qrPhones.map((phone) => phoneKey(phone.number)));
  const qrSpecificTypes = new Set(
    qrPhones
      .map((phone) => phone.type)
      .filter((type) => type !== 'other'),
  );

  const preservedOcr = current
    .filter((phone) => {
      const key = phoneKey(phone.number);
      if (!key || qrKeys.has(key)) return false;
      // If QR explicitly supplies a typed number, it is authoritative for that
      // same category. Untyped QR numbers do not erase additional OCR numbers.
      return phone.type === 'other' || !qrSpecificTypes.has(phone.type);
    })
    .map((phone) => ({ ...phone }));

  return [...qrPhones, ...preservedOcr];
}

export function hasAuthoritativeBusinessCardQrPayload(
  payloads: readonly string[],
): boolean {
  return payloads.some((payload) => {
    const contact = parseContactPayload(payload);
    if (!contact) return false;
    const hasIdentity = Boolean(
      clean(contact.firstName) ||
      clean(contact.lastName) ||
      clean(contact.company),
    );
    const hasContactDetail = Boolean(
      contact.emails.length ||
      contact.phones.length ||
      clean(contact.website) ||
      clean(contact.address?.full) ||
      clean(contact.address?.street) ||
      clean(contact.role) ||
      clean(contact.notes),
    );
    return hasIdentity && hasContactDetail;
  });
}

function qrEmailEvidence(
  card: BusinessCard,
  qrEmails: readonly string[],
): EmailEvidenceMetadata[] | undefined {
  const normalizedQr = uniqueStrings(
    qrEmails
      .flatMap(validEmailsFromValue)
      .map((email) => normalizeEmail(email))
      .filter(isValidEmailFormat),
  );
  if (!normalizedQr.length) return card.emailEvidence;

  const existing = card.emailEvidence ?? [];
  const byValue = new Map<string, EmailEvidenceMetadata>();
  for (const evidence of existing) {
    byValue.set(normalizeEmail(evidence.value).toLowerCase(), evidence);
  }

  return normalizedQr.map((email) => {
    const previous = byValue.get(email.toLowerCase());
    return {
      ...(previous ?? {}),
      value: email,
      rawValue: email,
      origin: 'observed',
      pageIndex: null,
      lineId: null,
      rawOcr: previous?.rawOcr ?? '',
      transformations: uniqueStrings([
        ...(previous?.transformations ?? []),
        'qr_payload_authoritative',
      ]),
      confidence: 1,
      validationStatus: 'valid',
      requiresReview: false,
      confirmed: true,
    };
  });
}

function mergeAddress(current: Address | undefined, incoming: Address | undefined): Address | undefined {
  if (!incoming) return current;
  if (!current) return { ...incoming };
  return {
    ...current,
    street: incoming.street || current.street,
    civicNumber: incoming.civicNumber || current.civicNumber,
    city: incoming.city || current.city,
    postalCode: incoming.postalCode || current.postalCode,
    region: incoming.region || current.region,
    country: incoming.country || current.country,
    full: incoming.full || current.full,
  };
}

function appendDistinctNote(current: string | undefined, incoming: string | undefined, role: string): string | undefined {
  const value = clean(incoming);
  if (!value) return current;
  if (normalizedComparable(value) === normalizedComparable(role)) return current;
  if (!current?.trim()) return value;
  if (normalizedComparable(current).includes(normalizedComparable(value))) return current;
  return `${current.trim()}\n${value}`;
}

/** OCR/Parser runs unchanged first. Structured QR then becomes authoritative where it supplies a field. */
export function enrichBusinessCardWithQr(
  card: BusinessCard,
  payloads: readonly string[],
): BusinessCard {
  const contacts = payloads
    .map(parseContactPayload)
    .filter((value): value is QrContactData => Boolean(value));
  if (!contacts.length) return card;

  let next: BusinessCard = {
    ...card,
    emails: [...card.emails],
    phones: card.phones.map((phone) => ({ ...phone })),
    address: card.address ? { ...card.address } : undefined,
    confidence: { ...card.confidence },
    extractionReview: card.extractionReview
      ? {
          ...card.extractionReview,
          reviewFields: [...card.extractionReview.reviewFields],
        }
      : undefined,
  };

  const qrEmails: string[] = [];
  const authoritativeReviewFields = new Set<string>();
  const overridden: string[] = [];
  let matched = 0;
  let added = 0;
  let conflicts = 0;

  const applyScalar = (
    field: 'firstName' | 'lastName' | 'company' | 'role',
    incoming: string,
  ) => {
    const value = clean(incoming);
    if (!value) return;
    const current = clean(next[field]);
    if (!current) {
      next[field] = value;
      added += 1;
    } else if (normalizedComparable(current) === normalizedComparable(value)) {
      matched += 1;
    } else {
      next[field] = value;
      conflicts += 1;
      overridden.push(field);
    }
    next.confidence[field] = 1;
    authoritativeReviewFields.add(field);
  };

  for (const contact of contacts) {
    applyScalar('firstName', contact.firstName);
    applyScalar('lastName', contact.lastName);
    applyScalar('company', contact.company);
    applyScalar('role', contact.role);

    if (contact.website) {
      const value = clean(contact.website);
      if (!next.website?.trim()) {
        next.website = value;
        added += 1;
      } else if (normalizedComparable(next.website) === normalizedComparable(value)) {
        matched += 1;
      } else {
        next.website = value;
        conflicts += 1;
        overridden.push('website');
      }
      next.confidence.website = 1;
      authoritativeReviewFields.add('website');
    }

    if (contact.address) {
      const currentAddress = next.address?.full || next.address?.street || '';
      const incomingAddress = contact.address.full || contact.address.street || '';
      if (!currentAddress) {
        added += 1;
      } else if (
        normalizedComparable(currentAddress) === normalizedComparable(incomingAddress)
      ) {
        matched += 1;
      } else if (incomingAddress) {
        conflicts += 1;
        overridden.push('address');
      }
      next.address = mergeAddress(next.address, contact.address);
      next.confidence.address = 1;
      authoritativeReviewFields.add('address');
    }

    qrEmails.push(...contact.emails);

    if (contact.phones.length) {
      const previousPhones = next.phones.map((phone) => ({ ...phone }));
      const previousKeys = new Set(previousPhones.map((phone) => phoneKey(phone.number)).filter(Boolean));
      const qrKeys = new Set(contact.phones.map((phone) => phoneKey(phone.number)).filter(Boolean));
      const matchedPhones = [...qrKeys].filter((key) => previousKeys.has(key)).length;
      matched += matchedPhones;
      if (previousPhones.length && matchedPhones < contact.phones.length) {
        conflicts += 1;
        overridden.push('phones');
      } else if (!previousPhones.length) {
        added += contact.phones.length;
      }
      next.phones = mergePhonesAuthoritative(previousPhones, contact.phones);
      next.confidence.phones = 1;
      authoritativeReviewFields.add('phones');
    }

    next.notes = appendDistinctNote(next.notes, contact.notes, next.role);
  }

  const validQrEmails = uniqueStrings(
    qrEmails
      .flatMap(validEmailsFromValue)
      .map((email) => normalizeEmail(email))
      .filter(isValidEmailFormat),
  );
  if (validQrEmails.length) {
    const currentEmails = uniqueStrings(
      next.emails
        .map((email) => normalizeEmail(email))
        .filter(isValidEmailFormat),
    );
    const currentKeys = new Set(currentEmails.map((email) => email.toLowerCase()));
    const qrKeys = new Set(validQrEmails.map((email) => email.toLowerCase()));
    const sameSet =
      currentKeys.size === qrKeys.size &&
      [...qrKeys].every((key) => currentKeys.has(key));

    if (sameSet) {
      matched += validQrEmails.length;
    } else {
      if (currentEmails.length) {
        conflicts += 1;
        overridden.push('emails');
      } else {
        added += validQrEmails.length;
      }
      next.emails = validQrEmails;
    }
    next.emailEvidence = qrEmailEvidence(next, validQrEmails);
    next.confidence.emails = 1;
    authoritativeReviewFields.add('emails');
  }

  if (next.extractionReview && authoritativeReviewFields.size) {
    const review = { ...next.extractionReview };
    for (const field of authoritativeReviewFields) {
      const key = field as
        | 'firstName'
        | 'lastName'
        | 'company'
        | 'role'
        | 'emails'
        | 'phones'
        | 'website'
        | 'address';
      const currentField = review[key];
      if (!currentField) continue;

      let value: unknown;
      if (key === 'emails') value = [...next.emails];
      else if (key === 'phones') value = next.phones.map((phone) => ({ ...phone }));
      else if (key === 'address') value = next.address ?? null;
      else value = next[key];

      (review as any)[key] = {
        ...currentField,
        value,
        confidence: 'high',
        score: 1,
        source: 'observed',
        reasons: uniqueStrings([
          ...(currentField.reasons ?? []),
          'qr_payload_authoritative',
        ]),
      };
    }
    review.reviewFields = review.reviewFields.filter(
      (field) => !authoritativeReviewFields.has(field),
    );
    review.needsReview = review.reviewFields.length > 0;
    review.emailEvidence = next.emailEvidence;
    next.extractionReview = review;
  }

  console.warn('[BusinessCardQR] merge_complete', {
    structuredContacts: contacts.length,
    matched,
    added,
    conflicts,
    qrAuthoritative: true,
    overridden: uniqueStrings(overridden),
  });
  return next;
}

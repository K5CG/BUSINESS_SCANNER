import type { Address, BusinessCard } from '../types';

export interface QaExpectedCard {
  firstName?: string;
  lastName?: string;
  roleContains?: string[];
  companyContains?: string[];
  emailsContain?: string[];
  phonesContainDigits?: string[];
  websiteContains?: string[];
  addressContains?: string[];
  minAddressCount?: number;
  forbidIdentityContains?: string[];
  forbidCompanyContains?: string[];
  forbidAddressContains?: string[];
  allowEmptyOcrPages?: number[];
}

export interface QaAssertion {
  id: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
  severity: 'error' | 'warning';
}

export interface QaCardEvaluation {
  pass: boolean;
  errors: number;
  warnings: number;
  assertions: QaAssertion[];
}

export function normalizeQaText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[“”„‟\"'’`´]/g, '')
    .replace(/[^\p{L}\p{N}@.+&/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digits(value: unknown): string {
  return String(value ?? '').replace(/\D+/g, '');
}

function containsNormalized(actual: unknown, expected: string): boolean {
  const a = normalizeQaText(actual);
  const e = normalizeQaText(expected);
  return !!e && a.includes(e);
}

function addressText(address?: Address | null): string {
  if (!address) return '';
  return [
    address.full,
    address.street,
    address.civicNumber,
    address.postalCode,
    address.city,
    address.region,
    address.country,
  ].filter(Boolean).join(' | ');
}

export function collectCardAddressTexts(card: Pick<BusinessCard, 'address' | 'extractionReview'>): string[] {
  const primary = addressText(card.address);
  const alternatives = (card.extractionReview?.addressAlternatives ?? []).map(addressText);
  return [primary, ...alternatives].filter(Boolean);
}

export function evaluateQaBusinessCard(
  card: Pick<BusinessCard,
    'firstName' | 'lastName' | 'role' | 'company' | 'emails' | 'phones' | 'website' | 'address' | 'extractionReview'>,
  expected: QaExpectedCard,
  pageTexts: readonly string[] = [],
): QaCardEvaluation {
  const assertions: QaAssertion[] = [];
  const add = (id: string, pass: boolean, exp: unknown, actual: unknown, severity: 'error' | 'warning' = 'error') => {
    assertions.push({ id, pass, expected: exp, actual, severity });
  };

  if (expected.firstName !== undefined) {
    add('firstName', normalizeQaText(card.firstName) === normalizeQaText(expected.firstName), expected.firstName, card.firstName);
  }
  if (expected.lastName !== undefined) {
    add('lastName', normalizeQaText(card.lastName) === normalizeQaText(expected.lastName), expected.lastName, card.lastName);
  }
  for (const token of expected.roleContains ?? []) {
    add(`role:${token}`, containsNormalized(card.role, token), token, card.role);
  }
  for (const token of expected.companyContains ?? []) {
    add(`company:${token}`, containsNormalized(card.company, token), token, card.company);
  }
  for (const email of expected.emailsContain ?? []) {
    add(
      `email:${email}`,
      card.emails.some((actual) => normalizeQaText(actual) === normalizeQaText(email)),
      email,
      card.emails,
    );
  }
  for (const expectedDigits of expected.phonesContainDigits ?? []) {
    const target = digits(expectedDigits);
    add(
      `phone:${expectedDigits}`,
      card.phones.some((phone) => {
        const value = digits(phone.number);
        return value === target || value.endsWith(target) || target.endsWith(value);
      }),
      expectedDigits,
      card.phones.map((phone) => phone.number),
    );
  }
  for (const token of expected.websiteContains ?? []) {
    add(`website:${token}`, containsNormalized(card.website, token), token, card.website ?? '');
  }

  const addresses = collectCardAddressTexts(card);
  const allAddresses = addresses.join(' || ');
  for (const token of expected.addressContains ?? []) {
    add(`address:${token}`, containsNormalized(allAddresses, token), token, addresses);
  }
  if (expected.minAddressCount !== undefined) {
    add('addressCount', addresses.length >= expected.minAddressCount, `>=${expected.minAddressCount}`, addresses.length);
  }

  const identity = `${card.firstName} ${card.lastName}`;
  for (const token of expected.forbidIdentityContains ?? []) {
    add(`forbidIdentity:${token}`, !containsNormalized(identity, token), `NOT ${token}`, identity);
  }
  for (const token of expected.forbidCompanyContains ?? []) {
    add(`forbidCompany:${token}`, !containsNormalized(card.company, token), `NOT ${token}`, card.company);
  }
  for (const token of expected.forbidAddressContains ?? []) {
    add(`forbidAddress:${token}`, !containsNormalized(allAddresses, token), `NOT ${token}`, addresses);
  }

  const allowedEmpty = new Set(expected.allowEmptyOcrPages ?? []);
  pageTexts.forEach((text, pageIndex) => {
    const readable = normalizeQaText(text).length >= 2;
    add(
      `pageOcr:${pageIndex}`,
      readable,
      allowedEmpty.has(pageIndex) ? 'OCR optional; image retained even when OCR is empty' : 'non-empty OCR',
      { chars: text.trim().length },
      allowedEmpty.has(pageIndex) ? 'warning' : 'error',
    );
  });

  const errors = assertions.filter((item) => !item.pass && item.severity === 'error').length;
  const warnings = assertions.filter((item) => !item.pass && item.severity === 'warning').length;
  return { pass: errors === 0, errors, warnings, assertions };
}

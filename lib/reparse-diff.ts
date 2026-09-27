import type { BusinessCard } from '../types';

const TRACKED_SCALAR_FIELDS = [
  'firstName',
  'lastName',
  'company',
  'role',
  'website',
  'vatNumber',
  'taxCode',
] as const;

export type ReparseFieldKey =
  | (typeof TRACKED_SCALAR_FIELDS)[number]
  | 'emails'
  | 'phones'
  | 'address';

export interface ReparseFieldChange {
  field: ReparseFieldKey;
  before: string;
  after: string;
}

function norm(value: unknown): string {
  if (value == null) return '';
  return String(value).trim();
}

function emailState(card: BusinessCard): string {
  return JSON.stringify({
    emails: card.emails ?? [],
    evidence:
      card.emailEvidence === undefined
        ? { present: false }
        : { present: true, value: card.emailEvidence },
  });
}

function emailDisplay(card: BusinessCard): string {
  return emailState(card);
}

function phoneState(card: BusinessCard): string {
  return JSON.stringify(card.phones ?? []);
}

function phoneDisplay(card: BusinessCard): string {
  return phoneState(card);
}

function addressState(card: BusinessCard): string {
  return JSON.stringify(card.address ?? null);
}

export function diffReparseCard(before: BusinessCard, after: BusinessCard): ReparseFieldChange[] {
  const changes: ReparseFieldChange[] = [];
  for (const field of TRACKED_SCALAR_FIELDS) {
    const b = norm(before[field]);
    const a = norm(after[field]);
    if (b !== a) changes.push({ field, before: b, after: a });
  }
  if (emailState(before) !== emailState(after)) {
    changes.push({
      field: 'emails',
      before: emailDisplay(before),
      after: emailDisplay(after),
    });
  }
  if (phoneState(before) !== phoneState(after)) {
    changes.push({
      field: 'phones',
      before: phoneDisplay(before),
      after: phoneDisplay(after),
    });
  }
  const addrBefore = addressState(before);
  const addrAfter = addressState(after);
  if (addrBefore !== addrAfter) {
    changes.push({ field: 'address', before: addrBefore, after: addrAfter });
  }
  return changes;
}

export function reparseCardFingerprint(card: BusinessCard): string {
  return [
    card.firstName,
    card.lastName,
    card.company,
    card.role,
    card.address?.full ?? '',
    (card.emails ?? []).join(','),
  ]
    .map(norm)
    .join('|');
}

import type { BusinessCard } from '../types';
import { getSafeContactEmails } from './email-evidence';

const MIN_QUERY_LEN = 3;

export function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Testo indicizzabile per ricerca contatti (nome, azienda, email, ecc.). */
export function contactSearchBlob(card: BusinessCard): string {
  const parts = [
    card.firstName,
    card.lastName,
    card.company,
    card.role,
    card.title,
    card.website,
    card.vatNumber,
    card.taxCode,
    card.notes,
    card.rawText,
    ...getSafeContactEmails(card),
    ...(card.phones ?? []).map((p) => p.number),
    card.address?.full,
    card.address?.street,
    card.address?.city,
    card.address?.postalCode,
  ];
  return normalizeSearchText(parts.filter(Boolean).join(' '));
}

export function contactMatchesQuery(card: BusinessCard, query: string): boolean {
  const q = normalizeSearchText(query.trim());
  const isShortAlphanumericIdentifier = q.length >= 2 && /\d/.test(q) && /[a-z]/i.test(q);
  if (q.length < MIN_QUERY_LEN && !isShortAlphanumericIdentifier) return true;
  return contactSearchBlob(card).includes(q);
}

export function contactDisplayName(card: BusinessCard, fallback = ''): string {
  const name = [card.firstName, card.lastName].filter(Boolean).join(' ');
  return name || card.company || card.title || fallback;
}

export type ContactSortMode = 'date' | 'alpha';

export function sortContacts(
  list: BusinessCard[],
  mode: ContactSortMode,
  labelFallback = ''
): BusinessCard[] {
  const copy = [...list];
  if (mode === 'alpha') {
    copy.sort((a, b) =>
      contactDisplayName(a, labelFallback).localeCompare(contactDisplayName(b, labelFallback), undefined, {
        sensitivity: 'base',
      })
    );
    return copy;
  }
  copy.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return tb - ta;
  });
  return copy;
}

export const CONTACT_SEARCH_MIN_LEN = MIN_QUERY_LEN;

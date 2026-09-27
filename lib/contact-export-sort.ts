import type { BusinessCard } from '../types';

export type ContactExportSortMode = 'newest' | 'oldest' | 'name-asc' | 'name-desc';

function contactTimestamp(card: BusinessCard): number {
  const timestamp = new Date(card.createdAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function exportContactName(card: BusinessCard, fallback: string): string {
  const name = [card.firstName, card.lastName].filter(Boolean).join(' ').trim();
  return name || card.company.trim() || card.title.trim() || fallback;
}

export function sortContactsForExport(
  contacts: BusinessCard[],
  mode: ContactExportSortMode,
  fallback = '',
): BusinessCard[] {
  return contacts
    .map((contact, index) => ({ contact, index }))
    .sort((left, right) => {
      let order = 0;
      if (mode === 'newest' || mode === 'oldest') {
        const leftTime = contactTimestamp(left.contact);
        const rightTime = contactTimestamp(right.contact);
        order = mode === 'newest' ? rightTime - leftTime : leftTime - rightTime;
      } else {
        order = exportContactName(left.contact, fallback).localeCompare(
          exportContactName(right.contact, fallback),
          undefined,
          { sensitivity: 'base' },
        );
        if (mode === 'name-desc') order *= -1;
      }
      return order || left.index - right.index;
    })
    .map(({ contact }) => contact);
}

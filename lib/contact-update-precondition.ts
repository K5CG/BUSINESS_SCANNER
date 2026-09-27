import type { BusinessCard } from '../types';
import { contactReviewFingerprint } from './contact-review-state';

function dateFingerprint(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/**
 * Versione del target usata come precondizione del merge deduplica.
 * Comprende sia i campi/provenance editabili sia gli asset e i metadati che
 * non devono essere riportati a uno snapshot precedente.
 */
export function contactPersistenceFingerprint(card: BusinessCard): string {
  return JSON.stringify({
    id: card.id,
    updatedAt: dateFingerprint(card.updatedAt),
    persistenceRevision: card.persistenceRevision ?? null,
    review: contactReviewFingerprint(card),
    notes: card.notes ?? null,
    images: [...card.images],
    originalImages: [...(card.originalImages ?? [])],
    contactPhotoUri: card.contactPhotoUri ?? null,
    rawText: card.rawText,
    pageExtractions: card.pageExtractions ?? null,
  });
}

export class StaleContactUpdateError extends Error {
  constructor() {
    super('STALE_CONTACT_UPDATE');
    this.name = 'StaleContactUpdateError';
  }
}

/**
 * Deve essere invocata dentro lo stesso mutex della scrittura, prima di
 * staging, salvataggio o pulizia asset.
 */
export function assertContactUpdatePrecondition(
  current: BusinessCard,
  expectedFingerprint: string | undefined
): void {
  if (
    expectedFingerprint !== undefined &&
    contactPersistenceFingerprint(current) !== expectedFingerprint
  ) {
    throw new StaleContactUpdateError();
  }
}

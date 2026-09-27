import { BusinessCard } from '../types';
import { getAllContacts } from './storage';
import {
  confirmContactSaveIfNotDuplicate,
  promptResolveDuplicateContact,
  promptSelectDuplicateUpdateFields,
} from './duplicate-contacts';
import {
  buildContactDuplicateFieldProposals,
} from './contact-duplicate-resolution';
import type { ContactReparseFieldKey } from './contact-review-state';
import { contactPersistenceFingerprint } from './contact-update-precondition';
import {
  findContactDuplicate,
  type ContactDuplicateMatch,
} from './duplicate-contacts-core';

export class DuplicateContactCancelledError extends Error {
  constructor() {
    super('DUPLICATE_CONTACT_CANCELLED');
    this.name = 'DuplicateContactCancelledError';
  }
}

/** Esito della scelta utente su una nuova scansione potenzialmente duplicata. */
export type BusinessCardDuplicateResolution =
  | {
      decision: 'update_existing';
      duplicate: ContactDuplicateMatch;
      selectedFields: ContactReparseFieldKey[];
      targetFingerprint: string;
    }
  | {
      decision: 'save_new';
      duplicate: ContactDuplicateMatch | null;
    }
  | {
      decision: 'cancel';
      duplicate: ContactDuplicateMatch;
    };

/**
 * Valuta una nuova scansione e raccoglie una decisione esplicita. In assenza
 * di candidati equivale a "salva come nuovo", senza mostrare alcun prompt.
 */
export async function resolveBusinessCardDuplicate(
  card: BusinessCard,
  excludeId?: string,
  existing?: BusinessCard[]
): Promise<BusinessCardDuplicateResolution> {
  const pool = existing ?? (await getAllContacts());
  const duplicate = findContactDuplicate(card, pool, excludeId);
  if (!duplicate) {
    return { decision: 'save_new', duplicate: null };
  }
  const targetFingerprint = contactPersistenceFingerprint(duplicate.contact);
  const decision = await promptResolveDuplicateContact(duplicate);
  if (decision !== 'update_existing') return { decision, duplicate };

  const selection = await promptSelectDuplicateUpdateFields(
    buildContactDuplicateFieldProposals(duplicate.contact, card)
  );
  if (selection.decision === 'cancel') {
    return { decision: 'cancel', duplicate };
  }
  return {
    decision: 'update_existing',
    duplicate,
    selectedFields: selection.selectedFields,
    targetFingerprint,
  };
}

/** Guard binario legacy usato dagli aggiornamenti ordinari. */
export async function guardBusinessCardDuplicate(
  card: BusinessCard,
  excludeId?: string,
  existing?: BusinessCard[]
): Promise<boolean> {
  const pool = existing ?? (await getAllContacts());
  return confirmContactSaveIfNotDuplicate(card, pool, excludeId ?? card.id);
}

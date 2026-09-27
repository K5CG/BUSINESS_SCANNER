import { Alert } from 'react-native';
import type { BusinessCard } from '../types';
import i18n from '../i18n';
import type { ContactDuplicateFieldProposal } from './contact-duplicate-resolution';
import type { ContactReparseFieldKey } from './contact-review-state';
import {
  findContactDuplicate,
  getContactDisplayName,
  normalizeEmail,
  normalizePhone,
  normalizeContactToken,
  areDistinctPeople,
  type ContactDuplicateMatch,
  type DuplicateComparedField,
  type DuplicateStrength,
  type DuplicateTier,
} from './duplicate-contacts-core';

export {
  findContactDuplicate,
  getContactDisplayName,
  normalizeEmail,
  normalizePhone,
  normalizeContactToken,
  areDistinctPeople,
  type ContactDuplicateMatch,
  type DuplicateComparedField,
  type DuplicateStrength,
  type DuplicateTier,
};

export type ContactDuplicateUserDecision =
  | 'update_existing'
  | 'save_new'
  | 'cancel';

export type ContactDuplicateUpdateFieldSelection =
  | {
      decision: 'update_existing';
      selectedFields: ContactReparseFieldKey[];
    }
  | {
      decision: 'cancel';
    };

const FIELD_LABEL_KEYS: Record<DuplicateComparedField, string> = {
  name: 'contactDuplicateFieldName',
  company: 'company',
  emails: 'email',
  phones: 'phone',
  website: 'website',
  address: 'address',
  city: 'contactDuplicateFieldCity',
  country: 'contactDuplicateFieldCountry',
  vatNumber: 'vatNumber',
  taxCode: 'taxCode',
  images: 'contactDuplicateFieldImages',
  rawText: 'contactDuplicateFieldOcr',
};

const TIER_LABEL_KEYS: Record<DuplicateTier, string> = {
  exact: 'contactDuplicateTierExact',
  probable: 'contactDuplicateTierProbable',
  possible: 'contactDuplicateTierPossible',
};

const REASON_LABEL_KEYS: Record<ContactDuplicateMatch['reason'], string> = {
  email: 'contactDuplicateReasonEmail',
  phone: 'contactDuplicateReasonPhone',
  name_company: 'contactDuplicateReasonIdentity',
  name: 'contactDuplicateReasonName',
};

const UPDATE_FIELD_LABEL_KEYS: Record<ContactReparseFieldKey, string> = {
  firstName: 'firstName',
  lastName: 'lastName',
  company: 'company',
  role: 'role',
  emails: 'email',
  phones: 'phone',
  website: 'website',
  address: 'address',
  vatNumber: 'vatNumber',
  taxCode: 'taxCode',
};

function localizedFields(fields: readonly DuplicateComparedField[]): string {
  if (fields.length === 0) return i18n.t('contactDuplicateNoFields');
  return fields.map((field) => i18n.t(FIELD_LABEL_KEYS[field])).join(', ');
}

/** Testo completo e non distruttivo mostrato prima di una nuova persistenza. */
export function duplicateContactPromptMessage(
  duplicate: ContactDuplicateMatch
): string {
  return i18n.t('contactDuplicateResolutionMessage', {
    name: getContactDisplayName(duplicate.contact),
    level: i18n.t(TIER_LABEL_KEYS[duplicate.tier]),
    reason: i18n.t(REASON_LABEL_KEYS[duplicate.reason]),
    equalFields: localizedFields(duplicate.equalFields),
    differentFields: localizedFields(duplicate.differentFields),
  });
}

/**
 * Espone sempre le tre scelte richieste. Nessuna scelta modifica record o
 * asset: la persistenza resta responsabilità esplicita del chiamante.
 */
export function promptResolveDuplicateContact(
  duplicate: ContactDuplicateMatch
): Promise<ContactDuplicateUserDecision> {
  return new Promise((resolve) => {
    Alert.alert(
      i18n.t('contactDuplicateTitle'),
      duplicateContactPromptMessage(duplicate),
      [
        {
          text: i18n.t('cancel'),
          style: 'cancel',
          onPress: () => resolve('cancel'),
        },
        {
          text: i18n.t('contactDuplicateSaveNew'),
          onPress: () => resolve('save_new'),
        },
        {
          text: i18n.t('contactDuplicateUpdateExisting'),
          onPress: () => resolve('update_existing'),
        },
      ],
      { cancelable: true, onDismiss: () => resolve('cancel') }
    );
  });
}

function proposalStatusLabel(
  proposal: ContactDuplicateFieldProposal
): string {
  if (proposal.status === 'protected') {
    return i18n.t('contactDuplicateFieldStatusProtected');
  }
  if (proposal.status === 'unchanged') {
    return i18n.t('contactDuplicateFieldStatusUnchanged');
  }
  return i18n.t('contactDuplicateFieldStatusSelectable');
}

function duplicateFieldReviewMessage(
  proposals: readonly ContactDuplicateFieldProposal[]
): string {
  const currentLabel = i18n.t('contactDuplicateCurrentValue');
  const proposedLabel = i18n.t('contactDuplicateProposedValue');
  return [
    i18n.t('contactDuplicateFieldReviewIntro'),
    ...proposals.map((proposal) => {
      const fieldLabel = i18n.t(UPDATE_FIELD_LABEL_KEYS[proposal.field]);
      return [
        `${fieldLabel} — ${proposalStatusLabel(proposal)}`,
        `${currentLabel}: ${proposal.currentDisplay}`,
        `${proposedLabel}: ${proposal.proposedDisplay}`,
      ].join('\n');
    }),
  ].join('\n\n');
}

function promptStartDuplicateFieldReview(
  proposals: readonly ContactDuplicateFieldProposal[]
): Promise<boolean> {
  const hasSelectable = proposals.some(
    (proposal) => proposal.status === 'selectable'
  );
  return new Promise((resolve) => {
    Alert.alert(
      i18n.t('contactDuplicateFieldReviewTitle'),
      duplicateFieldReviewMessage(proposals),
      [
        {
          text: i18n.t('cancel'),
          style: 'cancel',
          onPress: () => resolve(false),
        },
        {
          text: i18n.t(
            hasSelectable
              ? 'contactDuplicateChooseFields'
              : 'contactDuplicateBackToDraft'
          ),
          onPress: () => resolve(hasSelectable),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

function promptDuplicateFieldChoice(
  proposal: ContactDuplicateFieldProposal
): Promise<'keep_existing' | 'use_proposed' | 'cancel'> {
  return new Promise((resolve) => {
    Alert.alert(
      i18n.t('contactDuplicateFieldChoiceTitle', {
        field: i18n.t(UPDATE_FIELD_LABEL_KEYS[proposal.field]),
      }),
      i18n.t('contactDuplicateFieldChoiceMessage', {
        current: proposal.currentDisplay,
        proposed: proposal.proposedDisplay,
      }),
      [
        {
          text: i18n.t('cancel'),
          style: 'cancel',
          onPress: () => resolve('cancel'),
        },
        {
          text: i18n.t('contactDuplicateKeepExisting'),
          onPress: () => resolve('keep_existing'),
        },
        {
          text: i18n.t('contactDuplicateUseProposed'),
          onPress: () => resolve('use_proposed'),
        },
      ],
      { cancelable: true, onDismiss: () => resolve('cancel') }
    );
  });
}

/**
 * Raccoglie una scelta esplicita per ogni delta applicabile. I campi manuali
 * sono mostrati nel riepilogo come protetti e non ricevono mai un pulsante di
 * applicazione. Se nessun campo viene scelto l'esito è un annullamento puro.
 */
export async function promptSelectDuplicateUpdateFields(
  proposals: readonly ContactDuplicateFieldProposal[]
): Promise<ContactDuplicateUpdateFieldSelection> {
  if (!(await promptStartDuplicateFieldReview(proposals))) {
    return { decision: 'cancel' };
  }

  const selectedFields: ContactReparseFieldKey[] = [];
  for (const proposal of proposals) {
    if (proposal.status !== 'selectable') continue;
    const choice = await promptDuplicateFieldChoice(proposal);
    if (choice === 'cancel') return { decision: 'cancel' };
    if (choice === 'use_proposed') selectedFields.push(proposal.field);
  }

  return selectedFields.length > 0
    ? { decision: 'update_existing', selectedFields }
    : { decision: 'cancel' };
}

/** Chiede conferma prima di salvare un possibile duplicato contatto. */
export function promptSaveDuplicateContact(displayName: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      i18n.t('contactDuplicateTitle'),
      i18n.t('contactDuplicateMessage', { name: displayName }),
      [
        { text: i18n.t('cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: i18n.t('saveAnyway'), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

export async function confirmContactSaveIfNotDuplicate(
  card: BusinessCard,
  existing: BusinessCard[],
  excludeId?: string
): Promise<boolean> {
  const duplicate = findContactDuplicate(card, existing, excludeId);
  if (!duplicate) return true;
  return promptSaveDuplicateContact(getContactDisplayName(duplicate.contact));
}

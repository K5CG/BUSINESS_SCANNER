import type { Address, BusinessCard, Phone } from '../types';
import {
  CONTACT_REPARSABLE_FIELD_KEYS,
  applyContactCandidatePreservingManual,
  contactFieldDisplayValue,
  createContactReparseProposal,
  ensureContactReviewState,
  snapshotContactFields,
  type ContactReparseFieldKey,
} from './contact-review-state';

export type ContactDuplicateResolutionAction =
  | 'update_existing'
  | 'save_new'
  | 'cancel';

export type ContactDuplicateResolutionAssetPolicy =
  | 'keep_existing'
  | 'use_source'
  | 'none';

export interface ContactDuplicateResolutionSource {
  kind: 'scan_draft';
  contactId: string;
}

export type ContactDuplicateResolutionTarget =
  | {
      kind: 'existing_contact';
      contactId: string;
    }
  | {
      kind: 'new_contact';
    }
  | {
      kind: 'none';
    };

interface ContactDuplicateResolutionPlanBase {
  action: ContactDuplicateResolutionAction;
  source: ContactDuplicateResolutionSource;
  target: ContactDuplicateResolutionTarget;
  assetPolicy: ContactDuplicateResolutionAssetPolicy;
  appliedFields: ContactReparseFieldKey[];
  protectedFields: ContactReparseFieldKey[];
  /**
   * Il planner non persiste nulla. Un valore `true` indica soltanto che il
   * chiamante deve eseguire esplicitamente la scrittura proposta.
   */
  requiresExplicitPersistence: boolean;
}

export interface UpdateExistingContactResolutionPlan
  extends ContactDuplicateResolutionPlanBase {
  action: 'update_existing';
  target: {
    kind: 'existing_contact';
    contactId: string;
  };
  assetPolicy: 'keep_existing';
  plannedRecord: BusinessCard;
  requiresExplicitPersistence: true;
}

export interface SaveNewContactResolutionPlan
  extends ContactDuplicateResolutionPlanBase {
  action: 'save_new';
  target: {
    kind: 'new_contact';
  };
  assetPolicy: 'use_source';
  plannedRecord: BusinessCard;
  requiresExplicitPersistence: true;
}

export interface CancelContactResolutionPlan
  extends ContactDuplicateResolutionPlanBase {
  action: 'cancel';
  target: {
    kind: 'none';
  };
  assetPolicy: 'none';
  plannedRecord: null;
  requiresExplicitPersistence: false;
}

export type ContactDuplicateResolutionPlan =
  | UpdateExistingContactResolutionPlan
  | SaveNewContactResolutionPlan
  | CancelContactResolutionPlan;

export interface ContactDuplicatePersistencePorts {
  createContact: (record: BusinessCard) => Promise<BusinessCard>;
  updateContact: (record: BusinessCard) => Promise<BusinessCard>;
}

export interface ExecutedContactDuplicateResolution {
  action: ContactDuplicateResolutionAction;
  persistedRecord: BusinessCard | null;
}

interface PlanContactDuplicateResolutionInputBase {
  existingContact: BusinessCard;
  sourceDraft: BusinessCard;
}

export type PlanContactDuplicateResolutionInput =
  | (PlanContactDuplicateResolutionInputBase & {
      action: 'update_existing';
      /** Campi scelti esplicitamente dall'utente nella review del merge. */
      selectedFields: readonly ContactReparseFieldKey[];
    })
  | (PlanContactDuplicateResolutionInputBase & {
      action: 'save_new';
      selectedFields?: never;
    })
  | (PlanContactDuplicateResolutionInputBase & {
      action: 'cancel';
      selectedFields?: never;
    });

export type ContactDuplicateFieldProposalStatus =
  | 'selectable'
  | 'protected'
  | 'unchanged';

export interface ContactDuplicateFieldProposal {
  field: ContactReparseFieldKey;
  currentDisplay: string;
  proposedDisplay: string;
  status: ContactDuplicateFieldProposalStatus;
}

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function meaningfulEmails(values: readonly string[]): string[] {
  return values.filter(hasText);
}

function meaningfulPhones(values: readonly Phone[]): Phone[] {
  return values
    .filter((phone) => hasText(phone.number))
    .map((phone) => ({ ...phone }));
}

function hasMeaningfulAddress(value: Address | undefined): boolean {
  if (!value) return false;
  return [
    value.street,
    value.civicNumber,
    value.city,
    value.postalCode,
    value.region,
    value.country,
    value.full,
  ].some(hasText);
}

function cloneCard(card: BusinessCard): BusinessCard {
  return {
    ...card,
    images: [...card.images],
    ...(card.originalImages ? { originalImages: [...card.originalImages] } : {}),
    confidence: { ...card.confidence },
    emails: [...card.emails],
    phones: card.phones.map((phone) => ({ ...phone })),
    ...(card.address === undefined
      ? {}
      : { address: { ...card.address } }),
    ...(card.emailEvidence === undefined
      ? {}
      : {
          emailEvidence: card.emailEvidence.map((item) => ({
            ...item,
            transformations: [...item.transformations],
          })),
        }),
  };
}

function candidateForSelectedNonEmptyFields(
  existing: BusinessCard,
  source: BusinessCard,
  selectedFields: readonly ContactReparseFieldKey[]
): BusinessCard {
  const selected = new Set<ContactReparseFieldKey>(
    selectedFields
  );
  const use = (field: ContactReparseFieldKey): boolean =>
    selected.has(field);

  const sourceEmails = meaningfulEmails(source.emails);
  const useEmails = use('emails') && sourceEmails.length > 0;
  const sourcePhones = meaningfulPhones(source.phones);
  const usePhones = use('phones') && sourcePhones.length > 0;
  const useAddress =
    use('address') && hasMeaningfulAddress(source.address);

  const extractionReview = source.extractionReview
    ? {
        ...source.extractionReview,
        addressAlternatives: useAddress
          ? source.extractionReview.addressAlternatives?.map(
              (address) => ({ ...address })
            )
          : existing.extractionReview?.addressAlternatives?.map(
              (address) => ({ ...address })
            ),
      }
    : source.extractionReview;

  return {
    ...source,
    firstName:
      use('firstName') && hasText(source.firstName)
        ? source.firstName
        : existing.firstName,
    lastName:
      use('lastName') && hasText(source.lastName)
        ? source.lastName
        : existing.lastName,
    company:
      use('company') && hasText(source.company)
        ? source.company
        : existing.company,
    role:
      use('role') && hasText(source.role)
        ? source.role
        : existing.role,
    emails: useEmails ? sourceEmails : [...existing.emails],
    emailEvidence: useEmails
      ? source.emailEvidence
      : existing.emailEvidence,
    phones: usePhones
      ? sourcePhones
      : existing.phones.map((phone) => ({ ...phone })),
    website:
      use('website') && hasText(source.website)
        ? source.website
        : existing.website,
    address: useAddress
      ? { ...source.address! }
      : existing.address
        ? { ...existing.address }
        : undefined,
    vatNumber:
      use('vatNumber') && hasText(source.vatNumber)
        ? source.vatNumber
        : existing.vatNumber,
    taxCode:
      use('taxCode') && hasText(source.taxCode)
        ? source.taxCode
        : existing.taxCode,
    extractionReview,
  };
}

/**
 * Descrive tutti i campi aggiornabili, inclusi quelli invariati e quelli
 * protetti da un override manuale. La UI usa questa lista per raccogliere una
 * selezione esplicita prima di costruire qualsiasi piano di persistenza.
 */
export function buildContactDuplicateFieldProposals(
  existingContact: BusinessCard,
  sourceDraft: BusinessCard
): ContactDuplicateFieldProposal[] {
  const candidate = candidateForSelectedNonEmptyFields(
    existingContact,
    sourceDraft,
    CONTACT_REPARSABLE_FIELD_KEYS
  );
  const current = ensureContactReviewState(existingContact);
  const currentSnapshot = snapshotContactFields(current);
  const proposedSnapshot = snapshotContactFields(candidate);
  const deltas = new Map(
    createContactReparseProposal(
      current,
      candidate,
      'contact-duplicate-resolution'
    ).fields.map((proposal) => [proposal.field, proposal] as const)
  );
  const manualOverrides = current.contactReviewState!.manualOverrides;

  return CONTACT_REPARSABLE_FIELD_KEYS.map((field) => {
    const delta = deltas.get(field);
    const protectedByManualOverride =
      Object.prototype.hasOwnProperty.call(manualOverrides, field);
    return {
      field,
      currentDisplay:
        delta?.currentDisplay ??
        contactFieldDisplayValue(currentSnapshot, field),
      proposedDisplay:
        delta?.proposedDisplay ??
        contactFieldDisplayValue(proposedSnapshot, field),
      status: protectedByManualOverride
        ? 'protected'
        : delta
          ? 'selectable'
          : 'unchanged',
    };
  });
}

/**
 * Produce soltanto un piano di risoluzione. Non aggiorna store, record o
 * asset e non invoca callback di persistenza.
 */
export function planContactDuplicateResolution(
  input: PlanContactDuplicateResolutionInput
): ContactDuplicateResolutionPlan {
  const source: ContactDuplicateResolutionSource = {
    kind: 'scan_draft',
    contactId: input.sourceDraft.id,
  };

  if (input.action === 'cancel') {
    return {
      action: 'cancel',
      source,
      target: { kind: 'none' },
      assetPolicy: 'none',
      plannedRecord: null,
      appliedFields: [],
      protectedFields: [],
      requiresExplicitPersistence: false,
    };
  }

  if (input.action === 'save_new') {
    return {
      action: 'save_new',
      source,
      target: { kind: 'new_contact' },
      assetPolicy: 'use_source',
      plannedRecord: cloneCard(input.sourceDraft),
      appliedFields: [],
      protectedFields: [],
      requiresExplicitPersistence: true,
    };
  }

  const candidate = candidateForSelectedNonEmptyFields(
    input.existingContact,
    input.sourceDraft,
    input.selectedFields
  );
  const merged = applyContactCandidatePreservingManual(
    input.existingContact,
    candidate,
    'ocr'
  );

  return {
    action: 'update_existing',
    source,
    target: {
      kind: 'existing_contact',
      contactId: input.existingContact.id,
    },
    assetPolicy: 'keep_existing',
    plannedRecord: {
      ...merged.appliedResult,
      id: input.existingContact.id,
      createdAt: input.existingContact.createdAt,
      updatedAt: input.existingContact.updatedAt,
      notes: input.existingContact.notes,
      images: [...input.existingContact.images],
      ...(input.existingContact.originalImages
        ? { originalImages: [...input.existingContact.originalImages] }
        : {}),
      contactPhotoUri: input.existingContact.contactPhotoUri,
    },
    appliedFields: [...merged.appliedFields],
    protectedFields: [...merged.protectedFields],
    requiresExplicitPersistence: true,
  };
}

/**
 * Esegue esclusivamente un piano già scelto dall'utente. Un piano `cancel`
 * non invoca alcuna porta; non esiste quindi alcun merge automatico implicito.
 */
export async function executeContactDuplicateResolution(
  plan: ContactDuplicateResolutionPlan,
  ports: ContactDuplicatePersistencePorts
): Promise<ExecutedContactDuplicateResolution> {
  if (plan.action === 'cancel') {
    return { action: 'cancel', persistedRecord: null };
  }
  if (plan.action === 'save_new') {
    return {
      action: 'save_new',
      persistedRecord: await ports.createContact(plan.plannedRecord),
    };
  }
  return {
    action: 'update_existing',
    persistedRecord: await ports.updateContact(plan.plannedRecord),
  };
}

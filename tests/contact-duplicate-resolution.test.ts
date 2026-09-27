import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard } from '../types';
import {
  CONTACT_REPARSABLE_FIELD_KEYS,
  applyManualContactEdits,
  initializeParsedContactReviewState,
} from '../lib/contact-review-state';
import {
  buildContactDuplicateFieldProposals,
  planContactDuplicateResolution,
} from '../lib/contact-duplicate-resolution';
import {
  assertContactUpdatePrecondition,
  contactPersistenceFingerprint,
  StaleContactUpdateError,
} from '../lib/contact-update-precondition';

const CREATED_AT = new Date('2026-07-20T08:00:00.000Z');
const UPDATED_AT = new Date('2026-07-21T09:00:00.000Z');

function card(overrides: Partial<BusinessCard> = {}): BusinessCard {
  return initializeParsedContactReviewState({
    id: 'existing-1',
    type: 'business_card',
    title: 'Acme - Mario Rossi',
    images: ['file:///existing-front.jpg'],
    contactPhotoUri: 'file:///existing-photo.jpg',
    rawText: 'MARIO ROSSI\nACME',
    confidence: {
      firstName: 0.8,
      lastName: 0.8,
      company: 0.8,
    },
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    firstName: 'Mario',
    lastName: 'Rossi',
    role: 'Sales',
    company: 'Acme',
    emails: ['mario@acme.it'],
    phones: [{ number: '+39 02 123456' }],
    website: 'https://acme.it',
    address: { full: 'Via Roma 1, Milano' },
    notes: 'Nota manuale da conservare',
    ...overrides,
  });
}

function draft(overrides: Partial<BusinessCard> = {}): BusinessCard {
  return {
    ...card({
      id: 'draft-2',
      title: 'Acme Italia - Mario Rossi',
      images: ['file:///new-scan.jpg'],
      contactPhotoUri: 'file:///new-face.jpg',
      rawText: 'MARIO ROSSI\nACME ITALIA\nACCOUNT MANAGER',
      createdAt: new Date('2026-07-31T10:00:00.000Z'),
      updatedAt: new Date('2026-07-31T10:00:00.000Z'),
      firstName: 'Mario',
      lastName: 'Rossi',
      role: 'Account Manager',
      company: 'Acme Italia',
      emails: ['m.rossi@acme.it'],
      phones: [{ number: '+39 02 654321' }],
      website: 'https://acme.it',
      address: { full: 'Via Milano 2, Roma' },
      notes: 'Nota prodotta dal nuovo scan',
    }),
    contactReviewState: undefined,
    ...overrides,
  };
}

test('DEDUP-15 update_existing prepara un update campo-per-campo sicuro', () => {
  const existing = card();
  const sourceDraft = draft();
  const plan = planContactDuplicateResolution({
    action: 'update_existing',
    existingContact: existing,
    sourceDraft,
    selectedFields: ['company', 'role'],
  });

  assert.equal(plan.action, 'update_existing');
  assert.deepEqual(plan.target, {
    kind: 'existing_contact',
    contactId: existing.id,
  });
  assert.deepEqual(plan.source, {
    kind: 'scan_draft',
    contactId: sourceDraft.id,
  });
  assert.equal(plan.assetPolicy, 'keep_existing');
  assert.equal(plan.requiresExplicitPersistence, true);
  assert.equal(plan.plannedRecord.company, 'Acme Italia');
  assert.equal(plan.plannedRecord.role, 'Account Manager');
  assert.deepEqual(plan.appliedFields.sort(), ['company', 'role']);
  assert.equal(plan.plannedRecord.emails[0], 'mario@acme.it');
  assert.equal(plan.plannedRecord.id, existing.id);
  assert.equal(plan.plannedRecord.createdAt, existing.createdAt);
  assert.equal(plan.plannedRecord.updatedAt, existing.updatedAt);
  assert.equal(plan.plannedRecord.notes, existing.notes);
});

test('DEDUP-16 save_new restituisce il draft invariato per un nuovo record', () => {
  const existing = card();
  const sourceDraft = draft();
  const before = structuredClone(sourceDraft);
  const plan = planContactDuplicateResolution({
    action: 'save_new',
    existingContact: existing,
    sourceDraft,
  });

  assert.equal(plan.action, 'save_new');
  assert.deepEqual(plan.target, { kind: 'new_contact' });
  assert.equal(plan.assetPolicy, 'use_source');
  assert.equal(plan.requiresExplicitPersistence, true);
  assert.deepEqual(plan.plannedRecord, sourceDraft);
  assert.notStrictEqual(plan.plannedRecord, sourceDraft);
  assert.deepEqual(sourceDraft, before);
});

test('DEDUP-17 cancel non produce alcun piano di scrittura', () => {
  const plan = planContactDuplicateResolution({
    action: 'cancel',
    existingContact: card(),
    sourceDraft: draft(),
  });

  assert.equal(plan.action, 'cancel');
  assert.deepEqual(plan.target, { kind: 'none' });
  assert.equal(plan.assetPolicy, 'none');
  assert.equal(plan.plannedRecord, null);
  assert.deepEqual(plan.appliedFields, []);
  assert.deepEqual(plan.protectedFields, []);
  assert.equal(plan.requiresExplicitPersistence, false);
});

test('DEDUP-18 update protegge manualOverrides anche se selezionati', () => {
  const existing = applyManualContactEdits(card(), {
    company: 'Azienda scelta a mano',
    website: 'https://manual.example.org',
  });
  const sourceDraft = draft({
    company: 'Azienda OCR',
    website: 'https://ocr.example.org',
    role: 'Director',
  });
  const plan = planContactDuplicateResolution({
    action: 'update_existing',
    existingContact: existing,
    sourceDraft,
    selectedFields: ['company', 'website', 'role'],
  });

  assert.equal(plan.action, 'update_existing');
  assert.equal(plan.plannedRecord.company, 'Azienda scelta a mano');
  assert.equal(
    plan.plannedRecord.website,
    'https://manual.example.org'
  );
  assert.equal(plan.plannedRecord.role, 'Director');
  assert.deepEqual(plan.protectedFields.sort(), [
    'company',
    'website',
  ]);
  assert.deepEqual(plan.appliedFields, ['role']);
});

test('DEDUP-19 update mantiene gli asset esistenti senza duplicarli', () => {
  const existing = card({
    images: [
      'file:///existing-front.jpg',
      'file:///existing-back.jpg',
    ],
    contactPhotoUri: 'file:///existing-photo.jpg',
  });
  const sourceDraft = draft({
    images: [
      'file:///existing-front.jpg',
      'file:///new-scan.jpg',
      'file:///new-scan.jpg',
    ],
    contactPhotoUri: 'file:///new-face.jpg',
  });
  const plan = planContactDuplicateResolution({
    action: 'update_existing',
    existingContact: existing,
    sourceDraft,
    selectedFields: CONTACT_REPARSABLE_FIELD_KEYS,
  });

  assert.equal(plan.action, 'update_existing');
  assert.deepEqual(plan.plannedRecord.images, existing.images);
  assert.equal(
    plan.plannedRecord.contactPhotoUri,
    existing.contactPhotoUri
  );
  assert.equal(new Set(plan.plannedRecord.images).size, 2);
  assert.notStrictEqual(plan.plannedRecord.images, existing.images);
});

test('DEDUP-20 il planner non muta né fonde automaticamente i record', () => {
  const existing = card();
  const sourceDraft = draft({
    id: 'candidate-must-not-replace-id',
    firstName: '',
    lastName: '   ',
    company: '',
    role: '',
    emails: [],
    phones: [],
    website: ' ',
    address: { full: ' ' },
    vatNumber: '',
    taxCode: ' ',
    notes: 'Non deve sostituire la nota esistente',
  });
  const existingBefore = structuredClone(existing);
  const draftBefore = structuredClone(sourceDraft);
  const plan = planContactDuplicateResolution({
    action: 'update_existing',
    existingContact: existing,
    sourceDraft,
    selectedFields: CONTACT_REPARSABLE_FIELD_KEYS,
  });

  assert.deepEqual(existing, existingBefore);
  assert.deepEqual(sourceDraft, draftBefore);
  assert.equal(plan.action, 'update_existing');
  assert.equal(plan.requiresExplicitPersistence, true);
  assert.notStrictEqual(plan.plannedRecord, existing);
  assert.equal(plan.plannedRecord.firstName, existing.firstName);
  assert.equal(plan.plannedRecord.lastName, existing.lastName);
  assert.equal(plan.plannedRecord.company, existing.company);
  assert.equal(plan.plannedRecord.role, existing.role);
  assert.deepEqual(plan.plannedRecord.emails, existing.emails);
  assert.deepEqual(plan.plannedRecord.phones, existing.phones);
  assert.equal(plan.plannedRecord.website, existing.website);
  assert.deepEqual(plan.plannedRecord.address, existing.address);
  assert.equal(plan.plannedRecord.notes, existing.notes);
  assert.equal(plan.plannedRecord.id, existing.id);
  assert.deepEqual(plan.appliedFields, []);
});

test('DEDUP-21 la proposta include ogni campo e blocca gli override manuali', () => {
  const existing = applyManualContactEdits(card(), {
    company: 'Azienda scelta a mano',
  });
  const proposals = buildContactDuplicateFieldProposals(
    existing,
    draft({
      company: 'Azienda OCR',
      role: 'Account Manager',
    })
  );

  assert.deepEqual(
    proposals.map((proposal) => proposal.field),
    CONTACT_REPARSABLE_FIELD_KEYS
  );
  assert.equal(
    proposals.find((proposal) => proposal.field === 'company')?.status,
    'protected'
  );
  const role = proposals.find((proposal) => proposal.field === 'role');
  assert.equal(role?.status, 'selectable');
  assert.match(role?.currentDisplay ?? '', /Sales/);
  assert.match(role?.proposedDisplay ?? '', /Account Manager/);
});

test('DEDUP-22 una modifica concorrente rende stale il merge prima di scrittura o cleanup', () => {
  const shownTarget = card();
  const expectedFingerprint = contactPersistenceFingerprint(shownTarget);
  const changedTarget = applyManualContactEdits(
    {
      ...shownTarget,
      images: [...shownTarget.images, 'file:///added-while-reviewing.jpg'],
      updatedAt: new Date('2026-07-31T11:00:00.000Z'),
    },
    { role: 'Ruolo aggiornato mentre il prompt era aperto' }
  );
  let writes = 0;
  let cleanups = 0;

  assert.throws(
    () => {
      assertContactUpdatePrecondition(changedTarget, expectedFingerprint);
      writes += 1;
      cleanups += 1;
    },
    StaleContactUpdateError
  );
  assert.equal(writes, 0);
  assert.equal(cleanups, 0);
  assert.equal(
    changedTarget.images.includes('file:///added-while-reviewing.jpg'),
    true
  );
  assert.equal(
    changedTarget.role,
    'Ruolo aggiornato mentre il prompt era aperto'
  );
});

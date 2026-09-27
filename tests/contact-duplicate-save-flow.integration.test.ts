import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { BusinessCard } from '../types';
import {
  executeContactDuplicateResolution,
  planContactDuplicateResolution,
} from '../lib/contact-duplicate-resolution';
import { initializeParsedContactReviewState } from '../lib/contact-review-state';
import { resolveBusinessCardDuplicate } from '../lib/duplicate-contact-guard';
import {
  getAlertHistory,
  resetAlertStub,
  type StubAlertCall,
} from './stubs/react-native-alert-stub';

function card(overrides: Partial<BusinessCard> = {}): BusinessCard {
  return {
    id: 'existing-contact',
    type: 'business_card',
    title: 'North Lab - Anna Verdi',
    images: ['file:///existing-card.jpg'],
    rawText: 'ANNA VERDI\nNORTH LAB',
    confidence: {},
    createdAt: new Date('2026-07-01T08:00:00.000Z'),
    updatedAt: new Date('2026-07-01T08:00:00.000Z'),
    firstName: 'Anna',
    lastName: 'Verdi',
    role: 'Director',
    company: 'North Lab',
    emails: ['anna@north-lab.test'],
    phones: [{ number: '+39 333 555 0101', type: 'mobile' }],
    notes: 'Nota esistente',
    ...overrides,
  };
}

function draft(): BusinessCard {
  return card({
    id: 'new-scan-draft',
    title: 'North Laboratory - Anna Verdi',
    images: ['file:///temporary-new-card.jpg'],
    company: 'North Laboratory',
    role: 'Managing Director',
    notes: 'Nota OCR da non sostituire',
  });
}

test('DEDUP-FLOW persiste soltanto la decisione esplicita selezionata', async () => {
  const existing = card();
  const source = draft();
  const created: BusinessCard[] = [];
  const updated: BusinessCard[] = [];
  const ports = {
    createContact: async (record: BusinessCard) => {
      created.push(record);
      return record;
    },
    updateContact: async (record: BusinessCard) => {
      updated.push(record);
      return record;
    },
  };

  const cancelPlan = planContactDuplicateResolution({
    action: 'cancel',
    existingContact: existing,
    sourceDraft: source,
  });
  const cancelled = await executeContactDuplicateResolution(
    cancelPlan,
    ports
  );
  assert.equal(cancelled.persistedRecord, null);
  assert.equal(created.length, 0);
  assert.equal(updated.length, 0);

  const updatePlan = planContactDuplicateResolution({
    action: 'update_existing',
    existingContact: existing,
    sourceDraft: source,
    selectedFields: ['role'],
  });
  const updateResult = await executeContactDuplicateResolution(
    updatePlan,
    ports
  );
  assert.equal(updateResult.action, 'update_existing');
  assert.equal(updateResult.persistedRecord?.id, existing.id);
  assert.equal(created.length, 0);
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0]?.images, existing.images);

  const savePlan = planContactDuplicateResolution({
    action: 'save_new',
    existingContact: existing,
    sourceDraft: source,
  });
  const saveResult = await executeContactDuplicateResolution(savePlan, ports);
  assert.equal(saveResult.action, 'save_new');
  assert.equal(saveResult.persistedRecord?.id, source.id);
  assert.equal(created.length, 1);
  assert.equal(updated.length, 1);
});

async function waitForAlertCount(count: number): Promise<StubAlertCall> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const alerts = getAlertHistory();
    if (alerts.length >= count) return alerts[count - 1]!;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`alert ${count} non mostrato`);
}

function reviewDraft(existing: BusinessCard): BusinessCard {
  return {
    ...existing,
    id: 'new-scan-draft',
    title: 'North Lab - Anna Verdi',
    images: ['file:///temporary-new-card.jpg'],
    role: 'Managing Director',
    createdAt: new Date('2026-07-31T10:00:00.000Z'),
    updatedAt: new Date('2026-07-31T10:00:00.000Z'),
    contactReviewState: undefined,
  };
}

test('DEDUP-STORE-FLOW propaga selectedFields espliciti e non scrive su cancel', async () => {
  const existing = initializeParsedContactReviewState(card());
  const source = reviewDraft(existing);
  const created: BusinessCard[] = [];
  const updated: BusinessCard[] = [];
  const ports = {
    createContact: async (record: BusinessCard) => {
      created.push(record);
      return record;
    },
    updateContact: async (record: BusinessCard) => {
      updated.push(record);
      return record;
    },
  };

  resetAlertStub();
  const updatePending = resolveBusinessCardDuplicate(
    source,
    undefined,
    [existing]
  );
  const initial = await waitForAlertCount(1);
  initial.buttons
    .find((button) => button.text === 'Aggiorna contatto esistente')
    ?.onPress?.();

  const review = await waitForAlertCount(2);
  assert.match(review.message ?? '', /Ruolo — da scegliere/i);
  review.buttons
    .find((button) => button.text === 'Scegli campo per campo')
    ?.onPress?.();

  const role = await waitForAlertCount(3);
  assert.match(role.title, /Ruolo/i);
  role.buttons
    .find((button) => button.text === 'Usa proposto')
    ?.onPress?.();

  const updateResolution = await updatePending;
  assert.equal(updateResolution.decision, 'update_existing');
  if (updateResolution.decision !== 'update_existing') {
    assert.fail('la review deve produrre un update');
  }
  assert.deepEqual(updateResolution.selectedFields, ['role']);
  const updatePlan = planContactDuplicateResolution({
    action: 'update_existing',
    existingContact: updateResolution.duplicate.contact,
    sourceDraft: source,
    selectedFields: updateResolution.selectedFields,
  });
  await executeContactDuplicateResolution(updatePlan, ports);
  assert.equal(updated[0]?.role, source.role);
  assert.equal(updated[0]?.company, existing.company);
  assert.equal(created.length, 0);
  assert.equal(updated.length, 1);

  resetAlertStub();
  const cancelPending = resolveBusinessCardDuplicate(
    source,
    undefined,
    [existing]
  );
  (await waitForAlertCount(1)).buttons
    .find((button) => button.text === 'Annulla')
    ?.onPress?.();
  assert.equal((await cancelPending).decision, 'cancel');
  assert.equal(created.length, 0);
  assert.equal(updated.length, 1);

  resetAlertStub();
  const saveNewPending = resolveBusinessCardDuplicate(
    source,
    undefined,
    [existing]
  );
  (await waitForAlertCount(1)).buttons
    .find((button) => button.text === 'Salva come nuovo')
    ?.onPress?.();
  const saveNewResolution = await saveNewPending;
  assert.equal(saveNewResolution.decision, 'save_new');
  const saveNewPlan = planContactDuplicateResolution({
    action: 'save_new',
    existingContact: existing,
    sourceDraft: source,
  });
  await executeContactDuplicateResolution(saveNewPlan, ports);
  assert.equal(created[0]?.id, source.id);
  assert.equal(created.length, 1);
  assert.equal(updated.length, 1);

  const storeSource = readFileSync(
    path.join(process.cwd(), 'store', 'useContactStore.ts'),
    'utf8'
  );
  assert.match(
    storeSource,
    /selectedFields:\s*resolution\.selectedFields/
  );
  assert.match(
    storeSource,
    /resolution\.selectedFields\.length === 0/
  );
  assert.match(
    storeSource,
    /expectedFingerprint:\s*resolution\.targetFingerprint/
  );
});

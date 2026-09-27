import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard } from '../types';
import {
  promptResolveDuplicateContact,
  promptSelectDuplicateUpdateFields,
  type ContactDuplicateUserDecision,
} from '../lib/duplicate-contacts';
import type { ContactDuplicateFieldProposal } from '../lib/contact-duplicate-resolution';
import { CONTACT_REPARSABLE_FIELD_KEYS } from '../lib/contact-review-state';
import type { ContactDuplicateMatch } from '../lib/duplicate-contacts-core';
import {
  getLatestAlert,
  resetAlertStub,
} from './stubs/react-native-alert-stub';

const existing: BusinessCard = {
  id: 'existing-contact',
  type: 'business_card',
  title: 'North Lab - Anna Verdi',
  images: ['file:///existing-card.jpg'],
  rawText: 'ANNA VERDI\nNORTH LAB',
  confidence: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  firstName: 'Anna',
  lastName: 'Verdi',
  role: 'Director',
  company: 'North Lab',
  emails: ['anna@north-lab.test'],
  phones: [{ number: '+39 333 555 0101', type: 'mobile' }],
};

const duplicate: ContactDuplicateMatch = {
  contact: existing,
  strength: 'strong',
  reason: 'email',
  tier: 'probable',
  score: 82,
  reasons: ['stessa email osservata o confermata'],
  signals: [
    {
      kind: 'email_same',
      strength: 'strong',
      score: 72,
      fields: ['emails'],
    },
  ],
  equalFields: ['emails', 'phones'],
  differentFields: ['name', 'company'],
};

async function chooseButton(
  label: string
): Promise<ContactDuplicateUserDecision> {
  resetAlertStub();
  const pending = promptResolveDuplicateContact(duplicate);
  const alert = getLatestAlert();
  const button = alert.buttons.find((item) => item.text === label);
  assert.ok(button?.onPress, `azione non mostrata: ${label}`);
  button.onPress();
  return pending;
}

test('DEDUP-UI mostra livello, motivo, diff e le tre decisioni esplicite', async () => {
  resetAlertStub();
  const pending = promptResolveDuplicateContact(duplicate);
  const alert = getLatestAlert();

  assert.match(alert.title, /contatto/i);
  assert.match(alert.message ?? '', /livello:\s*probabile/i);
  assert.match(alert.message ?? '', /motivo:/i);
  assert.match(alert.message ?? '', /campi uguali:/i);
  assert.match(alert.message ?? '', /campi differenti:/i);
  assert.deepEqual(
    alert.buttons.map((button) => button.text),
    [
      'Annulla',
      'Salva come nuovo',
      'Aggiorna contatto esistente',
    ]
  );
  alert.buttons[0]?.onPress?.();
  assert.equal(await pending, 'cancel');

  assert.equal(
    await chooseButton('Aggiorna contatto esistente'),
    'update_existing'
  );
  assert.equal(await chooseButton('Salva come nuovo'), 'save_new');
  assert.equal(await chooseButton('Annulla'), 'cancel');
});

test('DEDUP-UI chiusura di sistema equivale ad annullamento', async () => {
  resetAlertStub();
  const pending = promptResolveDuplicateContact(duplicate);
  getLatestAlert().options?.onDismiss?.();
  assert.equal(await pending, 'cancel');
});

function fieldProposals(): ContactDuplicateFieldProposal[] {
  return CONTACT_REPARSABLE_FIELD_KEYS.map((field) => ({
    field,
    currentDisplay: `attuale-${field}`,
    proposedDisplay: `proposto-${field}`,
    status:
      field === 'company'
        ? 'protected'
        : field === 'role'
          ? 'selectable'
          : 'unchanged',
  }));
}

test('DEDUP-UI update mostra tutti i campi e seleziona solo i delta non protetti', async () => {
  resetAlertStub();
  const pending = promptSelectDuplicateUpdateFields(fieldProposals());
  const review = getLatestAlert();

  for (const label of [
    'Nome',
    'Cognome',
    'Azienda',
    'Ruolo',
    'Email',
    'Telefono',
    'Sito web',
    'Indirizzo',
    'Partita IVA',
    'Codice Fiscale',
  ]) {
    assert.match(review.message ?? '', new RegExp(label, 'i'));
  }
  assert.match(review.message ?? '', /Azienda — protetto/i);
  assert.match(review.message ?? '', /attuale-company/i);
  assert.match(review.message ?? '', /proposto-company/i);
  assert.equal(
    review.buttons.some((button) => button.text === 'Usa proposto'),
    false
  );

  review.buttons
    .find((button) => button.text === 'Scegli campo per campo')
    ?.onPress?.();
  await Promise.resolve();

  const roleChoice = getLatestAlert();
  assert.match(roleChoice.title, /Ruolo/i);
  assert.match(roleChoice.message ?? '', /attuale-role/i);
  assert.match(roleChoice.message ?? '', /proposto-role/i);
  roleChoice.buttons
    .find((button) => button.text === 'Usa proposto')
    ?.onPress?.();

  assert.deepEqual(await pending, {
    decision: 'update_existing',
    selectedFields: ['role'],
  });
});

test('DEDUP-UI annullare la review non seleziona né aggiorna alcun campo', async () => {
  resetAlertStub();
  const pending = promptSelectDuplicateUpdateFields(fieldProposals());
  getLatestAlert().buttons
    .find((button) => button.text === 'Scegli campo per campo')
    ?.onPress?.();
  await Promise.resolve();
  getLatestAlert().buttons
    .find((button) => button.text === 'Annulla')
    ?.onPress?.();

  assert.deepEqual(await pending, { decision: 'cancel' });
});

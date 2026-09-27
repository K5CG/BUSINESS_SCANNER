import assert from 'node:assert/strict';
import test from 'node:test';
import i18n from '../i18n';
import type { OrderDocument } from '../types';
import {
  documentDuplicatePromptMessage,
  promptResolveDocumentDuplicate,
} from '../lib/document-duplicate-guard';
import {
  getLatestAlert,
  resetAlertStub,
} from './stubs/react-native-alert-stub';

const existing: OrderDocument = {
  id: 'stored-order',
  type: 'order',
  title: 'Ordine 2025/0874',
  images: [],
  rawText: '',
  confidence: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
  orderNumber: '2025/0874',
  items: [],
};

test('strong duplicate prompt uses Italian identity copy and three actions', async () => {
  await i18n.changeLanguage('it');
  resetAlertStub();
  const pending = promptResolveDocumentDuplicate({
    kind: 'strong',
    document: existing,
    number: '2025/0874',
  });
  const alert = getLatestAlert();
  assert.equal(alert.title, 'Documento già presente');
  assert.match(alert.message ?? '', /Esiste già un ordine con numero 2025\/0874/);
  assert.match(alert.message ?? '', /Vuoi aprire il documento esistente/);
  assert.deepEqual(
    alert.buttons.map((button) => button.text),
    ['Annulla', 'Salva comunque', 'Apri esistente']
  );
  alert.buttons.find((button) => button.text === 'Salva comunque')?.onPress?.();
  assert.equal(await pending, 'save_anyway');
});

test('possible duplicate prompt is not presented as certain', async () => {
  await i18n.changeLanguage('it');
  resetAlertStub();
  const pending = promptResolveDocumentDuplicate({
    kind: 'possible',
    document: existing,
  });
  const alert = getLatestAlert();
  assert.equal(alert.title, 'Possibile duplicato');
  assert.match(alert.message ?? '', /documento simile già salvato/i);
  assert.doesNotMatch(alert.message ?? '', /Esiste già un ordine/);
  assert.deepEqual(
    alert.buttons.map((button) => button.text),
    ['Annulla', 'Salva comunque', 'Visualizza esistente']
  );
  alert.buttons.find((button) => button.text === 'Annulla')?.onPress?.();
  assert.equal(await pending, 'cancel');
});

test('English strong duplicate copy is available', async () => {
  await i18n.changeLanguage('en');
  resetAlertStub();
  const message = documentDuplicatePromptMessage({
    kind: 'strong',
    document: existing,
    number: '2025/0874',
  });
  assert.match(message, /An order with number 2025\/0874 already exists/);
  const pending = promptResolveDocumentDuplicate({
    kind: 'strong',
    document: existing,
    number: '2025/0874',
  });
  const alert = getLatestAlert();
  assert.equal(alert.title, 'Document already exists');
  assert.deepEqual(
    alert.buttons.map((button) => button.text),
    ['Cancel', 'Save anyway', 'Open existing']
  );
  alert.buttons.find((button) => button.text === 'Open existing')?.onPress?.();
  assert.equal(await pending, 'open_existing');
});

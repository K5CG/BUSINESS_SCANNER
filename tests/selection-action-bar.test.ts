import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const bar = fs.readFileSync(path.join(root, 'components', 'SelectionActionBar.tsx'), 'utf8');
const documents = fs.readFileSync(path.join(root, 'app', '(tabs)', 'documents.tsx'), 'utf8');
const contacts = fs.readFileSync(path.join(root, 'app', '(tabs)', 'contacts.tsx'), 'utf8');
const it = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'it.json'), 'utf8')) as Record<string, string>;
const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'en.json'), 'utf8')) as Record<string, string>;

test('layout is three equal columns', () => {
  assert.match(bar, /titleRow/);
  assert.match(bar, /controlRow/);
  assert.match(bar, /selectionSelectedTitle/);
  assert.match(bar, /selectionSelectAllShort/);
  assert.match(bar, /t\('delete'\)/);
});

test('selected count is a number only', () => {
  assert.match(bar, /\{String\(count\)\}/);
  assert.doesNotMatch(bar, /selectionCountOne|selectionCountMany|documentsSelectedCount/);
  assert.match(bar, /flexShrink: 0/);
  assert.match(bar, /numberOfLines=\{1\}/);
});

test('select-all is a checkbox without duplicate text label', () => {
  assert.match(bar, /accessibilityRole="checkbox"/);
  assert.match(bar, /accessibilityLabel=\{t\('selectionSelectAll'\)\}/);
  assert.match(bar, /allVisibleSelected\) onDeselectVisible/);
  assert.match(bar, /onSelectAll\(\)/);
  assert.match(bar, /onDismiss/);
});

test('close X dismisses the whole selection', () => {
  assert.match(bar, /name="close"/);
  assert.match(bar, /accessibilityLabel=\{t\('selectionClear'\)\}/);
  assert.match(documents, /onDismiss=\{\(\) => setSelectedDocumentIds\(new Set\(\)\)\}/);
  assert.match(contacts, /onDismiss=\{\(\) => setListSelectedIds\(new Set\(\)\)\}/);
});

test('partial selection uses mixed checkbox state', () => {
  assert.match(bar, /const mixed = someVisibleSelected && !allVisibleSelected/);
  assert.match(bar, /'mixed'/);
  assert.match(bar, /indeterminateBox/);
});

test('delete is icon-only and disabled at zero', () => {
  assert.match(bar, /trash-outline/);
  assert.match(bar, /accessibilityLabel=\{t\('selectionDelete'\)\}/);
  assert.match(bar, /deleteDisabled = busy \|\| count === 0/);
  assert.doesNotMatch(bar, /deleteLabel/);
});

test('Documents and Contacts share the same bar', () => {
  assert.match(documents, /<SelectionActionBar/);
  assert.match(contacts, /<SelectionActionBar/);
  assert.match(documents, /onDeselectVisible=\{deselectVisibleSelectedDocuments\}/);
  assert.match(contacts, /onDeselectVisible=\{deselectVisibleSelectedContacts\}/);
});

test('Italian and English titles', () => {
  assert.equal(it.selectionSelectedTitle, 'Selezionati');
  assert.equal(it.selectionSelectAll, 'Seleziona tutti');
  assert.equal(it.selectionSelectAllShort, 'Selez. tutti');
  assert.equal(it.delete, 'Elimina');
  assert.equal(it.selectionDelete, 'Elimina selezionati');
  assert.equal(en.selectionSelectedTitle, 'Selected');
  assert.equal(en.selectionSelectAll, 'Select all');
  assert.equal(en.selectionSelectAllShort, 'Select all');
  assert.equal(en.delete, 'Delete');
  assert.equal(en.selectionDelete, 'Delete selected');
});

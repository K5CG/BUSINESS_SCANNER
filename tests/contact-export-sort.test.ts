import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sortContactsForExport, type ContactExportSortMode } from '../lib/contact-export-sort.ts';
import type { BusinessCard } from '../types/index.ts';

function card(id: string, name: string, createdAt: string): BusinessCard {
  return {
    id,
    type: 'business_card',
    title: name,
    images: [],
    rawText: '',
    confidence: {},
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    firstName: name,
    lastName: '',
    role: '',
    company: '',
    emails: [],
    phones: [],
  };
}

const contacts = [
  card('old-z', 'Zulu', '2026-01-01T09:00:00Z'),
  card('new-a', 'Alpha', '2026-03-01T09:00:00Z'),
  card('middle', 'Mike', '2026-02-01T09:00:00Z'),
];

for (const [mode, expected] of [
  ['newest', ['new-a', 'middle', 'old-z']],
  ['oldest', ['old-z', 'middle', 'new-a']],
  ['name-asc', ['new-a', 'middle', 'old-z']],
  ['name-desc', ['old-z', 'middle', 'new-a']],
] as const satisfies ReadonlyArray<readonly [ContactExportSortMode, string[]]>) {
  test(`${mode}: applica l'ordine richiesto`, () => {
    assert.deepEqual(sortContactsForExport(contacts, mode).map(({ id }) => id), expected);
  });
}

test('l’ordinamento è stabile e non modifica l’array originale', () => {
  const tied = [card('first', 'Same', '2026-01-01'), card('second', 'same', '2026-01-01')];
  const originalIds = tied.map(({ id }) => id);
  assert.deepEqual(sortContactsForExport(tied, 'newest').map(({ id }) => id), originalIds);
  assert.deepEqual(sortContactsForExport(tied, 'name-asc').map(({ id }) => id), originalIds);
  assert.deepEqual(tied.map(({ id }) => id), originalIds);
});

test('nomi mancanti usano azienda o fallback senza perdere stabilità', () => {
  const companyOnly = card('company', '', '2026-01-02');
  companyOnly.company = 'Beta Company';
  const missing = card('missing', '', '2026-01-01');
  missing.title = '';
  const alpha = card('alpha', 'Alpha', '2026-01-03');
  assert.deepEqual(
    sortContactsForExport([missing, companyOnly, alpha], 'name-asc', 'Business card').map(({ id }) => id),
    ['alpha', 'company', 'missing'],
  );
});

test('data decrescente porta in cima gli otto ID reali nell’ordine createdAt', () => {
  const latest = [
    ['d0179007-c15d-4309-8a00-74bce21380ed', '2026-08-01T14:20:44.845Z'],
    ['05fa8a2a-4d4e-4504-a0dd-73c7e9029225', '2026-08-01T14:20:21.838Z'],
    ['b156f59b-0d1c-4fda-9902-1692859a8d66', '2026-08-01T14:20:02.430Z'],
    ['1f8b98ec-87c8-46e8-b986-cb519cf8edb1', '2026-08-01T14:19:41.693Z'],
    ['2035bdcc-b0b3-4f14-94fd-0acececc2390', '2026-08-01T14:18:14.923Z'],
    ['e33b13e0-30b3-4f39-972f-97e4603be4b8', '2026-08-01T14:16:33.031Z'],
    ['9dcd669a-a485-4be3-9eb6-074a0cf87e62', '2026-08-01T14:15:13.472Z'],
    ['db0dc964-3586-43bf-81c8-32f8a2e64bb2', '2026-08-01T14:14:15.116Z'],
  ] as const;
  const older = Array.from({ length: 27 }, (_, index) =>
    card(`older-${index}`, `Older ${index}`, `2026-07-${String(index + 1).padStart(2, '0')}T12:00:00Z`),
  );
  const realLatest = latest.map(([id, createdAt], index) => card(id, `Latest ${index}`, createdAt));
  const sortedIds = sortContactsForExport([...older, ...realLatest], 'newest').map(({ id }) => id);
  assert.deepEqual(sortedIds.slice(0, 8), latest.map(([id]) => id));
});

test('Contatti ed Export usano lo stesso controllo a quattro direzioni', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'app/(tabs)/contacts.tsx'), 'utf8');
  const controls = fs.readFileSync(path.join(process.cwd(), 'components/ContactSortControls.tsx'), 'utf8');
  assert.match(source, /useState<ContactExportSortMode>\('newest'\)/);
  assert.equal((source.match(/<ContactSortControls/g) ?? []).length, 2);
  assert.match(source, /value=\{sortMode\}[\s\S]*onChange=\{setSortMode\}/);
  assert.match(source, /value=\{exportSortMode\}[\s\S]*onChange=\{setExportSortMode\}/);
  assert.equal((controls.match(/accessibilityRole="radio"/g) ?? []).length, 1);
  assert.match(controls, /accessibilityState=\{\{ selected \}\}/);
  assert.match(controls, /accessibilityHint=\{t\(hintKey\)\}/);
  assert.match(controls, /icon: 'arrow-up'/);
  assert.match(controls, /icon: 'arrow-down'/);
  assert.doesNotMatch(source, /setExportSortMode[\s\S]{0,120}setSelectedIds/);
});

test('il controllo resta su una riga e va a capo solo quando serve', () => {
  const controls = fs.readFileSync(path.join(process.cwd(), 'components/ContactSortControls.tsx'), 'utf8');
  assert.match(controls, /flexDirection: 'row'/);
  assert.match(controls, /flexWrap: 'wrap'/);
  assert.match(controls, /minWidth: 44/);
  assert.match(controls, /minHeight: 44/);
  assert.match(controls, /criterionActive/);
  assert.match(controls, /directionActive/);
});

test('italiano e inglese localizzano tutte le opzioni', () => {
  for (const locale of ['it', 'en']) {
    const translations = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), `i18n/${locale}.json`), 'utf8'),
    ) as Record<string, string>;
    for (const key of [
      'exportSortNewest',
      'exportSortOldest',
      'exportSortNameAsc',
      'exportSortNameDesc',
      'contactsSortDate',
      'contactsSortName',
      'sortDateAscendingHint',
      'sortDateDescendingHint',
      'sortNameAscendingHint',
      'sortNameDescendingHint',
    ]) {
      assert.ok(translations[key]);
    }
  }
});

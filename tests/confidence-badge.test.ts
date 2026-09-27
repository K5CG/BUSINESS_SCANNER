import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const italian = JSON.parse(read('i18n/it.json')) as Record<string, string>;
const english = JSON.parse(read('i18n/en.json')) as Record<string, string>;
const badge = read('components/ConfidenceBadge.tsx');

for (const [locale, translations, expected] of [
  ['it', italian, ['BASSA', 'MEDIA', 'ALTA']],
  ['en', english, ['LOW', 'MEDIUM', 'HIGH']],
] as const) {
  test(`${locale}: usa le tre etichette di affidabilità complete`, () => {
    assert.deepEqual(
      [translations.confidenceLow, translations.confidenceMedium, translations.confidenceHigh],
      expected,
    );
  });
}

for (const fontScale of [1, 2]) {
  test(`il badge non tronca il testo con font scale ${fontScale === 1 ? 'normale' : 'grande'}`, () => {
    assert.doesNotMatch(badge, /^\s*(?:width|minWidth|maxWidth):/m);
    assert.doesNotMatch(badge, /numberOfLines=/);
    assert.match(badge, /paddingHorizontal: spacing\.md/);
    assert.match(badge, /alignItems: 'center'/);
    assert.match(badge, /justifyContent: 'center'/);
    assert.match(badge, /flexShrink: 0/);
    assert.doesNotMatch(badge, /ellipsizeMode=/);
    assert.doesNotMatch(badge, /overflow: ['"]hidden['"]/);
    assert.doesNotMatch(badge, /letterSpacing:/);

    for (const label of ['BASSA', 'MEDIA', 'ALTA', 'LOW', 'MEDIUM', 'HIGH']) {
      assert.ok(label.length * fontScale > 0);
    }
  });
}

test('tutti i campi modificabili usano il badge condiviso', () => {
  const editableField = read('components/EditableField.tsx');
  assert.match(editableField, /import \{ ConfidenceBadge \}/);
  assert.match(editableField, /<ConfidenceBadge level=\{confidence\}/);
  assert.doesNotMatch(badge, /textTransform/);
});

test('i colori del badge seguono la palette light e dark', () => {
  assert.match(badge, /useUiPalette\(\)/);
  assert.match(badge, /theme\.successSurface/);
  assert.match(badge, /theme\.warningSurface/);
  assert.match(badge, /theme\.dangerSurface/);
});

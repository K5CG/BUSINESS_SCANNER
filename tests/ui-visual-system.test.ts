import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { radii, spacing, touchTarget, typography } from '../lib/ui-system.ts';

test('il sistema espone tutti i ruoli tipografici richiesti', () => {
  assert.deepEqual(Object.keys(typography), [
    'display',
    'heading1',
    'heading2',
    'heading3',
    'body',
    'bodySecondary',
    'label',
    'caption',
    'button',
    'input',
  ]);
});

test('ogni ruolo mantiene line-height leggibile e pesi portabili', () => {
  const portableWeights = new Set(['400', '500', '600', '700']);
  for (const [role, style] of Object.entries(typography)) {
    assert.ok(style.lineHeight > style.fontSize, role);
    assert.ok(portableWeights.has(style.fontWeight), role);
  }
});

test('scala spaziature e raggi è monotona', () => {
  const spacingValues = Object.values(spacing);
  const radiusValues = Object.values(radii);
  assert.deepEqual(spacingValues, [...spacingValues].sort((a, b) => a - b));
  assert.deepEqual(radiusValues, [...radiusValues].sort((a, b) => a - b));
});

test('touch target centrali non scendono sotto 44 dp', () => {
  assert.ok(touchTarget.minimum >= 44);
  assert.ok(touchTarget.comfortable >= touchTarget.minimum);
});

test('i controlli compatti principali applicano il touch target centrale', () => {
  for (const file of [
    'app/(tabs)/index.tsx',
    'components/EditableField.tsx',
    'components/LicenseActivationScreen.tsx',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /touchTarget\.minimum/, file);
  }
});

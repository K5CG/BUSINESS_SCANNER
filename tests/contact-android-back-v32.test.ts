import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('app/document/[id].tsx', 'utf8');

test('V32: il dettaglio contatto registra il Back hardware solo mentre e in primo piano', () => {
  assert.match(source, /BackHandler\.addEventListener\(\s*['"]hardwareBackPress['"]/);
  assert.match(source, /return \(\) => subscription\.remove\(\)/);
  assert.match(source, /if \(Platform\.OS !== ['"]android['"]\) return undefined/);
});

test('V32: triangolo Android e freccia superiore usano lo stesso handleBack', () => {
  const handleBackUses = source.match(/handleBack\(\)/g) ?? [];
  assert.ok(handleBackUses.length >= 1);
  assert.match(source, /onPress=\{handleBack\}/);
});

test('V32: senza history un contatto torna alla lista Contatti', () => {
  assert.match(
    source,
    /documentRef\.current\?\.type === ['"]business_card['"][\s\S]*?\/\(tabs\)\/contacts/,
  );
});

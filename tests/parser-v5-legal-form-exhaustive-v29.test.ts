import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEGAL_FORM_CATALOG,
  legalFormCompactKey,
  preferredLegalFormDisplayForKey,
  repairUniqueLegalFormOcr,
} from '../lib/parser-engine/validators/legal-form-catalog';

function distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j]!;
  }
  return previous[b.length]!;
}

const catalogKeys = [...new Set(
  LEGAL_FORM_CATALOG
    .map((entry) => legalFormCompactKey(entry.canonical))
    .filter((key) => /^[A-Z0-9]+$/.test(key))
)];

function expectedRepair(mutant: string): string | null {
  if (mutant.length < 2 || mutant.length > 24) return null;
  if (catalogKeys.includes(mutant)) return preferredLegalFormDisplayForKey(mutant);
  let best = Number.POSITIVE_INFINITY;
  let winners: string[] = [];
  for (const candidate of catalogKeys) {
    if (Math.abs(candidate.length - mutant.length) > 1) continue;
    const value = distance(mutant, candidate);
    if (value < best) {
      best = value;
      winners = [candidate];
    } else if (value === best) {
      winners.push(candidate);
    }
  }
  return best === 1 && winners.length === 1
    ? preferredLegalFormDisplayForKey(winners[0]!)
    : null;
}

test('V29: tutte le alterazioni OCR a un edit seguono candidato-unico o fail-closed', () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const mutants = new Set<string>();
  for (const key of catalogKeys) {
    for (let index = 0; index < key.length; index++) {
      mutants.add(key.slice(0, index) + key.slice(index + 1));
      for (const glyph of alphabet) {
        if (glyph !== key[index]) {
          mutants.add(key.slice(0, index) + glyph + key.slice(index + 1));
        }
      }
    }
    for (let index = 0; index <= key.length; index++) {
      for (const glyph of alphabet) {
        mutants.add(key.slice(0, index) + glyph + key.slice(index));
      }
    }
  }

  const failures: string[] = [];
  for (const mutant of mutants) {
    const expected = expectedRepair(mutant);
    const actual = repairUniqueLegalFormOcr(mutant);
    if (actual !== expected) failures.push(`${mutant}: ${String(actual)} != ${String(expected)}`);
  }
  assert.ok(mutants.size > 20_000, `copertura insufficiente: ${mutants.size}`);
  assert.deepEqual(failures, []);
});

test('V29: parole aziendali comuni non diventano forme societarie', () => {
  const ordinaryWords = [
    'STORE', 'STUDIO', 'DESIGN', 'SERVICE', 'SERVICES', 'SYSTEM', 'SYSTEMS',
    'GROUP', 'CONSULTING', 'ENGINEERING', 'INDUSTRIAL', 'AUTOMATION', 'SOFTWARE',
    'HARDWARE', 'LOGISTICS', 'TRADING', 'ITALY', 'OFFICE', 'ROAD', 'STREET',
  ];
  for (const word of ordinaryWords) {
    assert.equal(repairUniqueLegalFormOcr(word), null, word);
  }
});

test('V29: il glifo reale B.n.c converge univocamente a S.n.c.', () => {
  assert.equal(repairUniqueLegalFormOcr('B.n.c'), 'S.n.c.');
  assert.equal(repairUniqueLegalFormOcr('BNC'), null, 'senza punti resta ambiguo con Inc.');
});

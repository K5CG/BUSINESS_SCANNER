import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { getSafeContactEmails } from '../lib/email-evidence';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

function page(lines: readonly string[]): CardPageV5 {
  return {
    lines: lines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.93,
        boundingBox: { x: 4, y: index * 28, width: 300, height: 20 },
      })
    ),
    rawText: lines.join('\n'),
  };
}

test('email con spazi attorno a @ resta una proposta in review', () => {
  const result = extractCardV5([page(['Nora Vale', 'nora @ northlab.com'])]);
  const item = result.repairProposals?.find((entry) => entry.field === 'email');
  assert.ok(item);
  assert.equal(item.repaired, 'nora@northlab.com');
  assert.equal(item.requiresReview, true);
});

test('TLD separato del sito viene proposto senza uso operativo', () => {
  const result = extractCardV5([page(['www.northlab. com'])]);
  const item = result.repairProposals?.find((entry) => entry.field === 'website');
  assert.ok(item);
  assert.equal(item.operational, false);
  assert.match(item.repaired, /northlab\.com/i);
});

test('icona davanti al sito viene rimossa con provenance', () => {
  const result = extractCardV5([page(['☎ www.northlab.com'])]);
  const item = result.repairProposals?.find((entry) => entry.field === 'website');
  assert.ok(item);
  assert.match(item.raw, /☎/);
  assert.ok(item.transformations.includes('remove_leading_contact_icon'));
});

test('O OCR viene sostituita solo in un telefono etichettato', () => {
  const result = extractCardV5([page(['Tel +39 045 21 O00 85'])]);
  const item = result.repairProposals?.find((entry) => entry.field === 'phone');
  assert.ok(item);
  assert.match(item.repaired, /21 000 85/);
});

test('O OCR dentro un nome non genera repair semantiche', () => {
  const result = extractCardV5([page(['N0RA VALE', 'Director'])]);
  assert.equal(result.repairProposals?.some((entry) => entry.raw.includes('N0RA')), false);
});

test('punteggiatura terminale del sito produce una sola repair sicura', () => {
  const result = extractCardV5([page(['www.northlab.com;'])]);
  const items = result.repairProposals?.filter((entry) => entry.field === 'website') ?? [];
  assert.equal(items.length, 1);
  assert.ok(items[0]!.transformations.includes('trim_trailing_punctuation'));
});

test('repair email insicura non viene costruita da nome e dominio', () => {
  const result = extractCardV5([page(['Nora Vale', 'northlab.com'])]);
  assert.equal(result.repairProposals?.some((entry) => entry.field === 'email'), false);
});

test('tutte le repair restano non confermate e non operative', () => {
  const result = extractCardV5([page(['nora @ northlab.com', '☎ www.northlab.com'])]);
  assert.ok((result.repairProposals?.length ?? 0) >= 2);
  assert.ok(result.repairProposals?.every((entry) => !entry.confirmed && !entry.operational));
});

test('export sicuro esclude una email repaired non confermata', () => {
  const result = extractCardV5([page(['nora @ northlab.com'])]);
  const safe = getSafeContactEmails({
    emails: result.emails.value ?? [],
    emailEvidence: result.emailEvidence,
  });
  assert.deepEqual(safe, []);
});

test('un valore email observed prevale sulla variante repaired nel merge di evidenza', () => {
  const result = extractCardV5([page(['nora@northlab.com', 'nora @ northlab.com'])]);
  const observed = result.emailEvidence.find((entry) => entry.value === 'nora@northlab.com');
  assert.equal(observed?.origin, 'observed');
  assert.equal(observed?.confirmed, true);
  assert.deepEqual(result.emails.value, ['nora@northlab.com']);
});

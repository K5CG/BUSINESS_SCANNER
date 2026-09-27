import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCardFromPagesV5 } from '../lib/parser-v5';

test('V93: recovers a complete Italian address from one observed CAP/province line', () => {
  const parsed = parseCardFromPagesV5([
    {
      rawText: 'Vicolo Tessitori, 15-36015 Schio (VI)',
      lines: [{ text: 'Vicolo Tessitori, 15-36015 Schio (VI)', confidence: 0.94 }],
    },
  ]);
  assert.equal(parsed.address?.street, 'Vicolo Tessitori');
  assert.equal(parsed.address?.civicNumber, '15');
  assert.equal(parsed.address?.postalCode, '36015');
  assert.equal(parsed.address?.city, 'Schio');
  assert.equal(parsed.address?.region, 'VI');
});

test('V93: keeps an observed legal form and only restores acronym punctuation', () => {
  const parsed = parseCardFromPagesV5([
    {
      rawText: 'S.A.GE. MA, s.n.c.\nDante Chierico',
      lines: [
        { text: 'S.A.GE. MA, s.n.c.', confidence: 0.95 },
        { text: 'Dante Chierico', confidence: 0.95 },
      ],
    },
  ]);
  assert.equal(parsed.company, 'S.A.GE. MA. S.n.c.');
});

test('V93: removes binary-looking OCR prefix without removing a normal company word', () => {
  const parsed = parseCardFromPagesV5([
    {
      rawText: '001010101loi00x00 Esqogito S.r.l.',
      lines: [{ text: '001010101loi00x00 Esqogito S.r.l.', confidence: 0.8 }],
    },
  ]);
  assert.doesNotMatch(parsed.company, /^[01OIlxX]{6,}/u);
});

test('V93: email correction needs the selected person plus exactly one OCR edit', () => {
  const parsed = parseCardFromPagesV5([
    {
      rawText: 'Stefano Pasin\nstefano.posin@derga.it',
      lines: [
        { text: 'Stefano Pasin', confidence: 0.98 },
        { text: 'stefano.posin@derga.it', confidence: 0.96 },
      ],
    },
  ]);
  assert.ok(parsed.emails.includes('stefano.pasin@derga.it'));
  assert.ok(parsed.emailEvidence.some((email) => email.requiresReview));
});

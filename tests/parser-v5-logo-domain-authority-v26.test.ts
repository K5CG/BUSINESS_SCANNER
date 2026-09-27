import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { extractCardV5, type CardPageV5 } from '../lib/parser-v5/engine';

function page(texts: string[]): CardPageV5 {
  const lines = texts.map((text, index): OcrLine => ({
    text,
    confidence: 0.96,
    boundingBox: {
      x: 20,
      y: index * 34,
      width: Math.max(140, text.length * 8),
      height: index === 0 ? 42 : 22,
    },
  }));
  return { lines, rawText: texts.join('\n') };
}

test('V26 real DERGA: logo OCR DERGAE non prevale su www.derga.it e dominio email osservato', () => {
  const result = extractCardV5([
    page([
      'DERGAE',
      'C 0 N SULT ING',
      'Account Manager',
      'Fabrizio Lorigiola',
      'fabrizio.lorigiola a derga. it',
      '+39 346 4730515',
      'Centro direzionale:',
      'Via Frischin,3 - 39100 Bolzano',
      'Tel. 0471 502911 Fax 0471 922601',
      'P. 00759940216',
      'Filiali:',
      'Padova: Via Panà, 56/A-35027 Noventa Padovana',
      'Tel. 049 8078789 Fax 049 8077137',
      'Ancona: Via Brodolini,6 - 60035 Jesi',
      'www.derga.it',
      'Tel. 0731 215854',
      'Milano: Via S. Gregorio, 29 - 20124 Milano',
      'Tel. 02 66980134',
    ]),
  ]);
  assert.equal(result.company.value, 'DERGA Consulting');
  assert.ok(!/DERGAE/i.test(result.company.value ?? ''));
  assert.match(result.company.reasons.join(' '), /logo|dominio|sito/i);
});

test('V26: due email business concordi correggono un glifo logo minimo senza sito', () => {
  const result = extractCardV5([
    page([
      'ACMEQ',
      'Mario Rossi',
      'Sales Manager',
      'mario.rossi@acme.it',
      'sales@acme.it',
      '+39 02 1234567',
    ]),
  ]);
  assert.equal((result.company.value ?? '').toUpperCase(), 'ACME');
  assert.ok(result.company.score <= 0.82);
});

test('V26: sito + email concordi correggono il brand anche se il token e in mezzo alla company', () => {
  const result = extractCardV5([
    page([
      'Solutions BETAA Consulting',
      'John Doe',
      'Director',
      'john@beta.com',
      'www.beta.com',
    ]),
  ]);
  assert.ok(!/BETAA/i.test(result.company.value ?? ''));
  assert.match(result.company.value ?? '', /BETA/i);
});

test('V26: logo non corroborato non viene riscritto da fantasia', () => {
  const result = extractCardV5([
    page([
      'XYZART',
      'Jane Doe',
      'Designer',
      '+44 20 1234 5678',
    ]),
  ]);
  assert.ok(!result.company.value || /XYZART/i.test(result.company.value));
  if (result.company.value && /XYZART/i.test(result.company.value)) {
    assert.ok(result.company.score <= 0.58);
  }
});

test('V26: brand multi-parola distante dal dominio non viene appiattito', () => {
  const result = extractCardV5([
    page([
      'Global Career Partners',
      'Jane Doe',
      'Partner',
      'jane@derga.it',
      'www.derga.it',
    ]),
  ]);
  assert.notEqual(result.company.value, 'DERGA');
  assert.ok(!/^DERGA(?:\s|$)/i.test(result.company.value ?? ''));
});

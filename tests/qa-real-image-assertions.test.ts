import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateQaBusinessCard, normalizeQaText } from '../lib/qa-real-image-assertions';

function card(overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Fabio', lastName: 'De Vecchi', role: 'Area marketing', company: 'Gruppo Volta',
    emails: ['fabio.devecchi@gruppovolta.it'],
    phones: [{ number: '+39 045 6100883', type: 'work' }, { number: '+39 045 6100885', type: 'fax' }],
    website: 'www.gruppovolta.it',
    address: { street: 'Via Leida 8', city: 'Verona', full: 'Via Leida 8 - Verona' },
    extractionReview: { addressAlternatives: [] },
    ...overrides,
  } as any;
}

test('real-image oracle normalizes punctuation/casing but preserves token boundaries', () => {
  assert.equal(normalizeQaText('S.A.GE.MA.  S.n.c.'), 's.a.ge.ma. s.n.c.');
  assert.notEqual(normalizeQaText('De Vecchi'), normalizeQaText('Devecchi'));
});

test('real-image oracle catches fused surname and phone-contaminated address', () => {
  const result = evaluateQaBusinessCard(card({
    lastName: 'Devecchi',
    address: { full: 'Via Leida B, Verona, T 39 045 e1 000 B4' },
  }), {
    firstName: 'Fabio', lastName: 'De Vecchi', addressContains: ['Via Leida 8'],
    forbidAddressContains: ['T 39 045'],
  }, ['FABIO DE VECCHI\nArea marketing\nGruppo Volta']);
  assert.equal(result.pass, false);
  assert.ok(result.assertions.some((x) => x.id === 'lastName' && !x.pass));
  assert.ok(result.assertions.some((x) => x.id.startsWith('forbidAddress:') && !x.pass));
});

test('real-image oracle accepts structured contact and optional visual-only QR page', () => {
  const result = evaluateQaBusinessCard(card(), {
    firstName: 'Fabio', lastName: 'De Vecchi', roleContains: ['Area marketing'],
    companyContains: ['Gruppo Volta'], emailsContain: ['fabio.devecchi@gruppovolta.it'],
    phonesContainDigits: ['0456100883'], addressContains: ['Via Leida 8'], allowEmptyOcrPages: [1],
  }, ['Fabio De Vecchi\nArea marketing', '']);
  assert.equal(result.pass, true);
  assert.equal(result.warnings, 1);
});

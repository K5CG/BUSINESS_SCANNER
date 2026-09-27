import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCardV5 } from '../lib/parser-v5/engine';

function parse(rawText: string) {
  const lines = rawText.split(/\r?\n/).map((text) => ({ text, confidence: 0.85 }));
  return extractCardV5([{ rawText, lines }]);
}

test('batch 12/09: due telefoni internazionali distinti non vengono deduplicati per ultime 9 cifre', () => {
  const result = parse([
    'Markus Roithmeier',
    'Vice President',
    'Jedox AG',
    'Phone: +49 761 15147 222',
    'Mobile: +49 151 15147 222',
  ].join('\n'));
  assert.deepEqual(result.phones.value.map((p) => p.number), [
    '+49 761 15147 222',
    '+49 151 15147 222',
  ]);
});

test('batch 12/09: P. + PIVA italiana valida resta fiscale e non telefono', () => {
  const result = parse([
    'DERGA',
    'Fabrizio Lorigiola',
    'Account Manager',
    'Tel. 0471 502911',
    'P. 00759940216',
  ].join('\n'));
  assert.equal(result.vatNumber.value, '00759940216');
  assert.ok(!result.phones.value.some((p) => p.number.replace(/\D/g, '') === '00759940216'));
});

test('batch 12/09: TLD .ac e CAP giapponese NNN-NNNN sono strutturati senza falso telefono/civico piano', () => {
  const result = parse([
    'Michael Chang',
    'General Manager',
    'KOMINE CO.,LTD.',
    '2F, 1-38-16, Machiya, Arakawa-Ku, Tokyo, 116-0001 Japan',
    'Tel:+81-3-5901-7770',
    'HP:https://www.komine.ac/ E-mail:michael@komine.ac',
  ].join('\n'));
  assert.equal(result.website.value, 'www.komine.ac');
  assert.equal(result.address.value?.postalCode, '116-0001');
  assert.equal(result.address.value?.civicNumber, undefined);
  assert.ok(!result.phones.value.some((p) => p.number.replace(/\D/g, '') === '1160001'));
});

test('batch 12/09: slogan/attivita quality service non diventa ruolo personale', () => {
  const result = parse([
    'Peritus',
    'total quality service',
    'Ing. Luigi De Michieli',
    'e-mail : luigi. demichieli@ptqs.it',
  ].join('\n'));
  assert.equal(result.role.value, null);
  assert.deepEqual(result.emails.value, ['luigi.demichieli@ptqs.it']);
});

test('batch 12/09: sito www esplicito con virgola OCR viene riparato e prevale', () => {
  const result = parse([
    'Deana',
    'General Manager',
    'G&H INTERNATIONAL CO., LTD.',
    'E. deana@gandh.co.kr',
    'Web. www.gandh,co.kr',
  ].join('\n'));
  assert.deepEqual(result.emails.value, ['deana@gandh.co.kr']);
  assert.equal(result.website.value, 'www.gandh.co.kr');
});

test('batch 12/09: sito www esplicito prevale su dominio bare OCR incidentale', () => {
  const result = parse([
    'DERGA',
    'Fabrizio Lorigiola',
    'fabrizio.lorigiola oderga.it',
    'www.derga. it',
  ].join('\n'));
  assert.equal(result.website.value, 'www.derga.it');
});

test('batch 12/09: ZIP USA con spazi OCR viene ricomposto', () => {
  const result = parse([
    'Boston University',
    '755 Commonwealth Avenue',
    'Room B7',
    'Boston, Massachusetts 022 1 5',
  ].join('\n'));
  assert.equal(result.address.value?.postalCode, '02215');
  assert.equal(result.address.value?.city, 'Boston');
});

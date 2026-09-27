import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeCompanyValue,
} from '../lib/parser-v5/finalize';
import {
  resolveExplicitWebsiteFromText,
} from '../lib/parser-engine/validators/website';

test('un claim non usa come evidenza forte una email riparata', () => {
  assert.equal(
    finalizeCompanyValue(
      'INNOVATION FOR EVERYONE',
      ['nora.vale@aerolith-labs.example'],
      'INNOVATION FOR EVERYONE\nnora.vale @ aerolith-labs.example'
    ),
    null
  );
});

test('domini business osservati discordanti non scelgono il primo', () => {
  const rawText = [
    'INNOVATION FOR EVERYONE',
    'nora@aerolith-labs.example',
    'nora@meridian-works.example',
  ].join('\n');

  assert.equal(
    finalizeCompanyValue(
      'INNOVATION FOR EVERYONE',
      [
        'nora@aerolith-labs.example',
        'nora@meridian-works.example',
      ],
      rawText
    ),
    null
  );
  assert.equal(
    finalizeCompanyValue(
      'INNOVATION FOR EVERYONE',
      [
        'nora@meridian-works.example',
        'nora@aerolith-labs.example',
      ],
      rawText
    ),
    null
  );
});

test('bare domain etichettato Web è esplicito, un dominio email non lo è', () => {
  assert.equal(
    resolveExplicitWebsiteFromText(
      'Nora Vale\nnora@other.example\nWeb: meridian-works.com'
    ),
    'www.meridian-works.com'
  );
  assert.equal(
    resolveExplicitWebsiteFromText('Nora Vale\nnora@meridian-works.com'),
    undefined
  );
  assert.equal(
    finalizeCompanyValue(
      'INNOVATION FOR EVERYONE',
      ['nora@other.example'],
      'INNOVATION FOR EVERYONE\nnora@other.example\nWeb: meridian-works.com'
    ),
    null
  );
  assert.equal(
    finalizeCompanyValue(
      'INNOVATION FOR EVERYONE',
      [],
      'INNOVATION FOR EVERYONE\nWeb: meridian-works.com'
    ),
    'Meridian Works'
  );
});

test('riga Web o contatto non sostituisce una company plausibile', () => {
  const rawText = [
    'Lunar Harbor',
    'Nora Vale',
    'nora@lunar-harbor.test',
    'Web: lunar-harbor.test',
  ].join('\n');

  const company = finalizeCompanyValue(
    'Lunar Harbor',
    ['nora@lunar-harbor.test'],
    rawText
  );
  assert.equal(
    company?.replace(/[^a-z0-9]/gi, '').toLowerCase(),
    'lunarharbor'
  );
  assert.doesNotMatch(company ?? '', /^(?:web|contact)\s*:/i);
  assert.equal(
    finalizeCompanyValue('Web: lunar-harbor.test', [], rawText),
    null
  );
  assert.equal(
    finalizeCompanyValue('Contact: Nora Vale', [], rawText),
    null
  );
  assert.equal(
    resolveExplicitWebsiteFromText(rawText),
    'www.lunar-harbor.test'
  );
});

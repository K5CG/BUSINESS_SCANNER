import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { validateFinalAddress } from '../lib/parser-engine/validators/address';
import { extractBusinessCardV5 } from '../lib/parser-v5';
import { normalizeAddress } from '../lib/address-format';

function page(lines: readonly string[]) {
  return {
    rawText: lines.join('\n'),
    lines: lines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.96,
        boundingBox: {
          x: 4,
          y: index * 28,
          width: Math.max(100, text.length * 7),
          height: 20,
        },
      })
    ),
  };
}

test('prefisso telefonico OCR non diventa CAP o indirizzo', () => {
  const address = validateFinalAddress({
    full: '39045 eI O00 84',
    postalCode: '39045',
    city: 'Ei O',
  });

  assert.equal(address, null);
});

test('il falso CAP viene rimosso senza perdere una via osservata', () => {
  const address = validateFinalAddress({
    full: 'Via Leida 8, Verona - 39045 - Ei O',
    street: 'Via Leida 8, Verona',
    postalCode: '39045',
    city: 'Ei O',
  });

  assert.ok(address);
  assert.match(address.full ?? '', /Via Leida/i);
  assert.equal(address.postalCode, undefined);
  assert.equal(address.city, undefined);
  assert.doesNotMatch(address.full ?? '', /\b39045\b|Ei O/i);
});

test('un vero CAP con città e un indirizzo con via restano validi', () => {
  const capCity = validateFinalAddress({
    full: '39045 Milano',
    postalCode: '39045',
    city: 'Milano',
  });
  const streetAddress = validateFinalAddress({
    full: 'Via Roma 12 - 39045 - Milano',
    street: 'Via Roma 12',
    civicNumber: '12',
    postalCode: '39045',
    city: 'Milano',
  });

  assert.ok(capCity);
  assert.match(capCity.full ?? '', /\b39045\b/);
  assert.match(capCity.full ?? '', /Milano/i);
  assert.ok(streetAddress);
  assert.match(streetAddress.full ?? '', /Via Roma/i);
  assert.equal(streetAddress.postalCode, '39045');
  assert.match(streetAddress.city ?? streetAddress.full ?? '', /Milano/i);
});

test('il flusso parser conserva la via ma non il prefisso telefonico come CAP', () => {
  const result = extractBusinessCardV5([
    page([
      'NORTHSTAR LABS S.R.L.',
      'Elena North',
      'Area Marketing',
      'elena@northstar-labs.example',
      'F +39 045 21 O00 85',
      '39045 eI O00 84',
      'Via Leida 8, Verona',
    ]),
  ]);

  assert.ok(result.address.value);
  assert.match(result.address.value.full ?? '', /Via Leida/i);
  assert.equal(result.address.value.postalCode, undefined);
  assert.doesNotMatch(result.address.value.full ?? '', /\b39045\b|Ei O/i);
});

test('un CAP dopo virgola non viene duplicato come numero civico', () => {
  const address = normalizeAddress({
    street: 'Via Degli Scudai Centergross, 40050',
    postalCode: '40050',
    city: 'Funo di Argelato',
    region: 'BO',
    country: 'IT',
  });

  assert.ok(address);
  assert.equal(address.civicNumber, undefined);
  assert.equal(address.postalCode, '40050');
  assert.doesNotMatch(address.street ?? '', /\b40050\b/);
  assert.doesNotMatch(address.full ?? '', /Nr\.\s*40050/i);
});

test('civico ordinario e CAP distinti restano separati', () => {
  const address = normalizeAddress({
    street: 'Via Roma, 38',
    postalCode: '40050',
    city: 'Funo di Argelato',
    region: 'BO',
    country: 'IT',
  });

  assert.ok(address);
  assert.equal(address.civicNumber, '38');
  assert.equal(address.postalCode, '40050');
});

test('un civico esplicitamente etichettato può avere cinque cifre', () => {
  const address = normalizeAddress({
    street: 'Via Roma, Nr. 12345',
    postalCode: '40050',
    city: 'Funo di Argelato',
    region: 'BO',
    country: 'IT',
  });

  assert.ok(address);
  assert.equal(address.civicNumber, '12345');
  assert.equal(address.postalCode, '40050');
});

for (const civicLabel of [
  'n°',
  'No.',
  '#',
  'Civico',
  'Nro.',
  'Núm.',
  'Hausnummer',
]) {
  test(`il parser distingue il civico a cinque cifre con etichetta ${civicLabel} dal CAP`, () => {
    const result = extractBusinessCardV5([
      page([
        'ACME S.r.l.',
        'Nora Valli',
        'Managing Director',
        `Via Roma, ${civicLabel} 12345`,
        '40050 Funo di Argelato (BO)',
        'Italy',
      ]),
    ]);

    assert.equal(result.address.value?.civicNumber, '12345');
    assert.equal(result.address.value?.postalCode, '40050');
    assert.match(result.address.value?.street ?? '', /Via Roma/i);
    assert.match(result.address.value?.city ?? '', /Funo di Argelato/i);
  });
}

test('il parser conserva la via quando CAP e città precedono la strada sulla stessa riga', () => {
  const result = extractBusinessCardV5([
    page([
      'ECO-SABBIATURA S.n.c.',
      'di Erik Rizzo',
      '36031 DUEVILLE (VI) Via Corvo, 85',
      'info@ecosabbiatura.it',
    ]),
  ]);

  assert.match(result.address.value?.street ?? '', /Via Corvo/i);
  assert.equal(result.address.value?.civicNumber, '85');
  assert.equal(result.address.value?.postalCode, '36031');
  assert.match(result.address.value?.city ?? '', /Dueville/i);
});

test('un civico iniziale non prevale sul CAP in una riga città-regione-CAP', () => {
  for (const [
    street,
    location,
    expectedStreet,
    expectedCivic,
    expectedPostal,
    expectedCity,
    expectedRegion,
  ] of [
    [
      '1600 Pennsylvania Avenue NW',
      'Washington, DC 20500',
      /Pennsylvania Avenue NW/i,
      '1600',
      '20500',
      /Washington/i,
      'DC',
    ],
    [
      '1234 Main Road',
      'Austin, TX 78701',
      /Main Road/i,
      '1234',
      '78701',
      /Austin/i,
      'TX',
    ],
  ] as const) {
    const result = extractBusinessCardV5([
      page([
        'ACME LLC',
        'Nora Valli',
        'Managing Director',
        street,
        location,
      ]),
    ]);

    assert.match(result.address.value?.street ?? '', expectedStreet, street);
    assert.equal(result.address.value?.civicNumber, expectedCivic, street);
    assert.equal(result.address.value?.postalCode, expectedPostal, street);
    assert.match(result.address.value?.city ?? '', expectedCity, street);
    assert.equal(result.address.value?.region, expectedRegion, street);
  }
});

test('codici paese omografi non diventano stati USA senza evidenza', () => {
  for (const [full, expectedCity, expectedCountry] of [
    ['123 King Street - Toronto - CA', 'Toronto', 'CA'],
    ['42 Market Road - Mumbai - IN', 'Mumbai', 'IN'],
    ['10 Hafen Street - Berlin - DE', 'Berlin', 'DE'],
  ] as const) {
    const address = normalizeAddress({ full });
    assert.ok(address, full);
    assert.equal(address.country, expectedCountry, full);
    assert.equal(address.city, expectedCity, full);
    assert.equal(address.region, undefined, full);
  }
});

test('city, stato USA e ZIP costituiscono evidenza sufficiente per US', () => {
  for (const [full, expectedCity, expectedRegion, expectedPostal] of [
    ['500 Market Street - San Francisco, CA 94105', 'San Francisco', 'CA', '94105'],
    ['100 Meridian Street - Indianapolis, IN 46204', 'Indianapolis', 'IN', '46204'],
  ] as const) {
    const address = normalizeAddress({ full });
    assert.ok(address, full);
    assert.equal(address.country, 'US', full);
    assert.equal(address.city, expectedCity, full);
    assert.equal(address.region, expectedRegion, full);
    assert.equal(address.postalCode, expectedPostal, full);
  }
});

test('un codice paese esplicito dopo una regione resta un paese', () => {
  for (const [full, expectedCountry] of [
    ['100 King Street - Toronto - ON - CA', 'CA'],
    ['12 MG Road - Bengaluru - KA - IN', 'IN'],
  ] as const) {
    const address = normalizeAddress({ full });
    assert.ok(address, full);
    assert.equal(address.country, expectedCountry, full);
  }
});

test('un CAP internazionale a quattro cifre resta distinto dal civico', () => {
  const result = extractBusinessCardV5([
    page([
      'ACME AG',
      'Nora Valli',
      'Managing Director',
      'Bahnhofstrasse 10',
      '8001 Zürich',
    ]),
  ]);

  assert.match(result.address.value?.street ?? '', /Bahnhofstrasse/i);
  assert.equal(result.address.value?.civicNumber, '10');
  assert.equal(result.address.value?.postalCode, '8001');
});

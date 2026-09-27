import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import {
  extractCardV5,
  type CardPageV5,
} from '../lib/parser-v5/engine';
import { parseCardFromPagesV5 } from '../lib/parser-v5';

function page(lines: readonly string[]): CardPageV5 {
  return {
    lines: lines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.95,
        boundingBox: {
          x: 4,
          y: index * 28,
          width: Math.max(90, text.length * 7),
          height: index === 0 ? 30 : 20,
        },
      })
    ),
    rawText: lines.join('\n'),
  };
}

test('sedi inline separate sono persistite come primaria e alternativa', () => {
  const pages = [
    page([
      'MERIDIAN WORKS LTD.',
      'Nora Vale',
      'Managing Director',
      'Head Office / 10 Meridian Road, 20100 Milano, Italy',
      'Branch Office / 77 Aurora Avenue, 00100 Roma, Italy',
    ]),
  ];

  const result = extractCardV5(pages);
  const card = parseCardFromPagesV5(pages);

  assert.match(result.address.value?.full ?? '', /Meridian Road/i);
  assert.doesNotMatch(result.address.value?.full ?? '', /Aurora Avenue/i);
  assert.equal(result.addressAlternatives.length, 1);
  assert.match(result.addressAlternatives[0]?.full ?? '', /Aurora Avenue/i);
  assert.equal(card.extractionReview?.addressAlternatives?.length, 1);
  assert.equal(card.notes, undefined);
});

test('un blocco telefono dopo la sede non entra nelle alternative', () => {
  const result = extractCardV5([
    page([
      'MERIDIAN WORKS LTD.',
      'Nora Vale',
      'Head Office: 10 Meridian Road, 20100 Milano, Italy',
      'Tel: +39 02 5555 0101',
      'Branch Office: 77 Aurora Avenue, 00100 Roma, Italy',
      'Fax: +39 06 5555 0102',
    ]),
  ]);

  assert.equal(result.addressAlternatives.length, 1);
  assert.doesNotMatch(
    result.addressAlternatives.map((address) => address.full).join('\n'),
    /5555/
  );
});

test('una pagina non ammessa non produce indirizzi alternativi', () => {
  const result = extractCardV5([
    page([
      'ALPHA LABS LTD.',
      'Mario Rossi',
      'mario.rossi@alpha-labs.com',
      'Head Office: 10 Meridian Road, 20100 Milano, Italy',
    ]),
    page([
      'OMEGA SYSTEMS LTD.',
      'Giulia Bianchi',
      'giulia.bianchi@omega-systems.com',
      'Branch Office: 77 Aurora Avenue, 00100 Roma, Italy',
    ]),
  ]);

  assert.notEqual(result.pageCoherence.decision, 'match');
  const allAddresses = [
    result.address.value?.full ?? '',
    ...result.addressAlternatives.map((address) => address.full),
  ].join('\n');
  assert.equal(/Milano/i.test(allAddresses) && /Roma/i.test(allAddresses), false);
});

test('P.O. Box e indirizzo stradale restano nello stesso blocco', () => {
  const result = extractCardV5([
    page([
      'ATLAS GEAR LTD.',
      'Asim Nayyer',
      'CEO',
      'P.O. Box 2671, 10-Km Sambrial Road',
      'Sialkot 51310, Pakistan',
      'Tel: +92 52 6523488',
    ]),
  ]);
  assert.match(result.address.value?.full ?? '', /P\.O\. Box 2671/i);
  assert.match(result.address.value?.full ?? '', /Sialkot 51310/i);
  assert.doesNotMatch(result.address.value?.full ?? '', /6523488/);
  assert.equal(result.address.value?.addressType, 'po-box');
});

test('un intervallo civico osservato non viene ridotto', () => {
  const result = extractCardV5([
    page([
      'NORTH LAKE GMBH',
      'Bettina Pfeifer',
      'Director',
      'Grosse Seestrasse 32 - 34',
      '60486 Frankfurt am Main, Germany',
    ]),
  ]);
  assert.match(result.address.value?.full ?? '', /32\s*-\s*34/);
  assert.equal(result.address.value?.civicNumber, '32 - 34');
});

test('indirizzo multilinea conserva stanza, citta e CAP', () => {
  const result = extractCardV5([
    page([
      'NORTH UNIVERSITY',
      'Katie Vale',
      'Admissions Coordinator',
      '755 Commonwealth Avenue',
      'Room B7',
      'Boston, Massachusetts 02215',
      'Fax: 617-353-2744',
    ]),
  ]);
  assert.match(result.address.value?.full ?? '', /755 Commonwealth Avenue/i);
  assert.match(result.address.value?.full ?? '', /Room B7/i);
  assert.match(result.address.value?.full ?? '', /02215/);
  assert.equal(result.address.value?.rawLines?.length, 3);
});

test('civico stradale e identificativo edificio non vengono confusi', () => {
  const result = extractCardV5([
    page([
      'NORTH POLYTECHNIC',
      'Filippo Renga',
      'Via Lambruschini, 4b ed. 26B - 20156 Milano',
      'Tel: +39 02 2399 4801',
    ]),
  ]);
  assert.match(result.address.value?.full ?? '', /4b ed\. 26B/i);
  assert.notEqual(result.address.value?.civicNumber, '26B');
});

test('VAT adiacente interrompe il blocco indirizzo', () => {
  const result = extractCardV5([
    page([
      'MERIDIAN WORKS LTD.',
      'Nora Vale',
      'Via Aurora 7',
      '20100 Milano (MI)',
      'VAT: IT12345678901',
    ]),
  ]);
  assert.doesNotMatch(result.address.value?.full ?? '', /12345678901/);
});

test('sedi non etichettate separate da contatti restano distinte', () => {
  const result = extractCardV5([
    page([
      'MERIDIAN WORKS LTD.',
      'Nora Vale',
      '20100 Milano (MI)',
      'Via Aurora, 7',
      'Tel: +39 02 5555 0101',
      '00100 Roma (RM)',
      'Via Meridiana, 9',
      'Fax: +39 06 5555 0102',
    ]),
  ]);
  const addresses = [result.address.value, ...result.addressAlternatives]
    .map((address) => address?.full ?? '')
    .join('\n');
  assert.match(addresses, /Milano/i);
  assert.match(addresses, /Roma/i);
  assert.doesNotMatch(addresses, /5555/);
});

test('provenienza dei blocchi conserva pagina, ordine e righe OCR', () => {
  const result = extractCardV5([
    page([
      'MERIDIAN WORKS LTD.',
      'Nora Vale',
      'Head Office: 10 Meridian Road, 20100 Milano, Italy',
      'Branch Office: 77 Aurora Avenue, 00100 Roma, Italy',
    ]),
  ]);
  const addresses = [result.address.value, ...result.addressAlternatives].filter(Boolean);
  assert.ok(addresses.every((address) => address?.page === 0));
  assert.ok(addresses.every((address) => (address?.rawLines?.length ?? 0) >= 1));
  assert.deepEqual(addresses.map((address) => address?.order), [0, 1]);
});


// P0 address boundary batch regressions
test('P1 indirizzo: una riga ruolo interrompe il blocco indirizzo', () => {
  const result = extractCardV5([
    page([
      'ServOV Next Generation Platform',
      'Enrico Arata',
      "Corso Massimo d'Azeglio, 8",
      'Responsabile Servoy Italia',
      '10125 Torino',
      'Italia',
      'direct tel +39 335 29 59 65',
      'www.servoy.com',
    ]),
  ]);

  assert.ok(result.address.value?.full);
  assert.match(result.address.value!.full, /Corso Massimo d['’]Azeglio/i);
  assert.doesNotMatch(result.address.value!.full, /Responsabile Servoy/i);
});

test('P1 indirizzo: forma societaria inline prima della via non contamina la strada', () => {
  const result = extractCardV5([
    page([
      'PIVA 07793080016',
      '13P S.c.p.a. Corso Castelfidardo 30/A, 10129 Torino T +39',
      'ceaglio@i3p.it',
      'www.i3p.it',
      'Senior Consultant',
      'Massimiliano Ceaglio',
    ]),
  ]);

  assert.ok(result.address.value?.full);
  assert.match(result.address.value!.full, /Corso Castelfidardo/i);
  assert.doesNotMatch(result.address.value!.full, /13P S\.c\.p\.a\./i);
  assert.doesNotMatch(result.address.value!.full, /\+39\s*$/);
});

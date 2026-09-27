import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BusinessCard } from '../types';
import {
  applyBusinessCardReparseProposal,
  buildBusinessCardReparseProposal,
  reparseBusinessCardWithDecisions,
} from '../lib/contact-reparse';
import {
  applyManualContactEdits,
  initializeParsedContactReviewState,
} from '../lib/contact-review-state';
import { findContactDuplicateCandidates } from '../lib/duplicate-contacts-core';
import { withPersistenceRevision } from '../lib/scan-operation-lifecycle';
import {
  MemoryPersistenceAdapter,
  testCard,
} from './helpers/critical-workflow-harness';

const ATROX_RAW = [
  'Inspire the Next',
  'PO. Box-2671, 10-Km Sambrial Road, Sialkot-5 1310, Pakistan',
  'www.atrox-gear.com',
  '',
  'Asim Nayyer',
  '(CEO )',
  'Inspire the Net',
  'D92-333-8609110',
  'O92-52-6523488 / 6523499',
  '992-333-8609110',
  'asim.nayyer',
  'asim@atrox.pk',
  'Owww.atrox-gear.com',
].join('\n');

const CORIUM_RAW = [
  'CORIUM S.r.l.',
  'Via Tortona 33',
  '20144 Milano',
  'E-mail: tagliabueCeorium-S.r.l.it',
  'info@corium.it',
  'www.corium.it',
].join('\n');

const SAGEM_RAW = [
  'DANTE CHIERICO',
  'PERITO INDUSTRIALE',
  'S.A. GE. MA, s. n.c.',
  'SISTEMI AUTOMATICI GENERALI E MACCHINE',
  '36015 SCHIO (VIcenza) ITALY',
  'Vla Molise. 12 Z I.',
  'Codice Flscale 00255760241',
  'Telefono (0445) 671155',
  'Partita IVA 00255760241',
].join('\n');

const POLIMI_RAW = [
  'School of Management',
  'POLITECNICO DI MILANO',
  'Filippo',
  'Renga',
  'DIPARTIMENTO DI INGEGNERIA GESTIONALE',
  'Via Lambruschini, 4b ed. 26B- 20156 Milano',
  'filippo renga@polimi.it',
  'www.sompolimi.it',
].join('\n');

const PRICE_RAW = [
  'Management Consultants',
  'dr. Remiglio Sattanino',
  'Via Roma 255',
  '10123 Torino',
  'Telefono 011-510094',
  'Price Waterhouse Associates',
].join('\n');

const BOSTON_RAW = [
  'Boston University',
  'Division of Extended Education',
  'Metropolitan College',
  '755 Commonwealth Avenue',
  'Room B7',
  'Boston, Massachusetts 02215',
  '617-358-2153',
  'Fax: 617-353-2744',
  'E-mail: katiepobu. edu',
  'Katie L. Pasciucco',
  'Admissions & Outreach Coordinator',
].join('\n');

const GH_RAW = [
  'G&HINTERNATIONAL CO, LTD.',
  'Overseas Sales Dept. / General Manager',
  'Deana',
  '82-10-7396-3837',
  'Head Office / 2F, 629, Cheonho-daero, Gwangin-gu, Seoul 04931, Korea',
  'Web. www.gandh.co.kr',
  'E. deana@gandh.co.kr',
].join('\n');

const CORIUM_DEVICE_RAW = [
  'Gobal Career Partne',
  'arbora',
  'B-mail: tagliabueCeorium-srl.it',
  'Via Corregio, l9- 20149 Milano',
  'Amministratore Delegato',
  'Dott. Mlarco Tagliabue',
  'ORIUM',
].join('\n');

const DOLPHIN_DEVICE_RAW = [
  'Giorgio Bravi',
  'Dolphin Srl',
  'e-mail: gbravi@dolphin.it',
  '24040 BONATE SOTTO (BG)',
  'Via Vittorio Veneto, 2',
].join('\n');

const GRUPPOVITA_DEVICE_RAW = [
  'fabio.deverchi@gruppovita.it',
  'Www.ruppDvolta.it',
  'Via Leida B, Verona',
  'Gruppoita',
  'Area marketing',
  'FABIO DE VECCHI',
].join('\n');

const SOFTFABRIK_DEVICE_RAW = [
  'softfabrik',
  'Bettina Pfeifer',
  'Geschäftsführerin',
  'Große Seestra ße 32 - 34',
  '60486 Frankfurt am Main',
  'Postfach 90 05 62',
  '60445 Frankfurt am Main',
  'bettina.pfeifer@softfabrik.de',
  'www.softfabrik.de',
  'softfabrik GmbH',
].join('\n');

function savedCard(overrides: Partial<BusinessCard>): BusinessCard {
  return initializeParsedContactReviewState(
    testCard({
      title: 'Contatto precedente',
      firstName: '',
      lastName: '',
      role: '',
      company: '',
      emails: [],
      phones: [],
      ...overrides,
    })
  );
}

function runtime(card: BusinessCard): BusinessCard {
  return reparseBusinessCardWithDecisions(card).card;
}

test('BR-01 claim non resta azienda quando dominio e sito convergono', () => {
  const result = runtime(savedCard({ rawText: ATROX_RAW, company: 'Inspire the Next' }));
  assert.match(result.company, /atrox/i);
  assert.doesNotMatch(result.company, /inspire the next/i);
});

test('BR-02 riga email OCR corrotta non resta azienda', () => {
  const result = runtime(savedCard({ rawText: CORIUM_RAW, company: 'B-mail: tagliabueCeorium-S.r.l.it' }));
  assert.match(result.company, /corium/i);
  assert.doesNotMatch(result.company, /mail:|@|\.it$/i);
});

test('BR-03 dominio email e sito concordi arrivano al record applicato', () => {
  const result = runtime(savedCard({ rawText: ATROX_RAW, company: 'Inspire the Next' }));
  assert.ok(result.emails.some((value) => /@atrox\.pk$/i.test(value)));
  assert.match(result.website ?? '', /atrox-gear\.com/i);
  assert.match(result.company, /atrox/i);
});

test('BR-04 etichetta fiscale non resta persona', () => {
  const result = runtime(savedCard({ rawText: SAGEM_RAW, firstName: 'Codice', lastName: 'Flscale' }));
  assert.doesNotMatch(`${result.firstName} ${result.lastName}`, /codice|flscale/i);
});

test('BR-05 descrizione professionale non resta persona', () => {
  const result = runtime(savedCard({ rawText: PRICE_RAW, firstName: 'Management', lastName: 'Consultants' }));
  assert.doesNotMatch(`${result.firstName} ${result.lastName}`, /management consultants/i);
});

test('BR-06 istituzione non viene incorporata nel cognome', () => {
  const result = runtime(savedCard({ rawText: POLIMI_RAW, firstName: 'Ivan', lastName: 'Politecnico Di' }));
  assert.doesNotMatch(`${result.firstName} ${result.lastName}`, /politecnico/i);
});

test('BR-07 Room non diventa city', () => {
  const result = runtime(savedCard({ rawText: BOSTON_RAW, address: { full: '755 Commonwealth Avenue, Room B7, Boston, Massachusetts 02215', city: 'Room B7' } }));
  assert.doesNotMatch(result.address?.city ?? '', /^room\b/i);
});

test('BR-08 Building non diventa city', () => {
  const rawText = 'ACME LTD\nJane Doe\n10 Main Street\nBuilding 7\nLondon SW1A 1AA\njane@acme.co.uk';
  const result = runtime(savedCard({ rawText, address: { full: '10 Main Street, Building 7, London SW1A 1AA', city: 'Building 7' } }));
  assert.doesNotMatch(result.address?.city ?? '', /^building\b/i);
});

test('BR-09 raw OCR assente lascia il record invariato e non marca il parser', () => {
  const current = savedCard({ rawText: '', images: ['file:///front.jpg', 'file:///back.jpg'] });
  const result = runtime(current);
  assert.deepEqual(result, current);
  assert.equal(result.lastParserBuildId, undefined);
});

test('BR-10 raw OCR multipagina conserva evidenza di entrambe le pagine', () => {
  const result = runtime(savedCard({ rawText: ATROX_RAW, images: ['file:///front.jpg', 'file:///back.jpg'], company: 'Inspire the Next' }));
  assert.match(result.company, /atrox/i);
  assert.match(result.address?.full ?? '', /Pakistan/i);
});

test('BR-11 provenance del campo applicato diventa reparse', () => {
  const result = runtime(savedCard({ rawText: CORIUM_RAW, company: 'B-mail: tagliabueCeorium-S.r.l.it' }));
  assert.equal(result.contactReviewState?.fieldOrigins.company, 'reparse');
  assert.ok(result.extractionReview?.company.reasons?.length);
});

test('BR-12 titolo viene ricalcolato dopo il risultato finale', () => {
  const result = runtime(savedCard({ rawText: PRICE_RAW, title: 'Management Consultants', firstName: 'Management', lastName: 'Consultants' }));
  assert.equal(result.title.includes(result.company), Boolean(result.company));
  assert.doesNotMatch(result.title, /^Management Consultants$/i);
});

test('BR-13 il percorso runtime contiene una sola invocazione parser', () => {
  const source = readFileSync('lib/contact-reparse.ts', 'utf8');
  assert.equal((source.match(/parseCardFromPages\(pages\)/g) ?? []).length, 1);
});

test('BR-14 proposta reale applica il candidato e conserva il parser build', () => {
  const current = savedCard({ rawText: CORIUM_RAW, company: 'B-mail: tagliabueCeorium-S.r.l.it' });
  const proposal = buildBusinessCardReparseProposal(current);
  assert.ok(proposal);
  const applied = applyBusinessCardReparseProposal(current, proposal, ['company']);
  assert.equal(applied.status, 'applied');
  assert.match(applied.appliedResult.company, /corium/i);
  assert.equal(applied.appliedResult.lastParserBuildId, proposal.parserBuildId);
});

test('BR-15 modifica manuale resta protetta', () => {
  const parsed = savedCard({ rawText: ATROX_RAW, company: 'Inspire the Next' });
  const manual = applyManualContactEdits(parsed, { company: 'Azienda verificata manualmente' });
  const result = reparseBusinessCardWithDecisions(manual);
  assert.equal(result.card.company, 'Azienda verificata manualmente');
  assert.ok(result.protectedFields.includes('company'));
});

test('BR-16 repair email incerto resta in review e non diventa operativo', () => {
  const rawText = 'ACME S.r.l.\nJohn Doe\nE-mail: john.doeOacme.it\nwww.acme.it';
  const result = runtime(savedCard({ rawText }));
  const repaired = result.emailEvidence?.find((item) => item.origin === 'repaired');
  if (repaired?.requiresReview) {
    assert.ok(!result.emails.includes(repaired.value));
    assert.ok(result.extractionReview?.reviewFields.includes('emails'));
  }
});

test('BR-17 azienda OCR corrotta usa fonti concorrenti universali', () => {
  const result = runtime(savedCard({ rawText: GH_RAW, company: 'G&nternational Co, LTD' }));
  assert.match(result.company, /g\s*&\s*h/i);
  assert.match(result.company, /international/i);
});

test('BR-18 record vuoto senza raw OCR non viene trasformato o salvato', () => {
  const current = savedCard({ rawText: '', title: 'Contatto', images: ['file:///front.jpg', 'file:///back.jpg'] });
  const result = runtime(current);
  assert.equal(result.title, 'Contatto');
  assert.deepEqual(result.images, current.images);
  assert.equal(result.updatedAt.getTime(), current.updatedAt.getTime());
});

test('BR-19 deduplica resta coerente dopo il reprocess', () => {
  const current = savedCard({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', rawText: ATROX_RAW, company: 'Inspire the Next' });
  const result = runtime(current);
  const duplicate = savedCard({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', rawText: ATROX_RAW, company: 'ATROX', emails: ['asim@atrox.pk'] });
  assert.equal(findContactDuplicateCandidates(result, [duplicate]).length, 1);
});

test('BR-20 persistenza integrata conserva tutte le immagini una sola volta', async () => {
  const images = ['file:///front.jpg', 'file:///back.jpg'];
  const current = savedCard({ rawText: ATROX_RAW, images, company: 'Inspire the Next' });
  const next = withPersistenceRevision(runtime(current), 'bulk-reprocess-test');
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources(images);
  const persisted = await adapter.save(next);
  assert.equal(persisted.images.length, 2);
  assert.equal(adapter.events.filter((event) => event === 'db:insert').length, 1);
  assert.equal(adapter.events.filter((event) => event.startsWith('copy:')).length, 2);
});

test('BR-21 correzione minima OCR non degrada un nome precedente plausibile', () => {
  const previous = runtime(savedCard({
    rawText: CORIUM_DEVICE_RAW.replace('Mlarco', 'Marco'),
  }));
  const result = runtime({
    ...previous,
    rawText: CORIUM_DEVICE_RAW,
    website: 'www.tagliabueceorium-srl.it',
  });
  assert.equal(result.firstName, 'Marco');
  assert.equal(result.lastName, 'Tagliabue');
  assert.equal(result.website, undefined);
  assert.equal(result.extractionReview?.firstName.value, result.firstName);
  assert.equal(result.extractionReview?.website.value, null);
});

test('BR-22 sito valido resta disponibile quando converge con il dominio email', () => {
  const result = runtime(savedCard({
    rawText: DOLPHIN_DEVICE_RAW,
    website: 'www.dolphin.it',
    emails: ['gbravi@dolphin.it'],
  }));
  assert.equal(result.website, 'www.dolphin.it');
});

test('BR-23 dominio email verificato prevale su un sito OCR incompatibile', () => {
  const result = runtime(savedCard({
    rawText: GRUPPOVITA_DEVICE_RAW,
    website: 'www.gruppovita.it',
    emails: ['fabio.deverchi@gruppovita.it'],
  }));
  assert.equal(result.website, 'www.gruppovita.it');
  assert.equal(result.extractionReview?.website.value, result.website);
});

test('BR-24 dominio ricavabile da email OCR prevale su token web non correlato', () => {
  const result = runtime(savedCard({
    rawText: POLIMI_RAW
      .replace('POLITECNICO DI MILANO', 'POLITECNICO DI MILANO\nSSERVATORI.NET')
      .replace('filippo renga@polimi.it', 'filippo renga@polimt it'),
    website: 'www.polimt.it',
  }));
  assert.equal(result.website, 'www.sompolimi.it');
});

test('BR-25 indirizzo civico strutturato non viene sostituito da una casella postale', () => {
  const result = runtime(savedCard({
    rawText: SOFTFABRIK_DEVICE_RAW,
    address: {
      street: 'Große Seestra Sse 32 -',
      civicNumber: '34',
      postalCode: '60486',
      city: 'Frankfurt Am Main',
      full: 'Große Seestra Sse 32 -, Nr. 34 - 60486 - Frankfurt Am Main',
    },
  }));
  assert.match(result.address?.street ?? '', /^Große Seestra/i);
  assert.match(result.address?.city ?? '', /^Frankfurt am Main$/i);
});

test('BR-26 city geografica viene recuperata dal full quando la precedente era un locale', () => {
  const result = runtime(savedCard({
    rawText: BOSTON_RAW,
    address: {
      full: '755 Commonwealth Avenue, Room B7, Boston, Massachusetts 02215',
      street: 'Commonwealth Avenue',
      civicNumber: '755',
      postalCode: '02215',
      city: 'Room B7',
    },
  }));
  assert.equal(result.address?.city, 'Boston');
  assert.equal(result.extractionReview?.address.value?.city, result.address?.city);
});

test('BR-27 un nome precedente corrotto non blocca la correzione canonica', () => {
  const previous = runtime(savedCard({ rawText: CORIUM_DEVICE_RAW }));
  const result = runtime({
    ...previous,
    rawText: CORIUM_DEVICE_RAW.replace('Mlarco', 'Marco'),
  });
  assert.equal(result.firstName, 'Marco');
  assert.equal(result.lastName, 'Tagliabue');
  assert.equal(result.extractionReview?.firstName.value, result.firstName);
});

test('BR-28 un nome globale non è penalizzato da euristiche linguistiche', () => {
  const corruptRaw = CORIUM_DEVICE_RAW.replace('Mlarco', 'Miladen');
  const previous = runtime(savedCard({ rawText: corruptRaw }));
  const result = runtime({
    ...previous,
    rawText: corruptRaw.replace('Miladen', 'Mladen'),
  });
  assert.equal(result.firstName, 'Mladen');
  assert.equal(result.extractionReview?.firstName.value, result.firstName);
});

test('BR-29 una riga web non viene promossa a city', () => {
  const result = runtime(savedCard({ rawText: GH_RAW }));
  assert.match(result.address?.city ?? '', /^Gwangin-?\s*gu$/i);
});

test('BR-30 paese e codice paese non vengono duplicati come city', () => {
  const result = runtime(savedCard({
    rawText: [
      'KOMINE CO.,LTD.',
      'Michael Chang',
      '2F, 1-38-16, Machiya, Arakawa-Ku, Tokyo, 116-0001 Japan',
      'HP:https://www.komine.ac/ E-mail:michael@komine.ac',
    ].join('\n'),
  }));
  assert.equal(result.address?.city, 'Tokyo');
});

test('BR-31 una strada precedente al blocco postale non viene promossa a city', () => {
  const result = runtime(savedCard({
    rawText: [
      'TUGLAK',
      '1km, Aimnabad Road, Tuglak Street, Sialkot -51310-Pakistan.',
      'Managing Partner',
      'Ashraf Tuglak',
      'tuglak@cyber.net.pk',
    ].join('\n'),
  }));
  assert.doesNotMatch(result.address?.city ?? '', /\b(?:street|road)\b/i);
});

test('BR-32 un nome geografico con designatore stradale resta city', () => {
  const result = runtime(savedCard({
    rawText: [
      'Island Services Ltd.',
      '1 Waterfront Drive',
      'Road Town, Tortola 1110',
      'British Virgin Islands',
      'office@island-services.vg',
    ].join('\n'),
    address: {
      street: 'Waterfront Drive',
      civicNumber: '1',
      postalCode: '1110',
      city: 'Road Town',
      country: 'VG',
      full: '1 Waterfront Drive, Road Town, Tortola 1110',
    },
  }));
  assert.equal(result.address?.city, 'Road Town');
});

test('BR-33 city Street non coincide per sottostringa con High Street', () => {
  const result = runtime(savedCard({
    rawText: [
      'Street Community Office',
      '1 High Street',
      'Street, Somerset BA16 0EQ',
      'United Kingdom',
      'office@street-community.uk',
    ].join('\n'),
    address: {
      street: 'High Street',
      civicNumber: '1',
      postalCode: 'BA16 0EQ',
      city: 'Street',
      country: 'GB',
      full: '1 High Street, Street, Somerset BA16 0EQ',
    },
  }));
  assert.equal(result.address?.city, 'Street');
});

test('BR-33B city Road non coincide col token Broadway', () => {
  const result = runtime(savedCard({
    rawText: [
      'Road Services LLC',
      '10 Broadway',
      'Road, Virginia 12345',
      'office@road-services.example',
    ].join('\n'),
    address: {
      street: 'Broadway',
      civicNumber: '10',
      postalCode: '12345',
      city: 'Road',
      region: 'VA',
      country: 'US',
      full: '10 Broadway, Road, Virginia 12345',
    },
  }));
  assert.equal(result.address?.city, 'Road');
});

test('BR-34 Piazza Armerina resta city con una strada distinta', () => {
  const result = runtime(savedCard({
    rawText: [
      'Studio Esempio',
      'Via Roma 1',
      '94015 Piazza Armerina',
      'Italia',
      'info@studio-esempio.it',
    ].join('\n'),
    address: {
      street: 'Via Roma',
      civicNumber: '1',
      postalCode: '94015',
      city: 'Piazza Armerina',
      country: 'IT',
      full: 'Via Roma 1, 94015 Piazza Armerina',
    },
  }));
  assert.equal(result.address?.city, 'Piazza Armerina');
});

test('BR-35 city già parsata non può essere un segmento stradale diretto', () => {
  const result = runtime(savedCard({
    rawText: [
      'Tuglak Industries',
      '1 Aimnabad Road, Tuglak Street',
      '51310 Sialkot, Pakistan',
      'office@tuglak.example',
    ].join('\n'),
    address: {
      street: '1 Aimnabad Road, Tuglak Street',
      postalCode: '51310',
      city: 'Tuglak Street',
      country: 'PK',
      full: '1 Aimnabad Road, Tuglak Street, 51310 Sialkot, Pakistan',
    },
  }));
  assert.notEqual(result.address?.city, 'Tuglak Street');
});

test('BR-36 snapshot iniziale forte blocca una regressione OCR marginale', () => {
  const parsed = runtime(savedCard({
    rawText: CORIUM_DEVICE_RAW.replace('Mlarco', 'Marco'),
  }));
  const previous: BusinessCard = {
    ...parsed,
    rawText: CORIUM_DEVICE_RAW,
    extractionReview: parsed.extractionReview
      ? {
          ...parsed.extractionReview,
          firstName: {
            ...parsed.extractionReview.firstName,
            score: 0.995,
          },
        }
      : parsed.extractionReview,
    contactReviewState: parsed.contactReviewState
      ? {
          ...parsed.contactReviewState,
          parsedInitial: {
            ...parsed.contactReviewState.parsedInitial,
            firstName: 'Marco',
            lastName: 'Tagliabue',
          },
        }
      : parsed.contactReviewState,
  };
  const result = runtime(previous);
  assert.equal(result.firstName, 'Marco');
  assert.equal(result.lastName, 'Tagliabue');
});

test('BR-37 snapshot iniziale recupera una regressione gia applicata dal reparse', () => {
  const initial = runtime(savedCard({
    rawText: CORIUM_DEVICE_RAW.replace('Mlarco', 'Marco'),
  }));
  const drifted: BusinessCard = {
    ...initial,
    firstName: 'Mlarco',
    rawText: CORIUM_DEVICE_RAW,
    extractionReview: initial.extractionReview
      ? {
          ...initial.extractionReview,
          firstName: {
            ...initial.extractionReview.firstName,
            value: 'Mlarco',
            score: 0.996,
          },
        }
      : initial.extractionReview,
    contactReviewState: initial.contactReviewState
      ? {
          ...initial.contactReviewState,
          parsedInitial: {
            ...initial.contactReviewState.parsedInitial,
            firstName: 'Marco',
            lastName: 'Tagliabue',
          },
          fieldOrigins: {
            ...initial.contactReviewState.fieldOrigins,
            firstName: 'reparse',
          },
        }
      : initial.contactReviewState,
  };
  const result = runtime(drifted);
  assert.equal(result.firstName, 'Marco');
  assert.equal(result.lastName, 'Tagliabue');
});

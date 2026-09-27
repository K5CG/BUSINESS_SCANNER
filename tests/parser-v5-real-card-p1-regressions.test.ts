import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard, OcrLine } from '../types';
import {
  extractCardV5,
  type CardPageV5,
  type V5Result,
} from '../lib/parser-v5/engine';
import {
  hasAmbiguousTerminalLegalSeparator,
  matchTerminalLegalFormSuffix,
} from '../lib/parser-engine/validators/dictionaries';
import { isClaimLikeTerminalLegalPhrase } from '../lib/parser-engine/validators/role';
import { extractBusinessCardV5 } from '../lib/parser-v5/index';
import { resolveBrandFromEmailDomain } from '../lib/parser-engine/validators/brand-normalizer';
import {
  isDomainOnlyCompanyValue,
  stripNumberedLocationAfterLegalForm,
} from '../lib/parser-engine/validators/company';
import { isCompanySloganClaimLine } from '../lib/parser-engine/validators/role';
import { parseCapsSurnameFirstLine } from '../lib/parser-v5/person-token-split';
import { finalizeRoleValue } from '../lib/parser-v5/finalize';
import { splitCamelCaseInText, normalizeFusedPersonLine } from '../lib/parser-v5/person-token-split';
import { emailDomainIncoherentWithWebsite } from '../lib/parser-v5/email-website-coherence';
import { attachExtractionReviewToCard } from '../lib/extraction-review';

function page(textLines: readonly string[]): CardPageV5 {
  return {
    lines: textLines.map(
      (text, index): OcrLine => ({
        text,
        confidence: 0.96,
        boundingBox: {
          x: 4,
          y: index * 28,
          width: Math.max(90, text.length * 7),
          height: index === 0 ? 28 : 20,
        },
      })
    ),
    rawText: textLines.join('\n'),
  };
}

function phoneDigits(result: V5Result): string[] {
  return (result.phones.value ?? [])
    .map((phone) => phone.number.replace(/\D/g, ''))
    .sort();
}

function companyKey(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

test('P1 fiscale: Flscale resta etichetta OCR, non persona o telefono', () => {
  const result = extractCardV5([
    page([
      'DANTE CHIERICO',
      'PERITO INDUSTRIALE',
      'S.A. GE. MA, s. n.c.',
      '36015 SCHIO (Vicenza) ITALY',
      'Via Molise 12 Z.I.',
      'Codice Flscale 00255760241',
      'Telefono (0445) 671155',
      'Partita IVA 00255760241',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Dante');
  assert.equal(result.lastName.value, 'Chierico');
  assert.match(result.role.value ?? '', /^Perito Industriale$/i);
  assert.doesNotMatch(result.company.value ?? '', /perito\s+industriale/i);
  assert.match(result.company.value ?? '', /S\.?\s*A\.?\s*GE\.?\s*MA/i);
  assert.equal(result.vatNumber.value, '00255760241');
  assert.equal(result.taxCode.value, '00255760241');
  assert.deepEqual(phoneDigits(result), ['0445671155']);
  assert.equal(
    result.pageCoherence.numericEvidence?.ambiguous.some(
      (candidate) =>
        candidate.evidenceType === 'taxCode' &&
        candidate.normalizedValue === '00255760241'
    ),
    true
  );
  assert.equal(
    result.pageCoherence.numericEvidence?.accepted.some(
      (candidate) =>
        candidate.evidenceType === 'phone' &&
        candidate.normalizedValue === '00255760241'
    ),
    false
  );
});

test('P1 telefoni: prefisso OCR O92 osservato espande solo il secondo numero', () => {
  const result = extractCardV5([
    page([
      'Asim Nayyer',
      'Chief Executive Officer',
      'O92-52-6523488 / 6523499',
    ]),
  ]);

  assert.deepEqual(phoneDigits(result), [
    '092526523488',
    '092526523499',
  ]);
  assert.equal(result.address.value, null);
});

test('P1 telefoni: etichetta Tel conserva il prefisso italiano osservato', () => {
  const result = extractCardV5([
    page([
      'Nora Valli',
      'Operations Manager',
      'Tel: 0522 6523488 / 6523499',
    ]),
  ]);

  assert.deepEqual(phoneDigits(result), ['05226523488', '05226523499']);
});

test('P1 telefoni: una coppia numerica non telefonica non viene espansa', () => {
  const result = extractCardV5([
    page([
      'ALPHA INDUSTRIES S.R.L.',
      'Ordine 123456789 / 6543210',
    ]),
  ]);

  assert.deepEqual(result.phones.value, []);
});

test('P1 telefoni: un suffisso troppo corto non autorizza invenzioni', () => {
  const result = extractCardV5([
    page([
      'Nora Valli',
      'Tel: 0522 6523488 / 99',
    ]),
  ]);

  assert.equal(
    phoneDigits(result).includes('05226523499'),
    false
  );
});

test('P1 azienda: una ragione sociale osservata con suffisso OCR s.rl. prevale sul dominio', () => {
  const result = extractCardV5([
    page([
      'ERP',
      'Gold',
      'N0rthstar',
      'Partner',
      'CON SU LTI NG',
      'ERP Business Objects',
      'Volume Reseller',
      'Nora Valli',
      'Amministratore Unico',
      'nora.valli@northstarplatforms.example',
      '+39 393 0506967',
      'Northstar Ethics Consulting s.rl.',
      'Viale del Lavoro, 33',
      'P. IVA e C.F. 03481480238',
      'www.northstarplatforms.example',
    ]),
  ]);

  assert.equal(result.company.value, 'Northstar Ethics Consulting S.r.l.');
  assert.equal(
    result.company.reasons.some((reason) =>
      /sostituita: classe semantica invalida.*dominio/i.test(reason)
    ),
    false
  );
});

test('P1 azienda: una sottostringa breve del dominio dentro un claim non sostituisce il brand', () => {
  const result = extractCardV5([
    page([
      'MOVE FORWARD TO THE CORE',
      'Nora Valli',
      'Operations Manager',
      'nora.valli@novacore.example',
      'www.novacore.example',
    ]),
  ]);

  assert.equal(companyKey(result.company.value), 'novacore');
  assert.notEqual(
    companyKey(result.company.value),
    'moveforwardtothecore'
  );
});

test('P1 azienda: una coda autonoma concorde col dominio non resta fusa al frammento precedente', () => {
  const result = extractCardV5([
    page([
      'MARKET MADE EASIER',
      'E NOVACORE',
      'Nora Valli',
      'Operations Manager',
      'nora.valli@novacore.example',
      'www.novacore.example',
    ]),
  ]);

  assert.equal(companyKey(result.company.value), 'novacore');
});

test('P1 azienda: AS interno a un claim non diventa una forma giuridica', () => {
  const result = extractCardV5([
    page([
      'SOFTWARE AS A SERVICE',
      'Nora Valli',
      'Managing Director',
      'nora.valli@aerolith.example',
      'www.aerolith.example',
    ]),
  ]);

  const companyKey = result.company.value
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  assert.equal(companyKey, 'aerolith');
  assert.notEqual(companyKey, 'softwareasaservice');
});

const strongLegalForms: ReadonlyArray<readonly [string, string]> = [
  ['S.r.l.', 'srl'],
  ['5 R 1', 'srl'],
  ['S.r.l.s.', 'srls'],
  ['S.p.A.', 'spa'],
  ['S.n.c.', 'snc'],
  ['S.a.s.', 'sas'],
  ['S.c.a.r.l.', 'scarl'],
  ['S.t.p.', 'stp'],
  ['SAPA', 'sapa'],
  ['BVBA', 'bvba'],
  ['CVBA', 'cvba'],
  ['VZW', 'vzw'],
  ['GmbH & Co. KG', 'gmbhcokg'],
  ['GmbH', 'gmbh'],
  ['S.A.R.L.', 'sarl'],
  ['S.A.S.U.', 'sasu'],
  ['Ltd.', 'ltd'],
  ['Limited', 'limited'],
  ['LLC', 'llc'],
  ['LLP', 'llp'],
  ['Inc.', 'inc'],
  ['Corp.', 'corp'],
  ['Corporation', 'corporation'],
  ['PLC', 'plc'],
  ['A/S', 'as'],
  ['e.K.', 'ek'],
  ['Kft', 'kft'],
  ['Sp. z o.o.', 'spzoo'],
  ['ApS', 'aps'],
  ['A.G.', 'ag'],
  ['B.V.', 'bv'],
  ['N.V.', 'nv'],
  ['S.A.', 'sa'],
];

for (const [legalForm, legalKey] of strongLegalForms) {
  test(`P1 azienda: la forma giuridica forte ${legalForm} resta osservata`, () => {
    const result = extractCardV5([
      page([
        `Aerolith Labs ${legalForm}`,
        'Nora Valli',
        'Managing Director',
        'nora@fallbackbrand.example',
      ]),
    ]);

    assert.equal(companyKey(result.company.value), `aerolithlabs${legalKey}`);
    assert.equal(companyKey(result.company.value).includes('fallbackbrand'), false);
  });
}

for (const legalForm of ['AS', 'SA', 'AG', 'AB', 'BV', 'NV', 'KG', 'Oy']) {
  test(`P1 azienda: la sigla ambigua ${legalForm} richiede dominio concorde`, () => {
    const result = extractCardV5([
      page([
        `Aerolith Labs ${legalForm}`,
        'Nora Valli',
        'Managing Director',
        'nora@aerolithlabs.example',
      ]),
    ]);

    assert.equal(
      companyKey(result.company.value),
      `aerolithlabs${legalForm.toLowerCase()}`
    );
  });
}

const AMBIGUOUS_BARE_LEGAL_PHRASES = [
  'OPERATING AS',
  'AVAILABLE IN SA',
  'REPORT FOR AG',
  'BLOOD GROUP AB',
  'REFERENCE VALUE BV',
  'MEMORY TYPE NV',
  'NET WEIGHT 20 KG',
  'EXPRESSIONS LIKE OY',
  'WORK WITH AB',
  'DEPLOY TO AS',
] as const;

const CLAIM_LIKE_LEGAL_PHRASES = [
  'CLAIM: AVAILABLE IN S.A.',
  'CLAIM: REPORT FOR A.G.',
  'CLAIM: WORK WITH B.V.',
  'CLAIM: STATEMENT OF WORK B.V.',
  'CLAIM: DEPLOYED TO S.A.',
  'CLAIM: REPORTS ABOUT A.G.',
  'CLAIM: WORKED WITH B.V.',
  'CLAIM: OPERATE AS N.V.',
  'CLAIM: DEPLOYMENT TO A/S',
  'CLAIM: EXPRESS LIKE S.A.',
  'CLAIM: SOLD SEPARATELY S.A.',
  'CLAIM: MADE IN ITALY S.A.',
  'CLAIM: POWERED BY PEOPLE S.A.',
  'CLAIM: DESIGNED FOR TEAMS S.A.',
  'CLAIM: NOT FOR SALE S.A.',
  'CLAIM: KEEP DRY N.V.',
  'CLAIM: READY TO SHIP B.V.',
  'CLAIM: DEPLOYED UNDER S.A.',
  'CLAIM: REPORTS REGARDING A.G.',
  'CLAIM: WORKED WITHOUT B.V.',
  'CLAIM: OPERATE WITHIN N.V.',
  'CLAIM: DEPLOYMENT THROUGH A/S',
  'CLAIM: EXPRESS BEYOND S.A.',
  'CLAIM: MADE UPON A.G.',
  'CLAIM: AVAILABLE AFTER B.V.',
  'CLAIM = MADE IN ITALY B.V.',
  'CLAIM:MADE IN ITALY S.A.',
  'SLOGAN: CREATIVE WORKS B.V.',
  'MOTTO: ROSSO BLU N.V.',
  'MESSAGE: BIRD STUDIO S.A.',
] as const;

for (const phrase of [
  ...AMBIGUOUS_BARE_LEGAL_PHRASES,
  ...CLAIM_LIKE_LEGAL_PHRASES,
]) {
  test(`P1 azienda: la frase terminale "${phrase}" non è una società`, () => {
    const result = extractCardV5([
      page([
        phrase,
        'Nora Valli',
        'Managing Director',
        'nora@aerolith.com',
        'www.aerolith.com',
      ]),
    ]);

    assert.equal(companyKey(result.company.value), 'aerolith');
    assert.equal(
      isDomainOnlyCompanyValue(
        'Aerolith',
        ['nora@aerolith.com'],
        `${phrase}\nNora Valli\nManaging Director\nnora@aerolith.com`
      ),
      false
    );
  });
}

test('P1 azienda: un claim con forma legale senza prove concorrenti resta in review', () => {
  for (const phrase of CLAIM_LIKE_LEGAL_PHRASES) {
    assert.equal(isClaimLikeTerminalLegalPhrase(phrase), true, phrase);
    const result = extractBusinessCardV5([page([phrase])]);
    assert.equal(result.company.value, phrase, phrase);
    assert.equal(result.company.confidence, 'low', phrase);
    assert.equal(result.needsReview, true, phrase);
    assert.ok(result.reviewFields.includes('company'), phrase);
  }
});

test('P1 azienda: una sigla legale breve conserva un brand distintivo o corroborato', () => {
  const distinctive = extractCardV5([page(['Aerolith S.A.'])]);
  assert.equal(companyKey(distinctive.company.value), 'aerolithsa');

  for (const observedCompany of [
    'AEROLITH LABS S.A.',
    'ACME HOLDINGS A.G.',
    'NORTHSTAR GROUP B.V.',
    'BLUE ORBIT S.A.',
    'SILVER ANCHOR N.V.',
    'VECTOR LABS A.G.',
    'ORBITAL HOLDINGS B.V.',
    'SMART SYSTEMS S.A.',
    'SOFTWARE SOLUTIONS B.V.',
    'BUILDING AUTOMATION A.G.',
    'RENEWABLE ENERGY N.V.',
    'INDUSTRIAL ENGINEERING A/S',
    'BANK OF EUROPE S.A.',
    'HOUSE OF TRAVEL B.V.',
    'TOOLS FOR INDUSTRY A.G.',
    'SYSTEM GROUP S.A.',
    'PRODUCT GROUP B.V.',
    'BUILDING S.A.',
  ]) {
    assert.equal(
      hasAmbiguousTerminalLegalSeparator(observedCompany),
      false,
      observedCompany
    );
    const standalone = extractCardV5([page([observedCompany])]);
    assert.equal(
      companyKey(standalone.company.value),
      companyKey(observedCompany),
      observedCompany
    );
  }

  const corroboratedAllCaps = extractCardV5([
    page(['AEROLITH LABS S.A.', 'info@aerolithlabs.com']),
  ]);
  assert.equal(companyKey(corroboratedAllCaps.company.value), 'aerolithlabssa');
});

test('P1 azienda: una riga bare con suffisso forte non subisce veti lessicali', () => {
  for (const observedCompany of [
    'NEXT LEVEL S.A.',
    'PRIME TIME B.V.',
    'CENTER STAGE A.G.',
    'BLUE STATE N.V.',
    'ALPHA MODE S.A.',
    'PRIME VALUE B.V.',
    'OPEN FORMAT A.G.',
    'DATA STATE N.V.',
    'GLOBAL STATUS S.A.',
    'SIGNAL LEVEL B.V.',
    'ENABLE S.A.',
    'VISIBLE B.V.',
    'INNOVATING A.G.',
    'SCALABLE N.V.',
    'RELIABLE S.A.',
    'STAND BY S.A.',
    'MADE BY B.V.',
    'ALL ABOUT A.G.',
    'DESIGNED FOR N.V.',
    'DEVICE CATEGORY S.A.',
    'CONTRACT TERM N.V.',
    'PACKAGE SIZE B.V.',
    'ORDER REFERENCE S.A.',
    'RELEASE YEAR A.G.',
    'MACHINE CLASS N.V.',
    'PAYMENT METHOD S.A.',
    'ACCOUNT BALANCE N.V.',
    'TAX RATE B.V.',
    'SOLD SEPARATELY S.A.',
    'MADE IN ITALY S.A.',
    'POWERED BY PEOPLE S.A.',
    'DESIGNED FOR TEAMS S.A.',
    'NOT FOR SALE S.A.',
    'KEEP DRY N.V.',
    'READY TO SHIP B.V.',
    'DEPLOYED UNDER S.A.',
    'REPORTS REGARDING A.G.',
    'WORKED WITHOUT B.V.',
    'OPERATE WITHIN N.V.',
    'DEPLOYMENT THROUGH A/S',
    'EXPRESS BEYOND S.A.',
    'MADE UPON A.G.',
    'AVAILABLE AFTER B.V.',
    'OPERATING A/S',
  ]) {
    assert.equal(
      hasAmbiguousTerminalLegalSeparator(observedCompany),
      false,
      observedCompany
    );
    const result = extractCardV5([page([observedCompany])]);
    assert.equal(
      companyKey(result.company.value),
      companyKey(observedCompany),
      observedCompany
    );
  }
});

test('P1 azienda: il separatore resta ambiguo senza evidenza business indipendente', () => {
  for (const observedCompany of [
    'CODE: ART S.A.',
    'CODE:ART S.A.',
    'M: LAB B.V.',
    'M:LAB B.V.',
    'X = Y A.G.',
    'X=Y A.G.',
    'DESIGN: WORKS N.V.',
    'DESIGN:WORKS N.V.',
    'ALPHA = OMEGA S.A.',
    'ALPHA=OMEGA S.A.',
    'A: TEAM B.V.',
    'A:TEAM B.V.',
    'STUDIO:54 S.A.',
    'LEVEL=5 B.V.',
    'FORMULA:1 A.G.',
    'AREA=51 N.V.',
    'FIELD:WORK S.A.',
    'MODE:STUDIO B.V.',
    'LEVEL:UP A.G.',
    'STAGE:ARTS N.V.',
    'ACME CODE:ART B.V.',
    'MOTTO:ROSSO S.A.',
    'VERSION:2 S.A.',
    'REVISION:X1 A.G.',
    'NUMBER:5 N.V.',
    'YEAR:2000 S.A.',
    'SERIAL:1 B.V.',
    'TYPE:PREMIUM A.G.',
    'STATUS:ACTIVE N.V.',
    'MOTTO:ROSSO ITALIA S.A.',
    'CLAIM:ACME LABS B.V.',
    'LABEL=NAME S.A.',
    'FIELD=STATUS B.V.',
    'VALUE=ACTIVE N.V.',
    'STATUS=RUNNING S.A.',
    'STATE=IDLE B.V.',
    'FLAG=ON A.G.',
    'BUILD=2026 N.V.',
    'MODEL=42 S.A.',
    'LOT=17 B.V.',
    'BATCH=9 A.G.',
    'INVOICE=123 N.V.',
    'CODE=ABC S.A.',
    'REFERENCE=XYZ B.V.',
    'LEVEL=HIGH A.G.',
    'MODE=AUTO N.V.',
    'FORMAT=PDF S.A.',
    'SIZE=LARGE B.V.',
    'RATE=10 A.G.',
    'BALANCE=0 N.V.',
    'CONDITION=NEW S.A.',
    'PHASE=COMPLETE B.V.',
    'USER STATUS: S.A.',
    'SERVICE VERSION: B.V.',
    'CAMPAIGN TYPE: A.G.',
    'STATO=ATTIVO N.V.',
    'VERSIONE=1.2 S.A.',
    'TIPO=PREMIUM B.V.',
    'SYSTEM.MODULE.STATUS: GREEN A.G.',
    'ORDER.ITEM.ID: ABC N.V.',
    'PROJECT.FIELD: ID S.A.',
    'COLOR: GREEN B.V.',
    'ENABLED: TRUE A.G.',
    'RETRY: 3 N.V.',
    'TIMESTAMP: 2026-07-31 S.A.',
    'PRIORITY: HIGH B.V.',
  ] as const) {
    assert.equal(
      hasAmbiguousTerminalLegalSeparator(observedCompany),
      true,
      observedCompany
    );
    const legal = matchTerminalLegalFormSuffix(observedCompany);
    assert.ok(legal, observedCompany);
    const email = `info@${companyKey(legal.brand)}.com`;

    const standalone = extractBusinessCardV5([page([observedCompany])]);
    assert.equal(standalone.company.value, observedCompany, observedCompany);
    assert.equal(standalone.company.confidence, 'low', observedCompany);
    assert.ok(standalone.reviewFields.includes('company'), observedCompany);

    const corroborated = extractCardV5([page([observedCompany, email])]);
    assert.equal(corroborated.company.value, observedCompany, observedCompany);

    const unrelatedDomain = extractBusinessCardV5([
      page([observedCompany, 'info@unrelated.com']),
    ]);
    assert.equal(
      unrelatedDomain.company.value,
      observedCompany,
      observedCompany
    );
    assert.equal(
      unrelatedDomain.company.confidence,
      'low',
      observedCompany
    );
    assert.ok(
      unrelatedDomain.reviewFields.includes('company'),
      observedCompany
    );
  }
});

test('P1 azienda: il lessico settoriale non è un segnale negativo autonomo', () => {
  const observedCompany = 'SOFTWARE SERVICES AS';
  assert.equal(hasAmbiguousTerminalLegalSeparator(observedCompany), false);

  const unresolved = extractCardV5([page([observedCompany])]);
  assert.equal(unresolved.company.value, null);

  const corroborated = extractCardV5([
    page([observedCompany, 'info@softwareservices.example']),
  ]);
  assert.equal(
    companyKey(corroborated.company.value),
    companyKey(observedCompany)
  );
});

test('P1 azienda: un acronimo breve con forma legale terminale resta società', () => {
  for (const observedCompany of [
    'AI S.A.',
    'HP B.V.',
    '3M S.A.',
    'VR A.G.',
  ]) {
    assert.equal(
      hasAmbiguousTerminalLegalSeparator(observedCompany),
      false,
      observedCompany
    );
    const standalone = extractCardV5([page([observedCompany])]);
    assert.equal(
      companyKey(standalone.company.value),
      companyKey(observedCompany),
      observedCompany
    );
  }
});

test('P1 azienda: hostname e peso non sono suffissi societari terminali', () => {
  assert.equal(matchTerminalLegalFormSuffix('acme.ag'), null);
  assert.equal(matchTerminalLegalFormSuffix('portal.as'), null);
  assert.equal(matchTerminalLegalFormSuffix('20 KG'), null);
  assert.equal(matchTerminalLegalFormSuffix('Aerolith, AB')?.strength, 'strong');
  assert.equal(matchTerminalLegalFormSuffix('Aerolith (BV)')?.strength, 'strong');
});

test('P1 azienda: una email soltanto riparata non corrobora una forma legale ambigua', () => {
  const result = extractCardV5([
    page([
      'Aerolith Labs AS',
      'Nora Valli',
      'Managing Director',
      'nora @ aerolithlabs.example',
    ]),
  ]);

  assert.deepEqual(result.emails.value, ['nora@aerolithlabs.example']);
  assert.equal(result.emailEvidence[0]?.origin, 'repaired');
  assert.equal(result.emailEvidence[0]?.confirmed, false);
  assert.equal(result.company.value, null);
});

test('P1 azienda: il local-part di un provider generico non diventa company', () => {
  const result = extractCardV5([
    page([
      'Aerolith Labs AS',
      'Nora Valli',
      'Managing Director',
      'nora@gmail.com',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Nora');
  assert.equal(result.lastName.value, 'Valli');
  assert.equal(result.company.value, null);
});

test('P1 azienda: Co. KG resta una forma giuridica forte completa', () => {
  const result = extractCardV5([
    page([
      'Northstar Consulting Co. KG',
      'Nora Valli',
      'Managing Director',
    ]),
  ]);

  assert.equal(result.company.value, 'Northstar Consulting Co. KG');
  assert.equal(
    matchTerminalLegalFormSuffix('Northstar Consulting Co. KG')?.strength,
    'strong'
  );
});

test('P2 azienda: gli acronimi punteggiati osservati conservano il casing', () => {
  const result = extractCardV5([
    page([
      'S.A. GE. MA, s. n.c.',
      'Nora Valli',
      'Managing Director',
    ]),
  ]);

  assert.equal(result.company.value, 'S.A.GE.MA. S.n.c.');
});

test('P1 azienda: un sottodominio non sostituisce il brand corroborato', () => {
  const result = extractCardV5([
    page([
      'Aerolith Labs AS',
      'Nora Valli',
      'Managing Director',
      'nora@staff.aerolithlabs.com',
    ]),
  ]);

  assert.equal(result.company.value, 'Aerolith Labs AS');
});

test('P1 azienda: la radice business gestisce sottodomini e suffissi nazionali', () => {
  assert.equal(
    resolveBrandFromEmailDomain(['nora@staff.aerolith.com']),
    'Aerolith'
  );
  assert.equal(
    resolveBrandFromEmailDomain(['info@eu.aerolith.co.uk']),
    'Aerolith'
  );
  for (const suffix of ['me.uk', 'ltd.uk', 'plc.uk']) {
    assert.equal(
      resolveBrandFromEmailDomain([`info@staff.aerolith.${suffix}`]),
      'Aerolith'
    );
    const result = extractCardV5([
      page([
        'Aerolith Labs AS',
        'Nora Valli',
        'Managing Director',
        `nora@staff.aerolithlabs.${suffix}`,
      ]),
    ]);
    assert.equal(result.company.value, 'Aerolith Labs AS');
  }
});

test('P1 azienda: un termine infrastrutturale resta valido come radice registrabile', () => {
  for (const brand of ['team', 'media']) {
    assert.equal(
      companyKey(resolveBrandFromEmailDomain([`nora@${brand}.com`])),
      brand
    );
    const result = extractCardV5([
      page([
        `${brand.toUpperCase()} AS`,
        'Nora Valli',
        'Managing Director',
        `nora@${brand}.com`,
      ]),
    ]);
    assert.equal(companyKey(result.company.value), `${brand}as`);
  }
});

test('P1 azienda: un dominio hosted ambiguo corrobora OCR ma non genera il provider', () => {
  assert.equal(
    resolveBrandFromEmailDomain(['nora@acme.myshopify.com']),
    null
  );
  const result = extractCardV5([
    page([
      'Acme AS',
      'Nora Valli',
      'Managing Director',
      'nora@acme.myshopify.com',
    ]),
  ]);

  assert.equal(result.company.value, 'Acme AS');
  assert.equal(companyKey(result.company.value).includes('myshopify'), false);
});

test('P1 azienda: il sito osservato corregge il logo quando il dominio email OCR è discordante', () => {
  const result = extractCardV5([
    page([
      'TUGInK',
      'moTORBIKE IND.',
      'm.ASHRAr TUGLAK',
      'Managing partner',
      'www.tuglakmotorbike.com',
      'inko@tugiakmotorbike.com',
    ]),
  ]);

  assert.equal(result.emailDomainOcrMismatch, true);
  assert.equal(result.company.value, 'Tuglak');
});

test('P1 azienda: un indicatore di sede numerato dopo la forma giuridica non contamina la società', () => {
  const result = extractCardV5([
    page([
      'Uddas ILANO',
      'CHRISTIAN PEZZIN',
      '+39 338 7861410',
      'SCOUT s.r.l. Blocco 38 Bis',
      'Via degli Scudai Centergross',
      '40050 - Funo di Argelato',
      'Bologna - Italia',
      'tel. +39 051 3765570',
      'christian.pezzin@scout. it',
      'www.scout. it',
    ]),
  ]);

  assert.equal(companyKey(result.company.value), 'scoutsrl');
  assert.equal(companyKey(result.company.value).includes('blocco38bis'), false);
  assert.equal(companyKey(result.company.value).includes('christianpezzin'), false);
  assert.equal(result.firstName.value, 'Christian');
  assert.equal(result.lastName.value, 'Pezzin');
  assert.doesNotMatch(result.address.value?.full ?? '', /\bSCOUT\b|Blocco 38/i);
  assert.notEqual(result.address.value?.civicNumber, '38');
  assert.equal(result.address.value?.civicNumber, undefined);
  assert.equal(result.address.value?.postalCode, '40050');
  assert.doesNotMatch(result.address.value?.street ?? '', /\b40050\b/);
});

test('P1 azienda: la ragione sociale con sede numerata compete anche con email osservata valida', () => {
  const result = extractCardV5([
    page([
      'Uddas ILANO',
      'CHRISTIAN PEZZIN',
      'SCOUT s.r.l. Blocco 38 Bis',
      'christian.pezzin@scout.it',
    ]),
  ]);

  assert.equal(companyKey(result.company.value), 'scoutsrl');
  assert.equal(companyKey(result.company.value).includes('blocco38bis'), false);
  assert.equal(companyKey(result.company.value).includes('uddasilano'), false);
});

test('P1 azienda: la sede numerata non elimina forma legale e punteggiatura osservate', () => {
  const cases = [
    ['ACME GmbH & Co. KG, Building 7', 'ACME GmbH & Co. KG'],
    ['ACME Ltd. Suite 3', 'ACME Ltd.'],
    ['ACME S.p.A. - Piano 5', 'ACME S.p.A.'],
    ['ACME (S.r.l.) Blocco 12', 'ACME (S.r.l.)'],
    ['ACME S.r.l. (Blocco 12)', 'ACME S.r.l.'],
  ] as const;

  for (const [observed, expected] of cases) {
    const result = extractCardV5([
      page([
        observed,
        'Nora Valli',
        'Managing Director',
        'nora@acme.de',
        'www.acme.de',
      ]),
    ]);

    assert.equal(result.company.value, expected, observed);
    assert.equal(result.address.value, null, observed);
  }
});

test('P1 azienda: una sigla legale iniziale non tronca una forma terminale successiva', () => {
  const observed = 'SAS Building 7 S.r.l.';
  assert.equal(stripNumberedLocationAfterLegalForm(observed), observed);

  const result = extractCardV5([
    page([
      observed,
      'Nora Valli',
      'Managing Director',
      'nora@sasbuilding.it',
      'www.sasbuilding.it',
    ]),
  ]);

  assert.equal(result.company.value, observed);
  assert.notEqual(companyKey(result.company.value), 'noravallisas');
  assert.equal(result.address.value, null);
});

test('P1 azienda: una forma legale ambigua con sede richiede evidenza business', () => {
  const withoutEvidence = extractCardV5([
    page([
      'ACME AS Unit 5',
      'Nora Valli',
      'Managing Director',
    ]),
  ]);
  assert.equal(withoutEvidence.company.value, null);

  const corroborated = extractCardV5([
    page([
      'ACME AS Unit 5',
      'Nora Valli',
      'Managing Director',
      'nora@acme.com',
    ]),
  ]);
  assert.equal(companyKey(corroborated.company.value), 'acmeas');
  assert.equal(companyKey(corroborated.company.value).includes('unit5'), false);
});

test('P1 azienda: una riga indirizzo con forma legale non compete come società', () => {
  const result = extractCardV5([
    page([
      '123 Main Road LLC',
      'Nora Valli',
      'Managing Director',
    ]),
  ]);

  assert.equal(
    result.debugLines.find((line) => line.text === '123 Main Road LLC')
      ?.scores.company,
    -10
  );
  assert.notEqual(companyKey(result.company.value), '123mainroadllc');
});

test('P1 persona: una repair ordina solo due token osservati con un unico nome proprio', () => {
  const cases = [
    ['JOHN SMITH', 'john.smith@acme. com', 'Smith'],
    ['SMITH JOHN', 'john.smith@acme. com', 'Smith'],
    ['JOHN FERRARI', 'john.ferrari@acme. com', 'Ferrari'],
  ] as const;

  for (const [observed, repairedEmail, expectedLastName] of cases) {
    const result = extractCardV5([
      page([
        observed,
        'Managing Director',
        'ACME S.r.l.',
        repairedEmail,
      ]),
    ]);

    assert.equal(result.firstName.value, 'John', observed);
    assert.equal(result.lastName.value, expectedLastName, observed);
    assert.deepEqual(result.emails.value, [], observed);
    assert.equal(
      result.emailEvidence.some(
        (evidence) =>
          evidence.origin === 'repaired' &&
          evidence.value === repairedEmail.replace(/\s+/g, '')
      ),
      true,
      observed
    );
    assert.equal(
      result.firstName.reasons.includes(
        'riga nome osservata corroborata da repair email'
      ),
      true,
      observed
    );
  }
});

test('P1 persona: repair generiche o semantiche non creano persone', () => {
  const cases = [
    ['INFO SCOUT', 'info.scout@scout. it'],
    ['CONTACT SCOUT', 'contact.scout@scout. it'],
    ['SEGRETERIA JOHN', 'segreteria.john@acme. com'],
    ['PRESS JOHN', 'press.john@acme. com'],
    ['NET WEIGHT', 'net.weight@acme. com'],
    ['PROJECT MANAGER', 'project.manager@acme. com'],
    ['MAIN STREET', 'main.street@acme. com'],
    ['PROJECT PHOENIX', 'project.phoenix@acme. com'],
    ['CUSTOMER SUCCESS', 'customer.success@acme. com'],
    ['QUALITY CONTROL', 'quality.control@acme. com'],
    ['MEDIA RELATIONS', 'media.relations@acme. com'],
    ['RESEARCH LAB', 'research.lab@acme. com'],
    ['CLOUD PLATFORM', 'cloud.platform@acme. com'],
    ['PRODUCT VISION', 'product.vision@acme. com'],
    ['ELM STREET', 'elm.street@acme. com'],
    ['AIRPORT ROAD', 'airport.road@acme. com'],
    ['ORCHARD STREET', 'orchard.street@acme. com'],
    ['RAILWAY STREET', 'railway.street@acme. com'],
  ] as const;

  for (const [observed, repairedEmail] of cases) {
    const result = extractCardV5([
      page([
        observed,
        'Managing Director',
        'ACME S.r.l.',
        repairedEmail,
      ]),
    ]);

    assert.equal(result.firstName.value, null, observed);
    assert.equal(result.lastName.value, null, observed);
    assert.deepEqual(result.emails.value, [], observed);
  }
});

test('P1 persona: mailbox e reparti generici non diventano persone senza email', () => {
  const genericLines = [
    'SUPPORT JOHN',
    'BOOKING JOHN',
    'RECEPTION JOHN',
    'ACCOUNTS JOHN',
    'HELP JOHN',
    'ENQUIRIES JOHN',
    'BILLING JOHN',
    'CAREERS JOHN',
    'TEAM JOHN',
    'CUSTOMER JOHN',
    'RESERVATIONS JOHN',
    'ORDERS JOHN',
    'PROJECT JOHN',
    'QUALITY JOHN',
    'GLOBAL SUPPORT',
    'TECHNICAL SUPPORT',
    'PUBLIC RELATIONS',
    'GLOBAL OPERATIONS',
    'STRATEGIC PARTNERSHIPS',
    'MARKET INTELLIGENCE',
    'COMMUNICATIONS LUCA',
    'PROCUREMENT LUCA',
    'FINANCE LUCA',
    'LEGAL LUCA',
    'DESIGN LUCA',
    'ALPHA BETA',
  ] as const;

  for (const observed of genericLines) {
    const result = extractCardV5([
      page([
        observed,
        'ACME S.r.l.',
      ]),
    ]);

    assert.equal(result.firstName.value, null, observed);
    assert.equal(result.lastName.value, null, observed);
  }
});

test('P1 persona: righe composte solo da paesi non diventano persone', () => {
  const countryLines = [
    'SOUTH KOREA',
    'NEW ZEALAND',
    'SAUDI ARABIA',
    'CZECH REPUBLIC',
    'SOUTH AFRICA',
    'COSTA RICA',
  ] as const;

  for (const observed of countryLines) {
    const result = extractCardV5([
      page([
        observed,
        'ACME S.r.l.',
      ]),
    ]);

    assert.equal(result.firstName.value, null, observed);
    assert.equal(result.lastName.value, null, observed);
  }
});

test('P1 persona: una città interposta tra nome e cognome non diventa il cognome', () => {
  const result = extractCardV5([
    page([
      'MARIA',
      'DUBAI',
      'GOMEZ',
      'Managing Director',
      'ACME S.r.l.',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Maria');
  assert.equal(result.lastName.value, 'Gomez');
});

test('P1 azienda: claim grammaticali cedono a un sito business osservato', () => {
  for (const claim of [
    'SOFTWARE AS A SERVICE',
    'THE FUTURE IS NOW',
    'IDEAS INTO ACTION',
    'CREATE CONNECT GROW',
    'MOVE FORWARD TOGETHER',
    'BUILT FOR TOMORROW',
    'PASSION FOR QUALITY',
    'WHERE IDEAS GROW',
    'GROW WITH CONFIDENCE',
    'SHAPING A BETTER WORLD',
  ]) {
    assert.equal(isCompanySloganClaimLine(claim), true, claim);
    const result = extractCardV5([
      page([
        claim,
        'Nora Valli',
        'Managing Director',
        'www.aerolith.com',
      ]),
    ]);

    assert.equal(companyKey(result.company.value), 'aerolith', claim);
    assert.equal(result.firstName.value, 'Nora', claim);
    assert.equal(result.lastName.value, 'Valli', claim);
  }
});

test('P1 azienda: un brand osservato multi-parola conserva spazi e congiunzioni', () => {
  const result = extractCardV5([
    page([
      'Dal Collo & Partners',
      'Commercialisti Associati',
      'info@dalcolloepartners.it',
      'www.dalcolloepartners.it',
    ]),
  ]);

  assert.match(result.company.value ?? '', /Dal Collo\s*&\s*Partners/i);
  assert.doesNotMatch(result.company.value ?? '', /Dalcolloepartners/i);
});

test('P1 azienda: una località non espande un brand breve coerente col sito', () => {
  const result = extractCardV5([
    page([
      'Fabrizio Saro',
      'General Manager',
      'fabrizio.s@fuentisCom',
      'Via Mezzomonte 24',
      'www.fuentis.com',
      '33077-Sacile (PN)- ITALY',
    ]),
  ]);

  assert.match(result.company.value ?? '', /Fuentis|Fluentis/i);
  assert.doesNotMatch(result.company.value ?? '', /Sacile/i);
  assert.match(result.address.value?.full ?? '', /Sacile/i);
});

test('P1 azienda: intestazioni professionali e istituzionali prevalgono sulla radice dominio', () => {
  const professional = extractCardV5([
    page([
      'Studio Legale Associato Mondin-Campesan-Urbani-Messuri',
      'Avv. Paolo Dal Soglio',
      'info@venetoavvocati.it',
      '36015 Schio (VI) Pza Statuto 25',
    ]),
  ]);
  assert.match(professional.company.value ?? '', /Studio Legale/i);

  const institutional = extractCardV5([
    page([
      'Andrea Ponzoni',
      'Dirigente',
      'Responsabile Servizio informatica',
      'Istituto Zooprofilattico Sperimentale delle Venezie',
      'aponzoni@izsvenezie.it',
      'Viale dell Università 10 - 35020 Legnaro (PD)',
    ]),
  ]);
  assert.match(institutional.company.value ?? '', /Istituto Zooprofilattico/i);
});

test('P1 ruolo: qualificatori aziendali e ruoli composti non azzerano il campo', () => {
  const qualified = extractCardV5([
    page([
      'ServOV Next Generation Platform',
      'Enrico Arata',
      'Corso Massimo d’Azeglio, 8',
      'Responsabile Servoy Italia',
      'www.servoy.com',
    ]),
  ]);
  assert.match(qualified.role.value ?? '', /Responsabile/i);

  const composed = extractCardV5([
    page([
      'Andrea Ponzoni',
      'Dirigente',
      'Responsabile Servizio informatica',
      'Istituto Zooprofilattico Sperimentale delle Venezie',
      'aponzoni@izsvenezie.it',
    ]),
  ]);
  assert.match(composed.role.value ?? '', /Dirigente/i);
  assert.match(composed.role.value ?? '', /Responsabile/i);

  assert.equal(
    finalizeRoleValue('Sales Manager Acme', 'Acme'),
    'Sales Manager'
  );
  assert.equal(
    finalizeRoleValue('Acme Italia Software Solutions', 'Acme'),
    null
  );
  assert.equal(
    finalizeRoleValue('Space Systems Manager', 'ACE'),
    'Space Systems Manager'
  );
  assert.equal(
    finalizeRoleValue('Engineering Manager', 'RING'),
    'Engineering Manager'
  );
  assert.equal(
    finalizeRoleValue('Sales Manager', 'MAN'),
    'Sales Manager'
  );
  assert.equal(
    finalizeRoleValue('Acme — Sales Manager', 'Acme'),
    'Sales Manager'
  );
  assert.equal(finalizeRoleValue('CEO / www.acme.com', 'Acme'), 'CEO');
  assert.equal(finalizeRoleValue('Manager / Via Roma 3', 'Acme'), 'Manager');
});

test('P1 persona e azienda: un cognome societario conserva persona e forma legale', () => {
  const cases = [
    ['JOHN SMITH', 'SMITH LLC', 'j.smith@smith.com', 'John', 'Smith', 'smithllc'],
    ['NORA VALLI', 'VALLI GmbH', 'n.valli@valli.de', 'Nora', 'Valli', 'valligmbh'],
  ] as const;

  for (
    const [
      observedPerson,
      observedCompany,
      email,
      expectedFirst,
      expectedLast,
      expectedCompany,
    ] of cases
  ) {
    const result = extractCardV5([
      page([
        observedPerson,
        'Managing Director',
        observedCompany,
        email,
      ]),
    ]);

    assert.equal(result.firstName.value, expectedFirst, observedPerson);
    assert.equal(result.lastName.value, expectedLast, observedPerson);
    assert.equal(companyKey(result.company.value), expectedCompany, observedCompany);
  }

  const genericMailbox = extractCardV5([
    page([
      'SMITH LLC',
      'info@smith.com',
    ]),
  ]);
  assert.equal(genericMailbox.firstName.value, null);
  assert.equal(genericMailbox.lastName.value, null);
  assert.equal(companyKey(genericMailbox.company.value), 'smithllc');

  const familyFirmWithGenericMailbox = extractCardV5([
    page([
      'JOHN SMITH',
      'Managing Director',
      'SMITH LLC',
      'info@smith.com',
    ]),
  ]);
  assert.equal(familyFirmWithGenericMailbox.firstName.value, 'John');
  assert.equal(familyFirmWithGenericMailbox.lastName.value, 'Smith');
  assert.equal(
    companyKey(familyFirmWithGenericMailbox.company.value),
    'smithllc'
  );
});

test('P1 persona: una repair non corregge lettere OCR non coincidenti', () => {
  const result = extractCardV5([
    page([
      'JOHN SMYTH',
      'Managing Director',
      'ACME S.r.l.',
      'john.smith@acme. com',
    ]),
  ]);

  assert.notEqual(result.lastName.value, 'Smith');
  assert.equal(
    result.firstName.reasons.includes(
      'riga nome osservata corroborata da repair email'
    ),
    false
  );
  assert.deepEqual(result.emails.value, []);
});

test('P1 azienda: Road e Street senza struttura civica restano marchi', () => {
  const cases = [
    ['Open Road LLC', 'openroad.com'],
    ['Abbey Road Studios Ltd.', 'abbeyroadstudios.com'],
    ['Street Smart S.r.l.', 'streetsmart.it'],
    ['Studio 54 Road LLC', 'studio54road.com'],
    ['Route 66 LLC', 'route66.com'],
    ['Lane 7 GmbH', 'lane7.de'],
    ['Street 42 S.r.l.', 'street42.it'],
  ] as const;

  for (const [observed, domain] of cases) {
    const result = extractCardV5([
      page([
        observed,
        'Nora Valli',
        'Managing Director',
        `nora@${domain}`,
        `www.${domain}`,
      ]),
    ]);

    assert.notEqual(
      result.debugLines.find((line) => line.text === observed)?.scores.company,
      -10,
      observed
    );
    assert.equal(companyKey(result.company.value), companyKey(observed), observed);
    assert.equal(result.address.value, null, observed);
  }
});

test('P1 persona: cognomi Lane, Road e Street restano persone con evidenza esatta', () => {
  const result = extractCardV5([
    page([
      'ACME S.r.l.',
      'DIANE LANE',
      'Managing Director',
      '12 King Lane',
      'London SW1A 1AA',
      'United Kingdom',
      'diane.lane@acme. com',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Diane');
  assert.equal(result.lastName.value, 'Lane');
  assert.deepEqual(result.emails.value, []);
  assert.match(result.address.value?.full ?? '', /King Lane/i);
  assert.doesNotMatch(
    result.address.value?.full ?? '',
    /Diane Lane|diane\.lane@/i
  );
  assert.doesNotMatch(result.address.value?.street ?? '', /Diane Lane/i);
});

test('P1 persona: token osservati non ricevono lettere nuove senza evidenza', () => {
  const cases = [
    ['MARK NET', 'Mark', 'Net'],
    ['MARK FRANCESCH', 'Mark', 'Francesch'],
    ['SAM ROBERTS', 'Sam', 'Roberts'],
  ] as const;

  for (const [observed, expectedFirst, expectedLast] of cases) {
    const result = extractCardV5([
      page([
        observed,
        'Managing Director',
        'ACME S.r.l.',
      ]),
    ]);

    assert.equal(result.firstName.value, expectedFirst, observed);
    assert.equal(result.lastName.value, expectedLast, observed);
  }
});

test('P1 persona: un onorifico consente solo la rimozione univoca di un glifo OCR interno', () => {
  const result = extractCardV5([
    page([
      'Dott. Mlarco Tagliabue',
      'Amministratore Delegato',
      'ACME S.r.l.',
      'marco.tagliabue@acme.example',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Marco');
  assert.equal(result.lastName.value, 'Tagliabue');
});

test('P1 persona: un onorifico senza prova indipendente non modifica il nome osservato', () => {
  for (const observed of [
    'Dr. Marino Rossi',
    'Dott. Mlarco Tagliabue',
  ]) {
    const result = extractCardV5([
      page([
        observed,
        'Amministratore Delegato',
        'ACME S.r.l.',
      ]),
    ]);

    const expected = observed.includes('Marino') ? 'Marino' : 'Mlarco';
    assert.equal(result.firstName.value, expected, observed);
  }
});

test('P1 persona: surname-first CAPS richiede un nome proprio esatto', () => {
  assert.deepEqual(parseCapsSurnameFirstLine('MOSCATELLI LUCA'), {
    firstName: 'Luca',
    lastName: 'Moscatelli',
  });
  assert.equal(parseCapsSurnameFirstLine('MARK FRANCESCH'), null);
  assert.equal(parseCapsSurnameFirstLine('SAM ROBERTS'), null);
});

test('P1 persona: nome e cognome su righe separate non subiscono repair fuzzy', () => {
  const result = extractCardV5([
    page([
      'MARK',
      'NET',
      'Managing Director',
      'ACME S.r.l.',
      'mark.net@acme.com',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Mark');
  assert.equal(result.lastName.value, 'Net');
});

test('P1 persona: una repair non soppianta una diversa persona associata al ruolo', () => {
  const cases = [
    ['NORA VALLI', 'Managing Director', 'JOHN SMITH'],
    ['Managing Director', 'NORA VALLI', 'JOHN SMITH'],
    ['NORA MARIA DE VALLI', 'Managing Director', 'JOHN SMITH'],
  ] as const;

  for (const personBlock of cases) {
    const result = extractCardV5([
      page([
        ...personBlock,
        'ACME S.r.l.',
        'john.smith@acme. com',
      ]),
    ]);

    assert.equal(result.firstName.value, 'Nora', personBlock.join(' / '));
    assert.match(result.lastName.value ?? '', /Valli$/i, personBlock.join(' / '));
    assert.deepEqual(result.emails.value, [], personBlock.join(' / '));
    assert.equal(
      result.firstName.reasons.includes(
        'riga nome osservata corroborata da repair email'
      ),
      false,
      personBlock.join(' / ')
    );
  }
});

test('P1 persona: categorie, concessionarie e brand fusi non attivano il recupero generico', () => {
  const cases = [
    [
      'concessionaria',
      [
        'LEONI',
        'Concessionaria LEONI GUIDO',
        'di Leoni Bruno e C. s.a.s.',
        '46014 Castellucchio (MN)',
      ],
    ],
    [
      'categoria artigiana',
      [
        'FALEGNAMERIA FILIPPI',
        'PIETRO & FIGLI S.N.C.',
        'info@filippiserramenti.it',
        'www.filippiserramenti.it',
      ],
    ],
    [
      'brand fuso',
      [
        'OrientaForm',
        'formazione@orientaform.it',
        'www.orientaform.it',
        'Formazione e Orientamento',
      ],
    ],
  ] as const;

  for (const [label, lines] of cases) {
    const result = extractCardV5([page(lines)]);
    const diagnostic = `${label}: ${JSON.stringify({
      firstName: result.firstName,
      lastName: result.lastName,
      company: result.company,
    })}`;
    assert.equal(result.firstName.value, null, diagnostic);
    assert.equal(result.lastName.value, null, diagnostic);
  }
});

test('P1 persona: il nome immediatamente sopra un ruolo prevale su un logo simile a nome', () => {
  const result = extractCardV5([
    page([
      'Super Slar',
      'Solar Energy Group Sp.A',
      'MAURIZIO LAIN',
      'CONSULENTE TECNICO',
      'Agenzia Generale Vicenza di Fabbrizio Rita',
      'e-mail. rita fabbrizio@supersolar it',
    ]),
  ]);

  const diagnostic = JSON.stringify({
    firstName: result.firstName,
    lastName: result.lastName,
    company: result.company,
    role: result.role,
  });
  assert.equal(result.firstName.value, 'Maurizio', diagnostic);
  assert.equal(result.lastName.value, 'Lain', diagnostic);
});

test('P1 persona: la riga immediatamente sopra il ruolo prevale su un secondo nome sottostante', () => {
  const result = extractCardV5([
    page([
      'NORA VALLI',
      'Managing Director',
      'LUCA BIANCHI',
      'ACME S.r.l.',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Nora');
  assert.equal(result.lastName.value, 'Valli');
});

test('P1 persona: una riga Title Case sopra un ruolo prevale su una mailbox di sede', () => {
  const result = extractCardV5([
    page([
      'NORTHSTAR',
      'PORTO',
      'Elara Voss',
      'Operations Manager',
      'NORTHSTAR LLC',
      'porto@northstar.example',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Elara');
  assert.equal(result.lastName.value, 'Voss');
});

test('P1 persona: un nome osservato dentro una riga mista è recuperato solo con email personale concorde', () => {
  const result = extractCardV5([
    page([
      'SOFTWARE Nora Valli',
      'Operations Manager',
      'nvalli@novacore.example',
      'www.novacore.example',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Nora');
  assert.equal(result.lastName.value, 'Valli');
});

test('P1 persona: reparti e paesi sopra un ruolo non diventano identità', () => {
  const nonPeople = [
    'CORPORATE AFFAIRS',
    'STRATEGIC INITIATIVES',
    'DATA SCIENCE',
    'COTE D IVOIRE',
    'DOMINICAN REPUBLIC',
    'SRI LANKA',
  ] as const;

  for (const observed of nonPeople) {
    const result = extractCardV5([
      page([
        observed,
        'Regional Director',
        'NOVACORE S.r.l.',
        'info@novacore.example',
      ]),
    ]);
    const diagnostic = `${observed}: ${JSON.stringify({
      firstName: result.firstName,
      lastName: result.lastName,
    })}`;
    assert.equal(result.firstName.value, null, diagnostic);
    assert.equal(result.lastName.value, null, diagnostic);
  }
});

test('P1 persona: un cognome omonimo di un canale generico resta persona con email esatta', () => {
  for (const observed of [
    ['JOHN PRESS', 'john.press@acme.example', 'John', 'Press'],
    ['PETER SALES', 'peter.sales@acme.example', 'Peter', 'Sales'],
    ['MARK STORE', 'mark.store@acme.example', 'Mark', 'Store'],
    ['GRACE MEDIA', 'grace.media@acme.example', 'Grace', 'Media'],
  ] as const) {
    const [line, email, expectedFirst, expectedLast] = observed;
    const result = extractCardV5([
      page([
        line,
        'Managing Director',
        'ACME LLC',
        email,
      ]),
    ]);
    assert.equal(result.firstName.value, expectedFirst, line);
    assert.equal(result.lastName.value, expectedLast, line);
    assert.equal(result.role.value, 'Managing Director', line);
  }
});

test('P1 persona: surname-first ALLCAPS richiede evidenza email esatta', () => {
  for (const [line, email, expectedFirst, expectedLast] of [
    ['ROSSI ALVISE', 'alvise.rossi@acme.example', 'Alvise', 'Rossi'],
    ['ZHANG XIAO', 'xiao.zhang@acme.example', 'Xiao', 'Zhang'],
  ] as const) {
    const result = extractCardV5([
      page([
        line,
        'Managing Director',
        'ACME LLC',
        email,
      ]),
    ]);
    assert.equal(result.firstName.value, expectedFirst, line);
    assert.equal(result.lastName.value, expectedLast, line);
  }
});

test('P1 persona: ALLCAPS ambiguo senza prova conserva l’ordine osservato', () => {
  const result = extractCardV5([
    page([
      'ALVISE ROSSI',
      'Managing Director',
      'ACME LLC',
      'info@acme.example',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Alvise');
  assert.equal(result.lastName.value, 'Rossi');
});

test('P1 persona: apostrofi osservati restano parte del cognome', () => {
  const cases = [
    ["SEAN O'NEIL", 'Sean', "O'Neil"],
    ["PATRICK O'BRIEN", 'Patrick', "O'Brien"],
    ["MARCO D'ANGELO", 'Marco', "D'Angelo"],
    ['SEAN O’NEIL', 'Sean', "O'Neil"],
  ] as const;

  for (const [observed, expectedFirst, expectedLast] of cases) {
    const result = extractCardV5([
      page([
        observed,
        'Managing Director',
        'ACME S.r.l.',
      ]),
    ]);

    assert.equal(result.firstName.value, expectedFirst, observed);
    assert.equal(result.lastName.value, expectedLast, observed);
  }
});

test('P1 persona e azienda: particelle familiari non trasferiscono il nome nella società', () => {
  const cases = [
    ['MARCO DE LUCA', 'DE LUCA S.r.l.', 'info@deluca.it', 'Marco', 'De Luca'],
    ['LUCA DI MARCO', 'DI MARCO S.r.l.', 'info@dimarco.it', 'Luca', 'Di Marco'],
  ] as const;

  for (
    const [person, company, email, expectedFirst, expectedLast] of cases
  ) {
    const result = extractCardV5([
      page([
        person,
        'Managing Director',
        company,
        email,
      ]),
    ]);

    const diagnostic = `${person}: ${JSON.stringify({
      firstName: result.firstName,
      lastName: result.lastName,
      company: result.company,
    })}`;
    assert.equal(result.firstName.value, expectedFirst, diagnostic);
    assert.equal(result.lastName.value, expectedLast, diagnostic);
    assert.equal(
      companyKey(result.company.value),
      companyKey(company),
      `${company}: ${JSON.stringify(result.company)}`
    );
  }
});

test('P1 azienda: forma legale e indirizzo inline restano campi separati', () => {
  const cases = [
    ['ACME Ltd., 123 Main Road', 'acmeltd', /Main Road/i, '123'],
    [
      'ACME GmbH - Hauptstrasse 12',
      'acmegmbh',
      /Hauptstrasse/i,
      '12',
    ],
    ['ACME LLC, 123 Main Road', 'acmellc', /Main Road/i, '123'],
    ['ACME S.r.l. Via Roma 38', 'acmesrl', /Via Roma/i, '38'],
    ['ACME (S.r.l.) Via Roma 38', 'acmesrl', /Via Roma/i, '38'],
    [
      'ACME GmbH & Co. KG, Hauptstrasse 12',
      'acmegmbhcokg',
      /Hauptstrasse/i,
      '12',
    ],
    ['ACME S.A.R.L. 12 Rue de Paris', 'acmesarl', /Rue de Paris/i, '12'],
    ['ACME S.L. Calle Mayor 12', 'acmesl', /Calle Mayor/i, '12'],
    ['ACME Sp. z o.o. ul. Dluga 12', 'acmespzoo', /Dluga/i, '12'],
    ['ACME Ltd., 123 West 42nd Street', 'acmeltd', /West 42nd Street/i, '123'],
    ['ACME S.L., Calle Mayor, 10', 'acmesl', /Calle Mayor/i, '10'],
    ['ACME S.r.l. Via Roma 38 - 40050 Funo', 'acmesrl', /Via Roma/i, '38'],
    ['ACME LLC, Main Road 123, London', 'acmellc', /Main Road/i, '123'],
    ['ACME B.V., Keizersgracht 1', 'acmebv', /Keizersgracht/i, '1'],
    ['ACME N.V., Coolsingel 10', 'acmenv', /Coolsingel/i, '10'],
    ['ACME Oy, Mannerheimintie 12', 'acmeoy', /Mannerheimintie/i, '12'],
    ['ACME Kft, Vaci ut 10', 'acmekft', /Vaci ut/i, '10'],
  ] as const;

  for (const [observed, expectedCompany, expectedStreet, expectedCivic] of cases) {
    const result = extractCardV5([
      page([
        observed,
        'Nora Valli',
        'Managing Director',
      ]),
    ]);

    assert.equal(companyKey(result.company.value), expectedCompany, observed);
    assert.match(result.address.value?.street ?? '', expectedStreet, observed);
    assert.equal(result.address.value?.civicNumber, expectedCivic, observed);
    assert.doesNotMatch(
      result.address.value?.full ?? '',
      /\bACME\b/i,
      observed
    );
    assert.doesNotMatch(
      result.address.value?.street ?? '',
      /\bACME\b/i,
      observed
    );
  }
});

test('P1 indirizzo: una coda numerica non stradale resta fuori dall’indirizzo', () => {
  for (const observed of [
    'ACME Ltd., ISO 9001',
    'ACME Ltd., Model 3',
    'ACME Ltd., Since 1984',
    'ACME Ltd., Division 42',
    'ACME Ltd., Chapter 11',
  ]) {
    const result = extractCardV5([
      page([
        observed,
        'Nora Valli',
        'Managing Director',
      ]),
    ]);

    assert.equal(companyKey(result.company.value), 'acmeltd', observed);
    assert.equal(result.address.value, null, observed);
  }
});

test('P1 indirizzo: civico etichettato a cinque cifre non sostituisce il CAP', () => {
  const result = extractCardV5([
    page([
      'ACME S.r.l.',
      'Nora Valli',
      'Managing Director',
      'Via Roma, Nr. 12345',
      '40050 Funo di Argelato (BO)',
      'Italy',
    ]),
  ]);

  assert.equal(result.address.value?.civicNumber, '12345');
  assert.equal(result.address.value?.postalCode, '40050');
  assert.match(result.address.value?.city ?? '', /Funo di Argelato/i);
});

test('P1 indirizzo: CAP e città possono precedere la strada sulla stessa riga', () => {
  const cases = [
    [
      '00187 ROMA (RM), Piazza di Spagna 1',
      '00187',
      /Roma/i,
      /Piazza di Spagna/i,
      '1',
    ],
    [
      '75001 PARIS, 10 Rue de Rivoli',
      '75001',
      /Paris/i,
      /Rue de Rivoli/i,
      '10',
    ],
    [
      '10115 BERLIN, Invalidenstrasse 12',
      '10115',
      /Berlin/i,
      /Invalidenstrasse/i,
      '12',
    ],
  ] as const;

  for (
    const [observed, expectedPostal, expectedCity, expectedStreet, expectedCivic]
    of cases
  ) {
    const result = extractCardV5([
      page([
        'ACME S.r.l.',
        'Nora Valli',
        'Managing Director',
        observed,
      ]),
    ]);

    assert.equal(result.address.value?.postalCode, expectedPostal, observed);
    assert.match(result.address.value?.city ?? '', expectedCity, observed);
    assert.match(result.address.value?.street ?? '', expectedStreet, observed);
    assert.equal(result.address.value?.civicNumber, expectedCivic, observed);
  }
});

test('P1 azienda: un prefisso di dominio non corrobora l’identità completa', () => {
  for (const [observedCompany, evidenceLine] of [
    ['STATUS: ACTIVE S.A.', 'info@status.com'],
    ['CODE:ART B.V.', 'www.code.com'],
    ['SYSTEM.MODULE.STATUS: GREEN S.A.', 'info@system.com'],
  ] as const) {
    const result = extractBusinessCardV5([
      page([observedCompany, evidenceLine]),
    ]);

    assert.equal(result.company.value, observedCompany, observedCompany);
    assert.equal(result.company.confidence, 'low', observedCompany);
    assert.equal(result.company.source, 'layout', observedCompany);
    assert.ok(result.reviewFields.includes('company'), observedCompany);
  }
});

test('P1 azienda: email e sito devono convergere sulla stessa radice completa', () => {
  const discordant = extractBusinessCardV5([
    page([
      'CODE:ART S.A.',
      'info@code.com',
      'www.codeart.com',
    ]),
  ]);

  assert.equal(discordant.company.value, 'CODE:ART S.A.');
  assert.equal(discordant.company.confidence, 'low');
  assert.ok(discordant.reviewFields.includes('company'));
});

test('P1 azienda: email e sito concordi sostituiscono una label ambigua con provenance reale', () => {
  const lines = [
    'CLAIM: AVAILABLE IN S.A.',
    'Nora Vale',
    'Managing Director',
    'nora@aerolith.com',
    'www.aerolith.com',
  ] as const;
  const internal = extractCardV5([page(lines)]);
  const result = extractBusinessCardV5([page(lines)]);

  assert.equal(internal.company.value, 'Aerolith');
  assert.equal(internal.company.source, 'inferred');
  assert.deepEqual(internal.company.lineIds, [3, 4]);
  assert.deepEqual(internal.company.reasons, [
    'riga con separatore legale ambigua esclusa',
    'azienda derivata da email e sito osservati concordi',
  ]);
  assert.equal(result.company.value, 'Aerolith');
  assert.equal(result.company.source, 'inferred');
  assert.equal(result.company.confidence, 'high');
  assert.doesNotMatch(
    result.company.reasons.join(' '),
    /ragione sociale con forma giuridica/i
  );
});

test('P1 azienda: la convergenza risolve label testuali open-set senza vocabolario chiuso', () => {
  for (const observedCompany of [
    'PROMISE: QUALITY FIRST S.A.',
    'VISION: BETTER TOGETHER B.V.',
    'MISSION: GROW WITH YOU A.G.',
    'PROMESSA: QUALITA SEMPRE N.V.',
    'FRASE: INNOVAZIONE CONTINUA S.A.',
  ]) {
    const result = extractBusinessCardV5([
      page([
        observedCompany,
        'nora@realbrand.com',
        'www.realbrand.com',
      ]),
    ]);

    assert.equal(result.company.value, 'Realbrand', observedCompany);
    assert.equal(result.company.source, 'inferred', observedCompany);
    assert.equal(result.company.confidence, 'high', observedCompany);
  }
});

test('P1 review: una proposta LOW non sovrascrive azienda o email confermate', () => {
  const now = new Date('2026-07-31T09:00:00.000Z');
  const verifiedEmail = 'legacy@verified.com';
  const card: BusinessCard = {
    id: 'review-low-preserves-verified',
    type: 'business_card',
    title: 'Verified Legacy GmbH',
    images: [],
    rawText: '',
    confidence: { emails: 1 },
    createdAt: now,
    updatedAt: now,
    firstName: '',
    lastName: '',
    company: 'Verified Legacy GmbH',
    role: '',
    emails: [verifiedEmail],
    emailEvidence: [
      {
        value: verifiedEmail,
        rawValue: verifiedEmail,
        origin: 'user',
        pageIndex: null,
        lineId: null,
        rawOcr: verifiedEmail,
        transformations: ['user_confirmed'],
        confidence: 1,
        validationStatus: 'valid',
        requiresReview: false,
        confirmed: true,
      },
    ],
    phones: [],
  };

  const result = attachExtractionReviewToCard(card, [
    page(['CLAIM: AVAILABLE IN S.A.']),
  ]);

  assert.equal(result.extractionReview?.company.confidence, 'low');
  assert.equal(result.company, 'Verified Legacy GmbH');
  assert.equal(result.title, 'Verified Legacy GmbH');
  assert.deepEqual(result.emails, [verifiedEmail]);
  assert.equal(result.emailEvidence?.[0]?.origin, 'user');
});

test('P1 review: una proposta azienda LOW resta solo in review se il campo è vuoto', () => {
  const now = new Date('2026-07-31T09:00:00.000Z');
  const card: BusinessCard = {
    id: 'review-low-remains-proposal',
    type: 'business_card',
    title: '',
    images: [],
    rawText: '',
    confidence: {},
    createdAt: now,
    updatedAt: now,
    firstName: '',
    lastName: '',
    company: '',
    role: '',
    emails: [],
    phones: [],
  };

  const result = attachExtractionReviewToCard(card, [
    page(['CLAIM: AVAILABLE IN S.A.']),
  ]);

  assert.equal(
    result.extractionReview?.company.value,
    'CLAIM: AVAILABLE IN S.A.'
  );
  assert.equal(result.extractionReview?.company.confidence, 'low');
  assert.equal(result.company, '');
});

test('P1 review: una email legacy non classificata resta proposta tracciata', () => {
  const now = new Date('2026-07-31T09:00:00.000Z');
  const legacyEmail = 'legacy@verified.com';
  const card: BusinessCard = {
    id: 'review-low-preserves-legacy-suggestion',
    type: 'business_card',
    title: 'Verified Legacy GmbH',
    images: [],
    rawText: '',
    confidence: {},
    createdAt: now,
    updatedAt: now,
    firstName: '',
    lastName: '',
    company: 'Verified Legacy GmbH',
    role: '',
    emails: [legacyEmail],
    phones: [],
  };

  const result = attachExtractionReviewToCard(card, [
    page(['Nora Bianchi']),
  ]);

  // Il contratto 3B non rende operative email prive di provenance, ma il
  // valore non viene perso: resta una proposta esplicita da confermare.
  assert.deepEqual(result.emails, []);
  assert.equal(result.emailEvidence?.[0]?.value, legacyEmail);
  assert.equal(result.emailEvidence?.[0]?.origin, 'inferred');
  assert.equal(result.emailEvidence?.[0]?.requiresReview, true);
  assert.ok(result.extractionReview?.reviewFields.includes('emails'));
});

test('P1 azienda: preserva la coda societaria composta esattamente come osservata', () => {
  const result = extractCardV5([
    page([
      'Alex Morgan',
      'Marketing Director',
      'MERIDIAN INDUSTRIES',
      '(Private) Limited',
      'info@meridianindustries.com',
    ]),
  ]);

  assert.equal(
    companyKey(result.company.value),
    companyKey('MERIDIAN INDUSTRIES (Private) Limited')
  );
});


test('P1 azienda: brand stacked corroborato dal sito non retrocede alla sola riga logo', () => {
  const result = extractCardV5([
    page([
      'Mario Rossi',
      'CARROZZZERIA',
      'CRISTALLO',
      'www.carrozzeriacristallo.net',
    ]),
  ]);

  assert.equal(
    companyKey(result.company.value),
    companyKey('Carrozzeria Cristallo')
  );
});


test('P1 dominio azienda: provider generico prima del sito non oscura il dominio business osservato', () => {
  const result = extractCardV5([
    page([
      'CARROZzZERIA',
      'CRISTALLO',
      'di De Rossi Romeo Emilio',
      'Via Croce, 5836033 Isola Vicentina',
      'Tel. 0444 975669',
      'cell./whatsapp 345 1638355',
      'P.J. 01238380248IC.F. DRSRML58E27E864N',
      'carr_cristallo@libero.it I www.carrozzeriacristallo.net',
    ]),
  ]);

  assert.equal(
    companyKey(result.company.value),
    companyKey('Carrozzeria Cristallo')
  );
});


test('P1 istituzione: gerarchia multilivello osservata prevale sulla singola intestazione', () => {
  const result = extractCardV5([
    page([
      'Boston University',
      'Division of Extended Education',
      'ERSITAS BOSTON',
      'Metropolitan College',
      'NENSSSXIX',
      '755 Commonwealth Avenue',
      'Room B7',
      'Boston, Massachusetts 02215',
      'CON',
      '617-358-2153',
      'Fax: 617-353-2744',
      'E-mail: katiepebu.edu',
      'Katie L. Pasciucco',
      'Admissions & Outreach Coordinato',
    ]),
  ]);

  assert.equal(
    result.company.value,
    'Boston University / Division of Extended Education, Metropolitan College'
  );
  assert.ok((result.company.lineIds?.length ?? 0) >= 3);
});


test('P1 ruolo: coda executive valida viene separata da prefisso OCR aziendale', () => {
  const result = extractCardV5([
    page([
      'ISIS',
      'For Industry',
      'AlesSIO GIullano',
      'GarbuIoDICKINson GrOUp CIO',
      'alesSIO.giullano@ISISware.com',
      'Moble 39 33S S2gsi04',
      'Via E. AzzI, 1 -BIO3BPaeSe (TV) ITALY',
      'PL',
      '-035271B0267',
      'Tel -39 O42e43B685',
      'Fax39 O42176O695',
      'WwW.ISISware.com',
    ]),
  ]);

  assert.equal(result.role.value, 'Group CIO');
});


test('P1 azienda: legal-company osservata ripristina una riscrittura fuzzy della stessa riga', () => {
  const result = extractCardV5([
    page([
      'SAP',
      'Infor-Etied',
      'CON SU LII NG',
      'SAP BusinessObjects',
      'Andrea Grigoli',
      'Amministratore Unico',
      'andrea.grigoli@informeticons.com',
      '+39 393 0506967',
      'InformEtico Consulting srl.',
      'Viole Del Lovoro, 33- Centro Direzionale E33',
      '37036 Son Martino Buon Albergo VR',
      'P Iva e CF 034811480238',
      'www.informeticons.com'
    ]),
  ]);

  assert.equal(result.company.value, 'InformEtico Consulting srl.');
});


test('P1 fiscale: CF slash PNA produce PIVA valida senza assorbire Loc', () => {
  const result = extractCardV5([
    page([
      'OrientaForm',
      'formazione@orientaform.it',
      'www.orientaform.it',
      'Formazione e Orientamento',
      'Ente accreditato per i servizi al lavoro',
      'presso la Regione Veneto',
      "OrientoForm snc CF /PNA 03674360247 Loc Ponte d'oro 8/E Schio (VI)"
    ]),
  ]);
  assert.equal(result.vatNumber.value, '03674360247');
});


test('P1 azienda: resolver multi-riga generico preserva gerarchie istituzionali', () => {
  const result = extractCardV5([
    page([
      'TERMOIDRAULICA',
      'PASUBIO',
      'di MENEGOZZO GIANTONIO',
      'VIA ISONZO, 10',
      'tel. 0445 522966',
      '36015 SCHIO VI',
      'cell. 347 4311173',
      'P.IVA:03033010244',
      'gian.menegozzo@gmail.com'
    ]),
  ]);
  assert.equal(result.company.value, 'TERMOIDRAULICA PASUBIO');
});


test('P1 dominio azienda: mailbox generica discordante dal sito non guida la company', () => {
  assert.equal(
    emailDomainIncoherentWithWebsite(
      ['info@imexhaustsystem.it'],
      'www.lmexhaustsystem.it'
    ),
    true
  );

  const result = extractCardV5([
    page([
      'www.lmexhaustsystem.it',
      'info@Imexhaustsystem.it',
      'EXHAUST SYSTÈM',
      'MOSCATELLI LUCA',
    ]),
  ]);

  assert.equal(result.emailDomainOcrMismatch, true);
  assert.notEqual(companyKey(result.company.value), 'imexhaustsystem');
});


test('P1 persona: casing OCR interno non spezza un nome corroborato dalla email', () => {
  assert.equal(
    normalizeFusedPersonLine(
      'AlesSIO GIullano',
      ['alessio.giullano@example.com'],
      []
    ),
    'AlesSIO GIullano'
  );
});

test('P1 persona: vero CamelCase resta separabile senza confondere casing OCR', () => {
  assert.equal(splitCamelCaseInText('MarioRossi'), 'Mario Rossi');
  assert.equal(splitCamelCaseInText('AlesSIO'), 'AlesSIO');
  assert.equal(splitCamelCaseInText('MarIO'), 'MarIO');
});

test('P1 persona: parser conserva il token OCR intero se la email lo corrobora', () => {
  const result = extractCardV5([
    page([
      'For Industry',
      'AlesSIO GIullano',
      'Group CIO',
      'alessio.giullano@example-industry.com',
      'www.example-industry.com',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Alessio');
  assert.equal(result.lastName.value, 'Giullano');
});


test('P1 indirizzo: contact-mode qualifier davanti a telefono non diventa città', () => {
  const result = extractCardV5([
    page([
      'Example Platform',
      'Mario Rossi',
      "Corso Massimo d'Azeglio, 8",
      'Responsabile Italia',
      'IO15 Torino',
      'direct tel +39 335 29 59 65',
      'Italia',
      'www.example.com',
    ]),
  ]);
  assert.notEqual(result.address.value?.city?.toLowerCase(), 'direct');
});

test('P1 indirizzo: città prima di telefono resta valida se non è un contact qualifier', () => {
  const result = extractCardV5([
    page([
      'Example S.p.A.',
      'Mario Rossi',
      'Via Roma 8',
      'Torino tel +39 011 1234567',
      'Italia',
    ]),
  ]);
  assert.equal(result.address.value?.city?.toLowerCase(), 'torino');
});

test('P1 indirizzo: glifo OCR finale cade solo se la città base è osservata sulla stessa pagina', () => {
  const result = extractCardV5([
    page([
      'ACME S.p.a. Corso Castelfidardo 30/A, 10129 Torino T',
      'info@acme.example',
      'www.acme.example',
      'Torino',
      'Senior Consultant',
      'Mario Rossi',
    ]),
  ]);
  assert.equal(result.address.value?.city, 'Torino');
});


test('P1 company finalizer: descriptor tardivo non sovrascrive organization osservata corroborata', () => {
  const result = extractCardV5([
    page([
      'AlphaForm',
      'formazione@alphaform.it',
      'www.alphaform.it',
      'Formazione e Orientamento',
      'Ente accreditato per i servizi al lavoro',
      'presso la Regione Veneto',
      'AlphaForm snc CF / PIVA 03674360247',
    ]),
  ]);
  assert.match(result.company.value ?? '', /alphaform/i);
  assert.doesNotMatch(result.company.value ?? '', /presso la regione/i);
});

test('P1 company finalizer: legal-company osservata forte non retrocede a categoria commerciale', () => {
  const result = extractCardV5([
    page([
      'Mario Rossi',
      'm.rossi@interhouse.it',
      'InterHouse s.r.l.u.',
      'www.interhouse.it',
      'AGENZIA IMMOBILIARE',
    ]),
  ]);
  assert.match(result.company.value ?? '', /interhouse/i);
  assert.doesNotMatch(result.company.value ?? '', /^agenzia immobiliare$/i);
});


test('P1 company open-set V4: provider generico corrobora solo il brand osservato esatto', () => {
  const result = extractCardV5([
    page([
      'Kawasaki',
      'Concessionario Ufficiale Kawasaki per Vicenza e Provincia',
      'onlytype@libero.it',
      'di Balduzzo Raimondo',
      'Only Type',
    ]),
  ]);
  assert.match(result.company.value ?? '', /only\s*type/i);
  assert.doesNotMatch(result.company.value ?? '', /^concessionario/i);
});

test('P1 company open-set V4: local-part generico info non diventa company', () => {
  const result = extractCardV5([
    page([
      'Mario Rossi',
      'info@libero.it',
      'Sales Manager',
    ]),
  ]);
  assert.doesNotMatch(result.company.value ?? '', /^info$/i);
});

test('P1 company open-set V4: mailbox personale non sostituisce persona con company', () => {
  const result = extractCardV5([
    page([
      'Mario Rossi',
      'mariorossi@libero.it',
      'Sales Manager',
    ]),
  ]);
  assert.doesNotMatch(result.company.value ?? '', /mario\s*rossi/i);
});


test('P1 website OCR split: spazio dopo trattino dentro host esplicito viene ricomposto', () => {
  const result = extractCardV5([
    page([
      'Alpha Beta',
      'www.alpha- beta.it',
      'Mario Rossi',
      'Sales Manager',
    ]),
  ]);
  assert.equal(result.website.value, 'www.alpha-beta.it');
  assert.match(result.company.value ?? '', /alpha\s*beta/i);
});

test('P1 website OCR split: testo non-dominio dopo trattino non viene fuso', () => {
  const result = extractCardV5([
    page([
      'Alpha',
      'www.alpha- marketing',
      'Mario Rossi',
      'Sales Manager',
    ]),
  ]);
  assert.notEqual(result.website.value, 'www.alpha-marketing');
});

test('P1 website OCR split: sito già valido resta invariato', () => {
  const result = extractCardV5([
    page([
      'Acme Group',
      'www.acme-group.com',
      'Mario Rossi',
      'Sales Manager',
    ]),
  ]);
  assert.equal(result.website.value, 'www.acme-group.com');
});


test('P1 indirizzo A1: role semantic guard impedisce al ruolo di diventare città', () => {
  const result = extractCardV5([
    page([
      'Servoy Next Generation Platform',
      'Enrico Arata',
      "Corso Massimo d'Azeglio, 8",
      'Responsabile Servoy Italia',
      'IO15 Torino',
      'direct tel +39 335 29 59 65',
      'Italia',
      'www.servoy.com',
    ]),
  ]);
  assert.equal(result.address.value?.street, "Corso Massimo D'azeglio");
  assert.equal(result.address.value?.civicNumber, '8');
  assert.doesNotMatch(result.address.value?.city ?? '', /responsabile|servoy/i);
  assert.doesNotMatch(result.address.value?.full ?? '', /responsabile\s+servoy/i);
});


test('P1 indirizzo A2 V11: CAP città zona via conserva componenti osservati', () => {
  const result=extractCardV5([page([
    'Scuola Italiana Design',
    'Giorgio Pellizzaro',
    'Sede didoica: 35127 PADOVA - Z.I. Sud - Corso Stati Uniti, 14 bis',
    'www.scuolaitalianadesign.com',
  ])]);
  assert.equal(result.address.value?.postalCode,'35127');
  assert.match(result.address.value?.city ?? '',/^Padova$/i);
  assert.match(result.address.value?.street ?? '',/^Corso Stati Uniti$/i);
  assert.match(result.address.value?.civicNumber ?? '',/^14 bis$/i);
});

test('P1 indirizzo A2 V11: street civic trattino CAP città resta separato', () => {
  const result=extractCardV5([page([
    'ACME S.r.l. Via Roma 38 - 40050 Funo',
    'Mario Rossi',
  ])]);
  assert.match(result.address.value?.street ?? '',/^Via Roma$/i);
  assert.equal(result.address.value?.civicNumber,'38');
  assert.equal(result.address.value?.postalCode,'40050');
  assert.match(result.address.value?.city ?? '',/^Funo$/i);
});


test('P1 indirizzo A3 V2: residuo OCR telefono/fax non entra nell’indirizzo', () => {
  const result=extractCardV5([page([
    'Potonio Gaboardk',
    'Senior Partner',
    'mobile 39 392 17 21 116',
    'agaboardi@thenissoluzioni it',
    'uia F Lana l- 25020 Flero (Bs)',
    't - f B l 84',
    'www themissoluzioni it',
    'info@ themissoluzioni it',
  ])]);
  assert.doesNotMatch(result.address.value?.full ?? '', /(?:^|[, -])t\s*-\s*f\b/i);
  assert.match(result.address.value?.full ?? '', /25020/i);
  assert.match(result.address.value?.city ?? '', /Flero/i);
});

test('P1 indirizzo A3 V2: città osservata prima del telefono resta valida', () => {
  const result=extractCardV5([page([
    'Mario Rossi',
    'Via Roma, 10',
    'Torino tel +39 011 1234567',
  ])]);
  assert.match(result.address.value?.city ?? '', /^Torino$/i);
});

test('P1 indirizzo A3 V2: qualifier contatto non diventa città', () => {
  const result=extractCardV5([page([
    'Mario Rossi',
    'Via Roma, 10',
    'direct tel +39 011 1234567',
    'Torino',
  ])]);
  assert.doesNotMatch(result.address.value?.city ?? '', /^direct$/i);
});

test('P1 indirizzo A3 V2: via reale con lettere T/F resta valida', () => {
  const result=extractCardV5([page([
    'Mario Rossi',
    'Via T Fabbri, 84',
    '40100 Bologna BO',
  ])]);
  assert.match(result.address.value?.street ?? '', /^Via T Fabbri$/i);
  assert.equal(result.address.value?.civicNumber,'84');
});


test('P1 indirizzo A4 V3: CAP OCR corrotto prima della città recupera solo la città', () => {
  const result=extractCardV5([page([
    'ServOV Next Generation Platform',
    'Enrico Arata',
    "Corso Massimo d'Azeglio, 8",
    'Responsabile Servoy Italia',
    'IO15 Torino',
    'direct tel +39 335 29 59 65',
    'Italia',
  ])]);
  assert.match(result.address.value?.city ?? '',/^Torino$/i);
  assert.equal(result.address.value?.civicNumber,'8');
  assert.notEqual(result.address.value?.postalCode,'IO15');
});

test('P1 indirizzo A4 V3: direct tel non diventa città', () => {
  const result=extractCardV5([page([
    'Mario Rossi','Via Roma, 10','direct tel +39 011 1234567','Torino'
  ])]);
  assert.doesNotMatch(result.address.value?.city ?? '',/^direct$/i);
});

test('P1 indirizzo A4 V3: città prima del telefono resta valida', () => {
  const result=extractCardV5([page([
    'Mario Rossi','Via Roma, 10','Torino tel +39 011 1234567'
  ])]);
  assert.match(result.address.value?.city ?? '',/^Torino$/i);
});


test('P1 telefoni internazionali: parentesi osservate restano bilanciate e senza punteggiatura orfana', () => {
  const result = extractCardV5([page([
    'Mario Rossi',
    'Technical Manager',
    'Tel: (0445) 671155',
  ])]);
  const number = result.phones.value?.[0]?.number ?? '';
  assert.equal(number, '0445 671155');
  assert.equal(number.includes('(') || number.includes(')'), false);
});

test('P1 telefoni internazionali: +, 00, trattini, punti e slash sono accettati senza country rule italiana', () => {
  const samples = [
    ['Phone: +1 (415) 555-0123', '14155550123'],
    ['Tel: 0049 30 1234.5678', '00493012345678'],
    ['Phone: +44 20 7946 0958', '442079460958'],
  ] as const;
  for (const [raw, expectedDigits] of samples) {
    const result = extractCardV5([page(['John Doe', 'Manager', raw])]);
    assert.equal((result.phones.value?.[0]?.number ?? '').replace(/\D/g, ''), expectedDigits);
  }
});


test('P1 KOMINE: Michael Chang resta osservato e non viene femminilizzato', () => {
  const result = extractCardV5([
    page([
      'MICHAEL CHANG',
      'Sales Manager',
      'KOMINE CO., LTD.',
      'michael.chang@komine.example',
    ]),
  ]);

  assert.equal(result.firstName.value, 'Michael');
  assert.equal(result.lastName.value, 'Chang');
  assert.equal(companyKey(result.company.value), companyKey('KOMINE CO., LTD.'));
});

test('P1 telefoni: un identificativo fiscale con zeri iniziali persi non rinasce come telefono', () => {
  const result = extractCardV5([
    page([
      'CHRISTIAN PEZZIN',
      'SCOUT s.r.l.',
      '+39 338 7861410',
      'tel. +39 051 3765570',
      'P. IVA IT00682671201',
      'C.F. 03964120376',
    ]),
  ]);

  assert.equal(result.vatNumber.value, '00682671201');
  assert.equal(result.taxCode.value, '03964120376');
  assert.deepEqual(phoneDigits(result), ['390513765570', '393387861410']);
  assert.equal(phoneDigits(result).includes('682671201'), false);
});

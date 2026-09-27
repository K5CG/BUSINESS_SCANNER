import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import type { BusinessCard } from '../types';
import type { EmailEvidenceMetadata } from '../lib/email-evidence';
import { pagesFromRawText } from '../lib/extraction-review';
import { parseCardFromPages } from '../lib/parser';
import {
  assessContactDuplicates,
  findContactDuplicate,
  normalizePhone,
  type DuplicateTier,
} from '../lib/duplicate-contacts-core';

let nextId = 0;

function emailEvidence(
  value: string,
  origin: 'observed' | 'repaired' | 'user' = 'observed',
  confirmed = origin !== 'repaired'
): EmailEvidenceMetadata {
  const repaired = origin === 'repaired';
  return {
    value: value.toLowerCase(),
    rawValue: value,
    repairedValue: repaired ? value.toLowerCase() : undefined,
    origin,
    pageIndex: 0,
    lineId: 0,
    rawOcr: value,
    transformations: repaired ? ['conservative_test_repair'] : [],
    confidence: repaired ? 0.65 : 0.96,
    validationStatus: 'valid',
    requiresReview: repaired && !confirmed,
    confirmed,
  };
}

function card(
  partial: Partial<BusinessCard> & Pick<BusinessCard, 'firstName' | 'lastName'>
): BusinessCard {
  nextId += 1;
  const emails = partial.emails ?? [];
  return {
    id: partial.id ?? `dedupe-${String(nextId).padStart(3, '0')}`,
    type: 'business_card',
    title: '',
    images: [],
    rawText: '',
    confidence: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    role: '',
    company: '',
    emails,
    emailEvidence:
      partial.emailEvidence ??
      emails.map((email) => emailEvidence(email, 'observed')),
    phones: [],
    ...partial,
  };
}

test('DEDUP-01 stesso contatto con azienda OCR differente', () => {
  const existing = card({
    firstName: 'Marta',
    lastName: 'Rinaldi',
    company: 'Northwind Robotics',
    emails: ['marta@northwind-robotics.test'],
  });
  const scan = card({
    firstName: 'Marta',
    lastName: 'Rinaldi',
    company: 'NORTHWlND ROBOTlCS',
    emails: ['marta@northwind-robotics.test'],
  });

  const match = findContactDuplicate(scan, [existing]);
  assert.equal(match?.tier, 'probable');
  assert.equal(match?.reason, 'email');
  assert.ok(match?.differentFields.includes('company'));
});

test('DEDUP-02 stesso contatto con nome leggermente differente', () => {
  const existing = card({
    firstName: 'Marina',
    lastName: 'Bellini',
    company: 'Orbit Systems',
    address: { city: 'Padova', country: 'Italia' },
  });
  const scan = card({
    firstName: 'Marína',
    lastName: 'Belllni',
    company: 'Orbit System',
    address: { city: 'Padova', country: 'Italia' },
  });

  const match = findContactDuplicate(scan, [existing]);
  assert.equal(match?.tier, 'possible');
  assert.ok(match?.signals.some((signal) => signal.kind === 'name_fuzzy'));
});

test('DEDUP-03 stessa email personale prevale su nome differente', () => {
  const existing = card({
    firstName: 'Alessandra',
    lastName: 'Conti',
    emails: ['a.conti@personal-domain.test'],
  });
  const scan = card({
    firstName: 'Alessandro',
    lastName: 'Conli',
    emails: ['a.conti@personal-domain.test'],
  });

  const match = findContactDuplicate(scan, [existing]);
  assert.equal(match?.tier, 'probable');
  assert.ok(match?.signals.some((signal) => signal.kind === 'email_same'));
});

test('DEDUP-04 stesso telefono prevale su azienda differente', () => {
  const existing = card({
    firstName: 'Paolo',
    lastName: 'Serra',
    company: 'Aster Consulting',
    phones: [{ number: '049 555 0182', type: 'work' }],
  });
  const scan = card({
    firstName: 'Paolo',
    lastName: 'Serra',
    company: 'Vega Consulting',
    phones: [{ number: '049-555-0182', type: 'work' }],
  });

  const match = findContactDuplicate(scan, [existing]);
  assert.equal(match?.tier, 'probable');
  assert.equal(match?.reason, 'phone');
});

test('DEDUP-05 stessa azienda ma persone differenti non è un match', () => {
  const existing = card({
    firstName: 'Luca',
    lastName: 'Ferri',
    company: 'Helix Engineering',
  });
  const colleague = card({
    firstName: 'Sara',
    lastName: 'Monti',
    company: 'Helix Engineering',
  });

  assert.equal(findContactDuplicate(colleague, [existing]), null);
});

test('DEDUP-06 colleghi con lo stesso dominio non sono duplicati', () => {
  const existing = card({
    firstName: 'Nadia',
    lastName: 'Sala',
    company: 'Blue Peak',
    emails: ['nadia@blue-peak.test'],
    website: 'https://blue-peak.test',
  });
  const colleague = card({
    firstName: 'Enrico',
    lastName: 'Villa',
    company: 'Blue Peak',
    emails: ['enrico@blue-peak.test'],
    website: 'www.blue-peak.test',
  });

  assert.equal(findContactDuplicate(colleague, [existing]), null);
});

test('DEDUP-07 fingerprint fronte/retro è indipendente dall’ordine', () => {
  const front = 'Giulia Neri\nMosaic Lab\n+39 02 555 0101';
  const back = 'Via delle Industrie 8\nMilano\nmosaic-lab.test';
  const existing = card({
    firstName: 'Giulia',
    lastName: 'Neri',
    pageExtractions: [
      {
        pageIndex: 0,
        imageUri: 'front-a.jpg',
        processingMethod: 'local',
        rawText: front,
        structuredFields: {},
        warnings: [],
        completed: true,
        requiresReview: false,
      },
      {
        pageIndex: 1,
        imageUri: 'back-a.jpg',
        processingMethod: 'local',
        rawText: back,
        structuredFields: {},
        warnings: [],
        completed: true,
        requiresReview: false,
      },
    ],
  });
  const repeated = card({
    firstName: 'Giulia',
    lastName: 'Neri',
    pageExtractions: [
      {
        pageIndex: 0,
        imageUri: 'back-b.jpg',
        processingMethod: 'local',
        rawText: back,
        structuredFields: {},
        warnings: [],
        completed: true,
        requiresReview: false,
      },
      {
        pageIndex: 1,
        imageUri: 'front-b.jpg',
        processingMethod: 'local',
        rawText: front,
        structuredFields: {},
        warnings: [],
        completed: true,
        requiresReview: false,
      },
    ],
  });

  const match = findContactDuplicate(repeated, [existing]);
  assert.equal(match?.tier, 'exact');
  assert.ok(
    match?.signals.some((signal) => signal.kind === 'page_fingerprint')
  );
});

test('DEDUP-08 record quasi vuoto seguito da scansione completa richiede un segnale forte', () => {
  const sparse = card({
    firstName: '',
    lastName: '',
    emails: ['scan@crescent-studio.test'],
  });
  const complete = card({
    firstName: 'Elena',
    lastName: 'Riva',
    company: 'Crescent Studio',
    emails: ['scan@crescent-studio.test'],
    phones: [{ number: '+39 347 555 0123', type: 'mobile' }],
    address: { city: 'Verona', country: 'Italia' },
  });

  assert.equal(findContactDuplicate(complete, [sparse])?.tier, 'probable');

  const weakSparse = card({
    firstName: '',
    lastName: '',
    company: 'Crescent Studio',
  });
  assert.equal(findContactDuplicate(complete, [weakSparse]), null);
});

test('DEDUP-09 email repaired confermata uguale a email observed resta probable', () => {
  const existing = card({
    firstName: 'Tania',
    lastName: 'Greco',
    company: 'Quartz Design',
    emails: ['tania@quartz-design.test'],
  });
  const scan = card({
    firstName: 'Tania',
    lastName: 'Greco',
    company: 'Quartz Design',
    emails: [],
    emailEvidence: [
      emailEvidence('tania@quartz-design.test', 'repaired', true),
    ],
  });

  const match = findContactDuplicate(scan, [existing]);
  assert.equal(match?.tier, 'probable');
  assert.ok(
    match?.signals.some(
      (signal) => signal.kind === 'email_repaired_observed'
    )
  );
});

test('DEDUP-09B email repaired pending non è un identificatore forte', () => {
  const existing = card({
    firstName: '',
    lastName: '',
    emails: ['pending@quartz-design.test'],
  });
  const scan = card({
    firstName: '',
    lastName: '',
    emails: [],
    emailEvidence: [
      emailEvidence('pending@quartz-design.test', 'repaired', false),
    ],
  });
  const namedExisting = card({
    firstName: 'Tania',
    lastName: 'Greco',
    company: 'Quartz Design',
    emails: ['pending@quartz-design.test'],
  });
  const namedPending = card({
    firstName: 'Tania',
    lastName: 'Greco',
    company: 'Quartz Design',
    emails: [],
    emailEvidence: [
      emailEvidence('pending@quartz-design.test', 'repaired', false),
    ],
  });

  assert.equal(findContactDuplicate(scan, [existing]), null);
  const corroborated = findContactDuplicate(namedPending, [namedExisting]);
  assert.equal(corroborated?.tier, 'possible');
  assert.equal(
    corroborated?.signals.some(
      (signal) => signal.kind === 'email_repaired_observed'
    ),
    false
  );
});

test('DEDUP-10 telefoni con formattazioni differenti coincidono', () => {
  const existing = card({
    firstName: 'Irene',
    lastName: 'Gallo',
    phones: [{ number: '348 555 01 99', type: 'mobile' }],
  });
  const scan = card({
    firstName: 'Irene',
    lastName: 'Gallo',
    phones: [{ number: '(348) 555-0199', type: 'mobile' }],
  });

  assert.equal(normalizePhone('348 555 01 99'), normalizePhone('(348) 555-0199'));
  assert.equal(findContactDuplicate(scan, [existing])?.tier, 'probable');
});

test('DEDUP-11 prefisso italiano +39, 0039 o assente è equivalente', () => {
  const existing = card({
    firstName: 'Fabio',
    lastName: 'Leoni',
    phones: [{ number: '+39 349 555 0177', type: 'mobile' }],
  });
  const scan = card({
    firstName: 'Fabio',
    lastName: 'Leoni',
    phones: [{ number: '0039 349 555 0177', type: 'mobile' }],
  });
  const national = card({
    firstName: 'Fabio',
    lastName: 'Leoni',
    phones: [{ number: '3495550177', type: 'mobile' }],
  });

  assert.equal(findContactDuplicate(scan, [existing])?.reason, 'phone');
  assert.equal(findContactDuplicate(national, [existing])?.reason, 'phone');
});

test('DEDUP-11B + e 00 sono equivalenti per prefissi internazionali non italiani', () => {
  assert.equal(
    normalizePhone('+92 333 8609110'),
    normalizePhone('0092 333 8609110')
  );
  assert.equal(
    normalizePhone('+1 617 358 2158'),
    normalizePhone('001 617 358 2158')
  );
});

test('DEDUP-11C forma internazionale e nazionale richiedono corroborazione indipendente', () => {
  const international = card({
    firstName: 'Asim',
    lastName: 'Nayyer',
    company: 'Atrox',
    phones: [{ number: '+92 333 8609110', type: 'mobile' }],
  });
  const national = card({
    firstName: 'Asim',
    lastName: 'Nayyer',
    company: 'Atrox',
    phones: [{ number: '0333 8609110', type: 'mobile' }],
  });
  const uncorroboratedInternational = card({
    firstName: '',
    lastName: '',
    phones: [{ number: '+92 333 8609110', type: 'mobile' }],
  });
  const uncorroboratedNational = card({
    firstName: '',
    lastName: '',
    phones: [{ number: '0333 8609110', type: 'mobile' }],
  });

  const match = findContactDuplicate(national, [international]);
  assert.equal(match?.tier, 'probable');
  assert.ok(
    match?.signals.some((signal) => signal.kind === 'phone_ocr_compatible')
  );
  assert.equal(
    findContactDuplicate(
      uncorroboratedNational,
      [uncorroboratedInternational]
    ),
    null
  );
});

test('DEDUP-12 segnali medi producono un possibile duplicato', () => {
  const existing = card({
    firstName: 'Riccardo',
    lastName: 'Moretti',
    company: 'Vector Analytics',
    address: {
      street: 'Via Aurora 12',
      city: 'Bologna',
      country: 'Italia',
    },
  });
  const scan = card({
    firstName: 'Riccardo',
    lastName: 'Moretli',
    company: 'Vector Analytlcs',
    address: {
      street: 'Via Aurora 12',
      city: 'Bologna',
      country: 'Italia',
    },
  });

  const match = findContactDuplicate(scan, [existing]);
  assert.equal(match?.tier, 'possible');
  assert.ok((match?.score ?? 0) >= 28);
  assert.ok((match?.reasons.length ?? 0) >= 2);
});

test('DEDUP-13 duplicato esatto e ordinamento di tutti i candidati', () => {
  const exact = card({
    id: 'candidate-a',
    firstName: 'Silvia',
    lastName: 'Fontana',
    company: 'Nova Instruments',
    emails: ['silvia@nova-instruments.test'],
    phones: [{ number: '+39 333 555 0162', type: 'mobile' }],
    vatNumber: '12345678903',
  });
  const probable = card({
    id: 'candidate-b',
    firstName: 'Silvia',
    lastName: 'Fontana',
    company: 'Nova lnstruments',
    emails: ['silvia@nova-instruments.test'],
  });
  const scan = card({
    firstName: 'Silvia',
    lastName: 'Fontana',
    company: 'Nova Instruments',
    emails: ['silvia@nova-instruments.test'],
    phones: [{ number: '3335550162', type: 'mobile' }],
    vatNumber: 'IT12345678903',
  });

  const matches = assessContactDuplicates(scan, [probable, exact]);
  assert.deepEqual(
    matches.map((match) => match.contact.id),
    ['candidate-a', 'candidate-b']
  );
  assert.equal(matches[0]?.tier, 'exact');
  assert.ok(
    matches[0]?.signals.some((signal) => signal.kind === 'tax_id_same')
  );
  assert.ok(matches[0]?.equalFields.includes('emails'));
  assert.ok(matches[0]?.equalFields.includes('phones'));
});

test('DEDUP-14 contatti differenti non producono candidati', () => {
  const existing = card({
    firstName: 'Diego',
    lastName: 'Pace',
    company: 'Alpine Foods',
    website: 'alpine-foods.test',
    address: { country: 'Italia' },
  });
  const unrelated = card({
    firstName: 'Monica',
    lastName: 'Rossi',
    company: 'Harbor Textiles',
    website: 'harbor-textiles.test',
    address: { country: 'Italia' },
  });

  assert.deepEqual(assessContactDuplicates(unrelated, [existing]), []);
});

test('DEDUP-15 colleghi distinti con cognome lungo e stesso sito non sono duplicati', () => {
  const existing = card({
    firstName: 'Anna',
    lastName: 'Kowalski Van Helsing',
    company: 'Shared Company',
    emails: ['anna@shared-company.example'],
    website: 'https://shared-company.example',
  });
  const colleague = card({
    firstName: 'Bob',
    lastName: 'Kowalski Van Helsing',
    company: 'Shared Company',
    emails: ['bob@shared-company.example'],
    website: 'https://shared-company.example',
  });

  assert.equal(findContactDuplicate(colleague, [existing]), null);
});

test('DEDUP-16 dominio derivato da email non diventa un segnale forte', () => {
  const existing = card({
    firstName: 'Noor',
    lastName: 'Hassan',
    emails: ['noor.one@unlisted-mail-provider.example'],
  });
  const scan = card({
    firstName: 'Noor',
    lastName: 'Hassan',
    emails: ['noor.onf@unlisted-mail-provider.example'],
  });
  const closeNameExisting = card({
    firstName: 'Marco',
    lastName: 'Rossi',
    emails: ['marco@shared-domain.example'],
  });
  const closeNameColleague = card({
    firstName: 'Mario',
    lastName: 'Rossi',
    emails: ['mario@shared-domain.example'],
  });

  const match = findContactDuplicate(scan, [existing]);
  assert.equal(match?.tier, 'possible');
  assert.equal(
    match?.signals.some((signal) => signal.kind === 'domain_person'),
    false
  );
  assert.equal(
    match?.signals.some((signal) => signal.strength === 'strong'),
    false
  );
  assert.equal(
    findContactDuplicate(closeNameColleague, [closeNameExisting]),
    null
  );
});

test('DEDUP-17 email OCR compatibile richiede nome e organizzazione indipendenti', () => {
  const existing = card({
    firstName: 'Marta',
    lastName: 'Rinaldi',
    company: 'Acme Robotics',
    emails: ['marta.rinaldi@acme.example'],
  });
  const corroborated = card({
    firstName: 'Marta',
    lastName: 'Rinaldi',
    company: 'Acme Robotics',
    emails: ['marta.rinaldi@acne.example'],
  });
  const isolatedExisting = card({
    firstName: '',
    lastName: '',
    emails: ['isolated@acme.example'],
  });
  const isolatedOcr = card({
    firstName: '',
    lastName: '',
    emails: ['isolatecl@acme.example'],
  });

  const match = findContactDuplicate(corroborated, [existing]);
  assert.equal(match?.tier, 'probable');
  assert.ok(
    match?.signals.some((signal) => signal.kind === 'email_ocr_compatible')
  );
  assert.equal(findContactDuplicate(isolatedOcr, [isolatedExisting]), null);
});

test('DEDUP-18 telefono con una cifra OCR diversa richiede corroborazione indipendente', () => {
  const existing = card({
    firstName: 'Katie',
    lastName: 'Pasciucco',
    company: 'Boston University',
    phones: [{ number: '617-358-2158', type: 'work' }],
  });
  const corroborated = card({
    firstName: 'Katie',
    lastName: 'Pasciucco',
    company: 'Boston University',
    phones: [{ number: '617-358-2153', type: 'work' }],
  });
  const isolatedExisting = card({
    firstName: '',
    lastName: '',
    phones: [{ number: '617-358-2158', type: 'work' }],
  });
  const isolatedOcr = card({
    firstName: '',
    lastName: '',
    phones: [{ number: '617-358-2153', type: 'work' }],
  });

  const match = findContactDuplicate(corroborated, [existing]);
  assert.equal(match?.tier, 'probable');
  assert.ok(
    match?.signals.some((signal) => signal.kind === 'phone_ocr_compatible')
  );
  assert.equal(findContactDuplicate(isolatedOcr, [isolatedExisting]), null);
});

test('DEDUP-19 fiscal ID confronta VAT/tax cross-field senza usare VAT come persona', () => {
  const vatCard = card({
    firstName: 'Luca',
    lastName: 'Ferri',
    company: 'Helix Engineering',
    vatNumber: '12345678903',
  });
  const taxFieldCard = card({
    firstName: 'Luca',
    lastName: 'Ferri',
    company: 'Helix Engineering',
    taxCode: 'IT12345678903',
  });
  const colleague = card({
    firstName: 'Sara',
    lastName: 'Monti',
    company: 'Helix Engineering',
    vatNumber: 'IT12345678903',
  });

  const crossField = findContactDuplicate(taxFieldCard, [vatCard]);
  const taxSignal = crossField?.signals.find(
    (signal) => signal.kind === 'tax_id_same'
  );
  assert.equal(crossField?.tier, 'possible');
  assert.equal(taxSignal?.strength, 'medium');
  assert.equal(findContactDuplicate(colleague, [vatCard]), null);
});

test('DEDUP-20 codice fiscale personale resta un identificatore forte', () => {
  const existing = card({
    firstName: 'Mario',
    lastName: 'Rossi',
    taxCode: 'RSSMRA85T10A562S',
  });
  const scan = card({
    firstName: 'Marlo',
    lastName: 'Rossi',
    taxCode: 'RSSMRA85T10A562S',
  });

  const match = findContactDuplicate(scan, [existing]);
  assert.equal(match?.tier, 'probable');
  assert.equal(
    match?.signals.find((signal) => signal.kind === 'tax_id_same')?.strength,
    'strong'
  );
});

test('DEDUP-21 fingerprint OCR non prevale su una identità incompatibile', () => {
  const rawFingerprint = [
    'Lara Bianchi',
    'Alpha Robotics',
    '+39 333 555 0123',
    'Via Roma 10 Milano',
  ].join('\n');
  const exact = card({
    id: 'candidate-exact',
    firstName: 'Persona',
    lastName: 'Diversa',
    rawText: rawFingerprint,
  });
  const probable = card({
    id: 'candidate-probable',
    firstName: 'Lara',
    lastName: 'Bianchi',
    company: 'Alpha Robotlcs',
    emails: ['lara@alpha.example'],
  });
  const scan = card({
    firstName: 'Lara',
    lastName: 'Bianchi',
    company: 'Alpha Robotics',
    emails: ['lara@alpha.example'],
    rawText: rawFingerprint,
  });

  const matches = assessContactDuplicates(scan, [probable, exact]);
  assert.equal(matches[0]?.contact.id, 'candidate-probable');
  assert.equal(matches[0]?.tier, 'probable');
  assert.equal(
    matches.some((match) => match.contact.id === 'candidate-exact'),
    false
  );
});

test('DEDUP-REAL due scansioni imperfette equivalenti usano solo segnali universali', () => {
  const firstScan = card({
    firstName: 'Michele',
    lastName: 'Randon',
    company: 'Ironwood Components',
    phones: [{ number: '+39 0444 555 884', type: 'work' }],
    website: 'https://ironwood-components.test',
    address: { city: 'Vicenza', country: 'Italia' },
  });
  const secondScan = card({
    firstName: 'MicheIe',
    lastName: 'Randon',
    company: 'lronwood Cornponents',
    phones: [{ number: '0444/555884', type: 'work' }],
    website: 'www.ironwood-components.test',
    address: { city: 'Vicenza', country: 'Italia' },
  });

  const match = findContactDuplicate(secondScan, [firstScan]);
  assert.ok(match);
  assert.equal(match.tier, 'probable');
  assert.equal(match.reason, 'phone');
  assert.ok(match.signals.some((signal) => signal.kind === 'phone_same'));
  assert.ok(match.differentFields.includes('name'));
  assert.ok(match.differentFields.includes('company'));
});

interface RealExpectedFields {
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  company: string | null;
  emails: string[];
  phones: Array<{
    number: string;
    type?: 'mobile' | 'work' | 'fax' | 'other';
  }>;
  websites: string[];
  addresses: Array<{ kind: string; full: string }>;
  vatNumber: string | null;
  taxCode: string | null;
}

interface RealExpectedDocument {
  cases: Array<{
    caseId: string;
    sourceContactId: string;
    fields: RealExpectedFields;
    verification: {
      status: string;
    };
  }>;
}

interface RealDuplicateGroupsDocument {
  groups: Array<{
    groupId: string;
    relationship: string;
    caseIds: string[];
    expectedDuplicateLevel: DuplicateTier;
  }>;
}

interface RealCasesDocument {
  cases: Array<{
    caseId: string;
    sourceContactId: string;
    rawTextFile: string | null;
    rawTextAvailability: string;
  }>;
}

interface RealSourceContactsDocument extends Array<{
  id: string;
  rawText: string;
}> {}

function readRealDatasetJson<T>(filename: string): T {
  const path = join(
    process.cwd(),
    'test-data',
    'real-device-cards-2026-07-31',
    filename
  );
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function cardFromVerifiedExpectedCase(
  expectedCase: RealExpectedDocument['cases'][number]
): BusinessCard {
  const fields = expectedCase.fields;
  return card({
    id: `real-${expectedCase.caseId}`,
    firstName: fields.firstName ?? '',
    lastName: fields.lastName ?? '',
    role: fields.role ?? '',
    company: fields.company ?? '',
    emails: fields.emails,
    emailEvidence: fields.emails.map((email) =>
      emailEvidence(email, 'user')
    ),
    phones: fields.phones.map((phone) => ({ ...phone })),
    website: fields.websites[0],
    address: fields.addresses[0]
      ? { full: fields.addresses[0].full }
      : undefined,
    vatNumber: fields.vatNumber ?? undefined,
    taxCode: fields.taxCode ?? undefined,
    // Solo case-016 usa i field verificati: il raw OCR manca dall'export.
    images: [],
    rawText: '',
  });
}

test('DEDUP-DATASET case-016 verified e replay raw case-027 rispettano il livello atteso', () => {
  const duplicateDocument =
    readRealDatasetJson<RealDuplicateGroupsDocument>('duplicate-groups.json');
  const expectedDocument =
    readRealDatasetJson<RealExpectedDocument>('expected.json');
  const casesDocument =
    readRealDatasetJson<RealCasesDocument>('cases.json');
  const sourceContacts =
    readRealDatasetJson<RealSourceContactsDocument>('source/contacts.json');
  const group = duplicateDocument.groups.find(
    (item) =>
      item.relationship === 'same_physical_card_rescan' &&
      item.caseIds.includes('case-016') &&
      item.caseIds.includes('case-027')
  );
  assert.ok(group, 'la relazione canonica case-016/case-027 deve restare coperta');

  const case016 = casesDocument.cases.find(
    (item) => item.caseId === 'case-016'
  );
  const case027 = casesDocument.cases.find(
    (item) => item.caseId === 'case-027'
  );
  assert.ok(case016);
  assert.ok(case027);
  assert.equal(case016.rawTextFile, null);
  assert.equal(case016.rawTextAvailability, 'missing_from_export');
  const source016 = sourceContacts.find(
    (item) => item.id === case016.sourceContactId
  );
  assert.ok(source016);
  assert.equal(
    source016.rawText,
    '',
    'case-016 è esplicitamente non rigiocabile: il source OCR è vuoto'
  );

  const expected016 = expectedDocument.cases.find(
    (item) => item.caseId === 'case-016'
  );
  assert.ok(expected016);
  assert.equal(expected016.verification.status, 'verified_from_images');
  const verified016 = cardFromVerifiedExpectedCase(expected016);

  assert.ok(case027.rawTextFile);
  const raw027Path = join(
    process.cwd(),
    'test-data',
    'real-device-cards-2026-07-31',
    'source',
    case027.rawTextFile
  );
  const raw027 = readFileSync(raw027Path, 'utf8');
  assert.ok(raw027.trim());
  const replayed027 = card({
    ...parseCardFromPages(pagesFromRawText(raw027)),
    id: 'real-replay-case-027',
    images: [],
  });
  assert.equal(replayed027.rawText, raw027.trim());

  const match = findContactDuplicate(replayed027, [verified016]);
  assert.ok(match, `${group.groupId}: case-016 / replay case-027 non rilevato`);
  assert.equal(
    match.tier,
    group.expectedDuplicateLevel,
    `${group.groupId}: livello inatteso per case-016 / replay case-027`
  );
});

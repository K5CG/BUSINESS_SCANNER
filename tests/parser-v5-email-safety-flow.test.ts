import assert from 'node:assert/strict';
import test from 'node:test';
import type { BusinessCard, OcrLine } from '../types';
import {
  actionableEmailValues,
  applyManualEmailEdit,
  getSafeContactEmails,
  mergeReparsedEmailState,
  sanitizeBusinessCardEmailState,
  unconfirmedEmailSuggestions,
  type EmailEvidenceMetadata,
} from '../lib/email-evidence';
import {
  extractCardV5,
  type CardPageV5,
} from '../lib/parser-v5/engine';
import { parseCardFromPagesV5 } from '../lib/parser-v5';
import {
  exportToCsv,
  exportToJson,
  exportToPlainText,
  exportToVCard,
} from '../lib/export';

function ocrLine(text: string, index: number, confidence = 0.9): OcrLine {
  return {
    text,
    confidence,
    boundingBox: {
      x: 4,
      y: index * 24,
      width: Math.max(80, text.length * 7),
      height: 20,
    },
  };
}

function page(lines: readonly string[]): CardPageV5 {
  return {
    rawText: lines.join('\n'),
    lines: lines.map((line, index) => ocrLine(line, index)),
  };
}

function evidence(
  value: string,
  origin: EmailEvidenceMetadata['origin'],
  overrides: Partial<EmailEvidenceMetadata> = {}
): EmailEvidenceMetadata {
  const observedOrUser = origin === 'observed' || origin === 'user';
  return {
    value,
    rawValue: value,
    repairedValue: origin === 'repaired' ? value : undefined,
    origin,
    pageIndex: observedOrUser ? 0 : null,
    lineId: observedOrUser ? 1 : null,
    rawOcr: value,
    transformations: [],
    confidence: origin === 'user' ? 1 : observedOrUser ? 0.9 : 0.4,
    validationStatus: 'valid',
    requiresReview: !observedOrUser,
    confirmed: observedOrUser,
    ...overrides,
  };
}

function card(
  emails: string[],
  emailEvidence?: EmailEvidenceMetadata[]
): BusinessCard {
  const now = new Date('2026-07-25T10:00:00.000Z');
  return {
    id: 'phase3b-card',
    type: 'business_card',
    title: 'ACME - Mario Rossi',
    images: [],
    rawText: '',
    confidence: {},
    createdAt: now,
    updatedAt: now,
    firstName: 'Mario',
    lastName: 'Rossi',
    role: 'Sales Manager',
    company: 'ACME S.r.l.',
    emails,
    emailEvidence,
    phones: [],
  };
}

const PRIMARY_LINES = [
  'ALPHA ISOLATION S.R.L.',
  'Mario Rossi',
  'Direttore Commerciale',
  'mario.rossi@alpha-isolation.it',
  'www.alpha-isolation.it',
  'P.IVA 12345678901',
  'Tel: +39 02 1234 5678',
  'Via Roma 10',
  '20100 Milano (MI)',
];

const FOREIGN_LINES = [
  'OMEGA SENTINEL S.R.L.',
  'Giulia Bianchi',
  'Chief Executive Officer',
  'giulia.bianchi@omega-sentinel.com',
  'www.omega-sentinel.com',
];

test('3B-09 solo nome e dominio non costruiscono una email', () => {
  const result = extractCardV5([
    page(['Mario Rossi', 'ACME S.R.L.', 'acme.it']),
  ]);

  assert.deepEqual(result.emails.value, []);
  assert.deepEqual(result.emailEvidence, []);
});

test('3B-10 nome, cognome e sito senza email restano senza email', () => {
  const result = extractCardV5([
    page(['Mario Rossi', 'ACME S.R.L.', 'www.acme.it']),
  ]);

  assert.deepEqual(result.emails.value, []);
  assert.deepEqual(result.emailEvidence, []);
});

test('3B-11 altra email aziendale osservata non genera il pattern personale', () => {
  const result = extractCardV5([
    page([
      'Mario Rossi',
      'ACME S.R.L.',
      'info@acme.it',
      'www.acme.it',
    ]),
  ]);

  assert.deepEqual(result.emails.value, ['info@acme.it']);
  assert.deepEqual(
    result.emailEvidence.map((item) => item.value),
    ['info@acme.it']
  );
  assert.ok(
    result.emailEvidence.every((item) => item.origin === 'observed')
  );
  assert.ok(
    !JSON.stringify(result).toLowerCase().includes('mario.rossi@acme.it')
  );
});

test('3B-15 email della pagina esclusa non entra in valori o provenance', () => {
  const result = extractCardV5([page(PRIMARY_LINES), page(FOREIGN_LINES)]);

  assert.equal(result.pageCoherence.decision, 'mismatch');
  assert.deepEqual(result.pageCoherence.includedPageIndexes, [0]);
  assert.deepEqual(result.pageCoherence.excludedPageIndexes, [1]);
  assert.deepEqual(result.emails.value, [
    'mario.rossi@alpha-isolation.it',
  ]);
  assert.ok(result.emailEvidence.every((item) => item.pageIndex === 0));
  assert.ok(
    !JSON.stringify(result.emailEvidence).includes(
      'giulia.bianchi@omega-sentinel.com'
    )
  );
});

test('3B-16 email di un’altra persona non crea un contatto ibrido', () => {
  const result = extractCardV5([page(PRIMARY_LINES), page(FOREIGN_LINES)]);
  const selectedPerson = `${result.firstName.value ?? ''} ${
    result.lastName.value ?? ''
  }`.trim();
  const selectedEmails = result.emails.value ?? [];

  assert.match(selectedPerson, /Mario Rossi/i);
  assert.deepEqual(selectedEmails, [
    'mario.rossi@alpha-isolation.it',
  ]);
  assert.ok(!selectedEmails.includes('giulia.bianchi@omega-sentinel.com'));
});

test('3B-17 fronte e retro coerenti conservano email osservata e origine', () => {
  const result = extractCardV5([
    page([
      'ALPHA ISOLATION S.R.L.',
      'Mario Rossi',
      'mario.rossi@alpha-isolation.it',
    ]),
    page([
      'ALPHA ISOLATION S.R.L.',
      'www.alpha-isolation.it',
      'Tel: +39 02 1234 5678',
      'Via Roma 10, 20100 Milano (MI)',
    ]),
  ]);

  assert.equal(result.pageCoherence.decision, 'match');
  assert.deepEqual(result.pageCoherence.includedPageIndexes, [0, 1]);
  assert.deepEqual(result.emails.value, [
    'mario.rossi@alpha-isolation.it',
  ]);
  assert.equal(result.emailEvidence[0]?.origin, 'observed');
  assert.equal(result.emailEvidence[0]?.pageIndex, 0);
  assert.equal(result.emailEvidence[0]?.confirmed, true);
});

test('3B-18 due colleghi della stessa azienda non condividono email', () => {
  const contacts = [
    {
      name: 'Mario Rossi',
      email: 'mario.rossi@alpha.example',
    },
    {
      name: 'Giulia Bianchi',
      email: 'giulia.bianchi@alpha.example',
    },
  ];
  const result = extractCardV5(
    contacts.map((contact) =>
      page([
        'ALPHA S.R.L.',
        contact.name,
        contact.email,
        'P.IVA 12345678903',
      ])
    )
  );

  assert.equal(result.pageCoherence.decision, 'mismatch');
  assert.equal(result.pageCoherence.includedPageIndexes.length, 1);
  assert.equal(result.pageCoherence.excludedPageIndexes.length, 1);
  const kept = contacts[result.pageCoherence.includedPageIndexes[0]!]!;
  const excluded = contacts[result.pageCoherence.excludedPageIndexes[0]!]!;
  assert.deepEqual(result.emails.value, [kept.email]);
  assert.ok(!result.emails.value?.includes(excluded.email));
  assert.ok(
    result.emailEvidence.every(
      (item) => item.pageIndex === result.pageCoherence.includedPageIndexes[0]
    )
  );
});

test('3B-21 email inferred è disabilitata nel risultato salvabile', () => {
  const pages = [
    page([
      'EOS GROUP',
      'DARIO FACCHINI',
      'Marketing Manager',
      'focchinioeosbio.com',
      'www.eosbio.com',
    ]),
  ];
  const engine = extractCardV5(pages);
  const persisted = parseCardFromPagesV5(pages);

  assert.deepEqual(engine.emails.value, []);
  assert.deepEqual(engine.emailEvidence, []);
  assert.deepEqual(persisted.emails, []);
  assert.ok(
    !JSON.stringify(persisted).toLowerCase().includes(
      'facchini@eosbio.com'
    )
  );
});

test('3B-21b email legacy senza provenance resta suggerimento non operativo', () => {
  const legacy = card(['legacy.person@example.com']);

  assert.deepEqual(getSafeContactEmails(legacy), []);
  assert.doesNotMatch(
    exportToJson(legacy),
    /legacy\.person@example\.com/
  );

  const sanitized = sanitizeBusinessCardEmailState(legacy);
  assert.deepEqual(sanitized.emails, []);
  assert.equal(sanitized.emailEvidence?.[0]?.origin, 'inferred');
  assert.equal(
    sanitized.emailEvidence?.[0]?.validationStatus,
    'unverified'
  );
  assert.equal(sanitized.emailEvidence?.[0]?.requiresReview, true);
  assert.equal(sanitized.emailEvidence?.[0]?.confirmed, false);
  assert.deepEqual(
    sanitized.emailEvidence?.[0]?.transformations,
    ['legacy_provenance_unknown']
  );
  assert.deepEqual(
    unconfirmedEmailSuggestions(sanitized.emailEvidence).map(
      (item) => item.value
    ),
    ['legacy.person@example.com']
  );

  const reparsed = mergeReparsedEmailState(legacy, card([], []));
  assert.deepEqual(reparsed.emails, []);
  assert.equal(reparsed.emailEvidence?.[0]?.value, 'legacy.person@example.com');
  assert.equal(reparsed.emailEvidence?.[0]?.validationStatus, 'unverified');
});

test('3B-24 modifica manuale promuove email a USER confermata', () => {
  const repaired = evidence('mario.rossi@example.com', 'repaired', {
    rawValue: 'mario.rossi @ example.com',
    rawOcr: 'mario.rossi @ example.com',
    transformations: ['remove_spaces_around_at'],
  });
  const original = card(['mario.rossi@example.com'], [repaired]);
  const edited = applyManualEmailEdit(original, [
    ' Mario.Rossi@Example.COM ',
  ]);

  assert.deepEqual(edited.emails, ['Mario.Rossi@Example.COM']);
  assert.equal(
    edited.emailEvidence?.[0]?.value,
    'mario.rossi@example.com'
  );
  assert.equal(edited.emailEvidence?.[0]?.origin, 'user');
  assert.equal(edited.emailEvidence?.[0]?.confirmed, true);
  assert.equal(edited.emailEvidence?.[0]?.requiresReview, false);
  assert.ok(
    edited.emailEvidence?.[0]?.transformations.includes('user_confirmed')
  );
  assert.deepEqual(getSafeContactEmails(edited), [
    'mario.rossi@example.com',
  ]);
  assert.equal(edited.confidence.emails, 1);
  assert.equal(edited.title, original.title);
});

test('3B-25 export filtrato non contiene email inferred o repaired non confermate', () => {
  const observedValue = 'observed@example.com';
  const repairedValue = 'repaired@example.com';
  const inferredValue = 'inferred@example.com';
  const unsafeCard = card(
    [observedValue, repairedValue, inferredValue],
    [
      evidence(observedValue, 'observed'),
      evidence(observedValue, 'inferred'),
      evidence(repairedValue, 'repaired'),
      evidence(inferredValue, 'inferred'),
    ]
  );
  const safeCard = sanitizeBusinessCardEmailState(unsafeCard);
  const exports = [
    exportToPlainText(unsafeCard),
    exportToVCard(unsafeCard),
    exportToCsv(unsafeCard),
    exportToJson(unsafeCard),
  ];

  assert.deepEqual(safeCard.emails, [observedValue]);
  assert.equal(safeCard.confidence.emails, 0.9);
  for (const output of exports) {
    assert.match(output, /observed@example\.com/i);
    assert.doesNotMatch(output, /repaired@example\.com/i);
    assert.doesNotMatch(output, /inferred@example\.com/i);
  }
  const json = exportToJson(unsafeCard);
  assert.match(json, /"origin": "observed"/);
  assert.doesNotMatch(json, /"origin": "inferred"/);
  assert.doesNotMatch(json, /"origin": "repaired"/);
});

test('3B-26 invio email non è disponibile per inferred o repaired non confermate', () => {
  const repaired = evidence('repaired@example.com', 'repaired');
  const inferred = evidence('inferred@example.com', 'inferred');
  const unsafeCard = card(
    ['repaired@example.com', 'inferred@example.com'],
    [repaired, inferred]
  );

  assert.deepEqual(actionableEmailValues([repaired, inferred]), []);
  assert.deepEqual(getSafeContactEmails(unsafeCard), []);
  assert.deepEqual(
    unconfirmedEmailSuggestions([repaired, inferred]).map(
      (item) => item.origin
    ),
    ['repaired', 'inferred']
  );
});

test('3B-28 flusso parser conserva email osservata con score OCR non fisso', () => {
  const result = extractCardV5([
    page([
      'ECO-SABBIATURA S.n.c.',
      'Erik Rizzo',
      'info@ecosabbiatura.it',
      'www.ecosabbiatura.it',
    ]),
  ]);

  assert.deepEqual(result.emails.value, ['info@ecosabbiatura.it']);
  assert.equal(result.emailEvidence[0]?.origin, 'observed');
  assert.equal(result.emailEvidence[0]?.rawOcr, 'info@ecosabbiatura.it');
  assert.ok((result.emails.score ?? 0) > 0);
  assert.notEqual(result.emails.score, 0.95);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BusinessCard } from '../types';
import type { BusinessCardExtractionResult } from '../lib/parser-engine/card-extraction-result';
import { buildCardTitle } from '../lib/card-title';
import {
  applyContactCandidatePreservingManual,
  applyContactReparseProposal,
  applyManualContactEdits,
  buildContactReviewModel,
  contactEmailDraftValues,
  createContactReparseProposal,
  ensureContactReviewState,
  initializeParsedContactReviewState,
  prepareBusinessCardForPersistence,
  redactContactReviewStateForExport,
  snapshotContactFields,
} from '../lib/contact-review-state';
import {
  applyManualEmailEdit,
  getSafeContactEmails,
  mergeReparsedEmailState,
  sanitizeBusinessCardEmailState,
  type EmailEvidenceMetadata,
  type EmailEvidenceOrigin,
} from '../lib/email-evidence';
import { diffReparseCard } from '../lib/reparse-diff';

const NOW = new Date('2026-07-25T10:00:00.000Z');

function rawCard(overrides: Partial<BusinessCard> = {}): BusinessCard {
  return {
    id: 'contact-5c',
    type: 'business_card',
    title: 'Acme - Mario Rossi',
    images: ['file:///card.jpg'],
    rawText: 'MARIO ROSSI\nACME\nmario@acme.it',
    confidence: {
      firstName: 0.9,
      lastName: 0.9,
      company: 0.9,
      role: 0.7,
      emails: 0.9,
      phones: 0.8,
    },
    createdAt: NOW,
    updatedAt: NOW,
    firstName: 'Mario',
    lastName: 'Rossi',
    role: 'Sales',
    company: 'Acme',
    emails: [],
    phones: [{ number: '+39 0123' }],
    ...overrides,
  };
}

function card(overrides: Partial<BusinessCard> = {}): BusinessCard {
  return initializeParsedContactReviewState(rawCard(overrides));
}

function candidate(
  current: BusinessCard,
  patch: Partial<BusinessCard>
): BusinessCard {
  const next = { ...current, ...patch };
  return {
    ...next,
    title: buildCardTitle(
      next.company,
      next.firstName,
      next.lastName
    ),
  };
}

function evidence(
  value: string,
  origin: EmailEvidenceOrigin,
  overrides: Partial<EmailEvidenceMetadata> = {}
): EmailEvidenceMetadata {
  return {
    value,
    rawValue: value,
    origin,
    pageIndex: 0,
    lineId: 0,
    rawOcr: value,
    transformations: [],
    confidence: origin === 'user' || origin === 'observed' ? 1 : 0.6,
    validationStatus: 'valid',
    requiresReview: origin === 'repaired' || origin === 'inferred',
    confirmed: origin === 'user' || origin === 'observed',
    ...overrides,
  };
}

function extractionReviewFor(
  source: BusinessCard,
  overrides: Partial<BusinessCardExtractionResult> = {}
): BusinessCardExtractionResult {
  const field = <T>(value: T | null) => ({
    value,
    confidence: 'high' as const,
    score: 1,
    source: 'ocr' as const,
    reasons: [],
  });
  return {
    firstName: field(source.firstName || null),
    lastName: field(source.lastName || null),
    company: field(source.company || null),
    role: field(source.role || null),
    emails: field([...source.emails]),
    phones: field(source.phones.map((phone) => ({ ...phone }))),
    website: field(source.website ?? null),
    address: field(source.address ? { ...source.address } : null),
    vatNumber: field(source.vatNumber ?? null),
    taxCode: field(source.taxCode ?? null),
    rawText: source.rawText,
    needsReview: false,
    reviewFields: [],
    ...overrides,
  };
}

test('5C-01 review senza modifiche distingue initial e current draft', () => {
  const original = card();
  const model = buildContactReviewModel(original);
  assert.deepEqual(model.parsedInitial, model.currentDraft);
  assert.deepEqual(model.manualOverrides, {});
  assert.equal(model.reparseProposal, null);
  assert.equal(model.appliedResult, null);
});

test('5C-02 modifica nome marca USER e ricalcola il titolo', () => {
  const edited = applyManualContactEdits(card(), {
    firstName: 'Luigi',
  });
  assert.equal(edited.firstName, 'Luigi');
  assert.equal(edited.title, 'Acme - Luigi Rossi');
  assert.equal(edited.contactReviewState?.fieldOrigins.firstName, 'user');
  assert.equal(
    edited.contactReviewState?.manualOverrides.firstName,
    'Luigi'
  );
});

test('5C-03 modifica cognome ricalcola il titolo', () => {
  const edited = applyManualContactEdits(card(), {
    lastName: 'Bianchi',
  });
  assert.equal(edited.title, 'Acme - Mario Bianchi');
  assert.equal(edited.contactReviewState?.fieldOrigins.lastName, 'user');
});

test('5C-04 modifica azienda ricalcola il titolo', () => {
  const edited = applyManualContactEdits(card(), {
    company: 'Beta',
  });
  assert.equal(edited.title, 'Beta - Mario Rossi');
  assert.equal(edited.contactReviewState?.fieldOrigins.company, 'user');
});

test('5C-05 modifica nome e azienda usa una sola regola titolo', () => {
  const edited = applyManualContactEdits(card(), {
    firstName: 'Anna',
    company: 'Beta',
  });
  assert.equal(edited.title, 'Beta - Anna Rossi');
});

test('5C-06 campo manuale protetto anche se il parser propone altro', () => {
  const edited = applyManualContactEdits(card(), {
    firstName: 'Manuale',
  });
  const proposal = createContactReparseProposal(
    edited,
    candidate(edited, { firstName: 'Parser' }),
    'parser-5c'
  );
  assert.equal(
    proposal.fields.find((item) => item.field === 'firstName')
      ?.protectedByManualOverride,
    true
  );
  const result = applyContactReparseProposal(edited, proposal, [
    'firstName',
  ]);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.appliedResult.firstName, 'Manuale');
});

test('5C-07 reparse esplicito crea una proposta senza mutare il draft', () => {
  const current = card();
  const before = JSON.stringify(current);
  const proposal = createContactReparseProposal(
    current,
    candidate(current, { company: 'Beta' }),
    'parser-5c'
  );
  assert.equal(JSON.stringify(current), before);
  assert.equal(proposal.fields.length, 1);
  assert.equal(proposal.fields[0]?.field, 'company');
});

test('5C-08 proposta reparse conserva candidato e base distinti', () => {
  const current = card();
  const proposal = createContactReparseProposal(
    current,
    candidate(current, { role: 'Director' }),
    'parser-5c'
  );
  assert.equal(current.role, 'Sales');
  assert.equal(proposal.candidate.role, 'Director');
  assert.equal(proposal.parserBuildId, 'parser-5c');
});

test('5C-09 annulla reparse lascia il draft byte-per-byte invariato', () => {
  const current = ensureContactReviewState(card());
  const before = JSON.stringify(current);
  createContactReparseProposal(
    current,
    candidate(current, { company: 'Beta' }),
    'parser-5c'
  );
  assert.equal(JSON.stringify(current), before);
});

test('5C-10 accetta un solo campo e conserva gli altri', () => {
  const current = card();
  const proposal = createContactReparseProposal(
    current,
    candidate(current, {
      company: 'Beta',
      role: 'Director',
    }),
    'parser-5c'
  );
  const result = applyContactReparseProposal(current, proposal, [
    'company',
  ]);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.appliedFields, ['company']);
  assert.equal(result.appliedResult.company, 'Beta');
  assert.equal(result.appliedResult.role, 'Sales');
});

test('5C-11 accetta piÃ¹ campi senza copiare quelli non scelti', () => {
  const current = card();
  const proposal = createContactReparseProposal(
    current,
    candidate(current, {
      firstName: 'Anna',
      company: 'Beta',
      role: 'Director',
    }),
    'parser-5c'
  );
  const result = applyContactReparseProposal(current, proposal, [
    'firstName',
    'company',
  ]);
  assert.deepEqual(result.appliedFields, ['firstName', 'company']);
  assert.equal(result.appliedResult.role, 'Sales');
  assert.equal(result.appliedResult.title, 'Beta - Anna Rossi');
});

test('5C-12 titolo Azienda - Persona', () => {
  assert.equal(buildCardTitle('Acme', 'Mario', 'Rossi'), 'Acme - Mario Rossi');
});

test('5C-13 titolo solo Azienda', () => {
  assert.equal(buildCardTitle('Acme', '', ''), 'Acme');
});

test('5C-14 titolo solo Persona', () => {
  assert.equal(buildCardTitle('', 'Mario', 'Rossi'), 'Mario Rossi');
});

test('5C-15 titolo manuale non viene sovrascritto', () => {
  const titled = applyManualContactEdits(card(), { title: 'Lead VIP' });
  const proposal = createContactReparseProposal(
    titled,
    candidate(titled, { company: 'Beta' }),
    'parser-5c'
  );
  const result = applyContactReparseProposal(titled, proposal, [
    'company',
  ]);
  assert.equal(result.appliedResult.company, 'Beta');
  assert.equal(result.appliedResult.title, 'Lead VIP');
  assert.equal(
    result.appliedResult.contactReviewState?.fieldOrigins.title,
    'user'
  );
});

test('5C-16 salvataggio e riapertura conserva stato review e override', () => {
  const edited = applyManualContactEdits(card(), {
    company: 'Beta',
    website: null,
  });
  const persisted = prepareBusinessCardForPersistence(edited);
  const reopened = JSON.parse(JSON.stringify(persisted)) as BusinessCard;
  assert.deepEqual(
    reopened.contactReviewState,
    persisted.contactReviewState
  );
  assert.equal(
    reopened.contactReviewState?.manualOverrides.website,
    null
  );
  assert.equal(reopened.title, 'Beta - Mario Rossi');
});

test('5C-17 provenance distingue parser, OCR, AI, utente e reparse', () => {
  const initial = ensureContactReviewState(card());
  assert.equal(initial.contactReviewState?.fieldOrigins.company, 'parser');

  const ocr = applyContactCandidatePreservingManual(
    initial,
    candidate(initial, { phones: [{ number: '+39 999' }] }),
    'ocr'
  ).appliedResult;
  assert.equal(ocr.contactReviewState?.fieldOrigins.phones, 'ocr');

  const ai = applyContactCandidatePreservingManual(
    initial,
    candidate(initial, { role: 'Director' }),
    'ai'
  ).appliedResult;
  assert.equal(ai.contactReviewState?.fieldOrigins.role, 'ai');

  const user = applyManualContactEdits(initial, { company: 'User Co' });
  assert.equal(user.contactReviewState?.fieldOrigins.company, 'user');

  const proposal = createContactReparseProposal(
    initial,
    candidate(initial, { company: 'Parsed Co' }),
    'parser-5c'
  );
  const reparsed = applyContactReparseProposal(initial, proposal, [
    'company',
  ]).appliedResult;
  assert.equal(
    reparsed.contactReviewState?.fieldOrigins.company,
    'reparse'
  );
});

test('5C-18 conflitto manuale-parser mantiene il valore utente', () => {
  const edited = applyManualContactEdits(card(), {
    company: 'Azienda Corretta',
    role: 'Ruolo Corretto',
  });
  const result = applyContactCandidatePreservingManual(
    edited,
    candidate(edited, {
      company: 'Parser Co',
      role: 'Parser Role',
    }),
    'reparse'
  );
  assert.equal(result.appliedResult.company, 'Azienda Corretta');
  assert.equal(result.appliedResult.role, 'Ruolo Corretto');
  assert.deepEqual(result.protectedFields.sort(), ['company', 'role']);
});

test('5C-19 la review non applica automaticamente il reparse', () => {
  const screen = readFileSync('app/document/[id].tsx', 'utf8');
  assert.doesNotMatch(screen, /reparseBusinessCard\(card\)/);
  assert.match(screen, /await buildBusinessCardReocrProposal\(card/);
  assert.match(screen, /ContactReparseProposalModal/);
  assert.match(screen, /applyBusinessCardReocrProposal/);
  assert.match(screen, /pendingReocr/);
});

test('5C-20 email repaired/inferred restano proposte e USER resta protetta', () => {
  const current = card({
    emailEvidence: [
      evidence('repair@example.com', 'repaired'),
      evidence('guess@example.com', 'inferred'),
    ],
  });
  const manualEmail = applyManualEmailEdit(
    ensureContactReviewState(current),
    ['user@example.com']
  );
  const manual = applyManualContactEdits(manualEmail, {
    emails: manualEmail.emails,
  });
  assert.deepEqual(
    manual.emailEvidence?.map((item) => item.origin),
    ['user', 'repaired', 'inferred']
  );
  assert.deepEqual(
    manual.contactReviewState?.parsedInitial.emails,
    []
  );

  const parsed = mergeReparsedEmailState(manual, {
    ...candidate(manual, { company: 'Beta' }),
    emails: [],
    emailEvidence: [
      evidence('new-repair@example.com', 'repaired'),
      evidence('new-guess@example.com', 'inferred'),
    ],
  });
  const merged = applyContactCandidatePreservingManual(
    manual,
    parsed,
    'reparse'
  ).appliedResult;
  assert.deepEqual(merged.emails, ['user@example.com']);
  assert.ok(
    merged.emailEvidence?.some(
      (item) => item.origin === 'user' && item.confirmed
    )
  );
  assert.ok(
    merged.emailEvidence?.some(
      (item) => item.origin === 'repaired' && !item.confirmed
    )
  );
  assert.ok(
    merged.emailEvidence?.some(
      (item) => item.origin === 'inferred' && !item.confirmed
    )
  );
  assert.ok(
    !merged.emailEvidence?.some(
      (item) =>
        item.value === 'new-repair@example.com' ||
        item.value === 'new-guess@example.com'
    )
  );
});

test('5C-21 cancellazione manuale vuota resta protetta', () => {
  const edited = applyManualContactEdits(card(), {
    phones: [],
    website: null,
  });
  const merged = applyContactCandidatePreservingManual(
    edited,
    candidate(edited, {
      phones: [{ number: '+39 888' }],
      website: 'example.com',
    }),
    'reparse'
  );
  assert.deepEqual(merged.appliedResult.phones, []);
  assert.equal(merged.appliedResult.website, undefined);
  assert.deepEqual(merged.protectedFields.sort(), ['phones', 'website']);
});

test('5C-22 proposta stale fallisce chiusa', () => {
  const current = card();
  const proposal = createContactReparseProposal(
    current,
    candidate(current, { company: 'Beta' }),
    'parser-5c'
  );
  const changedWhileOpen = applyManualContactEdits(current, {
    role: 'Changed',
  });
  const result = applyContactReparseProposal(
    changedWhileOpen,
    proposal,
    ['company']
  );
  assert.equal(result.status, 'stale');
  assert.equal(result.appliedResult.company, 'Acme');
});

test('5C-23 AI non sovrascrive i campi manuali', () => {
  const edited = applyManualContactEdits(card(), {
    company: 'Manual Co',
  });
  const result = applyContactCandidatePreservingManual(
    edited,
    candidate(edited, {
      company: 'AI Co',
      role: 'AI Role',
    }),
    'ai'
  );
  assert.equal(result.appliedResult.company, 'Manual Co');
  assert.equal(result.appliedResult.role, 'AI Role');
  assert.equal(
    result.appliedResult.contactReviewState?.fieldOrigins.role,
    'ai'
  );
});

test('5C-24 rotazione e bulk producono proposta/anteprima prima di applicare', () => {
  const reparse = readFileSync('lib/contact-reparse.ts', 'utf8');
  const rotationBody =
    reparse.match(
      /export async function reocrBusinessCardFromImages[\s\S]*?\n}\n\n\/\*\* Ruota/
    )?.[0] ?? '';
  assert.doesNotMatch(rotationBody, /parseCardFromPages\(/);
  assert.match(
    reparse,
    /card\.contactReviewState\.tracking !== 'parsed'/
  );

  const screen = readFileSync('app/document/[id].tsx', 'utf8');
  assert.match(
    screen,
    /const proposal = buildBusinessCardReparseProposal\(next\)/
  );

  const contacts = readFileSync('app/(tabs)/contacts.tsx', 'utf8');
  assert.match(contacts, /runPass\(true\)/);
  assert.match(contacts, /runPass\(false\)/);
  assert.match(contacts, /\{ dryRun \}/);
});

test('5C-ALT-01 alternative indirizzo persistono nel round-trip JSON', () => {
  const source = rawCard({
    address: { full: '10 Meridian Road, 20100 Milano' },
  });
  source.extractionReview = extractionReviewFor(source, {
    addressAlternatives: [
      { full: '77 Aurora Avenue, 00100 Roma' },
    ],
  });
  const persisted = prepareBusinessCardForPersistence(
    initializeParsedContactReviewState(source)
  );
  const reopened = JSON.parse(JSON.stringify(persisted)) as BusinessCard;

  assert.deepEqual(
    reopened.extractionReview?.addressAlternatives,
    [{ full: '77 Aurora Avenue, 00100 Roma' }]
  );
  assert.equal(reopened.notes, undefined);
});

test('5C-ALT-02 reparse aggiorna le alternative quando applica address', () => {
  const source = rawCard({
    address: { full: '10 Meridian Road, 20100 Milano' },
  });
  source.extractionReview = extractionReviewFor(source, {
    addressAlternatives: [
      { full: '77 Aurora Avenue, 00100 Roma' },
    ],
  });
  const current = initializeParsedContactReviewState(source);
  const reparsed = candidate(current, {
    extractionReview: extractionReviewFor(current, {
      addressAlternatives: [
        { full: '5 Horizon Road, 10100 Torino' },
      ],
    }),
  });

  const result = applyContactCandidatePreservingManual(
    current,
    reparsed,
    'reparse'
  );

  assert.deepEqual(result.appliedFields, ['address']);
  assert.deepEqual(
    result.appliedResult.extractionReview?.addressAlternatives,
    [{ full: '5 Horizon Road, 10100 Torino' }]
  );
});

test('5C-ALT-03 address manuale protegge anche le alternative correnti', () => {
  const source = rawCard({
    address: { full: '10 Meridian Road, 20100 Milano' },
  });
  source.extractionReview = extractionReviewFor(source, {
    addressAlternatives: [
      { full: '77 Aurora Avenue, 00100 Roma' },
    ],
  });
  const current = applyManualContactEdits(
    initializeParsedContactReviewState(source),
    { address: source.address }
  );
  const reparsed = candidate(current, {
    extractionReview: extractionReviewFor(current, {
      addressAlternatives: [
        { full: '5 Horizon Road, 10100 Torino' },
      ],
    }),
  });

  const result = applyContactCandidatePreservingManual(
    current,
    reparsed,
    'reparse'
  );

  assert.deepEqual(result.protectedFields, ['address']);
  assert.deepEqual(
    result.appliedResult.extractionReview?.addressAlternatives,
    [{ full: '77 Aurora Avenue, 00100 Roma' }]
  );
});

test('5C-25 persistenza e due API parser usano il titolo centralizzato', () => {
  const persistence = readFileSync('lib/persistence.ts', 'utf8');
  const parser = readFileSync('lib/parser.ts', 'utf8');
  const aiMerge = readFileSync(
    'lib/parser-engine/merge/ai-merge.ts',
    'utf8'
  );
  const extraction = readFileSync('lib/extraction-review.ts', 'utf8');
  assert.match(persistence, /prepareBusinessCardForPersistence/);
  assert.match(parser, /export \{ buildCardTitle \} from '\.\/card-title'/);
  assert.match(
    aiMerge,
    /export \{ buildCardTitle \} from '\.\.\/\.\.\/card-title'/
  );
  assert.match(extraction, /buildCardTitle\(/);
});

test('5C-26 emailEvidence undefined resta distinto da array vuoto', () => {
  const legacy = ensureContactReviewState(card({ emailEvidence: undefined }));
  const knownEmpty = ensureContactReviewState(card({ emailEvidence: [] }));
  assert.equal(legacy.emailEvidence, undefined);
  assert.deepEqual(knownEmpty.emailEvidence, []);
});

test('5C-27 snapshot iniziale non viene riscritto da AI o reparse', () => {
  const initial = ensureContactReviewState(card());
  const parsedInitial = initial.contactReviewState?.parsedInitial;
  const ai = applyContactCandidatePreservingManual(
    initial,
    candidate(initial, { company: 'AI Co' }),
    'ai'
  ).appliedResult;
  const proposal = createContactReparseProposal(
    ai,
    candidate(ai, { role: 'Reparsed' }),
    'parser-5c'
  );
  const reparsed = applyContactReparseProposal(ai, proposal, [
    'role',
  ]).appliedResult;
  assert.deepEqual(
    reparsed.contactReviewState?.parsedInitial,
    parsedInitial
  );
  assert.notDeepEqual(
    snapshotContactFields(reparsed),
    parsedInitial
  );
});

test('5C-28 applicazione parziale parte dal draft corrente e non dal candidato', () => {
  const base = card({
    notes: 'nota iniziale',
    images: ['file:///old.jpg'],
    contactPhotoUri: 'file:///old-face.jpg',
  });
  const proposal = createContactReparseProposal(
    base,
    candidate(base, {
      role: 'Director',
      notes: 'nota iniziale',
      images: ['file:///old.jpg'],
    }),
    'parser-5c'
  );
  const latest = {
    ...base,
    notes: 'nota aggiornata',
    images: ['file:///new.jpg'],
    contactPhotoUri: 'file:///new-face.jpg',
    rawText: 'OCR aggiornato senza cambiare i campi',
  };
  const result = applyContactReparseProposal(latest, proposal, ['role']);
  assert.equal(result.status, 'applied');
  assert.equal(result.appliedResult.role, 'Director');
  assert.equal(result.appliedResult.notes, 'nota aggiornata');
  assert.deepEqual(result.appliedResult.images, ['file:///new.jpg']);
  assert.equal(result.appliedResult.contactPhotoUri, 'file:///new-face.jpg');
  assert.equal(
    result.appliedResult.rawText,
    'OCR aggiornato senza cambiare i campi'
  );
});

test('5C-29 campo non selezionato conserva evidence USER e metadata correnti', () => {
  const baseWithReview = card();
  const currentReview = extractionReviewFor(baseWithReview, {
    role: {
      value: 'Sales',
      confidence: 'high',
      score: 0.95,
      source: 'user',
      reasons: ['valore corrente'],
    },
  });
  const withReview = { ...baseWithReview, extractionReview: currentReview };
  const emailEdited = applyManualEmailEdit(withReview, ['user@example.com']);
  const current = applyManualContactEdits(emailEdited, {
    emails: emailEdited.emails,
  });
  const candidateReview = extractionReviewFor(current, {
    company: {
      value: 'Beta',
      confidence: 'high',
      score: 0.9,
      source: 'ocr',
      reasons: ['nuova azienda'],
    },
    role: {
      value: 'Parser Role',
      confidence: 'low',
      score: 0.1,
      source: 'ocr',
      reasons: ['metadata candidato non selezionato'],
    },
  });
  const proposal = createContactReparseProposal(
    current,
    candidate(current, {
      company: 'Beta',
      emailEvidence: [],
      extractionReview: candidateReview,
    }),
    'parser-5c'
  );
  const result = applyContactReparseProposal(current, proposal, ['company']);
  assert.equal(result.appliedResult.company, 'Beta');
  assert.deepEqual(result.appliedResult.emails, ['user@example.com']);
  assert.ok(
    result.appliedResult.emailEvidence?.some(
      (item) => item.origin === 'user' && item.confirmed
    )
  );
  assert.equal(result.appliedResult.extractionReview?.company.value, 'Beta');
  assert.equal(result.appliedResult.extractionReview?.role.value, 'Sales');
  assert.equal(result.appliedResult.extractionReview?.role.source, 'user');
});

test('5C-30 record legacy resta conservativo anche dopo preparazione salvataggio', () => {
  const parsed = rawCard();
  const legacy = {
    ...parsed,
    company: 'Azienda corretta nel vecchio editor',
    extractionReview: extractionReviewFor(parsed),
  };
  const initialized = ensureContactReviewState(legacy);
  assert.equal(
    initialized.contactReviewState?.tracking,
    'legacy_conservative'
  );
  assert.equal(
    initialized.contactReviewState?.fieldOrigins.company,
    'user'
  );
  assert.equal(
    initialized.contactReviewState?.manualOverrides.company,
    'Azienda corretta nel vecchio editor'
  );
  const persisted = prepareBusinessCardForPersistence(initialized);
  assert.equal(
    persisted.contactReviewState?.tracking,
    'legacy_conservative'
  );
  const reparseSource = readFileSync('lib/contact-reparse.ts', 'utf8');
  assert.match(
    reparseSource,
    /contactReviewState\.tracking !== 'parsed'/
  );
});

test('5C-31 delta repaired-only genera proposta senza promozione automatica', () => {
  const current = card({ emails: [], emailEvidence: [] });
  const repaired = evidence('repair@example.com', 'repaired');
  const next = candidate(current, {
    emails: [],
    emailEvidence: [repaired],
  });
  const proposal = createContactReparseProposal(
    current,
    next,
    'parser-5c'
  );
  assert.deepEqual(proposal.fields.map((item) => item.field), ['emails']);
  assert.match(proposal.fields[0]?.currentDisplay ?? '', /^\u2014\n/);
  assert.match(proposal.fields[0]?.proposedDisplay ?? '', /repair@example\.com/);
  const result = applyContactReparseProposal(current, proposal, ['emails']);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.appliedResult.emails, []);
  assert.deepEqual(result.appliedResult.emailEvidence, [repaired]);
});

test('5C-32 delta inferred-only genera proposta e resta da confermare', () => {
  const current = card({ emails: [], emailEvidence: [] });
  const inferred = evidence('guess@example.com', 'inferred');
  const proposal = createContactReparseProposal(
    current,
    candidate(current, {
      emails: [],
      emailEvidence: [inferred],
    }),
    'parser-5c'
  );
  const result = applyContactReparseProposal(current, proposal, ['emails']);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.appliedResult.emails, []);
  assert.equal(result.appliedResult.emailEvidence?.[0]?.confirmed, false);
  assert.equal(result.appliedResult.emailEvidence?.[0]?.requiresReview, true);
});

test('5C-33 anteprima bulk include telefoni ed evidence email', () => {
  const before = card({ emails: [], emailEvidence: [], phones: [] });
  const after = candidate(before, {
    emailEvidence: [evidence('repair@example.com', 'repaired')],
    phones: [{ number: '+39 999', type: 'work' }],
  });
  const changes = diffReparseCard(before, after);
  assert.ok(changes.some((change) => change.field === 'emails'));
  assert.ok(changes.some((change) => change.field === 'phones'));
  assert.match(
    changes.find((change) => change.field === 'emails')?.after ?? '',
    /repair@example\.com/
  );
});

test('5C-34 override sullo stesso valore rende stale una proposta giÃ  aperta', () => {
  const current = card();
  const proposal = createContactReparseProposal(
    current,
    candidate(current, { company: 'Beta' }),
    'parser-5c'
  );
  const sameValueManualEdit = applyManualContactEdits(current, {
    role: current.role,
  });
  const result = applyContactReparseProposal(
    sameValueManualEdit,
    proposal,
    ['company']
  );
  assert.equal(result.status, 'stale');
  assert.equal(result.appliedResult.company, 'Acme');
});

test('5C-35 normalizzazione pre-save riallinea il valore manuale protetto', () => {
  const edited = applyManualContactEdits(card(), {
    address: { full: ' via roma 1 ' },
  });
  const normalized = prepareBusinessCardForPersistence({
    ...edited,
    address: { full: 'Via Roma 1' },
  });
  assert.deepEqual(normalized.contactReviewState?.manualOverrides.address, {
    full: 'Via Roma 1',
  });
});

test('5C-36 AI usa il cardRef piÃ¹ recente e la rotazione blocca gli editor', () => {
  const editor = readFileSync('components/BusinessCardEditor.tsx', 'utf8');
  assert.match(editor, /const latestCard = cardRef\.current/);
  assert.match(editor, /mergeAiCardFields\(latestCard, outcome\.fields\)/);
  assert.match(editor, /emitChange\(merged\.appliedResult\)/);

  const screen = readFileSync('app/document/[id].tsx', 'utf8');
  assert.match(
    screen,
    /editable=\{!imageRotationRunning && !saving\}/
  );
  assert.match(screen, /imageRotationRunningRef\.current/);
  assert.match(screen, /onRotationStateChange=/);

  const preview = readFileSync(
    'components/DocumentImagesPreview.tsx',
    'utf8'
  );
  assert.match(preview, /onRotationStateChange\?\.\(true\)/);
  assert.match(preview, /setViewerVisible\(false\)/);
  assert.match(preview, /afterViewerClose\?\.\(\)/);
});

test('5C-37 oggetto email preserva il titolo manuale persistito', () => {
  const exportSource = readFileSync('lib/export.ts', 'utf8');
  assert.match(exportSource, /const hasManualTitle =/);
  assert.match(exportSource, /if \(hasManualTitle\) return document\.title/);
  assert.match(exportSource, /return buildCardTitle\(/);
});

test('5C-38 Salva e Invia bloccano sincronicamente le modifiche al draft', () => {
  const screen = readFileSync('app/document/[id].tsx', 'utf8');
  const saveExportSection = screen.slice(
    screen.indexOf('const handleSave'),
    screen.indexOf('const handleDelete') > 0
      ? screen.indexOf('const handleDelete')
      : screen.length
  );
  const lockAssignments =
    saveExportSection.match(/persistenceRunningRef\.current = true/g) ?? [];
  assert.equal(lockAssignments.length, 2);
  assert.match(
    screen,
    /editable=\{!imageRotationRunning && !saving\}/
  );
  assert.match(
    screen,
    /imageRotationRunningRef\.current \|\|\s*persistenceRunningRef\.current/
  );
  assert.match(screen, /disabled=\{saving \|\| documentAiRunning\}/);
  const saveSection = screen.slice(
    screen.indexOf('const handleSave'),
    screen.indexOf('const handleExport')
  );
  const exportSection = screen.slice(
    screen.indexOf('const handleExport'),
    screen.indexOf('const handleReparse')
  );
  assert.match(saveSection, /businessEditorCancellationRef\.current\?\.\(\)/);
  assert.match(exportSection, /businessEditorCancellationRef\.current\?\.\(\)/);
});

test('5C-39 email USER non valida resta correggibile ma mai operativa', () => {
  const editedEmail = applyManualEmailEdit(card(), ['not-an-email']);
  const edited = applyManualContactEdits(editedEmail, {
    emails: editedEmail.emails,
  });
  assert.deepEqual(contactEmailDraftValues(edited), ['not-an-email']);
  const persisted = prepareBusinessCardForPersistence(
    sanitizeBusinessCardEmailState(edited)
  );
  assert.deepEqual(persisted.emails, []);
  assert.deepEqual(getSafeContactEmails(persisted), []);
  assert.deepEqual(contactEmailDraftValues(persisted), ['not-an-email']);
  const reopened = JSON.parse(JSON.stringify(persisted)) as BusinessCard;
  assert.deepEqual(contactEmailDraftValues(reopened), ['not-an-email']);
});

test('5C-40 export redige email non operative anche dagli snapshot 5C', () => {
  const legacy = rawCard({
    emails: ['legacy.person@example.com'],
    emailEvidence: undefined,
  });
  const touched = applyManualContactEdits(legacy, { company: 'Acme aggiornata' });
  const persisted = prepareBusinessCardForPersistence(
    sanitizeBusinessCardEmailState(touched)
  );
  assert.deepEqual(persisted.emails, []);
  assert.ok(
    persisted.contactReviewState?.parsedInitial.emails.includes(
      'legacy.person@example.com'
    )
  );
  const redacted = redactContactReviewStateForExport(
    persisted,
    getSafeContactEmails(persisted)
  );
  assert.doesNotMatch(
    JSON.stringify(redacted),
    /legacy\.person@example\.com/
  );
  const exportSource = readFileSync('lib/export.ts', 'utf8');
  const qaSource = readFileSync('lib/export-qa.ts', 'utf8');
  assert.match(exportSource, /redactContactReviewStateForExport/);
  assert.match(qaSource, /redactContactReviewStateForExport/);
});

test('5C-41 titolo derivato continua a ricalcolarsi dopo edit sequenziali', () => {
  const firstEdit = applyManualContactEdits(card(), { firstName: 'Luca' });
  assert.equal(firstEdit.title, 'Acme - Luca Rossi');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      firstEdit.contactReviewState?.manualOverrides ?? {},
      'title'
    ),
    false
  );
  const secondEdit = applyManualContactEdits(firstEdit, { company: 'Beta' });
  assert.equal(secondEdit.title, 'Beta - Luca Rossi');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      secondEdit.contactReviewState?.manualOverrides ?? {},
      'title'
    ),
    false
  );
  const reopened = JSON.parse(
    JSON.stringify(prepareBusinessCardForPersistence(secondEdit))
  ) as BusinessCard;
  const thirdEdit = applyManualContactEdits(reopened, {
    lastName: 'Bianchi',
  });
  assert.equal(thirdEdit.title, 'Beta - Luca Bianchi');
});

test('5C-42 titolo company-only legacy viene migrato alla regola canonica', () => {
  const parsed = rawCard();
  const legacy = {
    ...parsed,
    title: parsed.company,
    extractionReview: extractionReviewFor(parsed),
  };
  const persisted = prepareBusinessCardForPersistence(legacy);
  assert.equal(persisted.title, 'Acme - Mario Rossi');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      persisted.contactReviewState?.manualOverrides ?? {},
      'title'
    ),
    false
  );
});

test('5C-42b titolo company-only resta derivato dopo correzione di entrambi i nomi', () => {
  const originallyParsed = rawCard();
  const legacy = {
    ...originallyParsed,
    title: originallyParsed.company,
    firstName: 'Luigi',
    lastName: 'Verdi',
    extractionReview: extractionReviewFor(originallyParsed),
  };
  const persisted = prepareBusinessCardForPersistence(legacy);
  assert.equal(persisted.title, 'Acme - Luigi Verdi');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      persisted.contactReviewState?.manualOverrides ?? {},
      'title'
    ),
    false
  );
});

test('5C-42c titolo legacy segue la company corretta nel vecchio editor', () => {
  const originallyParsed = rawCard();
  const legacy = {
    ...originallyParsed,
    title: originallyParsed.company,
    company: 'Beta',
    extractionReview: extractionReviewFor(originallyParsed),
  };
  const persisted = prepareBusinessCardForPersistence(legacy);
  assert.equal(persisted.title, 'Beta - Mario Rossi');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      persisted.contactReviewState?.manualOverrides ?? {},
      'title'
    ),
    false
  );
});

test('5C-42d titolo person-only segue la company aggiunta nel vecchio editor', () => {
  const originallyParsed = rawCard({
    company: '',
    title: 'Mario Rossi',
  });
  const legacy = {
    ...originallyParsed,
    company: 'Beta',
    extractionReview: extractionReviewFor(originallyParsed),
  };
  const persisted = prepareBusinessCardForPersistence(legacy);
  assert.equal(persisted.title, 'Beta - Mario Rossi');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      persisted.contactReviewState?.manualOverrides ?? {},
      'title'
    ),
    false
  );
});

test('5C-42e titolo legacy senza review resta derivato dopo le correzioni', () => {
  const legacy = rawCard({
    title: 'Acme - Mario Rossi',
    company: 'Beta',
    firstName: 'Luigi',
    extractionReview: undefined,
  });
  const persisted = prepareBusinessCardForPersistence(legacy);
  assert.equal(persisted.title, 'Beta - Luigi Rossi');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      persisted.contactReviewState?.manualOverrides ?? {},
      'title'
    ),
    false
  );
});

test('5C-43 review reidratata senza reasons non rompe la migrazione email', () => {
  const legacy = rawCard({
    emails: ['legacy.person@example.com'],
    emailEvidence: undefined,
  });
  const trimmed = extractionReviewFor(legacy);
  (trimmed.emails as { reasons?: string[] }).reasons = undefined;
  const migrated = sanitizeBusinessCardEmailState({
    ...legacy,
    extractionReview: trimmed,
  });
  assert.deepEqual(migrated.emails, []);
  assert.deepEqual(migrated.extractionReview?.emails.reasons, [
    'email legacy con provenienza da confermare',
  ]);
});

test('5C-44 refocus riconcilia un commit concluso dopo invalidazione', () => {
  const screen = readFileSync('app/document/[id].tsx', 'utf8');
  const persistence = readFileSync('lib/persistence.ts', 'utf8');
  assert.match(screen, /const reconcileAfterInactiveMutation = useCallback/);
  assert.match(
    screen,
    /useFocusEffect\([\s\S]*screenActiveRef\.current = true;[\s\S]*void loadOnce\(\)/
  );
  assert.match(
    screen,
    /isInactiveScanOperationError\(error\) \|\| !isActive\(\)[\s\S]*reconcileAfterInactiveMutation\(\)/
  );
  assert.match(
    persistence,
    /export async function readAfterPersistenceSettles[\s\S]*return runPersistenceOperation\(read\)/
  );
  assert.match(
    screen,
    /const fromDb = await readAfterPersistenceSettles\(async \(\) => \{[\s\S]*getContactById\(id\)[\s\S]*getDocumentById\(id\)/
  );
});

test('5C-45 scanner legacy inizializza la provenance quando il parser Ã¨ noto', () => {
  const scanner = readFileSync(
    'components/Camera/CardScanner.tsx',
    'utf8'
  );
  assert.match(scanner, /initializeParsedContactReviewState\(\{/);
});

test('5C-46 diff bulk distingue metadata address, phone ed email', () => {
  const before = card({
    address: { full: 'Via Roma 1', city: 'Roma' },
    phones: [{ number: '+39 1', type: 'work' }],
    emailEvidence: [evidence('info@example.com', 'repaired')],
  });
  const changedEvidence = evidence('info@example.com', 'repaired', {
    confidence: 0.8,
  });
  const after = candidate(before, {
    address: { full: 'Via Roma 1', city: 'Milano' },
    phones: [{ number: '+39 1', type: 'fax' }],
    emailEvidence: [changedEvidence],
  });
  const changes = diffReparseCard(before, after);
  for (const field of ['address', 'phones', 'emails'] as const) {
    const change = changes.find((item) => item.field === field);
    assert.ok(change, `delta ${field} mancante`);
    assert.notEqual(change.before, change.after);
  }
});

test('5C-46b proposta individuale rende visibili tutti i delta strutturali', () => {
  const beforeEvidence = evidence('info@example.com', 'repaired', {
    confidence: 0.6,
  });
  const before = card({
    address: { full: 'Via Roma 1', city: 'Roma' },
    phones: [{ number: '+39 1', type: 'work' }],
    emailEvidence: [beforeEvidence],
  });
  const after = candidate(before, {
    address: { full: 'Via Roma 1', city: 'Milano' },
    phones: [{ number: '+39 1', type: 'fax' }],
    emailEvidence: [
      {
        ...beforeEvidence,
        confidence: 0.8,
        transformations: ['domain_space_removed'],
      },
    ],
  });
  const proposal = createContactReparseProposal(
    before,
    after,
    'parser-5c'
  );

  for (const field of ['phones', 'address', 'emails'] as const) {
    const change = proposal.fields.find((item) => item.field === field);
    assert.ok(change, `proposta ${field} mancante`);
    assert.notEqual(change.currentDisplay, change.proposedDisplay);
  }
  const phone = proposal.fields.find((item) => item.field === 'phones');
  assert.match(phone?.currentDisplay ?? '', /work/);
  assert.match(phone?.proposedDisplay ?? '', /fax/);
  const address = proposal.fields.find((item) => item.field === 'address');
  assert.match(address?.currentDisplay ?? '', /Roma/);
  assert.match(address?.proposedDisplay ?? '', /Milano/);
  const email = proposal.fields.find((item) => item.field === 'emails');
  assert.match(email?.currentDisplay ?? '', /"confidence":0\.6/);
  assert.match(email?.proposedDisplay ?? '', /"confidence":0\.8/);
  assert.match(email?.proposedDisplay ?? '', /domain_space_removed/);
});

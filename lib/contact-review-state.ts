import type { Address, BusinessCard, Phone } from '../types';
import type {
  BusinessCardExtractionResult,
  ExtractionSource,
} from './parser-engine/card-extraction-result';
import type { EmailEvidenceMetadata } from './email-evidence';
import { buildCardTitle } from './card-title';

export const CONTACT_REVIEW_FIELD_KEYS = [
  'title',
  'firstName',
  'lastName',
  'company',
  'role',
  'emails',
  'phones',
  'website',
  'address',
  'vatNumber',
  'taxCode',
] as const;

export const CONTACT_REPARSABLE_FIELD_KEYS = [
  'firstName',
  'lastName',
  'company',
  'role',
  'emails',
  'phones',
  'website',
  'address',
  'vatNumber',
  'taxCode',
] as const;

export type ContactReviewFieldKey =
  (typeof CONTACT_REVIEW_FIELD_KEYS)[number];
export type ContactReparseFieldKey =
  (typeof CONTACT_REPARSABLE_FIELD_KEYS)[number];
export type ContactFieldOrigin =
  | 'parser'
  | 'ocr'
  | 'ai'
  | 'user'
  | 'reparse';
export type ContactReviewTracking =
  | 'parsed'
  | 'legacy_conservative';

export interface ContactFieldSnapshot {
  title: string;
  firstName: string;
  lastName: string;
  company: string;
  role: string;
  emails: string[];
  phones: Phone[];
  website: string | null;
  address: Address | null;
  vatNumber: string | null;
  taxCode: string | null;
}

export interface ContactReviewState {
  version: 1;
  /**
   * I record senza stato 5C vengono migrati in modo conservativo. Il flag
   * resta persistito affinché un salvataggio ordinario non li renda
   * accidentalmente eleggibili al reparse bulk.
   */
  tracking: ContactReviewTracking;
  parsedInitial: ContactFieldSnapshot;
  manualOverrides: Partial<ContactFieldSnapshot>;
  fieldOrigins: Record<ContactReviewFieldKey, ContactFieldOrigin>;
  /** Audit persistente per distinguere una modifica AI da OCR/parser nel QA. */
  aiApplications?: Array<{
    appliedAt: string;
    fields: ContactReparseFieldKey[];
  }>;
}

export interface ContactReparseFieldProposal {
  field: ContactReparseFieldKey;
  currentDisplay: string;
  proposedDisplay: string;
  currentOrigin: ContactFieldOrigin;
  protectedByManualOverride: boolean;
}

export interface ContactReparseProposal {
  contactId: string;
  baseFingerprint: string;
  parserBuildId: string;
  candidate: BusinessCard;
  fields: ContactReparseFieldProposal[];
}

export interface ContactReviewModel {
  parsedInitial: ContactFieldSnapshot;
  currentDraft: ContactFieldSnapshot;
  manualOverrides: Partial<ContactFieldSnapshot>;
  fieldOrigins: Record<ContactReviewFieldKey, ContactFieldOrigin>;
  reparseProposal: ContactReparseProposal | null;
  appliedResult: ContactFieldSnapshot | null;
}

export interface ApplyContactCandidateResult {
  appliedResult: BusinessCard;
  appliedFields: ContactReparseFieldKey[];
  protectedFields: ContactReparseFieldKey[];
}

export interface ApplyContactReparseResult
  extends ApplyContactCandidateResult {
  status: 'applied' | 'unchanged' | 'stale';
}

function cloneAddress(value: Address | null | undefined): Address | null {
  return value ? { ...value } : null;
}

function clonePhones(values: readonly Phone[]): Phone[] {
  return values.map((phone) => ({ ...phone }));
}

function cloneSnapshot(snapshot: ContactFieldSnapshot): ContactFieldSnapshot {
  return {
    ...snapshot,
    emails: [...snapshot.emails],
    phones: clonePhones(snapshot.phones),
    address: cloneAddress(snapshot.address),
  };
}

function cloneSnapshotField(
  snapshot: ContactFieldSnapshot,
  field: ContactReviewFieldKey
): ContactFieldSnapshot[ContactReviewFieldKey] {
  return cloneSnapshot(snapshot)[field];
}

function cloneManualOverrides(
  overrides: Partial<ContactFieldSnapshot>
): Partial<ContactFieldSnapshot> {
  const cloned: Partial<ContactFieldSnapshot> = {};
  const mutable = cloned as Record<string, unknown>;
  for (const field of CONTACT_REVIEW_FIELD_KEYS) {
    if (hasOwn(overrides, field)) {
      mutable[field] = cloneSnapshotField(
        {
          title: '',
          firstName: '',
          lastName: '',
          company: '',
          role: '',
          emails: [],
          phones: [],
          website: null,
          address: null,
          vatNumber: null,
          taxCode: null,
          ...overrides,
        },
        field
      );
    }
  }
  return cloned;
}

function hasOwn(
  value: object,
  key: PropertyKey
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isContactReviewFieldKey(
  value: string
): value is ContactReviewFieldKey {
  return (CONTACT_REVIEW_FIELD_KEYS as readonly string[]).includes(value);
}

export function snapshotContactFields(
  card: BusinessCard
): ContactFieldSnapshot {
  return {
    title: card.title ?? '',
    firstName: card.firstName ?? '',
    lastName: card.lastName ?? '',
    company: card.company ?? '',
    role: card.role ?? '',
    emails: [...(card.emails ?? [])],
    phones: clonePhones(card.phones ?? []),
    website: card.website ?? null,
    address: cloneAddress(card.address),
    vatNumber: card.vatNumber ?? null,
    taxCode: card.taxCode ?? null,
  };
}

/** Valore mostrato nell'editor: conserva anche input USER non operativo. */
export function contactEmailDraftValues(card: BusinessCard): string[] {
  const override = card.contactReviewState?.manualOverrides;
  if (override && hasOwn(override, 'emails')) {
    return [...(override.emails ?? [])];
  }
  return [...(card.emails ?? [])];
}

function originFromExtractionSource(
  source: ExtractionSource | undefined
): ContactFieldOrigin {
  if (source === 'user') return 'user';
  if (source === 'ai') return 'ai';
  if (
    source === 'ocr' ||
    source === 'observed' ||
    source === 'repaired'
  ) {
    return 'ocr';
  }
  return 'parser';
}

function extractionSourceForField(
  review: BusinessCardExtractionResult | undefined,
  field: ContactReviewFieldKey
): ExtractionSource | undefined {
  if (!review || field === 'title') return undefined;
  return review[field].source;
}

function initialOrigin(
  card: BusinessCard,
  field: ContactReviewFieldKey
): ContactFieldOrigin {
  if (
    field === 'emails' &&
    card.emailEvidence?.some((item) => item.origin === 'user')
  ) {
    return 'user';
  }
  if (
    field === 'emails' &&
    card.emailEvidence?.some(
      (item) => item.origin === 'observed' || item.origin === 'repaired'
    )
  ) {
    return 'ocr';
  }
  return originFromExtractionSource(
    extractionSourceForField(card.extractionReview, field)
  );
}

function createParsedReviewState(card: BusinessCard): ContactReviewState {
  const parsedInitial = snapshotContactFields(card);
  const fieldOrigins = {} as Record<
    ContactReviewFieldKey,
    ContactFieldOrigin
  >;
  const manualOverrides: Partial<ContactFieldSnapshot> = {};
  const mutableOverrides = manualOverrides as Record<string, unknown>;

  for (const field of CONTACT_REVIEW_FIELD_KEYS) {
    const origin = initialOrigin(card, field);
    fieldOrigins[field] = origin;
    if (origin === 'user') {
      mutableOverrides[field] = cloneSnapshot(parsedInitial)[field];
    }
  }

  return {
    version: 1,
    tracking: 'parsed',
    parsedInitial,
    manualOverrides,
    fieldOrigins,
  };
}

export function recordAiApplication(
  card: BusinessCard,
  appliedFields: readonly ContactReparseFieldKey[],
): BusinessCard {
  const initialized = ensureContactReviewState(card);
  if (!appliedFields.length) return initialized;
  const state = initialized.contactReviewState!;
  return {
    ...initialized,
    contactReviewState: {
      ...state,
      aiApplications: [
        ...(state.aiApplications ?? []).slice(-9),
        { appliedAt: new Date().toISOString(), fields: [...appliedFields] },
      ],
    },
  };
}

function legacyFieldMatchesKnownExtraction(
  card: BusinessCard,
  snapshot: ContactFieldSnapshot,
  field: ContactReviewFieldKey
): boolean {
  const review = card.extractionReview;
  if (field === 'title') {
    // Prima della Fase 5 il titolo dei contatti non era editabile. In assenza
    // dello stato esplicito non esiste quindi una prova di override USER:
    // trattarlo come derivato evita di congelare il titolo pre-correzione,
    // anche sui record creati dal vecchio scanner senza extractionReview.
    return true;
  }
  if (!review) return false;

  switch (field) {
    case 'firstName':
    case 'lastName':
    case 'company':
    case 'role':
      return JSON.stringify(snapshot[field]) ===
        JSON.stringify(review[field].value ?? '');
    case 'emails':
      return JSON.stringify(snapshot.emails) ===
        JSON.stringify(review.emails.value ?? []);
    case 'phones':
      return JSON.stringify(snapshot.phones) ===
        JSON.stringify(review.phones.value ?? []);
    case 'website':
      return JSON.stringify(snapshot.website) ===
        JSON.stringify(review.website.value ?? null);
    case 'address':
      return JSON.stringify(snapshot.address) ===
        JSON.stringify(review.address.value ?? null);
    case 'vatNumber':
      return JSON.stringify(snapshot.vatNumber) ===
        JSON.stringify(review.vatNumber.value ?? null);
    case 'taxCode':
      return JSON.stringify(snapshot.taxCode) ===
        JSON.stringify(review.taxCode.value ?? null);
  }
}

function createLegacyReviewState(card: BusinessCard): ContactReviewState {
  const parsedInitial = snapshotContactFields(card);
  const fieldOrigins = {} as Record<
    ContactReviewFieldKey,
    ContactFieldOrigin
  >;
  const manualOverrides: Partial<ContactFieldSnapshot> = {};
  const mutableOverrides = manualOverrides as Record<string, unknown>;

  for (const field of CONTACT_REVIEW_FIELD_KEYS) {
    const knownExtraction =
      legacyFieldMatchesKnownExtraction(card, parsedInitial, field);
    const origin = knownExtraction ? initialOrigin(card, field) : 'user';
    fieldOrigins[field] = origin;
    if (origin === 'user') {
      mutableOverrides[field] = cloneSnapshotField(parsedInitial, field);
    }
  }

  return {
    version: 1,
    tracking: 'legacy_conservative',
    parsedInitial,
    manualOverrides,
    fieldOrigins,
  };
}

function normalizeReviewState(
  card: BusinessCard,
  state: ContactReviewState
): ContactReviewState {
  const fallback = createLegacyReviewState(card);
  const manualOverrides = cloneManualOverrides(
    state.manualOverrides ?? fallback.manualOverrides
  );
  const mutableOverrides = manualOverrides as Record<string, unknown>;
  const current = snapshotContactFields(card);
  const fieldOrigins = Object.fromEntries(
    CONTACT_REVIEW_FIELD_KEYS.map((field) => [
      field,
      state.fieldOrigins?.[field] ?? fallback.fieldOrigins[field],
    ])
  ) as Record<ContactReviewFieldKey, ContactFieldOrigin>;

  for (const field of CONTACT_REVIEW_FIELD_KEYS) {
    if (hasOwn(manualOverrides, field)) {
      fieldOrigins[field] = 'user';
    } else if (fieldOrigins[field] === 'user') {
      if (field === 'title') {
        // Il titolo può essere derivato da nome/azienda USER senza essere
        // stato editato direttamente. Solo un override già presente prova
        // che il titolo stesso è manuale.
        continue;
      }
      mutableOverrides[field] = cloneSnapshotField(current, field);
    }
  }

  return {
    version: 1,
    tracking:
      state.tracking === 'parsed'
        ? 'parsed'
        : 'legacy_conservative',
    parsedInitial: cloneSnapshot(
      state.parsedInitial ?? fallback.parsedInitial
    ),
    manualOverrides,
    fieldOrigins,
    aiApplications: state.aiApplications?.map((entry) => ({
      appliedAt: entry.appliedAt,
      fields: [...entry.fields],
    })),
  };
}

export function ensureContactReviewState(
  card: BusinessCard
): BusinessCard {
  return {
    ...card,
    contactReviewState: card.contactReviewState
      ? normalizeReviewState(card, card.contactReviewState)
      : createLegacyReviewState(card),
  };
}

/**
 * Inizializza lo stato soltanto nel punto in cui il risultato parser appena
 * prodotto è ancora noto. Non viene usata come migrazione dei record legacy.
 */
export function initializeParsedContactReviewState(
  card: BusinessCard
): BusinessCard {
  if (card.contactReviewState) return ensureContactReviewState(card);
  return {
    ...card,
    contactReviewState: createParsedReviewState(card),
  };
}

function setSnapshotField(
  card: BusinessCard,
  snapshot: ContactFieldSnapshot,
  field: ContactReviewFieldKey
): BusinessCard {
  switch (field) {
    case 'title':
      return { ...card, title: snapshot.title };
    case 'firstName':
      return { ...card, firstName: snapshot.firstName };
    case 'lastName':
      return { ...card, lastName: snapshot.lastName };
    case 'company':
      return { ...card, company: snapshot.company };
    case 'role':
      return { ...card, role: snapshot.role };
    case 'emails':
      return { ...card, emails: [...snapshot.emails] };
    case 'phones':
      return { ...card, phones: clonePhones(snapshot.phones) };
    case 'website':
      return {
        ...card,
        website: snapshot.website ?? undefined,
      };
    case 'address':
      return {
        ...card,
        address: cloneAddress(snapshot.address) ?? undefined,
      };
    case 'vatNumber':
      return {
        ...card,
        vatNumber: snapshot.vatNumber ?? undefined,
      };
    case 'taxCode':
      return {
        ...card,
        taxCode: snapshot.taxCode ?? undefined,
      };
  }
}

function setSnapshotFields(
  card: BusinessCard,
  snapshot: ContactFieldSnapshot,
  fields: readonly ContactReviewFieldKey[]
): BusinessCard {
  return fields.reduce(
    (current, field) => setSnapshotField(current, snapshot, field),
    card
  );
}

function fieldValuesEqual(
  left: ContactFieldSnapshot,
  right: ContactFieldSnapshot,
  field: ContactReviewFieldKey
): boolean {
  return JSON.stringify(left[field]) === JSON.stringify(right[field]);
}

function emailEvidenceValue(
  card: Pick<BusinessCard, 'emailEvidence'>
): { present: false } | { present: true; value: EmailEvidenceMetadata[] } {
  return card.emailEvidence === undefined
    ? { present: false }
    : { present: true, value: card.emailEvidence };
}

function emailEvidenceEqual(
  left: Pick<BusinessCard, 'emailEvidence'>,
  right: Pick<BusinessCard, 'emailEvidence'>
): boolean {
  return (
    JSON.stringify(emailEvidenceValue(left)) ===
    JSON.stringify(emailEvidenceValue(right))
  );
}

function addressAlternativesValue(
  card: Pick<BusinessCard, 'extractionReview'>
): Address[] | undefined {
  return card.extractionReview?.addressAlternatives;
}

function addressAlternativesEqual(
  left: Pick<BusinessCard, 'extractionReview'>,
  right: Pick<BusinessCard, 'extractionReview'>
): boolean {
  return (
    JSON.stringify(addressAlternativesValue(left)) ===
    JSON.stringify(addressAlternativesValue(right))
  );
}

function contactFieldHasCandidateDelta(
  current: BusinessCard,
  candidate: BusinessCard,
  currentSnapshot: ContactFieldSnapshot,
  candidateSnapshot: ContactFieldSnapshot,
  field: ContactReparseFieldKey
): boolean {
  if (!fieldValuesEqual(currentSnapshot, candidateSnapshot, field)) {
    return true;
  }
  return (
    (field === 'emails' && !emailEvidenceEqual(current, candidate)) ||
    (field === 'address' && !addressAlternativesEqual(current, candidate))
  );
}

/**
 * Fingerprint della parte editabile/provenance della review. Comprende anche
 * un override manuale impostato sullo stesso valore e i delta evidence-only.
 */
export function contactReviewFingerprint(card: BusinessCard): string {
  const initialized = ensureContactReviewState(card);
  const state = initialized.contactReviewState!;
  return JSON.stringify({
    fields: snapshotContactFields(initialized),
    emailEvidence: emailEvidenceValue(initialized),
    addressAlternatives: addressAlternativesValue(initialized),
    manualOverrides: state.manualOverrides,
    fieldOrigins: state.fieldOrigins,
    tracking: state.tracking,
  });
}

function emailDisplayValue(
  card: BusinessCard,
  snapshot: ContactFieldSnapshot
): string {
  const values = [...snapshot.emails];
  for (const item of card.emailEvidence ?? []) {
    if (
      values.some(
        (value) => value.trim().toLowerCase() ===
          item.value.trim().toLowerCase()
      )
    ) {
      continue;
    }
    values.push(`${item.value} [${item.origin}]`);
  }
  const summary = values.join(', ') || '\u2014';
  return `${summary}\n${JSON.stringify({
    emails: snapshot.emails,
    evidence: emailEvidenceValue(card),
  })}`;
}

export function contactFieldDisplayValue(
  snapshot: ContactFieldSnapshot,
  field: ContactReviewFieldKey
): string {
  const value = snapshot[field];
  if (value == null) return '—';
  if (field === 'phones') {
    const phones = value as Phone[];
    const summary =
      phones
        .map((phone) =>
          phone.type
            ? `${phone.number || '\u2014'} (${phone.type})`
            : phone.number
        )
        .filter(Boolean)
        .join(', ') || '\u2014';
    return `${summary}\n${JSON.stringify(phones)}`;
  }
  if (field === 'emails') {
    const emails = value as string[];
    return emails.join(', ') || '—';
  }
  if (field === 'address') {
    const address = value as Address;
    const locality = [
      address.postalCode,
      address.city,
      address.region,
      address.country,
    ]
      .filter(Boolean)
      .join(' ');
    const summary =
      [address.full?.trim(), locality]
        .filter(Boolean)
        .join(' · ') || '\u2014';
    return `${summary}\n${JSON.stringify(address)}`;
  }
  return String(value).trim() || '—';
}

function derivedTitleOrigin(
  origins: Record<ContactReviewFieldKey, ContactFieldOrigin>
): ContactFieldOrigin {
  const sources = [
    origins.company,
    origins.firstName,
    origins.lastName,
  ];
  for (const source of [
    'user',
    'reparse',
    'ai',
    'ocr',
    'parser',
  ] as const) {
    if (sources.includes(source)) return source;
  }
  return 'parser';
}

function applyCanonicalTitle(card: BusinessCard): BusinessCard {
  const state = card.contactReviewState!;
  if (hasOwn(state.manualOverrides, 'title')) {
    return setSnapshotField(
      card,
      {
        ...snapshotContactFields(card),
        title:
          state.manualOverrides.title ??
          snapshotContactFields(card).title,
      },
      'title'
    );
  }
  const title = buildCardTitle(
    card.company,
    card.firstName,
    card.lastName
  );
  return {
    ...card,
    title,
    contactReviewState: {
      ...state,
      fieldOrigins: {
        ...state.fieldOrigins,
        title: derivedTitleOrigin(state.fieldOrigins),
      },
    },
  };
}

export function prepareBusinessCardForPersistence(
  card: BusinessCard
): BusinessCard {
  const titled = applyCanonicalTitle(ensureContactReviewState(card));
  const state = titled.contactReviewState!;
  const current = snapshotContactFields(titled);
  const manualOverrides = cloneManualOverrides(state.manualOverrides);
  const mutableOverrides = manualOverrides as Record<string, unknown>;

  // Normalizzazioni immediatamente precedenti al salvataggio (per esempio
  // address o email) devono aggiornare anche il valore protetto persistito.
  for (const field of CONTACT_REVIEW_FIELD_KEYS) {
    if (field === 'emails' && hasOwn(manualOverrides, 'emails')) {
      // `sanitizeBusinessCardEmailState` rimuove giustamente gli input USER
      // invalidi dal valore operativo. Il testo resta però nell'override per
      // poter essere corretto dopo il round-trip.
      continue;
    }
    if (field === 'title' && !hasOwn(manualOverrides, 'title')) {
      continue;
    }
    if (
      hasOwn(manualOverrides, field) ||
      state.fieldOrigins[field] === 'user'
    ) {
      mutableOverrides[field] = cloneSnapshotField(current, field);
    }
  }

  return {
    ...titled,
    contactReviewState: {
      ...state,
      manualOverrides,
    },
  };
}

/**
 * Gli snapshot interni non devono aggirare il filtro e-mail della Fase 3B.
 * La redazione è una copia per export e non modifica il record persistito.
 */
export function redactContactReviewStateForExport(
  card: BusinessCard,
  allowedEmails: readonly string[]
): ContactReviewState | undefined {
  if (!card.contactReviewState) return undefined;
  const allowed = new Set(
    allowedEmails.map((value) => value.trim().toLowerCase())
  );
  const keepAllowed = (values: readonly string[] | undefined) =>
    (values ?? []).filter((value) =>
      allowed.has(value.trim().toLowerCase())
    );
  const state = normalizeReviewState(card, card.contactReviewState);
  const parsedInitial = cloneSnapshot(state.parsedInitial);
  parsedInitial.emails = keepAllowed(parsedInitial.emails);
  const manualOverrides = cloneManualOverrides(state.manualOverrides);
  if (hasOwn(manualOverrides, 'emails')) {
    manualOverrides.emails = keepAllowed(manualOverrides.emails);
  }
  return {
    ...state,
    parsedInitial,
    manualOverrides,
  };
}

export function applyManualContactEdits(
  card: BusinessCard,
  patch: Partial<ContactFieldSnapshot>
): BusinessCard {
  const initialized = ensureContactReviewState(card);
  const current = snapshotContactFields(initialized);
  const patched: ContactFieldSnapshot = {
    ...current,
    ...patch,
    emails: patch.emails ? [...patch.emails] : current.emails,
    phones: patch.phones ? clonePhones(patch.phones) : current.phones,
    address:
      patch.address !== undefined
        ? cloneAddress(patch.address)
        : current.address,
  };
  const fields = Object.keys(patch).filter(isContactReviewFieldKey);
  if (fields.length === 0) return initialized;

  const state = initialized.contactReviewState!;
  const manualOverrides = {
    ...state.manualOverrides,
  };
  const mutableOverrides = manualOverrides as Record<string, unknown>;
  const fieldOrigins = { ...state.fieldOrigins };

  for (const field of fields) {
    mutableOverrides[field] = cloneSnapshot(patched)[field];
    fieldOrigins[field] = 'user';
  }

  let next = setSnapshotFields(initialized, patched, fields);
  next = {
    ...next,
    contactReviewState: {
      ...state,
      manualOverrides,
      fieldOrigins,
    },
  };

  if (
    fields.includes('firstName') ||
    fields.includes('lastName') ||
    fields.includes('company')
  ) {
    next = applyCanonicalTitle(next);
  }
  return next;
}

function extractionValueFromSnapshot(
  snapshot: ContactFieldSnapshot,
  field: ContactReparseFieldKey
): BusinessCardExtractionResult[ContactReparseFieldKey]['value'] {
  switch (field) {
    case 'firstName':
    case 'lastName':
    case 'company':
    case 'role':
      return snapshot[field] || null;
    case 'emails':
      return [...snapshot.emails];
    case 'phones':
      return clonePhones(snapshot.phones);
    case 'website':
      return snapshot.website;
    case 'address':
      return cloneAddress(snapshot.address);
    case 'vatNumber':
      return snapshot.vatNumber;
    case 'taxCode':
      return snapshot.taxCode;
  }
}

function cloneExtractionReview(
  review: BusinessCardExtractionResult
): BusinessCardExtractionResult {
  return {
    ...review,
    firstName: { ...review.firstName },
    lastName: { ...review.lastName },
    company: { ...review.company },
    role: { ...review.role },
    emails: {
      ...review.emails,
      value: review.emails.value ? [...review.emails.value] : review.emails.value,
    },
    phones: {
      ...review.phones,
      value: review.phones.value
        ? clonePhones(review.phones.value)
        : review.phones.value,
    },
    website: { ...review.website },
    address: {
      ...review.address,
      value: cloneAddress(review.address.value),
    },
    addressAlternatives: review.addressAlternatives?.map(
      (address) => cloneAddress(address)!
    ),
    vatNumber: { ...review.vatNumber },
    taxCode: { ...review.taxCode },
    reviewFields: [...review.reviewFields],
    emailEvidence: review.emailEvidence
      ? review.emailEvidence.map((item) => ({
          ...item,
          transformations: [...item.transformations],
        }))
      : review.emailEvidence,
  };
}

function mergeExtractionReview(
  currentCard: BusinessCard,
  candidateCard: BusinessCard,
  appliedFields: readonly ContactReparseFieldKey[]
): BusinessCardExtractionResult | undefined {
  const current = currentCard.extractionReview;
  const candidate = candidateCard.extractionReview;
  if (!candidate || appliedFields.length === 0) return current;

  const currentSnapshot = snapshotContactFields(currentCard);
  const applied = new Set(appliedFields);
  const next = cloneExtractionReview(current ?? candidate);

  for (const field of CONTACT_REPARSABLE_FIELD_KEYS) {
    if (applied.has(field)) {
      next[field] = {
        ...candidate[field],
        value: candidate[field].value,
      } as never;
      continue;
    }
    if (!current) {
      next[field] = {
        ...candidate[field],
        value: extractionValueFromSnapshot(currentSnapshot, field),
        source: 'legacy',
        reasons: [
          ...(candidate[field].reasons ?? []),
          'valore corrente conservato durante applicazione parziale',
        ],
      } as never;
    }
  }

  next.reviewFields = [
    ...new Set([
      ...(current?.reviewFields ?? []).filter(
        (field) => !applied.has(field as ContactReparseFieldKey)
      ),
      ...candidate.reviewFields.filter((field) =>
        applied.has(field as ContactReparseFieldKey)
      ),
    ]),
  ];
  next.needsReview = next.reviewFields.length > 0;
  next.rawText = candidate.rawText;
  if (applied.has('emails')) {
    next.emailEvidence = candidate.emailEvidence;
  } else {
    next.emailEvidence = current?.emailEvidence ?? currentCard.emailEvidence;
  }
  next.addressAlternatives = applied.has('address')
    ? candidate.addressAlternatives?.map((address) => cloneAddress(address)!)
    : current?.addressAlternatives?.map((address) => cloneAddress(address)!);
  return next;
}

function applyCandidateFields(
  currentCard: BusinessCard,
  candidate: BusinessCard,
  requestedFields: readonly ContactReparseFieldKey[],
  origin: Exclude<ContactFieldOrigin, 'parser' | 'user'>
): ApplyContactCandidateResult {
  const current = ensureContactReviewState(currentCard);
  const state = current.contactReviewState!;
  const currentSnapshot = snapshotContactFields(current);
  const candidateSnapshot = snapshotContactFields(candidate);
  const requested = new Set(requestedFields);
  const appliedFields: ContactReparseFieldKey[] = [];
  const protectedFields: ContactReparseFieldKey[] = [];

  for (const field of CONTACT_REPARSABLE_FIELD_KEYS) {
    if (!requested.has(field)) continue;
    if (
      !contactFieldHasCandidateDelta(
        current,
        candidate,
        currentSnapshot,
        candidateSnapshot,
        field
      )
    ) {
      continue;
    }
    if (hasOwn(state.manualOverrides, field)) {
      protectedFields.push(field);
      continue;
    }
    appliedFields.push(field);
  }

  if (appliedFields.length === 0) {
    return {
      appliedResult: current,
      appliedFields,
      protectedFields,
    };
  }

  let next: BusinessCard = {
    ...current,
    contactReviewState: state,
  };
  next = setSnapshotFields(next, candidateSnapshot, appliedFields);

  if (appliedFields.includes('emails')) {
    next.emailEvidence = candidate.emailEvidence;
  }

  const confidence = { ...current.confidence };
  for (const field of appliedFields) {
    if (candidate.confidence[field] !== undefined) {
      confidence[field] = candidate.confidence[field];
    }
  }

  const fieldOrigins = { ...state.fieldOrigins };
  for (const field of appliedFields) fieldOrigins[field] = origin;
  next = {
    ...next,
    confidence,
    extractionReview: mergeExtractionReview(
      current,
      candidate,
      appliedFields
    ),
    contactReviewState: {
      ...state,
      fieldOrigins,
    },
  };

  if (
    appliedFields.includes('firstName') ||
    appliedFields.includes('lastName') ||
    appliedFields.includes('company')
  ) {
    next = applyCanonicalTitle(next);
  } else {
    next = setSnapshotField(next, currentSnapshot, 'title');
  }

  return {
    appliedResult: next,
    appliedFields,
    protectedFields,
  };
}

export function applyContactCandidatePreservingManual(
  current: BusinessCard,
  candidate: BusinessCard,
  origin: 'ai' | 'ocr' | 'reparse'
): ApplyContactCandidateResult {
  return applyCandidateFields(
    current,
    candidate,
    CONTACT_REPARSABLE_FIELD_KEYS,
    origin
  );
}

export function createContactReparseProposal(
  currentCard: BusinessCard,
  candidate: BusinessCard,
  parserBuildId: string
): ContactReparseProposal {
  const current = ensureContactReviewState(currentCard);
  const currentSnapshot = snapshotContactFields(current);
  const candidateSnapshot = snapshotContactFields(candidate);
  const state = current.contactReviewState!;
  const fields = CONTACT_REPARSABLE_FIELD_KEYS
    .filter(
      (field) =>
        contactFieldHasCandidateDelta(
          current,
          candidate,
          currentSnapshot,
          candidateSnapshot,
          field
        )
    )
    .map((field) => ({
      field,
      currentDisplay:
        field === 'emails'
          ? emailDisplayValue(current, currentSnapshot)
          : contactFieldDisplayValue(currentSnapshot, field),
      proposedDisplay:
        field === 'emails'
          ? emailDisplayValue(candidate, candidateSnapshot)
          : contactFieldDisplayValue(candidateSnapshot, field),
      currentOrigin: state.fieldOrigins[field],
      protectedByManualOverride: hasOwn(state.manualOverrides, field),
    }));

  return {
    contactId: current.id,
    baseFingerprint: contactReviewFingerprint(current),
    parserBuildId,
    candidate: {
      ...candidate,
      contactReviewState: state,
    },
    fields,
  };
}

export function applyContactReparseProposal(
  currentCard: BusinessCard,
  proposal: ContactReparseProposal,
  selectedFields: readonly ContactReparseFieldKey[]
): ApplyContactReparseResult {
  const current = ensureContactReviewState(currentCard);
  if (
    proposal.contactId !== current.id ||
    proposal.baseFingerprint !== contactReviewFingerprint(current)
  ) {
    return {
      status: 'stale',
      appliedResult: current,
      appliedFields: [],
      protectedFields: [],
    };
  }

  const allowedProposalFields = new Set(
    proposal.fields.map((item) => item.field)
  );
  const requested = selectedFields.filter((field) =>
    allowedProposalFields.has(field)
  );
  const result = applyCandidateFields(
    current,
    proposal.candidate,
    requested,
    'reparse'
  );
  const appliedResult =
    result.appliedFields.length > 0
      ? {
          ...result.appliedResult,
          updatedAt: new Date(),
          lastParserBuildId: proposal.parserBuildId,
        }
      : result.appliedResult;

  return {
    ...result,
    status: result.appliedFields.length > 0 ? 'applied' : 'unchanged',
    appliedResult,
  };
}

export function buildContactReviewModel(
  card: BusinessCard,
  reparseProposal: ContactReparseProposal | null = null,
  appliedResult: BusinessCard | null = null
): ContactReviewModel {
  const initialized = ensureContactReviewState(card);
  const state = initialized.contactReviewState!;
  return {
    parsedInitial: cloneSnapshot(state.parsedInitial),
    currentDraft: snapshotContactFields(initialized),
    manualOverrides: { ...state.manualOverrides },
    fieldOrigins: { ...state.fieldOrigins },
    reparseProposal,
    appliedResult: appliedResult
      ? snapshotContactFields(appliedResult)
      : null,
  };
}

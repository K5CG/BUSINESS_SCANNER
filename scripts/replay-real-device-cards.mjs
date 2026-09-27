/**
 * Read-only replay of the canonical real-device acceptance dataset.
 *
 * Console output is deliberately PII-safe: it contains stable case IDs,
 * field names, scores and invariant codes, never extracted field values.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesFromRawText } from '../lib/extraction-review.ts';
import { parseCardFromPages } from '../lib/parser.ts';
import { PARSER_BUILD_ID } from '../lib/parser-version.ts';

const DATASET_ID = 'real-device-cards-2026-07-31';
const EXPECTED_MISSING_RAW = new Set(['case-005', 'case-016']);
const SCOREABLE_FIELDS = new Set([
  'firstName',
  'lastName',
  'role',
  'company',
  'emails',
  'phones',
  'websites',
  'addresses',
  'vatNumber',
  'taxCode',
]);
const SPECIAL_SCORE_FIELDS = new Map([
  ['noPerson', ['firstName', 'lastName']],
  ['noInventedPerson', ['firstName', 'lastName']],
  ['noInventedWebsite', ['websites']],
  ['observedWebsitePreserved', ['websites']],
  ['observedNamePreserved', ['firstName', 'lastName']],
]);
const AUTOMATED_INVARIANT_FIELDS = new Set([
  'ambiguousCompanyNeedsReview',
  'fiscalNotPersonOrPhone',
  'genericProviderExcluded',
  'nameSplitNeedsReview',
  'needsReview',
  'noDuplicatePhones',
  'noInventedPerson',
  'phoneNotAddress',
  'phoneNotPostalCode',
  'claimNotCompany',
  'personNeedsReview',
  'repairedEmailRequiresReview',
  'roleOrUnitNotPerson',
  'secondaryWebsiteNeedsReview',
]);
const DEFERRED_ACCEPTANCE_FIELDS = new Set([
  // I due casi senza raw OCR non possono essere rigiocati.
  'nonEmptyWhenPagesObserved',
  'needsReviewOnAmbiguousPages',
  // Coperto dalla suite deduplica, non dal replay del parser.
  'duplicateWithCase016',
  'duplicateWithCase027',
]);
const CONTACT_VALUE_FIELDS = [
  'firstName',
  'lastName',
  'role',
  'company',
  'emails',
  'phones',
  'website',
  'address',
  'vatNumber',
  'taxCode',
];

const args = process.argv.slice(2);
const enforce = args.includes('--enforce');
const unsupportedArgs = args.filter((argument) => argument !== '--enforce');
if (unsupportedArgs.length > 0) {
  throw new Error('usage: replay-real-device-cards.mjs [--enforce]');
}

const sourceDirectory = process.env.BUSINESS_SCANNER_BUNDLED_SOURCE_DIR
  ? path.resolve(process.env.BUSINESS_SCANNER_BUNDLED_SOURCE_DIR)
  : path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(sourceDirectory, '..');
const datasetRoot = path.join(repositoryRoot, 'test-data', DATASET_ID);
const sourceRoot = path.join(datasetRoot, 'source');

function readJson(relativePath) {
  return JSON.parse(
    readFileSync(path.join(datasetRoot, relativePath), 'utf8')
  );
}

function resolveSourcePath(relativePath) {
  const resolved = path.resolve(sourceRoot, relativePath);
  if (
    resolved !== sourceRoot &&
    !resolved.startsWith(`${sourceRoot}${path.sep}`)
  ) {
    throw new Error('dataset source path escapes its canonical root');
  }
  return resolved;
}

function normalizeObservedText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value) {
  return normalizeObservedText(value)
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeEmail(value) {
  return normalizeObservedText(value).toLocaleLowerCase('und').replace(/\s+/g, '');
}

function normalizeWebsite(value) {
  return normalizeObservedText(value)
    .toLocaleLowerCase('und')
    .replace(/\s+/g, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#]+$/, '');
}

function normalizePhone(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

function valueIsEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    return Object.values(value).every(valueIsEmpty);
  }
  return false;
}

function contactIsEmpty(card) {
  return CONTACT_VALUE_FIELDS.every((field) => valueIsEmpty(card[field]));
}

function scalarSimilarity(expected, actual) {
  if (valueIsEmpty(expected)) return valueIsEmpty(actual) ? 1 : 0;
  if (valueIsEmpty(actual)) return 0;

  const expectedNormalized = normalizeText(expected);
  const actualNormalized = normalizeText(actual);
  if (!expectedNormalized) return actualNormalized ? 0 : 1;
  if (expectedNormalized === actualNormalized) return 1;

  if (
    expectedNormalized.length >= 4 &&
    actualNormalized.length >= 4 &&
    (
      expectedNormalized.includes(actualNormalized) ||
      actualNormalized.includes(expectedNormalized)
    )
  ) {
    return (
      Math.min(expectedNormalized.length, actualNormalized.length) /
      Math.max(expectedNormalized.length, actualNormalized.length)
    );
  }

  return 0;
}

function setSimilarity(expectedValues, actualValues, itemSimilarity) {
  const expected = expectedValues.filter((value) => !valueIsEmpty(value));
  const actual = actualValues.filter((value) => !valueIsEmpty(value));
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  if (actual.length === 0) return 0;

  const remainingActualIndexes = new Set(actual.map((_, index) => index));
  let matchedScore = 0;

  for (const expectedValue of expected) {
    let bestIndex = -1;
    let bestScore = 0;
    for (const actualIndex of remainingActualIndexes) {
      const score = itemSimilarity(expectedValue, actual[actualIndex]);
      if (score > bestScore) {
        bestIndex = actualIndex;
        bestScore = score;
      }
    }
    if (bestIndex >= 0) remainingActualIndexes.delete(bestIndex);
    matchedScore += bestScore;
  }

  return matchedScore / Math.max(expected.length, actual.length);
}

function phoneSimilarity(expected, actual) {
  const expectedNumber = normalizePhone(expected?.number ?? expected);
  const actualNumber = normalizePhone(actual?.number ?? actual);
  if (!expectedNumber || !actualNumber) return 0;

  const numberMatches =
    expectedNumber === actualNumber ||
    (
      Math.min(expectedNumber.length, actualNumber.length) >= 7 &&
      (
        expectedNumber.endsWith(actualNumber) ||
        actualNumber.endsWith(expectedNumber)
      )
    );
  if (!numberMatches) return 0;

  const expectedType = normalizeText(expected?.type);
  const actualType = normalizeText(actual?.type);
  return !expectedType || expectedType === actualType ? 1 : 0.85;
}

function addressText(address) {
  if (typeof address === 'string') return address;
  if (!address || typeof address !== 'object') return '';
  if (typeof address.full === 'string' && address.full.trim()) {
    return address.full;
  }
  return Object.entries(address)
    .filter(([key, value]) => key !== 'kind' && typeof value === 'string')
    .map(([, value]) => value)
    .join(' ');
}

function tokenSet(value) {
  return new Set(
    normalizeObservedText(value)
      .toLocaleLowerCase('und')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function addressSimilarity(expected, actual) {
  const expectedText = addressText(expected);
  const actualText = addressText(actual);
  if (!expectedText) return actualText ? 0 : 1;
  if (!actualText) return 0;

  const exactish = scalarSimilarity(expectedText, actualText);
  const expectedTokens = tokenSet(expectedText);
  const actualTokens = tokenSet(actualText);
  if (expectedTokens.size === 0 || actualTokens.size === 0) return exactish;

  let intersection = 0;
  for (const token of expectedTokens) {
    if (actualTokens.has(token)) intersection += 1;
  }
  const dice =
    (2 * intersection) / (expectedTokens.size + actualTokens.size);
  return Math.max(exactish, dice);
}

function actualValuesForField(card, field) {
  switch (field) {
    case 'websites':
      return valueIsEmpty(card.website) ? [] : [card.website];
    case 'addresses':
      return [
        ...(valueIsEmpty(card.address) ? [] : [card.address]),
        ...(card.extractionReview?.addressAlternatives ?? []),
      ];
    default:
      return card[field];
  }
}

function scoreField(expectedFields, card, field) {
  const expected = expectedFields[field];
  const actual = actualValuesForField(card, field);

  switch (field) {
    case 'emails':
      return setSimilarity(
        expected ?? [],
        actual ?? [],
        (left, right) => Number(normalizeEmail(left) === normalizeEmail(right))
      );
    case 'websites':
      return setSimilarity(
        expected ?? [],
        actual ?? [],
        (left, right) =>
          Number(normalizeWebsite(left) === normalizeWebsite(right))
      );
    case 'phones':
      return setSimilarity(expected ?? [], actual ?? [], phoneSimilarity);
    case 'addresses':
      return setSimilarity(expected ?? [], actual ?? [], addressSimilarity);
    default:
      return scalarSimilarity(expected, actual);
  }
}

function fieldsToScore(expectedCase) {
  const fields = new Set();
  for (const acceptanceField of expectedCase.acceptanceFields) {
    if (SCOREABLE_FIELDS.has(acceptanceField)) {
      fields.add(acceptanceField);
    }
    for (const mappedField of SPECIAL_SCORE_FIELDS.get(acceptanceField) ?? []) {
      fields.add(mappedField);
    }
  }
  return [...fields];
}

function scoresForCard(expectedCase, card) {
  const fields = fieldsToScore(expectedCase);
  const fieldScores = Object.fromEntries(
    fields.map((field) => [
      field,
      scoreField(expectedCase.fields, card, field),
    ])
  );
  const values = Object.values(fieldScores);
  const aggregate =
    values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  return { fieldScores, aggregate };
}

function classify(score) {
  if (score >= 0.95) return 'PASS';
  if (score >= 0.5) return 'PARTIAL';
  return 'FAIL';
}

function percent(score) {
  return Math.round(score * 100);
}

function addressUsesPhone(expectedFields, parsed) {
  const actualAddress = addressText(parsed.address);
  const expectedAddresses = expectedFields.addresses ?? [];
  const expectedPhones = expectedFields.phones ?? [];
  if (
    !actualAddress ||
    expectedAddresses.length === 0 ||
    expectedPhones.length === 0
  ) {
    return false;
  }

  const addressDigits = normalizePhone(actualAddress);
  const containsExpectedPhone = expectedPhones.some((phone) => {
    const phoneDigits = normalizePhone(phone?.number ?? phone);
    return phoneDigits.length >= 7 && addressDigits.includes(phoneDigits);
  });
  if (!containsExpectedPhone) return false;

  const bestExpectedAddressScore = Math.max(
    ...expectedAddresses.map((address) =>
      addressSimilarity(address, parsed.address)
    )
  );
  return bestExpectedAddressScore < 0.5;
}

function reviewMetadata(parsed) {
  const review = parsed.extractionReview;
  return {
    needsReview: review?.needsReview === true,
    fields: new Set(review?.reviewFields ?? []),
  };
}

function normalizedPhoneValues(parsed) {
  return (parsed.phones ?? [])
    .map((phone) => normalizePhone(phone?.number ?? phone))
    .filter(Boolean);
}

function invariantViolations(expectedCase, parsed) {
  const violations = [];
  const acceptance = new Set(expectedCase.acceptanceFields);
  const review = reviewMetadata(parsed);
  const expectedEmails = new Set(
    (expectedCase.fields.emails ?? []).map(normalizeEmail)
  );

  if (acceptance.has('repairedEmailRequiresReview')) {
    const repairedExpectedEmail = (parsed.emailEvidence ?? []).some(
      (item) =>
        expectedEmails.has(normalizeEmail(item.value)) &&
        item.origin === 'repaired' &&
        item.requiresReview === true &&
        item.confirmed === false
    );
    if (!repairedExpectedEmail || !review.needsReview || !review.fields.has('emails')) {
      violations.push('REPAIRED_EMAIL_REVIEW_MISSING');
    }
  }

  if (acceptance.has('fiscalNotPersonOrPhone')) {
    const expectedVat = normalizePhone(expectedCase.fields.vatNumber);
    const expectedTaxCode = normalizeText(expectedCase.fields.taxCode);
    const actualPhones = new Set(normalizedPhoneValues(parsed));
    const person = normalizeText(
      [parsed.firstName, parsed.lastName].filter(Boolean).join(' ')
    );
    if (
      (expectedVat && normalizePhone(parsed.vatNumber) !== expectedVat) ||
      (expectedTaxCode && normalizeText(parsed.taxCode) !== expectedTaxCode)
    ) {
      violations.push('FISCAL_IDENTIFIER_NOT_CLASSIFIED');
    }
    if (expectedVat && actualPhones.has(expectedVat)) {
      violations.push('FISCAL_IDENTIFIER_USED_AS_PHONE');
    }
    if (
      person &&
      (
        person.includes('fiscal') ||
        person.includes('partitaiva') ||
        (expectedTaxCode && person.includes(expectedTaxCode))
      )
    ) {
      violations.push('FISCAL_LABEL_USED_AS_PERSON');
    }
  }

  if (
    acceptance.has('ambiguousCompanyNeedsReview') &&
    (!review.needsReview || !review.fields.has('company'))
  ) {
    violations.push('AMBIGUOUS_COMPANY_REVIEW_MISSING');
  }

  if (acceptance.has('genericProviderExcluded')) {
    const genericDomains = (expectedCase.fields.emails ?? [])
      .map((email) => normalizeEmail(email).split('@')[1])
      .filter(Boolean);
    const company = normalizeText(parsed.company);
    const website = normalizeWebsite(parsed.website);
    if (
      genericDomains.some((domain) => {
        const root = normalizeText(domain.split('.')[0]);
        return (
          (root && company === root) ||
          website === domain ||
          website.endsWith(`.${domain}`)
        );
      })
    ) {
      violations.push('GENERIC_PROVIDER_USED_AS_BUSINESS');
    }
  }

  if (acceptance.has('nameSplitNeedsReview') && !review.needsReview) {
    violations.push('NAME_SPLIT_REVIEW_MISSING');
  }

  if (acceptance.has('noDuplicatePhones')) {
    const phones = normalizedPhoneValues(parsed);
    if (new Set(phones).size !== phones.length) {
      violations.push('DUPLICATE_PHONE_EMITTED');
    }
  }

  if (acceptance.has('noInventedPerson')) {
    const actualPerson = normalizeText(
      [parsed.firstName, parsed.lastName].filter(Boolean).join(' ')
    );
    const expectedPerson = normalizeText(
      [expectedCase.fields.firstName, expectedCase.fields.lastName]
        .filter(Boolean)
        .join(' ')
    );
    if (
      actualPerson &&
      actualPerson !== expectedPerson &&
      !actualPerson.includes(expectedPerson) &&
      !expectedPerson.includes(actualPerson)
    ) {
      violations.push('UNSUPPORTED_PERSON_EMITTED');
    }
  }

  if (acceptance.has('needsReview') && !review.needsReview) {
    violations.push('REQUIRED_REVIEW_MISSING');
  }

  if (acceptance.has('phoneNotPostalCode')) {
    const postalCode = normalizePhone(parsed.address?.postalCode);
    const expectedPhones = (expectedCase.fields.phones ?? [])
      .map((phone) => normalizePhone(phone?.number ?? phone))
      .filter(Boolean);
    if (
      postalCode &&
      expectedPhones.some(
        (phone) =>
          phone.startsWith(postalCode) ||
          (
            phone.startsWith('39') &&
            phone.slice(2).startsWith(postalCode)
          )
      )
    ) {
      violations.push('PHONE_PREFIX_USED_AS_POSTAL_CODE');
    }
  }

  if (acceptance.has('claimNotCompany')) {
    const claim = normalizeText(expectedCase.fields.claim);
    if (claim && normalizeText(parsed.company) === claim) {
      violations.push('CLAIM_USED_AS_COMPANY');
    }
  }

  if (acceptance.has('personNeedsReview')) {
    const personIncomplete = valueIsEmpty(parsed.firstName) || valueIsEmpty(parsed.lastName);
    if (
      !review.needsReview ||
      (
        !personIncomplete &&
        !review.fields.has('firstName') &&
        !review.fields.has('lastName')
      )
    ) {
      violations.push('PERSON_REVIEW_MISSING');
    }
  }

  if (acceptance.has('roleOrUnitNotPerson')) {
    const person = normalizeObservedText(
      [parsed.firstName, parsed.lastName].filter(Boolean).join(' ')
    );
    if (
      person &&
      /\b(?:role|unit|office|department|dept|consultants?|management|sales)\b/i.test(
        person
      )
    ) {
      violations.push('ROLE_OR_UNIT_USED_AS_PERSON');
    }
  }

  if (
    acceptance.has('secondaryWebsiteNeedsReview') &&
    !review.needsReview
  ) {
    violations.push('SECONDARY_WEBSITE_REVIEW_MISSING');
  }

  return violations;
}

function safetyViolations(expectedCase, rawText, parsed) {
  const violations = invariantViolations(expectedCase, parsed);

  if (rawText.trim() && contactIsEmpty(parsed)) {
    violations.push('NONEMPTY_RAW_EMPTY_CONTACT');
  }

  if (
    Array.isArray(expectedCase.fields.websites) &&
    expectedCase.fields.websites.length === 0 &&
    !valueIsEmpty(parsed.website)
  ) {
    violations.push('INVENTED_WEBSITE');
  }

  if (addressUsesPhone(expectedCase.fields, parsed)) {
    violations.push('PHONE_USED_AS_ADDRESS');
  }

  if (expectedCase.acceptanceFields.includes('observedNamePreserved')) {
    const firstNamePreserved =
      normalizeObservedText(parsed.firstName) ===
      normalizeObservedText(expectedCase.fields.firstName);
    const lastNamePreserved =
      normalizeObservedText(parsed.lastName) ===
      normalizeObservedText(expectedCase.fields.lastName);
    if (!firstNamePreserved || !lastNamePreserved) {
      violations.push('OBSERVED_NAME_ALTERED');
    }
  }

  return violations;
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function main() {
  const casesDocument = readJson('cases.json');
  const expectedDocument = readJson('expected.json');
  const contacts = readJson('source/contacts.json');

  if (
    casesDocument.datasetId !== DATASET_ID ||
    !Array.isArray(casesDocument.cases) ||
    !Array.isArray(expectedDocument.cases) ||
    !Array.isArray(contacts)
  ) {
    throw new Error('canonical real-device dataset has an invalid shape');
  }

  const expectedByCase = new Map(
    expectedDocument.cases.map((entry) => [entry.caseId, entry])
  );
  const contactById = new Map(
    contacts.map((contact) => [contact.id, contact])
  );
  const rows = [];
  const unreplayable = [];
  const operationalErrors = [];

  for (const caseEntry of casesDocument.cases) {
    const expectedCase = expectedByCase.get(caseEntry.caseId);
    const savedContact = contactById.get(caseEntry.sourceContactId);
    if (!expectedCase || !savedContact) {
      throw new Error('canonical case mapping is incomplete');
    }
    if (expectedCase.sourceContactId !== caseEntry.sourceContactId) {
      throw new Error('canonical expected/source mapping is inconsistent');
    }

    if (caseEntry.rawTextFile === null) {
      if (!EXPECTED_MISSING_RAW.has(caseEntry.caseId)) {
        throw new Error('unexpected missing raw OCR in canonical dataset');
      }
      unreplayable.push(caseEntry.caseId);
      continue;
    }

    const rawPath = resolveSourcePath(caseEntry.rawTextFile);
    if (!existsSync(rawPath)) {
      throw new Error('canonical raw OCR reference is missing');
    }
    const rawText = readFileSync(rawPath, 'utf8');

    try {
      const parsed = parseCardFromPages(pagesFromRawText(rawText));
      const before = scoresForCard(expectedCase, savedContact);
      const after = scoresForCard(expectedCase, parsed);
      const violations = safetyViolations(expectedCase, rawText, parsed);
      const scoredFields = Object.keys(after.fieldScores);
      const unscoredAcceptance = expectedCase.acceptanceFields.filter(
        (field) =>
          !SCOREABLE_FIELDS.has(field) &&
          !SPECIAL_SCORE_FIELDS.has(field) &&
          !AUTOMATED_INVARIANT_FIELDS.has(field) &&
          !DEFERRED_ACCEPTANCE_FIELDS.has(field)
      );
      const deferredAcceptance = expectedCase.acceptanceFields.filter((field) =>
        DEFERRED_ACCEPTANCE_FIELDS.has(field)
      );
      if (unscoredAcceptance.length > 0) {
        throw new Error('canonical acceptance field lacks replay coverage');
      }

      rows.push({
        caseId: caseEntry.caseId,
        baselineStatus: caseEntry.baselineStatus,
        replayStatus: classify(after.aggregate),
        before,
        after,
        scoredFields,
        unscoredAcceptance,
        deferredAcceptance,
        violations,
      });
    } catch {
      operationalErrors.push(caseEntry.caseId);
    }
  }

  const actualMissingRaw = [...unreplayable].sort();
  const expectedMissingRaw = [...EXPECTED_MISSING_RAW].sort();
  if (
    actualMissingRaw.length !== expectedMissingRaw.length ||
    actualMissingRaw.some(
      (caseId, index) => caseId !== expectedMissingRaw[index]
    )
  ) {
    throw new Error('canonical missing-raw set is inconsistent');
  }
  if (
    rows.length + operationalErrors.length !== 25 ||
    unreplayable.length !== 2
  ) {
    throw new Error('canonical replay cardinality is inconsistent');
  }

  console.log('REAL_DEVICE_CARD_REPLAY');
  console.log(`dataset=${DATASET_ID}`);
  console.log(`parser=${PARSER_BUILD_ID}`);
  console.log(`mode=${enforce ? 'ENFORCE' : 'AUDIT'}`);
  console.log('privacy=CASE_ID_AND_FIELD_SCORES_ONLY');
  console.log(
    `cases total=${casesDocument.cases.length} replayed=${rows.length} unreplayable=${unreplayable.length}`
  );
  console.log('scores=before_saved_contact/replay_current_parser');

  for (const row of rows) {
    const fieldScores = row.scoredFields
      .map(
        (field) =>
          `${field}:${percent(row.before.fieldScores[field])}/${percent(
            row.after.fieldScores[field]
          )}`
      )
      .join(',');
    const safety =
      row.violations.length > 0 ? row.violations.join(',') : 'OK';
    console.log(
      `${row.caseId} baseline=${row.baselineStatus} replay=${row.replayStatus} ` +
        `score=${percent(row.before.aggregate)}/${percent(
          row.after.aggregate
        )} fields=${fieldScores} safety=${safety}`
    );
    if (row.unscoredAcceptance.length > 0) {
      console.log(
        `${row.caseId} unscoredAcceptance=${row.unscoredAcceptance.join(',')}`
      );
    }
    if (row.deferredAcceptance.length > 0) {
      console.log(
        `${row.caseId} deferredAcceptance=${row.deferredAcceptance.join(',')}`
      );
    }
  }

  for (const caseId of unreplayable) {
    console.log(`${caseId} UNREPLAYABLE_RAW_MISSING`);
  }
  for (const caseId of operationalErrors) {
    console.log(`${caseId} REPLAY_ERROR`);
  }

  const replaySummary = { PASS: 0, PARTIAL: 0, FAIL: 0 };
  for (const row of rows) replaySummary[row.replayStatus] += 1;
  const violations = rows.flatMap((row) =>
    row.violations.map((code) => ({ caseId: row.caseId, code }))
  );
  const beforeAverage = average(rows.map((row) => row.before.aggregate));
  const afterAverage = average(rows.map((row) => row.after.aggregate));

  console.log('SUMMARY');
  console.log(
    `baseline PASS=${casesDocument.baselineSummary.PASS} ` +
      `PARTIAL=${casesDocument.baselineSummary.PARTIAL} ` +
      `FAIL=${casesDocument.baselineSummary.FAIL}`
  );
  console.log(
    `replay PASS=${replaySummary.PASS} PARTIAL=${replaySummary.PARTIAL} ` +
      `FAIL=${replaySummary.FAIL} UNREPLAYABLE_RAW_MISSING=${unreplayable.length}`
  );
  console.log(
    `averageScore before=${percent(beforeAverage)} replay=${percent(
      afterAverage
    )} delta=${percent(afterAverage) - percent(beforeAverage)}`
  );
  console.log(
    `safety violations=${violations.length} operationalErrors=${operationalErrors.length}`
  );
  for (const violation of violations) {
    console.log(
      `SAFETY_VIOLATION caseId=${violation.caseId} code=${violation.code}`
    );
  }

  if (operationalErrors.length > 0) {
    process.exitCode = 1;
    return;
  }

  if (enforce && violations.length > 0) {
    console.log('ENFORCE=FAIL');
    process.exitCode = 1;
  } else if (enforce) {
    console.log('ENFORCE=PASS');
  }
}

try {
  main();
} catch {
  console.error('REAL_DEVICE_CARD_REPLAY DATASET_OR_RUNTIME_ERROR');
  process.exitCode = 1;
}

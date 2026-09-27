import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const datasetRoot = path.join(
  repoRoot,
  'test-data',
  'real-device-cards-2026-07-31'
);
const sourceRoot = path.join(datasetRoot, 'source');

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(datasetRoot, relativePath), 'utf8'));
}

function sourcePath(relativePath) {
  const resolved = path.resolve(sourceRoot, relativePath);
  assert.ok(
    resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`),
    `source path escapes dataset: ${relativePath}`
  );
  return resolved;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

const contacts = readJson('source/contacts.json');
const manifest = readJson('source/manifest.json');
const casesDocument = readJson('cases.json');
const expectedDocument = readJson('expected.json');
const duplicateDocument = readJson('duplicate-groups.json');
const deviceMetadata = readJson('device-metadata.json');
const archiveMetadata = readJson('source-archive.json');

assert.equal(contacts.length, 27, 'contacts.json must contain 27 contacts');
assert.equal(manifest.contactCount, 27, 'manifest contactCount must be 27');
assert.equal(manifest.contacts.length, 27, 'manifest must index 27 contacts');
assert.equal(new Set(contacts.map((contact) => contact.id)).size, 27);
assert.equal(new Set(manifest.contacts.map((contact) => contact.id)).size, 27);
assert.equal(casesDocument.cases.length, 27, 'cases.json must contain 27 cases');
assert.equal(
  expectedDocument.cases.length,
  27,
  'expected.json must contain 27 manual expectations'
);

const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
const manifestById = new Map(
  manifest.contacts.map((contact) => [contact.id, contact])
);
const expectedByCase = new Map(
  expectedDocument.cases.map((entry) => [entry.caseId, entry])
);

const stableCaseIds = casesDocument.cases.map((entry) => entry.caseId);
assert.deepEqual(
  stableCaseIds,
  Array.from({ length: 27 }, (_, index) => `case-${String(index + 1).padStart(3, '0')}`)
);

const referencedImages = new Set();
const referencedRawFiles = new Set();
const missingRawCaseIds = [];

for (const entry of casesDocument.cases) {
  assert.ok(contactById.has(entry.sourceContactId), `${entry.caseId}: unknown contact`);
  const manifestEntry = manifestById.get(entry.sourceContactId);
  assert.ok(manifestEntry, `${entry.caseId}: missing manifest entry`);
  assert.deepEqual(entry.imageFiles, manifestEntry.cardImageFiles);
  assert.equal(entry.pageCount, entry.imageFiles.length);
  assert.ok(['PASS', 'PARTIAL', 'FAIL'].includes(entry.baselineStatus));
  assert.ok(Array.isArray(entry.errorCategories));
  assert.ok(
    entry.errorCategories.every((category) =>
      ['ocr', 'parser', 'pageCoherence', 'dedupe', 'ui', 'ambiguous'].includes(
        category
      )
    )
  );

  for (const imageFile of entry.imageFiles) {
    assert.ok(existsSync(sourcePath(imageFile)), `${entry.caseId}: ${imageFile}`);
    referencedImages.add(imageFile);
  }

  if (entry.rawTextFile === null) {
    missingRawCaseIds.push(entry.caseId);
    assert.equal(entry.rawTextAvailability, 'missing_from_export');
    assert.equal(contactById.get(entry.sourceContactId).rawText, '');
  } else {
    assert.equal(entry.rawTextFile, manifestEntry.rawTextFile);
    assert.ok(
      existsSync(sourcePath(entry.rawTextFile)),
      `${entry.caseId}: ${entry.rawTextFile}`
    );
    assert.equal(entry.rawTextAvailability, 'aggregated_per_contact');
    referencedRawFiles.add(entry.rawTextFile);
  }

  const expected = expectedByCase.get(entry.caseId);
  assert.ok(expected, `${entry.caseId}: missing manual expectation`);
  assert.equal(expected.sourceContactId, entry.sourceContactId);
  assert.equal(expected.verification.status, 'verified_from_images');
  assert.ok(Array.isArray(expected.verification.ambiguousFields));
  assert.ok(Array.isArray(expected.acceptanceFields));
}

assert.deepEqual(missingRawCaseIds, ['case-005', 'case-016']);

const actualImageFiles = readdirSync(path.join(sourceRoot, 'images'))
  .filter((name) => statSync(path.join(sourceRoot, 'images', name)).isFile())
  .map((name) => `images/${name}`);
const actualRawFiles = readdirSync(path.join(sourceRoot, 'raw-text'))
  .filter((name) => statSync(path.join(sourceRoot, 'raw-text', name)).isFile())
  .map((name) => `raw-text/${name}`);

assert.equal(actualImageFiles.length, 34);
assert.equal(actualRawFiles.length, 25);
assert.deepEqual(new Set(actualImageFiles), referencedImages);
assert.deepEqual(new Set(actualRawFiles), referencedRawFiles);

const imageHashes = actualImageFiles.map((relativePath) =>
  sha256(sourcePath(relativePath))
);
assert.equal(
  new Set(imageHashes).size,
  imageHashes.length,
  'source images must not contain byte-identical duplicates'
);

assert.equal(archiveMetadata.contactCount, 27);
assert.equal(
  archiveMetadata.sha256,
  '0DDE17F1C316DD104C61BFA9D6642DC996B55F837B26CFE1B2212B04001FCED7'
);
assert.equal(deviceMetadata.ocr.perPageRawTextAvailable, false);
assert.ok(
  duplicateDocument.groups.some(
    (group) =>
      group.caseIds.includes('case-016') &&
      group.caseIds.includes('case-027') &&
      group.relationship === 'same_physical_card_rescan'
  ),
  'ATROX rescans must be recorded as a non-destructive duplicate group'
);

console.log(
  'real-device dataset: 27 cases, 34 unique images, 25 raw OCR files — OK'
);

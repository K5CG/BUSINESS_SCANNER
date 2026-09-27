import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesFromRawText } from '../lib/extraction-review.ts';
import { parseCardFromPages } from '../lib/parser.ts';

const PARTIAL_CASES = new Set([
  'case-001','case-003','case-004','case-006','case-010','case-012','case-013',
  'case-020','case-021','case-022','case-023','case-024','case-025','case-026',
]);

const sourceDirectory = process.env.BUSINESS_SCANNER_BUNDLED_SOURCE_DIR
  ? path.resolve(process.env.BUSINESS_SCANNER_BUNDLED_SOURCE_DIR)
  : path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(sourceDirectory, '..');
const datasetRoot = path.join(repositoryRoot, 'test-data', 'real-device-cards-2026-07-31');
const sourceRoot = path.join(datasetRoot, 'source');

const readJson = (name) => JSON.parse(readFileSync(path.join(datasetRoot, name), 'utf8'));
const cases = readJson('cases.json').cases;
const expected = readJson('expected.json').cases;
const contacts = readJson('source/contacts.json');
const expectedByCase = new Map(expected.map(x => [x.caseId, x]));
const contactById = new Map(contacts.map(x => [x.id, x]));

const compactCard = (card) => ({
  firstName: card.firstName ?? null,
  lastName: card.lastName ?? null,
  role: card.role ?? null,
  company: card.company ?? null,
  emails: card.emails ?? [],
  phones: card.phones ?? [],
  website: card.website ?? null,
  address: card.address ?? null,
  addressAlternatives: card.extractionReview?.addressAlternatives ?? [],
  vatNumber: card.vatNumber ?? null,
  taxCode: card.taxCode ?? null,
  needsReview: card.extractionReview?.needsReview ?? false,
  reviewFields: card.extractionReview?.reviewFields ?? [],
  emailEvidence: card.emailEvidence ?? [],
});

const out = [];
for (const c of cases) {
  if (!PARTIAL_CASES.has(c.caseId)) continue;
  const exp = expectedByCase.get(c.caseId);
  const src = contactById.get(c.sourceContactId);
  let rawText = '';
  if (c.rawTextFile) rawText = readFileSync(path.join(sourceRoot, c.rawTextFile), 'utf8');
  else rawText = src?.rawText ?? '';
  const parsed = parseCardFromPages(pagesFromRawText(rawText));
  out.push({
    caseId: c.caseId,
    baselineStatus: c.baselineStatus,
    errorCategories: c.errorCategories,
    acceptanceFields: exp?.acceptanceFields ?? [],
    expected: exp?.fields ?? {},
    actual: compactCard(parsed),
    rawText,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  dataset: 'real-device-cards-2026-07-31',
  partialCount: out.length,
  cases: out,
};
const target = path.join(repositoryRoot, 'PARTIALS_DIAGNOSTIC.json');
writeFileSync(target, JSON.stringify(report, null, 2), 'utf8');
console.log(`PARTIALS_DIAGNOSTIC_OK cases=${out.length}`);
console.log(`Report: ${target}`);

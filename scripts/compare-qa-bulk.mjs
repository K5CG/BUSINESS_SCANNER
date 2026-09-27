/**
 * Confronto bulk QA: actual (nuovo export/reparse) vs expected (revisione manuale).
 *
 * Uso:
 *   npm run compare:qa -- path/to/new-review.json
 *     → expected da scripts/qa/business-scanner-qa-review.json
 *     → actual dal nuovo export review JSON
 *
 *   npm run audit:qa -- --reparse path/to/contacts.json
 *     → rielabora rawText con parser v5 e confronta con expected
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCardV5 } from '../lib/parser-v5/engine.ts';

const __dirname =
  process.env.BUSINESS_SCANNER_BUNDLED_SOURCE_DIR ??
  path.dirname(fileURLToPath(import.meta.url));

const TRUTH_PATH = path.join(__dirname, 'qa', 'business-scanner-qa-review.json');
const ERRORS_CSV_PATH = path.join(__dirname, 'qa', 'business-scanner-qa-errors.csv');

const FIELD_KEYS = [
  'company',
  'firstName',
  'lastName',
  'role',
  'emails',
  'phones',
  'website',
  'address',
  'vatNumber',
  'taxCode',
];

function norm(value) {
  return (value ?? '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fieldValue(contact, field) {
  if (field === 'address') {
    return contact.addressFormatted ?? contact.address?.full ?? contact.fields?.address?.actual ?? '';
  }
  if (field === 'emails') {
    const v = contact.emails ?? contact.fields?.emails?.actual;
    return Array.isArray(v) ? v.join('\n') : (v ?? '');
  }
  if (field === 'phones') {
    const v = contact.phones ?? contact.fields?.phones?.actual;
    if (Array.isArray(v)) {
      return v.map((p) => (typeof p === 'string' ? p : p.type ? `${p.number} (${p.type})` : p.number)).join('\n');
    }
    return v ?? '';
  }
  return contact[field] ?? contact.fields?.[field]?.actual ?? '';
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function pagesFromRawText(rawText) {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) return [{ lines: [], rawText: '' }];
  const pageTexts = trimmed.split(/\n\n+/).filter(Boolean);
  const texts = pageTexts.length ? pageTexts : [trimmed];
  return texts.map((pageText) => ({
    rawText: pageText.trim(),
    lines: pageText
      .split('\n')
      .map((text, lineIndex) => ({
        text: text.trim(),
        confidence: 0.85,
        boundingBox: { x: 30, y: 20 + lineIndex * 18, width: 500, height: 16 },
      }))
      .filter((line) => line.text),
  }));
}

function reparseContacts(contactsPath) {
  const contacts = loadJson(contactsPath);
  const list = Array.isArray(contacts) ? contacts : contacts.contacts ?? Object.values(contacts);
  const out = {};
  for (const c of list) {
    const pages = pagesFromRawText(c.rawText ?? '');
    const r = extractCardV5(pages);
    out[c.id] = {
      fields: {
        company: { actual: r.company.value ?? '' },
        firstName: { actual: r.firstName.value ?? '' },
        lastName: { actual: r.lastName.value ?? '' },
        role: { actual: r.role.value ?? '' },
        emails: { actual: (r.emails.value ?? []).join('\n') },
        phones: {
          actual: (r.phones.value ?? [])
            .map((p) => (p.type ? `${p.number} (${p.type})` : p.number))
            .join('\n'),
        },
        website: { actual: r.website.value ?? '' },
        address: { actual: r.address.value?.full ?? '' },
        vatNumber: { actual: r.vatNumber.value ?? '' },
        taxCode: { actual: r.taxCode.value ?? '' },
      },
    };
  }
  return out;
}

function compareReviews(truth, actualReview) {
  const rows = [];
  let matches = 0;
  let mismatches = 0;
  let regressions = 0;
  let fixed = 0;

  for (const [contactId, truthEntry] of Object.entries(truth)) {
    const actualEntry = actualReview[contactId];
    const title = truthEntry.title ?? contactId;
    for (const field of FIELD_KEYS) {
      const expected = truthEntry.fields?.[field]?.expected ?? '';
      const truthActual = truthEntry.fields?.[field]?.actual ?? '';
      const newActual = actualEntry?.fields?.[field]?.actual ?? fieldValue(actualEntry ?? {}, field);
      if (expected === '' && newActual === '') continue;

      const ok = norm(newActual) === norm(expected);
      const wasOk = norm(truthActual) === norm(expected);

      if (ok) {
        matches++;
        if (!wasOk) fixed++;
      } else {
        mismatches++;
        if (wasOk) regressions++;
        rows.push({
          contactId,
          title,
          field,
          expected,
          before: truthActual,
          after: newActual,
          wasOk,
        });
      }
    }
  }

  return { rows, matches, mismatches, regressions, fixed };
}

function printReport(result) {
  const { rows, matches, mismatches, regressions, fixed } = result;
  console.log('\n=== QA BULK COMPARE ===');
  console.log(`Campi corretti: ${matches}`);
  console.log(`Errori residui: ${mismatches}`);
  console.log(`Risolti (prima errati): ${fixed}`);
  console.log(`Regressioni: ${regressions}`);

  const byField = {};
  for (const row of rows) {
    byField[row.field] = (byField[row.field] ?? 0) + 1;
  }
  if (Object.keys(byField).length) {
    console.log('\nErrori per campo:');
    for (const [field, count] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${field}: ${count}`);
    }
  }

  if (rows.length) {
    console.log('\nPrimi 20 errori:');
    for (const row of rows.slice(0, 20)) {
      console.log(`- [${row.title}] ${row.field}`);
      console.log(`    expected: ${JSON.stringify(row.expected)}`);
      console.log(`    before:   ${JSON.stringify(row.before)}`);
      console.log(`    after:    ${JSON.stringify(row.after)}`);
    }
  }
}

async function main() {
  if (!fs.existsSync(TRUTH_PATH)) {
    console.error('File truth mancante:', TRUTH_PATH);
    process.exit(1);
  }

  const truth = loadJson(TRUTH_PATH);
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      'Uso: npm run compare:qa -- <target.json> oppure npm run audit:qa -- --reparse <export-dir>'
    );
    process.exit(2);
  }

  let actualReview;
  if (args[0] === '--reparse' && args[1]) {
    actualReview = await reparseContacts(path.resolve(args[1]));
  } else if (args[0]) {
    actualReview = loadJson(path.resolve(args[0]));
  }

  const result = compareReviews(truth, actualReview);
  printReport(result);

  if (fs.existsSync(ERRORS_CSV_PATH)) {
    console.log(`\nRiferimento errori CSV: ${ERRORS_CSV_PATH}`);
  }

  process.exit(result.mismatches > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});

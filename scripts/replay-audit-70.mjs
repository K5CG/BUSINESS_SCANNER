/**
 * Replay parser sui 70 contatti QA + confronto con audit CSV.
 *
 * Uso:
 *   node scripts/replay-audit-70.mjs
 *   node scripts/replay-audit-70.mjs scripts/qa-import/export-2026-07-13-v2
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCardFromPages } from '../lib/parser.ts';
import { pagesFromRawText } from '../lib/extraction-review.ts';
import { PARSER_BUILD_ID } from '../lib/parser-version.ts';
import {
  parseStrictSemicolonCsvRows,
  summarizeReplayCoverage,
  writeReplayReport,
} from '../lib/test-suite-contract.ts';

const __dirname =
  process.env.BUSINESS_SCANNER_BUNDLED_SOURCE_DIR ??
  path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] ?? path.join(__dirname, '../tests/fixtures/replay-audit-70'));
const AUDIT_CSV = path.join(__dirname, '../tests/fixtures/replay-audit-70/AUDIT_RESIDUI_70_CONTATTI_2026-07-13_1245.csv');
const EXPECTED_AUDIT_ROWS = 54;

function parseAuditCsv(text) {
  // Il fixture audit-70 è headerless: la prima riga è già un caso reale (n=5).
  // parseStrictSemicolonCsvRows parte invece dalla seconda riga perché supporta
  // CSV con header. Normalizziamo qui il formato senza modificare il contratto
  // comune del parser CSV.
  const firstNonEmpty = text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const firstCell = firstNonEmpty.split(';', 1)[0]?.trim() ?? '';
  const headerless = /^\d+$/.test(firstCell);
  const parsedText = headerless
    ? `__header__\n${text}`
    : text;
  const parsed = parseStrictSemicolonCsvRows(parsedText, 8);
  const rows = [];
  const malformed = parsed.malformed.map((row) => ({
    lineNumber: row.lineNumber,
    reason: `colonne attese 8, trovate ${row.cells.length}`,
  }));

  for (const parsedRow of parsed.rows) {
    const parts = parsedRow.cells;
    const [n, title, field, actual, expected, severity, klass, note] = parts;
    const numericId = Number(n);
    if (!Number.isFinite(numericId) || !title?.trim() || !field?.trim()) {
      malformed.push({
        lineNumber: parsedRow.lineNumber,
        reason: 'id, titolo o campo non valido',
      });
      continue;
    }
    rows.push({
      n: numericId,
      title: title?.trim() ?? '',
      field: field?.trim() ?? '',
      actual: actual?.trim() ?? '',
      expected: expected?.trim() ?? '',
      severity: severity?.trim() ?? '',
      klass: klass?.trim() ?? '',
      note: note?.trim() ?? '',
    });
  }
  return { rows, malformed };
}

function norm(s) {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function fieldValue(card, field) {
  switch (field) {
    case 'person':
      return [card.firstName, card.lastName].filter(Boolean).join(' ').trim();
    case 'firstName':
      return card.firstName ?? '';
    case 'lastName':
      return card.lastName ?? '';
    case 'company':
      return card.company ?? '';
    case 'role':
      return card.role ?? '';
    case 'address': {
      const a = card.address;
      if (!a) return '';
      const structured = [
        [a.street, a.civicNumber].filter(Boolean).join(', '),
        a.postalCode,
        a.city,
        a.region,
        a.country,
      ].filter(Boolean).join(' - ');
      return structured || a.full || '';
    }
    case 'vatNumber':
      return card.vatNumber ?? '';
    case 'taxCode':
      return card.taxCode ?? '';
    default:
      return '';
  }
}

function auditTokens(value) {
  return norm(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bnr\.?\s*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(function(tok) { return tok.length > 1; });
}

function addressMatchesExpected(current, expected) {
  const actualTokens = auditTokens(current);
  const expectedTokens = auditTokens(expected);
  if (!expectedTokens.length) return true;
  if (!actualTokens.length) return false;
  const actualSet = new Set(actualTokens);
  return expectedTokens.every(function(tok) { return actualSet.has(tok); });
}

function matchesExpected(parsed, field, expected) {
  const rawVal = fieldValue(parsed, field);
  const val = norm(rawVal);
  const exp = norm(expected);
  if (!exp) return true;
  if (exp.includes(" da verificare") || exp.includes("leggibile dal biglietto")) {
    return val.length > 0;
  }
  if (field === "address") {
    return addressMatchesExpected(rawVal, expected);
  }
  if (field === "person" || field === "firstName" || field === "lastName") {
    return val.includes(exp) || exp.split(/\s+/).every(function(tok) { return val.includes(tok); });
  }
  return val.includes(exp) || val === exp;
}

function loadContacts() {
  const contactsPath = path.join(ROOT, 'contacts.json');
  return JSON.parse(fs.readFileSync(contactsPath, 'utf8'));
}

function replayContact(c) {
  const rawPath = path.join(ROOT, 'raw-text', `${c.id}.txt`);
  if (!fs.existsSync(rawPath)) return null;
  const raw = fs.readFileSync(rawPath, 'utf8');
  return parseCardFromPages(pagesFromRawText(raw));
}

function findContact(contacts, title) {
  const key = norm(title);
  const exact = contacts.find((c) => norm(c.title) === key);
  if (exact) return exact;

  const companyKey = key.split(' - ')[0] ?? key;
  const prefixMatches = contacts.filter((c) => norm(c.title).startsWith(companyKey));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

function main() {
  const contacts = loadContacts();
  const auditParse = parseAuditCsv(fs.readFileSync(AUDIT_CSV, 'utf8'));
  const audit = auditParse.rows;
  const results = { fixed: [], open: [], skipped: [], missing: [] };

  for (const row of audit) {
    const contact = findContact(contacts, row.title);
    if (!contact) {
      results.missing.push(row);
      continue;
    }
    const parsed = replayContact(contact);
    if (!parsed) {
      results.skipped.push({ row, reason: 'raw-text mancante' });
      continue;
    }

    const ok = matchesExpected(parsed, row.field, row.expected);
    const current = fieldValue(parsed, row.field);
    if (ok) {
      results.fixed.push({ ...row, current });
    } else {
      results.open.push({ ...row, current });
    }
  }

  const accounted =
    results.fixed.length +
    results.open.length +
    results.skipped.length +
    results.missing.length;
  const coverage = summarizeReplayCoverage(
    EXPECTED_AUDIT_ROWS,
    accounted,
    0
  );
  const contractViolations = [
    ...coverage.violations,
    ...auditParse.malformed.map(
      (row) => `CSV riga ${row.lineNumber}: ${row.reason}`
    ),
  ];
  const total = EXPECTED_AUDIT_ROWS;
  const fixed = results.fixed.length;
  const pct = total > 0 ? ((fixed / total) * 100).toFixed(1) : '0.0';

  console.log(`Parser build: ${PARSER_BUILD_ID}`);
  console.log(`Export: ${ROOT}`);
  console.log(`Audit rows: ${total}`);
  console.log(`Replay accounting: ${accounted}/${total} righe classificate`);
  for (const violation of contractViolations) {
    console.error(`REPLAY_CONTRACT_FAILED: ${violation}`);
  }
  console.log(`Risolti/classificati OK: ${fixed}/${total} (${pct}%)`);
  console.log(`Ancora aperti: ${results.open.length}`);
  if (results.missing.length) console.log(`Contatti non trovati: ${results.missing.length}`);
  if (results.skipped.length) console.log(`Senza raw-text: ${results.skipped.length}`);

  const critical = results.open.filter((r) => r.severity === 'critical');
  console.log(`\nCritici ancora aperti (${critical.length}):`);
  for (const r of critical.slice(0, 15)) {
    console.log(`  [${r.field}] ${r.title}`);
    console.log(`    atteso: ${r.expected}`);
    console.log(`    attuale: ${r.current || '(vuoto)'}`);
  }

  console.log('\nAltri aperti (high):');
  for (const r of results.open.filter((x) => x.severity === 'high').slice(0, 12)) {
    console.log(`  [${r.field}] ${r.title} → "${r.current || ''}" (atteso: ${r.expected.slice(0, 60)}...)`);
  }

  const outPath = path.join(ROOT, `replay-audit-${PARSER_BUILD_ID}.json`);
  const report = writeReplayReport(
    outPath,
    {
      build: PARSER_BUILD_ID,
      fixed,
      total,
      results,
      accounting: {
        expected: EXPECTED_AUDIT_ROWS,
        parsed: audit.length,
        classified: accounted,
        malformed: auditParse.malformed,
      },
    },
    (reportPath, contents) => fs.writeFileSync(reportPath, contents)
  );
  if (report.status === 'written') {
    console.log(`\nReport JSON: ${outPath}`);
  } else {
    console.error(
      `\nREPORT_WRITE_FAILED [${report.errorCode}]: ${outPath}` +
        `${report.message ? ` — ${report.message}` : ''}`
    );
    process.exitCode = 1;
  }

  if (total === 0) {
    console.error('REPLAY_RESULT_FAILED: audit vuoto, nessuna metrica valida');
    process.exitCode = 1;
  } else if (Number(pct) < 90) {
    console.error(`REPLAY_RESULT_FAILED: accuratezza ${pct}% sotto il gate 90%`);
    process.exitCode = 1;
  }
  if (contractViolations.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error('REPLAY_UNEXPECTED_ERROR:', error);
  process.exitCode = 1;
}

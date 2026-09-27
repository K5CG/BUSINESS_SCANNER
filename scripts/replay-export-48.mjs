/**
 * Replay locale sui 48 contatti QA + confronto con audit CSV.
 * Uso: node scripts/replay-export-48.mjs [exportDir] [auditCsv]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCardV5 } from '../lib/parser-v5/engine.ts';
import {
  evaluateAddressAudit,
  exactFormattedAddressMatch,
  semanticAddressMatch,
} from '../lib/parser-v5/address-assembly.ts';
import {
  parseReplayAuditRows,
  summarizeReplayCoverage,
} from '../lib/test-suite-contract.ts';

const __dirname =
  process.env.BUSINESS_SCANNER_BUNDLED_SOURCE_DIR ??
  path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const legacyExportDir = 'c:/Users/giova/Downloads/qa-export-1455';
const localExportDir = path.join(projectRoot, 'test-data', 'qa-export-2026-08-12-phone');
const legacyAuditCsv = 'c:/Users/giova/Downloads/AUDIT_RESIDUI_48_CONTATTI_2026-07-12_1455.csv';

function resolveReplayLayout(dir) {
  const flatContacts = path.join(dir, 'contacts.json');
  const nestedContacts = path.join(dir, 'contacts', 'contacts.json');
  if (fs.existsSync(flatContacts)) {
    return { contactsPath: flatContacts, rawTextDir: path.join(dir, 'raw-text') };
  }
  if (fs.existsSync(nestedContacts)) {
    return { contactsPath: nestedContacts, rawTextDir: path.join(dir, 'contacts', 'raw-text') };
  }
  return null;
}

function hasReplayContacts(dir) {
  return resolveReplayLayout(dir) !== null;
}

const exportDir =
  process.argv[2] ??
  (hasReplayContacts(localExportDir) ? localExportDir : legacyExportDir);
const auditCsv = process.argv[3] ?? legacyAuditCsv;

function parseRawTextPages(raw) {
  const chunks = raw.split(/\n---+\s*page\s*\d+\s*---+\n/i);
  if (chunks.length > 1) {
    return chunks.slice(1).map((chunk, page) => ({
      rawText: chunk.trim(),
      lines: chunk
        .split('\n')
        .map((text, indexInPage) => ({
          text: text.trim(),
          confidence: 0.85,
          boundingBox: { x: 30, y: 20 + indexInPage * 16, width: 500, height: 14 },
        }))
        .filter((l) => l.text),
      page,
    }));
  }
  const lines = raw
    .split('\n')
    .map((text, indexInPage) => ({
      text: text.trim(),
      confidence: 0.85,
      boundingBox: { x: 30, y: 20 + indexInPage * 16, width: 500, height: 14 },
    }))
    .filter((l) => l.text);
  return [{ rawText: raw.trim(), lines, page: 0 }];
}

function norm(s) {
  return (s ?? '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fieldOk(field, actual, expected) {
  if (!expected?.trim()) {
    const empty = Array.isArray(actual) ? actual.length === 0 : !String(actual ?? '').trim();
    return { ok: empty, note: empty ? 'empty ok' : 'unexpected value' };
  }
  const a = norm(actual);
  const e = norm(expected);
  if (!e) return { ok: true, note: 'no expected' };
  if (field === 'emails' || field.startsWith('emails')) {
    const list = Array.isArray(actual) ? actual : [actual].filter(Boolean);
    const ok = list.map((x) => norm(x)).some((x) => x.includes(e) || e.includes(x));
    return { ok, note: ok ? 'match' : 'no email match' };
  }
  if (field === 'address') {
    const actualStr = typeof actual === 'string' ? actual : String(actual ?? '');
    const segments = expected
      .split(/;+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const candidates = segments.length ? segments : [expected];
    let semantic = false;
    let exact = false;
    for (const seg of candidates) {
      if (semanticAddressMatch(actualStr, seg)) semantic = true;
      if (exactFormattedAddressMatch(actualStr, seg)) exact = true;
    }
    if (semantic) return { ok: true, note: exact ? 'exact' : 'semantic' };
    return { ok: false, note: 'address mismatch (semantic+exact)' };
  }
  if (field.includes('/')) {
    const combined = norm(actual);
    const ok = e.split(/\s+/).every((part) => part.length >= 3 && combined.includes(part));
    return { ok, note: ok ? 'match' : 'mismatch' };
  }
  const ok = a.includes(e) || e.includes(a);
  return { ok, note: ok ? 'match' : 'mismatch' };
}

function isModelNoteExpected(expected) {
  return /must be selected|do not use location token|personal office\/company address must/i.test(
    expected ?? ''
  );
}

function loadAuditRows(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  return parseReplayAuditRows(fs.readFileSync(csvPath, 'utf8'));
}

const replayLayout = resolveReplayLayout(exportDir);
if (!replayLayout) {
  console.error(`Export non trovato: ${path.join(exportDir, 'contacts.json')} oppure ${path.join(exportDir, 'contacts', 'contacts.json')}`);
  process.exit(1);
}

const contacts = JSON.parse(fs.readFileSync(replayLayout.contactsPath, 'utf8'));
const auditRows = loadAuditRows(auditCsv);

const stats = {
  company: { before: 0, after: 0, total: 0 },
  firstName: { before: 0, after: 0, total: 0 },
  lastName: { before: 0, after: 0, total: 0 },
  address: { before: 0, after: 0, total: 0, semanticAfter: 0, exactAfter: 0, passAfter: 0, modelNotes: 0 },
  emails: { before: 0, after: 0, total: 0 },
};

const summary = { resolved: 0, improved: 0, unchanged: 0, regressions: 0 };
const regressions = [];
const fixes = [];
const addressDetails = [];
let executedAuditRows = 0;
let replayedContacts = 0;

for (const c of contacts) {
  const rawPath = path.join(replayLayout.rawTextDir, `${c.id}.txt`);
  if (!fs.existsSync(rawPath)) continue;
  const raw = fs.readFileSync(rawPath, 'utf8');
  const pages = parseRawTextPages(raw).map((p, i) => ({ ...p, page: i }));
  const parsed = extractCardV5(pages);
  replayedContacts += 1;

  const parsedFlat = {
    company: parsed.company.value ?? '',
    firstName: parsed.firstName.value ?? '',
    lastName: parsed.lastName.value ?? '',
    address: parsed.address.value?.full ?? '',
    emails: parsed.emails.value ?? [],
  };

  const cardAudit = auditRows.filter((r) => r.title === c.title);
  for (const row of cardAudit) {
    const fieldKey = row.field.includes('/') ? row.field.split('/')[0] : row.field;
    if (!stats[fieldKey]) {
      console.error(`REPLAY_UNSUPPORTED_FIELD: ${row.title} [${row.field}]`);
      continue;
    }
    executedAuditRows += 1;
    stats[fieldKey].total += 1;
    const beforeOk = fieldOk(fieldKey, row.actual, row.expected).ok;
    const afterVal =
      fieldKey === 'emails' ? parsedFlat.emails : parsedFlat[fieldKey] ?? '';
    const afterCheck = fieldOk(fieldKey, afterVal, row.expected);
    const afterOk = afterCheck.ok;
    if (fieldKey === 'address') {
      if (isModelNoteExpected(row.expected)) {
        stats.address.modelNotes += 1;
        addressDetails.push({
          title: c.title,
          expected: row.expected,
          before: row.actual,
          after: afterVal,
          semantic: false,
          exact: false,
          contaminated: false,
          completeness: parsed.address.value?.completeness ?? 0,
          pass: false,
          modelNote: true,
        });
        continue;
      }

      const verdict = evaluateAddressAudit(parsed.address.value, row.expected);
      if (verdict.semantic) stats.address.semanticAfter += 1;
      if (verdict.exact) stats.address.exactAfter += 1;
      if (verdict.pass) stats.address.passAfter += 1;
      addressDetails.push({
        title: c.title,
        expected: row.expected,
        before: row.actual,
        after: afterVal,
        semantic: verdict.semantic,
        exact: verdict.exact,
        contaminated: verdict.contaminated,
        completeness: verdict.completeness,
        pass: verdict.pass,
        modelNote: false,
      });

      const afterOk = verdict.pass;
      if (beforeOk) stats[fieldKey].before += 1;
      if (afterOk) stats[fieldKey].after += 1;
      if (!beforeOk && afterOk) {
        fixes.push({ title: c.title, field: row.field, expected: row.expected, after: afterVal });
        summary.improved += 1;
        summary.resolved += 1;
      } else if (beforeOk && afterOk) {
        summary.unchanged += 1;
      } else if (beforeOk && !afterOk) {
        regressions.push({
          title: c.title,
          field: row.field,
          before: row.actual,
          after: afterVal,
          expected: row.expected,
        });
        summary.regressions += 1;
      }
      continue;
    }

    if (beforeOk) stats[fieldKey].before += 1;
    if (afterOk) stats[fieldKey].after += 1;

    if (!beforeOk && afterOk) {
      fixes.push({ title: c.title, field: row.field, expected: row.expected, after: afterVal });
      summary.improved += 1;
      summary.resolved += 1;
    } else if (beforeOk && afterOk) {
      summary.unchanged += 1;
    } else if (beforeOk && !afterOk) {
      regressions.push({
        title: c.title,
        field: row.field,
        before: row.actual,
        after: afterVal,
        expected: row.expected,
      });
      summary.regressions += 1;
    }
  }
}

console.log('\n=== REPLAY 48 CONTATTI ===');
console.log(`Export: ${exportDir}`);
console.log(`Audit:  ${auditCsv}`);
console.log('\ncampo | corretti prima | corretti dopo | audit rows');
for (const [field, s] of Object.entries(stats)) {
  if (!s.total) continue;
  if (field === 'address') {
    console.log(
      `${field} | ${s.before} | ${s.after} (semantic: ${s.semanticAfter}, exact: ${s.exactAfter}, PASS: ${s.passAfter}, note modello: ${s.modelNotes}) | ${s.total}`
    );
  } else {
    console.log(`${field} | ${s.before} | ${s.after} | ${s.total}`);
  }
}

console.log('\n--- Tabella replay ---');
console.log(`risolti: ${summary.resolved} | migliorati: ${summary.improved} | invariati: ${summary.unchanged} | regressioni: ${summary.regressions}`);

console.log(`\nFix audit (${fixes.length}):`);
for (const f of fixes.slice(0, 15)) {
  console.log(`  + ${f.title} [${f.field}] → ${JSON.stringify(f.after).slice(0, 80)}`);
}
if (fixes.length > 15) console.log(`  ... +${fixes.length - 15} altri`);

console.log(`\nRegressioni (${regressions.length}):`);
for (const r of regressions) {
  console.log(`  - ${r.title} [${r.field}] "${r.before}" → "${r.after}" (atteso: ${r.expected})`);
}

console.log('\n--- Address audit (semantic / exact / contamination / completeness) ---');
for (const a of addressDetails) {
  if (a.modelNote) {
    console.log(`  ${a.title}: MODEL_NOTE (atteso non è indirizzo) | "${a.expected.slice(0, 60)}..."`);
    continue;
  }
  console.log(
    `  ${a.title}: PASS=${a.pass ? 'OK' : 'NO'} semantic=${a.semantic ? 'OK' : 'NO'} exact=${a.exact ? 'OK' : 'NO'} contaminated=${a.contaminated ? 'YES' : 'no'} completeness=${a.completeness.toFixed(2)} | atteso="${a.expected.slice(0, 55)}" | dopo="${(a.after ?? '').slice(0, 65)}"`
  );
}

if (auditRows.length === 0) {
  console.log();
  console.log("Replay accounting: " + replayedContacts + "/" + contacts.length + " contatti riprocessati; audit CSV non disponibile");
  if (replayedContacts === 0) {
    console.error("REPLAY_CONTRACT_FAILED: nessun contatto riprocessabile");
    process.exit(1);
  }
  process.exit(0);
}

const replayCoverage = summarizeReplayCoverage(
  auditRows.length,
  executedAuditRows,
  regressions.length
);
console.log(
  "\nReplay accounting: " + replayCoverage.executed + "/" + replayCoverage.expected + " casi eseguiti"
);
for (const violation of replayCoverage.violations) {
  console.error("REPLAY_CONTRACT_FAILED: " + violation);
}
process.exit(replayCoverage.exitCode);
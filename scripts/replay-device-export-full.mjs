/**
 * Audit completo export device: replay iter19 vs export device + euristiche OCR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCardFromPages } from '../lib/parser.ts';
import { pagesFromRawText } from '../lib/extraction-review.ts';
import { PARSER_BUILD_ID } from '../lib/parser-version.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] ?? path.join(__dirname, 'qa-import/export-2026-07-14-device'));

const contacts = JSON.parse(fs.readFileSync(path.join(ROOT, 'contacts.json'), 'utf8'));

function norm(s) {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function person(parsed) {
  return [parsed.firstName, parsed.lastName].filter(Boolean).join(' ').trim();
}

function flagIssues(c, parsed, raw) {
  const flags = [];
  const review = c.extractionReview ?? {};
  const conf = c.confidence ?? {};

  if (!parsed.firstName?.trim()) flags.push({ sev: 'critical', code: 'no-firstName', msg: 'Nome vuoto' });
  if (!parsed.lastName?.trim()) flags.push({ sev: 'high', code: 'no-lastName', msg: 'Cognome vuoto' });
  if (!parsed.emails?.length) flags.push({ sev: 'critical', code: 'no-email', msg: 'Email vuota' });
  if (!parsed.company?.trim()) flags.push({ sev: 'critical', code: 'no-company', msg: 'Azienda vuota' });
  if (!parsed.role?.trim()) flags.push({ sev: 'medium', code: 'no-role', msg: 'Ruolo vuoto' });

  // Export device aveva needsReview
  if (c.extractionReview?.needsReview) {
    for (const f of c.extractionReview.reviewFields ?? []) {
      flags.push({ sev: 'medium', code: 'device-review', msg: `Device segnalava review: ${f}` });
    }
  }

  // Confidence bassa nel export device
  for (const [field, score] of Object.entries(conf)) {
    if (typeof score === 'number' && score <= 0.15 && ['firstName', 'lastName', 'company', 'role'].includes(field)) {
      const val = c[field] ?? (field === 'emails' ? c.emails?.[0] : '');
      if (!val || (Array.isArray(val) && !val.length)) {
        flags.push({ sev: 'high', code: 'low-conf-empty', msg: `Device: ${field} conf ${score} e vuoto` });
      }
    }
  }

  // Email nel raw ma non estratta
  const rawEmails = raw.match(/[a-z0-9][a-z0-9._%+\-]*@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? [];
  const rawEmailish = raw.match(/(?:e-?mail|pec)\s*[.:\-]?\s*[a-z0-9@.\s\-]{4,}/gi) ?? [];
  if (!parsed.emails?.length && (rawEmails.length || rawEmailish.length)) {
    flags.push({ sev: 'critical', code: 'email-in-raw', msg: `Email visibile in OCR ma non estratta: ${(rawEmails[0] ?? rawEmailish[0] ?? '').slice(0, 50)}` });
  }

  // Nome CAPS nel raw (2+ parole title/caps) ma persona vuota/incompleta
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (t.length < 6 || t.length > 40) continue;
    if (/@|www\.|tel|fax|\d{5}/i.test(t)) continue;
    if (/^[A-ZÀ-Ü][a-zà-ü]+\s+[A-ZÀ-Ü][a-zà-ü]+/.test(t) || /^[A-ZÀ-Ü]{4,}\s+[A-ZÀ-Ü]{4,}$/.test(t)) {
      if (!parsed.firstName?.trim() || !parsed.lastName?.trim()) {
        if (!person(parsed).toLowerCase().includes(t.split(/\s+/)[0]?.toLowerCase() ?? '')) {
          flags.push({ sev: 'high', code: 'name-in-raw', msg: `Possibile nome in OCR non estratto: "${t.slice(0, 45)}"` });
          break;
        }
      }
    }
  }

  // Company sospetta (token generico, troppo corto)
  const co = parsed.company ?? '';
  if (co && /^(?:technical|sports|informatica|infcrm|development|manufacturer)$/i.test(co.trim())) {
    flags.push({ sev: 'high', code: 'weak-company', msg: `Azienda generica/sospetta: "${co}"` });
  }
  if (co && co.length <= 12 && !/\b(?:srl|spa|ltd|gmbh|inc|co\.|s\.r\.l)/i.test(co)) {
    flags.push({ sev: 'medium', code: 'short-company', msg: `Azienda corta senza forma giuridica: "${co}"` });
  }

  // Miglioramento iter19 vs export device (informativo)
  const devicePerson = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  const newPerson = person(parsed);
  if (!devicePerson && newPerson) {
    flags.push({ sev: 'info', code: 'fixed-person', msg: `FIX iter19: persona "${newPerson}"` });
  } else if (devicePerson && !newPerson) {
    flags.push({ sev: 'critical', code: 'regression-person', msg: `REGRESSIONE: device aveva "${devicePerson}"` });
  }

  const deviceEmail = c.emails?.[0] ?? '';
  const newEmail = parsed.emails?.[0] ?? '';
  if (!deviceEmail && newEmail) {
    flags.push({ sev: 'info', code: 'fixed-email', msg: `FIX iter19: email "${newEmail}"` });
  } else if (deviceEmail && !newEmail) {
    flags.push({ sev: 'critical', code: 'regression-email', msg: `REGRESSIONE: device aveva "${deviceEmail}"` });
  }

  return flags;
}

const rows = [];

for (const c of contacts) {
  const rawPath = path.join(ROOT, 'raw-text', `${c.id}.txt`);
  if (!fs.existsSync(rawPath)) {
    rows.push({ title: c.title, id: c.id, skip: true, flags: [{ sev: 'critical', msg: 'raw-text mancante' }] });
    continue;
  }
  const raw = fs.readFileSync(rawPath, 'utf8');
  const parsed = parseCardFromPages(pagesFromRawText(raw));
  const flags = flagIssues(c, parsed, raw);

  rows.push({
    title: c.title ?? c.id.slice(0, 8),
    id: c.id,
    device: {
      person: [c.firstName, c.lastName].filter(Boolean).join(' ') || '(vuoto)',
      company: c.company || '(vuoto)',
      role: c.role || '(vuoto)',
      emails: c.emails?.join(', ') || '(vuoto)',
    },
    iter19: {
      person: person(parsed) || '(vuoto)',
      company: parsed.company || '(vuoto)',
      role: parsed.role || '(vuoto)',
      emails: parsed.emails?.join(', ') || '(vuoto)',
      website: parsed.website || '',
    },
    flags,
  });
}

const critical = rows.filter((r) => r.flags.some((f) => f.sev === 'critical'));
const high = rows.filter((r) => r.flags.some((f) => f.sev === 'high') && !r.flags.some((f) => f.sev === 'critical'));
const medium = rows.filter((r) => r.flags.some((f) => f.sev === 'medium') && !r.flags.some((f) => ['critical', 'high'].includes(f.sev)));
const ok = rows.filter((r) => !r.flags.some((f) => ['critical', 'high', 'medium'].includes(f.sev)));
const fixed = rows.filter((r) => r.flags.some((f) => f.code?.startsWith('fixed')));

console.log(`\n=== AUDIT COMPLETO 30 BIGLIETTI ===`);
console.log(`Parser: ${PARSER_BUILD_ID}`);
console.log(`Export: ${ROOT}\n`);
console.log(`OK (nessun flag):        ${ok.length}`);
console.log(`Con problemi MEDIUM:     ${medium.length}`);
console.log(`Con problemi HIGH:       ${high.length}`);
console.log(`Con problemi CRITICAL:   ${critical.length}`);
console.log(`Migliorati vs device:    ${fixed.length}`);

function printGroup(label, list) {
  if (!list.length) return;
  console.log(`\n--- ${label} (${list.length}) ---`);
  for (const r of list) {
    console.log(`\n▸ ${r.title}`);
    console.log(`  DEVICE:  ${r.device.person} | ${r.device.company} | ${r.device.emails}`);
    console.log(`  ITER19:  ${r.iter19.person} | ${r.iter19.company} | ${r.iter19.emails}`);
    for (const f of r.flags.filter((x) => x.sev !== 'info')) {
      console.log(`  [${f.sev.toUpperCase()}] ${f.msg}`);
    }
    const infos = r.flags.filter((x) => x.sev === 'info');
    if (infos.length) console.log(`  (fix: ${infos.map((i) => i.msg).join('; ')})`);
  }
}

printGroup('CRITICAL', critical);
printGroup('HIGH', high);
printGroup('MEDIUM (ruolo vuoto / review)', medium);

console.log('\n--- RIEPILOGO TUTTI I 30 ---');
for (const r of rows) {
  const sev = r.flags.some((f) => f.sev === 'critical') ? 'CRIT'
    : r.flags.some((f) => f.sev === 'high') ? 'HIGH'
    : r.flags.some((f) => f.sev === 'medium') ? 'MED '
    : ' OK ';
  console.log(`${sev} | ${r.title.padEnd(28)} | ${r.iter19.person.padEnd(22)} | ${(r.iter19.company ?? '').slice(0, 28)}`);
}

const outPath = path.join(ROOT, `full-audit-${PARSER_BUILD_ID}.json`);
fs.writeFileSync(outPath, JSON.stringify({ build: PARSER_BUILD_ID, rows }, null, 2));
console.log(`\nJSON: ${outPath}`);

if (critical.length + high.length > 0) process.exitCode = 1;

/**
 * Audit export device (valori salvati in contacts.json) + confronto con export precedente.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCardFromPages } from '../lib/parser.ts';
import { pagesFromRawText } from '../lib/extraction-review.ts';
import { PARSER_BUILD_ID } from '../lib/parser-version.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] ?? path.join(__dirname, 'qa-import/export-2026-07-14-reparse'));
const PREV = path.resolve(process.argv[3] ?? path.join(__dirname, 'qa-import/export-2026-07-14-device'));

function person(c) {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
}

function loadExport(dir) {
  const p = path.join(dir, 'contacts.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function auditContact(c, raw) {
  const flags = [];
  if (!c.firstName?.trim()) flags.push({ sev: 'critical', msg: 'Nome vuoto' });
  if (!c.lastName?.trim()) flags.push({ sev: 'high', msg: 'Cognome vuoto' });
  if (!c.emails?.length) flags.push({ sev: 'critical', msg: 'Email vuota' });
  if (!c.company?.trim()) flags.push({ sev: 'critical', msg: 'Azienda vuota' });
  if (!c.role?.trim()) flags.push({ sev: 'medium', msg: 'Ruolo vuoto' });

  for (const e of c.emails ?? []) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      flags.push({ sev: 'critical', msg: `Email malformata: ${e}` });
    }
    if (/www\.|\.itwww|\.comwww/i.test(e)) {
      flags.push({ sev: 'critical', msg: `Email fusa con sito: ${e}` });
    }
  }

  const review = c.extractionReview;
  if (review?.needsReview) {
    for (const f of review.reviewFields ?? []) {
      flags.push({ sev: 'medium', msg: `In review: ${f}` });
    }
  }

  if (raw) {
    const rawEmails = raw.match(/[a-z0-9][a-z0-9._%+\-]*@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? [];
    if (!c.emails?.length && rawEmails.length) {
      flags.push({ sev: 'critical', msg: `OCR ha email ma export no: ${rawEmails[0]}` });
    }
    const labelEmail = raw.match(/(?:e-?mail|pec)\s*[.:\-]?\s*([a-z0-9@.\s\-]{5,})/i);
    if (!c.emails?.length && labelEmail) {
      flags.push({ sev: 'critical', msg: `Label email in OCR: ${labelEmail[0].slice(0, 45)}` });
    }
  }

  // Replay drift: export diverso dal parser attuale
  if (raw) {
    const replay = parseCardFromPages(pagesFromRawText(raw));
    const drift = [];
    if (norm(person(c)) !== norm(person(replay))) drift.push(`persona export="${person(c)}" replay="${person(replay)}"`);
    if (norm(c.company) !== norm(replay.company)) drift.push(`company export="${c.company}" replay="${replay.company}"`);
    const e0 = c.emails?.[0] ?? '';
    const r0 = replay.emails?.[0] ?? '';
    if (norm(e0) !== norm(r0)) drift.push(`email export="${e0}" replay="${r0}"`);
    if (drift.length) flags.push({ sev: 'high', msg: `Drift export↔replay: ${drift.join(' | ')}` });
  }

  return flags;
}

function norm(s) {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const contacts = loadExport(ROOT);
const prevContacts = loadExport(PREV);
const prevById = new Map((prevContacts ?? []).map((c) => [c.id, c]));

console.log(`\n=== AUDIT EXPORT DEVICE ===`);
console.log(`Parser atteso: ${PARSER_BUILD_ID}`);
console.log(`Export: ${ROOT}`);
console.log(`Contatti: ${contacts?.length ?? 0}`);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
console.log(`Parser in manifest: ${manifest.parserBuildId}`);

const rows = [];
for (const c of contacts ?? []) {
  const rawPath = path.join(ROOT, 'raw-text', `${c.id}.txt`);
  const raw = fs.existsSync(rawPath) ? fs.readFileSync(rawPath, 'utf8') : '';
  const flags = auditContact(c, raw);
  const prev = prevById.get(c.id);
  const improved = [];
  if (prev) {
    if (!person(prev) && person(c)) improved.push('persona');
    if (!prev.emails?.length && c.emails?.length) improved.push('email');
    if (!prev.company?.trim() && c.company?.trim()) improved.push('company');
    if (!prev.role?.trim() && c.role?.trim()) improved.push('ruolo');
  }
  rows.push({
    title: c.title ?? c.id.slice(0, 8),
    id: c.id,
    person: person(c) || '(vuoto)',
    company: c.company || '(vuoto)',
    role: c.role || '(vuoto)',
    emails: c.emails?.join(', ') || '(vuoto)',
    flags,
    improved,
  });
}

const crit = rows.filter((r) => r.flags.some((f) => f.sev === 'critical'));
const high = rows.filter((r) => r.flags.some((f) => f.sev === 'high') && !r.flags.some((f) => f.sev === 'critical'));
const med = rows.filter((r) => r.flags.some((f) => f.sev === 'medium') && !r.flags.some((f) => ['critical', 'high'].includes(f.sev)));
const ok = rows.filter((r) => !r.flags.some((f) => ['critical', 'high', 'medium'].includes(f.sev)));

console.log(`\nOK: ${ok.length} | MEDIUM: ${med.length} | HIGH: ${high.length} | CRITICAL: ${crit.length}`);

const keyIds = {
  gandh: '11ee96f8-d42b-4c7e-8cde-73f7da4bf60c',
  software4u: 'dbd27768-80dc-49ed-8f3a-2aa8077fb460',
  domofacile: '60f5405e-cc6d-4f89-afdc-94fe0f60428b',
};

console.log('\n--- CASI CRITICI UTENTE ---');
for (const [label, id] of Object.entries(keyIds)) {
  const r = rows.find((x) => x.id === id);
  if (!r) { console.log(`${label}: NON TROVATO`); continue; }
  const prev = prevById.get(id);
  console.log(`\n▸ ${label.toUpperCase()} — ${r.title}`);
  console.log(`  PRIMA:  ${person(prev ?? {}) || '(vuoto)'} | ${prev?.company ?? ''} | ${prev?.emails?.join(', ') ?? '(vuoto)'} | ${prev?.role ?? ''}`);
  console.log(`  ORA:    ${r.person} | ${r.company} | ${r.emails} | ${r.role}`);
  for (const f of r.flags) console.log(`  [${f.sev}] ${f.msg}`);
}

function printGroup(label, list) {
  if (!list.length) return;
  console.log(`\n--- ${label} (${list.length}) ---`);
  for (const r of list) {
    console.log(`\n▸ ${r.title}`);
    console.log(`  ${r.person} | ${r.company} | ${r.emails}`);
    for (const f of r.flags.filter((x) => x.sev !== 'medium' || !x.msg.startsWith('In review'))) {
      if (f.sev === 'medium' && f.msg === 'Ruolo vuoto') continue;
      console.log(`  [${f.sev}] ${f.msg}`);
    }
    if (r.improved.length) console.log(`  ✓ Migliorato vs export 06:41: ${r.improved.join(', ')}`);
  }
}

printGroup('CRITICAL', crit);
printGroup('HIGH (cognome/drift/review)', high.filter((r) => !keyIds.gandh && !keyIds.software4u && !keyIds.domofacile || !Object.values(keyIds).includes(r.id)));

console.log('\n--- TABELLA 30 CONTATTI ---');
for (const r of rows.sort((a, b) => a.title.localeCompare(b.title))) {
  const sev = r.flags.some((f) => f.sev === 'critical') ? 'CRIT'
    : r.flags.some((f) => f.sev === 'high') ? 'HIGH'
    : r.flags.some((f) => f.sev === 'medium') ? 'MED '
    : ' OK ';
  console.log(`${sev} | ${r.title.slice(0, 32).padEnd(32)} | ${r.person.slice(0, 22).padEnd(22)} | ${(r.company ?? '').slice(0, 26)}`);
}

const out = path.join(ROOT, 'audit-export-report.json');
fs.writeFileSync(out, JSON.stringify({ build: manifest.parserBuildId, rows }, null, 2));
console.log(`\nReport: ${out}`);

if (crit.length) process.exitCode = 1;

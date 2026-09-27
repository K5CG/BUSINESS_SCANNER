import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exportDir = process.argv[2];
if (!exportDir) {
  console.error('Usage: node compare-export-once.mjs <export-dir>');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'qa/business-scanner-qa-review.json'), 'utf8'));
const contacts = JSON.parse(fs.readFileSync(path.join(exportDir, 'contacts.json'), 'utf8'));

const fields = ['company', 'firstName', 'lastName', 'role', 'emails', 'phones', 'website', 'address', 'vatNumber', 'taxCode'];
const norm = (v) =>
  (v ?? '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function get(c, f) {
  if (f === 'address') return c.address?.full ?? c.addressFormatted ?? '';
  if (f === 'emails') return (c.emails ?? []).join('\n');
  if (f === 'phones')
    return (c.phones ?? [])
      .map((p) => (p.type ? `${p.number} (${p.type})` : p.number))
      .join('\n');
  return c[f] ?? '';
}

let ok = 0;
let bad = 0;
let fixed = 0;
let reg = 0;
const byField = {};
const rows = [];

for (const c of contacts) {
  const t = truth[c.id];
  if (!t) continue;
  for (const f of fields) {
    const exp = t.fields?.[f]?.expected ?? '';
    const before = t.fields?.[f]?.actual ?? '';
    const after = get(c, f);
    if (exp === '' && after === '') continue;
    const match = norm(after) === norm(exp);
    const wasOk = norm(before) === norm(exp);
    if (match) {
      ok++;
      if (!wasOk) fixed++;
    } else {
      bad++;
      if (wasOk) reg++;
      byField[f] = (byField[f] ?? 0) + 1;
      rows.push({ id: c.id, title: c.title ?? t.title, field: f, exp, before, after, wasOk });
    }
  }
}

console.log('Export:', path.basename(exportDir));
console.log('Contatti export:', contacts.length);
console.log('Campi corretti:', ok);
console.log('Errori residui:', bad);
console.log('Risolti (prima errati):', fixed);
console.log('Regressioni:', reg);
console.log('Per campo:', byField);

const addr = rows.filter((r) => r.field === 'address');
console.log('\n--- Indirizzi risolti:', addr.filter((r) => !r.wasOk && norm(r.after) === norm(r.exp)).length, '---');
for (const r of addr.filter((r) => !r.wasOk && norm(r.after) === norm(r.exp))) {
  console.log(`+ [${r.title}]`);
  console.log(`    prima: ${r.before}`);
  console.log(`    ora:   ${r.after}`);
}

console.log('\n--- Indirizzi ancora errati:', addr.filter((r) => norm(r.after) !== norm(r.exp)).length, '---');
for (const r of addr.filter((r) => norm(r.after) !== norm(r.exp))) {
  console.log(`- [${r.title}]`);
  console.log(`    atteso: ${r.exp}`);
  console.log(`    prima:  ${r.before}`);
  console.log(`    ora:    ${r.after}`);
}

console.log('\n--- Regressioni ---');
for (const r of rows.filter((r) => r.wasOk && norm(r.after) !== norm(r.exp)).slice(0, 20)) {
  console.log(`! [${r.title}] ${r.field}: "${r.before}" -> "${r.after}"`);
}

console.log('\n--- Altri fix significativi ---');
for (const r of rows.filter((r) => !r.wasOk && norm(r.after) === norm(r.exp) && r.field !== 'address').slice(0, 25)) {
  console.log(`+ [${r.title}] ${r.field}: "${r.before}" -> "${r.after}"`);
}

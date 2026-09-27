import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'qa/business-scanner-qa-review.json'), 'utf8'));
const contacts = JSON.parse(fs.readFileSync(path.join(__dirname, 'qa/latest-export/contacts.json'), 'utf8'));

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

console.log('Contatti export:', contacts.length);
console.log('Campi corretti:', ok);
console.log('Errori residui:', bad);
console.log('Risolti (prima errati):', fixed);
console.log('Regressioni:', reg);
console.log('Per campo:', byField);

const improved = rows.filter((r) => !r.wasOk && norm(r.after) === norm(r.exp));
console.log('\n--- Risolti (' + improved.length + ') ---');
for (const r of improved.slice(0, 30)) {
  console.log(`- [${r.title}] ${r.field}: "${r.before}" → "${r.after}"`);
}

console.log('\n--- Errori residui (' + rows.filter((r) => norm(r.after) !== norm(r.exp)).length + ') ---');
for (const r of rows.filter((x) => norm(x.after) !== norm(x.exp)).slice(0, 30)) {
  console.log(`- [${r.title}] ${r.field}`);
  console.log(`    expected: ${JSON.stringify(r.exp)}`);
  console.log(`    before:   ${JSON.stringify(r.before)}`);
  console.log(`    after:    ${JSON.stringify(r.after)}`);
}

process.exit(bad > 0 ? 1 : 0);

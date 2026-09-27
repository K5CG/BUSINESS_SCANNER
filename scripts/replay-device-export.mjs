/**
 * Replay parser su export device e riepilogo campi critici vuoti.
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
const issues = [];

for (const c of contacts) {
  const rawPath = path.join(ROOT, 'raw-text', `${c.id}.txt`);
  if (!fs.existsSync(rawPath)) continue;
  const raw = fs.readFileSync(rawPath, 'utf8');
  const parsed = parseCardFromPages(pagesFromRawText(raw));
  const missing = [];
  if (!parsed.firstName?.trim()) missing.push('firstName');
  if (!parsed.lastName?.trim()) missing.push('lastName');
  if (!parsed.emails?.length) missing.push('email');
  if (!parsed.company?.trim()) missing.push('company');
  if (missing.length) {
    issues.push({
      title: c.title ?? c.id.slice(0, 8),
      id: c.id,
      missing,
      parsed: {
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        company: parsed.company,
        role: parsed.role,
        emails: parsed.emails,
      },
    });
  }
}

console.log(`Parser: ${PARSER_BUILD_ID}`);
console.log(`Export: ${ROOT}`);
console.log(`Contatti: ${contacts.length}`);
console.log(`Con campi critici vuoti: ${issues.length}`);
for (const i of issues) {
  console.log(`\n- ${i.title}`);
  console.log(`  manca: ${i.missing.join(', ')}`);
  console.log(`  →`, JSON.stringify(i.parsed));
}

if (issues.length) process.exitCode = 1;

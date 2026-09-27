import fs from 'node:fs';
import path from 'node:path';
import { parseCardFromPages } from '../lib/parser.ts';
import { pagesFromRawText } from '../lib/extraction-review.ts';

const dir = 'c:/Users/giova/Downloads/qa-export-0939';
const contacts = JSON.parse(fs.readFileSync(path.join(dir, 'contacts.json'), 'utf8'));
let improved = 0;
const samples = [];

for (const c of contacts) {
  const rawPath = path.join(dir, 'raw-text', `${c.id}.txt`);
  if (!fs.existsSync(rawPath)) continue;
  const raw = fs.readFileSync(rawPath, 'utf8');
  const parsed = parseCardFromPages(pagesFromRawText(raw));
  const fixes = [];
  if (!c.company?.trim() && parsed.company?.trim()) fixes.push(`company: ${parsed.company}`);
  if (!c.firstName?.trim() && parsed.firstName?.trim()) fixes.push(`nome: ${parsed.firstName}`);
  if (!c.lastName?.trim() && parsed.lastName?.trim()) fixes.push(`cognome: ${parsed.lastName}`);
  if (c.company && /www\s|servoy com|themissoluzioni it/i.test(c.company) && parsed.company && !/www\s|servoy com/i.test(parsed.company)) {
    fixes.push(`company: ${c.company} → ${parsed.company}`);
  }
  if (!c.role?.trim() && parsed.role?.trim()) fixes.push(`ruolo: ${parsed.role}`);
  if (fixes.length) {
    improved++;
    if (samples.length < 8) samples.push({ title: c.title, fixes });
  }
}

console.log(`Contatti migliorati con parser attuale: ${improved}/${contacts.length}`);
console.log(JSON.stringify(samples, null, 2));

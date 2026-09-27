import fs from 'fs';
import { parseCardFromPages } from '../lib/parser.ts';
import { pagesFromRawText } from '../lib/extraction-review.ts';
import { mergeReparseWithQualityGate } from '../lib/reparse-quality-gate.ts';

const ids = ['11ee96f8-d42b-4c7e-8cde-73f7da4bf60c', 'dbd27768-80dc-49ed-8f3a-2aa8077fb460'];
const prev = JSON.parse(fs.readFileSync('scripts/qa-import/export-2026-07-14-device/contacts.json', 'utf8'));
for (const id of ids) {
  const card = prev.find((c) => c.id === id);
  const raw = fs.readFileSync(`scripts/qa-import/export-2026-07-14-reparse/raw-text/${id}.txt`, 'utf8');
  const parsed = parseCardFromPages(pagesFromRawText(raw));
  const { card: merged, decisions } = mergeReparseWithQualityGate(card, parsed);
  console.log('\n===', card.title, '===');
  console.log('parsed person:', parsed.firstName, parsed.lastName);
  console.log('merged person:', merged.firstName, merged.lastName);
  console.log('decision:', decisions.find((d) => d.field === 'firstName'));
}

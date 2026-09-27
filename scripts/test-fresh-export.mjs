import { readFileSync } from 'fs';
import { extractBusinessCardV5 } from '../lib/parser-v5/index.ts';

const contacts = JSON.parse(
  readFileSync('scripts/qa-import/export-2026-07-13-fresh/contacts.json', 'utf8')
);

const targets = [
  'Ntuglak', 'A facile', 'Carrozzeria', 'ERSITAS', 'tagliabue', 'MHT', 'ISIS', 'Jaspersoft'
];

for (const c of contacts) {
  const hit = targets.some((t) =>
    (c.title || '').toLowerCase().includes(t.toLowerCase()) ||
    (c.company || '').toLowerCase().includes(t.toLowerCase()) ||
    (c.rawText || '').toLowerCase().includes(t.toLowerCase())
  );
  if (!hit) continue;

  const lines = (c.rawText || '').split('\n').map((text, i) => ({
    text,
    confidence: 0.85,
    boundingBox: { x: 30, y: 20 + i * 18, width: 500, height: 16 },
  }));

  const r = extractBusinessCardV5([{ rawText: c.rawText, lines }]);
  console.log('\n===', c.title || c.company, '===');
  const v = (f) => (f && typeof f === 'object' && 'value' in f ? f.value : f);
  console.log({
    firstName: v(r.firstName),
    lastName: v(r.lastName),
    company: v(r.company),
    emails: v(r.emails),
    website: v(r.website),
    address: v(r.address)?.full || v(r.address)?.street,
    vat: v(r.vatNumber),
    phones: (v(r.phones) || []).map((p) => p.number),
  });
}

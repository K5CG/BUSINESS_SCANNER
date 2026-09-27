import fs from 'node:fs';
import { extractCardV5 } from '../lib/parser-v5/engine.ts';

const exportPath = process.argv[2];
const contactId = process.argv[3];
if (!exportPath || !contactId) {
  console.error('Usage: node --import tsx scripts/replay-export-case.mjs <contacts.json> <contact-id>');
  process.exit(1);
}

const contacts = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
const contact = contacts.find((c) => c.id === contactId);
if (!contact?.rawText) {
  console.error('Contact not found or missing rawText');
  process.exit(1);
}

const raw = contact.rawText;
const pages = [
  {
    lines: raw
      .split('\n')
      .map((text, lineIndex) => ({
        text,
        confidence: 0.9,
        boundingBox: { x: 0, y: lineIndex * 20, width: 500, height: 16 },
      })),
    rawText: raw,
  },
];
const r = extractCardV5(pages);
console.log(JSON.stringify({ title: contact.title, ...{
  firstName: r.firstName.value,
  lastName: r.lastName.value,
  company: r.company.value,
  role: r.role.value,
  emails: r.emails.value,
  address: r.address.value?.full,
  vat: r.vatNumber.value,
  tax: r.taxCode.value,
}}, null, 2));

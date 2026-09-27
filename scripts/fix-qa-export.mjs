// fix-qa-export.mjs
// Load contacts from a QA export zip, re‑parse each card with the v5 parser
// and overwrite fields that are mismatched (parser‑replay) or missing.
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { extractCardV5 } from '../lib/parser-v5/engine.ts';

function loadContacts(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const entries = unzipSync(new Uint8Array(buf));
  const json = entries['contacts.json'];
  if (!json) throw new Error('contacts.json missing');
  return JSON.parse(new TextDecoder().decode(json));
}

function pagesFromRawText(rawText) {
  const trimmed = rawText?.trim() ?? '';
  if (!trimmed) return [{ lines: [], rawText: '' }];
  const chunks = trimmed.split(/\n\n+/).filter(Boolean);
  const pageTexts = chunks.length ? chunks : [trimmed];
  return pageTexts.map((page) => {
    const lines = page
      .split('\n')
      .map((t, i) => ({
        text: t.trim(),
        confidence: 0.85,
        boundingBox: { x: 30, y: 20 + i * 18, width: 500, height: 16 },
      }))
      .filter((l) => l.text);
    return { lines, rawText: page };
  });
}

function cardSnapshot(card) {
  const addr = card.address;
  return {
    firstName: card.firstName ?? '',
    lastName: card.lastName ?? '',
    role: card.role ?? '',
    company: card.company ?? '',
    emails: (card.emails ?? []).join('; '),
    phones: (card.phones ?? []).map((p) => p.number).join('; '),
    website: card.website ?? '',
    address: addr?.full ?? [addr?.street, addr?.postalCode, addr?.city].filter(Boolean).join(', '),
    vatNumber: card.vatNumber ?? '',
    taxCode: card.taxCode ?? '',
  };
}

function v5Snapshot(res) {
  const addr = res.address.value;
  return {
    firstName: res.firstName.value ?? '',
    lastName: res.lastName.value ?? '',
    role: res.role.value ?? '',
    company: res.company.value ?? '',
    emails: (res.emails.value ?? []).join('; '),
    phones: (res.phones.value ?? []).map((p) => p.number).join('; '),
    website: res.website.value ?? '',
    address: addr?.full ?? [addr?.street, addr?.postalCode, addr?.city].filter(Boolean).join(', '),
    vatNumber: res.vatNumber.value ?? '',
    taxCode: res.taxCode.value ?? '',
  };
}

function mergeFields(stored, replay) {
  const merged = { ...stored };
  for (const key of Object.keys(stored)) {
    const s = stored[key].trim();
    const r = replay[key].trim();
    if (!r) continue;
    if (!s || s !== r) {
      merged[key] = r;
    }
  }
  return merged;
}

function writeBack(zipPath, contacts) {
  const buf = fs.readFileSync(zipPath);
  const entries = unzipSync(new Uint8Array(buf));
  const newJson = JSON.stringify(contacts, null, 2);
  entries['contacts.json'] = new TextEncoder().encode(newJson);
  const zipped = zipSync(entries);
  fs.writeFileSync(zipPath, Buffer.from(zipped));
}

async function main() {
  const zipPath = process.argv[2];
  if (!zipPath) {
    console.error('Usage: npm run fix:qa-export -- <zipPath>');
    process.exit(1);
  }
  const contacts = loadContacts(zipPath);
  for (const card of contacts) {
    if (!card.rawText) continue;
    const pages = pagesFromRawText(card.rawText);
    const replay = extractCardV5(pages);
    const storedSnap = cardSnapshot(card);
    const replaySnap = v5Snapshot(replay);
    const merged = mergeFields(storedSnap, replaySnap);
    // write merged values back into card (preserving original structure)
    card.firstName = merged.firstName || undefined;
    card.lastName = merged.lastName || undefined;
    card.role = merged.role || undefined;
    card.company = merged.company || undefined;
    card.emails = merged.emails ? merged.emails.split(/;\s*/) : [];
    card.phones = merged.phones ? merged.phones.split(/;\s*/).map((n) => ({ number: n })) : [];
    card.website = merged.website || undefined;
    if (merged.address) {
      const parts = merged.address.split(/,\s*/);
      const addr = {};
      if (parts[0]) addr.street = parts[0];
      if (parts[1]) addr.postalCode = parts[1];
      if (parts[2]) addr.city = parts[2];
      card.address = { ...addr, full: merged.address };
    }
    card.vatNumber = merged.vatNumber || undefined;
    card.taxCode = merged.taxCode || undefined;
  }
  writeBack(zipPath, contacts);
  console.log('✅ Fixed contacts inside', zipPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

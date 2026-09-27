/**
 * Structural audit: company-from-domain, city-as-name, role-as-company, etc.
 */
import fs from 'node:fs';

const exportPath = process.argv[2] || 'c:/Users/giova/Downloads/qa-export-1026/contacts.json';
const c = JSON.parse(fs.readFileSync(exportPath, 'utf8'));

const ROLE_AS_COMPANY =
  /^(rapporti|responsabile|delegato|direttore|partner|manager|gestionale|commercial|sales|marketing|amministr|ufficio)/i;
const CITY_AS_NAME =
  /^(milano|roma|torino|napoli|padova|venezia|bologna|firenze|genova|verona)$/i;
const LEGAL_ONLY = /^(gmbh|s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?)(\s+(gmbh|s\.?r\.?l\.?|s\.?p\.?a\.?))?$/i;
const ADDR_BAD = /(C\.F\.|P\.IVA|Tel\.|Fax\.|Nr\. 0|35131[^-]|Nr\.\s*$)/i;

function domainStem(url) {
  if (!url) return '';
  return url
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('.')[0]
    .toLowerCase();
}

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const issues = [];
for (const x of c) {
  const probs = [];
  const raw = x.rawText || '';
  const emailsInRaw = [...raw.matchAll(/[\w.%+-]+@[\w.-]+\.[a-zA-Z]{2,}/g)].map((m) =>
    m[0].replace(/\s/g, '')
  );
  const storedEmails = (x.emails || []).map((e) => e.toLowerCase());
  const missingEmail = emailsInRaw.filter(
    (e) => !storedEmails.some((s) => s.includes(e.split('@')[0].slice(0, 5).toLowerCase()))
  );

  const co = (x.company || '').trim();
  const stem = domainStem(x.website);
  if (
    co &&
    stem &&
    norm(co) === norm(stem) &&
    !raw.toLowerCase().includes(co.toLowerCase().slice(0, 6))
  ) {
    probs.push({ t: 'company-from-domain', v: co, stem });
  }
  if (co && ROLE_AS_COMPANY.test(co)) probs.push({ t: 'role-as-company', v: co });
  if (co && LEGAL_ONLY.test(co.replace(/\s+/g, ' ')))
    probs.push({ t: 'legal-form-only-company', v: co });
  if (CITY_AS_NAME.test((x.lastName || '').trim()))
    probs.push({ t: 'city-as-lastname', v: x.lastName, name: `${x.firstName} ${x.lastName}` });
  if (CITY_AS_NAME.test((x.firstName || '').trim()))
    probs.push({ t: 'city-as-firstname', v: x.firstName });
  const addr = x.address?.full || '';
  if (addr && ADDR_BAD.test(addr)) probs.push({ t: 'address-contaminated', v: addr });
  if (missingEmail.length && emailsInRaw.length)
    probs.push({ t: 'missing-email', v: missingEmail.join('; ') });
  if (raw.match(/P\.\s*IVA|P\.IVA|IVA\s*\d/i) && !x.vatNumber && !(x.taxCode || '').match(/^\d{11}$/))
    probs.push({ t: 'missing-vat', v: raw.match(/(?:P\.?\s*IVA|IVA)\s*[:\s]*(\d+)/i)?.[1] || '?' });
  if ((x.firstName || '').toLowerCase() === (co || '').toLowerCase() && co)
    probs.push({ t: 'company-equals-person', v: co });
  if (raw.match(/GAVASSO|Daniela/i) && !(`${x.firstName}${x.lastName}`).match(/daniela|gavasso/i))
    probs.push({ t: 'missing-person', v: 'Daniela Gavasso' });
  if (co && /earata|servoy com|www\s+\w+\s+it/i.test(co))
    probs.push({ t: 'email-fused-company', v: co });
  if (probs.length) issues.push({ title: x.title, probs });
}

const byType = {};
for (const row of issues) {
  for (const p of row.probs) {
    byType[p.t] = (byType[p.t] || 0) + 1;
  }
}

console.log('Contacts:', c.length);
console.log('With structural issues:', issues.length);
console.log('By type:', byType);
console.log('\n--- Details ---');
for (const row of issues) {
  console.log(`\n${row.title}`);
  for (const p of row.probs) console.log(`  [${p.t}] ${p.v || JSON.stringify(p)}`);
}

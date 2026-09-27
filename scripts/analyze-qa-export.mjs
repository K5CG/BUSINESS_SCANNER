import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] ?? 'scripts/qa-import/export-2026-07-13');
const contacts = JSON.parse(fs.readFileSync(path.join(ROOT, 'contacts.json'), 'utf8'));

const issues = [];
for (const c of contacts) {
  const probs = [];
  const conf = c.confidence ?? {};
  const rev = c.extractionReview ?? {};
  if (!c.firstName?.trim()) probs.push('no-firstName');
  if (!c.lastName?.trim()) probs.push('no-lastName');
  if ((conf.firstName ?? 1) < 0.5) probs.push('low-firstName');
  if ((conf.lastName ?? 1) < 0.5) probs.push('low-lastName');
  if ((conf.company ?? 1) < 0.4 && c.company) probs.push('low-company');
  const emailLocal = (c.emails?.[0] ?? '').split('@')[0]?.toLowerCase() ?? '';
  const fn = (c.firstName ?? '').toLowerCase();
  const ln = (c.lastName ?? '').toLowerCase();
  if (emailLocal && fn && ln && !emailLocal.includes(fn.slice(0, 4)) && !emailLocal.includes(ln.slice(0, 4))) {
    probs.push('name-email-mismatch');
  }
  if (/\b(?:istruttore|sales|manager|director|ceo|responsabile)\b/i.test(c.company ?? '') && !c.role) {
    probs.push('role-as-company');
  }
  if (c.firstName && c.company && c.firstName.toLowerCase() === c.company.toLowerCase().split(/\s+/)[0]) {
    probs.push('company-equals-firstname');
  }
  if (probs.length) {
    issues.push({
      title: c.company || c.lastName || c.id.slice(0, 8),
      first: c.firstName,
      last: c.lastName,
      company: c.company,
      role: c.role,
      email: c.emails?.[0],
      probs,
      cf: [conf.firstName, conf.lastName, conf.company].map((x) => x?.toFixed?.(2) ?? '-').join('/'),
    });
  }
}

issues.sort((a, b) => b.probs.length - a.probs.length);
console.log(`Contacts: ${contacts.length}, with flags: ${issues.length}`);
console.log('\nTop 25:');
for (const i of issues.slice(0, 25)) {
  console.log(`- [${i.probs.join(',')}] ${i.title}`);
  console.log(`  ${i.first} | ${i.last} | ${i.company} | ${i.role ?? ''} | ${i.email ?? ''} (${i.cf})`);
}

const counts = {};
for (const i of issues) for (const p of i.probs) counts[p] = (counts[p] ?? 0) + 1;
console.log('\nFlag counts:', counts);

import fs from 'node:fs';
import { pickOrganizationHeaderFromEvidence, recoverStackedBrandLinesFromWebsite, sanitizeCompanyValue } from '../lib/parser-engine/validators/company';
const raw = fs.readFileSync('tests/fixtures/replay-audit-70/raw-text/5af3896f-b529-4f8a-a9f7-b164f5935e8f.txt', 'utf8');
console.log('HEADER=[' + String(pickOrganizationHeaderFromEvidence(raw, [])) + ']');
console.log('STACKED=[' + String(recoverStackedBrandLinesFromWebsite('LM Exhaust System', [], raw)) + ']');
console.log('SANITIZE INPUT=[' + String(sanitizeCompanyValue('LM Exhaust System')) + ']');
console.log('SANITIZE WWW=[' + String(sanitizeCompanyValue('www.lmexhaustsystem.it')) + ']');

import { resolveOrganizationFromOcr, isDomainOnlyCompanyValue, alignCompanyToEmailDomain } from '../lib/parser-engine/validators/company';
console.log('RESOLVE OCR=[' + String(resolveOrganizationFromOcr('LM Exhaust System', [], raw)) + ']');
console.log('DOMAIN ONLY=[' + String(isDomainOnlyCompanyValue('LM Exhaust System', [], raw)) + ']');
console.log('ALIGN=[' + String(alignCompanyToEmailDomain('LM Exhaust System', [], raw)) + ']');

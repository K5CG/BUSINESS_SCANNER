import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { BusinessCard, Phone } from '../types';
import {
  buildVCardFileName,
  escapeVCardText,
  exportToVCard,
  vCardTelType,
} from '../lib/export-vcard.ts';

const root = process.cwd();
const now = new Date('2026-08-14T10:00:00.000Z');

function card(overrides: Partial<BusinessCard> = {}): BusinessCard {
  return {
    id: 'katie-card',
    type: 'business_card',
    title: 'Boston University - Katie Pasciucco',
    images: [],
    rawText: 'E-mail: katiepobu. edu',
    confidence: {},
    createdAt: now,
    updatedAt: now,
    firstName: 'Katie',
    lastName: 'Pasciucco',
    role: 'Admissions & Outreach Coordinator',
    company: 'Boston University',
    emails: [],
    phones: [
      { number: '617-358-2153', type: 'work' },
      { number: '617-353-2744', type: 'fax' },
    ],
    address: {
      full: 'Commonwealth Avenue, Nr. 755 - 02215 - Boston',
    },
    ...overrides,
  };
}

test('Katie work + fax vCard uses VERSION 3.0 typed TEL and does not invent email', () => {
  const vcf = exportToVCard(card());
  assert.match(vcf, /^BEGIN:VCARD\r\nVERSION:3\.0\r\n/);
  assert.match(vcf, /\r\nEND:VCARD\r\n$/);
  assert.match(vcf, /\r\nFN:Katie Pasciucco\r\n/);
  assert.match(vcf, /\r\nN:Pasciucco;Katie;;;\r\n/);
  assert.match(vcf, /\r\nORG:Boston University\r\n/);
  assert.match(vcf, /\r\nTITLE:Admissions & Outreach Coordinator\r\n/);
  assert.match(vcf, /\r\nTEL;TYPE=WORK:617-358-2153\r\n/);
  assert.match(vcf, /\r\nTEL;TYPE=FAX:617-353-2744\r\n/);
  assert.doesNotMatch(vcf, /EMAIL:/);
  assert.doesNotMatch(vcf, /katiepobu/i);
  assert.equal(buildVCardFileName(card()), 'MyBizScanner_Katie_Pasciucco.vcf');
});

test('mobile, work, fax and unknown phones coexist', () => {
  const phones: Phone[] = [
    { number: '111', type: 'mobile' },
    { number: '222', type: 'work' },
    { number: '333', type: 'fax' },
    { number: '444', type: 'other' },
    { number: '555' },
  ];
  const vcf = exportToVCard(card({ phones }));
  assert.match(vcf, /\r\nTEL;TYPE=CELL:111\r\n/);
  assert.match(vcf, /\r\nTEL;TYPE=WORK:222\r\n/);
  assert.match(vcf, /\r\nTEL;TYPE=FAX:333\r\n/);
  assert.match(vcf, /\r\nTEL:444\r\n/);
  assert.match(vcf, /\r\nTEL:555\r\n/);
  assert.equal(vCardTelType('mobile'), 'CELL');
  assert.equal(vCardTelType('other'), undefined);
});

test('safe emails are exported; empty optional fields are omitted', () => {
  const vcf = exportToVCard(
    card({
      emails: ['katie@bu.edu'],
      emailEvidence: [
        {
          value: 'katie@bu.edu',
          rawValue: 'katie@bu.edu',
          origin: 'user',
          pageIndex: 0,
          lineId: 1,
          rawOcr: 'katie@bu.edu',
          transformations: ['user_confirmed'],
          confidence: 1,
          validationStatus: 'valid',
          requiresReview: false,
          confirmed: true,
        },
      ],
      website: 'https://bu.edu',
      notes: undefined,
      role: '',
      company: 'Boston University',
    })
  );
  assert.match(vcf, /\r\nEMAIL:katie@bu\.edu\r\n/);
  assert.match(vcf, /\r\nURL:https:\/\/bu\.edu\r\n/);
  assert.doesNotMatch(vcf, /\r\nTITLE:/);
  assert.doesNotMatch(vcf, /\r\nNOTE:/);
});

test('vCard 3.0 escaping handles backslash, semicolon, comma and newline', () => {
  assert.equal(escapeVCardText('a\\b;c,d\ne'), 'a\\\\b\\;c\\,d\\ne');
  const vcf = exportToVCard(
    card({
      firstName: 'Ann;a',
      lastName: 'O,Neil',
      company: 'Foo;Bar,Baz',
      notes: 'Line 1\nLine 2',
      address: { full: '12 Main St; Suite 3, Boston' },
    })
  );
  assert.match(vcf, /\r\nFN:Ann\\;a O\\,Neil\r\n/);
  assert.match(vcf, /\r\nN:O\\,Neil;Ann\\;a;;;\r\n/);
  assert.match(vcf, /\r\nORG:Foo\\;Bar\\,Baz\r\n/);
  assert.match(vcf, /\r\nNOTE:Line 1\\nLine 2\r\n/);
  assert.match(vcf, /\r\nADR:;;12 Main St\\; Suite 3\\, Boston;;;;\r\n/);
});

test('filename sanitizes unsafe characters and falls back to Contact', () => {
  assert.equal(
    buildVCardFileName({ firstName: 'Katie', lastName: 'Pasciucco' }),
    'MyBizScanner_Katie_Pasciucco.vcf'
  );
  assert.equal(
    buildVCardFileName({ firstName: 'A/B', lastName: 'C:D' }),
    'MyBizScanner_AB_CD.vcf'
  );
  assert.equal(buildVCardFileName({ firstName: '', lastName: '' }), 'MyBizScanner_Contact.vcf');
});

test('Export screen shares a .vcf file; diagnostic export requires confirmation', () => {
  const exportScreen = fs.readFileSync(path.join(root, 'app/export/[id].tsx'), 'utf8');
  assert.match(exportScreen, /shareContactVCardFile/);
  assert.doesNotMatch(exportScreen, /shareContent\(exportToVCard/);
  const contacts = fs.readFileSync(path.join(root, 'app/(tabs)/contacts.tsx'), 'utf8');
  const documents = fs.readFileSync(path.join(root, 'app/(tabs)/documents.tsx'), 'utf8');
  assert.match(contacts, /confirmDiagnosticExport/);
  assert.match(documents, /confirmDiagnosticExport/);
  const it = JSON.parse(fs.readFileSync(path.join(root, 'i18n/it.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n/en.json'), 'utf8'));
  assert.equal(it.export, 'Esporta');
  assert.equal(it.exportContacts, 'Esporta');
  assert.equal(it.exportDocuments, 'Esporta');
  assert.equal(en.export, 'Export');
  assert.equal(en.exportContacts, 'Export');
  assert.equal(en.exportDocuments, 'Export');
  assert.equal(it.exportQa, 'Export diagnostico');
  assert.equal(it.exportDataSection, 'Esporta dati');
  assert.equal(it.exportSupportSection, 'Assistenza');
  assert.equal(it.exportChooseTitle, 'Export diagnostico');
  assert.equal(it.diagnosticExportTitle, 'Export diagnostico');
  assert.match(it.diagnosticExportWarning, /Il pacchetto diagnostico può contenere dati personali/);
  assert.equal(it.diagnosticExportContinue, 'Continua');
});

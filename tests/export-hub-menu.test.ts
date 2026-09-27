import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('export hub uses generic Ionicons, not Excel branding', () => {
  const source = fs.readFileSync(path.join(root, 'components/ExportHubMenu.tsx'), 'utf8');
  assert.match(source, /header:\s*'share-outline'/);
  assert.match(source, /xlsx:\s*'grid-outline'/);
  assert.match(source, /csv:\s*'document-text-outline'/);
  assert.match(source, /pdf:\s*'document-outline'/);
  assert.match(source, /diagnostic:\s*'construct-outline'/);
  assert.doesNotMatch(source, /excel|microsoft|adobe|logo/i);
});

test('Contacts and Documents share one Esporta header action and the same hub architecture', () => {
  const contacts = fs.readFileSync(path.join(root, 'app/(tabs)/contacts.tsx'), 'utf8');
  const documents = fs.readFileSync(path.join(root, 'app/(tabs)/documents.tsx'), 'utf8');

  assert.equal((contacts.match(/accessibilityLabel=\{t\('export'\)\}/g) ?? []).length, 1);
  assert.equal((documents.match(/accessibilityLabel=\{t\('export'\)\}/g) ?? []).length, 1);
  assert.doesNotMatch(contacts, /accessibilityLabel=\{t\('exportContacts'\)\}/);
  assert.doesNotMatch(documents, /accessibilityLabel=\{t\('exportDocuments'\)\}/);

  assert.match(contacts, /exportDataSection/);
  assert.match(contacts, /exportSupportSection/);
  assert.match(contacts, /exportCustomerFormatXlsx/);
  assert.match(contacts, /exportCustomerFormatCsv/);
  assert.match(contacts, /t\('exportQa'\)/);
  assert.match(contacts, /confirmDiagnosticExport/);

  assert.match(documents, /exportDataSection/);
  assert.match(documents, /exportSupportSection/);
  assert.match(documents, /exportCustomerFormatXlsx/);
  assert.match(documents, /exportCustomerFormatPdf/);
  assert.match(documents, /EXPORT_HUB_ICONS\.xlsx/);
  assert.match(documents, /EXPORT_HUB_ICONS\.pdf/);
  assert.match(documents, /shareCustomerDocumentsExport/);
  assert.match(documents, /confirmDiagnosticExport/);
});

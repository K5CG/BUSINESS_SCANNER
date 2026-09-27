import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

test('new_scan free_document promotes structured identity over stale fast-parser identity', () => {
  const source = read('lib/document-structured-extraction.ts');
  assert.match(source, /\(\(authoritative \|\| !document\.documentNumber\) && number/);
  assert.match(source, /if \(authoritative\) \{\s*free\.title = number \? `Documento \$\{number\}` : free\.title;/s);
});

test('AI acceptance projects canonical number/date and derived title for every document family', () => {
  const source = read('app/document/[id].tsx');
  assert.match(source, /projectAcceptedDocumentIdentity/);
  assert.match(source, /free_document[\s\S]*documentNumber: number, title: `Documento \$\{number\}`/);
  assert.match(source, /quote[\s\S]*quoteNumber: number, title: `Preventivo \$\{number\}`/);
  assert.match(source, /order[\s\S]*orderNumber: number, title: `Ordine \$\{number\}`/);
  assert.match(source, /invoice[\s\S]*invoiceNumber: number, title: `Fattura \$\{number\}`/);
  assert.match(source, /invoiceDate: date/);
});

test('global accept enablement is driven by reactive persistence state, not a ref snapshot', () => {
  const source = read('app/document/[id].tsx');
  assert.match(source, /const \[hybridPersistenceRunning, setHybridPersistenceRunning\] = useState\(false\)/);
  assert.match(source, /setHybridPersistenceRunning\(true\)/);
  assert.match(source, /setHybridPersistenceRunning\(false\)/);
  const start = source.indexOf('<DocumentHybridReview');
  const end = source.indexOf('/>', start);
  assert.ok(start >= 0 && end > start, 'DocumentHybridReview self-closing block not found');
  const uiBlock = source.slice(start, end + 2);
  assert.match(uiBlock, /hybridPersistenceRunning/);
  assert.doesNotMatch(uiBlock, /persistenceRunningRef\.current/);
});

test('global accept button stays on one line with adaptive font', () => {
  const source = read('components/DocumentHybridReview.tsx');
  assert.match(source, /style=\{styles\.acceptAllText\}[\s\S]*numberOfLines=\{1\}[\s\S]*adjustsFontSizeToFit[\s\S]*minimumFontScale=\{0\.72\}/);
  assert.match(source, /acceptAllText: \{[\s\S]*fontSize: 14[\s\S]*lineHeight: 18/);
});

test('Gemini image modal keeps Annulla and Supporto AI readable on one line', () => {
  const source = read('components/GeminiConfirmationModal.tsx');
  assert.match(source, /contentKind === 'images' \? 1\.35/);
  assert.match(source, /contentKind === 'images' \? 0\.9/);
  assert.match(source, /cancelText\} numberOfLines=\{1\} adjustsFontSizeToFit minimumFontScale=\{0\.78\}/);
  assert.match(source, /confirmText\} numberOfLines=\{confirmMaxLines\} adjustsFontSizeToFit minimumFontScale=\{0\.78\}/);
});

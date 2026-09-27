import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSemanticFallbackExtraction,
  extractStrongDocumentNumber,
} from '../lib/document-semantic-fallback';

const root = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('numero documento con prefisso alfabetico e corpo slash resta completo', () => {
  const lines = [
    'FATTURA',
    'FV 26/081744',
    'emessa 22-08-2026',
  ];
  assert.equal(
    extractStrongDocumentNumber(lines.join('\n'), lines),
    'FV 26/081744',
  );
});

test('data emessa batte date tecniche e note esplicitamente escluse', () => {
  const lines = [
    'FATTURA',
    'FV 26/081744',
    'emessa 22-08-2026',
    'Seriali installazione: 04/12/2025 - 17/01/2026 - 09/05/2026',
    'Non usare come data documento: 17/01/2026',
  ];
  const out = buildSemanticFallbackExtraction(
    'invoice',
    lines.join('\n'),
    lines,
    'generic_regression',
  );
  assert.equal(out.metadata.documentNumber?.normalizedValue, 'FV 26/081744');
  assert.equal(out.metadata.issueDate?.normalizedValue, '2026-08-22');
});

test('una sola data in contesto seriale o esplicitamente escluso non diventa data documento', () => {
  const lines = [
    'FATTURA',
    'Seriali apparecchiatura: 17/01/2026',
    'Non usare come data documento: 17/01/2026',
  ];
  const out = buildSemanticFallbackExtraction(
    'invoice',
    lines.join('\n'),
    lines,
    'generic_regression',
  );
  assert.equal(out.metadata.issueDate, undefined);
});

test('UI documenti: AI alto, articoli compatti, notice distinta, timeout 30s', () => {
  const screen = read('app/document/[id].tsx');
  const details = read('components/DocumentStructuredDetails.tsx');
  const gemini = read('lib/gemini-ocr.ts');

  assert.match(gemini, /DOCUMENT_AI_INTERACTIVE_TIMEOUT_MS\s*=\s*30_000/);
  assert.equal(
    screen.indexOf('{hasReviewableDocumentImages ?') < screen.indexOf('{renderEditor()}'),
    true,
  );
  assert.match(screen, /partialNoticeBanner[\s\S]*?backgroundColor:\s*colors\.infoSurface/);
  assert.match(details, /expandedItems/);
  assert.match(details, /toggleItem/);
  assert.match(details, /documentDetailsDescription/);
  assert.match(details, /documentDetailsQuantity/);
  assert.match(details, /documentDetailsLineTotal/);
  assert.match(details, /accessibilityState=\{\{ expanded \}\}/);
});

/**
 * Verifica offline: 10 righe wrappate (forma reale PASS-B) attraverso
 * parsePdfItemsResponse + mergePdfPasses del codice locale corrente.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const wrapped = {
  items: Array.from({ length: 10 }, (_, index) => ({
    itemCode: {
      value: `A-${index + 1}`,
      pageIndex: 0,
      evidenceText: `A-${index + 1}`,
      confidenceType: 'heuristic',
      requiresReview: false,
      alternatives: [],
    },
    description: {
      value: `Riga ${index + 1}`,
      pageIndex: 0,
      evidenceText: `Riga ${index + 1}`,
      confidenceType: 'heuristic',
      requiresReview: false,
      alternatives: [],
    },
    quantity: {
      value: 1,
      pageIndex: 0,
      evidenceText: '1',
      confidenceType: 'heuristic',
      requiresReview: false,
      alternatives: [],
    },
    unitPrice: {
      value: 100,
      pageIndex: 0,
      evidenceText: '100',
      confidenceType: 'heuristic',
      requiresReview: false,
      alternatives: [],
    },
    lineTotal: {
      value: 100,
      pageIndex: 0,
      evidenceText: '100',
      confidenceType: 'heuristic',
      requiresReview: false,
      alternatives: [],
    },
  })),
};

// Preferisci le 10 righe reali dalla sonda se presenti.
let source = 'synthetic_wrapped';
try {
  const saved = JSON.parse(readFileSync('.tmp-qa/parse-pdf-response.json', 'utf8'));
  if (Array.isArray(saved.rawFields?.items) && saved.rawFields.items.length === 10) {
    wrapped.items = saved.rawFields.items;
    source = 'captured_rawFields.items';
  }
} catch {
  // keep synthetic
}

writeFileSync('.tmp-qa/pass-b-wrapped.json', JSON.stringify(wrapped));

const runner = `
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPdfItemsPassParseDiagnostics,
  mergePdfPasses,
  parsePdfItemsResponse,
} from '../supabase/functions/_shared/gemini-extract';

const text = readFileSync('.tmp-qa/pass-b-wrapped.json', 'utf8');
const parsed = parsePdfItemsResponse(text);
const afterParse = buildPdfItemsPassParseDiagnostics(text, parsed);
const merged = mergePdfPasses(
  { rawText: 'SUMMARY', documentNumber: 'PV-2026-0811', subtotal: 9482.5, vatAmount: 2086.15, total: 11568.65 },
  parsed
);
const report = {
  source: ${JSON.stringify(source)},
  rawItems: Array.isArray(parsed?.rawItems) ? parsed.rawItems.length : 0,
  itemsBeforeNormalization: afterParse.itemsBeforeNormalization,
  itemsAfterNormalization: afterParse.itemsAfterNormalization,
  mergedItems: merged.items?.length ?? 0,
  structuredItems: parsed?.structuredItems?.length ?? 0,
  rejectionReasons: afterParse.rejectionReasons,
};
console.log(JSON.stringify(report, null, 2));
assert.equal(report.rawItems, 10);
assert.equal(report.itemsBeforeNormalization, 10);
assert.equal(report.itemsAfterNormalization, 10);
assert.equal(report.mergedItems, 10);
`;

writeFileSync('.tmp-qa/verify-unwrap-run.ts', runner);
const result = spawnSync(
  'npx',
  [
    'ts-node',
    '--project',
    'tsconfig.phase6a-tests.json',
    'scripts/run-bundled-script.ts',
    '.tmp-qa/verify-unwrap-run.ts',
    '--alias:expo-modules-core=./scripts/stub-expo-modules-core.mjs',
  ],
  { encoding: 'utf8', shell: true }
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);

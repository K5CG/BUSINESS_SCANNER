import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('timeout AI interattivo a 30s senza cambiare il default documenti', () => {
  const gemini = read('lib/gemini-ocr.ts');
  const supabase = read('lib/supabase-functions.ts');

  assert.match(gemini, /export const DOCUMENT_AI_INTERACTIVE_TIMEOUT_MS\s*=\s*30_000\s*;/);
  assert.match(gemini, /timeoutMs:\s*DOCUMENT_AI_INTERACTIVE_TIMEOUT_MS/);
  assert.match(supabase, /export const DOCUMENT_FUNCTION_TIMEOUT_MS\s*=\s*45_000\s*;/);
  assert.match(
    supabase,
    /export function resolveSupabaseFunctionTimeoutMs\([\s\S]*?if \(override !== undefined\) return override;[\s\S]*?return DOCUMENT_FUNCTIONS\.has\(functionName\)[\s\S]*?\?\s*DOCUMENT_FUNCTION_TIMEOUT_MS[\s\S]*?:\s*FUNCTION_TIMEOUT_MS;[\s\S]*?\}/
  );
  assert.match(supabase, /const timeoutMs = resolveSupabaseFunctionTimeoutMs\(functionName,\s*options\);/);
  assert.match(supabase, /const timeout = setTimeout\(\(\) => controller\.abort\(\), timeoutMs\);/);
});

test('Dati tecnici: missing viene classificato come not_found prima di requiresReview', () => {
  const viewModel = read('lib/document-review-view-model.ts');
  const missingIndex = viewModel.indexOf("if (field.validationStatus === 'missing') return 'not_found';");
  const reviewIndex = viewModel.indexOf("if (field.requiresReview) return 'needs_review';");
  assert.notEqual(missingIndex, -1);
  assert.notEqual(reviewIndex, -1);
  assert.equal(missingIndex < reviewIndex, true);
});

test('UI espone errore AI, Chiudi, Riprova, progresso e stato Non trovato', () => {
  const screen = read('app/document/[id].tsx');
  const details = read('components/DocumentPageExtractionReview.tsx');
  const it = JSON.parse(read('i18n/it.json'));

  assert.match(screen, /review_abort/);
  assert.match(screen, /documentAiConnectionErrorTitle/);
  assert.match(screen, /documentAiClose/);
  assert.match(screen, /documentAiRetry/);
  assert.match(screen, /documentAiProgressPage/);
  assert.match(details, /documentFieldReliabilityNotFound/);
  assert.match(details, /documentFieldReliabilityMissingSummary/);

  assert.equal(it.documentAiConnectionErrorTitle, 'Supporto AI non disponibile');
  assert.equal(it.documentAiClose, 'Chiudi');
  assert.equal(it.documentAiRetry, 'Riprova');
  assert.equal(it.documentFieldReliabilityNotFound, 'Non trovato');
});

test('gestione outcome AI restringe status prima di leggere reason', () => {
  const screen = read('app/document/[id].tsx');
  const errorGuard = screen.indexOf("if (outcome.status === 'error') {");
  const firstReason = screen.indexOf('outcome.reason');
  assert.notEqual(errorGuard, -1);
  assert.notEqual(firstReason, -1);
  assert.equal(errorGuard < firstReason, true);
  assert.match(screen, /if \(outcome\.status === 'cancelled'\) \{\s*return;\s*\}/);
});

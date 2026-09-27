import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

test('parse-document usa timeout Gemini dedicato 20s, senza cambiare PDF', () => {
  const edge = read('supabase/functions/_shared/document-edge-handlers.ts');
  assert.match(edge, /export const DOCUMENT_GEMINI_TIMEOUT_MS\s*=\s*20_000/);
  assert.match(edge, /configured\.model,\s*\{\s*timeoutMs:\s*DOCUMENT_GEMINI_TIMEOUT_MS\s*\}\s*\)/);
  assert.match(edge, /timeoutMs:\s*PDF_GEMINI_TIMEOUT_MS/);
});

test('Supporto AI e review sono inseriti dopo la prima sezione riepilogativa', () => {
  const screen = read('app/document/[id].tsx');
  const details = read('components/DocumentStructuredDetails.tsx');
  assert.match(screen, /const renderDocumentAiSection = \(\) =>/);
  assert.match(screen, /afterSummary=\{renderDocumentAiSection\(\)\}/);
  assert.match(details, /afterSummary\?: React\.ReactNode/);
  assert.match(details, /sectionIndex === 0 \? afterSummary : null/);
  const body = screen.slice(screen.indexOf('<DocumentImagesPreview'), screen.indexOf('{renderEditor()}') + 20);
  assert.doesNotMatch(body, /styles\.documentAiBox/);
});

test('correzione riga usa Applica e mantiene la review aperta', () => {
  const review = read('components/DocumentHybridReview.tsx');
  assert.match(review, /name="create-outline"/);
  assert.match(review, /name="arrow-undo-outline"/);
  assert.match(review, /t\('documentHybridApply'\)/);
  assert.doesNotMatch(review, /<Text style=\{styles\.acceptText\}>\{t\('save'\)\}<\/Text>/);
  assert.match(review, /onManualValue\(path, manualScalar\);\s*closeManual\(\);/);
  assert.match(review, /onManualValue\(path, manualItem\);\s*closeManual\(\);/);
});

test('salvataggio globale e banner analisi sono distinti', () => {
  const screen = read('app/document/[id].tsx');
  assert.match(screen, /t\('documentSave'\)/);
  assert.match(screen, /backgroundColor:\s*'#FFF9E6'/);
  assert.match(screen, /borderColor:\s*'#E7C96B'/);
  assert.match(screen, /partialNoticeText:\s*\{\s*\.\.\.typography\.caption/);
});

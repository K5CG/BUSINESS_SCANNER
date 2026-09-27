import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveDocumentAiCreditState } from '../lib/document-ai-credits';

const root = process.cwd();
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const it = JSON.parse(source('i18n/it.json')) as Record<string, string>;
const en = JSON.parse(source('i18n/en.json')) as Record<string, string>;
const route = source('app/document/[id].tsx');

test('bottone italiano usa un testo provider-agnostico', () => {
  assert.equal(it.documentAiButton, 'Migliora con supporto AI');
});

test('bottone inglese usa un testo provider-agnostico', () => {
  assert.equal(en.documentAiButton, 'Improve with AI support');
});

test('descrizione italiana conserva consenso e persistenza senza nominare Gemini', () => {
  assert.doesNotMatch(it.documentLocalReviewHint, /Gemini/i);
  assert.match(it.documentLocalReviewHint, /inviare esplicitamente/i);
  assert.match(it.documentLocalReviewHint, /finché non premi Salva/i);
});

test('descrizione inglese conserva consenso e persistenza senza nominare Gemini', () => {
  assert.doesNotMatch(en.documentLocalReviewHint, /Gemini/i);
  assert.match(en.documentLocalReviewHint, /explicitly send/i);
  assert.match(en.documentLocalReviewHint, /until you tap Save/i);
});

test('i messaggi mostrati nel box restano provider-agnostici', () => {
  for (const copy of [
    it.documentLocalReviewHint,
    it.documentAiButton,
    it.documentAiError,
    it.documentAiNotConfigured,
    en.documentLocalReviewHint,
    en.documentAiButton,
    en.documentAiError,
    en.documentAiNotConfigured,
  ]) {
    assert.doesNotMatch(copy, /Gemini/i);
  }
});

test('crediti noti producono il valore residuo', () => {
  assert.deepEqual(resolveDocumentAiCreditState(12), { kind: 'remaining', value: 12 });
  assert.equal(it.documentAiCreditsRemaining.replace('{{count}}', '12'), 'Crediti AI residui: 12');
  assert.equal(en.documentAiCreditsRemaining.replace('{{count}}', '12'), 'Remaining AI credits: 12');
});

test('zero produce lo stato esaurito', () => {
  assert.deepEqual(resolveDocumentAiCreditState(0), { kind: 'exhausted' });
  assert.equal(it.documentAiCreditsExhausted, 'Crediti AI esauriti');
  assert.equal(en.documentAiCreditsExhausted, 'AI credits exhausted');
});

test('valore non disponibile non produce una riga crediti', () => {
  for (const value of [undefined, null, Number.NaN, -1, 1.5, '12']) {
    assert.deepEqual(resolveDocumentAiCreditState(value), { kind: 'unavailable' });
  }
  assert.match(route, /documentAiCreditState\.kind === 'remaining'/);
  assert.match(route, /documentAiCreditState\.kind === 'exhausted'[\s\S]*?: null/);
});

test('quota riusa LicenseProvider senza introdurre chiamate remote', () => {
  assert.match(route, /useLicense\(\)/);
  assert.match(route, /'aiCreditsRemaining' in licenseStatus/);
  assert.doesNotMatch(route, /callSupabaseFunction|fetch\(/);
});

test('box supporta light e dark mode tramite token adattivi', () => {
  assert.match(route, /backgroundColor: colors\.infoSurface/);
  assert.match(route, /color: colors\.textSecondary/);
  assert.doesNotMatch(route, /#[0-9a-f]{3,8}/i);
});

test('testo lungo e font scale grande non hanno larghezze fisse o troncamento', () => {
  const boxStyles = route.slice(route.indexOf('documentAiBox:'), route.indexOf('\n});', route.indexOf('documentAiBox:')));
  assert.match(boxStyles, /minHeight: 44/);
  assert.match(boxStyles, /alignItems: 'center'/);
  assert.match(boxStyles, /flexShrink: 1/);
  assert.doesNotMatch(boxStyles, /numberOfLines|ellipsizeMode|width:\s*\d/);
});

test('payload AI legacy o errore non modifica automaticamente il documento', () => {
  assert.doesNotMatch(route, /setDocument\(outcome\.document\)/);
  assert.match(route, /documentHybridSchemaUnavailable/);
});

test('editor manuale resta disabilitato durante la review ibrida', () => {
  assert.match(route, /editable=\{!saving && !documentAiRunning && !hybridReview\}/);
  assert.match(route, /if \(hybridReview\) return;/);
});

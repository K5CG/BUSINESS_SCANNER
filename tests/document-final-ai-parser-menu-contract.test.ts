import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = (relative: string) => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

test('AI review decisions are persisted and reloadable', () => {
  const screen = read('app/document/[id].tsx');
  const types = read('types/index.ts');
  assert.match(types, /aiReviewState\?:/);
  assert.match(screen, /fromDb\.aiReviewState/);
  assert.match(screen, /persistAndVerifyAiReview\(reviewDocument, 'review_created'\)/);
  assert.match(screen, /persistAndVerifyAiReview\(candidate, reason, acceptedPaths\.length\)/);
  assert.match(screen, /getDocumentById\(persisted\.id\)/);
  assert.match(screen, /AI_REVIEW_STATE_NOT_PERSISTED/);
  assert.match(screen, /materializeAcceptedHybridDocument\(base, nextReview\)/);
  assert.match(screen, /setHybridBaseDocument\(editedWithReview\)/);
});

test('AI diagnostics cover provider, proposals, decisions and persistence without logging document payloads', () => {
  const screen = read('app/document/[id].tsx');
  for (const event of [
    'review_start', 'provider_start', 'provider_done', 'proposals_built',
    'field_', 'accept_all', 'persist_start', 'persist_done', 'persist_failed', 'review_reload',
  ]) assert.ok(screen.includes(`[DocumentAI] ${event}`) || screen.includes('`[DocumentAI] field_${decision}`'));
  assert.doesNotMatch(screen, /\[DocumentAI\][^\n]*(rawText|aiValue|localValue|evidenceText)/);
});

test('global AI action uses the approved wording in IT and is available in EN', () => {
  const it = JSON.parse(read('i18n/it.json')) as Record<string, string>;
  const en = JSON.parse(read('i18n/en.json')) as Record<string, string>;
  assert.equal(it.documentHybridAcceptAll, 'Accetta tutte le modifiche proposte');
  assert.equal(en.documentHybridAcceptAll, 'Accept all proposed changes');
  const review = read('components/DocumentHybridReview.tsx');
  assert.match(review, /documentHybridAcceptAll/);
  assert.match(review, /state\.decisions\[path\] !== 'accepted'/);
});

test('Altro context uses the existing OtherDocumentTypePicker while commercial context remains unchanged', () => {
  const list = read('app/(tabs)/documents.tsx');
  const detail = read('app/document/[id].tsx');
  assert.match(list, /scanContext === 'other'/);
  assert.match(list, /<OtherDocumentTypePicker/);
  assert.match(list, /processingTypeForCategory\(category\)/);
  assert.match(detail, /documents\?scanContext=other/);
  assert.match(detail, /!\['quote', 'order', 'invoice'\]\.includes\(persisted\.category\)/);
});

test('production parser fix is generic and contains no document-specific identifiers', () => {
  const meta = read('lib/document-parties-metadata.ts');
  assert.match(meta, /resolveHeaderGridIdentity/);
  assert.match(meta, /header_identity_grid_column_owner/);
  assert.match(meta, /headerGridIdentity\.documentNumber \?\? fastHeaderDocumentNumber/);
  assert.match(meta, /headerGridIdentity\.issueDate\s*\?\? resolvedDates\.issueDate/);
  assert.doesNotMatch(meta, /NEVADA|CAMERA DI COMMERCIO|Z0138ADBA9|ZO138ADBA9/);
});

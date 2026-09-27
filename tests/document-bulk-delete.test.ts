import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deleteDocumentsIndividually } from '../lib/document-bulk-delete';
import { pruneDocumentSelection, selectVisibleDocuments, toggleDocumentSelection } from '../lib/document-selection';

const root = process.cwd();
const screen = fs.readFileSync(path.join(root, 'app', '(tabs)', 'documents.tsx'), 'utf8');
const store = fs.readFileSync(path.join(root, 'store', 'useDocumentStore.ts'), 'utf8');

test('1 selezione singola', () => assert.deepEqual([...toggleDocumentSelection(new Set(), 'a')], ['a']));
test('2 selezione multipla', () => assert.deepEqual([...toggleDocumentSelection(new Set(['a']), 'b')], ['a', 'b']));
test('3 deselezione', () => assert.equal(toggleDocumentSelection(new Set(['a']), 'a').size, 0));
test('4 seleziona tutti i risultati visibili', () => assert.deepEqual([...selectVisibleDocuments(new Set(['hidden']), ['a', 'b'])], ['hidden', 'a', 'b']));
test('5 deseleziona tutti usa un set vuoto', () => assert.match(screen, /setSelectedDocumentIds\(new Set\(\)\)/));
test('6 selezione preservata durante scroll', () => assert.match(screen, /keyExtractor=\{\(item\) => item\.id\}/));
test('7 selezione preservata durante ordinamento per identita', () => assert.deepEqual([...pruneDocumentSelection(new Set(['b', 'a']), new Set(['a', 'b']))].sort(), ['a', 'b']));
test('8 documento nascosto dal filtro resta selezionato', () => assert.deepEqual([...selectVisibleDocuments(new Set(['hidden']), ['visible'])], ['hidden', 'visible']));
test('9 documento nascosto dalla ricerca resta selezionato', () => assert.match(screen, /filterDocuments\(documents, searchQuery, typeSelection\)/));
test('10 tap riga apre senza modificare selezione', () => {
  assert.match(screen, /onPress=\{\(\) => router\.push\(`\/document\/\$\{item\.id\}`\)\}/);
  assert.match(screen, /onPress=\{\(\) => toggleSelected\(item\.id\)\}/);
});
test('11 cancellazione bulk richiede conferma', () => assert.match(screen, /documentsBulkDeleteMessage/));
test('12 conferma offre annulla', () => assert.match(screen, /\{ text: t\('cancel'\), style: 'cancel' \}/));

test('13 cancellazione riuscita restituisce tutti gli id', async () => {
  const result = await deleteDocumentsIndividually(['a', 'b'], async () => ({ deleted: true, cleanupPending: false }));
  assert.deepEqual(result.deletedIds, ['a', 'b']);
  assert.equal(result.failed.length, 0);
});

test('14 cancellazione parziale conserva i fallimenti', async () => {
  const result = await deleteDocumentsIndividually(['a', 'b'], async (id) => id === 'a' ? { deleted: true, cleanupPending: false } : { deleted: false, cleanupPending: false });
  assert.deepEqual(result.deletedIds, ['a']);
  assert.deepEqual(result.failed.map((entry) => entry.id), ['b']);
});

test('15 errore filesystem non interrompe gli altri documenti', async () => {
  const result = await deleteDocumentsIndividually(['fs', 'ok'], async (id) => {
    if (id === 'fs') throw new Error('filesystem');
    return { deleted: true, cleanupPending: false };
  });
  assert.deepEqual(result.deletedIds, ['ok']);
  assert.deepEqual(result.failed.map((entry) => entry.id), ['fs']);
});

test('16 errore SQLite non viene dichiarato successo', async () => {
  const result = await deleteDocumentsIndividually(['db'], async () => { throw new Error('sqlite'); });
  assert.equal(result.deletedIds.length, 0);
  assert.equal(result.failed.length, 1);
});

test('17 cleanup immagini pendente resta esplicito', async () => {
  const result = await deleteDocumentsIndividually(['a'], async () => ({ deleted: true, cleanupPending: true }));
  assert.deepEqual(result.cleanupPendingIds, ['a']);
});
test('18 usa la saga asset transazionale esistente', () => assert.match(store, /deleteDocumentsIndividually\(ids, deleteDocumentWithAssets, onProgress\)/));
test('19 doppio tap bloccato con ref sincrono', () => {
  assert.match(screen, /if \(deletingSelectedRef\.current\) return/);
  assert.match(screen, /deletingSelectedRef\.current = true/);
});
test('20 light mode usa token tema', () => assert.match(screen, /backgroundColor: colors\.surface/));
test('21 dark mode usa gli stessi token tema', () => assert.doesNotMatch(screen, /#[0-9a-f]{3,8}/i));
test('22 checkbox accessibile con stato checked', () => {
  assert.match(screen, /accessibilityRole="checkbox"/);
  assert.match(screen, /accessibilityState=\{\{ checked:/);
});
test('23 conteggio totale selezionato visibile', () => assert.match(screen, /documentsSelectedCount.*selectedCount/s));
test('24 store aggiorna lista e documento corrente solo per successi', () => {
  assert.match(store, /documents: state\.documents\.filter\(\(document\) => !deleted\.has\(document\.id\)\)/);
  assert.match(store, /currentDocument.*deleted\.has\(state\.currentDocument\.id\)/s);
});
test('25 cancellazione singola resta disponibile', () => assert.match(screen, /confirmDelete\(item\.id, item\.title\)/));
test('26 banner export obsoleto viene pulito al cambio dataset', () => assert.match(screen, /readyExport\.documentCount !== documents\.filter\(isStoredDocument\)\.length/));
test('27 id duplicati vengono eliminati una sola volta', async () => {
  let calls = 0;
  const result = await deleteDocumentsIndividually(['a', 'a'], async () => { calls += 1; return { deleted: true, cleanupPending: false }; });
  assert.equal(calls, 1);
  assert.equal(result.requested, 1);
});
test('28 avanzamento viene notificato dopo ogni documento', async () => {
  const progress: Array<[number, number]> = [];
  await deleteDocumentsIndividually(['a', 'b'], async () => ({ deleted: true, cleanupPending: false }), (current, total) => progress.push([current, total]));
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.match(screen, /documentsDeleteProgress/);
});
test('29 fallimenti parziali restano selezionati per un nuovo tentativo', () => {
  assert.match(screen, /setSelectedDocumentIds\(new Set\(failedIds\)\)/);
  assert.match(screen, /selectedTitles\.get\(id\) \?\? id/);
});

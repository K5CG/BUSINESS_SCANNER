import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Salva documento resta disponibile con proposte AI pending senza accettarle automaticamente', () => {
  const source = read('app/document/[id].tsx');
  const saveStart = source.indexOf('const handleSave = async () =>');
  const exportStart = source.indexOf('const handleExport', saveStart);
  const saveBody = source.slice(saveStart, exportStart > saveStart ? exportStart : saveStart + 10000);
  assert.doesNotMatch(saveBody, /hybrid_review_pending/);
  assert.doesNotMatch(saveBody, /acceptAllPendingHybridReview/);
  assert.match(source, /disabled=\{saving \|\| documentAiRunning \|\| imageRotationRunning\}/);
});

test('Supporto AI resta subito dopo la prima sezione riepilogativa e precede la review', () => {
  const screen = read('app/document/[id].tsx');
  const details = read('components/DocumentStructuredDetails.tsx');
  const aiFn = screen.slice(
    screen.indexOf('const renderDocumentAiSection'),
    screen.indexOf('const renderEditor', screen.indexOf('const renderDocumentAiSection'))
  );
  assert.match(details, /sectionIndex === 0 \? afterSummary : null/);
  assert.ok(aiFn.indexOf('documentAiSectionTitle') < aiFn.indexOf('<DocumentHybridReview'));
});

test('Review AI e organizzata in gruppi chiusi e articoli AI compatti espandibili', () => {
  const source = read('components/DocumentHybridReview.tsx');
  assert.match(source, /documentHybridGroupDocument/);
  assert.match(source, /documentHybridGroupParties/);
  assert.match(source, /documentHybridGroupTotals/);
  assert.match(source, /documentHybridGroupItems/);
  assert.match(source, /documentHybridGroupOther/);
  assert.match(source, /document: false[\s\S]*parties: false[\s\S]*totals: false[\s\S]*items: false/);
  assert.match(source, /expandedItems/);
  assert.match(source, /documentHybridAcceptAllHint/);
  assert.match(source, /create-outline/);
  assert.match(source, /arrow-undo-outline/);
  assert.match(source, /documentHybridApply/);
});

test('Articoli documento interi partono richiusi e il banner analisi resta paglierino compatto', () => {
  const details = read('components/DocumentStructuredDetails.tsx');
  const screen = read('app/document/[id].tsx');
  assert.match(details, /expandedItemSections/);
  assert.match(details, /documentDetailsRowsCount/);
  assert.match(details, /accessibilityState=\{\{ expanded: !!expandedItemSections\[section\.id\] \}\}/);
  assert.match(screen, /backgroundColor: '#FFF9E6'/);
  assert.match(screen, /partialNoticeText:[\s\S]*typography\.caption/);
});

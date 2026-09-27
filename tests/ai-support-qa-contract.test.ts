import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (p: string) => fs.readFileSync(p, 'utf8');

test('documenti e biglietti condividono lo stesso gate AI QA', () => {
  const policy = read('lib/release-rc-policy.ts');
  const doc = read('lib/document-ai-review.ts');
  const card = read('lib/card-ai-structure.ts');
  assert.match(policy, /RC_AI_QA_ALLOWED = true/);
  assert.match(policy, /return !RC_AI_DISABLED \|\| RC_AI_QA_ALLOWED/);
  assert.match(doc, /isRcCloudAiEnabled\(\)/);
  assert.match(card, /isRcCloudAiEnabled\(\)/);
});

test('ogni richiesta parse-document fattura una sola pagina e ripristina indice reale lato client', () => {
  const src = read('lib/gemini-ocr.ts');
  assert.match(src, /pageIndex: 0,\s*pageCount: 1,/s);
  assert.match(src, /forceClientStructuredPageIndex\([\s\S]*pageIndex/);
});

test('saldo crediti viene sincronizzato dopo AI documenti e biglietti', () => {
  const doc = read('app/document/[id].tsx');
  const card = read('components/BusinessCardEditor.tsx');
  assert.match(doc, /updateAiCreditsRemaining\(latestAiCreditsRemaining, 'document'\)/);
  assert.match(card, /updateAiCreditsRemaining\(outcome\.aiCreditsRemaining\)/);
});

test('documenti mostrano e bloccano il costo AI in base alle pagine', () => {
  const doc = read('app/document/[id].tsx');
  assert.match(doc, /creditsToConsume=\{Math\.max\(1, document\.images\.length\)\}/);
  assert.match(doc, /showCredits/);
});

test('pulsante breve Supporto AI e Annulla piu stretto', () => {
  const it = read('i18n/it.json');
  const en = read('i18n/en.json');
  const actions = read('lib/gemini-modal-actions.ts');
  assert.match(it, /"geminiModalSendButton"\s*:\s*"Supporto AI"/);
  assert.match(it, /"documentAiButton"\s*:\s*"Supporto AI"/);
  assert.match(it, /"aiHelpButton"\s*:\s*"Supporto AI"/);
  assert.match(en, /"geminiModalSendButton"\s*:\s*"AI support"/);
  assert.match(actions, /contentKind === 'pdf' \? 1\.4 : 1\.55/);
  assert.match(actions, /contentKind === 'pdf' \? 0\.85 : 0\.65/);
});

test('nessuna patch production specifica per un documento o cliente', () => {
  const files = [
    'lib/gemini-ocr.ts',
    'lib/release-rc-policy.ts',
    'components/BusinessCardEditor.tsx',
    'app/document/[id].tsx',
    'lib/gemini-modal-actions.ts',
  ].map(read).join('\n');
  assert.doesNotMatch(files, /NEVADA|ORD-21|Numero 28|21 nov 2022|CAMERA DI COMMERCIO/);
});

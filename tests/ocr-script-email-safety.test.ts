import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSubstantiveCjkEvidence } from '../lib/ocr-script-gate';
import { chooseFocusedEmail, chooseFocusedEmailConsensus, coalesceObservedInlineEmailPrefix, coalesceObservedSplitEmailRows, isPotentialEmailRow } from '../lib/ocr-email-refinement';
import { collectEmailEvidence } from '../lib/parser-v5/email-evidence';

test('CJK: un singolo glifo spurio non contamina un brand latino', () => {
  assert.equal(hasSubstantiveCjkEvidence('노 intercasa'), false);
  assert.equal(hasSubstantiveCjkEvidence('株式会社 KOMINE'), true);
  assert.equal(hasSubstantiveCjkEvidence('李'), true);
  assert.equal(hasSubstantiveCjkEvidence('intercasa'), false);
});

test('email: un secondo OCR focalizzato puo correggere pochi errori osservati dai pixel', () => {
  const decision = chooseFocusedEmail(
    'ffaccin@lntercasanet.it',
    'f.faccin@intercasanet.it',
  );
  assert.equal(decision.selected, 'f.faccin@intercasanet.it');
  assert.equal(decision.changed, true);
});

test('email: il secondo OCR non puo sostituire con un indirizzo lontano', () => {
  const decision = chooseFocusedEmail(
    'mario.rossi@example.it',
    'other.person@different.com',
  );
  assert.equal(decision.selected, 'mario.rossi@example.it');
  assert.equal(decision.changed, false);
});


test('email: una label E. non viene assorbita nel local-part', () => {
  const evidence = collectEmailEvidence([{
    lineId: 1, pageIndex: 0, confidence: 0.85,
    rawOcr: 'T. 82-53-587-18234 F. 82-53-587-1826 E. deana@gandh.co.kr',
  }]);
  assert.ok(evidence.some((item) => item.value === 'deana@gandh.co.kr'));
  assert.ok(!evidence.some((item) => item.value === 'e.deana@gandh.co.kr'));
});

test('email: una riga con label email senza @ attiva il secondo OCR', () => {
  assert.equal(isPotentialEmailRow('E-mail: katiepabu. edu'), true);
});

test('email: focused pixels may disambiguate a one-letter provider glyph', () => {
  const decision = chooseFocusedEmail(
    'leoratostefano9@ymail.com',
    'leoratostefano9@gmail.com',
  );
  assert.equal(decision.selected, 'leoratostefano9@gmail.com');
  assert.equal(decision.changed, true);
});


test('email: focused OCR non puo aggiungere una lettera al dominio gia valido', () => {
  const decision = chooseFocusedEmail(
    'onlytype @libero.it',
    'onlytype@ilibero.it',
  );
  assert.equal(decision.selected, 'onlytype@libero.it');
  assert.equal(decision.changed, false);
});


test('email: focused OCR non puo troncare un local-part completo gia osservato', () => {
  const decision = chooseFocusedEmail(
    'diego.bandolin@icms.it',
    'bandolin@icms.it',
  );
  assert.equal(decision.selected, 'diego.bandolin@icms.it');
  assert.equal(decision.changed, false);
});


test('email V20: due focused OCR concordi possono correggere un solo glifo host', () => {
  const decision = chooseFocusedEmailConsensus(
    'leoratostefano9@ymail.com',
    [
      'leoratostefano9@gmail.com',
      'noise',
      'leoratostefano9@gmail.com',
      'leoratostefano9@ymail.com',
    ],
  );
  assert.equal(decision.selected, 'leoratostefano9@gmail.com');
  assert.equal(decision.changed, true);
  assert.equal(decision.votes, 2);
});

test('email V20: focused OCR non puo riscrivere i caratteri del local-part', () => {
  const decision = chooseFocusedEmailConsensus(
    'alex.nadalin@namshi.com',
    [
      'clex.nodolin@namshi.com',
      'clex.nodolin@namshi.com',
      'alex.nadalin@namshi.com',
    ],
  );
  assert.equal(decision.selected, 'alex.nadalin@namshi.com');
  assert.equal(decision.changed, false);
});

test('email V20: split OCR osservato con separatore viene ricomposto senza invenzione', () => {
  const lines = coalesceObservedSplitEmailRows([
    { text: 'E-mail diego.', boundingBox: { x: 1, y: 1, width: 10, height: 2 } },
    { text: 'bandolin@icms.it', boundingBox: { x: 1, y: 3, width: 10, height: 2 } },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'E-mail diego.bandolin@icms.it');
  assert.equal(lines[0].boundingBox, undefined);
});

// V21 generic safety cases: a valid business mailbox must not be rewritten by
// a focused crop that loses/churns identity characters, while personal-provider
// mailboxes remain eligible for deep pixel reread.
import { shouldDeepRefineObservedEmail } from '../lib/ocr-email-refinement';

test('V21: business email is not selected for expensive deep reread', () => {
  assert.equal(shouldDeepRefineObservedEmail('E-mail diego.bandolin@icms.it'), false);
});

test('V21: personal provider email is eligible for deep pixel reread', () => {
  assert.equal(shouldDeepRefineObservedEmail('leoratostefano9@ymail.com'), true);
});

test('V21: focused OCR cannot delete a valid local-part prefix', () => {
  const result = chooseFocusedEmail('diego.bandolin@icms.it', 'bandolin@icms.it');
  assert.equal(result.changed, false);
  assert.equal(result.selected, 'diego.bandolin@icms.it');
});


test('V22: same-line observed email prefix is recomposed without invented characters', () => {
  assert.equal(
    coalesceObservedInlineEmailPrefix('E-mail diego. bandolin@icms.it'),
    'E-mail diego.bandolin@icms.it',
  );
});

test('V22: same-line prose before a complete email is not fused', () => {
  assert.equal(
    coalesceObservedInlineEmailPrefix('E-mail support team bandolin@icms.it'),
    'E-mail support team bandolin@icms.it',
  );
});

test('V22: host consensus preserves the exact observed local-part', () => {
  const decision = chooseFocusedEmailConsensus(
    'leoratostefano9@ymail.com',
    [
      'ieoratostefano9@gmail.com',
      'leoratostefano9@gmail.com',
      'leoratostefano9@ymail.com',
    ],
    2,
  );
  assert.equal(decision.changed, true);
  assert.equal(decision.selected, 'leoratostefano9@gmail.com');
  assert.equal(decision.votes, 2);
});

test('V22: a different identity cannot vote an email host into the observed mailbox', () => {
  const decision = chooseFocusedEmailConsensus(
    'alex.nadalin@namshi.com',
    [
      'clex.nodolin@namshl.com',
      'clex.nodolin@namshl.com',
    ],
    2,
  );
  assert.equal(decision.changed, false);
  assert.equal(decision.selected, 'alex.nadalin@namshi.com');
});

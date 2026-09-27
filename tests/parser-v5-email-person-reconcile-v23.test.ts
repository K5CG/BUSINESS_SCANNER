import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileEmailsWithObservedPerson } from '../lib/parser-v5/email-person-reconcile';
import { chooseFocusedEmailHostConsensus, extractFocusedEmailHost } from '../lib/ocr-email-refinement';

test('V23: labelled email row + observed person can restore missing local separator', () => {
  const result = reconcileEmailsWithObservedPerson(
    ['bandolin@icms.it'],
    'Diego',
    'Bandolin',
    'Dott. Diego Bandolin\nE-mail diego bandolin@icms. it',
  );
  assert.deepEqual(result.emails, ['diego.bandolin@icms.it']);
  assert.equal(result.repairs[0]?.reason, 'labeled_email_missing_local_separator');
});

test('V23: one glyph local-part can be reconciled only to unique observed person pattern', () => {
  const result = reconcileEmailsWithObservedPerson(
    ['ieoratostefano9@ymail.com'],
    'Stefano',
    'Leorato',
    'Stefano Leorato\nIstruttore CSEN 1° Livello\nieoratostefano9@ymail.com',
  );
  assert.deepEqual(result.emails, ['leoratostefano9@ymail.com']);
  assert.equal(result.repairs[0]?.reason, 'email_local_one_glyph_person_reconcile');
});

test('V23: raw + email agreeing on spelling is not dictionary-corrected', () => {
  const result = reconcileEmailsWithObservedPerson(
    ['alessio.giullano@isisware.com'],
    'Alessio',
    'Giullano',
    'AlesSIO GIullano\nalesSIO.giullano@ISISware.com',
  );
  assert.deepEqual(result.emails, ['alessio.giullano@isisware.com']);
  assert.equal(result.repairs.length, 0);
});

test('V23: detached prose is not fused into an email', () => {
  const result = reconcileEmailsWithObservedPerson(
    ['bandolin@icms.it'],
    'Diego',
    'Bandolin',
    'Dott. Diego Bandolin\nE-mail support bandolin@icms.it',
  );
  assert.deepEqual(result.emails, ['bandolin@icms.it']);
  assert.equal(result.repairs.length, 0);
});

test('V23: host-only focused OCR preserves local-part and requires consensus', () => {
  assert.equal(extractFocusedEmailHost('gmail.com'), 'gmail.com');
  const result = chooseFocusedEmailHostConsensus(
    'ieoratostefano9@ymail.com',
    ['gmail.com', '@gmail.com', 'ymail.com'],
    2,
  );
  assert.equal(result.selected, 'ieoratostefano9@gmail.com');
  assert.equal(result.changed, true);
  assert.equal(result.votes, 2);
});

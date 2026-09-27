import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseFocusedEmailConsensus,
  chooseFocusedEmailHostConsensus,
} from '../lib/ocr-email-refinement';

test('V26: conflicting optical quorum keeps the already-observed host', () => {
  const result = chooseFocusedEmailConsensus(
    'ieoratostefano9@gmail.com',
    [
      'leoratostefano9@ymail.com',
      'ieoratostefano9@ymail.com',
      'leoratostefano9@ymail.com',
      'leoratostefano9@ymail.com',
      'leoratostefano9@gmail.com',
      'leoratostefano9@gmail.com',
      'leoratostefano9@ymall.com',
      'leoratostefano9@ymall.com',
    ],
    2,
  );
  assert.equal(result.selected, 'ieoratostefano9@gmail.com');
  assert.equal(result.changed, false);
  assert.equal(result.votes, 2);
});

test('V26: an unsupported observed host can still be corrected by one unique quorum', () => {
  const result = chooseFocusedEmailConsensus(
    'leoratostefano9@ymail.com',
    [
      'ieoratostefano9@gmail.com',
      'leoratostefano9@gmail.com',
      'leoratostefano9@ymail.com',
    ],
    2,
  );
  assert.equal(result.selected, 'leoratostefano9@gmail.com');
  assert.equal(result.changed, true);
  assert.equal(result.votes, 2);
});

test('V26: host-only conflicting quorum is fail-closed', () => {
  const result = chooseFocusedEmailHostConsensus(
    'person@gmail.com',
    ['gmail.com', '@gmail.com', 'ymail.com', '@ymail.com', 'ymail.com'],
    2,
  );
  assert.equal(result.selected, 'person@gmail.com');
  assert.equal(result.changed, false);
});

test('V26: host-only unique alternative quorum can correct unsupported host', () => {
  const result = chooseFocusedEmailHostConsensus(
    'person@ymail.com',
    ['gmail.com', '@gmail.com', 'ymail.com'],
    2,
  );
  assert.equal(result.selected, 'person@gmail.com');
  assert.equal(result.changed, true);
  assert.equal(result.votes, 2);
});

test('V26: readings from a different mailbox identity cannot vote the host', () => {
  const result = chooseFocusedEmailConsensus(
    'alex.nadalin@namshi.com',
    ['other.person@namshl.com', 'other.person@namshl.com'],
    2,
  );
  assert.equal(result.selected, 'alex.nadalin@namshi.com');
  assert.equal(result.changed, false);
});

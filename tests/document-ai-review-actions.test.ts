import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptAllPendingHybridReview,
  hasAcceptablePendingHybridReview,
} from '../lib/document-ai-review-actions';

const initial = () => ({
  reconciliation: {
    fields: { documentNumber: {}, issueDate: {}, total: {} },
    items: [{ index: 0 }],
  },
  decisions: {
    documentNumber: 'pending',
    issueDate: 'rejected',
    total: 'manual',
    'items.0': 'pending',
  },
} as any);

const canAccept = (_state: any, path: string) => path !== 'items.0';
const decide = (state: any, path: string) => ({
  ...state,
  decisions: { ...state.decisions, [path]: 'accepted' },
});

test('global acceptance accepts only pending acceptable proposals', () => {
  const result = acceptAllPendingHybridReview(initial(), canAccept, decide);
  assert.deepEqual(result.acceptedPaths, ['documentNumber']);
  assert.equal(result.state.decisions.documentNumber, 'accepted');
  assert.equal(result.state.decisions.issueDate, 'rejected');
  assert.equal(result.state.decisions.total, 'manual');
  assert.equal(result.state.decisions['items.0'], 'pending');
});

test('global accept availability closes when no acceptable pending proposal remains', () => {
  const state = initial();
  assert.equal(hasAcceptablePendingHybridReview(state, canAccept), true);
  const result = acceptAllPendingHybridReview(state, canAccept, decide);
  assert.equal(hasAcceptablePendingHybridReview(result.state, canAccept), false);
});

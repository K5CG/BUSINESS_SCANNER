import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  acceptAllPendingHybridReview,
  hasPendingHybridReview,
} from '../lib/document-ai-review-actions';
import {
  hybridReviewCanSave,
  setHybridManualValue,
} from '../lib/document-hybrid-review';

test('accept-all chiude ogni pending: accetta gli applicabili e rifiuta/non-applica gli altri', () => {
  const initial: any = {
    decisions: { documentNumber: 'pending', shippingTerms: 'pending' },
    reconciliation: { fields: { documentNumber: {}, shippingTerms: {} }, items: [] },
  };
  const result = acceptAllPendingHybridReview(
    initial,
    (_state, candidatePath) => candidatePath === 'documentNumber',
    (state, candidatePath, decision) => ({
      ...state,
      decisions: { ...state.decisions, [candidatePath]: decision },
    }),
  );
  assert.deepEqual(result.acceptedPaths, ['documentNumber']);
  assert.deepEqual(result.ignoredPaths, ['shippingTerms']);
  assert.equal(result.state.decisions.documentNumber, 'accepted');
  assert.equal(result.state.decisions.shippingTerms, 'rejected');
  assert.equal(hasPendingHybridReview(result.state), false);
});

test('correzione manuale salva il valore nel review state e risolve il pending', () => {
  const review = {
    reconciliation: {
      fields: {
        documentNumber: {
          status: 'conflict',
          localValue: 'A',
          aiValue: 'B',
          requiresReview: true,
          reasons: [],
        },
      },
      items: [],
      requiresReview: true,
      conflicts: [],
    },
    validation: { issues: [] },
    decisions: { documentNumber: 'pending' },
  } as any;
  const next = setHybridManualValue(review, 'documentNumber', 'C');
  assert.equal(next.decisions.documentNumber, 'manual');
  assert.equal(next.reconciliation.fields.documentNumber.selectedValue, 'C');
  assert.equal(next.reconciliation.fields.documentNumber.selectedSource, 'manual');
  assert.equal(hybridReviewCanSave(next), true);
});

test('UI collega Correggi manualmente a input reale e ritorno deterministico alla review AI', () => {
  const root = path.resolve(__dirname, '..');
  const reviewSource = fs.readFileSync(path.join(root, 'components', 'DocumentHybridReview.tsx'), 'utf8');
  const screenSource = fs.readFileSync(path.join(root, 'app', 'document', '[id].tsx'), 'utf8');
  assert.match(reviewSource, /<TextInput/);
  assert.match(reviewSource, /onManualValue\(path, manualScalar\)/);
  assert.match(reviewSource, /onManualValue\(path, manualItem\)/);
  assert.match(screenSource, /setHybridManualValue\(hybridReview, path, rawValue\)/);
  assert.match(screenSource, /field_manual_draft/);
  assert.match(screenSource, /scrollToAiReviewRequestedRef/);
  assert.match(screenSource, /onLayout=\{handleAiReviewLayout\}/);
  assert.match(screenSource, /!hasPendingHybridReview\(hybridReview\)/);
});

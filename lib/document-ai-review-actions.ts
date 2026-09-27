export type HybridReviewDecision = 'pending' | 'accepted' | 'rejected' | 'manual';

export interface HybridReviewShape {
  decisions: Record<string, HybridReviewDecision | undefined>;
  reconciliation: {
    fields: Record<string, unknown>;
    items: ReadonlyArray<{ index: number }>;
  };
}

export function hybridReviewPaths(state: HybridReviewShape): string[] {
  return [
    ...Object.keys(state.reconciliation.fields),
    ...state.reconciliation.items.map((item) => `items.${item.index}`),
  ];
}

export function countHybridReviewDecisions(state: HybridReviewShape): Record<HybridReviewDecision, number> {
  const counts: Record<HybridReviewDecision, number> = { pending: 0, accepted: 0, rejected: 0, manual: 0 };
  for (const decision of Object.values(state.decisions)) {
    if (decision && Object.prototype.hasOwnProperty.call(counts, decision)) counts[decision] += 1;
  }
  return counts;
}


export function hasPendingHybridReview(state: HybridReviewShape): boolean {
  return hybridReviewPaths(state).some((path) => state.decisions[path] === 'pending');
}

export function hasAcceptablePendingHybridReview<T extends HybridReviewShape>(
  state: T,
  canAccept: (state: T, path: string) => boolean,
): boolean {
  return hybridReviewPaths(state).some(
    (path) => state.decisions[path] === 'pending' && canAccept(state, path),
  );
}

export function acceptAllPendingHybridReview<T extends HybridReviewShape>(
  state: T,
  canAccept: (state: T, path: string) => boolean,
  decide: (state: T, path: string, decision: 'accepted' | 'rejected') => T,
): { state: T; acceptedPaths: string[]; ignoredPaths: string[] } {
  let next = state;
  const acceptedPaths: string[] = [];
  const ignoredPaths: string[] = [];
  for (const path of hybridReviewPaths(state)) {
    if (next.decisions[path] !== 'pending') continue;
    if (canAccept(next, path)) {
      next = decide(next, path, 'accepted');
      acceptedPaths.push(path);
    } else {
      // A proposal that fails the deterministic acceptability guard is not left
      // pending after the user's explicit global decision. It is closed as
      // rejected/non-applicable, while the local value remains authoritative.
      next = decide(next, path, 'rejected');
      ignoredPaths.push(path);
    }
  }
  return { state: next, acceptedPaths, ignoredPaths };
}

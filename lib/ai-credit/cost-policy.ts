import type { AiOperationType } from './types.ts';

/** Configurable credit costs — commercial values TBD (see AI_CREDIT_COST_POLICY.md). */
export interface AiCreditCostPolicy {
  business_card_ai: number;
  document_page_ai: number;
  pdf_page_ai: number;
  document_reprocess: number;
}

export const DEFAULT_AI_CREDIT_COST_POLICY: AiCreditCostPolicy = {
  business_card_ai: 1,
  document_page_ai: 1,
  pdf_page_ai: 1,
  document_reprocess: 1,
};

export function creditsForOperation(
  operationType: AiOperationType,
  policy: AiCreditCostPolicy = DEFAULT_AI_CREDIT_COST_POLICY,
  pageCount = 1
): number {
  const pages = Math.max(1, Math.min(pageCount, 100));
  switch (operationType) {
    case 'business_card_ai':
      return policy.business_card_ai;
    case 'document_page_ai':
      return policy.document_page_ai * pages;
    case 'pdf_page_ai':
      return policy.pdf_page_ai * pages;
    case 'document_reprocess':
      return policy.document_reprocess * pages;
    default:
      return 1;
  }
}

/** Server-side only — rejects client-supplied cost overrides. */
export function assertServerSideCost(
  clientCost: unknown
): clientCost is never {
  return clientCost !== undefined && clientCost !== null;
}

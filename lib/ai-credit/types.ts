/** Commercial AI credit types — separate from ops rate limit (ai_usage_daily). */

export type AiCreditTransactionType =
  | 'grant'
  | 'consume'
  | 'refund'
  | 'purchase'
  | 'admin_adjustment'
  | 'trial_grant'
  | 'promotional_grant'
  | 'release';

export type AiCreditAccountStatus = 'active' | 'suspended' | 'closed';

export type AiOperationType =
  | 'business_card_ai'
  | 'document_page_ai'
  | 'pdf_page_ai'
  | 'document_reprocess';

export type AiCreditGrantSource =
  | 'trial'
  | 'manual_b2b'
  | 'premium'
  | 'purchase'
  | 'admin'
  | 'promotional';

export interface AiCreditAccount {
  id: string;
  licenseId: string | null;
  accountId: string | null;
  installationId: string;
  balance: number;
  status: AiCreditAccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AiCreditTransaction {
  id: string;
  creditAccountId: string;
  operationId: string;
  transactionType: AiCreditTransactionType;
  creditsDelta: number;
  balanceAfter: number;
  source: string;
  referenceId: string | null;
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
}

export interface AiCreditReservation {
  reservationId: string;
  creditAccountId: string;
  operationId: string;
  operationType: AiOperationType;
  creditsReserved: number;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'committed' | 'released';
}

export interface AiCreditBalanceView {
  balance: number;
  available: boolean;
  accountId: string | null;
}

export type AiCreditGuardErrorCode =
  | 'insufficient_credits'
  | 'account_suspended'
  | 'duplicate_operation'
  | 'reservation_not_found'
  | 'reservation_expired'
  | 'invalid_operation';

export interface AiCreditGuardResult<T = void> {
  ok: boolean;
  errorCode?: AiCreditGuardErrorCode;
  data?: T;
}

export const AI_OPERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

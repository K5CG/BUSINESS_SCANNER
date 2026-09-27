import type { AiCreditLedgerPort } from './ledger-port.ts';
import type { GrantAiCreditsInput, ReserveAiCreditsInput } from './ledger.ts';
import type {
  AiCreditAccount,
  AiCreditReservation,
  AiCreditTransaction,
  AiOperationType,
} from './types.ts';

/** Minimal Supabase client surface used by the durable ledger. */
export interface AiCreditRpcClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

function mapRpcError(error: { message?: string } | null): Error {
  const message = String(error?.message ?? 'ai_credits_unavailable');
  if (message.includes('insufficient_credits')) return new Error('insufficient_credits');
  if (message.includes('duplicate_operation')) return new Error('duplicate_operation');
  if (message.includes('account_suspended')) return new Error('account_suspended');
  if (message.includes('reservation_not_found')) return new Error('reservation_not_found');
  if (message.includes('reservation_expired')) return new Error('reservation_expired');
  return new Error(message);
}

function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  if (data && typeof data === 'object') return data as T;
  return null;
}

/**
 * Durable Postgres AI credit ledger via SECURITY DEFINER RPCs (service_role).
 */
function asLicenseUuid(licenseId: string | null | undefined): string | null {
  if (!licenseId) return null;
  const trimmed = licenseId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export class SupabaseAiCreditLedger implements AiCreditLedgerPort {
  constructor(private readonly client: AiCreditRpcClient) {}

  async getBalance(installationId: string, licenseId: string | null = null): Promise<number> {
    const { data, error } = await this.client.rpc('get_ai_credit_balance', {
      p_installation_id: installationId,
      p_license_id: asLicenseUuid(licenseId),
    });
    if (error) throw mapRpcError(error);
    const row = firstRow<{ balance?: number }>(data);
    return typeof row?.balance === 'number' ? row.balance : 0;
  }

  async getOrCreateAccount(
    installationId: string,
    licenseId: string | null = null
  ): Promise<AiCreditAccount> {
    const { data, error } = await this.client.rpc('get_ai_credit_balance', {
      p_installation_id: installationId,
      p_license_id: asLicenseUuid(licenseId),
    });
    if (error) throw mapRpcError(error);
    const row = firstRow<{ account_id?: string | null; balance?: number; status?: string }>(data);
    if (row?.account_id) {
      return {
        id: row.account_id,
        licenseId,
        accountId: null,
        installationId,
        balance: row.balance ?? 0,
        status: (row.status as AiCreditAccount['status']) ?? 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      id: '00000000-0000-0000-0000-000000000000',
      licenseId,
      accountId: null,
      installationId,
      balance: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async listTransactions(_creditAccountId: string): Promise<readonly AiCreditTransaction[]> {
    // Not required on Edge hot path; bootstrap uses grant idempotency in RPC.
    return [];
  }

  async grant(input: GrantAiCreditsInput): Promise<AiCreditTransaction> {
    const { data, error } = await this.client.rpc('grant_ai_credits', {
      p_installation_id: input.installationId,
      p_license_id: asLicenseUuid(input.licenseId),
      p_amount: input.amount,
      p_operation_id: input.operationId,
      p_transaction_type: input.transactionType ?? 'grant',
      p_source: input.source,
      p_reference_id: input.referenceId,
      p_metadata: input.metadata ?? {},
    });
    if (error) throw mapRpcError(error);
    const row = firstRow<{
      transaction_id?: string;
      balance_after?: number;
      duplicate?: boolean;
    }>(data);
    if (!row?.transaction_id) throw new Error('ai_credits_unavailable');
    return {
      id: row.transaction_id,
      creditAccountId: '',
      operationId: input.operationId,
      transactionType: input.transactionType ?? 'grant',
      creditsDelta: input.amount,
      balanceAfter: row.balance_after ?? 0,
      source: input.source,
      referenceId: input.referenceId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
  }

  async reserve(input: ReserveAiCreditsInput): Promise<AiCreditReservation> {
    const { data, error } = await this.client.rpc('reserve_ai_credits', {
      p_installation_id: input.installationId,
      p_license_id: asLicenseUuid(input.licenseId),
      p_operation_id: input.operationId,
      p_operation_type: input.operationType,
      p_credits: input.credits,
      p_lease_seconds: input.leaseSeconds ?? 120,
    });
    if (error) throw mapRpcError(error);
    const row = firstRow<{
      reservation_id?: string;
      credit_account_id?: string;
      credits_reserved?: number;
      expires_at?: string;
      status?: string;
    }>(data);
    if (!row?.reservation_id) throw new Error('ai_credits_unavailable');
    return {
      reservationId: row.reservation_id,
      creditAccountId: row.credit_account_id ?? '',
      operationId: input.operationId,
      operationType: input.operationType as AiOperationType,
      creditsReserved: row.credits_reserved ?? input.credits,
      createdAt: new Date().toISOString(),
      expiresAt: row.expires_at ?? new Date(Date.now() + 120_000).toISOString(),
      status: (row.status as AiCreditReservation['status']) ?? 'pending',
    };
  }

  async commit(reservationId: string): Promise<AiCreditTransaction> {
    const { data, error } = await this.client.rpc('commit_ai_credit_usage', {
      p_reservation_id: reservationId,
    });
    if (error) throw mapRpcError(error);
    const row = firstRow<{
      transaction_id?: string;
      balance_after?: number;
    }>(data);
    if (!row?.transaction_id) throw new Error('ai_credits_unavailable');
    return {
      id: row.transaction_id,
      creditAccountId: '',
      operationId: '',
      transactionType: 'consume',
      creditsDelta: 0,
      balanceAfter: row.balance_after ?? 0,
      source: 'commit',
      referenceId: reservationId,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
  }

  async release(reservationId: string): Promise<void> {
    const { error } = await this.client.rpc('release_ai_credit_reservation', {
      p_reservation_id: reservationId,
    });
    if (error) throw mapRpcError(error);
  }
}

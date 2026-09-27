import { randomUUID } from 'node:crypto';
import type {
  AiCreditAccount,
  AiCreditAccountStatus,
  AiCreditGrantSource,
  AiCreditReservation,
  AiCreditTransaction,
  AiCreditTransactionType,
  AiOperationType,
} from './types.ts';

export interface GrantAiCreditsInput {
  licenseId: string | null;
  installationId: string;
  amount: number;
  source: AiCreditGrantSource;
  referenceId: string;
  operationId: string;
  transactionType?: Extract<
    AiCreditTransactionType,
    'grant' | 'trial_grant' | 'promotional_grant' | 'purchase' | 'admin_adjustment' | 'refund'
  >;
  metadata?: Record<string, string | number | boolean>;
}

export interface ReserveAiCreditsInput {
  licenseId: string | null;
  installationId: string;
  operationId: string;
  operationType: AiOperationType;
  credits: number;
  leaseSeconds?: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function consumeKey(accountId: string, operationId: string): string {
  return `${accountId}:${operationId}:consume`;
}

function grantKey(accountId: string, operationId: string, type: AiCreditTransactionType): string {
  return `${accountId}:${operationId}:${type}`;
}

/**
 * In-memory commercial credit ledger for local Phase 3C.
 * Production replaces this with Supabase RPC (see SUPABASE_AI_CREDITS_MIGRATION_DRAFT.sql).
 */
export class InMemoryAiCreditLedger {
  private accounts = new Map<string, AiCreditAccount>();
  private transactions: AiCreditTransaction[] = [];
  private reservations = new Map<string, AiCreditReservation>();
  private idempotencyKeys = new Set<string>();

  getAccountByInstallation(installationId: string): AiCreditAccount | null {
    for (const account of this.accounts.values()) {
      if (account.installationId === installationId && account.status === 'active') {
        return account;
      }
    }
    return null;
  }

  getOrCreateAccount(
    installationId: string,
    licenseId: string | null = null
  ): AiCreditAccount {
    for (const account of this.accounts.values()) {
      if (account.installationId === installationId) return account;
    }

    const account: AiCreditAccount = {
      id: randomUUID(),
      licenseId,
      accountId: null,
      installationId,
      balance: 0,
      status: 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.accounts.set(account.id, account);
    return account;
  }

  getBalance(installationId: string): number {
    return this.getAccountByInstallation(installationId)?.balance ?? 0;
  }

  listTransactions(creditAccountId: string): readonly AiCreditTransaction[] {
    return this.transactions.filter((t) => t.creditAccountId === creditAccountId);
  }

  reconcileBalance(creditAccountId: string): number {
    const account = this.accounts.get(creditAccountId);
    if (!account) return 0;
    const fromLedger = this.transactions
      .filter((t) => t.creditAccountId === creditAccountId)
      .reduce((sum, t) => sum + t.creditsDelta, 0);
    return fromLedger;
  }

  private appendTransaction(
    account: AiCreditAccount,
    input: {
      operationId: string;
      transactionType: AiCreditTransactionType;
      creditsDelta: number;
      source: string;
      referenceId: string | null;
      metadata?: Record<string, string | number | boolean>;
      idempotencyKey: string;
    }
  ): { ok: true; transaction: AiCreditTransaction } | { ok: false; duplicate: true } {
    if (this.idempotencyKeys.has(input.idempotencyKey)) {
      const existing = this.transactions.find(
        (t) =>
          t.creditAccountId === account.id &&
          t.operationId === input.operationId &&
          t.transactionType === input.transactionType
      );
      if (existing) return { ok: true, transaction: existing };
      return { ok: false, duplicate: true };
    }

    const nextBalance = account.balance + input.creditsDelta;
    if (input.transactionType === 'consume' && nextBalance < 0) {
      throw new Error('insufficient_credits');
    }

    account.balance = nextBalance;
    account.updatedAt = nowIso();

    const transaction: AiCreditTransaction = {
      id: randomUUID(),
      creditAccountId: account.id,
      operationId: input.operationId,
      transactionType: input.transactionType,
      creditsDelta: input.creditsDelta,
      balanceAfter: nextBalance,
      source: input.source,
      referenceId: input.referenceId,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    };
    this.transactions.push(transaction);
    this.idempotencyKeys.add(input.idempotencyKey);
    this.accounts.set(account.id, account);
    return { ok: true, transaction };
  }

  grant(input: GrantAiCreditsInput): AiCreditTransaction {
    if (input.amount <= 0) throw new Error('invalid_grant_amount');
    const account = this.getOrCreateAccount(input.installationId, input.licenseId);
    if (account.status !== 'active') throw new Error('account_suspended');

    const txType = input.transactionType ?? 'grant';
    if (
      input.referenceId &&
      input.referenceId.startsWith('premium-monthly:') &&
      txType === 'grant'
    ) {
      const byReference = this.transactions.find(
        (t) =>
          t.creditAccountId === account.id &&
          t.referenceId === input.referenceId &&
          t.transactionType === 'grant'
      );
      if (byReference) return byReference;
    }

    const result = this.appendTransaction(account, {
      operationId: input.operationId,
      transactionType: txType,
      creditsDelta: input.amount,
      source: input.source,
      referenceId: input.referenceId,
      metadata: input.metadata,
      idempotencyKey: grantKey(account.id, input.operationId, txType),
    });
    if (!result.ok) {
      const dup = this.transactions.find(
        (t) => t.operationId === input.operationId && t.transactionType === txType
      );
      if (dup) return dup;
      throw new Error('duplicate_operation');
    }
    return result.transaction;
  }

  reserve(input: ReserveAiCreditsInput): AiCreditReservation {
    const account = this.getOrCreateAccount(input.installationId, input.licenseId);
    if (account.status !== 'active') throw new Error('account_suspended');

    const existingConsume = this.transactions.find(
      (t) =>
        t.creditAccountId === account.id &&
        t.operationId === input.operationId &&
        t.transactionType === 'consume'
    );
    if (existingConsume) {
      throw new Error('duplicate_operation');
    }

    for (const res of this.reservations.values()) {
      if (
        res.creditAccountId === account.id &&
        res.operationId === input.operationId &&
        res.status === 'pending'
      ) {
        return res;
      }
    }

    if (account.balance < input.credits) {
      throw new Error('insufficient_credits');
    }

    account.balance -= input.credits;
    account.updatedAt = nowIso();
    this.accounts.set(account.id, account);

    const leaseSeconds = input.leaseSeconds ?? 120;
    const reservation: AiCreditReservation = {
      reservationId: randomUUID(),
      creditAccountId: account.id,
      operationId: input.operationId,
      operationType: input.operationType,
      creditsReserved: input.credits,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
      status: 'pending',
    };
    this.reservations.set(reservation.reservationId, reservation);
    return reservation;
  }

  commit(reservationId: string): AiCreditTransaction {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error('reservation_not_found');
    if (reservation.status === 'committed') {
      const existing = this.transactions.find(
        (t) =>
          t.operationId === reservation.operationId &&
          t.transactionType === 'consume' &&
          t.creditAccountId === reservation.creditAccountId
      );
      if (existing) return existing;
      throw new Error('duplicate_operation');
    }
    if (reservation.status === 'released') throw new Error('reservation_not_found');
    if (new Date(reservation.expiresAt).getTime() <= Date.now()) {
      this.release(reservationId);
      throw new Error('reservation_expired');
    }

    const account = this.accounts.get(reservation.creditAccountId);
    if (!account) throw new Error('account_not_found');

    const idempotencyKey = consumeKey(account.id, reservation.operationId);
    if (this.idempotencyKeys.has(idempotencyKey)) {
      const dup = this.transactions.find(
        (t) =>
          t.operationId === reservation.operationId &&
          t.transactionType === 'consume'
      );
      if (dup) return dup;
      throw new Error('duplicate_operation');
    }

    reservation.status = 'committed';
    this.reservations.set(reservationId, reservation);

    const transaction: AiCreditTransaction = {
      id: randomUUID(),
      creditAccountId: account.id,
      operationId: reservation.operationId,
      transactionType: 'consume',
      creditsDelta: -reservation.creditsReserved,
      balanceAfter: account.balance,
      source: reservation.operationType,
      referenceId: reservationId,
      metadata: { operationType: reservation.operationType },
      createdAt: nowIso(),
    };
    this.transactions.push(transaction);
    this.idempotencyKeys.add(idempotencyKey);
    return transaction;
  }

  release(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.status !== 'pending') return;

    const account = this.accounts.get(reservation.creditAccountId);
    if (account) {
      account.balance += reservation.creditsReserved;
      account.updatedAt = nowIso();
      this.accounts.set(account.id, account);
    }
    reservation.status = 'released';
    this.reservations.set(reservationId, reservation);
  }

  expireReservations(nowMs = Date.now()): number {
    let count = 0;
    for (const [id, res] of this.reservations.entries()) {
      if (res.status === 'pending' && new Date(res.expiresAt).getTime() <= nowMs) {
        this.release(id);
        count += 1;
      }
    }
    return count;
  }

  setAccountStatus(installationId: string, status: AiCreditAccountStatus): void {
    for (const account of this.accounts.values()) {
      if (account.installationId === installationId) {
        account.status = status;
        account.updatedAt = nowIso();
        this.accounts.set(account.id, account);
        return;
      }
    }
  }
}

/** Process-local ledger until Supabase RPC is applied. */
let sharedLedger: InMemoryAiCreditLedger | null = null;

export function getSharedAiCreditLedger(): InMemoryAiCreditLedger {
  if (!sharedLedger) sharedLedger = new InMemoryAiCreditLedger();
  return sharedLedger;
}

export function resetSharedAiCreditLedger(): void {
  sharedLedger = null;
}

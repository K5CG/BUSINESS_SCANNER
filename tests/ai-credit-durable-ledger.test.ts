/**
 * Durable-ledger semantics exercised against SupabaseAiCreditLedger + a
 * mutex-serialized fake RPC that mirrors 006_ai_credit_ledger.sql rules.
 * Unit tests do not require a live Postgres; production cert uses live RPCs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { creditsForOperation, DEFAULT_AI_CREDIT_COST_POLICY } from '../lib/ai-credit/cost-policy.ts';
import { AiCreditGuard } from '../lib/ai-credit/guard.ts';
import {
  type AiCreditRpcClient,
  SupabaseAiCreditLedger,
} from '../lib/ai-credit/supabase-ledger.ts';

type Account = {
  id: string;
  installationId: string;
  licenseId: string | null;
  balance: number;
  status: 'active' | 'suspended';
};

type Reservation = {
  reservationId: string;
  creditAccountId: string;
  operationId: string;
  operationType: string;
  creditsReserved: number;
  status: 'pending' | 'committed' | 'released';
  expiresAt: number;
};

type Tx = {
  id: string;
  creditAccountId: string;
  operationId: string;
  transactionType: string;
  creditsDelta: number;
  balanceAfter: number;
  referenceId: string | null;
};

class FakeDurableRpc implements AiCreditRpcClient {
  accounts = new Map<string, Account>();
  reservations: Reservation[] = [];
  transactions: Tx[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  /** Serialize like Postgres row locks. */
  private exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private accountByInstallation(installationId: string): Account | undefined {
    for (const a of this.accounts.values()) {
      if (a.installationId === installationId && a.status === 'active') return a;
    }
    return undefined;
  }

  private ensureAccount(installationId: string, licenseId: string | null): Account {
    let account = this.accountByInstallation(installationId);
    if (!account) {
      account = {
        id: randomUUID(),
        installationId,
        licenseId,
        balance: 0,
        status: 'active',
      };
      this.accounts.set(account.id, account);
    }
    return account;
  }

  rpc(fn: string, args: Record<string, unknown> = {}) {
    return this.exclusive(() => this.dispatch(fn, args)).then(
      (data) => ({ data, error: null }),
      (error: Error) => ({ data: null, error: { message: error.message } })
    );
  }

  private dispatch(fn: string, args: Record<string, unknown>): unknown {
    switch (fn) {
      case 'get_ai_credit_balance': {
        const account = this.accountByInstallation(String(args.p_installation_id));
        if (!account) {
          return [{ account_id: null, balance: 0, status: 'active', available: true }];
        }
        return [
          {
            account_id: account.id,
            balance: account.balance,
            status: account.status,
            available: account.status === 'active',
          },
        ];
      }
      case 'grant_ai_credits': {
        const installationId = String(args.p_installation_id);
        const amount = Number(args.p_amount);
        const operationId = String(args.p_operation_id);
        const transactionType = String(args.p_transaction_type);
        const referenceId =
          args.p_reference_id == null ? null : String(args.p_reference_id);
        const account = this.ensureAccount(
          installationId,
          args.p_license_id == null ? null : String(args.p_license_id)
        );
        if (account.status !== 'active') throw new Error('account_suspended');
        if (
          referenceId &&
          referenceId.startsWith('premium-monthly:') &&
          transactionType === 'grant'
        ) {
          const byRef = this.transactions.find(
            (t) =>
              t.creditAccountId === account.id &&
              t.referenceId === referenceId &&
              t.transactionType === 'grant'
          );
          if (byRef) {
            return [
              {
                transaction_id: byRef.id,
                balance_after: account.balance,
                duplicate: true,
              },
            ];
          }
        }
        const existing = this.transactions.find(
          (t) =>
            t.creditAccountId === account.id &&
            t.operationId === operationId &&
            t.transactionType === transactionType
        );
        if (existing) {
          return [
            {
              transaction_id: existing.id,
              balance_after: account.balance,
              duplicate: true,
            },
          ];
        }
        account.balance += amount;
        const tx: Tx = {
          id: randomUUID(),
          creditAccountId: account.id,
          operationId,
          transactionType,
          creditsDelta: amount,
          balanceAfter: account.balance,
          referenceId,
        };
        this.transactions.push(tx);
        return [{ transaction_id: tx.id, balance_after: account.balance, duplicate: false }];
      }
      case 'reserve_ai_credits': {
        const installationId = String(args.p_installation_id);
        const operationId = String(args.p_operation_id);
        const credits = Number(args.p_credits);
        const leaseSeconds = Number(args.p_lease_seconds ?? 120);
        const account = this.ensureAccount(
          installationId,
          args.p_license_id == null ? null : String(args.p_license_id)
        );
        if (account.status !== 'active') throw new Error('account_suspended');

        const now = Date.now();
        for (const res of this.reservations) {
          if (
            res.creditAccountId === account.id &&
            res.status === 'pending' &&
            res.expiresAt <= now
          ) {
            account.balance += res.creditsReserved;
            res.status = 'released';
            this.transactions.push({
              id: randomUUID(),
              creditAccountId: account.id,
              operationId: res.operationId,
              transactionType: 'release',
              creditsDelta: res.creditsReserved,
              balanceAfter: account.balance,
              referenceId: res.reservationId,
            });
          }
        }

        if (
          this.transactions.some(
            (t) =>
              t.creditAccountId === account.id &&
              t.operationId === operationId &&
              t.transactionType === 'consume'
          )
        ) {
          throw new Error('duplicate_operation');
        }

        const prior = [...this.reservations]
          .reverse()
          .find(
            (r) => r.creditAccountId === account.id && r.operationId === operationId
          );
        if (prior) {
          if (prior.status === 'pending') {
            return [
              {
                reservation_id: prior.reservationId,
                credit_account_id: prior.creditAccountId,
                credits_reserved: prior.creditsReserved,
                expires_at: new Date(prior.expiresAt).toISOString(),
                status: prior.status,
                duplicate: true,
              },
            ];
          }
          throw new Error('duplicate_operation');
        }

        if (account.balance < credits) throw new Error('insufficient_credits');
        account.balance -= credits;
        const reservation: Reservation = {
          reservationId: randomUUID(),
          creditAccountId: account.id,
          operationId,
          operationType: String(args.p_operation_type),
          creditsReserved: credits,
          status: 'pending',
          expiresAt: now + leaseSeconds * 1000,
        };
        this.reservations.push(reservation);
        return [
          {
            reservation_id: reservation.reservationId,
            credit_account_id: account.id,
            credits_reserved: credits,
            expires_at: new Date(reservation.expiresAt).toISOString(),
            status: 'pending',
            duplicate: false,
          },
        ];
      }
      case 'commit_ai_credit_usage': {
        const reservationId = String(args.p_reservation_id);
        const res = this.reservations.find((r) => r.reservationId === reservationId);
        if (!res) throw new Error('reservation_not_found');
        const account = this.accounts.get(res.creditAccountId);
        if (!account) throw new Error('reservation_not_found');
        if (res.status === 'committed') {
          const existing = this.transactions.find(
            (t) =>
              t.creditAccountId === account.id &&
              t.operationId === res.operationId &&
              t.transactionType === 'consume'
          );
          return [
            {
              transaction_id: existing?.id ?? randomUUID(),
              balance_after: account.balance,
              duplicate: true,
            },
          ];
        }
        if (res.status === 'released') throw new Error('reservation_not_found');
        if (res.expiresAt <= Date.now()) throw new Error('reservation_expired');
        res.status = 'committed';
        const tx: Tx = {
          id: randomUUID(),
          creditAccountId: account.id,
          operationId: res.operationId,
          transactionType: 'consume',
          creditsDelta: -res.creditsReserved,
          balanceAfter: account.balance,
          referenceId: reservationId,
        };
        this.transactions.push(tx);
        return [{ transaction_id: tx.id, balance_after: account.balance, duplicate: false }];
      }
      case 'release_ai_credit_reservation': {
        const reservationId = String(args.p_reservation_id);
        const res = this.reservations.find((r) => r.reservationId === reservationId);
        if (!res) return [{ released: false, balance_after: 0, duplicate: false }];
        const account = this.accounts.get(res.creditAccountId)!;
        if (res.status === 'released') {
          return [{ released: true, balance_after: account.balance, duplicate: true }];
        }
        if (res.status !== 'pending') {
          return [{ released: false, balance_after: 0, duplicate: false }];
        }
        account.balance += res.creditsReserved;
        res.status = 'released';
        this.transactions.push({
          id: randomUUID(),
          creditAccountId: account.id,
          operationId: res.operationId,
          transactionType: 'release',
          creditsDelta: res.creditsReserved,
          balanceAfter: account.balance,
          referenceId: reservationId,
        });
        return [{ released: true, balance_after: account.balance, duplicate: false }];
      }
      default:
        throw new Error(`unknown_rpc:${fn}`);
    }
  }
}

function installation(): string {
  return `inst-${randomUUID().slice(0, 12)}`;
}

test('A. reserve same operationId twice — charged once', async () => {
  const rpc = new FakeDurableRpc();
  const ledger = new SupabaseAiCreditLedger(rpc);
  const installationId = installation();
  await ledger.grant({
    installationId,
    licenseId: null,
    amount: 5,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const operationId = randomUUID();
  const r1 = await ledger.reserve({
    installationId,
    licenseId: null,
    operationId,
    operationType: 'pdf_page_ai',
    credits: 2,
  });
  const r2 = await ledger.reserve({
    installationId,
    licenseId: null,
    operationId,
    operationType: 'pdf_page_ai',
    credits: 2,
  });
  assert.equal(r1.reservationId, r2.reservationId);
  assert.equal(await ledger.getBalance(installationId), 3);
});

test('B. commit same reservation twice — committed once', async () => {
  const rpc = new FakeDurableRpc();
  const ledger = new SupabaseAiCreditLedger(rpc);
  const installationId = installation();
  await ledger.grant({
    installationId,
    licenseId: null,
    amount: 5,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const res = await ledger.reserve({
    installationId,
    licenseId: null,
    operationId: randomUUID(),
    operationType: 'business_card_ai',
    credits: 1,
  });
  const c1 = await ledger.commit(res.reservationId);
  const c2 = await ledger.commit(res.reservationId);
  assert.equal(c1.id, c2.id);
  assert.equal(await ledger.getBalance(installationId), 4);
  assert.equal(
    rpc.transactions.filter((t) => t.transactionType === 'consume').length,
    1
  );
});

test('C. release same reservation twice — refunded once', async () => {
  const rpc = new FakeDurableRpc();
  const ledger = new SupabaseAiCreditLedger(rpc);
  const installationId = installation();
  await ledger.grant({
    installationId,
    licenseId: null,
    amount: 5,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const res = await ledger.reserve({
    installationId,
    licenseId: null,
    operationId: randomUUID(),
    operationType: 'business_card_ai',
    credits: 2,
  });
  await ledger.release(res.reservationId);
  await ledger.release(res.reservationId);
  assert.equal(await ledger.getBalance(installationId), 5);
  assert.equal(
    rpc.transactions.filter((t) => t.transactionType === 'release').length,
    1
  );
});

test('D. commit then retry reserve — duplicate_operation, no new charge', async () => {
  const rpc = new FakeDurableRpc();
  const ledger = new SupabaseAiCreditLedger(rpc);
  const installationId = installation();
  await ledger.grant({
    installationId,
    licenseId: null,
    amount: 5,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const operationId = randomUUID();
  const res = await ledger.reserve({
    installationId,
    licenseId: null,
    operationId,
    operationType: 'business_card_ai',
    credits: 1,
  });
  await ledger.commit(res.reservationId);
  await assert.rejects(
    () =>
      ledger.reserve({
        installationId,
        licenseId: null,
        operationId,
        operationType: 'business_card_ai',
        credits: 1,
      }),
    /duplicate_operation/
  );
  assert.equal(await ledger.getBalance(installationId), 4);
});

test('E. release then retry reserve — no accidental re-charge', async () => {
  const rpc = new FakeDurableRpc();
  const ledger = new SupabaseAiCreditLedger(rpc);
  const installationId = installation();
  await ledger.grant({
    installationId,
    licenseId: null,
    amount: 5,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const operationId = randomUUID();
  const res = await ledger.reserve({
    installationId,
    licenseId: null,
    operationId,
    operationType: 'business_card_ai',
    credits: 1,
  });
  await ledger.release(res.reservationId);
  await assert.rejects(
    () =>
      ledger.reserve({
        installationId,
        licenseId: null,
        operationId,
        operationType: 'business_card_ai',
        credits: 1,
      }),
    /duplicate_operation/
  );
  assert.equal(await ledger.getBalance(installationId), 5);
});

test('F. trial grant idempotency key twice — one grant', async () => {
  const rpc = new FakeDurableRpc();
  const ledger = new SupabaseAiCreditLedger(rpc);
  const installationId = installation();
  const input = {
    installationId,
    licenseId: null as string | null,
    amount: 5,
    source: 'trial' as const,
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant' as const,
  };
  await ledger.grant(input);
  await ledger.grant(input);
  assert.equal(await ledger.getBalance(installationId), 5);
  assert.equal(
    rpc.transactions.filter((t) => t.transactionType === 'trial_grant').length,
    1
  );
});

test('concurrency — only one expensive reserve succeeds', async () => {
  const rpc = new FakeDurableRpc();
  const ledger = new SupabaseAiCreditLedger(rpc);
  const installationId = installation();
  await ledger.grant({
    installationId,
    licenseId: null,
    amount: 2,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const results = await Promise.allSettled([
    ledger.reserve({
      installationId,
      licenseId: null,
      operationId: randomUUID(),
      operationType: 'pdf_page_ai',
      credits: 2,
    }),
    ledger.reserve({
      installationId,
      licenseId: null,
      operationId: randomUUID(),
      operationType: 'pdf_page_ai',
      credits: 2,
    }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const fail = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(fail.length, 1);
  assert.match(String((fail[0] as PromiseRejectedResult).reason), /insufficient_credits/);
  assert.equal(await ledger.getBalance(installationId), 0);
  assert.ok((await ledger.getBalance(installationId)) >= 0);
});

test('provider failure releases — balance restored', async () => {
  const rpc = new FakeDurableRpc();
  const guard = new AiCreditGuard(new SupabaseAiCreditLedger(rpc));
  const installationId = installation();
  await new SupabaseAiCreditLedger(rpc).grant({
    installationId,
    licenseId: null,
    amount: 5,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const res = await guard.reserve({
    installationId,
    licenseId: null,
    operationId: randomUUID(),
    operationType: 'pdf_page_ai',
    pageCount: 2,
  });
  const outcome = await guard.commitAfterProvider(res.reservationId, 'provider_error');
  assert.equal(outcome.consumed, false);
  assert.equal(await guard.getBalance(installationId), 5);
});

test('multi-page pdf_page_ai charges cost-policy × pageCount', async () => {
  const rpc = new FakeDurableRpc();
  const guard = new AiCreditGuard(new SupabaseAiCreditLedger(rpc));
  const installationId = installation();
  const pages = 2;
  const cost = creditsForOperation('pdf_page_ai', DEFAULT_AI_CREDIT_COST_POLICY, pages);
  assert.equal(cost, 2);
  await new SupabaseAiCreditLedger(rpc).grant({
    installationId,
    licenseId: null,
    amount: 10,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const before = await guard.getBalance(installationId);
  const res = await guard.reserve({
    installationId,
    licenseId: null,
    operationId: randomUUID(),
    operationType: 'pdf_page_ai',
    pageCount: pages,
  });
  assert.equal(res.creditsReserved, cost);
  await guard.commitAfterProvider(res.reservationId, 'success');
  assert.equal(await guard.getBalance(installationId), before - cost);
});

test('Edge restart simulation — new ledger adapter sees prior reservation', async () => {
  const rpc = new FakeDurableRpc();
  const installationId = installation();
  const operationId = randomUUID();
  const before = new SupabaseAiCreditLedger(rpc);
  await before.grant({
    installationId,
    licenseId: null,
    amount: 5,
    source: 'trial',
    referenceId: `trial:${installationId}`,
    operationId: `trial-grant:${installationId}`,
    transactionType: 'trial_grant',
  });
  const first = await before.reserve({
    installationId,
    licenseId: null,
    operationId,
    operationType: 'pdf_page_ai',
    credits: 2,
  });
  // New Edge isolate = new adapter instance, same durable store.
  const afterRestart = new SupabaseAiCreditLedger(rpc);
  const replay = await afterRestart.reserve({
    installationId,
    licenseId: null,
    operationId,
    operationType: 'pdf_page_ai',
    credits: 2,
  });
  assert.equal(replay.reservationId, first.reservationId);
  assert.equal(await afterRestart.getBalance(installationId), 3);
});

test('migration 006 hardens owner-model RPCs and locks service_role', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/006_ai_credit_ledger.sql'),
    'utf8'
  );
  assert.match(sql, /owner_kind/);
  assert.match(sql, /resolve_ai_credit_account/);
  assert.match(sql, /reserve_ai_credits/);
  assert.match(sql, /commit_ai_credit_usage/);
  assert.match(sql, /release_ai_credit_reservation/);
  assert.match(sql, /grant_ai_credits/);
  assert.match(sql, /'release'/);
  assert.match(sql, /TO service_role/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.ai_credit_accounts FROM anon/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /duplicate_operation/);
});

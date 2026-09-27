import type { AiCreditLedgerPort } from './ledger-port.ts';
import {
  InMemoryAiCreditLedger,
  type GrantAiCreditsInput,
  type ReserveAiCreditsInput,
} from './ledger.ts';
import type {
  AiCreditAccount,
  AiCreditReservation,
  AiCreditTransaction,
} from './types.ts';

/** Wraps the sync in-memory ledger for AiCreditGuard / unit tests. */
export class InMemoryAiCreditLedgerAdapter implements AiCreditLedgerPort {
  constructor(private readonly ledger: InMemoryAiCreditLedger) {}

  getBalance(installationId: string, _licenseId?: string | null): Promise<number> {
    return Promise.resolve(this.ledger.getBalance(installationId));
  }

  getOrCreateAccount(
    installationId: string,
    licenseId: string | null = null
  ): Promise<AiCreditAccount> {
    return Promise.resolve(this.ledger.getOrCreateAccount(installationId, licenseId));
  }

  listTransactions(creditAccountId: string): Promise<readonly AiCreditTransaction[]> {
    return Promise.resolve(this.ledger.listTransactions(creditAccountId));
  }

  grant(input: GrantAiCreditsInput): Promise<AiCreditTransaction> {
    return Promise.resolve(this.ledger.grant(input));
  }

  reserve(input: ReserveAiCreditsInput): Promise<AiCreditReservation> {
    return Promise.resolve(this.ledger.reserve(input));
  }

  commit(reservationId: string): Promise<AiCreditTransaction> {
    return Promise.resolve(this.ledger.commit(reservationId));
  }

  release(reservationId: string): Promise<void> {
    this.ledger.release(reservationId);
    return Promise.resolve();
  }

  get syncLedger(): InMemoryAiCreditLedger {
    return this.ledger;
  }
}

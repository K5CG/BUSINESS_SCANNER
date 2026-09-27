import type {
  AiCreditAccount,
  AiCreditReservation,
  AiCreditTransaction,
} from './types.ts';
import type { GrantAiCreditsInput, ReserveAiCreditsInput } from './ledger.ts';

/**
 * Async ledger surface used by AiCreditGuard.
 * In-memory and Postgres adapters both implement this.
 */
export interface AiCreditLedgerPort {
  getBalance(installationId: string, licenseId?: string | null): Promise<number>;
  getOrCreateAccount(
    installationId: string,
    licenseId?: string | null
  ): Promise<AiCreditAccount>;
  listTransactions(creditAccountId: string): Promise<readonly AiCreditTransaction[]>;
  grant(input: GrantAiCreditsInput): Promise<AiCreditTransaction>;
  reserve(input: ReserveAiCreditsInput): Promise<AiCreditReservation>;
  commit(reservationId: string): Promise<AiCreditTransaction>;
  release(reservationId: string): Promise<void>;
}

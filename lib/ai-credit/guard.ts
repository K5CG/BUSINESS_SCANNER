import { creditsForOperation, type AiCreditCostPolicy, DEFAULT_AI_CREDIT_COST_POLICY } from './cost-policy.ts';
import { InMemoryAiCreditLedgerAdapter } from './in-memory-ledger-adapter.ts';
import type { AiCreditLedgerPort } from './ledger-port.ts';
import {
  getSharedAiCreditLedger,
  InMemoryAiCreditLedger,
  type ReserveAiCreditsInput,
} from './ledger.ts';
import type { AiCreditReservation, AiCreditTransaction, AiOperationType } from './types.ts';

export interface AiOperationContext {
  installationId: string;
  licenseId: string | null;
  operationId: string;
  operationType: AiOperationType;
  pageCount?: number;
}

export type AiProviderOutcome = 'success' | 'provider_error' | 'validation_error' | 'timeout';

function asLedgerPort(ledger: AiCreditLedgerPort | InMemoryAiCreditLedger): AiCreditLedgerPort {
  if (ledger instanceof InMemoryAiCreditLedger) {
    return new InMemoryAiCreditLedgerAdapter(ledger);
  }
  return ledger;
}

/**
 * Reserve → provider → commit/release flow.
 * Provider/validation errors release reservation (no consume).
 */
export class AiCreditGuard {
  private ledger: AiCreditLedgerPort;

  constructor(
    ledger: AiCreditLedgerPort | InMemoryAiCreditLedger = getSharedAiCreditLedger(),
    private policy: AiCreditCostPolicy = DEFAULT_AI_CREDIT_COST_POLICY
  ) {
    this.ledger = asLedgerPort(ledger);
  }

  creditsRequired(ctx: AiOperationContext): number {
    return creditsForOperation(ctx.operationType, this.policy, ctx.pageCount ?? 1);
  }

  async reserve(ctx: AiOperationContext): Promise<AiCreditReservation> {
    const credits = this.creditsRequired(ctx);
    const input: ReserveAiCreditsInput = {
      licenseId: ctx.licenseId,
      installationId: ctx.installationId,
      operationId: ctx.operationId,
      operationType: ctx.operationType,
      credits,
    };
    return this.ledger.reserve(input);
  }

  async commitAfterProvider(
    reservationId: string,
    outcome: AiProviderOutcome
  ): Promise<{ consumed: boolean; transaction?: AiCreditTransaction }> {
    if (outcome === 'success') {
      const tx = await this.ledger.commit(reservationId);
      return { consumed: true, transaction: tx };
    }
    await this.ledger.release(reservationId);
    return { consumed: false };
  }

  async getBalance(installationId: string): Promise<number> {
    return this.ledger.getBalance(installationId);
  }
}

import { AiCreditGuard } from '../../../lib/ai-credit/guard.ts';
import { InMemoryAiCreditLedgerAdapter } from '../../../lib/ai-credit/in-memory-ledger-adapter.ts';
import type { AiCreditLedgerPort } from '../../../lib/ai-credit/ledger-port.ts';
import {
  getSharedAiCreditLedger,
  resetSharedAiCreditLedger,
} from '../../../lib/ai-credit/ledger.ts';
import { SupabaseAiCreditLedger } from '../../../lib/ai-credit/supabase-ledger.ts';
import {
  COMMERCIAL_SETTING_KEYS,
  resolveTrialAiCredits,
  TRIAL_AI_CREDITS_MAX,
  TRIAL_AI_CREDITS_MIN,
  type CommercialSettingIntReader,
} from '../../../lib/commercial-settings.ts';
import { readTrialCommercialConfig } from '../../../lib/trial-config.ts';
import {
  premiumMonthlyGrantOperationId,
  premiumMonthlyGrantReferenceId,
  premiumMonthlyPeriodKey,
  resolvePremiumMonthlyGrantAmount,
} from '../../../lib/trial-monthly-grant.ts';
export { resetSharedAiCreditLedger };

/** Lazy load keeps Node unit tests from typechecking Deno Edge modules. */
async function createServiceRoleClient(): Promise<{
  rpc(
    fn: string,
    args?: Record<string, unknown>
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}> {
  const importer = new Function(
    'return import("./license-utils.ts")'
  ) as () => Promise<{ createAdminClient: () => Promise<unknown> }>;
  const mod = await importer();
  return (await mod.createAdminClient()) as {
    rpc(
      fn: string,
      args?: Record<string, unknown>
    ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  };
}

function edgeEnv(): Record<string, string | undefined> {
  if (typeof process !== 'undefined' && process.env) {
    return process.env;
  }
  const deno = (globalThis as { Deno?: { env: { toObject(): Record<string, string> } } })
    .Deno;
  return deno?.env.toObject() ?? {};
}

function forceInMemoryLedger(): boolean {
  const value = edgeEnv().AI_CREDIT_LEDGER_BACKEND?.trim().toLowerCase();
  return value === 'memory' || value === 'inmemory';
}

let sharedPort: AiCreditLedgerPort | null = null;
let sharedPortPromise: Promise<AiCreditLedgerPort> | null = null;

async function resolveLedgerPort(): Promise<AiCreditLedgerPort> {
  if (sharedPort) return sharedPort;
  if (sharedPortPromise) return sharedPortPromise;

  sharedPortPromise = (async () => {
    if (forceInMemoryLedger()) {
      sharedPort = new InMemoryAiCreditLedgerAdapter(getSharedAiCreditLedger());
      return sharedPort;
    }
    try {
      const client = await createServiceRoleClient();
      sharedPort = new SupabaseAiCreditLedger(client);
      return sharedPort;
    } catch (error) {
      // Fail closed: never silently fall back to process-local Maps in production.
      sharedPort = null;
      sharedPortPromise = null;
      const detail = error instanceof Error ? error.message : 'unknown';
      throw new Error(`ai_credit_ledger_unavailable:${detail}`);
    }
  })();

  return sharedPortPromise;
}

const dbCommercialSettingReader: CommercialSettingIntReader = async (
  key,
  min,
  max
) => {
  const client = await createServiceRoleClient();
  const { data, error } = await client.rpc('get_commercial_setting_int', {
    p_key: key,
    p_min: min,
    p_max: max,
  });
  if (error) return null;
  return typeof data === 'number' ? data : null;
};

async function resolveTrialGrantAmount(): Promise<number> {
  // Memory/unit-test path: allow injected reader via commercial-settings;
  // do not hit Supabase. Production uses DB RPC.
  if (forceInMemoryLedger()) {
    const resolved = await resolveTrialAiCredits({ env: edgeEnv() });
    return resolved.amount;
  }
  const resolved = await resolveTrialAiCredits({
    env: edgeEnv(),
    readDbInt: dbCommercialSettingReader,
  });
  return resolved.amount;
}

export async function createAiCreditGuard(): Promise<AiCreditGuard> {
  const port = await resolveLedgerPort();
  return new AiCreditGuard(port);
}

export async function ensureTrialCreditGrant(
  installationId: string,
  licenseId: string | null = null
): Promise<number> {
  const ledger = await resolveLedgerPort();
  const amount = await resolveTrialGrantAmount();
  try {
    await ledger.grant({
      installationId,
      licenseId,
      amount,
      source: 'trial',
      referenceId: `trial:${installationId}`,
      operationId: `trial-grant:${installationId}`,
      transactionType: 'trial_grant',
    });
  } catch {
    /* idempotent / race */
  }
  return ledger.getBalance(installationId);
}

export async function ensurePremiumMonthlyCreditGrant(
  installationId: string,
  licenseId: string | null
): Promise<number> {
  const ledger = await resolveLedgerPort();
  if (!licenseId) {
    return ledger.getBalance(installationId);
  }

  const config = readTrialCommercialConfig(edgeEnv());
  const amount = resolvePremiumMonthlyGrantAmount(config);
  if (amount === null || amount <= 0) {
    return ledger.getBalance(installationId);
  }

  const periodKey = premiumMonthlyPeriodKey();
  const referenceId = premiumMonthlyGrantReferenceId(licenseId, periodKey);

  try {
    await ledger.grant({
      installationId,
      licenseId,
      amount,
      source: 'manual_b2b',
      referenceId,
      operationId: premiumMonthlyGrantOperationId(licenseId, periodKey),
      transactionType: 'grant',
    });
  } catch {
    /* idempotent per license + month */
  }
  return ledger.getBalance(installationId);
}

/** @deprecated Use ensurePremiumMonthlyCreditGrant */
export async function ensurePremiumCreditGrant(
  installationId: string,
  licenseId: string | null
): Promise<number> {
  return ensurePremiumMonthlyCreditGrant(installationId, licenseId);
}

export async function readCreditBalance(installationId: string): Promise<number> {
  const ledger = await resolveLedgerPort();
  return ledger.getBalance(installationId);
}

/** Test helper: reset process-local port cache. */
export function resetAiCreditLedgerPortForTests(): void {
  sharedPort = null;
  sharedPortPromise = null;
  resetSharedAiCreditLedger();
}

export {
  COMMERCIAL_SETTING_KEYS,
  TRIAL_AI_CREDITS_MIN,
  TRIAL_AI_CREDITS_MAX,
};

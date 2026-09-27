import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createStructureCardHandler } from '../_shared/document-edge-handlers.ts';
import { withEdgeDatabaseDeadline } from '../_shared/edge-database-deadline.ts';
import { createAdminClient } from '../_shared/license-utils.ts';
import { resolveGeminiModelConfiguration } from '../_shared/gemini-model-config.ts';
import { edgeLogger } from '../_shared/safe-logging.ts';
import { createSupabaseEdgeTrafficControl } from '../_shared/supabase-edge-traffic.ts';
import {
  createAiCreditGuard,
  ensureTrialCreditGrant,
} from '../_shared/ai-credit-bootstrap.ts';
import { assertCommercialAccessForAi } from '../_shared/commercial-access.ts';

const getEnv = (name: string): string | undefined => Deno.env.get(name);
const traffic = createSupabaseEdgeTrafficControl(getEnv);

/**
 * Quota tecnica globale già esistente. Il controllo ora fallisce chiuso:
 * un errore del contatore non deve trasformarsi in una chiamata AI illimitata.
 */
async function isWithinDailyQuota(): Promise<boolean> {
  const configured = Number(Deno.env.get('AI_CARD_DAILY_LIMIT') ?? '150');
  const maxDaily =
    Number.isSafeInteger(configured) && configured >= 1 && configured <= 10_000
      ? configured
      : 150;

  try {
    return await withEdgeDatabaseDeadline(async (signal) => {
      const supabase = await createAdminClient();
      const { data: allowed, error } = await supabase
        .rpc('increment_ai_usage', { max_calls: maxDaily })
        .abortSignal(signal);
      if (error) {
        edgeLogger.warn('AI_USAGE_UPDATE_FAILED', {
          status: 'failed',
          stage: 'database',
        });
        return false;
      }
      return allowed === true;
    });
  } catch {
    edgeLogger.warn('AI_USAGE_CHECK_FAILED', {
      status: 'failed',
      stage: 'database',
    });
    return false;
  }
}

const handlerPromise = createAiCreditGuard().then((creditGuard) =>
  createStructureCardHandler({
    allowedOrigins: () => Deno.env.get('EDGE_ALLOWED_ORIGINS'),
    getApiKey: () => Deno.env.get('GEMINI_API_KEY'),
    getModelConfiguration: () =>
      resolveGeminiModelConfiguration(Deno.env.get('GEMINI_MODEL')),
    isWithinDailyQuota,
    traffic,
    creditGuard,
    ensureCreditGrant: async (installationId, licenseId) => {
      await ensureTrialCreditGrant(installationId, licenseId);
    },
    assertCommercialAccess: assertCommercialAccessForAi,
  })
);

serve(async (request) => {
  const handler = await handlerPromise;
  return handler(request);
});

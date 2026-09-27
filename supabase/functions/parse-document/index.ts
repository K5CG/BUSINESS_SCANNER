import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createParseDocumentHandler } from '../_shared/document-edge-handlers.ts';
import { resolveGeminiModelConfiguration } from '../_shared/gemini-model-config.ts';
import { createSupabaseEdgeTrafficControl } from '../_shared/supabase-edge-traffic.ts';
import {
  createAiCreditGuard,
  ensureTrialCreditGrant,
} from '../_shared/ai-credit-bootstrap.ts';
import { assertCommercialAccessForAi } from '../_shared/commercial-access.ts';

const getEnv = (name: string): string | undefined => Deno.env.get(name);
const traffic = createSupabaseEdgeTrafficControl(getEnv);

const handlerPromise = createAiCreditGuard().then((creditGuard) =>
  createParseDocumentHandler({
    allowedOrigins: () => Deno.env.get('EDGE_ALLOWED_ORIGINS'),
    getApiKey: () => Deno.env.get('GEMINI_API_KEY'),
    getModelConfiguration: () =>
      resolveGeminiModelConfiguration(Deno.env.get('GEMINI_MODEL')),
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

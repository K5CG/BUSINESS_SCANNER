import {
  createDatabaseEdgeTrafficControl,
  edgeTrafficConfigFromEnv,
  type EdgeEnvGetter,
} from './edge-request-guard.ts';
import { withEdgeDatabaseDeadline } from './edge-database-deadline.ts';
import { createAdminClient } from './license-utils.ts';
import { edgeLogger } from './safe-logging.ts';

/**
 * Adapter di produzione per il gate anti-abuso globale. Conserva in memoria
 * soltanto il client Supabase; rate window e lease restano atomici su
 * PostgreSQL e non dipendono dal ciclo di vita del singolo isolate.
 */
export function createSupabaseEdgeTrafficControl(getEnv: EdgeEnvGetter) {
  let adminClient:
    | Awaited<ReturnType<typeof createAdminClient>>
    | undefined;

  const getAdminClient = async () => {
    adminClient ??= await createAdminClient();
    return adminClient;
  };

  return createDatabaseEdgeTrafficControl(
    edgeTrafficConfigFromEnv(getEnv),
    {
      fingerprintSalt: getEnv('EDGE_RATE_LIMIT_SALT'),
      scope: 'gemini',
      acquire: async (params) => {
        return withEdgeDatabaseDeadline(async (signal) => {
          const supabase = await getAdminClient();
          const { data, error } = await supabase
            .rpc('acquire_edge_ai_request', {
              p_scope: params.scope,
              p_fingerprint: params.fingerprint,
              p_rate_limit: params.rateLimit,
              p_window_seconds: params.windowSeconds,
              p_max_concurrent: params.maxConcurrent,
              p_lease_seconds: params.leaseSeconds,
            })
            .abortSignal(signal);
          if (error) throw new Error('EDGE_TRAFFIC_ACQUIRE_FAILED');
          return data;
        });
      },
      release: async (leaseId) => {
        await withEdgeDatabaseDeadline(async (signal) => {
          const supabase = await getAdminClient();
          const { error } = await supabase
            .rpc('release_edge_ai_request', {
              p_lease_id: leaseId,
            })
            .abortSignal(signal);
          if (error) throw new Error('EDGE_TRAFFIC_RELEASE_FAILED');
        });
      },
      onError: (stage) => {
        edgeLogger.warn(
          stage === 'acquire'
            ? 'EDGE_TRAFFIC_ACQUIRE_FAILED'
            : 'EDGE_TRAFFIC_RELEASE_FAILED',
          {
            status: 'unavailable',
            stage: 'database',
          }
        );
      },
    }
  );
}

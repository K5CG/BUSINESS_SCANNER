import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getInstallationId } from '../lib/installation-id';
import {
  hasValidPrivacyConsent,
  markPrivacyConsentBackendFailed,
  savePrivacyConsent,
} from '../lib/privacy-consent';
import { resolveHydratedAccepted } from '../lib/privacy-consent-hydration';
import { logPrivacyConsent } from '../lib/privacy-consent-log';
import { syncPendingPrivacyConsentIfNeeded } from '../lib/privacy-consent-remote';
import { resolvePrivacySettings } from '../lib/privacy-settings';
import { runtimeLogger } from '../lib/safe-runtime-logger';

interface PrivacyConsentContextValue {
  loading: boolean;
  accepted: boolean;
  privacyPolicyUrl: string | null;
  accept: () => Promise<void>;
}

const PrivacyConsentContext = createContext<PrivacyConsentContextValue | null>(null);

export function PrivacyConsentProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [accepted, setAccepted] = useState(false);
  const [privacyPolicyUrl, setPrivacyPolicyUrl] = useState<string | null>(null);
  const acceptInFlightRef = useRef(false);
  const policyVersionRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (acceptInFlightRef.current) {
      logPrivacyConsent('hydration_skip', { reason: 'accept_in_flight' });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const settings = await resolvePrivacySettings();
      policyVersionRef.current = settings.privacyPolicyVersion;
      setPrivacyPolicyUrl(settings.privacyPolicyUrl);

      const storedAccepted = await hasValidPrivacyConsent(settings.privacyPolicyVersion);
      setAccepted((current) => {
        const next = resolveHydratedAccepted(current, acceptInFlightRef.current, storedAccepted);
        logPrivacyConsent('hydration_apply', {
          storedAccepted,
          currentAccepted: current,
          nextAccepted: next,
          policyVersion: settings.privacyPolicyVersion,
        });
        return next;
      });

      if (storedAccepted) {
        void syncPendingPrivacyConsentIfNeeded().catch(() => undefined);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch((error) => {
      runtimeLogger.error('PRIVACY_CONSENT_LOAD_FAILED', error, {
        source: 'filesystem',
        stage: 'read',
        status: 'failed',
      });
      logPrivacyConsent('storage_write_failed', {
        stage: 'hydration_read',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [refresh]);

  const accept = useCallback(async () => {
    logPrivacyConsent('accept_start');
    logPrivacyConsent('provider_state_before', {
      loading,
      accepted,
      acceptInFlight: acceptInFlightRef.current,
    });

    acceptInFlightRef.current = true;
    logPrivacyConsent('provider_state_after', {
      loading,
      accepted,
      acceptInFlight: true,
    });

    try {
      const settings = await resolvePrivacySettings();
      policyVersionRef.current = settings.privacyPolicyVersion;
      setPrivacyPolicyUrl(settings.privacyPolicyUrl);

      const installationId = await getInstallationId();
      await savePrivacyConsent({
        installationId,
        policyVersion: settings.privacyPolicyVersion,
        backendSyncStatus: 'pending',
      });
      setAccepted(true);
      logPrivacyConsent('navigation_release_gate');
      logPrivacyConsent('provider_state_after', {
        loading,
        accepted: true,
        acceptInFlight: true,
        persisted: true,
      });

      void syncPendingPrivacyConsentIfNeeded()
        .then(async (sync) => {
          if (sync && !sync.ok) {
            await markPrivacyConsentBackendFailed().catch(() => undefined);
          }
        })
        .catch(() => undefined);
    } catch (error) {
      setAccepted(false);
      runtimeLogger.error('PRIVACY_CONSENT_SAVE_FAILED', error, {
        source: 'filesystem',
        stage: 'write',
        status: 'failed',
      });
      logPrivacyConsent('storage_write_failed', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    } finally {
      acceptInFlightRef.current = false;
    }
  }, [loading, accepted]);

  const value = useMemo(
    () => ({ loading, accepted, privacyPolicyUrl, accept }),
    [loading, accepted, privacyPolicyUrl, accept]
  );

  return (
    <PrivacyConsentContext.Provider value={value}>{children}</PrivacyConsentContext.Provider>
  );
}

export function usePrivacyConsent(): PrivacyConsentContextValue {
  const ctx = useContext(PrivacyConsentContext);
  if (!ctx) {
    throw new Error('usePrivacyConsent must be used within PrivacyConsentProvider');
  }
  return ctx;
}

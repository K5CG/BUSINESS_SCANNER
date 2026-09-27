import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  activateLicense as activateLicenseRequest,
  getLicenseStatus,
  type LicenseStatus,
} from '../lib/license-service';
import { emptyEntitlement } from '../lib/entitlement-state-machine';
import { isEntitlementAccessGranted } from '../lib/entitlement';
import { runtimeLogger } from '../lib/safe-runtime-logger';
import { setTrialScanAccountingEnabled } from '../lib/trial-scan-runtime';
import { logLicense } from '../lib/license-log';
import {
  applyAiCreditsRemainingToStatus,
  logAiCreditsUiSync,
  type AiCreditsUiSyncSource,
} from '../lib/ai-credits-ui-sync';

type UnresolvedLicenseStatus = Omit<
  LicenseStatus,
  'access' | 'entitlement'
> & {
  access: 'loading' | 'offline_blocked' | 'network_unknown' | 'expired';
  entitlement: ReturnType<typeof emptyEntitlement>;
};

type LicenseContextStatus = LicenseStatus | UnresolvedLicenseStatus;

interface LicenseContextValue {
  status: LicenseContextStatus;
  loading: boolean;
  showActivationForm: boolean;
  expiredNoticeDismissed: boolean;
  dismissExpiredNotice: () => void;
  refresh: () => Promise<void>;
  openActivation: () => void;
  closeActivation: () => void;
  activate: (email: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  /** Authoritative Edge balance only — does not invent credits locally. */
  updateAiCreditsRemaining: (
    value: unknown,
    source?: AiCreditsUiSyncSource
  ) => void;
}

const loadingStatus: LicenseContextStatus = {
  access: 'loading',
  entitlement: emptyEntitlement('', 'LOADING'),
  kind: null,
  expiresAt: null,
  daysRemaining: 0,
  trialEndsAt: null,
  keyHint: null,
  customerEmail: null,
  aiCreditsTotal: null,
  aiCreditsUsed: null,
  aiCreditsRemaining: null,
  trialScanCount: null,
  trialMaxScans: null,
  trialScansRemaining: null,
  trialDeviceStatus: null,
};

const LicenseContext = createContext<LicenseContextValue | null>(null);

function isLikelyNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /network|fetch|timeout|abort|failed to fetch|enetunreach|econnrefused|dns/i.test(message);
}

function unresolvedLicenseStatus(
  access: UnresolvedLicenseStatus['access'],
  entitlementStatus: ReturnType<typeof emptyEntitlement>['status'] = 'NETWORK_UNKNOWN'
): UnresolvedLicenseStatus {
  return {
    access,
    entitlement: emptyEntitlement('', entitlementStatus),
    kind: null,
    expiresAt: null,
    daysRemaining: 0,
    trialEndsAt: null,
    keyHint: null,
    customerEmail: null,
    aiCreditsTotal: null,
    aiCreditsUsed: null,
    aiCreditsRemaining: null,
    trialScanCount: null,
    trialMaxScans: null,
    trialScansRemaining: null,
    trialDeviceStatus: null,
  };
}

export function LicenseProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<LicenseContextStatus>(loadingStatus);
  const [loading, setLoading] = useState(true);
  const [showActivationForm, setShowActivationForm] = useState(false);
  const [expiredNoticeDismissed, setExpiredNoticeDismissed] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    logLicense('gate_start');
    try {
      const next = await getLicenseStatus();
      setStatus(next);
      setTrialScanAccountingEnabled(
        next.kind === 'trial' &&
          (next.access === 'active' || next.access === 'offline_grace')
      );
      logLicense('ui_state', { access: next.access, kind: next.kind });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      logLicense('exception_name', { name });
      logLicense('exception_message', { message });
      runtimeLogger.error('LICENSE_CHECK_FAILED', error, {
        stage: isLikelyNetworkError(error) ? 'network' : 'bootstrap',
        status: 'failed',
      });
      const access = isLikelyNetworkError(error) ? 'network_unknown' : 'expired';
      setStatus(unresolvedLicenseStatus(access, isLikelyNetworkError(error) ? 'NETWORK_UNKNOWN' : 'INVALID'));
      logLicense('ui_state', { access, reason: 'refresh_exception' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch((error) => {
      runtimeLogger.error('LICENSE_REFRESH_FAILED', error, {
        stage: 'network',
        status: 'failed',
      });
    });
  }, [refresh]);

  const openActivation = useCallback(() => setShowActivationForm(true), []);
  const closeActivation = useCallback(() => setShowActivationForm(false), []);
  const dismissExpiredNotice = useCallback(() => setExpiredNoticeDismissed(true), []);

  const activate = useCallback(async (email: string, key: string) => {
    const result = await activateLicenseRequest(email, key);
    if (result.ok && result.status) {
      setStatus(result.status);
      setShowActivationForm(false);
      setExpiredNoticeDismissed(true);
      setTrialScanAccountingEnabled(false);
      return { ok: true };
    }
    return { ok: false, error: result.error ?? 'invalid_key' };
  }, []);

  const updateAiCreditsRemaining = useCallback(
    (value: unknown, source: AiCreditsUiSyncSource = 'unknown') => {
      setStatus((previous) => {
        const next = applyAiCreditsRemainingToStatus<LicenseContextStatus>(previous, value);
        if (!next || next === previous) return previous;
        // `applyAiCreditsRemainingToStatus` only returns a non-null value when the server provides
        // an authoritative remaining balance, therefore the field must be a real number.
        if (next.aiCreditsRemaining === null) return previous;
        logAiCreditsUiSync({
          source,
          previous: previous.aiCreditsRemaining,
          next: next.aiCreditsRemaining,
        });
        return next;
      });
    },
    []
  );

  const value = useMemo(
    () => ({
      status,
      loading,
      showActivationForm,
      expiredNoticeDismissed,
      dismissExpiredNotice,
      refresh,
      openActivation,
      closeActivation,
      activate,
      updateAiCreditsRemaining,
    }),
    [
      status,
      loading,
      showActivationForm,
      expiredNoticeDismissed,
      dismissExpiredNotice,
      refresh,
      openActivation,
      closeActivation,
      activate,
      updateAiCreditsRemaining,
    ]
  );

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>;
}

export function useLicense(): LicenseContextValue {
  const ctx = useContext(LicenseContext);
  if (!ctx) {
    throw new Error('useLicense must be used within LicenseProvider');
  }
  return ctx;
}

export function isLicenseGateOpen(status: LicenseContextStatus): boolean {
  if (status.access === 'loading') return false;
  if (status.access === 'expired') {
    return status.entitlement.status === 'EXPIRED';
  }
  if (status.access === 'active' || status.access === 'offline_grace') {
    return isEntitlementAccessGranted(status.entitlement);
  }
  return false;
}

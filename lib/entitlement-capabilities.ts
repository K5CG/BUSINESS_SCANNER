import type { Entitlement } from './entitlement';
import {
  isEntitlementAccessGranted,
  isEntitlementCloudAiAllowed,
} from './entitlement';
import { isRcPdfImportEnabled } from './release-rc-policy';

/**
 * Central capability policy for trial/license states.
 * Prefer these helpers over scattered `if (expired)` checks.
 */
export interface EntitlementCapabilities {
  canEnterApp: boolean;
  canReadExistingData: boolean;
  canExportExistingData: boolean;
  canEditExistingData: boolean;
  canCreateNewScan: boolean;
  canImportPdf: boolean;
  canUseAi: boolean;
}

export function isEntitlementExpiredReadOnly(entitlement: Entitlement): boolean {
  return entitlement.status === 'EXPIRED';
}

export function isEntitlementAppEntryAllowed(entitlement: Entitlement): boolean {
  if (isEntitlementAccessGranted(entitlement)) return true;
  return entitlement.status === 'EXPIRED';
}

export function getEntitlementCapabilities(
  entitlement: Entitlement,
  aiCreditsRemaining: number | null = null
): EntitlementCapabilities {
  if (entitlement.status === 'EXPIRED') {
    return {
      canEnterApp: true,
      canReadExistingData: true,
      canExportExistingData: true,
      canEditExistingData: true,
      canCreateNewScan: false,
      canImportPdf: false,
      canUseAi: false,
    };
  }

  const full = isEntitlementAccessGranted(entitlement);
  return {
    canEnterApp: full,
    canReadExistingData: full,
    canExportExistingData: full && entitlement.features.export,
    canEditExistingData: full,
    canCreateNewScan: full && entitlement.features.scan,
    canImportPdf: full && isRcPdfImportEnabled(),
    canUseAi: isEntitlementCloudAiAllowed(entitlement, aiCreditsRemaining),
  };
}

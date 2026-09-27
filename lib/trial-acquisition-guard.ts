/**
 * Shared UI helper for blocking new acquisition when trial is expired.
 */
import { Alert } from 'react-native';
import type { TFunction } from 'i18next';
import type { EntitlementCapabilities } from './entitlement-capabilities';

export function alertTrialExpiredNewAcquisition(
  t: TFunction,
  kind: 'card' | 'document' | 'pdf',
  openActivation: () => void
): void {
  const messageKey =
    kind === 'card'
      ? 'licenseExpiredNewScanBlocked'
      : kind === 'pdf'
        ? 'licenseExpiredPdfBlocked'
        : 'licenseExpiredNewDocumentBlocked';
  Alert.alert(t('licenseExpiredTitle'), t(messageKey), [
    { text: t('cancel', { defaultValue: 'Cancel' }), style: 'cancel' },
    { text: t('licenseActivate'), onPress: openActivation },
  ]);
}

export function guardNewAcquisition(
  caps: EntitlementCapabilities,
  kind: 'card' | 'document' | 'pdf',
  t: TFunction,
  openActivation: () => void
): boolean {
  if (kind === 'pdf') {
    if (caps.canImportPdf) return true;
    alertTrialExpiredNewAcquisition(t, 'pdf', openActivation);
    return false;
  }
  if (caps.canCreateNewScan) return true;
  alertTrialExpiredNewAcquisition(t, kind, openActivation);
  return false;
}

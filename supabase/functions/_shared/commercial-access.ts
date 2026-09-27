/**
 * Shared commercial-access check for AI Edge handlers.
 */
import { assertInstallationCommerciallyActive } from './license-utils.ts';

export async function assertCommercialAccessForAi(
  installationId: string,
  _licenseId: string | null
): Promise<boolean> {
  return assertInstallationCommerciallyActive(installationId);
}

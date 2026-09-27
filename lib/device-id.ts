/**
 * @deprecated Use getInstallationId from ./installation-id instead.
 * Kept as alias so existing imports keep working during Phase 3B.
 */
import { getInstallationId } from './installation-id';

export async function getDeviceId(): Promise<string> {
  return getInstallationId();
}

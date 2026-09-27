import { getInstallationId } from './installation-id';
import {
  recordTrialScanLocally,
  type TrialScanCountableEvent,
} from './trial-scan-service';
import { shouldSkipTrialScanAccounting } from './trial-scan-runtime';

export async function notifyTrialScanCompleted(params: {
  operationId: string;
  event: TrialScanCountableEvent;
}): Promise<void> {
  const installationId = await getInstallationId();
  recordTrialScanLocally({
    installationId,
    operationId: params.operationId,
    skipTrialAccounting: shouldSkipTrialScanAccounting(),
    event: params.event,
  });
}

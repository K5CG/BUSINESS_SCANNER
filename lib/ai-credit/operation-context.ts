import { getInstallationId } from '../installation-id.ts';
import type { AiOperationType } from './types.ts';
// La generazione dell'identificativo vive in un modulo senza dipendenze dal
// runtime nativo, così è verificabile fuori dal dispositivo.
import { createAiOperationContext, type ClientAiOperationContext } from './operation-id.ts';

export { createAiOperationContext, createAiOperationId } from './operation-id.ts';
export type { ClientAiOperationContext } from './operation-id.ts';

const pendingOperations = new Map<string, ClientAiOperationContext>();

export async function buildAiRequestContext(
  operationType: AiOperationType,
  existingOperationId?: string
): Promise<ClientAiOperationContext> {
  const installationId = await getInstallationId();
  const base = createAiOperationContext(operationType, existingOperationId);
  const ctx = { ...base, installationId };
  pendingOperations.set(ctx.operationId, ctx);
  return ctx;
}

export function peekPendingOperation(operationId: string): ClientAiOperationContext | null {
  return pendingOperations.get(operationId) ?? null;
}

export function clearPendingOperation(operationId: string): void {
  pendingOperations.delete(operationId);
}

export function aiContextPayload(ctx: ClientAiOperationContext): Record<string, string> {
  return {
    installationId: ctx.installationId,
    operationId: ctx.operationId,
    operationType: ctx.operationType,
  };
}

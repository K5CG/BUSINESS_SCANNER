import { v4 as uuidv4 } from 'uuid';
import type { AiOperationType } from './types.ts';
import { AI_OPERATION_ID_RE } from './types.ts';

export interface ClientAiOperationContext {
  installationId: string;
  operationId: string;
  operationType: AiOperationType;
}

/**
 * Hermes non espone `crypto.getRandomValues`, quindi `uuid` da solo solleva
 * un'eccezione: ogni operazione AI, importazione PDF compresa, moriva qui prima
 * di raggiungere il servizio. Se una fonte crittografica è presente la usiamo,
 * altrimenti restiamo su `Math.random`: questo identificativo collega
 * l'operazione al suo addebito, non è un segreto e non autorizza nulla da solo.
 *
 * Stessa scelta di `createReactNativeSafeInstallationId`, che qui non possiamo
 * riusare perché il backend valida l'operationId come UUID.
 */
function randomOperationBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const source = (
    globalThis as {
      crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (typeof source?.getRandomValues === 'function') {
    source.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function createAiOperationId(): string {
  return uuidv4({ random: randomOperationBytes(16) });
}

/** One operationId per logical user action — reuse on retry. */
export function createAiOperationContext(
  operationType: AiOperationType,
  existingOperationId?: string
): ClientAiOperationContext {
  const operationId =
    existingOperationId && AI_OPERATION_ID_RE.test(existingOperationId)
      ? existingOperationId
      : createAiOperationId();
  return {
    installationId: '',
    operationId,
    operationType,
  };
}

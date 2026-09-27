import type { OperationLease } from './guarded-operation';

export type ScanOperationCheckpoint =
  | 'before_persistence'
  | 'after_async_step'
  | 'async_step_failed_after_invalidation'
  | 'persistence_failed_after_invalidation'
  | 'after_persistence'
  | 'compensation_failed';

export interface ActiveOperationGuard {
  readonly operationId: string;
  isActive(): boolean;
}

export class InactiveScanOperationError extends Error {
  readonly checkpoint: ScanOperationCheckpoint;
  readonly operationId: string;
  readonly compensationAttempted: boolean;
  readonly compensationError?: unknown;
  readonly originalError?: unknown;

  constructor(options: {
    checkpoint: ScanOperationCheckpoint;
    operationId: string;
    compensationAttempted?: boolean;
    compensationError?: unknown;
    originalError?: unknown;
  }) {
    super(`SCAN_OPERATION_INACTIVE:${options.checkpoint}`);
    this.name = 'InactiveScanOperationError';
    this.checkpoint = options.checkpoint;
    this.operationId = options.operationId;
    this.compensationAttempted = options.compensationAttempted === true;
    this.compensationError = options.compensationError;
    this.originalError = options.originalError;
  }
}

export function isInactiveScanOperationError(
  error: unknown
): error is InactiveScanOperationError {
  return error instanceof InactiveScanOperationError;
}

export interface GuardedCreatedRecordOptions<T> extends ActiveOperationGuard {
  compensationTarget: T;
  persist(): Promise<T>;
  compensate(value: T): Promise<unknown>;
  publish(value: T): void;
}

async function compensateInactiveCreation<T>(
  options: GuardedCreatedRecordOptions<T>,
  value: T,
  originalError?: unknown
): Promise<never> {
  try {
    await options.compensate(value);
  } catch (compensationError) {
    throw new InactiveScanOperationError({
      checkpoint: 'compensation_failed',
      operationId: options.operationId,
      compensationAttempted: true,
      compensationError,
      originalError,
    });
  }
  throw new InactiveScanOperationError({
    checkpoint: originalError
      ? 'persistence_failed_after_invalidation'
      : 'after_persistence',
    operationId: options.operationId,
    compensationAttempted: true,
    originalError,
  });
}

/**
 * Mantiene la persistenza atomica sottostante non interrompibile, ma separa
 * il commit tecnico dalla pubblicazione applicativa. Se l'operazione viene
 * invalidata mentre il commit è in corso, il risultato viene compensato e
 * non raggiunge lo store.
 */
export async function commitCreatedRecordIfActive<T>(
  options: GuardedCreatedRecordOptions<T>
): Promise<T> {
  if (!options.isActive()) {
    throw new InactiveScanOperationError({
      checkpoint: 'before_persistence',
      operationId: options.operationId,
    });
  }

  let persisted: T;
  try {
    persisted = await options.persist();
  } catch (error) {
    if (!options.isActive()) {
      // La saga Fase 1 può rigettare anche quando la rilettura del commit è
      // ambigua. Il target revisionato consente una compensazione idempotente
      // senza rischiare di cancellare un retry più recente con lo stesso ID.
      return compensateInactiveCreation(
        options,
        options.compensationTarget,
        error
      );
    }
    throw error;
  }

  // Lascia processare un eventuale Back/blur arrivato mentre la saga nativa
  // terminava, prima di pubblicare nello store.
  await yieldToOperationEventLoop();
  if (!options.isActive()) {
    return compensateInactiveCreation(options, persisted);
  }

  // Nessun await tra il controllo e la pubblicazione: l'effetto è atomico
  // rispetto agli eventi JavaScript che possono invalidare la lease.
  options.publish(persisted);
  return persisted;
}

/**
 * Protegge gli await preparatori (lettura duplicati, validazioni, prompt):
 * un risultato o errore completato dopo l'invalidazione viene convertito in
 * un esito inattivo, così il chiamante non pubblica feedback o store.error.
 */
export async function runActiveOperationStep<T>(
  operation: ActiveOperationGuard | undefined,
  step: () => Promise<T>
): Promise<T> {
  if (operation && !operation.isActive()) {
    throw new InactiveScanOperationError({
      checkpoint: 'before_persistence',
      operationId: operation.operationId,
    });
  }

  let result: T;
  try {
    result = await step();
  } catch (error) {
    if (operation && !operation.isActive()) {
      throw new InactiveScanOperationError({
        checkpoint: 'async_step_failed_after_invalidation',
        operationId: operation.operationId,
        originalError: error,
      });
    }
    throw error;
  }

  if (operation && !operation.isActive()) {
    throw new InactiveScanOperationError({
      checkpoint: 'after_async_step',
      operationId: operation.operationId,
    });
  }
  return result;
}

export interface GuardedExistingRecordOptions<T> extends ActiveOperationGuard {
  persist(): Promise<T>;
  publish(value: T): void;
}

/**
 * Per un aggiornamento esplicitamente richiesto non tenta di ricostruire una
 * revisione asset già sostituita. Se l'utente esce durante il commit, il DB
 * può terminare ma store, feedback e navigazione restano inattivi.
 */
export async function commitExistingRecordIfActive<T>(
  options: GuardedExistingRecordOptions<T>
): Promise<T> {
  if (!options.isActive()) {
    throw new InactiveScanOperationError({
      checkpoint: 'before_persistence',
      operationId: options.operationId,
    });
  }

  let persisted: T;
  try {
    persisted = await options.persist();
  } catch (error) {
    if (!options.isActive()) {
      throw new InactiveScanOperationError({
        checkpoint: 'persistence_failed_after_invalidation',
        operationId: options.operationId,
        originalError: error,
      });
    }
    throw error;
  }

  await yieldToOperationEventLoop();
  if (!options.isActive()) {
    throw new InactiveScanOperationError({
      checkpoint: 'after_persistence',
      operationId: options.operationId,
    });
  }

  options.publish(persisted);
  return persisted;
}

/**
 * Finalizza una lease e applica l'ultimo gruppo sincrono di effetti una sola
 * volta. È usato per store-draft, feedback e navigazione senza finestre tra
 * controllo e applicazione.
 */
export function runFinalOperationEffect(
  operation: OperationLease,
  effect: () => void
): boolean {
  if (!operation.tryFinalize()) return false;
  effect();
  return true;
}

export function yieldToOperationEventLoop(
  schedule: (callback: () => void) => unknown = (callback) =>
    setTimeout(callback, 0)
): Promise<void> {
  return new Promise<void>((resolve) => {
    schedule(resolve);
  });
}

export interface RevisionOwnedRecord {
  id: string;
  persistenceRevision?: string;
}

export function withPersistenceRevision<T extends RevisionOwnedRecord>(
  record: T,
  operationId: string
): T {
  const revision = operationId.trim();
  if (!revision) throw new Error('PERSISTENCE_REVISION_REQUIRED');
  return {
    ...record,
    persistenceRevision: revision,
  };
}

export function hasSamePersistenceRevision(
  current: RevisionOwnedRecord,
  expected: RevisionOwnedRecord
): boolean {
  return (
    current.id === expected.id &&
    typeof current.persistenceRevision === 'string' &&
    current.persistenceRevision.length > 0 &&
    current.persistenceRevision === expected.persistenceRevision
  );
}

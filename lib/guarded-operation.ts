export type OperationInvalidationReason =
  | 'replaced'
  | 'timeout'
  | 'orientation_changed'
  | 'mode_changed'
  | 'screen_blurred'
  | 'unmounted'
  | 'finished'
  | 'manual';

export interface OperationLease {
  readonly operationId: string;
  readonly invalidated: Promise<OperationInvalidationReason>;
  isActive(): boolean;
  isCurrent(): boolean;
  tryFinalize(): boolean;
  runIfActive(effect: () => void): boolean;
}

interface OperationState {
  active: boolean;
  finalized: boolean;
  reason: OperationInvalidationReason | null;
  resolveInvalidated: (reason: OperationInvalidationReason) => void;
  lease: OperationLease;
}

export interface LatestOperationController {
  begin(): OperationLease;
  invalidateCurrent(reason?: OperationInvalidationReason): void;
  invalidate(
    lease: OperationLease,
    reason?: OperationInvalidationReason
  ): void;
  finish(lease: OperationLease): void;
  isCurrent(lease: OperationLease): boolean;
  dispose(): void;
}

let operationSequence = 0;

export function createGuardedOperationId(prefix: string = 'ocr'): string {
  operationSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function defaultOperationId(): string {
  return createGuardedOperationId();
}

export function createLatestOperationController(
  idFactory: () => string = defaultOperationId
): LatestOperationController {
  let current: OperationState | null = null;
  let disposed = false;
  let localSequence = 0;

  const invalidateState = (
    state: OperationState,
    reason: OperationInvalidationReason
  ) => {
    if (!state.active) return;
    state.active = false;
    state.reason = reason;
    state.resolveInvalidated(reason);
  };

  const controller: LatestOperationController = {
    begin(): OperationLease {
      if (disposed) throw new Error('OPERATION_CONTROLLER_DISPOSED');
      if (current) invalidateState(current, 'replaced');

      localSequence += 1;
      const baseId = idFactory().trim() || 'ocr';
      const operationId = `${baseId}-${localSequence.toString(36)}`;
      let resolveInvalidated!: (reason: OperationInvalidationReason) => void;
      const invalidated = new Promise<OperationInvalidationReason>((resolve) => {
        resolveInvalidated = resolve;
      });
      const state = {} as OperationState;
      const lease: OperationLease = {
        operationId,
        invalidated,
        isActive: () =>
          current === state && state.active && !state.finalized && !disposed,
        isCurrent: () => current === state && state.active && !disposed,
        tryFinalize: () => {
          if (
            current !== state ||
            !state.active ||
            state.finalized ||
            disposed
          ) {
            return false;
          }
          state.finalized = true;
          return true;
        },
        runIfActive: (effect) => {
          if (!lease.isActive()) return false;
          effect();
          return true;
        },
      };
      Object.assign(state, {
        active: true,
        finalized: false,
        reason: null,
        resolveInvalidated,
        lease,
      });
      current = state;
      return lease;
    },

    invalidateCurrent(reason = 'manual'): void {
      if (!current) return;
      invalidateState(current, reason);
      current = null;
    },

    invalidate(lease, reason = 'manual'): void {
      if (!current || current.lease !== lease) return;
      invalidateState(current, reason);
      current = null;
    },

    finish(lease): void {
      if (!current || current.lease !== lease) return;
      invalidateState(current, 'finished');
      current = null;
    },

    isCurrent(lease): boolean {
      return Boolean(current?.lease === lease && current.active && !disposed);
    },

    dispose(): void {
      if (disposed) return;
      if (current) invalidateState(current, 'unmounted');
      current = null;
      disposed = true;
    },
  };

  return controller;
}

export interface TimedOperationContext {
  readonly operationId: string;
  isActive(): boolean;
}

export type TimedOperationOutcome<T> =
  | { status: 'completed'; operationId: string; value: T }
  | { status: 'timed_out'; operationId: string; value: T }
  | { status: 'stale'; operationId: string; value: T }
  | { status: 'failed'; operationId: string; value: T; error: unknown };

export interface TimerAdapter {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimerAdapter: TimerAdapter = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Il timeout invalida solo il risultato logico. La Promise nativa continua,
 * ma il suo valore/errore viene sempre consumato e non può più essere
 * finalizzato dal chiamante.
 */
export async function runTimedOperation<T>(options: {
  operationId: string;
  timeoutMs: number;
  fallback: T;
  isExternallyActive?: () => boolean;
  task: (context: TimedOperationContext) => Promise<T>;
  /**
   * Riceve soltanto valori prodotti quando il chiamante non può più
   * acquisirne l'ownership (timeout o invalidazione esterna).
   * L'handler è best-effort e non prolunga il tempo di risposta.
   */
  onDiscardedValue?: (value: T) => void | Promise<void>;
  timer?: TimerAdapter;
}): Promise<TimedOperationOutcome<T>> {
  const timer = options.timer ?? defaultTimerAdapter;
  let logicallyActive = true;
  let timedOut = false;
  const context: TimedOperationContext = {
    operationId: options.operationId,
    isActive: () =>
      logicallyActive && (options.isExternallyActive?.() ?? true),
  };

  const taskResult = Promise.resolve()
    .then(() => options.task(context))
    .then(
      (value) => ({ kind: 'value' as const, value }),
      (error) => ({ kind: 'error' as const, error })
    );

  let timeoutHandle: unknown;
  const timeoutResult = new Promise<{ kind: 'timeout' }>((resolve) => {
    timeoutHandle = timer.set(() => {
      timedOut = true;
      logicallyActive = false;
      resolve({ kind: 'timeout' });
    }, options.timeoutMs);
  });

  const settled = await Promise.race([taskResult, timeoutResult]);
  if (settled.kind !== 'timeout') {
    timer.clear(timeoutHandle);
  }

  if (settled.kind === 'timeout') {
    void taskResult.then((lateResult) => {
      if (lateResult.kind !== 'value' || !options.onDiscardedValue) return;
      void Promise.resolve()
        .then(() => options.onDiscardedValue?.(lateResult.value))
        .catch(() => undefined);
    });
    return {
      status: 'timed_out',
      operationId: options.operationId,
      value: options.fallback,
    };
  }

  if (!context.isActive() || timedOut) {
    logicallyActive = false;
    if (settled.kind === 'value' && options.onDiscardedValue) {
      void Promise.resolve()
        .then(() => options.onDiscardedValue?.(settled.value))
        .catch(() => undefined);
    }
    return {
      status: 'stale',
      operationId: options.operationId,
      value: options.fallback,
    };
  }

  logicallyActive = false;
  if (settled.kind === 'error') {
    return {
      status: 'failed',
      operationId: options.operationId,
      value: options.fallback,
      error: settled.error,
    };
  }
  return {
    status: 'completed',
    operationId: options.operationId,
    value: settled.value,
  };
}

export type AsyncConcurrencyOutcome<T> =
  | { status: 'completed'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'stale' }
  | { status: 'saturated' };

export interface AsyncConcurrencyGate {
  readonly maxConcurrency: number;
  readonly maxPending: number;
  activeCount(): number;
  pendingCount(): number;
  run<T>(options: {
    task: () => Promise<T>;
    isActive?: () => boolean;
  }): Promise<AsyncConcurrencyOutcome<T>>;
}

interface PendingConcurrencyTask {
  isActive: () => boolean;
  start: () => void;
  resolveStale: () => void;
}

/**
 * Limita sia il lavoro attivo sia la memoria della coda. I job diventati
 * stale non entrano mai nella sezione concorrente.
 */
export function createAsyncConcurrencyGate(
  maxConcurrency: number,
  maxPending: number = maxConcurrency * 2
): AsyncConcurrencyGate {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('INVALID_CONCURRENCY_LIMIT');
  }
  if (!Number.isSafeInteger(maxPending) || maxPending < 0) {
    throw new Error('INVALID_PENDING_LIMIT');
  }

  let active = 0;
  const pending: PendingConcurrencyTask[] = [];

  const drain = () => {
    while (active < maxConcurrency && pending.length > 0) {
      const next = pending.shift()!;
      if (!next.isActive()) {
        next.resolveStale();
        continue;
      }
      next.start();
    }
  };

  const gate: AsyncConcurrencyGate = {
    maxConcurrency,
    maxPending,
    activeCount: () => active,
    pendingCount: () => pending.length,

    run<T>(options: {
      task: () => Promise<T>;
      isActive?: () => boolean;
    }): Promise<AsyncConcurrencyOutcome<T>> {
      const isActive = options.isActive ?? (() => true);
      if (!isActive()) return Promise.resolve({ status: 'stale' });

      return new Promise<AsyncConcurrencyOutcome<T>>((resolve) => {
        const start = () => {
          if (!isActive()) {
            resolve({ status: 'stale' });
            drain();
            return;
          }

          active += 1;
          void Promise.resolve()
            .then(options.task)
            .then(
              (value) =>
                resolve(
                  isActive()
                    ? { status: 'completed', value }
                    : { status: 'stale' }
                ),
              (error) => resolve({ status: 'failed', error })
            )
            .finally(() => {
              active -= 1;
              drain();
            });
        };

        if (active < maxConcurrency) {
          start();
          return;
        }
        if (pending.length >= maxPending) {
          resolve({ status: 'saturated' });
          return;
        }

        pending.push({
          isActive,
          start,
          resolveStale: () => resolve({ status: 'stale' }),
        });
      });
    },
  };

  return gate;
}

/**
 * Esegue il rilascio soltanto dopo il settlement della Promise nativa.
 * Serve quando un timeout è logico ma l'API sottostante non è abortibile.
 */
export function finalizeAfterSettlement(
  pending: Promise<unknown> | null,
  finalize: () => void
): void {
  if (!pending) {
    finalize();
    return;
  }
  void pending.then(finalize, finalize);
}

export type LimitedAttemptResult<T> =
  | { status: 'fulfilled'; index: number; value: T }
  | { status: 'rejected'; index: number; error: unknown }
  | { status: 'stale'; index: number };

export async function runLimitedAttempts<TItem, TResult>(options: {
  items: readonly TItem[];
  maxConcurrency: number;
  context: TimedOperationContext;
  attempt: (
    item: TItem,
    index: number,
    context: TimedOperationContext
  ) => Promise<TResult>;
}): Promise<Array<LimitedAttemptResult<TResult>>> {
  if (
    !Number.isSafeInteger(options.maxConcurrency) ||
    options.maxConcurrency < 1
  ) {
    throw new Error('INVALID_CONCURRENCY_LIMIT');
  }

  const results = new Array<LimitedAttemptResult<TResult>>(
    options.items.length
  );
  let nextIndex = 0;

  const worker = async () => {
    while (options.context.isActive()) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= options.items.length) return;

      if (!options.context.isActive()) {
        results[index] = { status: 'stale', index };
        return;
      }

      try {
        const value = await options.attempt(
          options.items[index]!,
          index,
          options.context
        );
        results[index] = options.context.isActive()
          ? { status: 'fulfilled', index, value }
          : { status: 'stale', index };
      } catch (error) {
        results[index] = options.context.isActive()
          ? { status: 'rejected', index, error }
          : { status: 'stale', index };
      }
    }
  };

  const workerCount = Math.min(
    options.items.length,
    options.maxConcurrency
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  for (let index = 0; index < results.length; index += 1) {
    results[index] ??= { status: 'stale', index };
  }
  return results;
}

export interface ScoredAttempt<T> {
  index: number;
  score: number;
  value: T;
}

export function selectBestScoredAttempt<T>(
  attempts: readonly ScoredAttempt<T>[]
): ScoredAttempt<T> | null {
  let best: ScoredAttempt<T> | null = null;
  for (const attempt of attempts) {
    if (
      !best ||
      attempt.score > best.score ||
      (attempt.score === best.score && attempt.index < best.index)
    ) {
      best = attempt;
    }
  }
  return best;
}

export interface TemporaryAssetScope {
  track(uri: string): void;
  retain(uri: string): void;
  close(): Promise<void>;
  flush(): Promise<void>;
}

export function createTemporaryAssetScope(options: {
  cleanup: (uri: string) => Promise<void>;
  onCleanupError?: (uri: string, error: unknown) => void;
}): TemporaryAssetScope {
  const owned = new Set<string>();
  const retained = new Set<string>();
  const cleaned = new Set<string>();
  const pending = new Set<Promise<void>>();
  let closed = false;

  const scheduleCleanup = (uri: string) => {
    if (!uri || retained.has(uri) || cleaned.has(uri)) return;
    cleaned.add(uri);
    let pendingCleanup!: Promise<void>;
    pendingCleanup = options
      .cleanup(uri)
      .catch((error) => options.onCleanupError?.(uri, error))
      .finally(() => pending.delete(pendingCleanup));
    pending.add(pendingCleanup);
  };

  return {
    track(uri): void {
      const normalized = uri.trim();
      if (!normalized || owned.has(normalized)) return;
      owned.add(normalized);
      if (closed) scheduleCleanup(normalized);
    },

    retain(uri): void {
      if (closed) throw new Error('TEMPORARY_ASSET_SCOPE_CLOSED');
      const normalized = uri.trim();
      if (!normalized) return;
      retained.add(normalized);
    },

    async close(): Promise<void> {
      if (!closed) {
        closed = true;
        for (const uri of owned) scheduleCleanup(uri);
      }
      await Promise.allSettled([...pending]);
    },

    async flush(): Promise<void> {
      await Promise.allSettled([...pending]);
    },
  };
}

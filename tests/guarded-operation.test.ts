import assert from 'node:assert/strict';
import test from 'node:test';
import { runAssetSaveSaga } from '../lib/asset-persistence-core';
import { scanPagesLocally } from '../lib/local-ocr-pages';
import {
  createAsyncConcurrencyGate,
  createLatestOperationController,
  createTemporaryAssetScope,
  finalizeAfterSettlement,
  runLimitedAttempts,
  runTimedOperation,
  selectBestScoredAttempt,
  type TimerAdapter,
} from '../lib/guarded-operation';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeTimer implements TimerAdapter {
  private nextId = 0;
  private callbacks = new Map<number, () => void>();

  set(callback: () => void): number {
    this.nextId += 1;
    this.callbacks.set(this.nextId, callback);
    return this.nextId;
  }

  clear(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach((callback) => callback());
  }

  get activeCount(): number {
    return this.callbacks.size;
  }
}

const flushMicrotasks = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

test('4B-01 OCR completato prima del timeout viene accettato e cancella il timer', async () => {
  const timer = new FakeTimer();
  const outcome = await runTimedOperation({
    operationId: 'op-fast',
    timeoutMs: 100,
    fallback: 'original',
    task: async () => 'oriented',
    timer,
  });
  assert.deepEqual(outcome, {
    status: 'completed',
    operationId: 'op-fast',
    value: 'oriented',
  });
  assert.equal(timer.activeCount, 0);
});

test('4B-02 OCR completato dopo il timeout restituisce il fallback', async () => {
  const timer = new FakeTimer();
  const result = deferred<string>();
  const running = runTimedOperation({
    operationId: 'op-timeout',
    timeoutMs: 100,
    fallback: 'original',
    task: async () => result.promise,
    timer,
  });
  await flushMicrotasks();
  timer.fireAll();
  const outcome = await running;
  assert.equal(outcome.status, 'timed_out');
  assert.equal(outcome.value, 'original');
  result.resolve('late-oriented');
  await flushMicrotasks();
  assert.equal(outcome.value, 'original');
});

test('4B-03 risultato tardivo viene ignorato prima dell’effetto', async () => {
  const timer = new FakeTimer();
  const result = deferred<string>();
  let applied = 0;
  const running = runTimedOperation({
    operationId: 'op-late-result',
    timeoutMs: 100,
    fallback: 'original',
    task: async (context) => {
      const value = await result.promise;
      if (context.isActive()) applied += 1;
      return value;
    },
    timer,
  });
  await flushMicrotasks();
  timer.fireAll();
  await running;
  result.resolve('late');
  await flushMicrotasks();
  assert.equal(applied, 0);
});

test('4B-04 rotazioni completate in ordine inverso selezionano lo score, non l’arrivo', () => {
  const best = selectBestScoredAttempt([
    { index: 1, score: 20, value: 90 },
    { index: 0, score: 30, value: 0 },
    { index: 3, score: 10, value: 270 },
    { index: 2, score: 40, value: 180 },
  ]);
  assert.deepEqual(best, { index: 2, score: 40, value: 180 });
});

test('4B-05 nuova scansione invalida quella precedente', async () => {
  const controller = createLatestOperationController(() => 'scan');
  const oldOperation = controller.begin();
  const currentOperation = controller.begin();
  assert.equal(oldOperation.isActive(), false);
  assert.equal(await oldOperation.invalidated, 'replaced');
  assert.equal(currentOperation.isActive(), true);
});

test('4B-06 uscita dalla schermata invalida l’operazione', async () => {
  const controller = createLatestOperationController(() => 'focus');
  const operation = controller.begin();
  controller.invalidateCurrent('screen_blurred');
  assert.equal(operation.isActive(), false);
  assert.equal(await operation.invalidated, 'screen_blurred');
});

test('4B-07 unmount dispone il controller e blocca nuovi effetti', async () => {
  const controller = createLatestOperationController(() => 'mount');
  const operation = controller.begin();
  controller.dispose();
  assert.equal(operation.runIfActive(() => assert.fail('setState tardivo')), false);
  assert.equal(await operation.invalidated, 'unmounted');
  assert.throws(() => controller.begin(), /DISPOSED/);
});

test('4B-08 timeout multipli chiudono tutti i timer logici', async () => {
  const timer = new FakeTimer();
  const never = deferred<string>();
  const operations = ['a', 'b', 'c'].map((operationId) =>
    runTimedOperation({
      operationId,
      timeoutMs: 100,
      fallback: 'original',
      task: async () => never.promise,
      timer,
    })
  );
  await flushMicrotasks();
  assert.equal(timer.activeCount, 3);
  timer.fireAll();
  const outcomes = await Promise.all(operations);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), [
    'timed_out',
    'timed_out',
    'timed_out',
  ]);
  assert.equal(timer.activeCount, 0);
});

test('4B-09 un tentativo fallisce e uno riesce', async () => {
  const attempts = await runLimitedAttempts({
    items: [0, 90],
    maxConcurrency: 2,
    context: { operationId: 'attempts', isActive: () => true },
    attempt: async (angle) => {
      if (angle === 0) throw new Error('ocr failed');
      return angle;
    },
  });
  assert.equal(attempts[0]?.status, 'rejected');
  assert.deepEqual(attempts[1], {
    status: 'fulfilled',
    index: 1,
    value: 90,
  });
});

test('4B-10 tutti i tentativi falliscono senza risultato selezionabile', async () => {
  const attempts = await runLimitedAttempts({
    items: [0, 90, 180, 270],
    maxConcurrency: 2,
    context: { operationId: 'all-fail', isActive: () => true },
    attempt: async () => {
      throw new Error('no OCR');
    },
  });
  assert.equal(attempts.every((attempt) => attempt.status === 'rejected'), true);
  assert.equal(
    selectBestScoredAttempt(
      attempts.flatMap((attempt) =>
        attempt.status === 'fulfilled'
          ? [{ index: attempt.index, score: 1, value: attempt.value }]
          : []
      )
    ),
    null
  );
});

test('4B-11 una selezione già finalizzata non viene finalizzata due volte', () => {
  const controller = createLatestOperationController(() => 'finalize');
  const operation = controller.begin();
  assert.equal(operation.tryFinalize(), true);
  assert.equal(operation.tryFinalize(), false);
  assert.equal(operation.isActive(), false);
  assert.equal(operation.isCurrent(), true);
});

test('4B-12 nessuna doppia navigazione', () => {
  const controller = createLatestOperationController(() => 'navigation');
  const operation = controller.begin();
  let navigations = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (operation.tryFinalize()) navigations += 1;
  }
  assert.equal(navigations, 1);
});

test('4B-13 nessun doppio salvataggio', () => {
  const controller = createLatestOperationController(() => 'save');
  const operation = controller.begin();
  let saves = 0;
  if (operation.tryFinalize()) saves += 1;
  if (operation.tryFinalize()) saves += 1;
  assert.equal(saves, 1);
});

test('4B-14 cleanup elimina asset temporanei una volta e trattiene l’output', async () => {
  const cleaned: string[] = [];
  const scope = createTemporaryAssetScope({
    cleanup: async (uri) => {
      cleaned.push(uri);
    },
  });
  scope.track('file:///cache/thumb.jpg');
  scope.track('file:///cache/rotated.jpg');
  scope.track('file:///cache/rotated.jpg');
  scope.track('file:///cache/final.jpg');
  scope.retain('file:///cache/final.jpg');
  await scope.close();
  assert.deepEqual(cleaned.sort(), [
    'file:///cache/rotated.jpg',
    'file:///cache/thumb.jpg',
  ]);
});

test('4B-15 ogni operationId resta distinto anche con factory ripetitiva', () => {
  const controller = createLatestOperationController(() => 'same');
  const first = controller.begin();
  const second = controller.begin();
  assert.notEqual(first.operationId, second.operationId);
});

test('4B-16 il risultato della vecchia operazione non applica effetti', async () => {
  const controller = createLatestOperationController(() => 'old');
  const oldOperation = controller.begin();
  const result = deferred<string>();
  let applied = '';
  const oldWork = (async () => {
    const value = await result.promise;
    oldOperation.runIfActive(() => {
      applied = value;
    });
  })();
  controller.begin();
  result.resolve('stale');
  await oldWork;
  assert.equal(applied, '');
});

test('4B-17 il limite di concorrenza non supera due tentativi', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const attempts = await runLimitedAttempts({
    items: [0, 90, 180, 270, 360],
    maxConcurrency: 2,
    context: { operationId: 'limit', isActive: () => true },
    attempt: async (angle) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return angle;
    },
  });
  assert.equal(attempts.length, 5);
  assert.equal(maxInFlight, 2);
});

test('4B-18 errore tardivo viene consumato dopo il timeout', async () => {
  const timer = new FakeTimer();
  const result = deferred<string>();
  const running = runTimedOperation({
    operationId: 'late-error',
    timeoutMs: 100,
    fallback: 'original',
    task: async () => result.promise,
    timer,
  });
  await flushMicrotasks();
  timer.fireAll();
  const outcome = await running;
  result.reject(new Error('late native error'));
  await flushMicrotasks();
  assert.equal(outcome.status, 'timed_out');
});

test('4B-19 nessun setState dopo unmount', async () => {
  const controller = createLatestOperationController(() => 'ui');
  const operation = controller.begin();
  const result = deferred<void>();
  let setStateCalls = 0;
  const work = (async () => {
    await result.promise;
    operation.runIfActive(() => {
      setStateCalls += 1;
    });
  })();
  controller.dispose();
  result.resolve();
  await work;
  assert.equal(setStateCalls, 0);
});

test('4B-20 solo l’operazione corrente entra nella saga atomica Fase 1', async () => {
  const controller = createLatestOperationController(() => 'persist');
  const stale = controller.begin();
  const current = controller.begin();
  const calls: string[] = [];

  const persistIfCurrent = async (operation: typeof current) => {
    if (!operation.tryFinalize()) return;
    await runAssetSaveSaga({
      stage: async () => {
        calls.push('stage');
      },
      promote: async () => {
        calls.push('promote');
      },
      persist: async () => {
        calls.push('persist');
      },
      isPersisted: async () => false,
      rollbackAssets: async () => {
        calls.push('rollback');
      },
    });
  };

  await persistIfCurrent(stale);
  await persistIfCurrent(current);
  await persistIfCurrent(current);
  assert.deepEqual(calls, ['stage', 'promote', 'persist']);
});

test('4B-21 cleanup fallito è best-effort e non riapre lo scope', async () => {
  const errors: string[] = [];
  const scope = createTemporaryAssetScope({
    cleanup: async () => {
      throw new Error('filesystem busy');
    },
    onCleanupError: (uri) => errors.push(uri),
  });
  scope.track('file:///cache/failed.jpg');
  await assert.doesNotReject(scope.close());
  assert.deepEqual(errors, ['file:///cache/failed.jpg']);
});

test('4B-22 parità di score usa stabilmente l’indice/angolo precedente', () => {
  const best = selectBestScoredAttempt([
    { index: 3, score: 10, value: 270 },
    { index: 1, score: 10, value: 90 },
  ]);
  assert.deepEqual(best, { index: 1, score: 10, value: 90 });
});

test('4B-23 una risorsa tardiva passa al cleanup senza ritardare il fallback', async () => {
  const timer = new FakeTimer();
  const result = deferred<string>();
  const cleanupGate = deferred<void>();
  const cleanupStarted: string[] = [];
  const cleanupDone: string[] = [];
  const running = runTimedOperation({
    operationId: 'late-resource',
    timeoutMs: 100,
    fallback: 'original',
    task: async () => result.promise,
    onDiscardedValue: async (value) => {
      cleanupStarted.push(value);
      await cleanupGate.promise;
      cleanupDone.push(value);
    },
    timer,
  });

  await flushMicrotasks();
  timer.fireAll();
  const outcome = await running;
  assert.equal(outcome.status, 'timed_out');
  assert.deepEqual(cleanupStarted, []);

  result.resolve('file:///cache/late.jpg');
  await flushMicrotasks();
  assert.deepEqual(cleanupStarted, ['file:///cache/late.jpg']);
  assert.deepEqual(cleanupDone, []);

  cleanupGate.resolve();
  await flushMicrotasks();
  assert.deepEqual(cleanupDone, ['file:///cache/late.jpg']);
});

test('4B-24 un valore fast non viene classificato come risorsa scartata', async () => {
  const discarded: string[] = [];
  const outcome = await runTimedOperation({
    operationId: 'owned-resource',
    timeoutMs: 100,
    fallback: 'original',
    task: async () => 'file:///cache/current.jpg',
    onDiscardedValue: async (value) => {
      discarded.push(value);
    },
  });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(discarded, []);
});

test('4B-25 il limiter condiviso mantiene due job attivi e una coda finita', async () => {
  const gate = createAsyncConcurrencyGate(2, 4);
  const holds = Array.from({ length: 6 }, () => deferred<void>());
  const started: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const operations = holds.map((hold, index) =>
    gate.run({
      task: async () => {
        started.push(index);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await hold.promise;
        inFlight -= 1;
        return index;
      },
    })
  );

  await flushMicrotasks();
  assert.deepEqual(started, [0, 1]);
  assert.equal(gate.activeCount(), 2);
  assert.equal(gate.pendingCount(), 4);

  for (const hold of holds) {
    hold.resolve();
    await flushMicrotasks();
  }
  const outcomes = await Promise.all(operations);
  assert.equal(
    outcomes.every((outcome) => outcome.status === 'completed'),
    true
  );
  assert.equal(maxInFlight, 2);
  assert.equal(gate.activeCount(), 0);
  assert.equal(gate.pendingCount(), 0);
});

test('4B-26 un job stale in coda non avvia il lavoro nativo', async () => {
  const gate = createAsyncConcurrencyGate(1, 1);
  const firstGate = deferred<void>();
  let secondActive = true;
  let secondStarted = 0;
  const first = gate.run({
    task: async () => {
      await firstGate.promise;
      return 'first';
    },
  });
  const second = gate.run({
    isActive: () => secondActive,
    task: async () => {
      secondStarted += 1;
      return 'second';
    },
  });

  await flushMicrotasks();
  secondActive = false;
  firstGate.resolve();
  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
  assert.equal(firstOutcome.status, 'completed');
  assert.equal(secondOutcome.status, 'stale');
  assert.equal(secondStarted, 0);
});

test('4B-27 la coda piena rifiuta altro lavoro senza superare il limite', async () => {
  const gate = createAsyncConcurrencyGate(1, 1);
  const hold = deferred<void>();
  const first = gate.run({ task: async () => hold.promise });
  const queued = gate.run({ task: async () => 'queued' });
  const saturated = await gate.run({ task: async () => 'never' });
  assert.equal(saturated.status, 'saturated');
  assert.equal(gate.activeCount(), 1);
  assert.equal(gate.pendingCount(), 1);
  hold.resolve();
  await Promise.all([first, queued]);
});

test('4B-28 una scansione multipagina stale non avvia la pagina successiva', async () => {
  let active = true;
  let calls = 0;
  const result = await scanPagesLocally(
    ['page-1', 'page-2'],
    async () => {
      calls += 1;
      active = false;
      return {
        lines: [{ text: 'late', confidence: 0.5 }],
        text: 'late',
      };
    },
    { isActive: () => active }
  );

  assert.equal(calls, 1);
  assert.deepEqual(result.pages, []);
  assert.equal(result.ocrWorked, false);
});

test('4B-29 il mutex camera resta chiuso fino al settlement nativo tardivo', async () => {
  const nativeCapture = deferred<void>();
  let releases = 0;
  finalizeAfterSettlement(nativeCapture.promise, () => {
    releases += 1;
  });

  await flushMicrotasks();
  assert.equal(releases, 0);
  nativeCapture.resolve();
  await flushMicrotasks();
  assert.equal(releases, 1);
});

test('4B-30 anche un rigetto nativo rilascia il mutex una sola volta', async () => {
  const nativeCapture = deferred<void>();
  let releases = 0;
  finalizeAfterSettlement(nativeCapture.promise, () => {
    releases += 1;
  });

  nativeCapture.reject(new Error('late camera failure'));
  await flushMicrotasks();
  assert.equal(releases, 1);
});

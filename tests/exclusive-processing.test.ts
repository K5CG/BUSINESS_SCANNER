import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runAssetSaveSaga } from '../lib/asset-persistence-core';
import {
  createExclusiveOperationGate,
  type ExclusiveOperationGate,
} from '../lib/exclusive-operation-gate';
import { createLatestOperationController } from '../lib/guarded-operation';

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

async function runExclusive(
  gate: ExclusiveOperationGate,
  task: () => Promise<void>,
  holdForNavigation = false
): Promise<boolean> {
  const lease = gate.tryAcquire();
  if (!lease) return false;
  try {
    await task();
    return true;
  } finally {
    if (!holdForNavigation) lease.release();
  }
}

function countingHandler(options: {
  gate: ExclusiveOperationGate;
  pause: Promise<void>;
  counters: {
    ocr: number;
    parser: number;
    assets: number;
    records: number;
    store: number;
    navigation: number;
  };
}) {
  const lease = options.gate.tryAcquire();
  if (!lease) {
    return { entered: false, done: Promise.resolve(false) };
  }
  options.counters.ocr += 1;
  const done = (async () => {
    try {
      await options.pause;
      options.counters.parser += 1;
      options.counters.assets += 1;
      options.counters.records += 1;
      options.counters.store += 1;
      options.counters.navigation += 1;
      return true;
    } finally {
      lease.release();
    }
  })();
  return { entered: true, done };
}

test('5B-01 doppio acquire nello stesso tick ammette solo il primo', () => {
  const gate = createExclusiveOperationGate(() => 'same-tick');
  const first = gate.tryAcquire();
  const second = gate.tryAcquire();
  assert.ok(first);
  assert.equal(second, null);
});

test('5B-02 doppio handler prima del primo await avvia una pipeline', async () => {
  const gate = createExclusiveOperationGate(() => 'before-await');
  const pause = deferred<void>();
  let entered = 0;
  const handler = () =>
    runExclusive(gate, async () => {
      entered += 1;
      await pause.promise;
    });
  const first = handler();
  const second = handler();
  assert.equal(entered, 1);
  assert.equal(await second, false);
  pause.resolve();
  assert.equal(await first, true);
});

test('5B-03 secondo tap durante OCR è ignorato', () => {
  const gate = createExclusiveOperationGate(() => 'ocr');
  const first = gate.tryAcquire();
  assert.ok(first);
  assert.equal(gate.tryAcquire(), null);
});

test('5B-04 secondo tap durante persistenza è ignorato', async () => {
  const gate = createExclusiveOperationGate(() => 'persist');
  const persistence = deferred<void>();
  const first = runExclusive(gate, () => persistence.promise);
  assert.equal(gate.tryAcquire(), null);
  persistence.resolve();
  assert.equal(await first, true);
});

test('5B-05 successo con navigazione trattiene il lock fino al blur', async () => {
  const gate = createExclusiveOperationGate(() => 'navigation');
  await runExclusive(gate, async () => undefined, true);
  assert.equal(gate.isLocked(), true);
  gate.invalidateCurrent();
  assert.equal(gate.isLocked(), false);
});

test('5B-06 errore rilascia il lock e consente retry', async () => {
  const gate = createExclusiveOperationGate(() => 'error');
  await assert.rejects(
    runExclusive(gate, async () => {
      throw new Error('pipeline failed');
    }),
    /pipeline failed/
  );
  assert.ok(gate.tryAcquire());
});

test('5B-07 timeout invalida il lock e consente retry', () => {
  const gate = createExclusiveOperationGate(() => 'timeout');
  assert.ok(gate.tryAcquire());
  assert.equal(gate.invalidateCurrent(), true);
  assert.ok(gate.tryAcquire());
});

test('5B-08 annullamento rilascia il lock e consente retry', () => {
  const gate = createExclusiveOperationGate(() => 'cancel');
  assert.ok(gate.tryAcquire());
  gate.invalidateCurrent();
  assert.ok(gate.tryAcquire());
});

test('5B-09 due tap producono un solo record', async () => {
  const gate = createExclusiveOperationGate(() => 'record');
  const pause = deferred<void>();
  const counters = {
    ocr: 0,
    parser: 0,
    assets: 0,
    records: 0,
    store: 0,
    navigation: 0,
  };
  const first = countingHandler({ gate, pause: pause.promise, counters });
  const second = countingHandler({ gate, pause: pause.promise, counters });
  pause.resolve();
  await Promise.all([first.done, second.done]);
  assert.equal(counters.records, 1);
});

test('5B-10 due tap producono una sola copia asset', async () => {
  const gate = createExclusiveOperationGate(() => 'assets');
  const pause = deferred<void>();
  const counters = {
    ocr: 0,
    parser: 0,
    assets: 0,
    records: 0,
    store: 0,
    navigation: 0,
  };
  const first = countingHandler({ gate, pause: pause.promise, counters });
  const second = countingHandler({ gate, pause: pause.promise, counters });
  pause.resolve();
  await Promise.all([first.done, second.done]);
  assert.equal(counters.assets, 1);
});

test('5B-11 due tap producono un solo store update', async () => {
  const gate = createExclusiveOperationGate(() => 'store');
  const pause = deferred<void>();
  const counters = {
    ocr: 0,
    parser: 0,
    assets: 0,
    records: 0,
    store: 0,
    navigation: 0,
  };
  const first = countingHandler({ gate, pause: pause.promise, counters });
  const second = countingHandler({ gate, pause: pause.promise, counters });
  pause.resolve();
  await Promise.all([first.done, second.done]);
  assert.equal(counters.store, 1);
});

test('5B-12 due tap producono una sola navigazione', async () => {
  const gate = createExclusiveOperationGate(() => 'router');
  const pause = deferred<void>();
  const counters = {
    ocr: 0,
    parser: 0,
    assets: 0,
    records: 0,
    store: 0,
    navigation: 0,
  };
  const first = countingHandler({ gate, pause: pause.promise, counters });
  const second = countingHandler({ gate, pause: pause.promise, counters });
  pause.resolve();
  await Promise.all([first.done, second.done]);
  assert.equal(counters.navigation, 1);
});

test('5B-13 successo senza navigazione rilascia il lock', async () => {
  const gate = createExclusiveOperationGate(() => 'success');
  assert.equal(await runExclusive(gate, async () => undefined), true);
  assert.equal(gate.isLocked(), false);
});

test('5B-14 finally di errore rilascia il lock', async () => {
  const gate = createExclusiveOperationGate(() => 'failure-finally');
  await assert.rejects(
    runExclusive(gate, async () => {
      throw new Error('expected');
    })
  );
  assert.equal(gate.isLocked(), false);
});

test('5B-15 invalidazione di annullamento apre il gate', () => {
  const gate = createExclusiveOperationGate(() => 'cancel-release');
  assert.ok(gate.tryAcquire());
  gate.invalidateCurrent();
  assert.equal(gate.isLocked(), false);
});

test('5B-16 unmount dispone il gate e blocca effetti futuri', () => {
  const gate = createExclusiveOperationGate(() => 'unmount');
  const lease = gate.tryAcquire();
  assert.ok(lease);
  gate.dispose();
  assert.equal(gate.isLocked(), false);
  assert.equal(lease.isOwner(), false);
  assert.equal(gate.tryAcquire(), null);
});

test('5B-17 nuova scansione entra dopo invalidazione della precedente', () => {
  const gate = createExclusiveOperationGate(() => 'new-scan');
  const old = gate.tryAcquire();
  assert.ok(old);
  gate.invalidateCurrent();
  const current = gate.tryAcquire();
  assert.ok(current);
  assert.notEqual(current.operationId, old.operationId);
});

test('5B-18 tre tap rapidi producono una sola pipeline', async () => {
  const gate = createExclusiveOperationGate(() => 'triple');
  const pause = deferred<void>();
  let pipelines = 0;
  const handler = () =>
    runExclusive(gate, async () => {
      pipelines += 1;
      await pause.promise;
    });
  const runs = [handler(), handler(), handler()];
  assert.equal(pipelines, 1);
  pause.resolve();
  assert.deepEqual(await Promise.all(runs), [true, false, false]);
});

test('5B-19 una finally tardiva A non libera la lease B', () => {
  const gate = createExclusiveOperationGate(() => 'owner');
  const old = gate.tryAcquire();
  assert.ok(old);
  gate.invalidateCurrent();
  const current = gate.tryAcquire();
  assert.ok(current);
  assert.equal(old.release(), false);
  assert.equal(current.isOwner(), true);
  assert.equal(gate.isLocked(), true);
});

test('5B-20 la saga atomica Fase 1 viene eseguita una sola volta', async () => {
  const gate = createExclusiveOperationGate(() => 'phase1');
  const events: string[] = [];
  const handler = () =>
    runExclusive(gate, async () => {
      await runAssetSaveSaga({
        stage: async () => {
          events.push('stage');
        },
        promote: async () => {
          events.push('promote');
        },
        persist: async () => {
          events.push('persist');
        },
        isPersisted: async () => true,
        rollbackAssets: async () => {
          events.push('rollback');
        },
      });
    });
  const first = handler();
  const second = handler();
  assert.equal(await second, false);
  assert.equal(await first, true);
  assert.deepEqual(events, ['stage', 'promote', 'persist']);
});

test('5B-21 cancellazione resta compatibile con la lease 5A', () => {
  const gate = createExclusiveOperationGate(() => 'phase5a');
  const exclusive = gate.tryAcquire();
  const controller = createLatestOperationController(() => 'scan');
  const operation = controller.begin();
  assert.ok(exclusive);
  controller.invalidateCurrent('screen_blurred');
  gate.invalidateCurrent();
  let effects = 0;
  operation.runIfActive(() => {
    effects += 1;
  });
  assert.equal(effects, 0);
  assert.equal(exclusive.release(), false);
  assert.ok(gate.tryAcquire());
});

test('5B-22 doppio Invia entra una volta', async () => {
  const gate = createExclusiveOperationGate(() => 'double-export');
  const pause = deferred<void>();
  let exports = 0;
  const send = () =>
    runExclusive(gate, async () => {
      exports += 1;
      await pause.promise;
    });
  const first = send();
  const second = send();
  pause.resolve();
  await Promise.all([first, second]);
  assert.equal(exports, 1);
});

test('5B-23 Salva e Invia condividono lo stesso gate', async () => {
  const gate = createExclusiveOperationGate(() => 'save-export');
  const pause = deferred<void>();
  let saves = 0;
  let exports = 0;
  const save = runExclusive(gate, async () => {
    saves += 1;
    await pause.promise;
  });
  const send = runExclusive(gate, async () => {
    exports += 1;
  });
  pause.resolve();
  await Promise.all([save, send]);
  assert.deepEqual({ saves, exports }, { saves: 1, exports: 0 });
});

test('5B-24 doppia conferma PDF avvia una sola importazione', async () => {
  const gate = createExclusiveOperationGate(() => 'pdf');
  const pause = deferred<void>();
  let imports = 0;
  const confirm = () =>
    runExclusive(gate, async () => {
      imports += 1;
      await pause.promise;
    });
  const first = confirm();
  const second = confirm();
  pause.resolve();
  await Promise.all([first, second]);
  assert.equal(imports, 1);
});

test('5B-25 la cattura viene respinta mentre Processa possiede il gate', () => {
  const gate = createExclusiveOperationGate(() => 'capture');
  assert.ok(gate.tryAcquire());
  const captureAccepted = !gate.isLocked();
  assert.equal(captureAccepted, false);
});

test('5B-26 un idFactory ripetitivo produce lease distinte', () => {
  const gate = createExclusiveOperationGate(() => 'fixed');
  const first = gate.tryAcquire();
  assert.ok(first);
  first.release();
  const second = gate.tryAcquire();
  assert.ok(second);
  assert.notEqual(first.operationId, second.operationId);
});

test('5B-27 i consumer reali usano gate condivisi prima delle pipeline', () => {
  const scanner = readFileSync(
    'components/Camera/MultiPageScanner.tsx',
    'utf8'
  );
  const review = readFileSync('app/document/[id].tsx', 'utf8');
  const exportScreen = readFileSync('app/export/[id].tsx', 'utf8');

  assert.ok(
    (scanner.match(/processingGateRef\.current\.tryAcquire\(\)/g) ?? [])
      .length >= 2
  );
  assert.match(
    scanner,
    /captureInProgress\.current \|\|\s*processingGateRef\.current\.isLocked\(\)/
  );
  assert.match(scanner, /if \(!navigated\) exclusiveLease\.release\(\)/);
  assert.match(scanner, /pendingProcessSettlementsRef/);

  assert.ok(
    (review.match(/saveExportGateRef\.current\.tryAcquire\(\)/g) ?? [])
      .length >= 2
  );
  assert.match(review, /saveExportGateRef\.current\.invalidateCurrent\(\)/);

  assert.ok(
    (exportScreen.match(/shareGateRef\.current\.tryAcquire\(\)/g) ?? [])
      .length >= 2
  );
});

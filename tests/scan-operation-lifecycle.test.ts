import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runAssetSaveSaga } from '../lib/asset-persistence-core';
import {
  createLatestOperationController,
  createTemporaryAssetScope,
} from '../lib/guarded-operation';
import {
  commitCreatedRecordIfActive,
  commitExistingRecordIfActive,
  hasSamePersistenceRevision,
  InactiveScanOperationError,
  isInactiveScanOperationError,
  runActiveOperationStep,
  runFinalOperationEffect,
  withPersistenceRevision,
  yieldToOperationEventLoop,
} from '../lib/scan-operation-lifecycle';

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

const flushMicrotasks = async () => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
};

test('5A-01 Indietro prima dell’OCR invalida la lease', () => {
  const controller = createLatestOperationController(() => 'scan');
  const operation = controller.begin();
  controller.invalidateCurrent('manual');
  assert.equal(operation.isActive(), false);
});

test('5A-02 Indietro durante OCR rende il risultato inutilizzabile', async () => {
  const controller = createLatestOperationController(() => 'ocr');
  const operation = controller.begin();
  const ocr = deferred<string>();
  const running = ocr.promise.then((value) =>
    operation.isActive() ? value : 'ignored'
  );
  controller.invalidateCurrent('screen_blurred');
  ocr.resolve('late');
  assert.equal(await running, 'ignored');
});

test('5A-03 il yield dopo parsing lascia passare l’annullamento accodato', async () => {
  let resume!: () => void;
  const controller = createLatestOperationController(() => 'parse');
  const operation = controller.begin();
  const yielded = yieldToOperationEventLoop((callback) => {
    resume = callback;
    return 1;
  });
  controller.invalidateCurrent('manual');
  resume();
  await yielded;
  assert.equal(operation.tryFinalize(), false);
});

test('5A-04 annullamento durante copia immagini compensa senza pubblicare', async () => {
  const controller = createLatestOperationController(() => 'copy');
  const operation = controller.begin();
  assert.equal(operation.tryFinalize(), true);
  const copied = deferred<{ id: string }>();
  let compensated = 0;
  let published = 0;
  const running = commitCreatedRecordIfActive({
    operationId: operation.operationId,
    isActive: operation.isCurrent,
    compensationTarget: { id: 'copy-record' },
    persist: () => copied.promise,
    compensate: async () => {
      compensated += 1;
    },
    publish: () => {
      published += 1;
    },
  });
  controller.invalidateCurrent('screen_blurred');
  copied.resolve({ id: 'copy-record' });
  await assert.rejects(running, InactiveScanOperationError);
  assert.equal(compensated, 1);
  assert.equal(published, 0);
});

test('5A-05 annullamento durante transazione DB compensa il commit concluso', async () => {
  const transaction = deferred<{ id: string }>();
  let active = true;
  let compensatedId = '';
  const running = commitCreatedRecordIfActive({
    operationId: 'db-op',
    isActive: () => active,
    compensationTarget: { id: 'db-record' },
    persist: () => transaction.promise,
    compensate: async (record) => {
      compensatedId = record.id;
    },
    publish: () => assert.fail('store non deve essere aggiornato'),
  });
  active = false;
  transaction.resolve({ id: 'db-record' });
  await assert.rejects(running, /after_persistence/);
  assert.equal(compensatedId, 'db-record');
});

test('5A-06 annullamento dopo il salvataggio ma prima della pubblicazione compensa', async () => {
  let active = true;
  let compensated = false;
  let published = false;
  await assert.rejects(
    commitCreatedRecordIfActive({
      operationId: 'post-save',
      isActive: () => active,
      compensationTarget: { id: 'saved' },
      persist: async () => {
        active = false;
        return { id: 'saved' };
      },
      compensate: async () => {
        compensated = true;
      },
      publish: () => {
        published = true;
      },
    }),
    /after_persistence/
  );
  assert.equal(compensated, true);
  assert.equal(published, false);
});

test('5A-07 unmount impedisce setState e feedback tardivi', async () => {
  const controller = createLatestOperationController(() => 'unmount');
  const operation = controller.begin();
  controller.dispose();
  let effects = 0;
  const ran = operation.runIfActive(() => {
    effects += 1;
  });
  assert.equal(ran, false);
  assert.equal(effects, 0);
});

test('5A-08 una nuova scansione invalida la precedente', () => {
  const controller = createLatestOperationController(() => 'replace');
  const oldOperation = controller.begin();
  const currentOperation = controller.begin();
  assert.equal(oldOperation.isCurrent(), false);
  assert.equal(currentOperation.isCurrent(), true);
});

test('5A-09 un operationId vecchio non può pubblicare nello store', async () => {
  const controller = createLatestOperationController(() => 'version');
  const oldOperation = controller.begin();
  controller.begin();
  let persisted = 0;
  await assert.rejects(
    commitCreatedRecordIfActive({
      operationId: oldOperation.operationId,
      isActive: oldOperation.isCurrent,
      compensationTarget: { id: 'old' },
      persist: async () => {
        persisted += 1;
        return { id: 'old' };
      },
      compensate: async () => undefined,
      publish: () => assert.fail('pubblicazione stale'),
    }),
    /before_persistence/
  );
  assert.equal(persisted, 0);
});

test('5A-10 nessun setState dopo invalidazione durante update', async () => {
  const pending = deferred<number>();
  let active = true;
  let stateUpdates = 0;
  const running = commitExistingRecordIfActive({
    operationId: 'update',
    isActive: () => active,
    persist: () => pending.promise,
    publish: () => {
      stateUpdates += 1;
    },
  });
  active = false;
  pending.resolve(1);
  await assert.rejects(running, /after_persistence/);
  assert.equal(stateUpdates, 0);
});

test('5A-11 un commit attivo aggiorna lo store una sola volta', async () => {
  let updates = 0;
  const result = await commitCreatedRecordIfActive({
    operationId: 'active-create',
    isActive: () => true,
    compensationTarget: { id: 'record' },
    persist: async () => ({ id: 'record' }),
    compensate: async () => assert.fail('compensazione inattesa'),
    publish: () => {
      updates += 1;
    },
  });
  assert.equal(result.id, 'record');
  assert.equal(updates, 1);
});

test('5A-12 la navigazione finale è applicata al massimo una volta', () => {
  const controller = createLatestOperationController(() => 'navigation');
  const operation = controller.begin();
  let navigations = 0;
  assert.equal(
    runFinalOperationEffect(operation, () => {
      navigations += 1;
    }),
    true
  );
  assert.equal(
    runFinalOperationEffect(operation, () => {
      navigations += 1;
    }),
    false
  );
  assert.equal(navigations, 1);
});

test('5A-13 gli asset temporanei vengono puliti su annullamento', async () => {
  const cleaned: string[] = [];
  const scope = createTemporaryAssetScope({
    cleanup: async (uri) => {
      cleaned.push(uri);
    },
  });
  scope.track('cache://front.jpg');
  scope.track('cache://back.jpg');
  await scope.close();
  assert.deepEqual(cleaned.sort(), [
    'cache://back.jpg',
    'cache://front.jpg',
  ]);
});

test('5A-14 la compensazione riconosce la stessa revisione', () => {
  const expected = withPersistenceRevision(
    { id: 'same', persistenceRevision: undefined },
    'operation-a'
  );
  const current = { ...expected };
  assert.equal(hasSamePersistenceRevision(current, expected), true);
});

test('5A-15 la compensazione non cancella un retry più recente', () => {
  const expected = {
    id: 'same',
    persistenceRevision: 'operation-old',
  };
  const current = {
    id: 'same',
    persistenceRevision: 'operation-new',
  };
  assert.equal(hasSamePersistenceRevision(current, expected), false);
});

test('5A-16 un errore tardivo viene classificato come inattivo e ignorabile', async () => {
  const pending = deferred<{ id: string }>();
  let active = true;
  let compensatedId = '';
  const running = commitCreatedRecordIfActive({
    operationId: 'late-error',
    isActive: () => active,
    compensationTarget: { id: 'late-error' },
    persist: () => pending.promise,
    compensate: async (target) => {
      compensatedId = target.id;
    },
    publish: () => assert.fail('pubblicazione inattesa'),
  });
  active = false;
  pending.reject(new Error('native late error'));
  await assert.rejects(running, (error: unknown) => {
    assert.equal(isInactiveScanOperationError(error), true);
    assert.equal(
      (error as InactiveScanOperationError).checkpoint,
      'persistence_failed_after_invalidation'
    );
    assert.equal(
      (error as InactiveScanOperationError).compensationAttempted,
      true
    );
    return true;
  });
  assert.equal(compensatedId, 'late-error');
});

test('5A-17 un risultato tardivo viene compensato e non applicato', async () => {
  const pending = deferred<string>();
  let active = true;
  const compensated: string[] = [];
  const applied: string[] = [];
  const running = commitCreatedRecordIfActive({
    operationId: 'late-result',
    isActive: () => active,
    compensationTarget: 'late',
    persist: () => pending.promise,
    compensate: async (value) => {
      compensated.push(value);
    },
    publish: (value) => {
      applied.push(value);
    },
  });
  active = false;
  pending.resolve('late');
  await assert.rejects(running, /after_persistence/);
  assert.deepEqual(compensated, ['late']);
  assert.deepEqual(applied, []);
});

test('5A-18 il claim 4B resta corrente durante il commit protetto', async () => {
  const controller = createLatestOperationController(() => 'claimed');
  const operation = controller.begin();
  assert.equal(operation.tryFinalize(), true);
  assert.equal(operation.isActive(), false);
  assert.equal(operation.isCurrent(), true);
  let published = 0;
  await commitCreatedRecordIfActive({
    operationId: operation.operationId,
    isActive: operation.isCurrent,
    compensationTarget: { id: 'claimed-record' },
    persist: async () => ({ id: 'claimed-record' }),
    compensate: async () => assert.fail('compensazione inattesa'),
    publish: () => {
      published += 1;
    },
  });
  assert.equal(published, 1);
});

test('5A-19 la saga Fase 1 resta atomica dentro il commit protetto', async () => {
  const events: string[] = [];
  let stored = false;
  await commitCreatedRecordIfActive({
    operationId: 'phase1-compatible',
    isActive: () => true,
    compensationTarget: { id: 'atomic' },
    persist: async () => {
      await runAssetSaveSaga({
        stage: async () => {
          events.push('stage');
        },
        promote: async () => {
          events.push('promote');
        },
        persist: async () => {
          events.push('persist');
          stored = true;
        },
        isPersisted: async () => stored,
        rollbackAssets: async () => {
          events.push('rollback');
        },
      });
      return { id: 'atomic' };
    },
    compensate: async () => assert.fail('compensazione inattesa'),
    publish: () => {
      events.push('store');
    },
  });
  assert.deepEqual(events, ['stage', 'promote', 'persist', 'store']);
});

test('5A-20 la lease 4B invalidata resta compatibile con il gate 5A', async () => {
  const controller = createLatestOperationController(() => 'phase4b');
  const operation = controller.begin();
  controller.invalidateCurrent('timeout');
  await assert.rejects(
    commitExistingRecordIfActive({
      operationId: operation.operationId,
      isActive: operation.isCurrent,
      persist: async () => 'should-not-run',
      publish: () => assert.fail('effetto inatteso'),
    }),
    /before_persistence/
  );
});

test('5A-21 una compensazione fallita resta diagnostica ma non pubblica', async () => {
  let active = true;
  let published = 0;
  const running = commitCreatedRecordIfActive({
    operationId: 'compensation-failure',
    isActive: () => active,
    compensationTarget: { id: 'ambiguous' },
    persist: async () => {
      active = false;
      return { id: 'ambiguous' };
    },
    compensate: async () => {
      throw new Error('delete failed');
    },
    publish: () => {
      published += 1;
    },
  });
  await assert.rejects(running, (error: unknown) => {
    assert.equal(isInactiveScanOperationError(error), true);
    const inactive = error as InactiveScanOperationError;
    assert.equal(inactive.checkpoint, 'compensation_failed');
    assert.equal(inactive.compensationAttempted, true);
    return true;
  });
  assert.equal(published, 0);
});

test('5A-22 un errore di persistenza attivo resta visibile al chiamante', async () => {
  const original = new Error('db unavailable');
  await assert.rejects(
    commitCreatedRecordIfActive({
      operationId: 'active-failure',
      isActive: () => true,
      compensationTarget: { id: 'failed' },
      persist: async () => {
        throw original;
      },
      compensate: async () => undefined,
      publish: () => undefined,
    }),
    (error: unknown) => error === original
  );
});

test('5A-23 il yield non riprende prima del turno host', async () => {
  let scheduled!: () => void;
  let resumed = false;
  const running = yieldToOperationEventLoop((callback) => {
    scheduled = callback;
    return 1;
  }).then(() => {
    resumed = true;
  });
  await flushMicrotasks();
  assert.equal(resumed, false);
  scheduled();
  await running;
  assert.equal(resumed, true);
});

test('5A-24 una revisione mancante fallisce chiusa', () => {
  assert.equal(
    hasSamePersistenceRevision(
      { id: 'legacy' },
      { id: 'legacy', persistenceRevision: 'operation' }
    ),
    false
  );
});

test('5A-25 un await preparatorio completato dopo Back non produce feedback', async () => {
  const pending = deferred<boolean>();
  let active = true;
  let feedback = 0;
  const running = runActiveOperationStep(
    {
      operationId: 'duplicate-prompt',
      isActive: () => active,
    },
    () => pending.promise
  ).then(() => {
    feedback += 1;
  });
  active = false;
  pending.resolve(true);
  await assert.rejects(running, /after_async_step/);
  assert.equal(feedback, 0);
});

test('5A-26 un errore preparatorio tardivo non diventa store.error', async () => {
  const pending = deferred<boolean>();
  let active = true;
  let storeErrors = 0;
  const running = runActiveOperationStep(
    {
      operationId: 'duplicate-read-error',
      isActive: () => active,
    },
    () => pending.promise
  ).catch((error: unknown) => {
    if (!isInactiveScanOperationError(error)) storeErrors += 1;
    throw error;
  });
  active = false;
  pending.reject(new Error('late read error'));
  await assert.rejects(running, /async_step_failed_after_invalidation/);
  assert.equal(storeErrors, 0);
});

test('5A-27 la AI review è vincolata al focus e cancellata dal parent', () => {
  const editor = readFileSync('components/BusinessCardEditor.tsx', 'utf8');
  const review = readFileSync('app/document/[id].tsx', 'utf8');
  assert.match(editor, /isScreenActiveRef\.current\(\)/);
  assert.match(editor, /registerCancellation\?\.\(cancelAiOperation\)/);
  assert.match(
    review,
    /businessEditorCancellationRef\.current\?\.\(\)/
  );
  assert.match(
    review,
    /!screenActiveRef\.current \|\|\s*imageRotationRunningRef\.current/
  );
  assert.match(
    review,
    /documentRef\.current = next;\s*setDocument\(next\)/
  );
});

test('5A-28 il draft viene pulito per ID anche prima del caricamento', () => {
  const review = readFileSync('app/document/[id].tsx', 'utf8');
  const store = readFileSync('store/useContactStore.ts', 'utf8');
  assert.match(
    review,
    /useContactStore\.getState\(\)\.draftContact\?\.id === routeId/
  );
  assert.match(review, /clearDraftContact\(card\.id\)/);
  assert.match(
    review,
    /draftPersistenceOwnerRef\.current !== operationId/
  );
  assert.match(
    store,
    /state\.draftContact\?\.id !== expectedId/
  );
});

test('5A-29 sessione camera e PDF temporaneo hanno cleanup finito', () => {
  const scanner = readFileSync(
    'components/Camera/MultiPageScanner.tsx',
    'utf8'
  );
  const pdfImport = readFileSync('lib/pdf-import.ts', 'utf8');
  assert.match(
    scanner,
    /if \(pendingProcessSettlementsRef\.current\.size > 0\) \{/
  );
  assert.doesNotMatch(
    scanner,
    /if \(\s*captureInProgress\.current\s*\|\|\s*pendingProcessSettlementsRef\.current\.size > 0\s*\) \{/
  );
  assert.match(pdfImport, /finally \{/);
  assert.match(pdfImport, /cleanupTemporaryPdfUri\(asset\.uri\)/);
});

test('5A-30 export e feedback legacy non sopravvivono alla navigazione', () => {
  const exportScreen = readFileSync('app/export/[id].tsx', 'utf8');
  const legacyScanner = readFileSync(
    'components/Camera/CardScanner.tsx',
    'utf8'
  );
  assert.match(exportScreen, /useFocusEffect\(/);
  assert.match(exportScreen, /navigation\.addListener\('beforeRemove'/);
  assert.match(exportScreen, /operation\.tryFinalize\(\)/);
  assert.ok(
    legacyScanner.indexOf("'Foto salvata'") <
      legacyScanner.indexOf("router.replace(`/document/${card.id}`)")
  );
});

test('5A-31 errori load e preferenze modal tardivi vengono consumati', () => {
  const review = readFileSync('app/document/[id].tsx', 'utf8');
  const modal = readFileSync(
    'components/GeminiConfirmationModal.tsx',
    'utf8'
  );
  assert.match(
    review,
    /catch \{\s*if \(!isActive\(\)\) return;[\s\S]*Alert\.alert/
  );
  assert.match(modal, /let active = true/);
  assert.match(
    modal,
    /if \(!active \|\| !mountedRef\.current \|\| !visibleRef\.current\) return/
  );
  assert.match(
    modal,
    /if \(!mountedRef\.current \|\| !visibleRef\.current\) return;\s*onConfirm\(\)/
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  runAssetDeleteSaga,
  runAssetBatchDeleteSaga,
  runAssetSaveSaga,
} from '../lib/asset-persistence-core';
import { createAsyncMutex } from '../lib/async-mutex';
import {
  assertAssetTokenPaths,
  assertDeletionTokenPaths,
  assertFreshAssetRevision,
  otherOwnerUsesDirectory,
  ownerReferencesAllowPerFileSweep,
  ownersOutsideConfirmedContactDeletion,
  selectOrphanRecordDirectoryUris,
  selectUnreferencedManagedAssetUris,
} from '../lib/asset-path-policy';

const RECORD_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const ORPHAN_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOT = 'file:///documents/scans/';

test('create multipagina: URI temporanei entrano solo nello staging e lo store cambia dopo il commit', async () => {
  const sources = ['content://camera/front', 'file:///cache/back.jpg'];
  const staged = new Set<string>();
  const final = new Set<string>();
  const finalUris = sources.map(
    (_source, index) => `${ROOT}${RECORD_ID}/page-${index}-${OPERATION_ID}.jpg`
  );
  let dbImages: string[] | null = null;
  let storeImages: string[] = ['old'];
  const calls: string[] = [];

  await runAssetSaveSaga({
    stage: async () => {
      calls.push('stage');
      sources.forEach((_source, index) => staged.add(`stage/page-${index}.jpg`));
    },
    promote: async () => {
      calls.push('promote');
      staged.clear();
      finalUris.forEach((uri) => final.add(uri));
    },
    persist: async () => {
      calls.push('db');
      dbImages = [...finalUris];
    },
    isPersisted: async () => false,
    rollbackAssets: async () => {
      staged.clear();
      final.clear();
    },
  });
  storeImages = [...finalUris];

  assert.deepEqual(calls, ['stage', 'promote', 'db']);
  assert.deepEqual(dbImages, finalUris);
  assert.deepEqual(storeImages, finalUris);
  assert.equal(staged.size, 0);
  assert.deepEqual([...final], finalUris);
  assert.equal(finalUris.some((uri) => uri.startsWith('content://')), false);
});

test('copy fallita sulla pagina N: niente DB, finali o mutazione store', async () => {
  const staged = new Set<string>();
  const final = new Set<string>();
  let dbCalled = false;
  const store = ['unchanged'];

  await assert.rejects(
    runAssetSaveSaga({
      stage: async () => {
        staged.add('page-0');
        throw new Error('copy-page-1');
      },
      promote: async () => {
        final.add('should-not-exist');
      },
      persist: async () => {
        dbCalled = true;
      },
      isPersisted: async () => false,
      rollbackAssets: async () => {
        staged.clear();
        final.clear();
      },
    }),
    /copy-page-1/
  );

  assert.equal(dbCalled, false);
  assert.equal(staged.size, 0);
  assert.equal(final.size, 0);
  assert.deepEqual(store, ['unchanged']);
});

test('promozione parziale fallita: compensa i finali gia mossi', async () => {
  const staged = new Set(['page-0', 'page-1']);
  const final = new Set<string>();
  let dbCalled = false;

  await assert.rejects(
    runAssetSaveSaga({
      stage: async () => undefined,
      promote: async () => {
        staged.delete('page-0');
        final.add('final-0');
        throw new Error('promote-page-1');
      },
      persist: async () => {
        dbCalled = true;
      },
      isPersisted: async () => false,
      rollbackAssets: async () => {
        staged.clear();
        final.clear();
      },
    }),
    /promote-page-1/
  );

  assert.equal(dbCalled, false);
  assert.equal(staged.size, 0);
  assert.equal(final.size, 0);
});

test('DB fallisce prima del commit: rollback degli asset promossi', async () => {
  const final = new Set(['new-final']);
  let reconciled = false;

  await assert.rejects(
    runAssetSaveSaga({
      stage: async () => undefined,
      promote: async () => undefined,
      persist: async () => {
        throw new Error('db-before-commit');
      },
      isPersisted: async () => reconciled,
      rollbackAssets: async () => {
        final.clear();
      },
    }),
    /db-before-commit/
  );
  assert.equal(final.size, 0);
});

test('commit-then-throw: riconcilia il payload DB e conserva gli asset vivi', async () => {
  const final = new Set(['new-final']);
  let dbCommitted = false;
  let rollbackCalled = false;

  await runAssetSaveSaga({
    stage: async () => undefined,
    promote: async () => undefined,
    persist: async () => {
      dbCommitted = true;
      throw new Error('ambiguous-commit');
    },
    isPersisted: async () => dbCommitted,
    rollbackAssets: async () => {
      rollbackCalled = true;
      final.clear();
    },
  });

  assert.equal(rollbackCalled, false);
  assert.deepEqual([...final], ['new-final']);
});

test('riconciliazione DB incerta: non cancella alla cieca i finali', async () => {
  const final = new Set(['possibly-live']);
  await assert.rejects(
    runAssetSaveSaga({
      stage: async () => undefined,
      promote: async () => undefined,
      persist: async () => {
        throw new Error('commit-status-unknown');
      },
      isPersisted: async () => {
        throw new Error('db-read-failed');
      },
      rollbackAssets: async () => {
        final.clear();
      },
    }),
    /commit-status-unknown/
  );
  assert.deepEqual([...final], ['possibly-live']);
});

test('collisione staging: lo staging preesistente non appartiene alla saga e resta intatto', async () => {
  const preexisting = new Set(['collision/page-0.jpg']);
  let ownedToken = false;

  await assert.rejects(
    runAssetSaveSaga({
      stage: async () => {
        if (preexisting.size > 0) throw new Error('collision');
        ownedToken = true;
      },
      promote: async () => undefined,
      persist: async () => undefined,
      isPersisted: async () => false,
      rollbackAssets: async () => {
        if (ownedToken) preexisting.clear();
      },
    }),
    /collision/
  );
  assert.deepEqual([...preexisting], ['collision/page-0.jpg']);
});

test('collisione sul finale N: rollback elimina solo i file promossi dalla saga', async () => {
  const preexisting = new Set(['final-1-existing']);
  const owned = new Set<string>();
  await assert.rejects(
    runAssetSaveSaga({
      stage: async () => undefined,
      promote: async () => {
        owned.add('final-0-new');
        if (preexisting.has('final-1-existing')) throw new Error('final-collision');
      },
      persist: async () => undefined,
      isPersisted: async () => false,
      rollbackAssets: async () => {
        owned.clear();
      },
    }),
    /final-collision/
  );
  assert.equal(owned.size, 0);
  assert.deepEqual([...preexisting], ['final-1-existing']);
});

test('delete riuscita: sposta, committa, finalizza in ordine', async () => {
  const calls: string[] = [];
  const result = await runAssetDeleteSaga({
    stageAssets: async () => {
      calls.push('trash');
    },
    deleteRecord: async () => {
      calls.push('db-delete');
    },
    isDeleted: async () => true,
    restoreAssets: async () => {
      calls.push('restore');
    },
    finalizeAssets: async () => {
      calls.push('cleanup');
    },
  });
  assert.deepEqual(calls, ['trash', 'db-delete', 'cleanup']);
  assert.deepEqual(result, { cleanupPending: false });
});

test('delete DB fallita: ripristina immagini e rilancia', async () => {
  let inTrash = false;
  await assert.rejects(
    runAssetDeleteSaga({
      stageAssets: async () => {
        inTrash = true;
      },
      deleteRecord: async () => {
        throw new Error('delete-db-failed');
      },
      isDeleted: async () => false,
      restoreAssets: async () => {
        inTrash = false;
      },
      finalizeAssets: async () => {
        inTrash = false;
      },
    }),
    /delete-db-failed/
  );
  assert.equal(inTrash, false);
});

test('move-to-trash ack-then-throw: lo stage fallito viene compensato prima del DB', async () => {
  let inTrash = false;
  let dbCalled = false;
  await assert.rejects(
    runAssetDeleteSaga({
      stageAssets: async () => {
        inTrash = true;
        throw new Error('move-ack-then-throw');
      },
      deleteRecord: async () => {
        dbCalled = true;
      },
      isDeleted: async () => false,
      restoreAssets: async () => {
        inTrash = false;
      },
      finalizeAssets: async () => undefined,
    }),
    /move-ack-then-throw/
  );
  assert.equal(inTrash, false);
  assert.equal(dbCalled, false);
});

test('delete commit-then-throw e cleanup fallito: record eliminato, recovery pendente', async () => {
  let deleted = false;
  let restored = false;
  const result = await runAssetDeleteSaga({
    stageAssets: async () => undefined,
    deleteRecord: async () => {
      deleted = true;
      throw new Error('ambiguous-delete');
    },
    isDeleted: async () => deleted,
    restoreAssets: async () => {
      restored = true;
    },
    finalizeAssets: async () => {
      throw new Error('filesystem-busy');
    },
  });
  assert.equal(restored, false);
  assert.deepEqual(result, { cleanupPending: true });
});

test('mutex: recovery/operazioni non si sovrappongono', async () => {
  const mutex = createAsyncMutex();
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = mutex.runExclusive(async () => {
    calls.push('recovery-start');
    await firstGate;
    calls.push('recovery-end');
  });
  const second = mutex.runExclusive(async () => {
    calls.push('save-start');
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['recovery-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['recovery-start', 'recovery-end', 'save-start']);
});

test('mutex: un task fallito rilascia sempre il successivo', async () => {
  const mutex = createAsyncMutex();
  const calls: string[] = [];
  const first = mutex.runExclusive(async () => {
    calls.push('first');
    throw new Error('expected');
  });
  const second = mutex.runExclusive(async () => {
    calls.push('second');
  });
  await assert.rejects(first, /expected/);
  await second;
  assert.deepEqual(calls, ['first', 'second']);
});

test('token asset/delete forgiati, inclusi token vuoti, sono rifiutati', () => {
  const validToken = {
    recordId: RECORD_ID,
    operationId: OPERATION_ID,
    stagingDirectoryUri: `${ROOT}.staging/${OPERATION_ID}/`,
    finalDirectoryUri: `${ROOT}${RECORD_ID}/`,
    assets: [
      {
        kind: 'page' as const,
        pageIndex: 0,
        stagedUri: `${ROOT}.staging/${OPERATION_ID}/page-0.jpg`,
        finalUri: `${ROOT}${RECORD_ID}/page-0-${OPERATION_ID}.jpg`,
      },
    ],
  };
  assert.doesNotThrow(() => assertAssetTokenPaths(ROOT, validToken));
  assert.throws(
    () =>
      assertAssetTokenPaths(ROOT, {
        ...validToken,
        assets: [],
        stagingDirectoryUri: 'file:///outside/',
      }),
    /Directory/
  );
  assert.throws(
    () =>
      assertAssetTokenPaths(ROOT, {
        ...validToken,
        assets: [{ ...validToken.assets[0]!, finalUri: 'file:///outside/victim.jpg' }],
      }),
    /Percorso/
  );
  assert.throws(
    () =>
      assertDeletionTokenPaths(ROOT, {
        recordId: RECORD_ID,
        operationId: OPERATION_ID,
        originalDirectoryUri: `${ROOT}${RECORD_ID}/`,
        trashedDirectoryUri: 'file:///outside/',
      }),
    /Percorso/
  );
  for (const forgedId of [
    '../victim',
    '%2e%2e',
    `${RECORD_ID}/child`,
    `${RECORD_ID}\\child`,
  ]) {
    assert.throws(
      () => assertAssetTokenPaths(ROOT, { ...validToken, recordId: forgedId }),
      /ID/
    );
  }
  assert.throws(
    () =>
      assertAssetTokenPaths(ROOT, {
        ...validToken,
        assets: [validToken.assets[0]!, validToken.assets[0]!],
      }),
    /duplicato/
  );
});

test('shared cross-tabella/same-ID: la directory deve essere preservata', () => {
  const directory = `${ROOT}${RECORD_ID}/`;
  const records = [
    {
      owner: 'contact' as const,
      id: RECORD_ID,
      images: [`${directory}page-0.jpg`],
    },
    {
      owner: 'document' as const,
      id: OTHER_ID,
      images: [`${directory}page-0.jpg`],
    },
  ];
  assert.equal(otherOwnerUsesDirectory(records, 'contact', RECORD_ID, directory), true);
  assert.equal(
    otherOwnerUsesDirectory(
      [
        { owner: 'contact', id: RECORD_ID, images: [] },
        {
          owner: 'document',
          id: OTHER_ID,
          images: [`file:///old-ios-container/scans/${RECORD_ID}/page-0.jpg`],
        },
      ],
      'contact',
      RECORD_ID,
      directory
    ),
    true
  );
  assert.equal(
    otherOwnerUsesDirectory(
      [{ owner: 'document', id: RECORD_ID, images: [] }],
      'contact',
      RECORD_ID,
      directory
    ),
    true
  );
  assert.equal(
    otherOwnerUsesDirectory(
      [{ owner: 'contact', id: RECORD_ID, images: [`${directory}page-0.jpg`] }],
      'contact',
      RECORD_ID,
      directory
    ),
    false
  );
});

test('delete contatto esplicita: co-elimina solo il twin legacy dello stesso ID', () => {
  const LEGACY_ONLY_ID = '44444444-4444-4444-8444-444444444444';
  const owners = [
    { owner: 'contact' as const, id: RECORD_ID, images: [] },
    {
      owner: 'document' as const,
      id: RECORD_ID,
      recordType: 'business_card',
      images: [],
    },
    {
      owner: 'document' as const,
      id: RECORD_ID,
      recordType: 'quote',
      images: [],
    },
    {
      owner: 'document' as const,
      id: LEGACY_ONLY_ID,
      recordType: 'business_card',
      images: [],
    },
  ];
  const remaining = ownersOutsideConfirmedContactDeletion(
    owners,
    new Set([RECORD_ID])
  );
  assert.deepEqual(
    remaining.map((record) => `${record.owner}:${record.recordType ?? 'contact'}:${record.id}`),
    [
      `document:quote:${RECORD_ID}`,
      `document:business_card:${LEGACY_ONLY_ID}`,
    ]
  );
});

test('recovery live-dir: elimina solo managed non referenziati, inclusi legacy', () => {
  const directory = `${ROOT}${RECORD_ID}/`;
  const versioned = `page-0-${OPERATION_ID}.jpg`;
  const liveLegacy = 'page-1.jpg';
  const orphanLegacyPhoto = 'contact-photo.jpg';
  const unrelated = 'README.txt';
  const references = new Set([`${directory}${liveLegacy}`]);

  const cleanup = selectUnreferencedManagedAssetUris(
    directory,
    [versioned, liveLegacy, orphanLegacyPhoto, unrelated],
    references
  );
  assert.deepEqual(cleanup.sort(), [
    `${directory}${orphanLegacyPhoto}`,
    `${directory}${versioned}`,
  ].sort());
  assert.equal(cleanup.includes(`${directory}${unrelated}`), false);
  const malformedUuidNames = [
    `page-0-${'-'.repeat(36)}.jpg`,
    `contact-photo-${'-'.repeat(36)}.jpg`,
  ];
  assert.deepEqual(
    selectUnreferencedManagedAssetUris(
      directory,
      malformedUuidNames,
      new Set<string>()
    ),
    []
  );
});

test('delete su directory condivisa: seleziona solo asset target non piu referenziati', () => {
  const directory = `${ROOT}${RECORD_ID}/`;
  const shared = `${directory}page-0.jpg`;
  const targetOnly = `${directory}page-1.jpg`;
  const cleanup = selectUnreferencedManagedAssetUris(
    directory,
    ['page-0.jpg', 'page-1.jpg', 'unrelated.txt'],
    new Set([shared])
  );
  assert.deepEqual(cleanup, [targetOnly]);
});

test('recovery live-dir fail-closed: owner vuoto, temp o stale non autorizza lo sweep', () => {
  const directory = `${ROOT}${RECORD_ID}/`;
  assert.equal(
    ownerReferencesAllowPerFileSweep(
      [{ id: RECORD_ID, images: [] }],
      RECORD_ID,
      directory
    ),
    false
  );
  assert.equal(
    ownerReferencesAllowPerFileSweep(
      [{ id: RECORD_ID, images: ['content://camera/cache'] }],
      RECORD_ID,
      directory
    ),
    false
  );
  assert.equal(
    ownerReferencesAllowPerFileSweep(
      [{ id: RECORD_ID, images: [`file:///old/scans/${RECORD_ID}/not-managed.bin`] }],
      RECORD_ID,
      directory
    ),
    false
  );
  assert.equal(
    ownerReferencesAllowPerFileSweep(
      [{ id: RECORD_ID, images: [`file:///old/scans/${RECORD_ID}/page-0.jpg`] }],
      RECORD_ID,
      directory
    ),
    true
  );
});

test('recovery orfani: nessuna cancellazione di directory non UUID o ancora condivisa', () => {
  const referencedDirectory = `${ROOT}${OTHER_ID}/`;
  const selected = selectOrphanRecordDirectoryUris(
    ROOT,
    [RECORD_ID, OTHER_ID, ORPHAN_ID, 'dataset-backup', '.trash'],
    new Set([RECORD_ID]),
    new Set([`${referencedDirectory}page-0.jpg`])
  );
  assert.deepEqual(selected, [`${ROOT}${ORPHAN_ID}/`]);

  const retry = selectOrphanRecordDirectoryUris(
    ROOT,
    [ORPHAN_ID],
    new Set<string>(),
    new Set<string>()
  );
  assert.deepEqual(retry, [`${ROOT}${ORPHAN_ID}/`]);
});

test('crash dopo promote prima del DB: recovery seleziona il finale orfano', () => {
  const promotedDirectory = `${ROOT}${ORPHAN_ID}/`;
  const selected = selectOrphanRecordDirectoryUris(
    ROOT,
    [ORPHAN_ID],
    new Set<string>(),
    // La cache sorgente puo essere gia sparita: non e un riferimento DB vivo.
    new Set<string>()
  );
  assert.deepEqual(selected, [promotedDirectory]);
});

test('clear-all batch: errore di staging a meta ripristina in ordine inverso', async () => {
  const moved: string[] = [];
  const restored: string[] = [];
  let dbCalled = false;
  await assert.rejects(
    runAssetBatchDeleteSaga({
      items: ['one', 'two', 'three'],
      stageItem: async (item) => {
        if (item === 'three') throw new Error('stage-three');
        moved.push(item);
        return item;
      },
      deleteRecords: async () => {
        dbCalled = true;
      },
      areDeleted: async () => false,
      restoreItem: async (token) => {
        restored.push(token);
      },
      finalizeItem: async () => undefined,
    }),
    /stage-three/
  );
  assert.equal(dbCalled, false);
  assert.deepEqual(moved, ['one', 'two']);
  assert.deepEqual(restored, ['two', 'one']);
});

test('clear-all batch: commit ambiguo riconciliato finalizza senza restore', async () => {
  const restored: string[] = [];
  const finalized: string[] = [];
  const result = await runAssetBatchDeleteSaga({
    items: ['one', 'two'],
    stageItem: async (item) => item,
    deleteRecords: async () => {
      throw new Error('commit-then-throw');
    },
    areDeleted: async () => true,
    restoreItem: async (token) => {
      restored.push(token);
    },
    finalizeItem: async (token) => {
      finalized.push(token);
    },
  });
  assert.deepEqual(restored, []);
  assert.deepEqual(finalized, ['one', 'two']);
  assert.deepEqual(result, { cleanupPending: false });
});

test('clear-all batch: DB rollback + restore fallito espone errore composto', async () => {
  await assert.rejects(
    runAssetBatchDeleteSaga({
      items: ['one'],
      stageItem: async (item) => item,
      deleteRecords: async () => {
        throw new Error('db-rollback');
      },
      areDeleted: async () => false,
      restoreItem: async () => {
        throw new Error('restore-failed');
      },
      finalizeItem: async () => undefined,
    }),
    /rollback batch fallito/
  );
});

test('rotazione: OCR o DB fallito conserva la versione precedente', async () => {
  for (const failure of ['ocr', 'db'] as const) {
    const files = new Set(['old-page']);
    let dbImage = 'old-page';
    await assert.rejects(
      runAssetSaveSaga({
        stage: async () => {
          if (failure === 'ocr') throw new Error('ocr-failed');
        },
        promote: async () => {
          files.add('new-page');
        },
        persist: async () => {
          if (failure === 'db') throw new Error('db-failed');
          dbImage = 'new-page';
        },
        isPersisted: async () => false,
        rollbackAssets: async () => {
          files.delete('new-page');
        },
      }),
      new RegExp(`${failure}-failed`)
    );
    assert.equal(dbImage, 'old-page');
    assert.deepEqual([...files], ['old-page']);
  }
});

test('rotazione: una revisione stale viene rifiutata prima di toccare asset', () => {
  assert.throws(
    () =>
      assertFreshAssetRevision(
        { updatedAt: '2026-01-02T00:00:00.000Z', images: ['page-new'] },
        { updatedAt: '2026-01-01T00:00:00.000Z', images: ['page-old'] }
      ),
    /Revisione/
  );
  assert.doesNotThrow(() =>
    assertFreshAssetRevision(
      { updatedAt: '2026-01-02T00:00:00.000Z', images: ['page-new'] },
      { updatedAt: '2026-01-02T00:00:00.000Z', images: ['page-new'] }
    )
  );
});

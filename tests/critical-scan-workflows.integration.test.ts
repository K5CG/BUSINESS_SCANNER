import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AnyDocument,
  BusinessCard,
  QuoteDocument,
} from '../types';
import type { GeminiDocumentExtract } from '../lib/gemini-ocr';
import type { LocalOcrScanResult } from '../lib/local-ocr-pages';
import {
  processCapturedScan,
  type ScanProcessOperation,
  type ScanProcessOutcome,
  type ScanProcessPorts,
} from '../lib/scan-process-workflow';
import {
  createLatestOperationController,
  type OperationLease,
} from '../lib/guarded-operation';
import { createExclusiveOperationGate } from '../lib/exclusive-operation-gate';
import {
  isInactiveScanOperationError,
} from '../lib/scan-operation-lifecycle';
import { runDocumentAiReview } from '../lib/document-ai-review';
import { buildDocumentFromExtract } from '../lib/document-from-extract';
import { parseSparseDocumentPageFields } from '../lib/document-parser';
import {
  PAGE_WARNING_CLOUD_FALLBACK,
  pageResultFromCloudExtract,
} from '../lib/document-page-extraction';
import { mergeDocumentPageFields } from '../lib/document-field-merge';
import { applyDocumentFieldMerge } from '../lib/document-field-merge-application';
import {
  applyContactReparseProposal,
  applyManualContactEdits,
  createContactReparseProposal,
  initializeParsedContactReviewState,
  prepareBusinessCardForPersistence,
} from '../lib/contact-review-state';
import {
  getSafeContactEmails,
  sanitizeBusinessCardEmailState,
  type EmailEvidenceMetadata,
} from '../lib/email-evidence';
import { buildCardTitle } from '../lib/card-title';
import { buildOcrQualityViewModel } from '../lib/ocr-quality-view-model';
import {
  createWorkflowEffects,
  deferred,
  MemoryPersistenceAdapter,
  ocrLines,
  persistCreatedRecord,
  testCard,
  testQuote,
  type WorkflowEffects,
} from './helpers/critical-workflow-harness';

const PRIMARY_CARD_LINES = [
  'ALPHA ISOLATION S.R.L.',
  'Mario Rossi',
  'Direttore Commerciale',
  'mario.rossi@alpha-isolation.it',
  'www.alpha-isolation.it',
  'P.IVA 12345678901',
  'Tel: +39 02 1234 5678',
  'Via Roma 10',
  '20100 Milano (MI)',
];

const FOREIGN_CARD_LINES = [
  'OMEGA SENTINEL S.R.L.',
  'Giulia Bianchi',
  'Chief Executive Officer',
  'giulia.bianchi@omega-sentinel.com',
  'www.omega-sentinel.com',
];

function cloudExtract(
  rawText: string,
  overrides: Partial<GeminiDocumentExtract> = {}
): GeminiDocumentExtract {
  return {
    rawText,
    ...overrides,
  };
}

function scanResult(lines: readonly string[]): LocalOcrScanResult {
  return {
    lines: ocrLines(lines),
    text: lines.join('\n'),
  };
}

function operationFromLease(
  lease: OperationLease
): ScanProcessOperation {
  return {
    operationId: lease.operationId,
    isActiveBeforeClaim: lease.isActive,
    isClaimCurrent: lease.isCurrent,
    tryFinalize: lease.tryFinalize,
  };
}

interface WorkflowPortOptions {
  adapter: MemoryPersistenceAdapter;
  effects: WorkflowEffects;
  scanPage: ScanProcessPorts['scanPage'];
  ensureReady?: () => Promise<void>;
  publishBusinessCard?: (card: BusinessCard) => boolean;
}

function workflowPorts(
  options: WorkflowPortOptions
): ScanProcessPorts {
  const { adapter, effects } = options;
  return {
    ensureReady: async () => {
      adapter.events.push('db:ready');
      await options.ensureReady?.();
    },
    scanPage: async (imageUri) => {
      adapter.events.push(`ocr:${imageUri}`);
      return options.scanPage(imageUri);
    },
    publishBusinessCard: (card) => {
      if (
        options.publishBusinessCard &&
        !options.publishBusinessCard(card)
      ) {
        return false;
      }
      adapter.events.push('store:draft');
      effects.published.set(card.id, card);
      return true;
    },
    persistDocument: async (document, guard) => {
      await persistCreatedRecord(adapter, effects, document, guard);
    },
    notifyWarning: (warning, documentType) => {
      effects.warnings.push(`${warning}:${documentType}`);
    },
    navigate: (targetId) => {
      adapter.events.push('navigate');
      effects.navigations.push(targetId);
    },
    yieldBeforeClaim: async () => undefined,
  };
}

function completedDocument(
  outcome: ScanProcessOutcome
): AnyDocument {
  if (outcome.status !== 'completed') {
    assert.fail(outcome.status === 'inactive' ? `Workflow inattivo: ${outcome.checkpoint}` : 'Workflow OCR insufficiente');
  }
  return outcome.document;
}

function requireQuote(document: AnyDocument): QuoteDocument {
  if (document.type !== 'quote') {
    assert.fail(`Atteso quote, ricevuto ${document.type}`);
  }
  return document;
}

function requireCard(document: AnyDocument): BusinessCard {
  if (document.type !== 'business_card') {
    assert.fail(`Atteso business_card, ricevuto ${document.type}`);
  }
  return document;
}

function onlyPublished(effects: WorkflowEffects): AnyDocument {
  assert.equal(effects.published.size, 1);
  const document = effects.published.values().next().value;
  assert.ok(document);
  return document;
}

async function persistThenNavigate(
  adapter: MemoryPersistenceAdapter,
  effects: WorkflowEffects,
  record: AnyDocument,
  operationId: string
): Promise<AnyDocument> {
  const persisted = await persistCreatedRecord(
    adapter,
    effects,
    record,
    {
      operationId,
      isActive: () => true,
    }
  );
  adapter.events.push('navigate');
  effects.navigations.push(persisted.id);
  return persisted;
}

function assertEventsInOrder(
  events: readonly string[],
  expected: readonly string[]
): void {
  let previousIndex = -1;
  for (const marker of expected) {
    const index = events.indexOf(marker, previousIndex + 1);
    assert.notEqual(index, -1, `Evento mancante: ${marker}`);
    assert.ok(
      index > previousIndex,
      `Ordine non valido per evento: ${marker}`
    );
    previousIndex = index;
  }
}

async function deleteThenRemoveFromStore(
  adapter: MemoryPersistenceAdapter,
  effects: WorkflowEffects,
  recordId: string
): Promise<void> {
  await adapter.delete(recordId);
  adapter.events.push('store:remove');
  effects.published.delete(recordId);
}

test('6B-01 scansione locale singola attraversa parser, draft e navigazione', async () => {
  const imageUri = 'file:///capture/card-front.jpg';
  const adapter = new MemoryPersistenceAdapter();
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-single');
  const lease = controller.begin();
  let ocrCalls = 0;

  const outcome = await processCapturedScan({
    documentType: 'business_card',
    imageUris: [imageUri],
    operation: operationFromLease(lease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async (uri) => {
        ocrCalls += 1;
        assert.equal(uri, imageUri);
        return scanResult(PRIMARY_CARD_LINES);
      },
    }),
  });

  const card = requireCard(completedDocument(outcome));
  assert.equal(ocrCalls, 1);
  assert.equal(adapter.records.size, 0);
  assert.equal(effects.published.get(card.id), card);
  assert.deepEqual(card.images, [imageUri]);
  assert.equal(
    card.title,
    buildCardTitle(card.company, card.firstName, card.lastName)
  );
  assert.match(card.title, /Mario Rossi/i);
  assert.deepEqual(effects.navigations, [card.id]);
  controller.finish(lease);
});

test('6B-02 scansione locale multipagina attraversa merge, asset, DB e store', async () => {
  const images = [
    'file:///capture/quote-front.jpg',
    'file:///capture/quote-total.jpg',
  ];
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources(images);
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-multipage');
  const lease = controller.begin();
  const seen: string[] = [];
  const pageLines = new Map<string, readonly string[]>([
    [
      images[0],
      [
        'Preventivo Q-204',
        'Cliente: Delta S.R.L.',
        'Data: 24/07/2026',
      ],
    ],
    [
      images[1],
      [
        'Servizio consulenza tecnica',
        'Totale EUR 122,00',
      ],
    ],
  ]);

  const outcome = await processCapturedScan({
    documentType: 'quote',
    imageUris: images,
    operation: operationFromLease(lease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async (uri) => {
        seen.push(uri);
        const lines = pageLines.get(uri);
        assert.ok(lines);
        return scanResult(lines);
      },
    }),
  });

  const quote = requireQuote(completedDocument(outcome));
  const stored = adapter.records.get(quote.id);
  assert.ok(stored);
  assert.deepEqual(seen, images);
  assert.equal(quote.pageExtractions?.length, 2);
  assert.deepEqual(
    quote.pageExtractions?.map((page) => page.processingMethod),
    ['local', 'local']
  );
  assert.match(quote.rawText, /Preventivo Q-204/);
  assert.match(quote.rawText, /Totale EUR 122,00/);
  assert.equal(effects.published.get(quote.id)?.id, quote.id);
  assert.deepEqual(
    stored.pageExtractions?.map((page) => page.imageUri),
    stored.images
  );
  assert.equal(effects.navigations.at(-1), quote.id);
  assertEventsInOrder(adapter.events, ['store:publish', 'navigate']);
  controller.finish(lease);
});

test('6B-02b OCR e UI usano il frame mentre il record conserva anche lo scatto originale', async () => {
  const frameImages = ['file:///capture/quote-frame-aligned.jpg'];
  const originalImages = ['file:///capture/quote-original-full.jpg'];
  const ocrImages = [...frameImages];
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources([...frameImages, ...originalImages]);
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-full-source');
  const lease = controller.begin();
  const seen: string[] = [];

  const outcome = await processCapturedScan({
    documentType: 'quote',
    imageUris: frameImages,
    ocrImageUris: ocrImages,
    originalImageUris: originalImages,
    operation: operationFromLease(lease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async (uri) => {
        seen.push(uri);
        return scanResult(['Preventivo Q-FULL', 'Totale EUR 100,00']);
      },
    }),
  });

  const quote = requireQuote(completedDocument(outcome));
  assert.deepEqual(seen, ocrImages);
  assert.deepEqual(quote.images, frameImages);
  assert.deepEqual(quote.originalImages, originalImages);
  assert.deepEqual(quote.pageExtractions?.map((page) => page.imageUri), frameImages);
  assert.ok(adapter.records.has(quote.id));
  controller.finish(lease);
});

test('6B-03 consenso cloud negato non avvia cloud, fallback o parser', async () => {
  const current = testQuote();
  let cloudCalls = 0;
  let localCalls = 0;
  let structureCalls = 0;
  let builderCalls = 0;
  const outcome = await runDocumentAiReview(
    'cancel',
    current,
    async () => {
      cloudCalls += 1;
      return { status: 'error', message: 'chiamata inattesa' };
    },
    (documentType, extract, options) => {
      builderCalls += 1;
      return buildDocumentFromExtract(documentType, extract, options);
    },
    async () => {
      localCalls += 1;
      return scanResult(['fallback inatteso']);
    },
    (documentType, lines, rawText) => {
      structureCalls += 1;
      return parseSparseDocumentPageFields(
        documentType,
        lines,
        rawText
      );
    }
  );

  assert.equal(outcome.status, 'cancelled');
  assert.strictEqual(outcome.document, current);
  assert.deepEqual(
    { cloudCalls, localCalls, structureCalls, builderCalls },
    { cloudCalls: 0, localCalls: 0, structureCalls: 0, builderCalls: 0 }
  );
});

test('6B-04 cloud fallito usa fallback locale e merge misto senza rete reale', async () => {
  const images = [
    'file:///review/mixed-header.jpg',
    'file:///review/mixed-total.jpg',
  ];
  const current = testQuote({ images, total: undefined });
  const cloudCalls: string[] = [];
  const localCalls: string[] = [];

  const outcome = await runDocumentAiReview(
    'confirm',
    current,
    async (uri) => {
      cloudCalls.push(uri);
      return uri === images[0]
        ? {
            status: 'ok',
            extract: cloudExtract(
              'Preventivo Q-MIX\nCliente ALPHA S.R.L.',
              {
                documentNumber: 'Q-MIX',
                customerName: 'ALPHA S.R.L.',
              }
            ),
          }
        : { status: 'error', message: 'cloud controllato non disponibile' };
    },
    buildDocumentFromExtract,
    async (uri) => {
      localCalls.push(uri);
      return scanResult([
        'Riepilogo preventivo Q-MIX',
        'Totale EUR 122,00',
      ]);
    },
    parseSparseDocumentPageFields,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'ok');
  const quote = requireQuote(outcome.document);
  assert.deepEqual(cloudCalls, images);
  assert.deepEqual(localCalls, [images[1]]);
  assert.deepEqual(
    quote.pageExtractions?.map((page) => page.processingMethod),
    ['cloud', 'local_fallback']
  );
  const fallback = quote.pageExtractions?.[1];
  assert.ok(fallback);
  assert.ok(fallback.warnings.includes(PAGE_WARNING_CLOUD_FALLBACK));
  assert.match(fallback.error ?? '', /cloud controllato/i);
  assert.equal(fallback.structuredFields.total, 122);
  assert.equal(quote.total, 122);
});

test('6B-05 consenso cloud applica il totale dell’ultima pagina e lo persiste', async () => {
  const images = [
    'file:///review/cloud-header.jpg',
    'file:///review/cloud-total.jpg',
  ];
  const current = testQuote({
    images,
    quoteNumber: undefined,
    total: undefined,
  });
  const cloudCalls: string[] = [];
  let localCalls = 0;

  const outcome = await runDocumentAiReview(
    'confirm',
    current,
    async (uri) => {
      cloudCalls.push(uri);
      return uri === images[0]
        ? {
            status: 'ok',
            extract: cloudExtract(
              'Preventivo Q-77\nCliente ACME S.R.L.',
              {
                documentNumber: 'Q-77',
                customerName: 'ACME S.R.L.',
              }
            ),
          }
        : {
            status: 'ok',
            extract: cloudExtract('TOTALE EUR 122,00', {
              total: 122,
            }),
          };
    },
    buildDocumentFromExtract,
    async () => {
      localCalls += 1;
      return scanResult(['fallback inatteso']);
    },
    parseSparseDocumentPageFields,
    { testOnlyBypassRcCloudAi: true }
  );

  assert.equal(outcome.status, 'ok');
  const reviewed = requireQuote(outcome.document);
  assert.deepEqual(cloudCalls, images);
  assert.equal(localCalls, 0);
  assert.deepEqual(
    reviewed.pageExtractions?.map((page) => page.processingMethod),
    ['cloud', 'cloud']
  );
  assert.equal(reviewed.total, 122);
  assert.equal(reviewed.fieldMerge?.fields.total?.sourcePageIndex, 1);

  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources(images);
  const effects = createWorkflowEffects();
  await persistThenNavigate(
    adapter,
    effects,
    reviewed,
    '6b-cloud-confirm'
  );
  const stored = adapter.records.get(current.id);
  assert.ok(stored);
  assert.equal(requireQuote(stored).total, 122);
  assert.deepEqual(effects.navigations, [current.id]);
});

test('6B-06 pagina estranea è esclusa dal draft e non contamina i campi', async () => {
  const images = [
    'file:///capture/alpha-card.jpg',
    'file:///capture/omega-card.jpg',
  ];
  const adapter = new MemoryPersistenceAdapter();
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-mismatch');
  const lease = controller.begin();

  const outcome = await processCapturedScan({
    documentType: 'business_card',
    imageUris: images,
    operation: operationFromLease(lease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async (uri) =>
        scanResult(
          uri === images[0] ? PRIMARY_CARD_LINES : FOREIGN_CARD_LINES
        ),
    }),
  });

  const card = requireCard(completedDocument(outcome));
  assert.equal(
    card.extractionReview?.pageCoherence?.decision,
    'mismatch'
  );
  assert.deepEqual(
    card.extractionReview?.pageCoherence?.includedPageIndexes,
    [0]
  );
  assert.deepEqual(
    card.extractionReview?.pageCoherence?.excludedPageIndexes,
    [1]
  );
  const semanticRecord = JSON.stringify({
    title: card.title,
    firstName: card.firstName,
    lastName: card.lastName,
    company: card.company,
    role: card.role,
    emails: card.emails,
    phones: card.phones,
    website: card.website,
    rawText: card.rawText,
  });
  assert.doesNotMatch(
    semanticRecord,
    /omega sentinel|giulia|bianchi|chief executive|omega-sentinel/i
  );
  assert.equal(effects.published.size, 1);
  assert.deepEqual(effects.navigations, [card.id]);
  controller.finish(lease);
});

test('6B-07 salvataggio riuscito ordina copia, promozione, DB, store e navigazione', async () => {
  const imageUri = 'file:///capture/quote-save.jpg';
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources([imageUri]);
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-save');
  const lease = controller.begin();

  const outcome = await processCapturedScan({
    documentType: 'quote',
    imageUris: [imageUri],
    operation: operationFromLease(lease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async () =>
        scanResult([
          'Preventivo Q-SAVE',
          'Cliente: ACME S.R.L.',
          'Totale EUR 100,00',
        ]),
    }),
  });

  const quote = requireQuote(completedDocument(outcome));
  const stored = adapter.records.get(quote.id);
  const published = effects.published.get(quote.id);
  assert.ok(stored);
  assert.ok(published);
  assert.equal(stored.persistenceRevision, lease.operationId);
  assert.equal(published.persistenceRevision, lease.operationId);
  assert.equal(adapter.staging.size, 0);
  assert.equal(adapter.finals.size, 1);
  assert.match(stored.images[0], /^file:\/\/\/permanent\//);
  assert.deepEqual(
    stored.pageExtractions?.map((page) => page.imageUri),
    stored.images
  );
  assertEventsInOrder(adapter.events, [
    `copy:${imageUri}`,
    'promote',
    'db:insert',
    'store:publish',
    'navigate',
  ]);
  controller.finish(lease);
});

test('6B-08 copia fallita annulla tutto e un retry successivo riesce', async () => {
  const images = [
    'file:///capture/retry-1.jpg',
    'file:///capture/retry-2.jpg',
  ];
  const record = testQuote({ images });
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources(images);
  adapter.failCopyAt = 2;
  const effects = createWorkflowEffects();

  await assert.rejects(
    persistThenNavigate(adapter, effects, record, '6b-copy-fail'),
    /COPY_FAILED:2/
  );
  assert.equal(adapter.staging.size, 0);
  assert.equal(adapter.finals.size, 0);
  assert.equal(adapter.records.size, 0);
  assert.equal(effects.published.size, 0);
  assert.deepEqual(effects.navigations, []);
  assert.ok(adapter.events.includes('rollback:assets'));

  adapter.failCopyAt = undefined;
  const persisted = await persistThenNavigate(
    adapter,
    effects,
    record,
    '6b-copy-retry'
  );
  assert.equal(adapter.records.size, 1);
  assert.equal(effects.published.size, 1);
  assert.deepEqual(effects.navigations, [record.id]);
  assert.equal(persisted.persistenceRevision, '6b-copy-retry');
});

test('6B-09 errore DB dopo la copia esegue rollback e blocca store e navigazione', async () => {
  const images = ['file:///capture/db-fail.jpg'];
  const record = testQuote({ images });
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources(images);
  adapter.failDatabase = true;
  const effects = createWorkflowEffects();

  await assert.rejects(
    persistThenNavigate(adapter, effects, record, '6b-db-fail'),
    /DB_INSERT_FAILED/
  );
  assert.ok(adapter.events.includes('promote'));
  assert.ok(adapter.events.includes('db:insert'));
  assert.ok(adapter.events.includes('rollback:assets'));
  assert.equal(adapter.staging.size, 0);
  assert.equal(adapter.finals.size, 0);
  assert.equal(adapter.records.size, 0);
  assert.equal(effects.published.size, 0);
  assert.deepEqual(effects.navigations, []);
});

test('6B-10 rollback e compensazione rimuovono solo gli asset della revisione proprietaria', async () => {
  const unrelated = 'file:///permanent/unrelated/keep.jpg';
  const imageUri = 'file:///capture/owned-fail.jpg';
  const record = testQuote({ images: [imageUri] });
  const adapter = new MemoryPersistenceAdapter();
  adapter.sources.add(imageUri);
  adapter.finals.add(unrelated);
  adapter.failDatabase = true;
  const effects = createWorkflowEffects();

  await assert.rejects(
    persistThenNavigate(adapter, effects, record, '6b-owned-fail'),
    /DB_INSERT_FAILED/
  );
  assert.deepEqual([...adapter.finals], [unrelated]);

  const supersededUri =
    'file:///permanent/22222222-2222-4222-8222-222222222222/new/page-1.jpg';
  const superseded = testQuote({
    images: [supersededUri],
    persistenceRevision: 'new-revision',
  });
  adapter.records.set(superseded.id, superseded);
  adapter.finals.add(supersededUri);
  await adapter.compensate({
    ...superseded,
    persistenceRevision: 'old-revision',
  });
  assert.equal(adapter.records.get(superseded.id), superseded);
  assert.ok(adapter.finals.has(supersededUri));

  const legacyUri = 'file:///permanent/legacy/keep.jpg';
  const legacy = testQuote({
    id: 'legacy-record',
    images: [legacyUri],
    persistenceRevision: undefined,
  });
  adapter.records.set(legacy.id, legacy);
  adapter.finals.add(legacyUri);
  await adapter.compensate({
    ...legacy,
    persistenceRevision: 'old-revision',
  });
  assert.equal(adapter.records.get(legacy.id), legacy);
  assert.ok(adapter.finals.has(legacyUri));
});

test('6B-11 cancellazione completa rimuove record, immagini, foto e trash', async () => {
  const imageUri = 'file:///capture/delete-card.jpg';
  const photoUri = 'file:///capture/delete-face.jpg';
  const record = testCard({
    images: [imageUri],
    contactPhotoUri: photoUri,
  });
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources([imageUri, photoUri]);
  const effects = createWorkflowEffects();
  await persistThenNavigate(adapter, effects, record, '6b-delete-save');
  assert.equal(adapter.finals.size, 2);

  await deleteThenRemoveFromStore(adapter, effects, record.id);

  assert.equal(adapter.records.size, 0);
  assert.equal(adapter.finals.size, 0);
  assert.equal(adapter.trash.size, 0);
  assert.equal(effects.published.size, 0);
  assertEventsInOrder(adapter.events, [
    'delete:stage',
    'db:delete',
    'delete:finalize',
    'store:remove',
  ]);
});

test('6B-12 annullamento durante OCR e claim rifiutata non producono effetti', async () => {
  const imageUri = 'file:///capture/cancel-ocr.jpg';
  const adapter = new MemoryPersistenceAdapter();
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-cancel-ocr');
  const lease = controller.begin();
  const started = deferred<void>();
  const pending = deferred<LocalOcrScanResult>();

  const running = processCapturedScan({
    documentType: 'business_card',
    imageUris: [imageUri],
    operation: operationFromLease(lease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async () => {
        started.resolve(undefined);
        return pending.promise;
      },
    }),
  });
  await started.promise;
  controller.invalidateCurrent('screen_blurred');
  pending.resolve(scanResult(PRIMARY_CARD_LINES));
  const outcome = await running;

  assert.equal(outcome.status, 'inactive');
  if (outcome.status === 'inactive') {
    assert.equal(outcome.checkpoint, 'after_ocr');
  }
  assert.equal(adapter.records.size, 0);
  assert.equal(effects.published.size, 0);
  assert.deepEqual(effects.navigations, []);

  const rejectedAdapter = new MemoryPersistenceAdapter();
  const rejectedEffects = createWorkflowEffects();
  const rejected = await processCapturedScan({
    documentType: 'business_card',
    imageUris: ['file:///capture/rejected-claim.jpg'],
    operation: {
      operationId: '6b-rejected-claim',
      isActiveBeforeClaim: () => true,
      isClaimCurrent: () => true,
      tryFinalize: () => false,
    },
    ports: workflowPorts({
      adapter: rejectedAdapter,
      effects: rejectedEffects,
      scanPage: async () => scanResult(PRIMARY_CARD_LINES),
    }),
  });
  assert.deepEqual(rejected, {
    status: 'inactive',
    checkpoint: 'claim_rejected',
  });
  assert.equal(rejectedEffects.published.size, 0);
  assert.deepEqual(rejectedEffects.navigations, []);
});

test('6B-13 annullamento durante persistenza compensa record e file', async () => {
  const imageUri = 'file:///capture/cancel-db.jpg';
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources([imageUri]);
  adapter.databaseStarted = deferred<void>();
  adapter.holdDatabase = deferred<void>();
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-cancel-db');
  const lease = controller.begin();

  const running = processCapturedScan({
    documentType: 'quote',
    imageUris: [imageUri],
    operation: operationFromLease(lease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async () =>
        scanResult(['Preventivo Q-CANCEL', 'Totale EUR 50,00']),
    }),
  });

  await adapter.databaseStarted.promise;
  controller.invalidateCurrent('screen_blurred');
  adapter.holdDatabase.resolve(undefined);
  await assert.rejects(running, (error: unknown) => {
    assert.equal(isInactiveScanOperationError(error), true);
    return true;
  });

  assert.equal(adapter.records.size, 0);
  assert.equal(adapter.staging.size, 0);
  assert.equal(adapter.finals.size, 0);
  assert.equal(effects.published.size, 0);
  assert.deepEqual(effects.navigations, []);
  assert.ok(adapter.events.includes('compensate:record'));
});

test('6B-14 doppio tap sincrono ammette una sola pipeline completa', async () => {
  const imageUri = 'file:///capture/double-tap.jpg';
  const adapter = new MemoryPersistenceAdapter();
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-double');
  const gate = createExclusiveOperationGate(() => '6b-double-gate');
  const started = deferred<void>();
  const pending = deferred<LocalOcrScanResult>();
  let pipelineCalls = 0;

  const enter = (): Promise<boolean> => {
    const gateLease = gate.tryAcquire();
    if (!gateLease) return Promise.resolve(false);
    const operationLease = controller.begin();
    pipelineCalls += 1;
    return processCapturedScan({
      documentType: 'business_card',
      imageUris: [imageUri],
      operation: operationFromLease(operationLease),
      ports: workflowPorts({
        adapter,
        effects,
        scanPage: async () => {
          started.resolve(undefined);
          return pending.promise;
        },
      }),
    })
      .then((outcome) => outcome.status === 'completed')
      .finally(() => {
        controller.finish(operationLease);
        gateLease.release();
      });
  };

  const first = enter();
  const second = await enter();
  assert.equal(second, false);
  await started.promise;
  pending.resolve(scanResult(PRIMARY_CARD_LINES));
  assert.equal(await first, true);
  assert.equal(pipelineCalls, 1);
  assert.equal(effects.published.size, 1);
  assert.equal(effects.navigations.length, 1);
  assert.equal(gate.isLocked(), false);
});

test('6B-15 risultato tardivo della scansione sostituita non sovrascrive quella nuova', async () => {
  const adapter = new MemoryPersistenceAdapter();
  const effects = createWorkflowEffects();
  const controller = createLatestOperationController(() => '6b-late');
  const firstLease = controller.begin();
  const firstStarted = deferred<void>();
  const lateResult = deferred<LocalOcrScanResult>();

  const first = processCapturedScan({
    documentType: 'business_card',
    imageUris: ['file:///capture/late-old.jpg'],
    operation: operationFromLease(firstLease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async () => {
        firstStarted.resolve(undefined);
        return lateResult.promise;
      },
    }),
  });
  await firstStarted.promise;

  const secondLease = controller.begin();
  const second = await processCapturedScan({
    documentType: 'business_card',
    imageUris: ['file:///capture/late-new.jpg'],
    operation: operationFromLease(secondLease),
    ports: workflowPorts({
      adapter,
      effects,
      scanPage: async () => scanResult(PRIMARY_CARD_LINES),
    }),
  });
  assert.equal(second.status, 'completed');

  lateResult.resolve(scanResult(FOREIGN_CARD_LINES));
  const lateOutcome = await first;
  assert.equal(lateOutcome.status, 'inactive');
  assert.equal(effects.published.size, 1);
  assert.equal(effects.navigations.length, 1);
  assert.doesNotMatch(
    JSON.stringify(onlyPublished(effects)),
    /omega|giulia|bianchi/i
  );
  controller.finish(secondLease);
});

test('6B-16 proposta reparse è non distruttiva finché non viene applicata', () => {
  const current = initializeParsedContactReviewState(testCard());
  const before = JSON.stringify(current);
  const adapter = new MemoryPersistenceAdapter();
  const effects = createWorkflowEffects();
  const candidate: BusinessCard = {
    ...current,
    company: 'Beta',
    title: buildCardTitle(
      'Beta',
      current.firstName,
      current.lastName
    ),
  };

  const proposal = createContactReparseProposal(
    current,
    candidate,
    'parser-phase6b'
  );

  assert.equal(JSON.stringify(current), before);
  assert.ok(
    proposal.fields.some((field) => field.field === 'company')
  );
  assert.equal(adapter.records.size, 0);
  assert.equal(effects.published.size, 0);
  assert.deepEqual(effects.navigations, []);
});

test('6B-17 modifica manuale resta protetta nel reparse e nel record persistito', async () => {
  const current = initializeParsedContactReviewState(testCard());
  const edited = applyManualContactEdits(current, {
    firstName: 'Luigi',
    company: 'Beta',
  });
  const candidate: BusinessCard = {
    ...edited,
    firstName: 'Parser',
    company: 'Parser Co',
    role: 'CTO',
    title: buildCardTitle('Parser Co', 'Parser', edited.lastName),
  };
  const proposal = createContactReparseProposal(
    edited,
    candidate,
    'parser-phase6b'
  );
  const applied = applyContactReparseProposal(
    edited,
    proposal,
    ['firstName', 'company', 'role']
  );

  assert.equal(applied.appliedResult.firstName, 'Luigi');
  assert.equal(applied.appliedResult.company, 'Beta');
  assert.equal(applied.appliedResult.role, 'CTO');
  assert.ok(applied.protectedFields.includes('firstName'));
  assert.ok(applied.protectedFields.includes('company'));
  assert.deepEqual(applied.appliedFields, ['role']);
  assert.equal(applied.appliedResult.title, 'Beta - Luigi Rossi');
  assert.equal(
    applied.appliedResult.contactReviewState?.fieldOrigins.firstName,
    'user'
  );

  const ready = prepareBusinessCardForPersistence(
    applied.appliedResult
  );
  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources(ready.images);
  const effects = createWorkflowEffects();
  await persistThenNavigate(
    adapter,
    effects,
    ready,
    '6b-manual-save'
  );
  const stored = adapter.records.get(ready.id);
  assert.ok(stored);
  const storedCard = requireCard(stored);
  assert.equal(storedCard.firstName, 'Luigi');
  assert.equal(storedCard.company, 'Beta');
  assert.equal(storedCard.title, 'Beta - Luigi Rossi');
  assert.equal(
    storedCard.contactReviewState?.fieldOrigins.firstName,
    'user'
  );
});

test('6B-18 email inferred resta evidence ma non viene salvata come email operativa', async () => {
  const inferred: EmailEvidenceMetadata = {
    value: 'guess@example.com',
    rawValue: 'guess@example.com',
    origin: 'inferred',
    pageIndex: 0,
    lineId: 2,
    rawOcr: 'guess@example.com',
    transformations: [],
    confidence: 0.5,
    validationStatus: 'valid',
    requiresReview: true,
    confirmed: false,
  };
  const unsafe = testCard({
    emails: ['guess@example.com'],
    emailEvidence: [inferred],
  });
  const ready = prepareBusinessCardForPersistence(
    sanitizeBusinessCardEmailState(unsafe)
  );
  assert.deepEqual(ready.emails, []);
  assert.deepEqual(getSafeContactEmails(ready), []);

  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources(ready.images);
  const effects = createWorkflowEffects();
  await persistThenNavigate(
    adapter,
    effects,
    ready,
    '6b-email-save'
  );
  const stored = adapter.records.get(ready.id);
  assert.ok(stored);
  const storedCard = requireCard(stored);
  assert.deepEqual(storedCard.emails, []);
  assert.deepEqual(getSafeContactEmails(storedCard), []);
  assert.equal(storedCard.emailEvidence?.[0]?.origin, 'inferred');
  assert.equal(storedCard.emailEvidence?.[0]?.confirmed, false);
});

test('6B-19 data impossibile resta tracciata ma non viene applicata al record', async () => {
  const imageUri = 'file:///capture/invalid-date.jpg';
  const currentDate = new Date('2026-01-31T00:00:00.000Z');
  const current = testQuote({
    images: [imageUri],
    quoteDate: currentDate,
    total: 50,
  });
  const page = pageResultFromCloudExtract(0, imageUri, {
    rawText: 'Data documento: 31/02/2026\nTotale EUR 100,00',
    date: '31/02/2026',
    total: 100,
  });
  const merge = mergeDocumentPageFields([page]);
  const applied = requireQuote(
    applyDocumentFieldMerge(current, merge, {
      mode: 'preserve_existing',
      currentDocument: current,
    })
  );
  const reviewed: QuoteDocument = {
    ...applied,
    pageExtractions: [page],
    ...(page.ocrQuality ? { ocrQuality: page.ocrQuality } : {}),
  };

  assert.equal(page.structuredFields.date, undefined);
  assert.equal(
    page.fieldReliability?.date?.validationStatus,
    'invalid'
  );
  assert.equal(
    reviewed.quoteDate?.toISOString(),
    currentDate.toISOString()
  );
  assert.equal(reviewed.total, 100);

  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources([imageUri]);
  const effects = createWorkflowEffects();
  await persistThenNavigate(
    adapter,
    effects,
    reviewed,
    '6b-invalid-date-save'
  );
  const stored = adapter.records.get(current.id);
  assert.ok(stored);
  assert.equal(
    requireQuote(stored).quoteDate?.toISOString(),
    currentDate.toISOString()
  );
  assert.equal(
    stored.fieldReliability?.date?.validationStatus,
    'unverified'
  );
  assert.equal(
    stored.fieldReliability?.date?.alternatives.some(
      (alternative) => alternative.validationStatus === 'invalid'
    ),
    true
  );
});

test('6B-20 confidence cloud sconosciuta resta non disponibile dopo il round-trip', async () => {
  const imageUri = 'file:///capture/unknown-confidence.jpg';
  const current = testQuote({ images: [imageUri] });
  const page = pageResultFromCloudExtract(0, imageUri, {
    rawText: 'Preventivo Q-UNKNOWN\nTotale EUR 75,00',
    documentNumber: 'Q-UNKNOWN',
    total: 75,
  });
  const merge = mergeDocumentPageFields([page]);
  const applied = requireQuote(
    applyDocumentFieldMerge(current, merge, {
      mode: 'preserve_existing',
      currentDocument: current,
    })
  );
  assert.ok(page.ocrQuality);
  const reviewed: QuoteDocument = {
    ...applied,
    pageExtractions: [page],
    ocrQuality: page.ocrQuality,
  };

  const adapter = new MemoryPersistenceAdapter();
  adapter.seedSources([imageUri]);
  const effects = createWorkflowEffects();
  await persistThenNavigate(
    adapter,
    effects,
    reviewed,
    '6b-unknown-confidence'
  );
  const stored = adapter.records.get(current.id);
  assert.ok(stored?.ocrQuality);
  assert.equal(stored.ocrQuality.confidenceType, 'unknown');
  assert.equal(stored.ocrQuality.measuredConfidence, undefined);
  const view = buildOcrQualityViewModel(stored.ocrQuality, 'it');
  assert.equal(view.confidenceKind, 'unavailable');
  assert.equal(view.confidenceValue, undefined);
  assert.match(view.confidenceLabel, /non disponibile/i);
  if (view.estimatedQualityValue) {
    assert.equal(view.confidenceValue, undefined);
  }
});

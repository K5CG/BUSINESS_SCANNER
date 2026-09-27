import fs from 'node:fs';
import path from 'node:path';
import type { AnyDocument } from '../types';
import {
  parseStructuredDocumentFromOcr,
  type CanonicalParseResult,
} from '../lib/document-canonical-parse';
import { firstDifferingStage, type CanonicalParseSnapshot } from '../lib/document-parse-snapshot';
import { resetDocumentParserCaches } from '../lib/document-parser-caches';
import {
  LATEST_QA_DIR,
  documentNumberOf,
  persistedViewFromDocument,
  type LatestQaFixture,
} from '../lib/qa-latest-fixtures';

export interface FixtureReplayRow {
  id: string;
  title: string;
  firstDifferingStage: string | 'none';
  nodeHash: string;
  androidHash: string | 'n/a';
  sameFinalResult: boolean;
  coldWarmSame: boolean;
  parserVsPersistInputSame: boolean;
  persistInputVsQaReadbackSame: boolean;
  node: {
    customer: string | null;
    items: number;
    subtotal: number | null;
    vat: number | null;
    total: number | null;
    number: string | null;
    discount: number | null;
  };
  qaPersisted: LatestQaFixture['persisted'];
  snapshot: CanonicalParseSnapshot;
}

function commercialView(result: CanonicalParseResult) {
  const persisted = result.persisted;
  return {
    customer: persisted.type === 'business_card' ? null : persisted.customerName ?? null,
    items: persisted.type === 'business_card' ? 0 : persisted.items?.length ?? 0,
    subtotal: persisted.type === 'business_card' ? null : persisted.subtotal ?? null,
    vat: persisted.type === 'business_card' ? null : persisted.vatAmount ?? null,
    total: persisted.type === 'business_card' ? null : persisted.total ?? null,
    number: documentNumberOf(persisted) ?? null,
    discount: result.extraction.summary.discountTotal?.normalizedValue ?? null,
  };
}

function stageHash(snapshot: CanonicalParseSnapshot, stage: string): string {
  return snapshot.stages.find((entry) => entry.stage === stage)?.hash ?? 'missing';
}

export async function replayOneFixture(
  fixture: LatestQaFixture,
  document: AnyDocument,
  deadlineMode: 'production' | 'unlimited' = 'production',
): Promise<CanonicalParseResult> {
  const documentType = fixture.type === 'business_card' ? 'free_document' : fixture.type;
  return parseStructuredDocumentFromOcr({
    documentType: documentType as 'quote' | 'order' | 'invoice' | 'free_document',
    pages: fixture.pages,
    deadlineMode,
  }, {
    persistShell: {
      ...document,
      items: [],
      subtotal: undefined,
      vatAmount: undefined,
      total: undefined,
    } as AnyDocument,
  });
}

export async function replayQaDirNode(qaDir: string): Promise<FixtureReplayRow[]> {
  const fixtureDir = path.join(process.cwd(), qaDir, 'fixtures');
  const outDir = path.join(process.cwd(), qaDir, 'node-snapshots');
  fs.mkdirSync(outDir, { recursive: true });
  const index = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'index.json'), 'utf8')) as {
    documents: Array<{ id: string }>;
  };
  const rows: FixtureReplayRow[] = [];
  for (const entry of index.documents) {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, `${entry.id}.json`), 'utf8'),
    ) as LatestQaFixture;
    const document = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, `${entry.id}.document.json`), 'utf8'),
    ) as AnyDocument;
    resetDocumentParserCaches();
    const cold = await replayOneFixture(fixture, document);
    resetDocumentParserCaches();
    for (const other of index.documents.filter((item) => item.id !== entry.id).slice(0, 3)) {
      const otherFixture = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, `${other.id}.json`), 'utf8'),
      ) as LatestQaFixture;
      const otherDocument = JSON.parse(
        fs.readFileSync(path.join(fixtureDir, `${other.id}.document.json`), 'utf8'),
      ) as AnyDocument;
      await replayOneFixture(otherFixture, otherDocument);
    }
    const warm = await replayOneFixture(fixture, document);
    const coldWarmSame = firstDifferingStage(cold.snapshot, warm.snapshot) === undefined;
    const persistInput = cold.snapshot.stages.find((stage) => stage.stage === 'persistence_input');
    const qaReadback = persistedViewFromDocument(document);
    const persistInputVsQa = JSON.stringify({
      customer: persistInput && persistInput.output && typeof persistInput.output === 'object'
        ? (persistInput.output as { customer?: unknown }).customer
        : null,
      items: persistInput && persistInput.output && typeof persistInput.output === 'object'
        ? (persistInput.output as { items?: unknown }).items
        : null,
      subtotal: persistInput && persistInput.output && typeof persistInput.output === 'object'
        ? (persistInput.output as { subtotal?: unknown }).subtotal
        : null,
      vat: persistInput && persistInput.output && typeof persistInput.output === 'object'
        ? (persistInput.output as { vat?: unknown }).vat
        : null,
      total: persistInput && persistInput.output && typeof persistInput.output === 'object'
        ? (persistInput.output as { total?: unknown }).total
        : null,
    }) === JSON.stringify({
      customer: qaReadback.customer,
      items: qaReadback.items,
      subtotal: qaReadback.subtotal,
      vat: qaReadback.vatAmount,
      total: qaReadback.total,
    });
    const canonicalOut = cold.snapshot.stages.find((stage) => stage.stage === 'canonical_result')?.output as {
      customer?: unknown;
      items?: unknown;
      subtotal?: unknown;
      vat?: unknown;
      total?: unknown;
    } | undefined;
    const persistOut = persistInput?.output as {
      customer?: unknown;
      items?: unknown;
      subtotal?: unknown;
      vat?: unknown;
      total?: unknown;
    } | undefined;
    const parserVsPersist = JSON.stringify({
      customer: canonicalOut?.customer ?? null,
      items: canonicalOut?.items ?? null,
      subtotal: canonicalOut?.subtotal ?? null,
      vat: canonicalOut?.vat ?? null,
      total: canonicalOut?.total ?? null,
    }) === JSON.stringify({
      customer: persistOut?.customer ?? null,
      items: persistOut?.items ?? null,
      subtotal: persistOut?.subtotal ?? null,
      vat: persistOut?.vat ?? null,
      total: persistOut?.total ?? null,
    });
    const row: FixtureReplayRow = {
      id: fixture.id,
      title: fixture.title,
      firstDifferingStage: 'n/a-android-snapshot-missing',
      nodeHash: stageHash(cold.snapshot, 'canonical_result'),
      androidHash: 'n/a',
      sameFinalResult: false,
      coldWarmSame,
      parserVsPersistInputSame: parserVsPersist,
      persistInputVsQaReadbackSame: persistInputVsQa,
      node: commercialView(cold),
      qaPersisted: fixture.persisted,
      snapshot: cold.snapshot,
    };
    fs.writeFileSync(
      path.join(outDir, `${fixture.id}.json`),
      JSON.stringify({
        id: fixture.id,
        title: fixture.title,
        node: row.node,
        qaPersisted: row.qaPersisted,
        snapshot: cold.snapshot,
        warmFirstDiff: firstDifferingStage(cold.snapshot, warm.snapshot) ?? null,
      }, null, 2),
    );
    rows.push(row);
  }
  fs.writeFileSync(
    path.join(process.cwd(), qaDir, 'node-scoreboard.json'),
    JSON.stringify(rows.map(({ snapshot, ...rest }) => rest), null, 2),
  );
  return rows;
}

export async function replayLatestQaNode(): Promise<FixtureReplayRow[]> {
  return replayQaDirNode(LATEST_QA_DIR);
}

async function main() {
  const qaDir = process.argv[2] ?? LATEST_QA_DIR;
  const rows = await replayQaDirNode(qaDir);
  console.table(rows.map((row) => ({
    title: row.title,
    customer: row.node.customer,
    items: row.node.items,
    sub: row.node.subtotal,
    vat: row.node.vat,
    tot: row.node.total,
    disc: row.node.discount,
    coldWarm: row.coldWarmSame,
    vsQaPersist: row.persistInputVsQaReadbackSame,
    qaCustomer: row.qaPersisted.customer,
    qaVat: row.qaPersisted.vatAmount,
    qaTot: row.qaPersisted.total,
  })));
}

const invokedDirectly = process.argv[1]?.includes('replay-latest-qa-node');
if (invokedDirectly) void main();

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifyDocumentLayoutPagesAsync } from '../lib/document-layout';
import { extractStructuredDocumentAsync } from '../lib/document-structured-extraction';

const THERMOFLUX_ID = '21359f33-28de-4232-8e9e-105e99635468';
const qaRoot = path.join(process.cwd(), 'test-data', 'qa-export-2026-08-08-real-full');

function thermoFluxPageInput(pageIndex: 0 | 1) {
  const raw = fs.readFileSync(path.join(qaRoot, 'raw-text', `${THERMOFLUX_ID}.txt`), 'utf8');
  const chunks = raw.split(/^=== PAGE \d+[^\n]*\n/m).filter(Boolean);
  const pageText = chunks[pageIndex] ?? chunks[0];
  const lines = pageText.split(/\r?\n/).filter((line) => line.trim()).map((text, i) => ({
    text,
    confidence: 0.9,
    boundingBox: { x: 80 + (i % 5) * 70, y: 40 + i * 22, width: 320, height: 18 },
  }));
  return {
    pageIndex,
    rawText: pageText,
    lines,
    width: 3060,
    height: 4080,
  };
}

test('ThermoFlux page1 table_band stays bounded', async () => {
  const started = Date.now();
  const pages = await classifyDocumentLayoutPagesAsync([thermoFluxPageInput(0)], {
    layoutDeadlineMs: 5_000,
    yieldEvery: 8,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8_000, `page1 layout too slow: ${elapsed}ms`);
  assert.equal(pages.length, 1);
});

test('ThermoFlux page2 table_band stays bounded', async () => {
  const started = Date.now();
  const pages = await classifyDocumentLayoutPagesAsync([thermoFluxPageInput(1)], {
    layoutDeadlineMs: 5_000,
    yieldEvery: 8,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8_000, `page2 layout too slow: ${elapsed}ms`);
  assert.equal(pages.length, 1);
});

test('layout timeout on page1 skips expensive layout on page2', async () => {
  const processDeadline = Date.now() + 4_000;
  const started = Date.now();
  const pages = await classifyDocumentLayoutPagesAsync(
    [thermoFluxPageInput(0), thermoFluxPageInput(1)],
    {
      layoutDeadlineMs: 1,
      processDeadline,
      yieldEvery: 1,
    },
  );
  const elapsed = Date.now() - started;
  assert.equal(pages.length, 2);
  assert.ok(pages.some((page) => page.reasons.includes('structured_layout_timeout')));
  assert.ok(elapsed < 6_000, `multipage layout exceeded budget: ${elapsed}ms`);
  assert.ok(
    pages.filter((page) => page.reasons.includes('structured_layout_timeout')).length >= 1,
  );
});

test('ThermoFlux structured extraction respects global process deadline', async () => {
  const started = Date.now();
  const extraction = await extractStructuredDocumentAsync('quote', [
    thermoFluxPageInput(0),
    thermoFluxPageInput(1),
  ], {
    processDeadline: Date.now() + 12_000,
    layoutDeadlineMs: 3_000,
    yieldEvery: 8,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 14_000, `structured extraction too slow: ${elapsed}ms`);
  assert.equal(extraction.schemaVersion, 1);
});

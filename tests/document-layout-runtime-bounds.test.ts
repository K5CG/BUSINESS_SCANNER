import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifyDocumentLayoutPageAsync, classifyDocumentLayoutPagesAsync } from '../lib/document-layout';
import { detectDocumentLanguages } from '../lib/document-label-dictionary';
import { extractStructuredDocumentAsync } from '../lib/document-structured-extraction';

const MOTORPARTS_ID = 'a13fa9a4-b89f-48df-9f51-8a3d48d5d318';
const TECNOFORNITURE_ID = 'b82a4053-1fbb-454e-aff2-073c40c695b5';
const SLOW_LAYOUT_ID = '9cb5aef5-e441-46ce-9b1a-06acf77c7b97';
const qaRoot = path.join(process.cwd(), 'test-data', 'qa-export-2026-08-08-real-full');

function qaLayoutInput(fixtureId: string, lineCount?: number) {
  const rawText = fs.readFileSync(
    path.join(qaRoot, 'raw-text', `${fixtureId}.txt`),
    'utf8',
  ).replace(/^=== PAGE[^\n]*\n/, '');
  const split = rawText.split(/\r?\n/).filter((l) => l.trim());
  const lines = (lineCount === undefined ? split : split.slice(0, lineCount)).map((text, i) => ({
    text,
    confidence: 0.9,
    boundingBox: { x: 80 + (i % 4) * 90, y: 40 + i * 24, width: 360, height: 20 },
  }));
  return {
    pageIndex: 0,
    rawText,
    lines,
    width: 4080,
    height: 3060,
  };
}

function motorpartsInput(lineCount = 130) {
  return qaLayoutInput(MOTORPARTS_ID, lineCount);
}

test('Motorparts layout async completes through classifyDocumentLayoutPagesAsync', async () => {
  const started = Date.now();
  const pages = await classifyDocumentLayoutPagesAsync([motorpartsInput()], {
    yieldEvery: 8,
    layoutDeadlineMs: 5_000,
  });
  const elapsed = Date.now() - started;
  assert.equal(pages.length, 1);
  assert.ok(pages[0].lines.length >= 100);
  assert.ok(elapsed < 8_000, `layout too slow: ${elapsed}ms`);
  assert.ok(!pages[0].reasons.includes('structured_layout_timeout'));
});

test('extractStructuredDocumentAsync completes for Motorparts QA raw text', async () => {
  const started = Date.now();
  const extraction = await extractStructuredDocumentAsync('order', [motorpartsInput()]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `structured extraction too slow: ${elapsed}ms`);
  assert.equal(extraction.schemaVersion, 1);
  assert.ok(!extraction.reasons.includes('structured_layout_timeout'));
});

test('layout deadline returns partial page without hanging', async () => {
  const started = Date.now();
  const page = await classifyDocumentLayoutPageAsync(motorpartsInput(140), {
    layoutDeadlineMs: 1,
    yieldEvery: 1,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `deadline path hung: ${elapsed}ms`);
  assert.ok(page.reasons.includes('structured_layout_timeout'));
  assert.ok(page.lines.length > 0);
  assert.equal(page.zones.length, 0);
});

test('layout timeout short-circuits structured extraction before language', async () => {
  const trace: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (line.includes('[StructuredLanguage]')) trace.push('language');
    originalWarn(...args);
  };
  try {
    const extraction = await extractStructuredDocumentAsync('order', [motorpartsInput()], {
      layoutDeadlineMs: 1,
      yieldEvery: 1,
    });
    assert.ok(extraction.reasons.includes('structured_layout_timeout'));
    assert.equal(extraction.requiresReview, true);
    assert.equal(extraction.complete, false);
    assert.equal(extraction.language, undefined);
    assert.equal(trace.includes('language'), false);
  } finally {
    console.warn = originalWarn;
  }
});

test('language detection respects hard deadline', () => {
  const rawText = fs.readFileSync(
    path.join(qaRoot, 'raw-text', `${MOTORPARTS_ID}.txt`),
    'utf8',
  );
  const lines = rawText.split(/\r?\n/).filter(Boolean);
  const started = Date.now();
  const detection = detectDocumentLanguages(lines, { deadline: Date.now() - 1 });
  assert.equal(detection.timeoutReason, 'structured_language_timeout');
  assert.deepEqual(detection.detectedLanguages, []);
  assert.ok(Date.now() - started < 100);
});

test('pathological many-line input stays bounded', async () => {
  const lines = Array.from({ length: 180 }, (_, i) => ({
    text: `Riga ${i} importo ${(i + 1) * 3.14}`,
    confidence: 0.5,
    boundingBox: { x: 10 + (i % 6) * 40, y: 10 + i * 8, width: 120, height: 14 },
  }));
  const started = Date.now();
  const page = await classifyDocumentLayoutPageAsync({
    pageIndex: 0,
    rawText: lines.map((line) => line.text).join('\n'),
    lines,
    width: 3000,
    height: 4000,
  }, { layoutDeadlineMs: 5_000, yieldEvery: 8 });
  assert.ok(Date.now() - started < 8_000);
  assert.ok(page.lines.length > 0);
});

test('Tecnoforniture layout completes within hard budget', async () => {
  const started = Date.now();
  const page = await classifyDocumentLayoutPageAsync(qaLayoutInput(TECNOFORNITURE_ID), {
    layoutDeadlineMs: 5_000,
    yieldEvery: 8,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `Tecnoforniture layout too slow: ${elapsed}ms`);
  assert.ok(page.lines.length >= 100);
});

test('slow 125-line fixture layout completes within hard budget', async () => {
  const started = Date.now();
  const page = await classifyDocumentLayoutPageAsync(qaLayoutInput(SLOW_LAYOUT_ID), {
    layoutDeadlineMs: 5_000,
    yieldEvery: 8,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10_000, `slow layout fixture too slow: ${elapsed}ms`);
  assert.ok(page.lines.length >= 80);
});

test('weak table signals reject quickly via precheck', async () => {
  const lines = Array.from({ length: 80 }, (_, i) => ({
    text: `Nota amministrativa ${i} senza tabella numerica`,
    confidence: 0.8,
    boundingBox: { x: 40, y: 20 + i * 18, width: 280, height: 16 },
  }));
  const started = Date.now();
  const page = await classifyDocumentLayoutPageAsync({
    pageIndex: 0,
    rawText: lines.map((line) => line.text).join('\n'),
    lines,
    width: 2400,
    height: 3200,
  }, { layoutDeadlineMs: 2_000, yieldEvery: 8 });
  assert.ok(Date.now() - started < 3_000);
  assert.ok(page.lines.length > 0);
});

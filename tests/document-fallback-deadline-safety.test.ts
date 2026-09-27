import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentIdentity } from '../lib/document-parties-metadata';
import {
  applySemanticFallbackOverlay,
  buildSemanticFallbackExtraction,
} from '../lib/document-semantic-fallback';
import { extractStructuredDocumentAsync } from '../lib/document-structured-extraction';
import { shouldReplacePartyValue } from '../lib/document-party-roles';
import type { StructuredDocumentExtraction } from '../lib/document-structure';

function line(text: string, x: number, y: number): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width: 400, height: 22 } };
}

function emptyExtraction(partial: Partial<StructuredDocumentExtraction>): StructuredDocumentExtraction {
  return {
    schemaVersion: 1,
    metadata: {},
    items: [],
    summary: { taxSummaries: [], conflicts: [], requiresReview: true },
    conditions: {},
    pages: [],
    complete: false,
    requiresRescan: false,
    requiresReview: true,
    reasons: [],
    ...partial,
  };
}

test('21 fallback fills blank customer only', () => {
  const fallback = buildSemanticFallbackExtraction(
    'order',
    'Spettabile\nAssociazione Amici Trafoi\nTotale documento 680,70',
    ['Spettabile', 'Associazione Amici Trafoi', 'Totale documento 680,70'],
    'semantic_overlay',
  );
  const overlaid = applySemanticFallbackOverlay(
    emptyExtraction({}),
    'order',
    'Spettabile\nAssociazione Amici Trafoi\nTotale documento 680,70',
    ['Spettabile', 'Associazione Amici Trafoi', 'Totale documento 680,70'],
  );
  assert.ok(fallback.customer?.name?.normalizedValue || overlaid.customer?.name?.normalizedValue);
});

test('22 fallback cannot replace valid customer', () => {
  assert.equal(shouldReplacePartyValue('CHIOZZA TOMMASO', 'Tino Documento Di Chiusure'), false);
  const pages = classifyDocumentLayoutPages([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines: [line('Spett.le', 40, 240), line('CHIOZZA TOMMASO', 40, 270)],
    rawText: 'Spett.le\nCHIOZZA TOMMASO\nTino Documento Di Chiusure',
  }]);
  const identity = extractDocumentIdentity(pages, 'quote');
  const overlaid = applySemanticFallbackOverlay(
    emptyExtraction({
      metadata: identity.metadata,
      ...(identity.customer ? { customer: identity.customer } : {}),
    }),
    'quote',
    'Spett.le\nCHIOZZA TOMMASO\nTino Documento Di Chiusure',
    pages[0].lines.map((entry) => entry.text).concat(['Tino Documento Di Chiusure']),
  );
  assert.match(String(overlaid.customer?.name?.normalizedValue ?? ''), /CHIOZZA/i);
});

test('23 fallback cannot replace valid total', () => {
  const overlaid = applySemanticFallbackOverlay(
    emptyExtraction({
      summary: {
        taxSummaries: [],
        conflicts: [],
        requiresReview: false,
        total: {
          rawValue: '680,70',
          normalizedValue: 680.7,
          pageIndex: 0,
          sourceLineIds: [],
          sourceLines: ['680,70'],
          validationStatus: 'valid',
          confidenceType: 'heuristic',
          reasons: ['labeled_document_total'],
          requiresReview: false,
          alternatives: [],
        },
      },
    }),
    'order',
    'TOTALE DOCUMENTO 122,75\nIVA 22%',
    ['TOTALE DOCUMENTO 122,75', 'IVA 22%'],
  );
  assert.equal(overlaid.summary.total?.normalizedValue, 680.7);
});

test('24 forced metadata timeout still returns a safe identity shell', async () => {
  const pages = classifyDocumentLayoutPages([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines: [
      line('Alfa Componenti S.r.l.', 40, 40),
      line('Spettabile', 40, 240),
      line('Beta Logistica S.r.l.', 40, 270),
      line('Totale documento 100,00', 40, 900),
    ],
    rawText: 'Alfa Componenti S.r.l.\nSpettabile\nBeta Logistica S.r.l.\nTotale documento 100,00',
  }]);
  const identity = extractDocumentIdentity(pages, 'order', { deadline: Date.now() - 1 });
  assert.ok(identity);
  if (identity.customer?.name?.normalizedValue) {
    assert.notEqual(identity.customer.name.normalizedValue, 'Cliente');
  }
});

test('25 forced items/totals timeout does not wipe a valid total via overlay', () => {
  const overlaid = applySemanticFallbackOverlay(
    emptyExtraction({
      reasons: ['items_totals_deadline_exceeded'],
      summary: {
        taxSummaries: [],
        conflicts: [],
        requiresReview: false,
        total: {
          rawValue: '1400',
          normalizedValue: 1400,
          pageIndex: 0,
          sourceLineIds: [],
          sourceLines: ['Totale 1.400,00€'],
          validationStatus: 'valid',
          confidenceType: 'heuristic',
          reasons: ['labeled_document_total'],
          requiresReview: false,
          alternatives: [],
        },
      },
    }),
    'quote',
    'Totale 1.400,00€\nal netto di IVA 22%',
    ['Totale 1.400,00€', 'al netto di IVA 22%'],
  );
  assert.equal(overlaid.summary.total?.normalizedValue, 1400);
  assert.notEqual(overlaid.summary.vatAmount?.normalizedValue, 1400);
});

test('26 semantic result remains safe under forced process timeout', async () => {
  const extraction = await extractStructuredDocumentAsync('quote', [{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    rawText: 'Spett.le\nCHIOZZA TOMMASO\nTotale 1.400,00€\nal netto di IVA 22%',
    lines: [
      line('Spett.le', 40, 240),
      line('CHIOZZA TOMMASO', 40, 270),
      line('KIT TENDICINGHIA AUTO', 40, 500),
      line('1', 520, 500),
      line('216,98', 700, 500),
      line('Totale 1.400,00€', 40, 1100),
      line('al netto di IVA 22%', 40, 1130),
    ],
  }], { processDeadline: Date.now() - 1 });
  if (extraction.customer?.name?.normalizedValue) {
    assert.notEqual(extraction.customer.name.normalizedValue, 'Tino Documento Di Chiusure');
  }
  if (extraction.summary.total?.normalizedValue !== undefined) {
    assert.notEqual(extraction.summary.vatAmount?.normalizedValue, extraction.summary.total.normalizedValue);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDocumentIdentity } from '../lib/document-parties-metadata';
import { classifyDocumentLayoutPages } from '../lib/document-layout';

const line = (id: string, text: string, x: number, y: number, width = 100) => ({
  text, confidence: 0.9, boundingBox: { x, y, width, height: 24 },
});

function resolveIdentity(lines: ReturnType<typeof line>[], language: 'it' | 'en') {
  const pages = classifyDocumentLayoutPages([{
    pageIndex: 0,
    width: 1000,
    height: 1400,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }]);
  return extractDocumentIdentity(pages, 'quote', { primaryLanguage: language }).metadata;
}

test('header identity grid owns number/date over lower body references', () => {
  const lines = [
    line('l1', 'Anno Es.', 100, 100), line('l2', 'Numero', 260, 100),
    line('l3', 'CodSez', 420, 100), line('l4', 'Data', 580, 100),
    line('l5', '2024', 100, 140), line('l6', '73', 260, 140),
    line('l7', 'SEC', 420, 140), line('l8', '14 mar 2024', 580, 140, 150),
    line('l9', 'Regolamento 2016/679', 300, 900, 220), line('l10', '2/7/2018', 600, 950, 140),
  ];
  const result = resolveIdentity(lines, 'it');
  assert.equal(result.documentNumber?.normalizedValue, '73');
  assert.equal(result.issueDate?.normalizedValue, '2024-03-14');
});

test('bare Numero table column cannot claim document identity', () => {
  const result = resolveIdentity([
    line('l1', 'Numero', 100, 400), line('l2', 'Descrizione', 250, 400), line('l3', '7', 100, 440),
  ], 'it');
  assert.equal(result.documentNumber, undefined);
  assert.equal(result.issueDate, undefined);
});

test('same rule supports English identity grids', () => {
  const lines = [
    line('l1', 'Year', 100, 100), line('l2', 'Number', 260, 100),
    line('l3', 'Section', 420, 100), line('l4', 'Date', 580, 100),
    line('l5', '2026', 100, 140), line('l6', '104', 260, 140),
    line('l7', 'A', 420, 140), line('l8', '5 Sep 2026', 580, 140, 150),
  ];
  const result = resolveIdentity(lines, 'en');
  assert.equal(result.documentNumber?.normalizedValue, '104');
  assert.equal(result.issueDate?.normalizedValue, '2026-09-05');
});

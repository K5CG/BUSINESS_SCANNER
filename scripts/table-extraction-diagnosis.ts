/**
 * Diagnostic trace for table extraction on QA 2026-08-08 documents.
 * Run: npx ts-node --project tsconfig.document-structure-tests.json scripts/table-extraction-diagnosis.ts
 */
import fs from 'node:fs';
import type { InvoiceDocument, OrderDocument, QuoteDocument } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import type { DocumentLayoutPageInput } from '../lib/document-layout';
import {
  detectDocumentTableColumn,
  extractDocumentItemsAndTotals,
  parseDocumentAmount,
} from '../lib/document-items-totals';
import type { StructuredDocumentType } from '../lib/document-structure';
import { extractStructuredDocument } from '../lib/document-structured-extraction';

type QaDoc = QuoteDocument | OrderDocument | InvoiceDocument;

const DOC_NAMES: Record<string, string> = {
  '21359f33': 'ThermoFlux',
  '9cb5aef5': 'Atelier',
  '2adb6bb0': 'Medisupply',
  'a13fa9a4': 'Motorparts',
  '7b8fc549': 'EnerSoluciones',
  '960e93ce': 'Rheinwerk',
  '28ff5440': 'Northbridge',
  'f7938d5e': 'GlobalFood',
  'b82a4053': 'Tecnoforniture',
};

const UPSIDE_DOWN = new Set(['9cb5aef5', '2adb6bb0', 'a13fa9a4']);

function layoutInputs(doc: QaDoc): DocumentLayoutPageInput[] {
  return (doc.structuredExtraction?.pages ?? []).map((page) => ({
    pageIndex: page.pageIndex,
    lines: page.lines.map((line) => ({
      text: line.text,
      confidence: 0.9,
      ...(line.boundingBox ? { boundingBox: line.boundingBox } : {}),
      ...(line.elements ? { elements: line.elements } : {}),
    })),
    rawText: page.lines.map((line) => line.text).join('\n'),
    width: page.width,
    height: page.height,
  }));
}

function diagnoseHeaderColumns(page: ReturnType<typeof classifyDocumentLayoutPages>[number]) {
  const columnLines = page.lines.flatMap((line) => {
    const kind = detectDocumentTableColumn(line.text);
    return kind && line.boundingBox ? [{ kind, text: line.text.slice(0, 50), x: line.boundingBox.x, y: line.boundingBox.y }] : [];
  });
  const tableZones = page.zones.filter((z) => z.classification === 'items_table');
  return { columnLines, tableZones: tableZones.length, tableZoneReasons: tableZones.flatMap((z) => z.reasons) };
}

function countVisibleDataRows(page: ReturnType<typeof classifyDocumentLayoutPages>[number]): number {
  const tableZone = page.zones.find((z) => z.classification === 'items_table');
  if (!tableZone) return 0;
  const ids = new Set(tableZone.lineIds);
  const tableLines = page.lines.filter((l) => ids.has(l.id));
  const amounts = tableLines.filter((l) => parseDocumentAmount(l.text) !== undefined);
  const yGroups = new Set(amounts.map((l) => Math.round((l.boundingBox?.y ?? 0) / 25)));
  return yGroups.size;
}

const docs = (JSON.parse(
  fs.readFileSync('test-data/qa-export-2026-08-08-real/documents.json', 'utf8'),
) as QaDoc[]).filter((d) => String(d.createdAt).startsWith('2026-08-08'));

console.log('# Table extraction diagnosis\n');

for (const doc of docs) {
  const prefix = doc.id.slice(0, 8);
  const name = DOC_NAMES[prefix] ?? prefix;
  const inputs = layoutInputs(doc);
  const layoutPages = classifyDocumentLayoutPages(inputs);
  const extraction = extractStructuredDocument(doc.type as StructuredDocumentType, inputs);
  const itemsResult = extractDocumentItemsAndTotals(layoutPages);

  console.log(`## ${name} (${prefix}) — ${doc.type}${UPSIDE_DOWN.has(prefix) ? ' [legacy upside-down OCR]' : ''}`);
  console.log(`- structured items: ${extraction.items.length}`);
  console.log(`- items/totals reasons: ${itemsResult.reasons.join(', ') || 'none'}`);
  console.log(`- total: ${extraction.summary.total?.normalizedValue ?? 'missing'}`);
  console.log(`- vat: ${extraction.summary.vatAmount?.normalizedValue ?? 'missing'}`);

  for (const page of layoutPages) {
    const diag = diagnoseHeaderColumns(page);
    console.log(`\n### Page ${page.pageIndex}`);
    console.log(`- table zones: ${diag.tableZones} (${diag.tableZoneReasons.join(', ') || 'none'})`);
    console.log(`- column detections (${diag.columnLines.length}):`);
    for (const col of diag.columnLines.slice(0, 20)) {
      console.log(`  - ${col.kind}: "${col.text}" @ x=${Math.round(col.x)} y=${Math.round(col.y)}`);
    }
    console.log(`- visible data row bands (approx): ${countVisibleDataRows(page)}`);
  }
  console.log('');
}

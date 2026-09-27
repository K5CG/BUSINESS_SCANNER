import fs from 'node:fs';
import path from 'node:path';
import { parseOrderDocument, parseQuoteDocument } from '../lib/document-parser';

type Row = {
  file: string;
  kind: 'quote' | 'order';
  customer?: string;
  number?: string;
  total?: number;
  subtotal?: number;
  vatAmount?: number;
  items: number;
  itemSum: number;
  flags: string[];
};

function loadRaw(filePath: string): { raw: string; lines: { text: string; confidence: number; lineIndex: number }[] } {
  const raw = fs
    .readFileSync(filePath, 'utf8')
    .replace(/^=== PAGE \d+ \| local ===\n/, '');
  const lines = raw.split('\n').map((text, lineIndex) => ({
    text,
    confidence: 0.9,
    lineIndex,
  }));
  return { raw, lines };
}

function diagnoseQuote(file: string): Row {
  const { raw, lines } = loadRaw(file);
  const doc = parseQuoteDocument(lines, raw);
  const itemSum = doc.items.reduce((sum, item) => sum + item.total, 0);
  const flags: string[] = [];
  if (doc.total !== undefined && itemSum > doc.total * 1.02) flags.push('items_exceed_total');
  if (doc.total !== undefined && doc.items[0] && Math.abs(doc.total - doc.items[0].total) < 0.01) {
    flags.push('total_equals_first_item');
  }
  if (doc.total !== undefined && doc.total < 100 && itemSum > 200) flags.push('total_too_small');
  if (raw.match(/totale\s+1\.400/i) && doc.total !== 1400) flags.push('pendingomme_total_mismatch');
  if (raw.match(/680[,\.]70/i) && doc.total !== undefined && Math.abs(doc.total - 680.7) > 0.05) {
    flags.push('kunzi_total_mismatch');
  }
  return {
    file: path.basename(file),
    kind: 'quote',
    customer: doc.customerName,
    number: doc.quoteNumber,
    total: doc.total,
    subtotal: doc.subtotal,
    vatAmount: doc.vatAmount,
    items: doc.items.length,
    itemSum: Math.round(itemSum * 100) / 100,
    flags,
  };
}

function diagnoseOrder(file: string): Row {
  const { raw, lines } = loadRaw(file);
  const doc = parseOrderDocument(lines, raw);
  const itemSum = doc.items.reduce((sum, item) => sum + item.total, 0);
  const flags: string[] = [];
  if (doc.total !== undefined && itemSum > doc.total * 1.02) flags.push('items_exceed_total');
  if (doc.total !== undefined && doc.items[0] && Math.abs(doc.total - doc.items[0].total) < 0.01) {
    flags.push('total_equals_first_item');
  }
  if (doc.orderNumber === 'FERMA') flags.push('order_number_ferma');
  if (raw.match(/680[,\.]70/i) && doc.total !== undefined && Math.abs(doc.total - 680.7) > 0.05) {
    flags.push('kunzi_total_mismatch');
  }
  return {
    file: path.basename(file),
    kind: 'order',
    customer: doc.customerName,
    number: doc.orderNumber,
    total: doc.total,
    subtotal: doc.subtotal,
    vatAmount: doc.vatAmount,
    items: doc.items.length,
    itemSum: Math.round(itemSum * 100) / 100,
    flags,
  };
}

const root = path.join(process.cwd(), 'test-data');
const rows: Row[] = [];

for (const dir of fs.readdirSync(root).filter((name) => name.startsWith('qa-export-'))) {
  const rawDir = path.join(root, dir, 'raw-text');
  if (!fs.existsSync(rawDir)) continue;
  for (const file of fs.readdirSync(rawDir).filter((name) => name.endsWith('.txt'))) {
    const full = path.join(rawDir, file);
    const raw = fs.readFileSync(full, 'utf8');
    const isOrder = /CONFERMA ORDINE|ordine cliente|purchase order/i.test(raw);
    rows.push(isOrder ? diagnoseOrder(full) : diagnoseQuote(full));
  }
}

const flagged = rows.filter((row) => row.flags.length > 0);
console.log(JSON.stringify({ scanned: rows.length, flagged }, null, 2));
for (const row of flagged) {
  console.log(JSON.stringify(row));
}

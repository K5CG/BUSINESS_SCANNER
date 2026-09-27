import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentLayoutLine } from '../lib/document-structure';
import { reattachOrphanNumericCells } from '../lib/document-orphan-cells';
import { parseDiscountPercent } from '../lib/document-vat-column';

function line(id: string, text: string, x: number, y: number): DocumentLayoutLine {
  return {
    id,
    text,
    pageIndex: 0,
    readingOrder: x,
    boundingBox: { x, y, width: 40, height: 20 },
  } as DocumentLayoutLine;
}

test('row discount rejects monetary-sized values but keeps ordinary bare percentages', () => {
  assert.equal(parseDiscountPercent('10'), 10);
  assert.equal(parseDiscountPercent('42'), 42);
  assert.equal(parseDiscountPercent('150'), undefined);
  assert.equal(parseDiscountPercent('12500'), undefined);
});

test('positive orphan unit price replaces false zero placeholder in same commercial row', () => {
  const description = line('desc', 'Manodopera installazione', 200, 100);
  const quantity = line('qty', '2', 600, 100);
  const falseZero = line('zero', '0,00', 800, 100);
  const total = line('total', '70,00', 1100, 100);
  const realPrice = line('price', '35,00', 800, 118);

  const assignColumn = (entry: DocumentLayoutLine): string | undefined => {
    if (entry.id === 'desc') return 'description';
    if (entry.id === 'qty') return 'quantity';
    if (entry.id === 'zero' || entry.id === 'price') return 'unitPrice';
    if (entry.id === 'total') return 'lineTotal';
    return undefined;
  };

  const result = reattachOrphanNumericCells({
    rows: [{ pageIndex: 0, y: 100, lines: [description, quantity, falseZero, total] }],
    body: [description, quantity, falseZero, total, realPrice],
    assignColumn,
    pageIndex: 0,
    medianLineHeight: 20,
    medianRowSpacing: 60,
  });

  assert.equal(result.attached, 1);
  const prices = result.rows[0]?.lines.filter((entry) => assignColumn(entry) === 'unitPrice') ?? [];
  assert.deepEqual(prices.map((entry) => entry.text), ['35,00']);
});

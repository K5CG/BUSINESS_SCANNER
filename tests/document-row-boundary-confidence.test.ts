import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { classifyDocumentLayoutPages } from '../lib/document-layout';
import { extractDocumentItemsAndTotals } from '../lib/document-items-totals';
import { annotateDocumentRegions, isCarryForwardText } from '../lib/document-region-model';

function line(text: string, x: number, y: number, width = 90, height = 22): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width, height } };
}

function layout(lines: OcrLine[], width = 1400, height = 1800) {
  return annotateDocumentRegions(classifyDocumentLayoutPages([{
    pageIndex: 0,
    width,
    height,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }]));
}

function layoutPages(pages: OcrLine[][], width = 1400, height = 1800) {
  return annotateDocumentRegions(classifyDocumentLayoutPages(pages.map((lines, pageIndex) => ({
    pageIndex,
    width,
    height,
    lines,
    rawText: lines.map((entry) => entry.text).join('\n'),
  }))));
}

function headers(): OcrLine[] {
  return [
    line('Codice', 40, 100, 80),
    line('Descrizione', 180, 102, 160),
    line('Q.tà', 520, 108, 50),
    line('Prezzo', 640, 110, 80),
    line('IVA %', 900, 112, 50),
    line('Totale', 1100, 118, 70),
  ];
}

test('1. code-shaped fragment with no own numerics does not open a new row', () => {
  const pages = layout([
    ...headers(),
    line('TUB-PE100', 40, 180, 110),
    line('Polyethylene pipe PN16 DN32', 180, 181, 260),
    line('120', 520, 200, 30),
    line('3,20', 640, 205, 50),
    line('22', 900, 208, 30),
    line('384,00', 1100, 210, 70),
    line('TUB-PE100-1', 40, 228, 120),
    line('wall thickness continuation', 180, 250, 240),
    line('Imponibile', 700, 360, 120),
    line('384,00', 1100, 360, 70),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items[0]?.quantity?.normalizedValue, 120);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 384);
});

test('2. hyphenated SKU with own qty+price opens a new row', () => {
  const pages = layout([
    ...headers(),
    line('VAL-MOT-01', 40, 180, 120),
    line('Motorized valve body', 180, 181, 220),
    line('4', 520, 196, 20),
    line('1250,00', 640, 198, 80),
    line('22', 900, 199, 30),
    line('4500,00', 1100, 200, 80),
    line('SEN-LIV-02', 40, 260, 120),
    line('Capacitive level sensor', 180, 261, 220),
    line('6', 520, 276, 20),
    line('285,00', 640, 278, 70),
    line('22', 900, 279, 30),
    line('1569,60', 1100, 280, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  const codes = extraction.items.map((item) => String(item.itemCode?.normalizedValue ?? ''));
  assert.equal(extraction.items.length, 2);
  assert.match(codes.join(' | '), /VAL-MOT-01/i);
  assert.match(codes.join(' | '), /SEN-LIV-02/i);
});

test('3. plain alphanumeric code with own numerics opens a new row', () => {
  const pages = layout([
    ...headers(),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly', 180, 181, 220),
    line('6', 520, 196, 20),
    line('42,50', 640, 198, 70),
    line('22', 900, 199, 30),
    line('229,50', 1100, 200, 80),
    line('KIT01', 40, 280, 80),
    line('Brass valve kit', 180, 281, 180),
    line('4', 520, 296, 20),
    line('24,90', 640, 298, 70),
    line('22', 900, 299, 30),
    line('89,64', 1100, 300, 80),
  ], 1400, 1800);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2);
  assert.equal(extraction.items[1]?.lineTotal?.normalizedValue, 89.64);
  assert.match(String(extraction.items[1]?.itemCode?.normalizedValue ?? extraction.items[1]?.description?.normalizedValue ?? ''), /KIT01/i);
});

test('4. descriptive service label with own numerics opens a new row', () => {
  const pages = layout([
    ...headers(),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly', 180, 181, 220),
    line('6', 520, 196, 20),
    line('42,50', 640, 198, 70),
    line('22', 900, 199, 30),
    line('229,50', 1100, 200, 80),
    line('PACK', 40, 280, 80),
    line('Express packing service', 180, 281, 220),
    line('1', 520, 296, 20),
    line('15,00', 640, 298, 70),
    line('22', 900, 299, 30),
    line('15,00', 1100, 300, 70),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2);
  assert.equal(extraction.items[1]?.lineTotal?.normalizedValue, 15);
  assert.match(String(extraction.items[1]?.description?.normalizedValue ?? ''), /packing/i);
});

test('5. wrapped description with no numerics stays a continuation', () => {
  const pages = layout([
    ...headers(),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly with long technical', 180, 181, 280),
    line('body wrapping onto the next baseline', 180, 210, 260),
    line('6', 520, 196, 20),
    line('42,50', 640, 198, 70),
    line('22', 900, 199, 30),
    line('229,50', 1100, 200, 80),
    line('Imponibile', 700, 360, 120),
    line('229,50', 1100, 360, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.match(String(extraction.items[0]?.description?.normalizedValue ?? ''), /wrapping|baseline|technical/i);
});

test('5b. wrapped spec fragment with stray lineTotal stays a continuation', () => {
  const pages = layout([
    ...headers(),
    line('PNL-01', 40, 180, 80),
    line('Electrical control panel IP66, supply,', 180, 181, 280),
    line('2', 520, 182, 20),
    line('9850,00', 640, 182, 80),
    line('22', 900, 182, 30),
    line('19700,00', 1100, 182, 90),
    line('230V/1ph/50Hz, complete with protections and terminals.', 180, 214, 300),
    line('3800,00', 1100, 216, 80),
    line('ENG-01', 40, 300, 80),
    line('Commissioning and software service', 180, 301, 260),
    line('40', 520, 302, 30),
    line('95,00', 640, 302, 70),
    line('22', 900, 302, 30),
    line('3800,00', 1100, 302, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(
    extraction.items.length,
    2,
    extraction.items.map((item) => item.description?.normalizedValue).join(' | '),
  );
  const panel = extraction.items.find((item) => /Electrical control panel/i.test(String(item.description?.normalizedValue ?? '')));
  const service = extraction.items.find((item) => /Commissioning and software/i.test(String(item.description?.normalizedValue ?? '')));
  assert.ok(panel);
  assert.ok(service);
  assert.equal(extraction.items.some((item) => /^230V\/1ph\/50Hz/i.test(String(item.description?.normalizedValue ?? '').trim())), false);
  assert.match(String(panel?.description?.normalizedValue ?? ''), /230V\/1ph\/50Hz|protections/i);
  assert.equal(panel?.lineTotal?.normalizedValue, 19700);
  assert.equal(service?.lineTotal?.normalizedValue, 3800);
});

test('5c. free zero-price row with quantity is not absorbed', () => {
  const pages = layout([
    ...headers(),
    line('PNL-01', 40, 180, 80),
    line('Electrical control panel IP66, supply,', 180, 181, 280),
    line('2', 520, 182, 20),
    line('9850,00', 640, 182, 80),
    line('22', 900, 182, 30),
    line('19700,00', 1100, 182, 90),
    line('SETUP', 40, 250, 80),
    line('Included installation support', 180, 251, 260),
    line('1', 520, 252, 20),
    line('0,00', 640, 252, 50),
    line('22', 900, 252, 30),
    line('0,00', 1100, 252, 50),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2, extraction.items.map((item) => item.description?.normalizedValue).join(' | '));
  const included = extraction.items.find((item) => /Included installation/i.test(String(item.description?.normalizedValue ?? '')));
  assert.ok(included);
  assert.equal(included?.quantity?.normalizedValue, 1);
  assert.equal(included?.unitPrice?.normalizedValue, 0);
});

test('5d. distinct service with its own total is not absorbed', () => {
  const pages = layout([
    ...headers(),
    line('PNL-01', 40, 180, 80),
    line('Electrical control panel IP66, supply,', 180, 181, 280),
    line('2', 520, 182, 20),
    line('9850,00', 640, 182, 80),
    line('22', 900, 182, 30),
    line('19700,00', 1100, 182, 90),
    line('TRASP', 40, 250, 80),
    line('Transport and packing', 180, 251, 220),
    line('1', 520, 252, 20),
    line('80,00', 640, 252, 70),
    line('22', 900, 252, 30),
    line('80,00', 1100, 252, 70),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 19700);
  assert.equal(extraction.items[1]?.lineTotal?.normalizedValue, 80);
});

test('6. next row text overlapping previous Y still splits when it owns numerics', () => {
  const pages = layout([
    ...headers(),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly wrapped across the band', 180, 181, 280, 48),
    line('6', 520, 205, 20),
    line('42,50', 640, 208, 70),
    line('22', 900, 209, 30),
    line('229,50', 1100, 212, 80),
    line('KIT-01', 40, 218, 80),
    line('Brass valve kit starting near previous wrap', 180, 216, 260, 40),
    line('4', 520, 268, 20),
    line('24,90', 640, 272, 70),
    line('22', 900, 273, 30),
    line('89,64', 1100, 278, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 229.5);
  assert.equal(extraction.items[1]?.lineTotal?.normalizedValue, 89.64);
});

test('7. numeric cluster closer to previous row does not split', () => {
  const pages = layout([
    ...headers(),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly', 180, 181, 220),
    line('SKU-FRAG-1', 40, 198, 110),
    line('6', 520, 196, 20),
    line('42,50', 640, 198, 70),
    line('22', 900, 199, 30),
    line('229,50', 1100, 200, 80),
    line('Imponibile', 700, 320, 120),
    line('229,50', 1100, 320, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items[0]?.quantity?.normalizedValue, 6);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 229.5);
});

test('8b. left-column code slightly below its numeric band still owns that row', () => {
  const pages = layout([
    ...headers(),
    line('Cabin filter assembly', 180, 201, 220),
    line('5', 520, 200, 20),
    line('14,20', 640, 201, 50),
    line('22', 900, 202, 30),
    line('63,90', 1100, 201, 70),
    line('FILTABC01', 40, 210, 110),
    line('Synthetic oil pack', 180, 268, 200),
    line('8', 520, 261, 20),
    line('49,90', 640, 262, 50),
    line('22', 900, 263, 30),
    line('366,66', 1100, 261, 70),
    line('OILXYZ99', 40, 270, 100),
    line('Imponibile', 700, 380, 120),
    line('430,56', 1100, 380, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2, extraction.items.map((item) => item.description?.normalizedValue).join(' | '));
  assert.equal(extraction.items[0]?.quantity?.normalizedValue, 5);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 63.9);
  assert.match(String(extraction.items[0]?.description?.normalizedValue ?? ''), /Cabin filter/i);
  assert.equal(extraction.items[1]?.quantity?.normalizedValue, 8);
  assert.equal(extraction.items[1]?.lineTotal?.normalizedValue, 366.66);
  assert.match(String(extraction.items[1]?.description?.normalizedValue ?? ''), /Synthetic oil/i);
});

test('8. numeric cluster closer to next left anchor splits', () => {
  const pages = layout([
    ...headers(),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly', 180, 181, 220),
    line('6', 520, 196, 20),
    line('42,50', 640, 198, 70),
    line('22', 900, 199, 30),
    line('229,50', 1100, 200, 80),
    line('KIT-01', 40, 270, 80),
    line('Brass valve kit', 180, 271, 180),
    line('4', 520, 286, 20),
    line('24,90', 640, 288, 70),
    line('22', 900, 289, 30),
    line('89,64', 1100, 290, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 2);
  assert.equal(extraction.items[1]?.lineTotal?.normalizedValue, 89.64);
});

test('9. a numeric token cannot validate two commercial rows', () => {
  const pages = layout([
    ...headers(),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly', 180, 181, 220),
    line('6', 520, 196, 20),
    line('42,50', 640, 198, 70),
    line('22', 900, 199, 30),
    line('229,50', 1100, 200, 80),
    line('FRAG-CODE-1', 40, 220, 120),
    line('subcomponent text', 180, 222, 180),
    line('Imponibile', 700, 340, 120),
    line('229,50', 1100, 340, 80),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  const qtyOnly = extraction.items.filter((item) =>
    item.quantity?.normalizedValue === 6 && item.unitPrice?.normalizedValue === undefined && item.lineTotal?.normalizedValue === undefined);
  assert.equal(qtyOnly.length, 0);
});

test('10. zero-price valid row is still supported', () => {
  const pages = layout([
    ...headers(),
    line('FREE-1', 40, 180, 80),
    line('Complimentary setup', 180, 181, 200),
    line('1', 520, 196, 20),
    line('0,00', 640, 198, 50),
    line('22', 900, 199, 30),
    line('0,00', 1100, 200, 50),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items[0]?.unitPrice?.normalizedValue, 0);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 0);
});

test('11. free row is still supported', () => {
  const pages = layout([
    ...headers(),
    line('XK-220', 40, 180, 80),
    line('Free setup / zero priced row', 180, 181, 220),
    line('1', 520, 196, 20),
    line('0,00', 640, 198, 50),
    line('22', 900, 199, 30),
    line('0,00', 1100, 200, 50),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items[0]?.quantity?.normalizedValue, 1);
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 0);
});

test('12. multipage page-local row ownership is preserved', () => {
  const pages = layoutPages([
    [
      ...headers(),
      line('ABC-123', 40, 180, 90),
      line('Primary pump assembly', 180, 181, 220),
      line('1', 520, 196, 20),
      line('100,00', 640, 198, 70),
      line('22', 900, 199, 30),
      line('100,00', 1100, 200, 70),
    ],
    [
      ...headers(),
      line('KIT-01', 40, 180, 80),
      line('Brass valve kit', 180, 181, 180),
      line('4', 520, 196, 20),
      line('24,90', 640, 198, 70),
      line('22', 900, 199, 30),
      line('89,64', 1100, 200, 80),
      line('PACK', 40, 280, 80),
      line('Express packing', 180, 281, 180),
      line('1', 520, 296, 20),
      line('15,00', 640, 298, 70),
      line('22', 900, 299, 30),
      line('15,00', 1100, 300, 70),
    ],
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 3);
  assert.equal(extraction.items.filter((item) => item.pageIndex === 0).length, 1);
  assert.equal(extraction.items.filter((item) => item.pageIndex === 1).length, 2);
});

test('13. carry-forward is still excluded', () => {
  assert.equal(isCarryForwardText('Riporto da pagina 1: 63.109,30'), true);
  const pages = layout([
    ...headers(),
    line('ABC-123', 40, 180, 90),
    line('Primary pump assembly', 180, 181, 220),
    line('1', 520, 196, 20),
    line('100,00', 640, 198, 70),
    line('22', 900, 199, 30),
    line('100,00', 1100, 200, 70),
    line('Riporto da pagina 1: 100,00', 40, 280, 220),
    line('Imponibile', 700, 360, 120),
    line('100,00', 1100, 360, 70),
  ]);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 1);
  assert.equal(extraction.items.some((item) => /riporto/i.test(String(item.description?.normalizedValue ?? ''))), false);
});

test('weak left-column code with own numerics splits even when previous description lacks a qty', () => {
  const pages = layout([
    line('Codice', 180, 1040, 80),
    line('Descrizione', 390, 1042, 160),
    line('Q.tà', 900, 1048, 50),
    line('Prezzo', 1020, 1050, 80),
    line('Sconto %', 1220, 1052, 70),
    line('IVA %', 1380, 1054, 50),
    line('Totale', 1550, 1056, 70),
    line('FILT-20', 184, 1110, 119),
    line('Industrial high-flow filter', 393, 1109, 390),
    line('6', 906, 1124, 15),
    line('42,50', 1023, 1128, 81),
    line('10', 1226, 1132, 32),
    line('22', 1383, 1133, 32),
    line('229,50', 1534, 1132, 100),
    line('KIT-VAL', 182, 1210, 127),
    line('Brass valve kit', 392, 1212, 244),
    line('4', 906, 1221, 15),
    line('24,90', 1023, 1221, 79),
    line('10', 1226, 1226, 31),
    line('22', 1385, 1228, 33),
    line('89,64', 1556, 1228, 83),
    line('MAN-09', 182, 1312, 147),
    line('Installation labour', 391, 1313, 362),
    line('35,00', 1025, 1316, 80),
    line('0', 1235, 1321, 16),
    line('22', 1387, 1322, 30),
    line('70,00', 1559, 1322, 82),
    line('PACK', 178, 1412, 113),
    line('Express packing', 388, 1411, 272),
    line('1', 908, 1413, 15),
    line('15,00', 1028, 1414, 70),
    line('0', 1235, 1418, 16),
    line('22', 1387, 1419, 30),
    line('15,00', 1559, 1419, 70),
    line('Imponibile', 1200, 1600, 120),
    line('404,14', 1550, 1600, 80),
    line('Totale documento', 1180, 1680, 160),
    line('493,05', 1550, 1680, 80),
  ], 1800, 2200);
  const extraction = extractDocumentItemsAndTotals(pages);
  assert.equal(extraction.items.length, 4, extraction.items.map((item) => item.description?.normalizedValue).join(' | '));
  assert.equal(extraction.items[0]?.lineTotal?.normalizedValue, 229.5);
  assert.equal(extraction.items[1]?.lineTotal?.normalizedValue, 89.64);
  assert.equal(extraction.items[2]?.lineTotal?.normalizedValue, 70);
  assert.equal(extraction.items[3]?.lineTotal?.normalizedValue, 15);
});

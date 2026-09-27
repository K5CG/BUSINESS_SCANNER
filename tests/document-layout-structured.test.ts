import assert from 'node:assert/strict';
import test from 'node:test';
import type { OcrLine } from '../types';
import { buildDocumentLayoutLines, classifyDocumentLayoutPage, classifyDocumentLayoutPages } from '../lib/document-layout';

function line(text: string, x: number, y: number, width = 200, height = 20): OcrLine {
  return { text, confidence: 0.9, boundingBox: { x, y, width, height } };
}

test('geometria, pagina, id e ordine di lettura vengono preservati', () => {
  const lines = buildDocumentLayoutLines({
    pageIndex: 1,
    width: 1000,
    height: 1400,
    rawText: '',
    lines: [line('destra', 500, 100), line('sinistra', 50, 100), line('sotto', 50, 180)],
  });
  assert.deepEqual(lines.map((entry) => entry.text), ['sinistra', 'destra', 'sotto']);
  assert.deepEqual(lines.map((entry) => entry.id), ['p2-l1', 'p2-l2', 'p2-l3']);
  assert.equal(lines[0].pageIndex, 1);
  assert.deepEqual(lines[0].boundingBox, { x: 50, y: 100, width: 200, height: 20 });
});

test('classifica le zone universali senza dipendere dal rawText concatenato', () => {
  const page = classifyDocumentLayoutPage({
    pageIndex: 0,
    width: 1000,
    height: 1400,
    rawText: 'ordine volutamente diverso',
    lines: [
      line('ACME', 50, 40),
      line('ACME S.p.A. - P.IVA IT00112233445', 50, 120),
      line('Preventivo n. P-12 Data 02/08/2026', 50, 220),
      line('Spett.le Cliente Uno', 50, 320),
      line('Codice Descrizione Q.ta Prezzo IVA Totale', 50, 500),
      line('A1 Servizio 2 20,00 22% 40,00', 50, 560),
      line('Imponibile IVA 22%', 50, 900),
      line('Totale documento 48,80', 50, 980),
      line('IBAN IT60X0542811101000000123456', 50, 1080),
      line('Note: consegna entro 10 giorni', 50, 1160),
      line('Registro imprese Milano', 50, 1320),
    ],
  });
  const kinds = new Set(page.zones.map((zone) => zone.classification));
  for (const kind of ['header', 'metadata', 'customer', 'items_table', 'tax_summary', 'totals', 'payment', 'notes', 'footer']) {
    assert.ok(kinds.has(kind as never), `zona mancante: ${kind}`);
  }
});

test('il contesto cliente associa le righe vicine senza fonderle con l emittente', () => {
  const page = classifyDocumentLayoutPage({
    pageIndex: 0,
    rawText: '',
    lines: [
      { text: 'Spett.le', confidence: 0.8 },
      { text: 'Cliente Uno S.r.l.', confidence: 0.8 },
      { text: 'Via Roma 1', confidence: 0.8 },
    ],
  });
  assert.deepEqual(page.zones.map((zone) => zone.classification), ['customer']);
  assert.equal(page.zones[0].rawLines.length, 3);
});

test('senza geometria mantiene l ordine fornito e marca unknown da revisionare', () => {
  const page = classifyDocumentLayoutPage({
    pageIndex: 0,
    rawText: 'Riga libera',
    lines: [{ text: 'Riga libera', confidence: 0.5 }],
  });
  assert.equal(page.lines[0].text, 'Riga libera');
  assert.equal(page.zones[0].classification, 'unknown');
  assert.equal(page.zones[0].requiresReview, true);
});

test('multipagina conserva ordine e indici pagina', () => {
  const pages = classifyDocumentLayoutPages([
    { pageIndex: 2, lines: [], rawText: 'Totale 10,00' },
    { pageIndex: 0, lines: [], rawText: 'Preventivo P-1' },
    { pageIndex: 1, lines: [], rawText: 'Descrizione Qta Prezzo Totale' },
  ]);
  assert.deepEqual(pages.map((page) => page.pageIndex), [0, 1, 2]);
  assert.deepEqual(pages.map((page) => page.lines[0].id), ['p1-l1', 'p2-l1', 'p3-l1']);
});

test('rotazione OCR gia applicata conserva box ed elementi nel canvas leggibile', () => {
  const input = {
    pageIndex: 0,
    rawText: '',
    width: 2600,
    height: 1838,
    ocrCanvasWidth: 2600,
    ocrCanvasHeight: 1838,
    rotationDegrees: 90 as const,
    lines: [{
      text: 'Numero: Q-1', confidence: 0.9,
      boundingBox: { x: 2000, y: 100, width: 40, height: 300 },
      elements: [{ text: 'Q-1', elementIndex: 0, boundingBox: { x: 2000, y: 250, width: 40, height: 80 } }],
    }],
  };
  const result = buildDocumentLayoutLines(input)[0];
  assert.deepEqual(result.boundingBox, { x: 2000, y: 100, width: 40, height: 300 });
  assert.deepEqual(result.elements?.[0].boundingBox, { x: 2000, y: 250, width: 40, height: 80 });
});

test('canvas Android dimezzato viene riconciliato senza ruotare di nuovo i box OCR', () => {
  const page = classifyDocumentLayoutPage({
    pageIndex: 0,
    rawText: 'Preventivo N. Q-1',
    width: 1300,
    height: 919,
    ocrCanvasWidth: 1300,
    ocrCanvasHeight: 919,
    rotationDegrees: 90,
    lines: [{
      text: 'Preventivo N. Q-1',
      confidence: 0.9,
      boundingBox: { x: 2100, y: 220, width: 320, height: 48 },
    }],
  });
  assert.equal(page.width, 2600);
  assert.equal(page.height, 1838);
  assert.deepEqual(page.lines[0].boundingBox, { x: 2100, y: 220, width: 320, height: 48 });
});

test('un piccolo overflow estende il canvas esattamente senza salto artificiale a 2x', () => {
  const page = classifyDocumentLayoutPage({
    pageIndex: 0,
    rawText: 'Riga al margine',
    width: 1000,
    height: 1400,
    lines: [line('Riga al margine', 900, 120, 140, 30)],
  });
  assert.equal(page.width, 1040);
  assert.equal(page.height, 1456);
  assert.notEqual(page.width, 2000);
});

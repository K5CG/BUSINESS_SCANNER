import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCardFromPages } from '../lib/parser';
import { scanPagesLocally } from '../lib/local-ocr-pages';

function lines(rawText: string) {
  return rawText.split('\n').map((text, index) => ({
    text,
    confidence: 0.96,
    boundingBox: { x: 10, y: index * 26, width: 420, height: 20 },
  }));
}

test('V95: email osservata rimuove il nome duplicato soltanto quando conferma il cognome', () => {
  const card = parseCardFromPages([{
    rawText: 'Filippo Filippo De Guio\nfilippo.deguio@esqogito.com\nEsqogito',
    lines: lines('Filippo Filippo De Guio\nfilippo.deguio@esqogito.com\nEsqogito'),
  }]);
  assert.equal(card.firstName, 'Filippo');
  assert.equal(card.lastName, 'De Guio');
});

test('V95: indirizzo italiano osservato conserva citta e provincia senza frammenti spurii', () => {
  const rawText = 'Luca De Franceschi\nVia Campagnola, Nr. 21D - 36015 Schio (VI)';
  const card = parseCardFromPages([{ rawText, lines: lines(rawText) }]);
  assert.equal(card.address?.city, 'Schio');
  assert.equal(card.address?.region, 'VI');
  assert.match(card.address?.full ?? '', /36015 Schio \(VI\)/);
  assert.doesNotMatch(card.address?.full ?? '', /Schio \([vV]\)/);
});

test('V95: deadline OCR locale restituisce pagina incompleta e non attende una risposta tardiva', async () => {
  const started = Date.now();
  const result = await scanPagesLocally(['scan://slow'], async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { lines: [], text: '', quality: { heuristicQuality: 0, confidenceType: 'heuristic' as const, qualityReasons: [], requiresReview: true } };
  }, { deadline: Date.now() + 15, operationIdPrefix: 'v95-test' });
  assert.ok(Date.now() - started < 65);
  assert.equal(result.ocrWorked, false);
  assert.equal(result.pages[0]?.completed, false);
  assert.match(result.pages[0]?.error ?? '', /oltre il limite/i);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectBusinessCardBoundaryFromGray } from '../lib/business-card-boundary';

function makeGray(width: number, height: number) {
  const gray = new Uint8Array(width * height);
  gray.fill(100);
  const x1 = 28, x2 = width - 26, y1 = 20, y2 = height - 18;
  // Due bordi forti (alto/basso, delta 12) e due moderati (sx/dx, delta 7).
  for (let y = 0; y < height; y++) {
    for (let x = x1; x < x2; x++) {
      gray[y * width + x] = y >= y1 && y < y2 ? 107 : 95;
    }
  }
  return gray;
}

test('boundary: bordo moderatamente contrastato non obbliga a rifare la foto', () => {
  const width = 220, height = 140;
  const gray = makeGray(width, height);
  const result = detectBusinessCardBoundaryFromGray(gray, width, height);
  assert.ok(result, 'il rettangolo fisico centrato deve essere recuperato dal secondo passaggio');
  assert.ok(result!.areaRatio > 0.5 && result!.areaRatio < 0.9);
});

test('boundary: immagine uniforme resta rifiutata', () => {
  const width = 220, height = 140;
  const gray = new Uint8Array(width * height);
  gray.fill(128);
  assert.equal(detectBusinessCardBoundaryFromGray(gray, width, height), null);
});

test('boundary: rettangolo forte ma troppo decentrato viene rifiutato invece di tagliare il biglietto', () => {
  const width = 220, height = 140;
  const gray = new Uint8Array(width * height);
  gray.fill(40);
  const x1 = 5, x2 = 155, y1 = 10, y2 = 130;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) gray[y * width + x] = 220;
  }
  assert.equal(detectBusinessCardBoundaryFromGray(gray, width, height), null);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync('components/Camera/MultiPageScanner.tsx', 'utf8');

test('new camera sessions cannot inherit a permanently false overlay state', () => {
  assert.doesNotMatch(src, /useState\(true\).*documentOverlayReady|setDocumentOverlayReady\(/s);
  assert.match(src, /const documentOverlayReady =[\s\S]*cameraReady && documentViewportModeMaterialized/);
});

test('camera lifecycle still has explicit ready/session ownership', () => {
  assert.match(src, /cameraReady/);
  assert.match(src, /cameraSession/);
  assert.match(src, /onCameraReady=\{handleCameraReady\}/);
});

test('no document-category bypass exists', () => {
  assert.doesNotMatch(src, /delivery_document.*documentOverlayReady|proforma_invoice.*documentOverlayReady|generic_image.*documentOverlayReady/);
});

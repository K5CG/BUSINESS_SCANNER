import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync('components/Camera/MultiPageScanner.tsx', 'utf8');

test('document overlay readiness is deterministic from cameraReady and materialized viewport', () => {
  assert.match(
    src,
    /const documentOverlayReady\s*=\s*documentType === 'business_card' \|\|\s*\(cameraReady && documentViewportModeMaterialized\)/s
  );
  assert.doesNotMatch(src, /setDocumentOverlayReady\(/);
  assert.doesNotMatch(src, /setTimeout\(\(\) => setDocumentOverlayReady/);
});

test('document viewport is based on a real measured layout', () => {
  assert.match(src, /const viewportHasLayout = viewportSize\.width > 0 && viewportSize\.height > 0/);
  assert.match(src, /const documentViewportModeMaterialized =[\s\S]*viewportHasLayout/);
  assert.match(
    src,
    /onLayout=\{\(e\) => \{\s*const \{ width, height \} = e\.nativeEvent\.layout;\s*setViewportSize\(\{ width, height \}\);/s
  );
});

test('capture remains fail-closed for every document category', () => {
  // Production diagnostics deliberately expose the two independent fail-closed reasons.
  assert.match(
    src,
    /documentType !== 'business_card' && !documentViewportModeMaterialized\s*\?\s*'document_viewport_not_materialized'/s
  );
  assert.match(
    src,
    /documentType !== 'business_card' && !documentOverlayReady\s*\?\s*'document_overlay_not_ready'/s
  );
  assert.match(src, /if \(captureBlockReasons\.length > 0\)/);
  assert.doesNotMatch(
    src,
    /delivery_document.*documentOverlayReady|proforma_invoice.*documentOverlayReady|generic_document.*documentOverlayReady|generic_image.*documentOverlayReady/
  );
});

test('overlay rendering uses the same deterministic readiness as capture', () => {
  assert.match(src, /documentViewportModeMaterialized && documentOverlayReady/);
});

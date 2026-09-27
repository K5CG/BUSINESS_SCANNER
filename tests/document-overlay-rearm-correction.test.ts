import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = fs.readFileSync('components/Camera/MultiPageScanner.tsx', 'utf8');

test('session change does not erase a valid materialized viewport', () => {
  assert.doesNotMatch(
    src,
    /setViewportSize\(\(current\)[\s\S]*?\{ width: 0, height: 0 \}[\s\S]*?\[acquisitionSessionKey, documentType\]/
  );
});

test('overlay readiness is re-evaluated on session and camera readiness', () => {
  assert.match(src, /if \(!cameraReady \|\| !documentViewportModeMaterialized\)/);
  assert.match(
    src,
    /\[\s*acquisitionSessionKey,\s*cameraReady,\s*documentType,\s*documentViewportModeMaterialized,/s
  );
});

test('real parent viewport layout remains the geometry authority', () => {
  assert.match(
    src,
    /onLayout=\{\(e\) => \{\s*const \{ width, height \} = e\.nativeEvent\.layout;\s*setViewportSize\(\{ width, height \}\);/s
  );
  assert.match(
    src,
    /const documentViewportModeMaterialized =[\s\S]*viewportHasLayout && viewportIsLandscape === effectiveDocumentLandscape/
  );
});

test('capture remains fail-closed with no category bypass', () => {
  assert.match(src, /documentType !== 'business_card' && !documentOverlayReady/);
  assert.match(src, /document_overlay_not_ready/);
  assert.doesNotMatch(src, /delivery_document.*documentOverlayReady|proforma_invoice.*documentOverlayReady/);
});

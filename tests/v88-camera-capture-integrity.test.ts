import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { imagePipelineUris } from '../lib/image-preparation';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

// Compatibilità del gate introdotto in V88: V89 conserva lo stabilizzatore,
// ma corregge il contratto errato che aveva reso l'originale la foto mostrata.
test('V88/V89: stream stabilizzato prima dello scatto', () => {
  const session = read('components/Camera/useCameraSession.ts');
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(session, /CAPTURE_STABILIZATION_MS = 700/);
  assert.match(session, /cameraCaptureReady/);
  assert.match(scanner, /camera_stream_stabilizing/);
  assert.match(scanner, /disabled=\{scanning \|\| !cameraCaptureReady\}/);
});

test('V89: l’originale non sostituisce il ritaglio visuale', () => {
  const uris = imagePipelineUris('file:///cache/original.jpg', 'file:///cache/ocr-crop.jpg');
  assert.equal(uris.previewUri, uris.ocrPreparedUri);
  assert.equal(uris.persistenceSourceUri, uris.ocrPreparedUri);
  assert.notEqual(uris.persistenceSourceUri, uris.originalUri);
});

test('V89: l’originale viene separato e protetto per il ri-OCR', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /copyImageToDraftStorage\(imageUris\.originalUri\)/);
  assert.match(scanner, /originalUri: draftOriginalUri/);
  assert.match(scanner, /originalImageUris: cardOriginalImageUris/);
});

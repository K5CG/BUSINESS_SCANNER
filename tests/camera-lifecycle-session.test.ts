import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('camera lifecycle is keyed to acquisition session', () => {
  const source = fs.readFileSync('components/Camera/useCameraSession.ts', 'utf8');
  assert.match(source, /useCameraSession\(activationKey\?: string\)/);
  assert.match(source, /\}, \[activationKey\]\)\s*\);/);
});

test('scan screen passes acquisition identity into scanner', () => {
  const source = fs.readFileSync('app/scan/[type].tsx', 'utf8');
  assert.match(source, /acquisitionSessionKey=\{scannerSessionKey\}/);
});

test('scanner passes acquisition identity into camera-session hook', () => {
  const source = fs.readFileSync('components/Camera/MultiPageScanner.tsx', 'utf8');
  assert.match(source, /useCameraSession\(acquisitionSessionKey\)/);
});

test('shutter diagnostics expose silent capture guards', () => {
  const source = fs.readFileSync('components/Camera/MultiPageScanner.tsx', 'utf8');
  assert.match(source, /\[CameraCapture\] shutter_press/);
  assert.match(source, /\[CameraCapture\] blocked/);
  for (const reason of [
    'capture_in_progress',
    'processing_gate_locked',
    'camera_ref_missing',
    'camera_not_ready',
    'document_viewport_not_materialized',
    'document_overlay_not_ready',
  ]) {
    assert.match(source, new RegExp(reason));
  }
});

test('camera session diagnostics expose activate and ready events', () => {
  const source = fs.readFileSync('components/Camera/useCameraSession.ts', 'utf8');
  assert.match(source, /\[CameraSession\] activate/);
  assert.match(source, /\[CameraSession\] ready/);
});

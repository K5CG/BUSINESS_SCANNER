import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const scanner = fs.readFileSync('components/Camera/MultiPageScanner.tsx', 'utf8');
const orientation = fs.readFileSync('lib/card-orientation-fix.ts', 'utf8');

test('V94: portrait CameraView normalizes a landscape JPEG before the boundary plan', () => {
  assert.match(scanner, /captureWidth > captureHeight/);
  assert.match(scanner, /capture_axis_normalized_before_crop/);
  assert.ok(scanner.indexOf('capture_axis_normalized_before_crop') < scanner.indexOf('const plan = await buildScanPlan'));
});

test('V94: same-axis 180 reading order precedes quarter-turn alternatives', () => {
  assert.match(orientation, /const angles = \[0, 180, 90, 270\]/);
  assert.match(orientation, /ORIENT_OCR_TIMEOUT_MS = 3500/);
  assert.match(orientation, /reading_order_rotated/);
});

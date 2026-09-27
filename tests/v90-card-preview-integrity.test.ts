import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildScanManipulatorActions,
  NORMALIZED_SCAN_MAX_LONG_SIDE,
} from '../lib/image-utils';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('V90: the raw 3060x4080 camera size is reduced after business-card crop', () => {
  const plan = buildScanManipulatorActions(
    3060,
    4080,
    'business_card',
    'portrait',
    1530,
    2040,
  );
  const resize = plan.actions.find((action) => 'resize' in action) as
    | { resize: { width?: number; height?: number } }
    | undefined;

  assert.equal(NORMALIZED_SCAN_MAX_LONG_SIDE, 2000);
  assert.ok(resize, 'business-card pipeline must include a post-crop resize');
  assert.ok(Math.max(resize.resize.width ?? 0, resize.resize.height ?? 0) <= 2000);
});

test('V90: OCR rotation never replaces the persisted business-card preview', () => {
  const workflow = read('lib/scan-process-workflow.ts');
  assert.match(workflow, /const displayedImageUris = imageUris;/);
  assert.match(workflow, /buildBusinessCard\([\s\S]*displayedImageUris/);
  assert.doesNotMatch(workflow, /orientBusinessCardImages/);
});

test('V90: a failed derived preview falls back to its saved original instead of a blank tile', () => {
  const preview = read('components/DocumentImagesPreview.tsx');
  const detail = read('app/document/[id].tsx');
  assert.match(preview, /originalImages\?: string\[\]/);
  assert.match(preview, /setUseOriginalFallback/);
  assert.match(preview, /hasOriginalFallback/);
  assert.match(detail, /originalImages=\{document\.type === 'business_card' \? document\.originalImages : undefined\}/);
});

test('V90: post-shutter failures are reported as processing/persistence errors', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /let jpegCaptured = false;/);
  assert.match(scanner, /jpegCaptured = true;/);
  assert.match(scanner, /CAPTURE_PROCESSING_OR_PERSISTENCE_FAILED/);
  assert.match(scanner, /captureProcessingFailed/);
});

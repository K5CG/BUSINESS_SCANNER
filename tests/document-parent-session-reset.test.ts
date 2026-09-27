import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

test('ScanScreen parent resets captureMode on a new acquisition session', () => {
  const source = fs.readFileSync('app/scan/[type].tsx', 'utf8');
  assert.match(source, /setCaptureModeState\([\s\S]*captureModeParam[\s\S]*\)/);
  assert.match(source, /\[scanSessionParam, captureModeParam, documentType\]/);
});

test('document navigation always carries an explicit portrait start mode', () => {
  const source = fs.readFileSync('lib/document-scan-navigation.ts', 'utf8');
  assert.match(source, /captureMode=portrait/);
});

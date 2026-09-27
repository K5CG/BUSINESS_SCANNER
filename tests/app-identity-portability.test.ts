import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const CANONICAL = 'com.mybizscanner.ai';

test('app.json locks Android package and iOS bundle to canonical id', () => {
  const expo = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
  assert.equal(expo.android.package, CANONICAL);
  assert.equal(expo.ios.bundleIdentifier, CANONICAL);
  assert.equal(expo.ios.infoPlist.NSCameraUsageDescription.includes('fotocamera'), true);
  assert.ok(expo.ios.infoPlist.UISupportedInterfaceOrientations.includes('UIInterfaceOrientationPortrait'));
  assert.equal(
    expo.plugins.some(
      (plugin: unknown) =>
        Array.isArray(plugin) && plugin[0] === 'expo-screen-orientation',
    ),
    true,
  );
  assert.equal(JSON.stringify(expo).includes('NSContactsUsageDescription'), false);
  assert.equal(JSON.stringify(expo).includes('NSMicrophoneUsageDescription'), false);
  assert.equal(JSON.stringify(expo).includes('NSPhotoLibraryUsageDescription'), false);
});

test('app.config.js does not fall back to a shorter package id', () => {
  const src = fs.readFileSync(path.join(root, 'app.config.js'), 'utf8');
  assert.match(src, /CANONICAL_APP_ID = 'com\.mybizscanner\.ai'/);
  assert.doesNotMatch(src, /com\.ideebusiness\.cardscanner'/);
  assert.doesNotMatch(src, /com\.kfive\.businessscanner/);
});

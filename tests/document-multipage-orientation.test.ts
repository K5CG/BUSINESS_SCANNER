import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  planCapturedDocumentOrientation,
  type DocumentOrientationNormalizationInput,
} from '../lib/document-capture-orientation';
import {
  needsPortraitQuarterTurnProbe,
  needsProcessedVisualOrientationProbe,
  resolvePortraitQuarterTurnRotation,
} from '../lib/document-orientation-evidence';

const THERMOFLUX_PAGE2: DocumentOrientationNormalizationInput = {
  width: 4080,
  height: 3060,
  exifOrientation: 1,
  deviceOrientationAtCapture: 'portrait',
  previewOrientation: 'portrait',
  platform: 'android',
  cameraProcessingApplied: true,
};

test('ThermoFlux page2 portrait capture on landscape bitmap does not invent a quarter-turn', () => {
  const plan = planCapturedDocumentOrientation(THERMOFLUX_PAGE2);
  assert.equal(plan.rotationRequired, 0);
  assert.equal(needsPortraitQuarterTurnProbe(THERMOFLUX_PAGE2, plan), false);
});

test('QA 2026-08-29 page2: portrait state + landscape JPEG + EXIF assente richiede probe visuale', () => {
  const input: DocumentOrientationNormalizationInput = {
    ...THERMOFLUX_PAGE2,
    exifOrientation: null,
  };
  const plan = planCapturedDocumentOrientation(input);
  assert.equal(plan.rotationRequired, 0);
  assert.equal(needsProcessedVisualOrientationProbe(input, plan), true);
  assert.equal(needsPortraitQuarterTurnProbe(input, plan), true);
});

test('multipage session prefers 270 when page1 was upright portrait and scores tie', () => {
  const bands90 = { topInk: 0.5, bottomInk: 0.5 };
  const bands270 = { topInk: 0.52, bottomInk: 0.48 };
  const decision = resolvePortraitQuarterTurnRotation(bands90, bands270, {
    previousPages: [{
      rotationApplied: 0,
      normalizedWidth: 3060,
      normalizedHeight: 4080,
      sourceWidth: 3060,
      sourceHeight: 4080,
      captureOrientation: 'portrait',
    }],
  });
  assert.equal(decision.rotation, 270);
  assert.equal(decision.confidence, 'confident');
});

test('Medisupply ambiguous ink probe defaults to 90 without risky 270 override', () => {
  const bands90 = { topInk: 0.9028, bottomInk: 0.9167 };
  const bands270 = { topInk: 0.9028, bottomInk: 0.9167 };
  const decision = resolvePortraitQuarterTurnRotation(bands90, bands270);
  assert.equal(decision.rotation, 90);
  assert.equal(decision.confidence, 'ambiguous');
});

test('Motorparts landscape Android remains 270 not flipped by portrait probe', () => {
  const plan = planCapturedDocumentOrientation({
    width: 3060,
    height: 4080,
    exifOrientation: 1,
    deviceOrientationAtCapture: 'landscape-left',
    previewOrientation: 'landscape',
    platform: 'android',
    cameraProcessingApplied: true,
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(
    needsPortraitQuarterTurnProbe({
      width: 3060,
      height: 4080,
      exifOrientation: 1,
      deviceOrientationAtCapture: 'landscape-left',
      previewOrientation: 'landscape',
      platform: 'android',
      cameraProcessingApplied: true,
    }, plan),
    false,
  );
});

test('single portrait page without landscape bitmap skips portrait quarter-turn probe', () => {
  const plan = planCapturedDocumentOrientation({
    width: 3060,
    height: 4080,
    exifOrientation: 1,
    deviceOrientationAtCapture: 'portrait',
    previewOrientation: 'portrait',
    platform: 'android',
    cameraProcessingApplied: true,
  });
  assert.equal(plan.rotationRequired, 0);
  assert.equal(needsPortraitQuarterTurnProbe({
    width: 3060,
    height: 4080,
    exifOrientation: 1,
    deviceOrientationAtCapture: 'portrait',
    previewOrientation: 'portrait',
    platform: 'android',
    cameraProcessingApplied: true,
  }, plan), false);
});

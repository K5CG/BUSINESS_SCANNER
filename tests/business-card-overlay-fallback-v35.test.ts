import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldUseVerifiedOverlayFallback,
  type PreparedBusinessCardSharpnessResult,
} from '../lib/image-sharpness';

function result(
  overrides: Partial<PreparedBusinessCardSharpnessResult>,
): PreparedBusinessCardSharpnessResult {
  return {
    score: 300,
    sampleWidth: 320,
    sampleHeight: 190,
    cropWidth: 320,
    cropHeight: 190,
    passed: true,
    minZoneScore: 120,
    zoneScores: { center: 300 },
    medianZoneScore: 300,
    maxZoneScore: 400,
    measured: true,
    ...overrides,
  };
}

test('V35: bordo invisibile ma crop overlay verificato e nitido puo proseguire', () => {
  assert.equal(shouldUseVerifiedOverlayFallback(result({})), true);
});

test('V35: il fallback overlay non rende accettabile una foto realmente morbida', () => {
  assert.equal(shouldUseVerifiedOverlayFallback(result({ passed: false })), false);
});

test('V35: un errore della misura non viene scambiato per evidenza di leggibilita', () => {
  assert.equal(shouldUseVerifiedOverlayFallback(result({ measured: false, sampleWidth: 0 })), false);
});

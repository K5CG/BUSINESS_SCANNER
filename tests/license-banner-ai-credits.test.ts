import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveLicenseBannerAiCredits } from '../lib/license-banner-ai-credits';

test('banner shows durable balance 3', () => {
  assert.equal(resolveLicenseBannerAiCredits(3), 3);
});

test('banner shows zero credits as 0', () => {
  assert.equal(resolveLicenseBannerAiCredits(0), 0);
});

test('banner hides credits when null/undefined', () => {
  assert.equal(resolveLicenseBannerAiCredits(null), null);
  assert.equal(resolveLicenseBannerAiCredits(undefined), null);
});

test('LicenseBanner uses helper and existing i18n key without RC AI gate', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'components/LicenseBanner.tsx'),
    'utf8'
  );
  assert.doesNotMatch(src, /isRcCloudAiEnabled/);
  assert.match(src, /resolveLicenseBannerAiCredits/);
  assert.match(src, /licenseTrialAiCredits/);
  assert.doesNotMatch(src, /licenseTrialAiUnavailable/);
});

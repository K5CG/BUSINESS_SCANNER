import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveHydratedAccepted,
  shouldShowPrivacyConsentScreen,
} from '../lib/privacy-consent-hydration.ts';
import {
  getPrivacyConsentRecord,
  hasValidPrivacyConsent,
  markPrivacyConsentBackendSynced,
  savePrivacyConsent,
} from '../lib/privacy-consent.ts';
import {
  FALLBACK_PRIVACY_POLICY_URL,
  FALLBACK_PRIVACY_POLICY_VERSION,
  parsePrivacyPolicyVersion,
  parseSafePrivacyPolicyUrl,
} from '../lib/privacy-config.ts';
import {
  readPrivacySettingsCache,
  writePrivacySettingsCache,
} from '../lib/privacy-settings.ts';
import {
  resetLicenseFileStub,
  stubFileContents,
} from './stubs/expo-file-system-license-stub.ts';
import { resetSecureStoreStub } from './stubs/expo-secure-store-stub.ts';
import fs from 'node:fs';
import path from 'node:path';

test.beforeEach(() => {
  resetLicenseFileStub();
  resetSecureStoreStub();
});

test('A. first acceptance — local consent saved', async () => {
  await savePrivacyConsent({
    installationId: 'synth-install-aaaaaaaa',
    policyVersion: '1.0',
    backendSyncStatus: 'pending',
  });
  assert.equal(await hasValidPrivacyConsent('1.0'), true);
  const record = await getPrivacyConsentRecord();
  assert.equal(record?.backendSyncStatus, 'pending');
  assert.equal(record?.installationId, 'synth-install-aaaaaaaa');
});

test('gate shows privacy screen when not accepted', () => {
  assert.equal(shouldShowPrivacyConsentScreen(true, false), false);
  assert.equal(shouldShowPrivacyConsentScreen(false, false), true);
  assert.equal(shouldShowPrivacyConsentScreen(false, true), false);
});

test('C. server timestamp mark — local record stores backendAcceptedAt', async () => {
  await savePrivacyConsent({
    installationId: 'synth-install-bbbbbbbb',
    policyVersion: '1.0',
  });
  const serverTs = '2026-08-12T12:00:00.000Z';
  const synced = await markPrivacyConsentBackendSynced(serverTs);
  assert.equal(synced?.backendSyncStatus, 'synced');
  assert.equal(synced?.backendAcceptedAt, serverTs);
});

test('D. same install/version local overwrite stays single file record', async () => {
  await savePrivacyConsent({
    installationId: 'synth-install-cccccccc',
    policyVersion: '1.0',
  });
  await savePrivacyConsent({
    installationId: 'synth-install-cccccccc',
    policyVersion: '1.0',
  });
  const record = await getPrivacyConsentRecord();
  assert.equal(record?.policyVersion, '1.0');
  assert.equal(record?.installationId, 'synth-install-cccccccc');
});

test('E. new privacy version requires renewed local acceptance', async () => {
  await savePrivacyConsent({
    installationId: 'synth-install-dddddddd',
    policyVersion: '1.0',
  });
  assert.equal(await hasValidPrivacyConsent('1.0'), true);
  assert.equal(await hasValidPrivacyConsent('2026-10-01'), false);
});

test('F. backend unavailable — local acceptance survives pending', async () => {
  await savePrivacyConsent({
    installationId: 'synth-install-eeeeeeee',
    policyVersion: '1.0',
    backendSyncStatus: 'pending',
  });
  assert.equal(await hasValidPrivacyConsent('1.0'), true);
  const record = await getPrivacyConsentRecord();
  assert.equal(record?.backendSyncStatus, 'pending');
});

test('G. retry later marks synced once', async () => {
  await savePrivacyConsent({
    installationId: 'synth-install-ffffffff',
    policyVersion: '1.0',
    backendSyncStatus: 'pending',
  });
  await markPrivacyConsentBackendSynced('2026-08-12T13:00:00.000Z');
  const again = await markPrivacyConsentBackendSynced('2026-08-12T13:00:00.000Z');
  assert.equal(again?.backendSyncStatus, 'synced');
  assert.equal(again?.backendAcceptedAt, '2026-08-12T13:00:00.000Z');
});

test('H/I. DB URL resolution prefers provided DB value; change without rebuild', () => {
  const a = parseSafePrivacyPolicyUrl('https://www.mybizscanner.com/privacy/');
  const b = parseSafePrivacyPolicyUrl('https://newdomain.example/privacy');
  assert.equal(a, 'https://www.mybizscanner.com/privacy/');
  assert.equal(b, 'https://newdomain.example/privacy');
});

test('H2. retired businessscanner.app host falls back to current canonical privacy URL', () => {
  assert.equal(
    parseSafePrivacyPolicyUrl('https://www.businessscanner.app/privacy'),
    FALLBACK_PRIVACY_POLICY_URL
  );
});

test('J. invalid DB URL → safe fallback', () => {
  assert.equal(
    parseSafePrivacyPolicyUrl('javascript:alert(1)', FALLBACK_PRIVACY_POLICY_URL),
    FALLBACK_PRIVACY_POLICY_URL
  );
  assert.equal(
    parseSafePrivacyPolicyUrl('http://insecure.example/privacy', FALLBACK_PRIVACY_POLICY_URL),
    FALLBACK_PRIVACY_POLICY_URL
  );
  assert.equal(
    parseSafePrivacyPolicyUrl('not a url', FALLBACK_PRIVACY_POLICY_URL),
    FALLBACK_PRIVACY_POLICY_URL
  );
});

test('K. offline cache URL available', async () => {
  await writePrivacySettingsCache({
    privacyPolicyUrl: 'https://www.mybizscanner.com/privacy/',
    privacyPolicyVersion: '1.0',
    fetchedAt: '2026-08-12T10:00:00.000Z',
  });
  const cached = await readPrivacySettingsCache();
  assert.equal(cached?.privacyPolicyUrl, 'https://www.mybizscanner.com/privacy/');
  assert.equal(cached?.privacyPolicyVersion, '1.0');
  assert.equal(cached?.source, 'cache');
});

test('version parser rejects invalid values', () => {
  assert.equal(parsePrivacyPolicyVersion('1.0'), '1.0');
  assert.equal(parsePrivacyPolicyVersion('2026-08-12'), '2026-08-12');
  assert.equal(
    parsePrivacyPolicyVersion('bad version!', FALLBACK_PRIVACY_POLICY_VERSION),
    FALLBACK_PRIVACY_POLICY_VERSION
  );
});

test('storage write failure — error propagates and gate remains closed', async () => {
  const files = stubFileContents() as Map<string, string>;
  const originalWrite = files.set.bind(files);
  files.set = () => {
    throw new Error('disk_full');
  };
  await assert.rejects(() => savePrivacyConsent({ installationId: 'synth-fail-00000001' }), /disk_full/);
  assert.equal(await hasValidPrivacyConsent('1.0'), false);
  files.set = originalWrite;
});

test('hydration race — in-flight accept is not overwritten by stale read', () => {
  assert.equal(resolveHydratedAccepted(false, true, false), true);
  assert.equal(resolveHydratedAccepted(true, false, false), true);
  assert.equal(resolveHydratedAccepted(false, false, true), true);
  assert.equal(resolveHydratedAccepted(false, false, false), false);
});

test('L/M migration locks — anon cannot mutate privacy settings or enumerate consents', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/009_privacy_consent_and_settings.sql'),
    'utf8'
  );
  assert.match(sql, /REVOKE ALL ON TABLE public\.privacy_consents FROM anon/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.privacy_consents FROM authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.register_privacy_consent[\s\S]*TO service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_public_privacy_settings\(\) TO service_role/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.register_privacy_consent[\s\S]*TO anon/);
  assert.match(sql, /privacy_policy_url/);
  assert.match(sql, /privacy_policy_version/);
  assert.match(sql, /UNIQUE \(installation_id, privacy_version\)/);
});

test('fallback constants match current verified site URL and version 1.0', () => {
  assert.equal(FALLBACK_PRIVACY_POLICY_URL, 'https://mybizscanner.com/privacy');
  assert.equal(FALLBACK_PRIVACY_POLICY_VERSION, '1.0');
});

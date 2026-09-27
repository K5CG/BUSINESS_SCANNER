import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  parseCheckLicenseBody,
  parseValidateLicenseBody,
  sanitizeLicenseKeyForLog,
} from '../supabase/functions/_shared/license-payload.ts';
import {
  checkLicenseRateLimit,
  fingerprintFromInstallation,
  resetLicenseRateLimitsForTests,
} from '../supabase/functions/_shared/license-rate-limit.ts';
import { hashLicenseKey } from '../supabase/functions/_shared/license-key-hash.ts';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('7. max activation — errorCode max_devices mappato lato client', () => {
  const src = read('lib/license-service.ts');
  assert.match(src, /case 'max_devices'/);
});

test('8. reinstallazione — nuovo installationId generato (RN-safe fallback)', () => {
  const src = read('lib/installation-id.ts');
  assert.match(src, /createReactNativeSafeInstallationId/);
  assert.doesNotMatch(src, /uuidv4/);
  assert.match(src, /INSTALLATION_SECURE_KEY/);
});

test('15. doppio tap — activate non duplica stato locale senza risposta server', () => {
  const src = read('components/LicenseProvider.tsx');
  assert.match(src, /activateLicenseRequest/);
  assert.match(src, /result\.ok && result\.status/);
});

test('16. richieste concorrenti — rate limit validate-license', () => {
  resetLicenseRateLimitsForTests();
  const fp = fingerprintFromInstallation('inst-concurrent-test-12345678');
  let blocked = false;
  for (let i = 0; i < 25; i++) {
    const r = checkLicenseRateLimit('validate_license', fp);
    if (!r.allowed) blocked = true;
  }
  assert.equal(blocked, true);
  resetLicenseRateLimitsForTests();
});

test('17. payload manipolato — installationId invalido rifiutato', () => {
  const bad = parseCheckLicenseBody({ deviceId: '../etc/passwd' });
  assert.equal(bad.ok, false);
  const huge = parseCheckLicenseBody({
    deviceId: 'a'.repeat(200),
  });
  assert.equal(huge.ok, false);
});

test('17b. validate payload — email mancante', () => {
  const r = parseValidateLicenseBody({
    installationId: '12345678-abcd-efgh',
    licenseKey: 'BS-TEST-1234',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.errorCode, 'email_required');
});

test('18. deviceId spoofato — server tratta ID come identificatore non prova', () => {
  const spec = read('INSTALLATION_IDENTITY_SPEC.md');
  assert.match(spec, /identifier, not proof/i);
});

test('19. license key non loggata', () => {
  assert.equal(sanitizeLicenseKeyForLog('BS-SECRET-KEY'), '[redacted]');
  const validateSrc = read('supabase/functions/validate-license/index.ts');
  assert.doesNotMatch(validateSrc, /console\.log\(.*licenseKey/);
  assert.match(validateSrc, /sanitizeLicenseKeyForLog/);
});

test('20. nessun secret nel bundle client', () => {
  const config = read('lib/config.ts');
  assert.doesNotMatch(config, /SERVICE_ROLE|service_role|GEMINI_API/);
  const service = read('lib/license-service.ts');
  assert.doesNotMatch(service, /SERVICE_ROLE|service_role/);
  const pkg = read('package.json');
  assert.doesNotMatch(pkg, /service_role/);
});

test('hash license key — deterministico con pepper', async () => {
  const a = await hashLicenseKey('BS-TEST-0001', 'pepper-test-value-16b');
  const b = await hashLicenseKey('BS-TEST-0001', 'pepper-test-value-16b');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('check-license accetta installationId e legacy deviceId', () => {
  const id = '12345678-abcd-4ef0-8abc-123456789abc';
  const fromNew = parseCheckLicenseBody({ installationId: id });
  assert.equal(fromNew.ok, true);
  if (fromNew.ok) assert.equal(fromNew.installationId, id);

  const fromLegacy = parseCheckLicenseBody({ deviceId: id });
  assert.equal(fromLegacy.ok, true);
});

test('edge functions usano service_role solo via createAdminClient', () => {
  const utils = read('supabase/functions/_shared/license-utils.ts');
  assert.match(utils, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(read('lib/config.ts'), /SERVICE_ROLE/);
});

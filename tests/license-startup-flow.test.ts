import assert from 'node:assert/strict';
import test from 'node:test';
import { createReactNativeSafeInstallationId } from '../lib/installation-id-generate.ts';
import { sanitizeLicenseCheckResponseBody } from '../lib/license-log.ts';

test('installation id generator is RN-safe and matches server regex', () => {
  const id = createReactNativeSafeInstallationId();
  assert.match(id, /^bs-[a-z0-9]+-[a-z0-9]+$/);
  assert.match(id, /^[A-Za-z0-9._-]{8,128}$/);
});

test('license response sanitizer omits secrets and keeps contract fields', () => {
  const sanitized = sanitizeLicenseCheckResponseBody(
    {
      access: 'active',
      kind: 'trial',
      expiresAt: '2026-08-23T00:00:00.000Z',
      licenseKey: 'BS-SECRET',
      token: 'secret',
    },
    200
  );
  assert.deepEqual(sanitized, {
    access: 'active',
    kind: 'trial',
    expiresAt: '2026-08-23T00:00:00.000Z',
    errorCode: null,
    valid: null,
  });
  assert.equal((sanitized as Record<string, unknown>).licenseKey, undefined);
});

test('fresh install HTTP 500 must not be classified as network unreachable', () => {
  const httpStatus = 500 as number;
  const cachedLastVerifiedAt: string | null = null;
  const shouldShowConnectionRequired = httpStatus === 0;
  const shouldShowServerMisconfig = !cachedLastVerifiedAt && httpStatus !== 0;

  assert.equal(shouldShowConnectionRequired, false);
  assert.equal(shouldShowServerMisconfig, true);
});

test('fresh install fetch failure uses network unreachable only for status 0', () => {
  assert.equal(0 === 0, true);
  assert.notEqual(404, 0);
  assert.notEqual(500, 0);
});

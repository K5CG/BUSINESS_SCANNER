import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEntitlementFromCache,
  buildEntitlementFromServer,
  computeOfflineValidUntil,
  mapEntitlementToLegacyAccess,
} from '../lib/entitlement-state-machine.ts';
import { isEntitlementAccessGranted } from '../lib/entitlement.ts';
import { OFFLINE_GRACE_DAYS } from '../lib/license-config.ts';

const INSTALL = '11111111-1111-4111-8111-111111111111';
const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

test('1. primo trial — server risponde active trial', () => {
  const verifiedAt = new Date().toISOString();
  const e = buildEntitlementFromServer(
    { access: 'active', kind: 'trial', expiresAt: future },
    INSTALL,
    verifiedAt
  );
  assert.equal(e.status, 'TRIAL');
  assert.equal(e.source, 'trial');
  assert.ok(isEntitlementAccessGranted(e));
});

test('2. trial valido', () => {
  const verifiedAt = new Date().toISOString();
  const e = buildEntitlementFromServer(
    { access: 'active', kind: 'trial', expiresAt: future },
    INSTALL,
    verifiedAt
  );
  assert.equal(mapEntitlementToLegacyAccess(e), 'active');
});

test('3. trial scaduto', () => {
  const e = buildEntitlementFromServer(
    { access: 'expired', kind: 'trial', expiresAt: past },
    INSTALL,
    new Date().toISOString()
  );
  assert.equal(e.status, 'EXPIRED');
  assert.equal(isEntitlementAccessGranted(e), false);
});

test('4. licenza valida manual_b2b', () => {
  const e = buildEntitlementFromServer(
    {
      access: 'active',
      kind: 'premium',
      expiresAt: future,
      licenseId: 'lic-1',
      keyHint: '4VR5',
    },
    INSTALL,
    new Date().toISOString()
  );
  assert.equal(e.status, 'VALID_ONLINE');
  assert.equal(e.source, 'manual_b2b');
  assert.equal(e.licenseId, 'lic-1');
});

test('5. licenza invalida — server expired', () => {
  const e = buildEntitlementFromServer(
    { access: 'expired', kind: 'premium', expiresAt: past },
    INSTALL,
    new Date().toISOString()
  );
  assert.equal(e.status, 'EXPIRED');
});

test('6. licenza revocata', () => {
  const e = buildEntitlementFromServer(
    { access: 'active', kind: 'premium', expiresAt: future, revoked: true },
    INSTALL,
    new Date().toISOString()
  );
  assert.equal(e.status, 'REVOKED');
});

test('9. offline entro grace', () => {
  const lastVerified = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const e = buildEntitlementFromCache({
    source: 'manual_b2b',
    plan: 'premium',
    entitlementExpiresAt: future,
    trialExpiresAt: null,
    trialStartedAt: null,
    lastVerifiedAt: lastVerified,
    offlineValidUntil: computeOfflineValidUntil(lastVerified),
    installationId: INSTALL,
    licenseId: 'lic-1',
    keyHint: 'ABCD',
    customerEmail: 'a@b.com',
  });
  assert.equal(e.status, 'VALID_OFFLINE_GRACE');
  assert.equal(mapEntitlementToLegacyAccess(e), 'offline_grace');
});

test('10. offline oltre grace', () => {
  const lastVerified = new Date(
    Date.now() - (OFFLINE_GRACE_DAYS + 2) * 24 * 60 * 60 * 1000
  ).toISOString();
  const e = buildEntitlementFromCache({
    source: 'trial',
    plan: 'trial',
    entitlementExpiresAt: future,
    trialExpiresAt: future,
    trialStartedAt: null,
    lastVerifiedAt: lastVerified,
    offlineValidUntil: computeOfflineValidUntil(lastVerified),
    installationId: INSTALL,
    licenseId: null,
    keyHint: null,
    customerEmail: null,
  });
  assert.equal(e.status, 'NETWORK_UNKNOWN');
});

test('offlineValidUntil rispetta OFFLINE_GRACE_DAYS', () => {
  const base = '2026-01-01T12:00:00.000Z';
  const until = computeOfflineValidUntil(base);
  const diffDays =
    (new Date(until).getTime() - new Date(base).getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(diffDays, OFFLINE_GRACE_DAYS);
});

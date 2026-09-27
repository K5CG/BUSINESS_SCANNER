/**
 * Final trial policy tests: DB duration, expired read/export, acquisition blocks.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  COMMERCIAL_SETTING_KEYS,
  DEFAULT_TRIAL_DURATION_DAYS,
  parseBoundedTrialDurationDays,
  resolveTrialDurationDays,
  resolveTrialDurationDaysFromParts,
  setCommercialSettingIntReaderForTests,
} from '../lib/commercial-settings.ts';
import {
  getEntitlementCapabilities,
  isEntitlementAppEntryAllowed,
} from '../lib/entitlement-capabilities.ts';
import {
  buildEntitlementFromServer,
  emptyEntitlement,
} from '../lib/entitlement-state-machine.ts';
import { isEntitlementAccessGranted } from '../lib/entitlement.ts';

const root = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

test('A — DB duration safety fallback is 3 when setting read is unavailable', async () => {
  setCommercialSettingIntReaderForTests(async () => null);
  const resolved = await resolveTrialDurationDays({ env: {} });
  assert.equal(resolved.days, 3);
  assert.equal(resolved.source, 'code_fallback');
  assert.equal(DEFAULT_TRIAL_DURATION_DAYS, 3);
  assert.equal(COMMERCIAL_SETTING_KEYS.TRIAL_DURATION_DAYS, 'trial_duration_days');
});

test('B — synthetic Supabase trial_duration_days controls duration without code change', async () => {
  let dbValue = 3;
  setCommercialSettingIntReaderForTests(async (key) => {
    assert.equal(key, 'trial_duration_days');
    return dbValue;
  });
  assert.equal((await resolveTrialDurationDays({ env: {} })).days, 3);
  assert.equal((await resolveTrialDurationDays({ env: {} })).source, 'database');
  dbValue = 14;
  assert.equal((await resolveTrialDurationDays({ env: {} })).days, 14);
  setCommercialSettingIntReaderForTests(null);
});

test('C — existing trial_ends_at unchanged by duration resolver (stored timestamps)', () => {
  const ends = '2026-08-08T12:00:00.000Z';
  const entitlement = buildEntitlementFromServer(
    {
      access: 'active',
      kind: 'trial',
      expiresAt: ends,
      trialStartedAt: '2026-08-01T12:00:00.000Z',
      trialScanCount: 0,
      trialMaxScans: 20,
      trialDeviceStatus: 'active',
    },
    randomUUID(),
    new Date().toISOString()
  );
  assert.equal(entitlement.trialExpiresAt, ends);
});

test('D/E — expired can enter app and export existing data', () => {
  const entitlement = emptyEntitlement(randomUUID(), 'EXPIRED', 'trial', 'trial');
  assert.equal(isEntitlementAccessGranted(entitlement), false);
  assert.equal(isEntitlementAppEntryAllowed(entitlement), true);
  const caps = getEntitlementCapabilities(entitlement);
  assert.equal(caps.canReadExistingData, true);
  assert.equal(caps.canExportExistingData, true);
  assert.equal(caps.canEditExistingData, true);
  assert.equal(entitlement.features.export, true);
});

test('F/G/H — expired cannot scan card/document/import PDF', () => {
  const caps = getEntitlementCapabilities(
    emptyEntitlement(randomUUID(), 'EXPIRED', 'trial', 'trial')
  );
  assert.equal(caps.canCreateNewScan, false);
  assert.equal(caps.canImportPdf, false);
  assert.equal(caps.canUseAi, false);
});

test('I/J/K — expired capabilities block AI', () => {
  const caps = getEntitlementCapabilities(
    emptyEntitlement(randomUUID(), 'EXPIRED', 'trial', 'trial'),
    20
  );
  assert.equal(caps.canUseAi, false);
});

test('M — licensed full access capabilities', () => {
  const entitlement = buildEntitlementFromServer(
    {
      access: 'active',
      kind: 'premium',
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    },
    randomUUID(),
    new Date().toISOString()
  );
  assert.equal(isEntitlementAccessGranted(entitlement), true);
  const caps = getEntitlementCapabilities(entitlement, 10);
  assert.equal(caps.canCreateNewScan, true);
  assert.equal(caps.canExportExistingData, true);
});

test('N — offline expired empty entitlement still read-only capable when EXPIRED', () => {
  const entitlement = emptyEntitlement(randomUUID(), 'EXPIRED');
  const caps = getEntitlementCapabilities(entitlement);
  assert.equal(caps.canReadExistingData, true);
  assert.equal(caps.canCreateNewScan, false);
});

test('O — reinstall policy documented as accepted until Store (code markers)', () => {
  const spec = fs.readFileSync(path.join(root, 'INSTALLATION_IDENTITY_SPEC.md'), 'utf8');
  assert.match(spec, /new trial/i);
  const migration = fs.readFileSync(
    path.join(root, 'supabase/migrations/008_trial_duration_commercial_setting.sql'),
    'utf8'
  );
  assert.match(migration, /trial_duration_days/);
  assert.match(migration, /'3'/);
  assert.match(migration, /NEW trial/);
});

test('P — active trial capabilities allow scan', () => {
  const entitlement = buildEntitlementFromServer(
    {
      access: 'active',
      kind: 'trial',
      expiresAt: new Date(Date.now() + 3 * DAY_MS).toISOString(),
      trialStartedAt: new Date().toISOString(),
      trialScanCount: 0,
      trialMaxScans: 20,
      trialDeviceStatus: 'active',
    },
    randomUUID(),
    new Date().toISOString()
  );
  const caps = getEntitlementCapabilities(entitlement);
  assert.equal(caps.canCreateNewScan, true);
});

test('duration bounds reject invalid values', () => {
  assert.equal(parseBoundedTrialDurationDays(0), null);
  assert.equal(parseBoundedTrialDurationDays(-1), null);
  assert.equal(parseBoundedTrialDurationDays(366), null);
  assert.equal(parseBoundedTrialDurationDays('nope'), null);
  assert.equal(parseBoundedTrialDurationDays(14), 14);
  assert.equal(
    resolveTrialDurationDaysFromParts({
      env: { TRIAL_DURATION_EMERGENCY_OVERRIDE: 'true', TRIAL_DURATION_DAYS: '21' },
    }).source,
    'emergency_env'
  );
});

test('Supabase duration authority wiring — new trial reads app_commercial_settings.trial_duration_days', () => {
  const licenseUtils = fs.readFileSync(
    path.join(root, 'supabase/functions/_shared/license-utils.ts'),
    'utf8'
  );
  const trialUtils = fs.readFileSync(
    path.join(root, 'supabase/functions/_shared/trial-utils.ts'),
    'utf8'
  );
  assert.match(licenseUtils, /resolveEdgeTrialDurationDays/);
  assert.match(licenseUtils, /get_commercial_setting_int/);
  assert.match(trialUtils, /resolveTrialDurationDays/);
  assert.equal(COMMERCIAL_SETTING_KEYS.TRIAL_DURATION_DAYS, 'trial_duration_days');
});

test('gate + acquisition guard source wiring', () => {
  const gate = fs.readFileSync(path.join(root, 'components/LicenseGate.tsx'), 'utf8');
  assert.match(gate, /LicenseExpiredContinueScreen/);
  assert.match(gate, /expiredNoticeDismissed/);
  const home = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
  assert.match(home, /guardNewAcquisition/);
  const docs = fs.readFileSync(path.join(root, 'app/(tabs)/documents.tsx'), 'utf8');
  assert.match(docs, /guardNewAcquisition/);
  const scan = fs.readFileSync(path.join(root, 'app/scan/[type].tsx'), 'utf8');
  assert.match(scan, /alertTrialExpiredNewAcquisition/);
  for (const rel of [
    'supabase/functions/parse-document/index.ts',
    'supabase/functions/parse-pdf/index.ts',
    'supabase/functions/structure-business-card/index.ts',
  ]) {
    assert.match(
      fs.readFileSync(path.join(root, rel), 'utf8'),
      /assertCommercialAccess:\s*assertCommercialAccessForAi/
    );
  }
});

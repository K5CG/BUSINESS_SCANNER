/**
 * Synthetic trial expiry / reinstall harness.
 * Uses ONLY fake installation IDs — never touches a real device trial.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  buildEntitlementFromCache,
  buildEntitlementFromServer,
  computeOfflineValidUntil,
  mapEntitlementToLegacyAccess,
  type CachedEntitlementProof,
} from '../lib/entitlement-state-machine.ts';
import {
  isEntitlementAccessGranted,
  isEntitlementCloudAiAllowed,
} from '../lib/entitlement.ts';
import { OFFLINE_GRACE_DAYS, TRIAL_DAYS } from '../lib/license-config.ts';
import { RC_AI_DISABLED, RC_PDF_IMPORT_ALLOWED, RC_TRIAL_TIME_ONLY } from '../lib/release-rc-policy.ts';
import { readTrialCommercialConfig, TRIAL_CONFIG_DEFAULTS } from '../lib/trial-config.ts';
import { isTrialAccessActive, type TrialDeviceRow } from '../supabase/functions/_shared/trial-utils.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const root = path.resolve(__dirname, '..');

function addDays(from: Date, days: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

type SimRow = TrialDeviceRow & { creditsRemaining: number };

/** In-memory mirror of ensureTrialDevice + credit residual — synthetic only. */
class SyntheticTrialBackend {
  private readonly rows = new Map<string, SimRow>();
  private readonly paid = new Set<string>();

  firstInstall(installationId: string, now = new Date()): SimRow {
    assert.ok(!this.rows.has(installationId), 'must use fresh synthetic id');
    const config = readTrialCommercialConfig({});
    const row: SimRow = {
      device_id: installationId,
      installation_id: installationId,
      trial_started_at: now.toISOString(),
      trial_ends_at: addDays(now, config.trialDurationDays).toISOString(),
      created_at: now.toISOString(),
      status: 'active',
      scan_count: 0,
      max_scans_snapshot: config.trialMaxScans,
      last_seen_at: now.toISOString(),
      creditsRemaining: 20,
    };
    this.rows.set(installationId, row);
    return { ...row };
  }

  check(installationId: string, now = new Date()): {
    access: 'active' | 'expired';
    row: SimRow | null;
    commerciallyActive: boolean;
  } {
    if (this.paid.has(installationId)) {
      return {
        access: 'active',
        row: this.rows.get(installationId) ?? null,
        commerciallyActive: true,
      };
    }
    const existing = this.rows.get(installationId);
    if (!existing) {
      return {
        access: 'active',
        row: this.firstInstall(installationId, now),
        commerciallyActive: true,
      };
    }
    const row = { ...existing, last_seen_at: now.toISOString() };
    this.rows.set(installationId, row);
    const active = isTrialAccessActiveAt(row, now.getTime());
    return {
      access: active ? 'active' : 'expired',
      row,
      commerciallyActive: active,
    };
  }

  expireRow(installationId: string, now = new Date()): void {
    const row = this.rows.get(installationId);
    assert.ok(row);
    // Force server-side expiry well in the past so clock spoof cannot revive it.
    row.trial_ends_at = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    row.status = 'expired';
  }

  markPaid(installationId: string): void {
    this.paid.add(installationId);
  }

  canCallAi(installationId: string, now = new Date()): {
    allowed: boolean;
    reason: 'ok' | 'license_inactive' | 'insufficient_credits';
  } {
    const { commerciallyActive, row } = this.check(installationId, now);
    if (!commerciallyActive) return { allowed: false, reason: 'license_inactive' };
    if (!row || row.creditsRemaining <= 0) {
      return { allowed: false, reason: 'insufficient_credits' };
    }
    return { allowed: true, reason: 'ok' };
  }
}

function isTrialAccessActiveAt(row: TrialDeviceRow, nowMs: number): boolean {
  const ends = new Date(row.trial_ends_at).getTime();
  if (!Number.isFinite(ends) || ends <= nowMs) return false;
  const max = row.max_scans_snapshot ?? 20;
  const scans = row.scan_count ?? 0;
  if (scans >= max) return false;
  return (row.status ?? 'active') === 'active';
}

function gateForAccess(access: ReturnType<typeof mapEntitlementToLegacyAccess>): {
  screen: 'app' | 'activation' | 'offline' | 'loading';
  voluntaryBack: boolean;
} {
  if (access === 'loading') return { screen: 'loading', voluntaryBack: false };
  if (access === 'offline_blocked' || access === 'network_unknown') {
    return { screen: 'offline', voluntaryBack: false };
  }
  if (access === 'expired' || access === 'revoked') {
    return { screen: 'activation', voluntaryBack: false };
  }
  if (access === 'active' || access === 'offline_grace') {
    return { screen: 'app', voluntaryBack: false };
  }
  return { screen: 'activation', voluntaryBack: false };
}

test('duration safety fallback — 3 days; Supabase remains production source', () => {
  assert.equal(TRIAL_CONFIG_DEFAULTS.trialDurationDays, 3);
  assert.equal(TRIAL_DAYS, 3);
  assert.equal(readTrialCommercialConfig({}).trialDurationDays, 3);
  assert.equal(
    readTrialCommercialConfig({
      TRIAL_DURATION_EMERGENCY_OVERRIDE: 'true',
      TRIAL_DURATION_DAYS: '14',
    }).trialDurationDays,
    14
  );
  // Without emergency flag, TRIAL_DURATION_DAYS alone does not change sync config.
  assert.equal(
    readTrialCommercialConfig({ TRIAL_DURATION_DAYS: '14' }).trialDurationDays,
    3
  );
});

test('A/B — first install + same identity before expiry → active', () => {
  const backend = new SyntheticTrialBackend();
  const id = randomUUID();
  const day0 = new Date('2026-08-01T12:00:00.000Z');
  const first = backend.firstInstall(id, day0);
  assert.equal(isTrialAccessActiveAt(first, day0.getTime()), true);

  // Verifica realmente PRIMA della scadenza commerciale di 3 giorni.
  // A esattamente 3 * DAY_MS il trial è correttamente scaduto.
  const beforeExpiry = new Date(day0.getTime() + 2 * DAY_MS);
  const again = backend.check(id, beforeExpiry);
  assert.equal(again.access, 'active');
  assert.equal(again.row?.trial_started_at, first.trial_started_at);
});

test('C — same identity after day 8 → expired', () => {
  const backend = new SyntheticTrialBackend();
  const id = randomUUID();
  const day0 = new Date('2026-08-01T12:00:00.000Z');
  backend.firstInstall(id, day0);
  const day8 = new Date(day0.getTime() + 8 * DAY_MS);
  const result = backend.check(id, day8);
  assert.equal(result.access, 'expired');
  assert.equal(result.commerciallyActive, false);
});

test('D — reinstall with SAME installationId → remains expired', () => {
  const backend = new SyntheticTrialBackend();
  const id = randomUUID();
  const day0 = new Date('2026-08-01T12:00:00.000Z');
  backend.firstInstall(id, day0);
  backend.expireRow(id, new Date(day0.getTime() + 8 * DAY_MS));
  const reinstall = backend.check(id, new Date(day0.getTime() + 9 * DAY_MS));
  assert.equal(reinstall.access, 'expired');
  assert.equal(reinstall.commerciallyActive, false);
});

test('E — NEW installationId (uninstall wipe) → new trial granted', () => {
  const backend = new SyntheticTrialBackend();
  const oldId = randomUUID();
  const day0 = new Date('2026-08-01T12:00:00.000Z');
  backend.firstInstall(oldId, day0);
  backend.expireRow(oldId, new Date(day0.getTime() + 8 * DAY_MS));

  const newId = randomUUID();
  const day9 = new Date(day0.getTime() + 9 * DAY_MS);
  const fresh = backend.check(newId, day9);
  assert.equal(fresh.access, 'active');
  assert.notEqual(newId, oldId);
  assert.equal(fresh.commerciallyActive, true);
});

test('expired + leftover credits — AI blocked after commercial gate', () => {
  const backend = new SyntheticTrialBackend();
  const id = randomUUID();
  const day0 = new Date('2026-08-01T12:00:00.000Z');
  backend.firstInstall(id, day0);
  backend.expireRow(id);
  const row = backend.check(id).row!;
  assert.ok(row.creditsRemaining > 0);
  const ai = backend.canCallAi(id);
  assert.equal(ai.allowed, false);
  assert.equal(ai.reason, 'license_inactive');
});

test('paid activation still allows AI after trial end', () => {
  const backend = new SyntheticTrialBackend();
  const id = randomUUID();
  backend.firstInstall(id);
  backend.expireRow(id);
  backend.markPaid(id);
  assert.equal(backend.canCallAi(id).allowed, true);
});

test('day-8 UX maps to expired entry + continue interstitial (not hard dead-end)', () => {
  const installationId = randomUUID();
  const verifiedAt = new Date().toISOString();
  const entitlement = buildEntitlementFromServer(
    {
      access: 'expired',
      kind: 'trial',
      expiresAt: new Date(Date.now() - DAY_MS).toISOString(),
      trialStartedAt: new Date(Date.now() - 8 * DAY_MS).toISOString(),
      trialScanCount: 0,
      trialMaxScans: 20,
      trialDeviceStatus: 'expired',
    },
    installationId,
    verifiedAt
  );
  assert.equal(entitlement.status, 'EXPIRED');
  assert.equal(isEntitlementAccessGranted(entitlement), false);
  assert.equal(entitlement.features.export, true);
  const access = mapEntitlementToLegacyAccess(entitlement);
  assert.equal(access, 'expired');
  assert.deepEqual(gateForAccess(access), {
    screen: 'activation',
    voluntaryBack: false,
  });
});

test('LicenseGate source — expired continue + activation, no store CTA', () => {
  const gate = fs.readFileSync(path.join(root, 'components', 'LicenseGate.tsx'), 'utf8');
  assert.match(gate, /LicenseExpiredContinueScreen/);
  assert.match(gate, /expiredNoticeDismissed/);
  const activation = fs.readFileSync(
    path.join(root, 'components', 'LicenseActivationScreen.tsx'),
    'utf8'
  );
  assert.match(activation, /licenseExpiredTitle/);
  assert.match(activation, /licenseActivate/);
  assert.match(activation, /licenseContactHint/);
  assert.doesNotMatch(activation, /Play Store|App Store|billing|purchaseProduct/i);
});

test('offline grace — active cache within grace opens app; expired cache does not', () => {
  const installationId = randomUUID();
  const now = Date.now();
  const activeProof: CachedEntitlementProof = {
    source: 'trial',
    plan: 'trial',
    entitlementExpiresAt: new Date(now + 2 * DAY_MS).toISOString(),
    lastVerifiedAt: new Date(now - DAY_MS).toISOString(),
    offlineValidUntil: computeOfflineValidUntil(new Date(now - DAY_MS).toISOString()),
    installationId,
    licenseId: null,
    keyHint: null,
    customerEmail: null,
    trialStartedAt: new Date(now - DAY_MS).toISOString(),
    trialExpiresAt: new Date(now + 2 * DAY_MS).toISOString(),
    trialScanCount: 0,
    trialMaxScans: 20,
  };
  assert.equal(OFFLINE_GRACE_DAYS, 7);
  const offlineActive = buildEntitlementFromCache(activeProof, now);
  assert.ok(['TRIAL', 'VALID_OFFLINE_GRACE'].includes(offlineActive.status));
  assert.equal(isEntitlementAccessGranted(offlineActive), true);

  const expiredProof: CachedEntitlementProof = {
    ...activeProof,
    entitlementExpiresAt: new Date(now - DAY_MS).toISOString(),
    trialExpiresAt: new Date(now - DAY_MS).toISOString(),
    offlineValidUntil: new Date(now + DAY_MS).toISOString(),
  };
  const offlineExpired = buildEntitlementFromCache(expiredProof, now);
  assert.equal(offlineExpired.status, 'EXPIRED');
  assert.equal(isEntitlementAccessGranted(offlineExpired), false);
});

test('clock back on client can keep offline cache; server row stays expired', () => {
  const installationId = randomUUID();
  const verifiedAt = '2026-08-01T12:00:00.000Z';
  const proof: CachedEntitlementProof = {
    source: 'trial',
    plan: 'trial',
    entitlementExpiresAt: '2099-08-08T12:00:00.000Z',
    lastVerifiedAt: verifiedAt,
    offlineValidUntil: computeOfflineValidUntil(verifiedAt),
    installationId,
    licenseId: null,
    keyHint: null,
    customerEmail: null,
    trialStartedAt: '2026-08-01T12:00:00.000Z',
    trialExpiresAt: '2099-08-08T12:00:00.000Z',
    trialScanCount: 0,
    trialMaxScans: 20,
  };
  // Grace window ended relative to lastVerified (2026-08-01 + 7d)
  const afterGrace = new Date('2026-08-10T12:00:00.000Z').getTime();
  assert.equal(buildEntitlementFromCache(proof, afterGrace).status, 'NETWORK_UNKNOWN');
  // Device clock rolled back inside grace
  const spoofedNow = new Date('2026-08-03T12:00:00.000Z').getTime();
  assert.equal(isEntitlementAccessGranted(buildEntitlementFromCache(proof, spoofedNow)), true);

  const backend = new SyntheticTrialBackend();
  backend.firstInstall(installationId, new Date('2026-08-01T12:00:00.000Z'));
  backend.expireRow(installationId, new Date('2026-08-09T12:00:00.000Z'));
  assert.equal(
    backend.check(installationId, new Date('2026-08-03T12:00:00.000Z')).access,
    'expired'
  );
});

test('RC flags unchanged by this audit', () => {
  assert.equal(RC_TRIAL_TIME_ONLY, true);
  assert.equal(RC_AI_DISABLED, true);
  assert.equal(RC_PDF_IMPORT_ALLOWED, true);
});

test('production AI handlers wire assertCommercialAccess', () => {
  for (const rel of [
    'supabase/functions/parse-document/index.ts',
    'supabase/functions/parse-pdf/index.ts',
    'supabase/functions/structure-business-card/index.ts',
  ]) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(src, /assertCommercialAccess:\s*assertCommercialAccessForAi/);
  }
  const handlers = fs.readFileSync(
    path.join(root, 'supabase/functions/_shared/document-edge-handlers.ts'),
    'utf8'
  );
  assert.match(handlers, /LICENSE_INACTIVE/);
  assert.match(handlers, /assertCommercialAccess/);
});

test('i18n expiry copy present IT/EN', () => {
  const en = JSON.parse(fs.readFileSync(path.join(root, 'i18n/en.json'), 'utf8'));
  const it = JSON.parse(fs.readFileSync(path.join(root, 'i18n/it.json'), 'utf8'));
  assert.equal(en.licenseExpiredTitle, 'Trial period ended');
  assert.equal(it.licenseExpiredTitle, 'Periodo di prova terminato');
  assert.match(en.licenseExpiredBody, /free trial has ended/);
  assert.match(it.licenseExpiredBody, /prova gratuita/);
  assert.match(en.licenseContactHint, /Contact your provider/);
  assert.match(it.licenseContactHint, /contatta il fornitore/);
});

test('isTrialAccessActive rejects past ends_at', () => {
  const past = new Date(Date.now() - DAY_MS).toISOString();
  const future = new Date(Date.now() + DAY_MS).toISOString();
  assert.equal(
    isTrialAccessActive({
      device_id: 'x',
      trial_started_at: past,
      trial_ends_at: past,
      created_at: past,
      status: 'active',
      scan_count: 0,
      max_scans_snapshot: 20,
    }),
    false
  );
  assert.equal(
    isTrialAccessActive({
      device_id: 'x',
      trial_started_at: past,
      trial_ends_at: future,
      created_at: past,
      status: 'active',
      scan_count: 0,
      max_scans_snapshot: 20,
    }),
    true
  );
});

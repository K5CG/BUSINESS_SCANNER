import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  InMemoryAiCreditLedger,
  getSharedAiCreditLedger,
  resetSharedAiCreditLedger,
} from '../lib/ai-credit/ledger.ts';
import {
  ensureTrialCreditGrant,
  ensurePremiumMonthlyCreditGrant,
  resetAiCreditLedgerPortForTests,
} from '../supabase/functions/_shared/ai-credit-bootstrap.ts';

process.env.AI_CREDIT_LEDGER_BACKEND = 'memory';
import { buildEntitlementFromServer } from '../lib/entitlement-state-machine.ts';
import { isEntitlementAccessGranted } from '../lib/entitlement.ts';
import {
  readTrialCommercialConfig,
  TRIAL_CONFIG_DEFAULTS,
  TRIAL_CONFIG_ENV,
} from '../lib/trial-config.ts';
import {
  premiumMonthlyGrantOperationId,
  premiumMonthlyGrantReferenceId,
  premiumMonthlyPeriodKey,
} from '../lib/trial-monthly-grant.ts';
import {
  resolveTrialLookupInstallationId,
  simulateRecordTrialScan,
} from '../lib/trial-record-scan-logic.ts';
import {
  InMemoryTrialScanLedger,
  resetSharedTrialScanLedger,
} from '../lib/trial-scan-ledger.ts';
import {
  recordTrialScanLocally,
  shouldCountTrialScanEvent,
} from '../lib/trial-scan-service.ts';
import {
  resolveTrialAccess,
  trialIsActive,
  trialScansRemaining,
} from '../lib/trial-status.ts';

const INSTALL = '11111111-1111-4111-8111-111111111111';
const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function trialSnapshot(overrides: Partial<Parameters<typeof trialIsActive>[0]> = {}) {
  return {
    trialStartedAt: new Date().toISOString(),
    trialExpiresAt: future,
    scanCount: 0,
    maxScans: 20,
    status: 'active' as const,
    ...overrides,
  };
}

test('1. trial safety fallback — 3 days config', () => {
  const config = readTrialCommercialConfig({});
  assert.equal(config.trialDurationDays, 3);
});

test('2. new trial defaults — max 20 scans config', () => {
  const config = readTrialCommercialConfig({});
  assert.equal(config.trialMaxScans, 20);
});

test('3. scan 1 increments count to 1', () => {
  resetSharedTrialScanLedger();
  const op = randomUUID();
  const result = recordTrialScanLocally({
    installationId: INSTALL,
    operationId: op,
    skipTrialAccounting: false,
    event: 'document_persisted',
  });
  assert.ok(result);
  assert.equal(result!.scanCount, 1);
});

test('4. scan 20 ends trial (scan budget)', () => {
  const snapshot = trialSnapshot({ scanCount: 20 });
  assert.equal(trialIsActive(snapshot), false);
  assert.equal(resolveTrialAccess(snapshot).reason, 'scans');
});

test('5. scan 21 blocked — remaining zero at 20', () => {
  assert.equal(trialScansRemaining(trialSnapshot({ scanCount: 20 })), 0);
  assert.equal(trialScansRemaining(trialSnapshot({ scanCount: 21 })), 0);
});

test('6. configured trial expiry ends trial (time)', () => {
  const snapshot = trialSnapshot({ trialExpiresAt: past });
  assert.equal(trialIsActive(snapshot), false);
  assert.equal(resolveTrialAccess(snapshot).reason, 'time');
});

test('7. 20 scans before configured expiry ends trial', () => {
  const snapshot = trialSnapshot({ scanCount: 20, trialExpiresAt: future });
  assert.equal(trialIsActive(snapshot), false);
});

test('8. configured expiry before 20 scans ends trial', () => {
  const snapshot = trialSnapshot({ scanCount: 5, trialExpiresAt: past });
  assert.equal(trialIsActive(snapshot), false);
});

test('9. AI credits 0 does not end trial local access', () => {
  const e = buildEntitlementFromServer(
    {
      access: 'active',
      kind: 'trial',
      expiresAt: future,
      trialScanCount: 5,
      trialMaxScans: 20,
      trialDeviceStatus: 'active',
    },
    INSTALL,
    new Date().toISOString(),
    0
  );
  assert.equal(e.status, 'TRIAL');
  assert.ok(isEntitlementAccessGranted(e));
  assert.equal(e.features.scan, true);
  assert.equal(e.features.cloudAi, false);
});

test('10. retry same scan operation does not double count', () => {
  resetSharedTrialScanLedger();
  const op = randomUUID();
  const first = recordTrialScanLocally({
    installationId: INSTALL,
    operationId: op,
    skipTrialAccounting: false,
    event: 'document_persisted',
  });
  const second = recordTrialScanLocally({
    installationId: INSTALL,
    operationId: op,
    skipTrialAccounting: false,
    event: 'document_persisted',
  });
  assert.equal(first!.scanCount, 1);
  assert.equal(second!.duplicate, true);
  assert.equal(second!.scanCount, 1);
});

test('11. retake photo event is not counted', () => {
  assert.equal(shouldCountTrialScanEvent('camera_open'), false);
});

test('12. OCR error before result is not counted', () => {
  assert.equal(shouldCountTrialScanEvent('ocr_error_before_result'), false);
});

test('13. multipage document uses single operation id — one scan', () => {
  resetSharedTrialScanLedger();
  const op = `multipage-${randomUUID()}`;
  recordTrialScanLocally({
    installationId: INSTALL,
    operationId: op,
    skipTrialAccounting: false,
    event: 'document_persisted',
  });
  const ledger = new InMemoryTrialScanLedger();
  ledger.recordScan({ installationId: INSTALL, operationId: op });
  assert.equal(ledger.getScanCount(INSTALL), 1);
});

test('14. premium skips trial scan accounting', () => {
  resetSharedTrialScanLedger();
  const result = recordTrialScanLocally({
    installationId: INSTALL,
    operationId: randomUUID(),
    skipTrialAccounting: true,
    event: 'document_persisted',
  });
  assert.equal(result, null);
});

test('15. trial AI grant code fallback is 20 credits', async () => {
  resetAiCreditLedgerPortForTests();
  const balance = await ensureTrialCreditGrant(INSTALL, null);
  assert.equal(balance, TRIAL_CONFIG_DEFAULTS.aiTrialGrantCredits);
  assert.equal(TRIAL_CONFIG_DEFAULTS.aiTrialGrantCredits, 20);
});

test('16. trial AI grant is idempotent', async () => {
  resetAiCreditLedgerPortForTests();
  const a = await ensureTrialCreditGrant(INSTALL, null);
  const b = await ensureTrialCreditGrant(INSTALL, null);
  assert.equal(a, b);
});

test('17. reinstall same installation does not regenerate trial grant', async () => {
  resetAiCreditLedgerPortForTests();
  await ensureTrialCreditGrant(INSTALL, null);
  const balanceAgain = await ensureTrialCreditGrant(INSTALL, null);
  const ledger = getSharedAiCreditLedger();
  const account = ledger.getOrCreateAccount(INSTALL, null);
  const grants = ledger
    .listTransactions(account.id)
    .filter((t) => t.transactionType === 'trial_grant');
  assert.equal(grants.length, 1);
  assert.equal(balanceAgain, TRIAL_CONFIG_DEFAULTS.aiTrialGrantCredits);
});

test('18. premium monthly grant idempotent per license and month', async () => {
  resetAiCreditLedgerPortForTests();
  process.env[TRIAL_CONFIG_ENV.AI_PREMIUM_MONTHLY_GRANT_CREDITS] = '20';
  const licenseId = randomUUID();
  const a = await ensurePremiumMonthlyCreditGrant(INSTALL, licenseId);
  const b = await ensurePremiumMonthlyCreditGrant(INSTALL, licenseId);
  assert.equal(a, 20);
  assert.equal(b, 20);
  delete process.env[TRIAL_CONFIG_ENV.AI_PREMIUM_MONTHLY_GRANT_CREDITS];
  const period = premiumMonthlyPeriodKey();
  assert.match(
    premiumMonthlyGrantOperationId(licenseId, period),
    new RegExp(`premium-monthly-grant:${licenseId}:${period}`)
  );
});

test('19. migration preserves legacy trial rows — no delete/truncate', () => {
  const root = process.cwd();
  const sql = fs.readFileSync(
    path.join(root, 'SUPABASE_PHASE_3BC_CONSOLIDATED_MIGRATION.sql'),
    'utf8'
  );
  assert.doesNotMatch(sql, /DELETE FROM public\.trial_devices/i);
  assert.doesNotMatch(sql, /TRUNCATE public\.trial_devices/i);
  assert.match(sql, /Legacy rows \(e\.g\. ~84 pre-production test installs\)/);
});

test('20. no hardcoded store prices in trial/licensing modules', () => {
  const root = process.cwd();
  const files = [
    'lib/trial-config.ts',
    'lib/license-config.ts',
    'components/LicenseBanner.tsx',
    'supabase/functions/check-license/index.ts',
  ];
  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(content, /7[,.]99/);
    assert.doesNotMatch(content, /59[,.]99/);
    assert.doesNotMatch(content, /€/);
  }
});

test('21. legacy device_id = installation_id lookup resolves trial row', () => {
  const legacyId = 'legacy-device-abc12345';
  assert.ok(
    resolveTrialLookupInstallationId(legacyId, {
      installationId: legacyId,
      deviceId: legacyId,
    })
  );
});

test('22. installation_id distinct from device_id resolves by installation_id', () => {
  assert.ok(
    resolveTrialLookupInstallationId('inst-new-identity1', {
      installationId: 'inst-new-identity1',
      deviceId: 'legacy-device-old0001',
    })
  );
  assert.equal(
    resolveTrialLookupInstallationId('unknown-installation', {
      installationId: 'inst-new-identity1',
      deviceId: 'legacy-device-old0001',
    }),
    false
  );
});

test('23. unknown installation_id — simulate not found via SQL contract', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'SUPABASE_PHASE_3BC_CONSOLIDATED_MIGRATION.sql'),
    'utf8'
  );
  assert.match(sql, /RAISE EXCEPTION 'trial_not_found'/);
});

test('24. duplicate installation_id prevented by unique index in migration', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'SUPABASE_PHASE_3BC_CONSOLIDATED_MIGRATION.sql'),
    'utf8'
  );
  assert.match(sql, /idx_trial_devices_installation_unique/);
});

test('25. scan 20th authorized when count starts at 19', () => {
  const op = randomUUID();
  const result = simulateRecordTrialScan({
    state: {
      installationId: INSTALL,
      deviceId: 'legacy-dev-001',
      status: 'active',
      trialExpiresAt: future,
      scanCount: 19,
      maxScans: 20,
    },
    operationId: op,
    recordedOperationIds: new Set(),
  });
  assert.equal(result.recorded, true);
  assert.equal(result.state.scanCount, 20);
  assert.equal(result.state.status, 'expired_scans');
  assert.equal(result.trialActive, false);
});

test('26. scan rejected when count already 20 — no increment', () => {
  const result = simulateRecordTrialScan({
    state: {
      installationId: INSTALL,
      deviceId: 'legacy-dev-001',
      status: 'active',
      trialExpiresAt: future,
      scanCount: 20,
      maxScans: 20,
    },
    operationId: randomUUID(),
    recordedOperationIds: new Set(),
  });
  assert.equal(result.rejected, true);
  assert.equal(result.rejectReason, 'expired_scans');
  assert.equal(result.state.scanCount, 20);
  assert.equal(result.recorded, false);
});

test('27. expired trial time rejects scan before increment', () => {
  const result = simulateRecordTrialScan({
    state: {
      installationId: INSTALL,
      deviceId: INSTALL,
      status: 'active',
      trialExpiresAt: past,
      scanCount: 5,
      maxScans: 20,
    },
    operationId: randomUUID(),
    recordedOperationIds: new Set(),
  });
  assert.equal(result.rejected, true);
  assert.equal(result.rejectReason, 'expired_time');
  assert.equal(result.state.scanCount, 5);
  assert.equal(result.recorded, false);
});

test('28. new trial snapshots TRIAL_MAX_SCANS; duration uses emergency ENV or DB', () => {
  process.env[TRIAL_CONFIG_ENV.TRIAL_MAX_SCANS] = '25';
  process.env[TRIAL_CONFIG_ENV.TRIAL_DURATION_EMERGENCY_OVERRIDE] = 'true';
  process.env[TRIAL_CONFIG_ENV.TRIAL_DURATION_DAYS] = '9';
  const config = readTrialCommercialConfig(process.env);
  assert.equal(config.trialMaxScans, 25);
  assert.equal(config.trialDurationDays, 9);
  const edge = fs.readFileSync(
    path.join(process.cwd(), 'supabase/functions/_shared/license-utils.ts'),
    'utf8'
  );
  assert.match(edge, /max_scans_snapshot: config\.trialMaxScans/);
  assert.match(edge, /resolveEdgeTrialDurationDays/);
  delete process.env[TRIAL_CONFIG_ENV.TRIAL_MAX_SCANS];
  delete process.env[TRIAL_CONFIG_ENV.TRIAL_DURATION_DAYS];
  delete process.env[TRIAL_CONFIG_ENV.TRIAL_DURATION_EMERGENCY_OVERRIDE];
});

test('29. premium monthly — different operation_id same month does not double grant', async () => {
  resetAiCreditLedgerPortForTests();
  process.env[TRIAL_CONFIG_ENV.AI_PREMIUM_MONTHLY_GRANT_CREDITS] = '20';
  const licenseId = randomUUID();
  const period = premiumMonthlyPeriodKey();
  const ref = premiumMonthlyGrantReferenceId(licenseId, period);
  const ledger = getSharedAiCreditLedger();
  await ensurePremiumMonthlyCreditGrant(INSTALL, licenseId);
  ledger.grant({
    installationId: INSTALL,
    licenseId,
    amount: 20,
    source: 'manual_b2b',
    referenceId: ref,
    operationId: `other-op-${randomUUID()}`,
    transactionType: 'grant',
  });
  const account = ledger.getOrCreateAccount(INSTALL, licenseId);
  const monthlyGrants = ledger
    .listTransactions(account.id)
    .filter((t) => t.referenceId === ref);
  assert.equal(monthlyGrants.length, 1);
  delete process.env[TRIAL_CONFIG_ENV.AI_PREMIUM_MONTHLY_GRANT_CREDITS];
});

test('30. premium monthly — next calendar month allows new grant reference', () => {
  const licenseId = randomUUID();
  const jan = premiumMonthlyGrantReferenceId(licenseId, '2026-01');
  const feb = premiumMonthlyGrantReferenceId(licenseId, '2026-02');
  assert.notEqual(jan, feb);
  assert.match(jan, /^premium-monthly:/);
});

test('31. installation_id FK target uses UNIQUE constraint not partial index', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'SUPABASE_PHASE_3BC_CONSOLIDATED_MIGRATION.sql'),
    'utf8'
  );
  assert.match(sql, /trial_devices_installation_id_unique UNIQUE \(installation_id\)/);
  assert.match(sql, /DROP INDEX IF EXISTS public\.idx_trial_devices_installation_unique/);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_devices_installation_unique/);
  assert.match(sql, /trial_scan_events_installation_fk/);
  const post = fs.readFileSync(
    path.join(process.cwd(), 'SUPABASE_PHASE_3BC_POSTDEPLOY_VERIFY.sql'),
    'utf8'
  );
  assert.match(post, /trial_devices_installation_id_unique/);
  assert.match(post, /4j_no_partial_installation_index/);
});

test('32. resolve rejects inactive license and trial before account create', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'SUPABASE_PHASE_3BC_CONSOLIDATED_MIGRATION.sql'),
    'utf8'
  );
  const resolveBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.resolve_ai_credit_account'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.expire_ai_credit_reservations')
  );
  assert.match(resolveBlock, /RAISE EXCEPTION 'license_not_active'/);
  assert.match(resolveBlock, /RAISE EXCEPTION 'trial_not_active'/);
});

test('33. get balance returns unavailable without creating account for bad entitlement', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'SUPABASE_PHASE_3BC_CONSOLIDATED_MIGRATION.sql'),
    'utf8'
  );
  const balanceBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.get_ai_credit_balance'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.grant_ai_credits')
  );
  assert.doesNotMatch(balanceBlock, /resolve_ai_credit_account/);
  assert.match(balanceBlock, /v_entitlement_ok/);
});

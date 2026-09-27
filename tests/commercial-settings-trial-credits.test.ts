import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  COMMERCIAL_SETTING_KEYS,
  DEFAULT_TRIAL_AI_CREDITS,
  parseBoundedTrialAiCredits,
  resolveTrialAiCredits,
  resolveTrialAiCreditsFromParts,
  setCommercialSettingIntReaderForTests,
  TRIAL_AI_CREDITS_MAX,
} from '../lib/commercial-settings.ts';
import { TRIAL_CONFIG_DEFAULTS } from '../lib/trial-config.ts';
import {
  ensureTrialCreditGrant,
  resetAiCreditLedgerPortForTests,
} from '../supabase/functions/_shared/ai-credit-bootstrap.ts';
import { resetSharedAiCreditLedger } from '../lib/ai-credit/ledger.ts';

process.env.AI_CREDIT_LEDGER_BACKEND = 'memory';

function resetAll(): void {
  delete process.env.AI_TRIAL_GRANT_EMERGENCY_OVERRIDE;
  delete process.env.AI_TRIAL_GRANT_CREDITS;
  setCommercialSettingIntReaderForTests(null);
  resetAiCreditLedgerPortForTests();
  resetSharedAiCreditLedger();
}

test('code fallback DEFAULT_TRIAL_AI_CREDITS is 20', () => {
  assert.equal(DEFAULT_TRIAL_AI_CREDITS, 20);
  assert.equal(TRIAL_CONFIG_DEFAULTS.aiTrialGrantCredits, 20);
});

test('parseBoundedTrialAiCredits rejects invalid values', () => {
  assert.equal(parseBoundedTrialAiCredits(null), null);
  assert.equal(parseBoundedTrialAiCredits(undefined), null);
  assert.equal(parseBoundedTrialAiCredits(''), null);
  assert.equal(parseBoundedTrialAiCredits('abc'), null);
  assert.equal(parseBoundedTrialAiCredits(-1), null);
  assert.equal(parseBoundedTrialAiCredits(1.5), null);
  assert.equal(parseBoundedTrialAiCredits(TRIAL_AI_CREDITS_MAX + 1), null);
  assert.equal(parseBoundedTrialAiCredits(20), 20);
  assert.equal(parseBoundedTrialAiCredits('30'), 30);
});

test('resolution prefers emergency env over DB', () => {
  const resolved = resolveTrialAiCreditsFromParts({
    env: {
      AI_TRIAL_GRANT_EMERGENCY_OVERRIDE: 'true',
      AI_TRIAL_GRANT_CREDITS: '7',
    },
    dbValue: 20,
  });
  assert.deepEqual(resolved, { amount: 7, source: 'emergency_env' });
});

test('resolution uses DB when emergency override off', () => {
  const resolved = resolveTrialAiCreditsFromParts({
    env: { AI_TRIAL_GRANT_CREDITS: '5' },
    dbValue: 20,
  });
  assert.deepEqual(resolved, { amount: 20, source: 'database' });
});

test('resolution falls back to code when DB missing/invalid', () => {
  assert.deepEqual(
    resolveTrialAiCreditsFromParts({ env: {}, dbValue: null }),
    { amount: 20, source: 'code_fallback' }
  );
  assert.deepEqual(
    resolveTrialAiCreditsFromParts({ env: {}, dbValue: 'nope' }),
    { amount: 20, source: 'code_fallback' }
  );
  assert.deepEqual(
    resolveTrialAiCreditsFromParts({ env: {}, dbValue: 999999 }),
    { amount: 20, source: 'code_fallback' }
  );
});

test('A. DB value 20 → new trial receives 20', async () => {
  resetAll();
  setCommercialSettingIntReaderForTests(async () => 20);
  const installationId = randomUUID();
  const balance = await ensureTrialCreditGrant(installationId, null);
  assert.equal(balance, 20);
});

test('B. DB value 30 → new trial receives 30 without code change', async () => {
  resetAll();
  setCommercialSettingIntReaderForTests(async () => 30);
  const installationId = randomUUID();
  const balance = await ensureTrialCreditGrant(installationId, null);
  assert.equal(balance, 30);
});

test('C. existing previously granted trial → no top-up', async () => {
  resetAll();
  setCommercialSettingIntReaderForTests(async () => 5);
  const installationId = randomUUID();
  const first = await ensureTrialCreditGrant(installationId, null);
  assert.equal(first, 5);
  setCommercialSettingIntReaderForTests(async () => 20);
  const again = await ensureTrialCreditGrant(installationId, null);
  assert.equal(again, 5);
});

test('D. same installation repeated → no duplicate grant', async () => {
  resetAll();
  setCommercialSettingIntReaderForTests(async () => 20);
  const installationId = randomUUID();
  const a = await ensureTrialCreditGrant(installationId, null);
  const b = await ensureTrialCreditGrant(installationId, null);
  assert.equal(a, 20);
  assert.equal(b, 20);
});

test('E. DB unavailable → code fallback 20', async () => {
  resetAll();
  setCommercialSettingIntReaderForTests(async () => {
    throw new Error('db_down');
  });
  const resolved = await resolveTrialAiCredits({
    env: {},
    readDbInt: async () => {
      throw new Error('db_down');
    },
  });
  assert.deepEqual(resolved, { amount: 20, source: 'code_fallback' });

  const installationId = randomUUID();
  const balance = await ensureTrialCreditGrant(installationId, null);
  assert.equal(balance, 20);
});

test('F. invalid DB values are rejected (bounded)', async () => {
  resetAll();
  for (const bad of [null, -3, 'x', 50_000_000, 12.5]) {
    setCommercialSettingIntReaderForTests(async () => bad as number);
    const resolved = await resolveTrialAiCredits({
      env: {},
      readDbInt: async () => (bad as number | null),
    });
    assert.equal(resolved.source, 'code_fallback');
    assert.equal(resolved.amount, 20);
  }
});

test('migration 007 seeds trial_ai_credits=20 and locks privileges', () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), 'supabase/migrations/007_commercial_settings.sql'),
    'utf8'
  );
  assert.match(sql, /app_commercial_settings/);
  assert.match(sql, /trial_ai_credits/);
  assert.match(sql, /'20'/);
  assert.match(sql, /get_commercial_setting_int/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.app_commercial_settings FROM anon/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.app_commercial_settings FROM authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.get_commercial_setting_int/);
  assert.match(sql, /TO service_role/);
  assert.equal(COMMERCIAL_SETTING_KEYS.TRIAL_AI_CREDITS, 'trial_ai_credits');
});

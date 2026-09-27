import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

const consolidated = () => read('SUPABASE_PHASE_3BC_CONSOLIDATED_MIGRATION.sql');
const postdeploy = () => read('SUPABASE_PHASE_3BC_POSTDEPLOY_VERIFY.sql');

test('preflight SQL is read-only (no mutations)', () => {
  const sql = read('SUPABASE_PHASE_3BC_PREFLIGHT_READONLY.sql');
  assert.match(sql, /PREFLIGHT_READONLY/i);
  assert.doesNotMatch(sql, /\bINSERT\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\b/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /\bCREATE TABLE\b/i);
  assert.match(sql, /information_schema/);
  assert.match(sql, /app_licenses/);
  assert.match(sql, /duplicate_license_keys/);
});

test('postdeploy verify SQL is read-only', () => {
  const sql = postdeploy();
  assert.match(sql, /POSTDEPLOY_VERIFY/i);
  assert.doesNotMatch(sql, /\bINSERT INTO\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\b/i);
  assert.doesNotMatch(sql, /\bDELETE FROM\b/i);
  assert.doesNotMatch(sql, /\bDROP TABLE\b/i);
  assert.doesNotMatch(sql, /\bCREATE TABLE\b/i);
  assert.match(sql, /idx_ai_credit_tx_idempotent/);
  assert.match(sql, /acquire_ai_rate_limit_count/);
  assert.match(sql, /ledger_reconciliation/);
});

test('consolidated migration includes required sections', () => {
  const sql = consolidated();
  assert.match(sql, /Phase 3B/i);
  assert.match(sql, /ai_usage_daily/);
  assert.match(sql, /edge_ai_rate_windows/);
  assert.match(sql, /edge_ai_request_leases/);
  assert.match(sql, /acquire_edge_ai_request/);
  assert.match(sql, /ai_credit_accounts/);
  assert.match(sql, /owner_kind/);
  assert.match(sql, /ai_credit_transactions/);
  assert.match(sql, /edge_ai_credit_reservations/);
  assert.match(sql, /resolve_ai_credit_account/);
  assert.match(sql, /grant_ai_credits/);
  assert.match(sql, /reserve_ai_credits/);
  assert.match(sql, /commit_ai_credit_usage/);
  assert.match(sql, /release_ai_credit_reservation/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = ''/);
  assert.match(sql, /REVOKE ALL ON TABLE/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION .* TO service_role/);
});

test('consolidated migration excludes destructive 003 and duplicate rate RPC', () => {
  const sql = consolidated();
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /DELETE FROM public\.app_licenses/i);
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.acquire_ai_rate_limit/);
  assert.match(sql, /acquire_ai_rate_limit from 3C draft intentionally OMITTED/i);
});

test('consolidated migration uses transaction boundary', () => {
  const sql = consolidated();
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /^COMMIT;/m);
});

test('consolidated migration documents pepper outside DB', () => {
  const sql = consolidated();
  assert.match(sql, /LICENSE_KEY_PEPPER/);
  assert.match(sql, /NEVER commit pepper/i);
  assert.doesNotMatch(sql, /pepper\s*=\s*'[a-z0-9]+'/i);
});

test('integration review documents 004/005 evaluation', () => {
  const md = read('PHASE_3BC_INTEGRATION_REVIEW.md');
  assert.match(md, /004/);
  assert.match(md, /005/);
  assert.match(md, /acquire_ai_rate_limit/);
  assert.match(md, /owner_kind/);
  assert.match(md, /ZERO MODIFICHE SUPABASE REMOTO|zero remote/i);
});

test('RPC security matrix covers admin RPC isolation', () => {
  const md = read('RPC_SECURITY_MATRIX.md');
  assert.match(md, /grant_ai_credits/);
  assert.match(md, /refund_ai_credits/);
  assert.match(md, /service_role/);
  assert.match(md, /search_path/);
});

test('edge deploy matrix lists all five functions', () => {
  const md = read('EDGE_DEPLOY_MATRIX.md');
  for (const fn of [
    'check-license',
    'validate-license',
    'parse-document',
    'parse-pdf',
    'structure-business-card',
  ]) {
    assert.match(md, new RegExp(fn));
  }
  assert.match(md, /after SQL/i);
});

test('rollback plan preserves ledger', () => {
  const md = read('SUPABASE_PHASE_3BC_ROLLBACK_PLAN.md');
  assert.match(md, /Never DELETE/i);
  assert.match(md, /append-only/i);
  assert.match(md, /Edge rollback/i);
});

test('consolidated owner model — license shared across activations', () => {
  const sql = consolidated();
  assert.match(sql, /v_owner_kind := 'license'/);
  assert.match(sql, /v_owner_kind := 'trial_installation'/);
  const review = read('PHASE_3BC_INTEGRATION_REVIEW.md');
  assert.match(review, /shared balance/i);
});

test('initial credits are env-configurable not hardcoded in SQL', () => {
  const sql = consolidated();
  assert.doesNotMatch(sql, /DEFAULT 150/);
  assert.match(sql, /AI_TRIAL_GRANT_CREDITS/);
  assert.match(sql, /AI_PREMIUM_MONTHLY_GRANT_CREDITS/);
  assert.match(sql, /TRIAL_DURATION_DAYS/);
  assert.match(sql, /TRIAL_MAX_SCANS/);
});

test('trial scan accounting in consolidated migration', () => {
  const sql = consolidated();
  assert.match(sql, /trial_scan_events/);
  assert.match(sql, /record_trial_scan/);
  assert.match(sql, /scan_count/);
  assert.match(sql, /max_scans_snapshot/);
  assert.match(sql, /trial_scan_events_idempotent/);
  assert.match(sql, /trial_devices_installation_id_unique UNIQUE \(installation_id\)/);
  assert.match(sql, /DROP INDEX IF EXISTS public\.idx_trial_devices_installation_unique/);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_devices_installation_unique/);
  assert.match(sql, /trial_scan_events_installation_fk/);
  assert.match(sql, /WHERE t\.installation_id = p_installation_id/);
  assert.doesNotMatch(sql, /WHERE t\.device_id = p_installation_id/);
  assert.match(sql, /v_rejected/);
  assert.match(sql, /reject_reason/);
  assert.match(postdeploy(), /4h_trial_device_columns/);
  assert.match(postdeploy(), /4h_trial_scan_count_valid/);
  assert.match(postdeploy(), /4j_trial_installation_unique/);
  assert.match(postdeploy(), /4j_no_partial_installation_index/);
  assert.match(postdeploy(), /4j_trial_scan_events_installation_fk/);
  assert.match(postdeploy(), /record_trial_scan/);
});

test('resolve_ai_credit_account validates entitlement before new account insert', () => {
  const sql = consolidated();
  const resolveBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.resolve_ai_credit_account'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.expire_ai_credit_reservations')
  );
  assert.match(resolveBlock, /license_not_active/);
  assert.match(resolveBlock, /trial_not_active/);
  assert.match(resolveBlock, /l\.revoked = false/);
  assert.match(resolveBlock, /l\.status = 'active'/);
  assert.match(resolveBlock, /t\.installation_id = p_installation_id/);
  assert.match(resolveBlock, /t\.trial_ends_at > v_now/);
  assert.match(resolveBlock, /t\.scan_count < COALESCE\(t\.max_scans_snapshot, 20\)/);
  assert.match(resolveBlock, /Existing accounts are returned without entitlement re-validation/i);
});

test('get_ai_credit_balance does not auto-create account on read', () => {
  const sql = consolidated();
  const balanceBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.get_ai_credit_balance'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.grant_ai_credits')
  );
  assert.doesNotMatch(balanceBlock, /resolve_ai_credit_account/);
  assert.match(balanceBlock, /never auto-create on balance read/i);
  assert.match(balanceBlock, /'unavailable'/);
  assert.match(balanceBlock, /'none'/);
});

test('premium monthly grant idempotent by license and period reference', () => {
  const sql = consolidated();
  assert.match(sql, /premium-monthly:/);
  assert.match(sql, /idx_ai_credit_tx_premium_monthly_ref/);
  const monthlyBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.grant_premium_monthly_ai_credits'),
    sql.indexOf('-- License check/validate rate limit persistence')
  );
  assert.match(monthlyBlock, /t\.reference_id = v_reference_id/);
  const grantBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.grant_ai_credits'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.reserve_ai_credits')
  );
  assert.match(grantBlock, /p_reference_id LIKE 'premium-monthly:%'/);
});

test('global unique owner — not partial active-only index', () => {
  const sql = consolidated();
  assert.match(sql, /ai_credit_accounts_owner_unique UNIQUE \(owner_kind, owner_ref\)/);
  assert.doesNotMatch(sql, /idx_ai_credit_owner_active/);
  assert.doesNotMatch(sql, /WHERE status = 'active'\s*\)\s*;/);
});

test('resolve finds account regardless of status — no active-only filter', () => {
  const sql = consolidated();
  const resolveBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.resolve_ai_credit_account'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.expire_ai_credit_reservations')
  );
  assert.match(resolveBlock, /One logical account per owner regardless of status/i);
  assert.doesNotMatch(resolveBlock, /AND a\.status = 'active'/);
});

test('resolve uses ON CONFLICT for concurrent same-owner requests', () => {
  const sql = consolidated();
  assert.match(sql, /ON CONFLICT ON CONSTRAINT ai_credit_accounts_owner_unique DO NOTHING/);
  assert.match(sql, /FOR UPDATE/);
});

test('suspended account cannot resurrect via new active insert', () => {
  const sql = consolidated();
  const resolveBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.resolve_ai_credit_account'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.expire_ai_credit_reservations')
  );
  assert.match(resolveBlock, /IF FOUND THEN/);
  assert.match(resolveBlock, /Existing accounts are returned without entitlement re-validation/i);
  const validationIdx = resolveBlock.indexOf('Defense-in-depth');
  const insertIdx = resolveBlock.indexOf('INSERT INTO public.ai_credit_accounts');
  assert.ok(validationIdx > 0 && insertIdx > validationIdx);
});

test('closed and suspended accounts blocked on grant and reserve', () => {
  const sql = consolidated();
  assert.match(sql, /RAISE EXCEPTION 'account_closed'/);
  assert.match(sql, /RAISE EXCEPTION 'account_suspended'/);
  const grantBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.grant_ai_credits'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.reserve_ai_credits')
  );
  assert.match(grantBlock, /invalid_grant_transaction_type/);
  assert.match(grantBlock, /trial_grant/);
  assert.doesNotMatch(grantBlock, /'consume'/);
});

test('grant rejects consume as positive grant transaction_type', () => {
  const sql = consolidated();
  const grantBlock = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.grant_ai_credits'),
    sql.indexOf('CREATE OR REPLACE FUNCTION public.reserve_ai_credits')
  );
  assert.match(
    grantBlock,
    /p_transaction_type NOT IN \(\s*'grant', 'refund', 'purchase', 'admin_adjustment', 'trial_grant', 'promotional_grant'\s*\)/
  );
});

test('legacy revoked boolean backfilled to status', () => {
  const sql = consolidated();
  assert.match(sql, /revoked = true THEN 'revoked'/);
  assert.match(sql, /ELSE 'active' END/);
  assert.match(sql, /revoked_at = COALESCE\(revoked_at, created_at\)/);
  assert.doesNotMatch(sql, /UPDATE public\.app_licenses[\s\S]*SET license_key/i);
});

test('legacy issued_at initialized from created_at', () => {
  const sql = consolidated();
  assert.match(sql, /SET issued_at = created_at/);
  const issuedIdx = sql.indexOf('SET issued_at = created_at');
  const notNullIdx = sql.indexOf('ALTER COLUMN issued_at SET NOT NULL');
  assert.ok(issuedIdx > 0 && notNullIdx > issuedIdx);
});

test('existing licenses preserved — no destructive license mutation', () => {
  const sql = consolidated();
  assert.doesNotMatch(sql, /DELETE FROM public\.app_licenses/i);
  assert.doesNotMatch(sql, /UPDATE public\.app_licenses[\s\S]*SET license_key/i);
  assert.doesNotMatch(sql, /DROP COLUMN.*license_key/i);
});

test('trial_devices untouched by migration DDL', () => {
  const sql = consolidated();
  assert.doesNotMatch(sql, /DELETE FROM public\.trial_devices/i);
  assert.doesNotMatch(sql, /TRUNCATE public\.trial_devices/i);
  assert.match(postdeploy(), /4g_trial_devices_count/);
});

test('postdeploy verifies owner unique and legacy backfill', () => {
  const sql = postdeploy();
  assert.match(sql, /ai_credit_accounts_owner_unique/);
  assert.match(sql, /4d_revoked_status_alignment/);
  assert.match(sql, /4e_issued_at_from_created_at/);
  assert.match(sql, /4f_duplicate_credit_owners/);
  assert.match(sql, /4c_no_partial_owner_index/);
});

test('same license maps to single owner_ref balance', () => {
  const sql = consolidated();
  assert.match(sql, /v_owner_ref := p_license_id::text/);
  assert.match(sql, /owner_kind = 'license'/);
  assert.match(sql, /ai_credit_accounts_owner_unique/);
});

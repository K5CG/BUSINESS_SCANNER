-- =============================================================================
-- 006_ai_credit_ledger.sql
-- Durable commercial AI credit ledger cutover (Postgres).
--
-- Remote already has owner_kind/owner_ref tables + baseline RPCs from the
-- Phase 3BC consolidated apply. This migration:
--   • keeps that account ownership model (license | trial_installation)
--   • hardens reserve/commit/release idempotency
--   • journals release events
--   • restores balance on TTL expire (via release)
--   • locks mutations to service_role
--
-- Does NOT redefine 001–005 objects. Does NOT change AI cost policy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Ensure 'release' is a valid journal type
-- -----------------------------------------------------------------------------

ALTER TABLE public.ai_credit_transactions
  DROP CONSTRAINT IF EXISTS ai_credit_transactions_transaction_type_check;

ALTER TABLE public.ai_credit_transactions
  ADD CONSTRAINT ai_credit_transactions_transaction_type_check
  CHECK (transaction_type IN (
    'grant',
    'consume',
    'refund',
    'purchase',
    'admin_adjustment',
    'trial_grant',
    'promotional_grant',
    'release'
  ));

-- -----------------------------------------------------------------------------
-- 2. RLS / table privileges (deny client writes)
-- -----------------------------------------------------------------------------

ALTER TABLE public.ai_credit_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_ai_credit_reservations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ai_credit_accounts FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_credit_accounts FROM anon;
REVOKE ALL ON TABLE public.ai_credit_accounts FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ai_credit_accounts TO service_role;

REVOKE ALL ON TABLE public.ai_credit_transactions FROM PUBLIC;
REVOKE ALL ON TABLE public.ai_credit_transactions FROM anon;
REVOKE ALL ON TABLE public.ai_credit_transactions FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.ai_credit_transactions TO service_role;

REVOKE ALL ON TABLE public.edge_ai_credit_reservations FROM PUBLIC;
REVOKE ALL ON TABLE public.edge_ai_credit_reservations FROM anon;
REVOKE ALL ON TABLE public.edge_ai_credit_reservations FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.edge_ai_credit_reservations TO service_role;

-- -----------------------------------------------------------------------------
-- 3. resolve_ai_credit_account
-- Edge remains the entitlement gate. RPC creates/looks up the durable owner
-- account without requiring trial_devices/app_licenses rows (avoids QA
-- isolate-memory bootstrap coupling).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_ai_credit_account(
  p_installation_id text,
  p_license_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_kind text;
  v_owner_ref text;
  v_account_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9._-]{8,128}$' THEN
    RAISE EXCEPTION 'invalid_installation_id';
  END IF;

  IF p_license_id IS NOT NULL THEN
    v_owner_kind := 'license';
    v_owner_ref := p_license_id::text;
  ELSE
    v_owner_kind := 'trial_installation';
    v_owner_ref := p_installation_id;
  END IF;

  SELECT a.id INTO v_account_id
  FROM public.ai_credit_accounts AS a
  WHERE a.owner_kind = v_owner_kind
    AND a.owner_ref = v_owner_ref
  FOR UPDATE;

  IF FOUND THEN
    IF v_owner_kind = 'license' THEN
      UPDATE public.ai_credit_accounts AS a
      SET primary_installation_id = p_installation_id, updated_at = v_now
      WHERE a.id = v_account_id;
    END IF;
    RETURN v_account_id;
  END IF;

  INSERT INTO public.ai_credit_accounts (
    owner_kind, owner_ref, license_id, primary_installation_id, balance, status
  )
  VALUES (
    v_owner_kind,
    v_owner_ref,
    p_license_id,
    p_installation_id,
    0,
    'active'
  )
  ON CONFLICT ON CONSTRAINT ai_credit_accounts_owner_unique DO NOTHING
  RETURNING id INTO v_account_id;

  IF v_account_id IS NULL THEN
    SELECT a.id INTO v_account_id
    FROM public.ai_credit_accounts AS a
    WHERE a.owner_kind = v_owner_kind
      AND a.owner_ref = v_owner_ref
    FOR UPDATE;
  END IF;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'account_resolve_failed';
  END IF;

  RETURN v_account_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. release_ai_credit_reservation (idempotent + journal)
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.release_ai_credit_reservation(uuid);

CREATE OR REPLACE FUNCTION public.release_ai_credit_reservation(
  p_reservation_id uuid
)
RETURNS TABLE (
  released boolean,
  balance_after integer,
  duplicate boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_res public.edge_ai_credit_reservations%ROWTYPE;
  v_balance integer;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN QUERY SELECT FALSE, 0, FALSE;
    RETURN;
  END IF;

  SELECT r.* INTO v_res
  FROM public.edge_ai_credit_reservations AS r
  WHERE r.reservation_id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 0, FALSE;
    RETURN;
  END IF;

  IF v_res.status = 'released' THEN
    SELECT a.balance INTO v_balance
    FROM public.ai_credit_accounts AS a
    WHERE a.id = v_res.credit_account_id;
    RETURN QUERY SELECT TRUE, COALESCE(v_balance, 0), TRUE;
    RETURN;
  END IF;

  IF v_res.status <> 'pending' THEN
    -- committed: never release / refund via this path
    RETURN QUERY SELECT FALSE, 0, FALSE;
    RETURN;
  END IF;

  UPDATE public.ai_credit_accounts AS a
  SET balance = a.balance + v_res.credits_reserved,
      updated_at = clock_timestamp()
  WHERE a.id = v_res.credit_account_id
  RETURNING balance INTO v_balance;

  UPDATE public.edge_ai_credit_reservations AS r
  SET status = 'released'
  WHERE r.reservation_id = p_reservation_id;

  INSERT INTO public.ai_credit_transactions (
    credit_account_id, operation_id, transaction_type,
    credits_delta, balance_after, source, reference_id, metadata
  )
  VALUES (
    v_res.credit_account_id,
    v_res.operation_id,
    'release',
    v_res.credits_reserved,
    v_balance,
    v_res.operation_type,
    p_reservation_id::text,
    jsonb_build_object('reason', 'provider_or_validation_failure', 'operationType', v_res.operation_type)
  )
  ON CONFLICT (credit_account_id, operation_id, transaction_type) DO NOTHING;

  RETURN QUERY SELECT TRUE, v_balance, FALSE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. expire_ai_credit_reservations — restore via release (never silent drop)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_ai_credit_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer := 0;
  r record;
BEGIN
  FOR r IN
    SELECT res.reservation_id
    FROM public.edge_ai_credit_reservations AS res
    WHERE res.status = 'pending' AND res.expires_at <= clock_timestamp()
    FOR UPDATE
  LOOP
    PERFORM x.released
    FROM public.release_ai_credit_reservation(r.reservation_id) AS x;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. get_ai_credit_balance
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_ai_credit_balance(
  p_installation_id text,
  p_license_id uuid DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid,
  balance integer,
  status text,
  available boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_kind text;
  v_owner_ref text;
  v_account_id uuid;
  v_balance integer;
  v_status text;
BEGIN
  IF p_installation_id IS NULL OR p_installation_id !~ '^[A-Za-z0-9._-]{8,128}$' THEN
    RAISE EXCEPTION 'invalid_installation_id';
  END IF;

  IF p_license_id IS NOT NULL THEN
    v_owner_kind := 'license';
    v_owner_ref := p_license_id::text;
  ELSE
    v_owner_kind := 'trial_installation';
    v_owner_ref := p_installation_id;
  END IF;

  SELECT a.id, a.balance, a.status
  INTO v_account_id, v_balance, v_status
  FROM public.ai_credit_accounts AS a
  WHERE a.owner_kind = v_owner_kind
    AND a.owner_ref = v_owner_ref;

  IF FOUND THEN
    RETURN QUERY SELECT
      v_account_id,
      v_balance,
      v_status,
      (v_status = 'active');
    RETURN;
  END IF;

  RETURN QUERY SELECT NULL::uuid, 0, 'none'::text, TRUE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. grant_ai_credits (idempotent)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.grant_ai_credits(
  p_installation_id text,
  p_license_id uuid,
  p_amount integer,
  p_operation_id text,
  p_transaction_type text,
  p_source text,
  p_reference_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  transaction_id uuid,
  balance_after integer,
  duplicate boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_id uuid;
  v_existing uuid;
  v_tx_id uuid;
  v_balance integer;
  v_status text;
BEGIN
  IF p_amount IS NULL OR p_amount < 1 OR p_amount > 100000 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  IF p_transaction_type IS NULL OR p_transaction_type NOT IN (
    'grant', 'refund', 'purchase', 'admin_adjustment', 'trial_grant', 'promotional_grant'
  ) THEN
    RAISE EXCEPTION 'invalid_transaction_type';
  END IF;
  IF p_operation_id IS NULL OR p_operation_id !~ '^[0-9a-f-]{36}$|^[a-z0-9:_-]{8,128}$' THEN
    RAISE EXCEPTION 'invalid_operation_id';
  END IF;
  IF p_metadata ? 'ocrText' THEN
    RAISE EXCEPTION 'invalid_metadata';
  END IF;

  v_account_id := public.resolve_ai_credit_account(p_installation_id, p_license_id);

  SELECT a.balance, a.status INTO v_balance, v_status
  FROM public.ai_credit_accounts AS a
  WHERE a.id = v_account_id
  FOR UPDATE;

  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'account_suspended';
  END IF;

  IF p_reference_id IS NOT NULL AND p_reference_id LIKE 'premium-monthly:%' AND p_transaction_type = 'grant' THEN
    SELECT t.id INTO v_existing
    FROM public.ai_credit_transactions AS t
    WHERE t.credit_account_id = v_account_id
      AND t.reference_id = p_reference_id
      AND t.transaction_type = 'grant'
    LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing, v_balance, TRUE;
      RETURN;
    END IF;
  END IF;

  SELECT t.id INTO v_existing
  FROM public.ai_credit_transactions AS t
  WHERE t.credit_account_id = v_account_id
    AND t.operation_id = p_operation_id
    AND t.transaction_type = p_transaction_type;

  IF FOUND THEN
    RETURN QUERY SELECT v_existing, v_balance, TRUE;
    RETURN;
  END IF;

  v_balance := v_balance + p_amount;
  UPDATE public.ai_credit_accounts AS a
  SET balance = v_balance,
      updated_at = clock_timestamp(),
      license_id = COALESCE(p_license_id, a.license_id)
  WHERE a.id = v_account_id;

  INSERT INTO public.ai_credit_transactions (
    credit_account_id, operation_id, transaction_type,
    credits_delta, balance_after, source, reference_id, metadata
  )
  VALUES (
    v_account_id, p_operation_id, p_transaction_type,
    p_amount, v_balance, p_source, p_reference_id, COALESCE(p_metadata, '{}'::jsonb)
  )
  RETURNING id INTO v_tx_id;

  RETURN QUERY SELECT v_tx_id, v_balance, FALSE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 8. reserve_ai_credits (idempotent; hold-at-reserve)
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.reserve_ai_credits(text, uuid, text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.reserve_ai_credits(
  p_installation_id text,
  p_license_id uuid,
  p_operation_id text,
  p_operation_type text,
  p_credits integer,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  reservation_id uuid,
  credit_account_id uuid,
  credits_reserved integer,
  expires_at timestamptz,
  status text,
  duplicate boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account_id uuid;
  v_balance integer;
  v_status text;
  v_existing public.edge_ai_credit_reservations%ROWTYPE;
  v_res_id uuid;
  v_now timestamptz := clock_timestamp();
  v_expires timestamptz;
BEGIN
  IF p_credits IS NULL OR p_credits < 1 OR p_credits > 10000 THEN
    RAISE EXCEPTION 'invalid_credits';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_lease';
  END IF;
  IF p_operation_type IS NULL OR p_operation_type NOT IN (
    'business_card_ai', 'document_page_ai', 'pdf_page_ai', 'document_reprocess'
  ) THEN
    RAISE EXCEPTION 'invalid_operation_type';
  END IF;
  IF p_operation_id IS NULL OR p_operation_id !~ '^[0-9a-f-]{36}$|^[a-z0-9:_-]{8,128}$' THEN
    RAISE EXCEPTION 'invalid_operation_id';
  END IF;

  PERFORM public.expire_ai_credit_reservations();

  v_account_id := public.resolve_ai_credit_account(p_installation_id, p_license_id);

  SELECT a.balance, a.status INTO v_balance, v_status
  FROM public.ai_credit_accounts AS a
  WHERE a.id = v_account_id
  FOR UPDATE;

  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'account_suspended';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ai_credit_transactions AS t
    WHERE t.credit_account_id = v_account_id
      AND t.operation_id = p_operation_id
      AND t.transaction_type = 'consume'
  ) THEN
    RAISE EXCEPTION 'duplicate_operation';
  END IF;

  SELECT r.* INTO v_existing
  FROM public.edge_ai_credit_reservations AS r
  WHERE r.credit_account_id = v_account_id
    AND r.operation_id = p_operation_id
  ORDER BY r.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_existing.status = 'pending' THEN
      RETURN QUERY SELECT
        v_existing.reservation_id,
        v_existing.credit_account_id,
        v_existing.credits_reserved,
        v_existing.expires_at,
        v_existing.status,
        TRUE;
      RETURN;
    END IF;
    -- released or committed: never re-charge same operationId
    RAISE EXCEPTION 'duplicate_operation';
  END IF;

  IF v_balance < p_credits THEN
    RAISE EXCEPTION 'insufficient_credits';
  END IF;

  v_expires := v_now + (p_lease_seconds * INTERVAL '1 second');
  v_res_id := gen_random_uuid();

  UPDATE public.ai_credit_accounts AS a
  SET balance = a.balance - p_credits, updated_at = v_now
  WHERE a.id = v_account_id;

  INSERT INTO public.edge_ai_credit_reservations (
    reservation_id, credit_account_id, operation_id, operation_type,
    credits_reserved, expires_at, status
  )
  VALUES (
    v_res_id, v_account_id, p_operation_id, p_operation_type,
    p_credits, v_expires, 'pending'
  );

  RETURN QUERY SELECT
    v_res_id,
    v_account_id,
    p_credits,
    v_expires,
    'pending'::text,
    FALSE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 9. commit_ai_credit_usage (idempotent)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.commit_ai_credit_usage(
  p_reservation_id uuid
)
RETURNS TABLE (
  transaction_id uuid,
  balance_after integer,
  duplicate boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_res public.edge_ai_credit_reservations%ROWTYPE;
  v_balance integer;
  v_tx_id uuid;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF p_reservation_id IS NULL THEN
    RAISE EXCEPTION 'reservation_not_found';
  END IF;

  SELECT r.* INTO v_res
  FROM public.edge_ai_credit_reservations AS r
  WHERE r.reservation_id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found';
  END IF;

  SELECT a.balance INTO v_balance
  FROM public.ai_credit_accounts AS a
  WHERE a.id = v_res.credit_account_id
  FOR UPDATE;

  IF v_res.status = 'committed' THEN
    SELECT t.id, t.balance_after INTO v_tx_id, v_balance
    FROM public.ai_credit_transactions AS t
    WHERE t.credit_account_id = v_res.credit_account_id
      AND t.operation_id = v_res.operation_id
      AND t.transaction_type = 'consume'
    LIMIT 1;
    RETURN QUERY SELECT v_tx_id, COALESCE(v_balance, 0), TRUE;
    RETURN;
  END IF;

  IF v_res.status = 'released' THEN
    RAISE EXCEPTION 'reservation_not_found';
  END IF;

  IF v_res.expires_at <= v_now THEN
    PERFORM public.release_ai_credit_reservation(p_reservation_id);
    RAISE EXCEPTION 'reservation_expired';
  END IF;

  UPDATE public.edge_ai_credit_reservations AS r
  SET status = 'committed'
  WHERE r.reservation_id = p_reservation_id;

  -- Balance already reduced at reserve; consume journals the spend.
  INSERT INTO public.ai_credit_transactions (
    credit_account_id, operation_id, transaction_type,
    credits_delta, balance_after, source, reference_id, metadata
  )
  VALUES (
    v_res.credit_account_id, v_res.operation_id, 'consume',
    -v_res.credits_reserved, v_balance, v_res.operation_type,
    p_reservation_id::text,
    jsonb_build_object('operationType', v_res.operation_type)
  )
  RETURNING id INTO v_tx_id;

  RETURN QUERY SELECT v_tx_id, v_balance, FALSE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 10. Privileges — service_role only
-- -----------------------------------------------------------------------------

DO $grants$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'resolve_ai_credit_account',
        'expire_ai_credit_reservations',
        'get_ai_credit_balance',
        'grant_ai_credits',
        'reserve_ai_credits',
        'commit_ai_credit_usage',
        'release_ai_credit_reservation'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END;
$grants$;

COMMENT ON TABLE public.ai_credit_accounts IS
  'Durable commercial AI credit balance. owner_kind=license|trial_installation.';
COMMENT ON TABLE public.ai_credit_transactions IS
  'Append-only commercial credit journal including grant/consume/release.';
COMMENT ON TABLE public.edge_ai_credit_reservations IS
  'Hold-at-reserve operations. TTL expire restores via release_ai_credit_reservation.';

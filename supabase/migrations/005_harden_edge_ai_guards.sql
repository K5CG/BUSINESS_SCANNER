-- Difese tecniche anti-abuso per le Edge Function AI. Queste tabelle non
-- rappresentano account, licenze, crediti commerciali o billing.

CREATE TABLE IF NOT EXISTS public.edge_ai_rate_windows (
  scope text NOT NULL,
  fingerprint text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL,
  PRIMARY KEY (scope, fingerprint),
  CONSTRAINT edge_ai_rate_scope_valid
    CHECK (scope ~ '^[a-z0-9_-]{1,64}$'),
  CONSTRAINT edge_ai_rate_fingerprint_valid
    CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT edge_ai_rate_count_valid
    CHECK (request_count >= 1)
);

CREATE INDEX IF NOT EXISTS edge_ai_rate_windows_started_idx
  ON public.edge_ai_rate_windows (window_started_at);

CREATE TABLE IF NOT EXISTS public.edge_ai_request_leases (
  lease_id uuid PRIMARY KEY,
  scope text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT edge_ai_lease_scope_valid
    CHECK (scope ~ '^[a-z0-9_-]{1,64}$'),
  CONSTRAINT edge_ai_lease_expiry_valid
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS edge_ai_request_leases_scope_expiry_idx
  ON public.edge_ai_request_leases (scope, expires_at);

ALTER TABLE public.edge_ai_rate_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edge_ai_request_leases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.edge_ai_rate_windows FROM PUBLIC;
REVOKE ALL ON TABLE public.edge_ai_rate_windows FROM anon;
REVOKE ALL ON TABLE public.edge_ai_rate_windows FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.edge_ai_rate_windows TO service_role;

REVOKE ALL ON TABLE public.edge_ai_request_leases FROM PUBLIC;
REVOKE ALL ON TABLE public.edge_ai_request_leases FROM anon;
REVOKE ALL ON TABLE public.edge_ai_request_leases FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.edge_ai_request_leases TO service_role;

-- Acquisizione atomica di rate window + lease di concorrenza. L'advisory lock
-- serializza tutti i provider call dello stesso scope anche fra isolate,
-- regioni e cold start differenti.
CREATE OR REPLACE FUNCTION public.acquire_edge_ai_request(
  p_scope text,
  p_fingerprint text,
  p_rate_limit integer,
  p_window_seconds integer,
  p_max_concurrent integer,
  p_lease_seconds integer
)
RETURNS TABLE (
  allowed boolean,
  reason text,
  retry_after_seconds integer,
  lease_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '250ms'
AS $$
DECLARE
  v_now timestamptz;
  v_window_started_at timestamptz;
  v_request_count integer;
  v_active_count integer;
  v_retry_after integer;
  v_lease_id uuid;
BEGIN
  IF p_scope IS NULL OR p_scope !~ '^[a-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid scope';
  END IF;
  IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid fingerprint';
  END IF;
  IF p_rate_limit IS NULL OR p_rate_limit < 1 OR p_rate_limit > 1000 THEN
    RAISE EXCEPTION 'invalid rate limit';
  END IF;
  IF
    p_window_seconds IS NULL OR
    p_window_seconds < 1 OR
    p_window_seconds > 300
  THEN
    RAISE EXCEPTION 'invalid rate window';
  END IF;
  IF
    p_max_concurrent IS NULL OR
    p_max_concurrent < 1 OR
    p_max_concurrent > 50
  THEN
    RAISE EXCEPTION 'invalid concurrency';
  END IF;
  IF
    p_lease_seconds IS NULL OR
    p_lease_seconds < 30 OR
    p_lease_seconds > 90
  THEN
    RAISE EXCEPTION 'invalid lease';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(p_scope, 0)
  ) THEN
    RETURN QUERY
      SELECT FALSE, 'concurrency_limited'::text, 1, NULL::uuid;
    RETURN;
  END IF;
  v_now := pg_catalog.clock_timestamp();

  DELETE FROM public.edge_ai_request_leases AS lease
  WHERE lease.expires_at <= v_now;

  DELETE FROM public.edge_ai_rate_windows AS rate
  WHERE
    rate.window_started_at <
    v_now - (p_window_seconds * INTERVAL '2 seconds');

  SELECT rate.window_started_at, rate.request_count
  INTO v_window_started_at, v_request_count
  FROM public.edge_ai_rate_windows AS rate
  WHERE rate.scope = p_scope AND rate.fingerprint = p_fingerprint
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.edge_ai_rate_windows (
      scope,
      fingerprint,
      window_started_at,
      request_count
    )
    VALUES (p_scope, p_fingerprint, v_now, 1);
  ELSIF
    v_now - v_window_started_at >=
    p_window_seconds * INTERVAL '1 second'
  THEN
    UPDATE public.edge_ai_rate_windows AS rate
    SET window_started_at = v_now, request_count = 1
    WHERE rate.scope = p_scope AND rate.fingerprint = p_fingerprint;
  ELSIF v_request_count >= p_rate_limit THEN
    v_retry_after := GREATEST(
      1,
      pg_catalog.ceil(
        EXTRACT(
          EPOCH FROM (
            v_window_started_at +
            p_window_seconds * INTERVAL '1 second' -
            v_now
          )
        )
      )::integer
    );
    RETURN QUERY
      SELECT FALSE, 'rate_limited'::text, v_retry_after, NULL::uuid;
    RETURN;
  ELSE
    UPDATE public.edge_ai_rate_windows AS rate
    SET request_count = rate.request_count + 1
    WHERE rate.scope = p_scope AND rate.fingerprint = p_fingerprint;
  END IF;

  SELECT count(*)::integer
  INTO v_active_count
  FROM public.edge_ai_request_leases AS lease
  WHERE lease.scope = p_scope AND lease.expires_at > v_now;

  IF v_active_count >= p_max_concurrent THEN
    RETURN QUERY
      SELECT FALSE, 'concurrency_limited'::text, 1, NULL::uuid;
    RETURN;
  END IF;

  v_lease_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.edge_ai_request_leases (
    lease_id,
    scope,
    created_at,
    expires_at
  )
  VALUES (
    v_lease_id,
    p_scope,
    v_now,
    v_now + p_lease_seconds * INTERVAL '1 second'
  );

  RETURN QUERY SELECT TRUE, 'allowed'::text, 0, v_lease_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_edge_ai_request(
  p_lease_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '250ms'
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_lease_id IS NULL THEN
    RETURN FALSE;
  END IF;

  DELETE FROM public.edge_ai_request_leases AS lease
  WHERE lease.lease_id = p_lease_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_edge_ai_request(
  text,
  text,
  integer,
  integer,
  integer,
  integer
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acquire_edge_ai_request(
  text,
  text,
  integer,
  integer,
  integer,
  integer
) FROM anon;
REVOKE ALL ON FUNCTION public.acquire_edge_ai_request(
  text,
  text,
  integer,
  integer,
  integer,
  integer
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_edge_ai_request(
  text,
  text,
  integer,
  integer,
  integer,
  integer
) TO service_role;

REVOKE ALL ON FUNCTION public.release_edge_ai_request(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_edge_ai_request(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.release_edge_ai_request(uuid)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_edge_ai_request(uuid)
  TO service_role;

-- Hardening della quota tecnica AI esistente: la RPC può essere invocata
-- soltanto dalle Edge Function tramite service_role.
CREATE OR REPLACE FUNCTION public.increment_ai_usage(max_calls integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_calls integer;
BEGIN
  IF max_calls IS NULL OR max_calls < 1 OR max_calls > 10000 THEN
    RAISE EXCEPTION 'invalid max_calls';
  END IF;

  INSERT INTO public.ai_usage_daily AS usage (usage_date, calls)
  VALUES (CURRENT_DATE, 1)
  ON CONFLICT (usage_date) DO UPDATE
    SET calls = usage.calls + 1
  RETURNING calls INTO current_calls;

  RETURN current_calls <= max_calls;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_ai_usage(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_ai_usage(integer) FROM anon;
REVOKE ALL ON FUNCTION public.increment_ai_usage(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_usage(integer) TO service_role;

-- 007_commercial_settings.sql
-- Centralized commercial configuration (non-secret).
-- Primary source for trial AI credits and future commercial knobs.
-- service_role only — no anon/authenticated client access.

CREATE TABLE IF NOT EXISTS public.app_commercial_settings (
  setting_key text PRIMARY KEY,
  setting_value text NOT NULL,
  value_type text NOT NULL
    CHECK (value_type IN ('integer', 'text', 'boolean')),
  description text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_commercial_settings IS
  'Non-secret commercial configuration. Edited via SQL/admin. Not readable by mobile clients.';

ALTER TABLE public.app_commercial_settings ENABLE ROW LEVEL SECURITY;

-- Explicitly no policies for anon/authenticated → denied under RLS.
-- service_role bypasses RLS in Supabase.

REVOKE ALL ON TABLE public.app_commercial_settings FROM PUBLIC;
REVOKE ALL ON TABLE public.app_commercial_settings FROM anon;
REVOKE ALL ON TABLE public.app_commercial_settings FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.app_commercial_settings TO service_role;

-- Seed / upsert commercial decision: new trials receive 20 AI credits.
INSERT INTO public.app_commercial_settings (
  setting_key,
  setting_value,
  value_type,
  description,
  updated_at
) VALUES (
  'trial_ai_credits',
  '20',
  'integer',
  'One-time AI credit grant for new trial installations (idempotent trial-grant:<installationId>).',
  now()
)
ON CONFLICT (setting_key) DO UPDATE
SET
  setting_value = EXCLUDED.setting_value,
  value_type = EXCLUDED.value_type,
  description = EXCLUDED.description,
  updated_at = now();

-- Server-side bounded integer reader (service_role only).
CREATE OR REPLACE FUNCTION public.get_commercial_setting_int(
  p_key text,
  p_min integer DEFAULT 0,
  p_max integer DEFAULT 10000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw text;
  v_num numeric;
  v_int integer;
BEGIN
  IF p_key IS NULL OR length(trim(p_key)) = 0 THEN
    RETURN NULL;
  END IF;
  IF p_min IS NULL OR p_max IS NULL OR p_min > p_max THEN
    RETURN NULL;
  END IF;

  SELECT s.setting_value
    INTO v_raw
  FROM public.app_commercial_settings s
  WHERE s.setting_key = p_key
    AND s.value_type = 'integer';

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_num := trim(v_raw)::numeric;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  IF v_num <> trunc(v_num) THEN
    RETURN NULL;
  END IF;

  v_int := v_num::integer;
  IF v_int < p_min OR v_int > p_max THEN
    RETURN NULL;
  END IF;

  RETURN v_int;
END;
$$;

REVOKE ALL ON FUNCTION public.get_commercial_setting_int(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_commercial_setting_int(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.get_commercial_setting_int(text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_commercial_setting_int(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.get_commercial_setting_int(text, integer, integer) IS
  'Returns bounded integer commercial setting or NULL if missing/invalid. service_role only.';

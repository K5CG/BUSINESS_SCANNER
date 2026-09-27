-- 010_fix_privacy_consent_register_ambiguity.sql
-- Fix PL/pgSQL ambiguity between RETURNS TABLE columns and table columns.
-- Must DROP first: CREATE OR REPLACE cannot change OUT/return row type.

DROP FUNCTION IF EXISTS public.register_privacy_consent(text, text, text, text, uuid, text);

CREATE FUNCTION public.register_privacy_consent(
  p_installation_id text,
  p_privacy_version text,
  p_locale text DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_license_id uuid DEFAULT NULL,
  p_consent_type text DEFAULT 'first_launch_summary'
)
RETURNS TABLE (
  out_id uuid,
  out_installation_id text,
  out_privacy_version text,
  out_accepted_at timestamptz,
  out_created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_installation text;
  v_version text;
  v_locale text;
  v_app_version text;
  v_consent_type text;
  v_accepted_at timestamptz;
  v_created boolean := false;
BEGIN
  v_installation := trim(both FROM coalesce(p_installation_id, ''));
  v_version := trim(both FROM coalesce(p_privacy_version, ''));
  v_locale := NULLIF(trim(both FROM coalesce(p_locale, '')), '');
  v_app_version := NULLIF(trim(both FROM coalesce(p_app_version, '')), '');
  v_consent_type := NULLIF(trim(both FROM coalesce(p_consent_type, '')), '');

  IF char_length(v_installation) < 8 OR char_length(v_installation) > 128 THEN
    RAISE EXCEPTION 'invalid_installation_id';
  END IF;
  IF v_installation !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'invalid_installation_id';
  END IF;
  IF char_length(v_version) < 1 OR char_length(v_version) > 64 THEN
    RAISE EXCEPTION 'invalid_privacy_version';
  END IF;
  IF v_version !~ '^[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'invalid_privacy_version';
  END IF;
  IF v_consent_type IS NULL THEN
    v_consent_type := 'first_launch_summary';
  END IF;
  IF char_length(v_consent_type) > 64 THEN
    RAISE EXCEPTION 'invalid_consent_type';
  END IF;
  IF v_locale IS NOT NULL AND (char_length(v_locale) < 2 OR char_length(v_locale) > 32) THEN
    RAISE EXCEPTION 'invalid_locale';
  END IF;
  IF v_app_version IS NOT NULL AND char_length(v_app_version) > 64 THEN
    RAISE EXCEPTION 'invalid_app_version';
  END IF;

  INSERT INTO public.privacy_consents AS pc (
    installation_id,
    license_id,
    privacy_version,
    accepted,
    consent_type,
    locale,
    app_version,
    accepted_at
  ) VALUES (
    v_installation,
    p_license_id,
    v_version,
    true,
    v_consent_type,
    v_locale,
    v_app_version,
    now()
  )
  ON CONFLICT ON CONSTRAINT privacy_consents_installation_version_uidx DO NOTHING
  RETURNING pc.id, pc.accepted_at
  INTO v_id, v_accepted_at;

  IF v_id IS NULL THEN
    SELECT c.id, c.accepted_at
      INTO v_id, v_accepted_at
    FROM public.privacy_consents c
    WHERE c.installation_id = v_installation
      AND c.privacy_version = v_version;
    v_created := false;
  ELSE
    v_created := true;
  END IF;

  out_id := v_id;
  out_installation_id := v_installation;
  out_privacy_version := v_version;
  out_accepted_at := v_accepted_at;
  out_created := v_created;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) TO service_role;

COMMENT ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) IS
  'Idempotent privacy consent registration. accepted_at is server-side. service_role only.';

-- 009_privacy_consent_and_settings.sql
-- Public privacy policy URL/version in app_commercial_settings + auditable consent evidence.
-- Does NOT rewrite existing trial_devices / trial commercial values.
-- Does NOT store document/card content or device fingerprints.

-- ---------------------------------------------------------------------------
-- Public commercial settings (readable only via controlled Edge/service_role)
-- ---------------------------------------------------------------------------
INSERT INTO public.app_commercial_settings (
  setting_key,
  setting_value,
  value_type,
  description,
  updated_at
) VALUES (
  'privacy_policy_url',
  'https://www.businessscanner.app/privacy',
  'text',
  'Full privacy policy HTTPS URL shown in-app. Change without APK rebuild.',
  now()
)
ON CONFLICT (setting_key) DO UPDATE
SET
  setting_value = EXCLUDED.setting_value,
  value_type = EXCLUDED.value_type,
  description = EXCLUDED.description,
  updated_at = now();

INSERT INTO public.app_commercial_settings (
  setting_key,
  setting_value,
  value_type,
  description,
  updated_at
) VALUES (
  'privacy_policy_version',
  '1.0',
  'text',
  'Privacy policy version. Changing this requires renewed in-app acceptance for installations still on the prior version.',
  now()
)
ON CONFLICT (setting_key) DO UPDATE
SET
  setting_value = EXCLUDED.setting_value,
  value_type = EXCLUDED.value_type,
  description = EXCLUDED.description,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- Consent evidence table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.privacy_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id text NOT NULL
    CHECK (char_length(installation_id) BETWEEN 8 AND 128),
  license_id uuid NULL,
  privacy_version text NOT NULL
    CHECK (char_length(privacy_version) BETWEEN 1 AND 64),
  accepted boolean NOT NULL DEFAULT true
    CHECK (accepted = true),
  consent_type text NOT NULL DEFAULT 'first_launch_summary'
    CHECK (char_length(consent_type) BETWEEN 1 AND 64),
  locale text NULL
    CHECK (locale IS NULL OR char_length(locale) BETWEEN 2 AND 32),
  app_version text NULL
    CHECK (app_version IS NULL OR char_length(app_version) BETWEEN 1 AND 64),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT privacy_consents_installation_version_uidx
    UNIQUE (installation_id, privacy_version)
);

COMMENT ON TABLE public.privacy_consents IS
  'Auditable first-launch privacy summary acceptance. One row per installation_id + privacy_version. No document/card content.';

CREATE INDEX IF NOT EXISTS privacy_consents_accepted_at_idx
  ON public.privacy_consents (accepted_at DESC);

ALTER TABLE public.privacy_consents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.privacy_consents FROM PUBLIC;
REVOKE ALL ON TABLE public.privacy_consents FROM anon;
REVOKE ALL ON TABLE public.privacy_consents FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.privacy_consents TO service_role;

-- ---------------------------------------------------------------------------
-- service_role helpers (Edge only — never exposed to mobile clients)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_public_privacy_settings()
RETURNS TABLE (
  privacy_policy_url text,
  privacy_policy_version text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url text;
  v_version text;
BEGIN
  SELECT s.setting_value INTO v_url
  FROM public.app_commercial_settings s
  WHERE s.setting_key = 'privacy_policy_url'
    AND s.value_type = 'text';

  SELECT s.setting_value INTO v_version
  FROM public.app_commercial_settings s
  WHERE s.setting_key = 'privacy_policy_version'
    AND s.value_type = 'text';

  privacy_policy_url := v_url;
  privacy_policy_version := v_version;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_privacy_settings() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_public_privacy_settings() FROM anon;
REVOKE ALL ON FUNCTION public.get_public_privacy_settings() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_privacy_settings() TO service_role;

COMMENT ON FUNCTION public.get_public_privacy_settings() IS
  'Returns public privacy URL/version for Edge. service_role only.';

CREATE OR REPLACE FUNCTION public.register_privacy_consent(
  p_installation_id text,
  p_privacy_version text,
  p_locale text DEFAULT NULL,
  p_app_version text DEFAULT NULL,
  p_license_id uuid DEFAULT NULL,
  p_consent_type text DEFAULT 'first_launch_summary'
)
RETURNS TABLE (
  id uuid,
  installation_id text,
  privacy_version text,
  accepted_at timestamptz,
  created boolean
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

  INSERT INTO public.privacy_consents (
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
  ON CONFLICT (installation_id, privacy_version) DO NOTHING
  RETURNING privacy_consents.id, privacy_consents.accepted_at
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

  id := v_id;
  installation_id := v_installation;
  privacy_version := v_version;
  accepted_at := v_accepted_at;
  created := v_created;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) TO service_role;

COMMENT ON FUNCTION public.register_privacy_consent(text, text, text, text, uuid, text) IS
  'Idempotent privacy consent registration. accepted_at is server-side. service_role only.';

-- Business Scanner — setup progetto Supabase DEDICATO
-- Eseguire in SQL Editor del NUOVO progetto (NON LabTracker)
-- Poi: supabase link --project-ref NUOVO_REF && npm run supabase:deploy

-- === 001: tabelle licenze ===
CREATE TABLE IF NOT EXISTS app_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_key text UNIQUE NOT NULL,
  license_type text NOT NULL CHECK (license_type IN ('test', 'premium')),
  valid_days integer NOT NULL,
  max_activations integer NOT NULL DEFAULT 2,
  activation_count integer NOT NULL DEFAULT 0,
  revoked boolean NOT NULL DEFAULT false,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS license_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_id uuid NOT NULL REFERENCES app_licenses(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (license_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_app_licenses_key ON app_licenses (license_key);
CREATE INDEX IF NOT EXISTS idx_license_activations_device ON license_activations (device_id);

ALTER TABLE app_licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_activations ENABLE ROW LEVEL SECURITY;

-- === 002: email + trial ===
ALTER TABLE app_licenses
  ADD COLUMN IF NOT EXISTS assigned_email text;

ALTER TABLE license_activations
  ADD COLUMN IF NOT EXISTS customer_email text;

CREATE TABLE IF NOT EXISTS trial_devices (
  device_id text PRIMARY KEY,
  trial_started_at timestamptz NOT NULL DEFAULT now(),
  trial_ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_license_activations_email
  ON license_activations (customer_email);

CREATE INDEX IF NOT EXISTS idx_app_licenses_assigned_email
  ON app_licenses (assigned_email);

ALTER TABLE trial_devices ENABLE ROW LEVEL SECURITY;

-- Verifica
SELECT 'app_licenses' AS tabella, count(*) AS righe FROM app_licenses
UNION ALL
SELECT 'license_activations', count(*) FROM license_activations
UNION ALL
SELECT 'trial_devices', count(*) FROM trial_devices;

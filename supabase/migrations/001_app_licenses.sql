-- Licenze Business Scanner (test 15 gg / premium 1 anno)
-- Esegui in Supabase → SQL Editor

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

-- Nessuna policy pubblica: solo edge function con service role accede ai dati.

-- Esempio chiavi demo (sostituire in produzione):
-- INSERT INTO app_licenses (license_key, license_type, valid_days, max_activations, note)
-- VALUES
--   ('BS-TEST-DEMO-0001', 'test', 15, 5, 'Demo interna'),
--   ('BS-PREM-DEMO-0001', 'premium', 365, 2, 'Cliente demo');

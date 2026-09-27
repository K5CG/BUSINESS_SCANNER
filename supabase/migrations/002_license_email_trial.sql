-- Email cliente + trial server-side (una prova per dispositivo)
-- Esegui in Supabase → SQL Editor (dopo 001_app_licenses.sql)

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

-- Nessuna policy pubblica: solo edge function (service role) accede ai dati.

-- Opzionale: associa email alle chiavi demo già create
-- UPDATE app_licenses SET assigned_email = 'tua@email.it' WHERE license_key = 'BS-PREM-FJYJ-4VR5';

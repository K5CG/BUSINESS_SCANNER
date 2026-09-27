-- Chiave premium iniziale (topscanner / Business Scanner)
-- SECURITY: never commit a live license key or owner email. Insert via private operator channel.
INSERT INTO app_licenses (license_key, license_type, valid_days, max_activations, assigned_email, note)
VALUES (
  '<PREMIUM_LICENSE_KEY>',
  'premium',
  365,
  2,
  '<OWNER_EMAIL>',
  'Cliente — attivazione 2026'
)
ON CONFLICT (license_key) DO UPDATE SET
  assigned_email = EXCLUDED.assigned_email,
  revoked = false,
  activation_count = 0;

SELECT license_key, assigned_email, activation_count, revoked FROM app_licenses;

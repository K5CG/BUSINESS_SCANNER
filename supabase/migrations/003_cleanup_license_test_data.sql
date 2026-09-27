-- Pulizia dati licenze di test (Supabase → SQL Editor)
-- Esegui DOPO 001 e 002. Poi rigenera/ricrea le chiavi se necessario.

-- 1) Attivazioni dispositivi (test precedenti)
DELETE FROM license_activations;

-- 2) Prove gratuite registrate per dispositivo
DELETE FROM trial_devices;

-- 3) Azzera contatore attivazioni sulle chiavi esistenti
UPDATE app_licenses SET activation_count = 0;

-- 4) OPZIONALE — rimuove TUTTE le chiavi (decommentare se vuoi ripartire da zero)
-- DELETE FROM app_licenses;

-- 5) OPZIONALE — rimuove email assegnate alle chiavi (decommentare)
-- UPDATE app_licenses SET assigned_email = NULL;

-- Verifica
SELECT 'app_licenses' AS tabella, count(*) AS righe FROM app_licenses
UNION ALL
SELECT 'license_activations', count(*) FROM license_activations
UNION ALL
SELECT 'trial_devices', count(*) FROM trial_devices;

SELECT license_key, license_type, assigned_email, activation_count, revoked
FROM app_licenses
ORDER BY created_at;

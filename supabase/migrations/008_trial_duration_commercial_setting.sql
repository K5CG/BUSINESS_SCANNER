-- 008_trial_duration_commercial_setting.sql
-- Centralize trial duration days in app_commercial_settings.
-- Production source of truth: setting_key = 'trial_duration_days'.
-- Existing trial_devices.trial_ends_at rows are NOT rewritten.

INSERT INTO public.app_commercial_settings (
  setting_key,
  setting_value,
  value_type,
  description,
  updated_at
) VALUES (
  'trial_duration_days',
  '3',
  'integer',
  'Duration in days for NEW trial installations only. Existing trial_ends_at values remain unchanged.',
  now()
)
ON CONFLICT (setting_key) DO UPDATE
SET
  setting_value = EXCLUDED.setting_value,
  value_type = EXCLUDED.value_type,
  description = EXCLUDED.description,
  updated_at = now();

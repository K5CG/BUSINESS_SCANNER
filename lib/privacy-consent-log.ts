export type PrivacyConsentLogStep =
  | 'button_pressed'
  | 'accept_start'
  | 'storage_write_start'
  | 'storage_write_ok'
  | 'storage_write_failed'
  | 'provider_state_before'
  | 'provider_state_after'
  | 'gate_render'
  | 'navigation_release_gate'
  | 'hydration_skip'
  | 'hydration_apply'
  | 'installation_id_source'
  | 'backend_sync_ok'
  | 'backend_sync_failed';

export function logPrivacyConsent(
  step: PrivacyConsentLogStep,
  detail?: Record<string, unknown>,
): void {
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[PrivacyConsent] ${step}${suffix}`);
}

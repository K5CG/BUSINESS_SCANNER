export type LicenseLogStep =
  | 'gate_start'
  | 'network_state'
  | 'installation_id_begin'
  | 'installation_id_source'
  | 'cached_entitlement'
  | 'check_start'
  | 'endpoint'
  | 'response_status'
  | 'response_body_sanitized'
  | 'exception_name'
  | 'exception_message'
  | 'entitlement_result'
  | 'ui_state'
  | 'check_network_unreachable'
  | 'check_http_error';

export function logLicense(step: LicenseLogStep, detail?: Record<string, unknown>): void {
  const suffix = detail ? ` ${JSON.stringify(detail)}` : '';
  console.warn(`[License] ${step}${suffix}`);
}

export function sanitizeLicenseCheckResponseBody(
  data: Record<string, unknown> | null,
  httpStatus: number,
  errorCode?: string,
): Record<string, unknown> {
  if (data) {
    return {
      access: data.access ?? null,
      kind: data.kind ?? null,
      expiresAt: data.expiresAt ?? null,
      errorCode: data.errorCode ?? null,
      valid: data.valid ?? null,
    };
  }
  return { httpStatus, errorCode: errorCode ?? null };
}

export function redactInstallationId(installationId: string): string {
  const trimmed = installationId.trim();
  if (trimmed.length <= 4) return '****';
  return `****${trimmed.slice(-4)}`;
}

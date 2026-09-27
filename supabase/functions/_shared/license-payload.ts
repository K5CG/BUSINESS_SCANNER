const MAX_INSTALLATION_ID_LEN = 128;
const MAX_EMAIL_LEN = 320;
const MAX_LICENSE_KEY_LEN = 64;
const INSTALLATION_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export function normalizeInstallationId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!INSTALLATION_ID_RE.test(trimmed)) return null;
  return trimmed;
}

export function resolveInstallationId(body: Record<string, unknown>): string | null {
  const fromPreferred = normalizeInstallationId(body.installationId);
  if (fromPreferred) return fromPreferred;
  return normalizeInstallationId(body.deviceId);
}

export function parseCheckLicenseBody(body: unknown):
  | { ok: true; installationId: string; email: string | null }
  | { ok: false; errorCode: 'invalid_request' | 'payload_too_large' } {
  if (!body || typeof body !== 'object') {
    return { ok: false, errorCode: 'invalid_request' };
  }
  const record = body as Record<string, unknown>;
  const rawJson = JSON.stringify(record);
  if (rawJson.length > 4096) {
    return { ok: false, errorCode: 'payload_too_large' };
  }

  const installationId = resolveInstallationId(record);
  if (!installationId) {
    return { ok: false, errorCode: 'invalid_request' };
  }

  let email: string | null = null;
  if (record.email !== undefined && record.email !== null && record.email !== '') {
    if (typeof record.email !== 'string' || record.email.length > MAX_EMAIL_LEN) {
      return { ok: false, errorCode: 'invalid_request' };
    }
    email = record.email.trim().toLowerCase();
  }

  return { ok: true, installationId, email };
}

export function parseValidateLicenseBody(body: unknown):
  | { ok: true; installationId: string; email: string; licenseKey: string }
  | { ok: false; errorCode: 'invalid_request' | 'payload_too_large' | 'email_required' | 'email_invalid' } {
  if (!body || typeof body !== 'object') {
    return { ok: false, errorCode: 'invalid_request' };
  }
  const record = body as Record<string, unknown>;
  const rawJson = JSON.stringify(record);
  if (rawJson.length > 8192) {
    return { ok: false, errorCode: 'payload_too_large' };
  }

  const installationId = resolveInstallationId(record);
  if (!installationId) {
    return { ok: false, errorCode: 'invalid_request' };
  }

  if (typeof record.email !== 'string' || !record.email.trim()) {
    return { ok: false, errorCode: 'email_required' };
  }
  const email = record.email.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LEN || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, errorCode: 'email_invalid' };
  }

  if (typeof record.licenseKey !== 'string' || !record.licenseKey.trim()) {
    return { ok: false, errorCode: 'invalid_request' };
  }
  const licenseKey = record.licenseKey.trim().toUpperCase().replace(/\s+/g, '');
  if (licenseKey.length > MAX_LICENSE_KEY_LEN || licenseKey.length < 4) {
    return { ok: false, errorCode: 'invalid_request' };
  }

  return { ok: true, installationId, email, licenseKey };
}

export function licenseKeyHint(key: string): string {
  return key.length <= 4 ? key : key.slice(-4);
}

export function sanitizeLicenseKeyForLog(_key: string): string {
  return '[redacted]';
}

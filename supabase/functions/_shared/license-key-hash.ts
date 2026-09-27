/** SHA-256 license key hashing — standard Web Crypto, no proprietary crypto. */

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashLicenseKey(
  normalizedKey: string,
  pepper: string
): Promise<string> {
  const payload = `${pepper}:${normalizedKey}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload)
  );
  return bytesToHex(new Uint8Array(digest));
}

export function licenseKeyPrefix(normalizedKey: string, length = 8): string {
  return normalizedKey.slice(0, Math.min(length, normalizedKey.length));
}

declare const Deno:
  | {
      env: { get(name: string): string | undefined };
    }
  | undefined;

export function getLicenseKeyPepper(): string | null {
  const pepper =
    (typeof Deno !== 'undefined' ? Deno.env.get('LICENSE_KEY_PEPPER') : undefined)?.trim() ??
    process.env.LICENSE_KEY_PEPPER?.trim();
  return pepper && pepper.length >= 16 ? pepper : null;
}

const EMAIL_FORMAT =
  /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Normalizza email (trim + lowercase). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True se il formato è plausibile. */
export function isValidEmailFormat(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized || normalized.length > 254) return false;
  return EMAIL_FORMAT.test(normalized);
}

/**
 * Valida e normalizza un indirizzo email.
 * Ritorna `null` se non valido.
 */
export function validateEmail(email: string): string | null {
  const normalized = normalizeEmail(email);
  return isValidEmailFormat(normalized) ? normalized : null;
}


/** Deduplica email già normalizzate preservando l'ordine. */
export function dedupeEmails(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const valid = validateEmail(raw);
    if (!valid || seen.has(valid)) continue;
    seen.add(valid);
    out.push(valid);
  }
  return out;
}

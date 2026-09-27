import type { Phone } from '../../../types';
import { normalizePhoneDigits } from '../extractors/phone';

function digitCount(value: string): number {
  return value.replace(/\D/g, '').length;
}

const VALID_TYPES = new Set<NonNullable<Phone['type']>>(['mobile', 'work', 'fax', 'other']);

function normalizeType(type: Phone['type'] | undefined): Phone['type'] {
  if (type && VALID_TYPES.has(type)) return type;
  return 'work';
}

/**
 * Valida e normalizza un numero telefonico.
 * Ritorna `null` se le cifre significative sono fuori range (9–15).
 */
export function validatePhone(phone: Phone): Phone | null {
  const normalizedNumber = normalizePhoneDigits((phone.number ?? '').trim());
  // Preserve original phone if validation fails (empty or out‑of‑range digit count)
  if (!normalizedNumber) {
    return { number: (phone.number ?? '').trim(), type: phone.type };
  }

  const digits = digitCount(normalizedNumber);
  if (digits < 9 || digits > 15) {
    return { number: (phone.number ?? '').trim(), type: phone.type };
  }

  return {
    number: normalizedNumber,
    type: normalizeType(phone.type),
  };
}

/** Deduplica per cifre significative preservando il primo tipo incontrato. */
export function dedupePhones(phones: Phone[]): Phone[] {
  const unique = new Map<string, Phone>();
  for (const raw of phones) {
    const valid = validatePhone(raw);
    if (!valid) continue;
    const key = valid.number.replace(/\D/g, '');
    if (!key || unique.has(key)) continue;
    unique.set(key, valid);
  }
  return [...unique.values()];
}

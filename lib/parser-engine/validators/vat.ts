const ITALIAN_TAX_CODE = /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/;
const ITALIAN_VAT_NUMBER = /^\d{11}$/;

/** Normalizza P.IVA / CF (trim + uppercase). */
export function normalizeTaxId(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

/** True se è una P.IVA italiana a 11 cifre. */
export function isValidVatNumber(value: string): boolean {
  const normalized = normalizeTaxId(value).replace(/^IT/, '');
  return ITALIAN_VAT_NUMBER.test(normalized);
}

/** True se è un codice fiscale italiano (16 caratteri). */
export function isValidTaxCode(value: string): boolean {
  return ITALIAN_TAX_CODE.test(normalizeTaxId(value));
}

/**
 * Valida una partita IVA.
 * Ritorna la forma normalizzata (11 cifre) o `null`.
 */
export function validateVatNumber(value: string): string | null {
  const normalized = normalizeTaxId(value).replace(/^IT/, '');
  return ITALIAN_VAT_NUMBER.test(normalized) ? normalized : null;
}

/**
 * Valida un codice fiscale italiano.
 * Accetta CF persona (16 car.) e P.IVA numerica condivisa (11 cifre) da etichetta combinata.
 */
export function validateTaxCode(value: string): string | null {
  const normalized = normalizeTaxId(value);
  if (ITALIAN_TAX_CODE.test(normalized)) return normalized;
  const asVat = normalized.replace(/^IT/, '');
  if (ITALIAN_VAT_NUMBER.test(asVat)) return asVat;
  return null;
}

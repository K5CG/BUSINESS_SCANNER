/**
 * Classificazione geografica indirizzi — evita CAP/provincia IT su indirizzi esteri.
 */
import type { Address } from '../types';
import { provinceFromItalianCap } from './parser-engine/validators/italian-cap';

const FOREIGN_COUNTRY_RE =
  /\b(?:taiwan|pakistan|sialkot|belgium|belgique|germany|deutschland|france|netherlands|nederland|austria|spain|españa|portugal|uk|united\s+kingdom|usa|united\s+states|ireland|irlanda|canada|korea|corea|japan|giappone|china|cina|switzerland|svizzera|schweiz)\b/i;

const ITALY_EXPLICIT_RE = /\b(?:italy|italia|\bIT\b)\b/i;

export function detectCountryHints(text: string): string[] {
  const hints: string[] = [];
  const t = text.trim();
  if (!t) return hints;
  if (/\btaiwan\b/i.test(t)) hints.push('TW');
  if (/\bpakistan\b/i.test(t) || /\bsialkot\b/i.test(t)) hints.push('PK');
  if (/\bbelgium\b|\bbelgique\b/i.test(t)) hints.push('BE');
  if (/\bgermany\b|\bdeutschland\b/i.test(t)) hints.push('DE');
  if (/\bfrance\b/i.test(t)) hints.push('FR');
  if (/\bireland\b|\birlanda\b/i.test(t)) hints.push('IE');
  if (/\bitaly\b|\bitalia\b/i.test(t)) hints.push('IT');
  return hints;
}

/** true se il testo indica chiaramente un indirizzo non italiano. */
export function isExplicitlyForeignAddress(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (FOREIGN_COUNTRY_RE.test(t)) return true;
  if (/\b(?:taichung|sialkot|pasrur|loignun|schweiz)\b/i.test(t)) return true;
  return false;
}

/** Classifica se l'indirizzo può ricevere provincia/CAP italiani. */
export function isItalianAddressContext(address: Address | null | undefined, rawText?: string): boolean {
  const full = `${address?.full ?? ''} ${rawText ?? ''}`.trim();
  if (!full) return false;
  if (isExplicitlyForeignAddress(full)) return false;
  if (ITALY_EXPLICIT_RE.test(full)) return true;
  if (address?.country && !/^it$/i.test(address.country)) return false;
  if (/\(\s*[A-Z]{2}\s*\)/.test(full) && !/\b(?:taiwan|pakistan)\b/i.test(full)) return true;
  if (/\b(?:via|viale|piazza|corso|vicolo|strada|localit[aà])\b/i.test(full)) return true;
  return false;
}

export function shouldApplyItalianCapProvince(
  address: Address | null | undefined,
  rawText?: string
): boolean {
  if (!isItalianAddressContext(address, rawText)) return false;
  const cap = address?.postalCode?.replace(/\s/g, '') ?? '';
  if (!/^\d{5}$/.test(cap)) return false;
  return !!provinceFromItalianCap(cap);
}

/** Nuovo indirizzo peggiora aggiungendo IT/provincia italiana su estero. */
export function addressForeignContaminationRegression(
  oldFull: string,
  newFull: string
): boolean {
  const oldF = oldFull.trim();
  const newF = newFull.trim();
  if (!oldF || !newF || oldF === newF) return false;
  if (isExplicitlyForeignAddress(oldF) && /\(\s*[A-Z]{2}\s*\)\s*-\s*IT\b/i.test(newF)) {
    return true;
  }
  if (isExplicitlyForeignAddress(oldF) && /-\s*\([A-Z]{2}\)\s*-\s*IT\s*$/i.test(newF)) {
    return true;
  }
  return false;
}

import { looksLikeInternationalTaxIdentifier } from './document-international-values';

/**
 * Un identificativo fiscale (P.IVA, VAT ID, codice fiscale) non e' mai un importo.
 * Il guard vive qui perche' serve sia al parser strutturato sia ai riepiloghi IVA.
 */

/** Etichette che introducono un identificativo, non un valore monetario. */
const FISCAL_IDENTIFIER_LABEL =
  /\b(?:vat[\s.\-]*(?:id|no|nr|num(?:ber)?|reg(?:istration)?)|p\.?\s*iva|partita\s+iva|cod\.?\s*fisc\w*|codice\s+fiscale|tax\s*(?:id|code|no|num(?:ber)?)|ust[\s.\-]*id\w*|umsatzsteuer[\s.\-]*id\w*|steuernummer|mwst[\s.\-]*nr\w*|btw[\s.\-]*nr\w*|tva\s+intracommunautaire|num[eé]ro\s+de\s+tva|siret|siren|nif|cif|iban|bic|swift)\b/i;

const CURRENCY_EVIDENCE = /[€$£¥]|\b(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN)\b/i;
const DECIMAL_EVIDENCE = /[.,]\d{1,2}(?!\d)/;

/** Sotto questa soglia un numero resta un importo plausibile. */
const MIN_IDENTIFIER_DIGITS = 8;
/** Lunghezza tipica dei VAT ID europei: senza decimali ne' valuta non e' denaro. */
const STANDALONE_IDENTIFIER_DIGITS = 11;

export type FiscalIdentifierReason =
  | 'country_prefixed_vat_id'
  | 'fiscal_identifier_label'
  | 'leading_zero_identifier'
  | 'implausible_identifier_length';

export interface FiscalIdentifierVerdict {
  fiscal: boolean;
  reason?: FiscalIdentifierReason;
}

/**
 * Decide se un token numerico e' un identificativo fiscale invece di un importo.
 * Serve evidenza monetaria (valuta o decimali) per tenerlo come denaro; in mancanza
 * si guarda il contesto, non la sola lunghezza, cosi' un importo grande ma formattato resta valido.
 */
export function classifyFiscalIdentifierAmount(
  token: string,
  contextLine = '',
): FiscalIdentifierVerdict {
  const raw = token.trim();
  if (!raw) return { fiscal: false };
  if (CURRENCY_EVIDENCE.test(raw) || DECIMAL_EVIDENCE.test(raw) || raw.includes('%')) {
    return { fiscal: false };
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length < MIN_IDENTIFIER_DIGITS) return { fiscal: false };

  if (looksLikeInternationalTaxIdentifier(raw)) {
    return { fiscal: true, reason: 'country_prefixed_vat_id' };
  }
  if (FISCAL_IDENTIFIER_LABEL.test(contextLine)) {
    return { fiscal: true, reason: 'fiscal_identifier_label' };
  }
  if (digits.startsWith('0')) {
    return { fiscal: true, reason: 'leading_zero_identifier' };
  }
  if (digits.length >= STANDALONE_IDENTIFIER_DIGITS) {
    return { fiscal: true, reason: 'implausible_identifier_length' };
  }
  return { fiscal: false };
}

export function looksLikeFiscalIdentifierAmount(token: string, contextLine = ''): boolean {
  return classifyFiscalIdentifierAmount(token, contextLine).fiscal;
}

/** Vero quando la riga presenta esplicitamente un identificativo fiscale. */
export function hasFiscalIdentifierLabel(text: string): boolean {
  return FISCAL_IDENTIFIER_LABEL.test(text);
}

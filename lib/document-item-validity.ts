const LEGAL_OR_BANK_ITEM =
  /\b(?:inscrita\s+en\s+el\s+registro|registro\s+mercantil|condiciones\s+generales|condizioni\s+generali|privacy|iban|bic|swift|datos\s+bancarios|coordinate\s+bancarie|bankverbindung|osservazioni|observaciones|notes?\s+and\s+conditions|thank\s+you\s+for\s+your\s+business)\b/i;

const FOOTER_HEADING =
  /\b(?:datos\s+bancarios|osservazioni|observaciones|condizioni\s+generali|condiciones\s+generales|vat\s+summary|riepilogo(?:\s+iva)?|note\s*\/\s*remarks|resumen\s+de\s+cantidades|total\s+3\s+a[nñ]os)\b/i;

export function isLegalOrBankFooterText(text: string | undefined): boolean {
  const value = text?.trim() ?? '';
  if (!value) return false;
  if (LEGAL_OR_BANK_ITEM.test(value)) return true;
  if (/\b(?:iban|bic|swift)\b/i.test(value) && value.length > 24) return true;
  return false;
}

export function isTableFooterHeading(text: string | undefined): boolean {
  return FOOTER_HEADING.test(text?.trim() ?? '');
}

export function isNonCommercialItemDescription(text: string | undefined): boolean {
  const value = text?.trim() ?? '';
  if (!value) return true;
  if (isLegalOrBankFooterText(value)) return true;
  if (/\b(?:riporto(?:\s+(?:a|da)\s+pagina)?|a\s+riportare|carry(?:ed)?(?:\s+|-)forward|brought\s+forward|[uü]bertrag|a\s+reporter)\b/i.test(value)) {
    return true;
  }
  if (/\b(?:resumen(?:\s+de\s+cantidades)?|total\s+unidades\s+a[nñ]o|total\s+3\s+a[nñ]os|triennal[e]?|trienal|\d+\s+unidades)\b/i.test(value)) {
    return true;
  }
  if (value.length > 90 && /(?:registro|iban|foro|controversia|condizioni|condiciones)/i.test(value)) {
    return true;
  }
  return false;
}

export function isNotesOrTermsBoundary(text: string | undefined): boolean {
  const value = text?.trim() ?? '';
  if (!value) return false;
  if (NOTES_OR_TERMS_ONLY.test(value)) return true;
  if (isLegalOrBankFooterText(value) || isTableFooterHeading(value)) return true;
  if (
    /\b(?:delivery\s+terms|payment\s+terms|tolerance|validity|validit[aà]|conditions|condizioni|note(?:s)?\b|remarks|osservazioni|observaciones|iban|bic|swift|no\s+se\s+incluyen|does\s+not\s+include|non\s+sono\s+inclus|ne\s+sont\s+pas\s+inclus)\b/i.test(
      value,
    )
  ) {
    return true;
  }
  return false;
}

const TOTALS_OR_HEADER_ROW =
  /^(?:totale|total|grand total|subtotale|subtotal|imponibile|descrizione|description|q\.?t[aà]|qty|iva|vat|importo|amount)\s*$/i;
const PRODUCT_OR_SERVICE =
  /\b(?:lavorazione|servizio|service|setup|logo|articolo|product|kit|filtro|manodopera|installazione|included|omaggio|complimentary|incluso|free\s+of\s+charge)\b/i;

const NOTES_OR_TERMS_ONLY =
  /\b(?:tempi\s+di\s+consegna|tasso\s+di\s+tolleranza|condizioni\s+generali|condiciones\s+generales|note\s+and\s+conditions|osservazioni|observaciones|delivery\s+terms|payment\s+terms|validit[aà]|tolleranza)\b/i;

export interface CommercialItemValidityInput {
  description?: string;
  itemCode?: string;
  quantity?: number;
  unitPrice?: number;
  lineTotal?: number;
  sourceLines?: readonly string[];
}

function hasCommercialNumericEvidence(input: CommercialItemValidityInput): boolean {
  const qty = input.quantity;
  const price = input.unitPrice;
  const total = input.lineTotal;
  if (qty !== undefined && qty > 0) return true;
  if (price !== undefined && price > 0) return true;
  if (total !== undefined && total > 0) return true;
  if ((price === 0 || total === 0) && (qty === undefined || qty > 0)) return true;
  return false;
}


const SETTLEMENT_OR_BALANCE = /\b(?:acconto|anticipo|caparra|deposito|deposit|advance\s+payment|amount\s+paid|pagato|paid|balance\s+due|saldo\s+(?:dovuto|da\s+pagare)|residuo\s+da\s+pagare|payment\s+instructions?|istruzioni\s+(?:di\s+)?pagamento|bank\s+transfer|bonifico\s+bancario|routing\s+aba)\b/i;

export function isSettlementOrBalanceText(value: string): boolean {
  return SETTLEMENT_OR_BALANCE.test(value.trim());
}

function looksLikeCompactItemCode(value?: string): boolean {
  const token = value?.trim() ?? '';
  if (token.length < 3 || token.length > 24 || /\s/.test(token)) return false;
  return /[A-Za-z]/.test(token) && /[0-9]/.test(token);
}

function looksLikeFreeOrIncludedItem(input: CommercialItemValidityInput): boolean {
  const desc = input.description?.trim() ?? '';
  if (!desc || TOTALS_OR_HEADER_ROW.test(desc) || isNonCommercialItemDescription(desc)) return false;
  const included = /\b(?:included|omaggio|complimentary|incluso|free\s+of\s+charge)\b/i.test(desc);
  if (!included && !looksLikeCompactItemCode(input.itemCode)) return false;
  if (PRODUCT_OR_SERVICE.test(desc) || included || looksLikeCompactItemCode(input.itemCode)) return true;
  const price = input.unitPrice;
  const total = input.lineTotal;
  return (price === 0 || total === 0) && desc.length >= 4 && !NOTES_OR_TERMS_ONLY.test(desc);
}

export function isPersistableCommercialItem(input: CommercialItemValidityInput): boolean {
  const desc = input.description?.trim() ?? '';
  if (!desc) return false;
  if (TOTALS_OR_HEADER_ROW.test(desc)) return false;
  // Settlements, deposits, balances and payment instructions are document-level
  // financial state, never commercial line items even when OCR finds amounts.
  if (isSettlementOrBalanceText(desc)) return false;
  if (NOTES_OR_TERMS_ONLY.test(desc) && !PRODUCT_OR_SERVICE.test(desc) && !looksLikeCompactItemCode(input.itemCode)) {
    return false;
  }
  if (isNotesOrTermsBoundary(desc) && !PRODUCT_OR_SERVICE.test(desc)) {
    return false;
  }
  if (isNonCommercialItemDescription(desc) && !hasCommercialNumericEvidence(input) && !looksLikeCompactItemCode(input.itemCode)) {
    return false;
  }
  if (hasCommercialNumericEvidence(input) || looksLikeCompactItemCode(input.itemCode)) return true;
  if (looksLikeFreeOrIncludedItem(input)) return true;
  if (NOTES_OR_TERMS_ONLY.test(desc) && !PRODUCT_OR_SERVICE.test(desc)) return false;
  return false;
}

export function persistableInputFromStructuredItem(item: {
  description?: { normalizedValue?: string };
  itemCode?: { normalizedValue?: string };
  quantity?: { normalizedValue?: number };
  unitPrice?: { normalizedValue?: number };
  lineTotal?: { normalizedValue?: number };
  sourceLines?: readonly string[];
}): CommercialItemValidityInput {
  return {
    description: item.description?.normalizedValue,
    itemCode: item.itemCode?.normalizedValue,
    quantity: item.quantity?.normalizedValue,
    unitPrice: item.unitPrice?.normalizedValue,
    lineTotal: item.lineTotal?.normalizedValue,
    sourceLines: item.sourceLines,
  };
}

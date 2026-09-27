/**
 * Document-level money classes. Semantic label evidence first; arithmetic second.
 * A negative amount is not automatically a discount. A value near 22 is not VAT.
 */

export type DocumentMoneyClass =
  | 'gross'
  | 'merchandise_subtotal'
  | 'discount'
  | 'net_taxable'
  | 'vat_amount'
  | 'vat_rate'
  | 'fees'
  | 'labor'
  | 'misc_charge'
  | 'shipping'
  | 'grand_total'
  | 'page_subtotal'
  | 'line_total'
  | 'unknown';

const VAT_EXCLUDED_LANGUAGE =
  /\b(?:al\s+netto\s+di\s+iva|iva\s+esclusa|iva\s+non\s+inclusa|vat\s+excluded|excluding\s+vat|hors\s+tva|zzgl\.?\s*mwst|ht\s+hors\s+tva|prezzi\s+si\s+intendono\s+al\s+netto)\b/i;

export interface DocumentMoneyBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DocumentMoneyCandidate {
  rawText: string;
  label?: string;
  bbox?: DocumentMoneyBox;
  zone?: string;
  semanticClass: DocumentMoneyClass;
  sign: 1 | -1;
  currency?: string;
  confidence: number;
  value: number;
}

const DISCOUNT_LABEL = /\b(?:discount|sconto|remise|rabatt|descuento)\b/i;
const TAXABLE_LABEL = /\b(?:imponibile|imponible|mpon\w*|taxable|netto|net\s+amount|net\s+taxable|subtotale|subtotal|total\s+ht|nettobetrag|base\s+imponibile|base\s+imponible|totale\s+m?pon\w*)\b/i;
const GROSS_LABEL = /\b(?:lordo|gross|total\s+ht\s+brut|brutto)\b/i;
const TOTAL_LABEL = /(?:\b(?:totale(?:\s+(?:documento|da\s+pagare|complessivo|ordine|fattura|preventivo|offerta))?|grand\s+total|total\s+due|amount\s+due|total\s+(?:factura|presupuesto|documento|ttc|general)|gesamtbetrag|endbetrag)\b|^total\s*:?\s*$)/i;
const LABOR_LABEL = /\b(?:manodopera|labor|labour|handwerk|main\s+d.?oeuvre)\b/i;
const SHIPPING_LABEL = /\b(?:trasporto|shipping|freight|porto|transport|imballo|packing|handling|spese\s+di\s+spedizione|spese\s+di\s+trasporto|frais\s+de\s+port)\b/i;
const VAT_AMOUNT_LABEL = /\b(?:iva|vat|tva|mwst|ust|imposta|impog)(?:\s+(?:importo|amount|totale))?\b|\btotale\s+imp(?!onib)\w*/i;
const VAT_RATE_LABEL = /\b(?:iva|vat|tva|mwst)\s*\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*%\s*(?:iva|vat|tva|mwst)\b/i;
const TABLE_HEADER = /^(?:sconto|discount|iva|vat|qta|qty|prezzo|price|totale|total|importo)\s*%?$/i;
const CENT = 0.05;

export function isVatExcludedLanguage(text: string | undefined): boolean {
  return !!text && VAT_EXCLUDED_LANGUAGE.test(text);
}

export function classifyMoneyLabel(label: string | undefined): DocumentMoneyClass {
  const text = (label ?? '').trim();
  if (!text) return 'unknown';
  if (isVatExcludedLanguage(text)) return 'net_taxable';
  if (TABLE_HEADER.test(text) && DISCOUNT_LABEL.test(text)) return 'unknown';
  if (DISCOUNT_LABEL.test(text) && !VAT_AMOUNT_LABEL.test(text)) return 'discount';
  if (VAT_RATE_LABEL.test(text) || (/%\s*$/.test(text) && VAT_AMOUNT_LABEL.test(text))) return 'vat_rate';
  if (LABOR_LABEL.test(text)) return 'labor';
  if (SHIPPING_LABEL.test(text)) return 'shipping';
  if (TAXABLE_LABEL.test(text)) return 'net_taxable';
  if (VAT_AMOUNT_LABEL.test(text) && !isVatExcludedLanguage(text)) return 'vat_amount';
  if (GROSS_LABEL.test(text)) return 'gross';
  if (TOTAL_LABEL.test(text)) return 'grand_total';
  return 'unknown';
}

/** Same source amount cannot be both grand total and VAT unless two distinct explicit labels prove it. */
export function sameAmountCannotBeTotalAndVat(
  vatAmount: number | undefined,
  grandTotal: number | undefined,
  options?: { vatLabel?: string; totalLabel?: string },
): boolean {
  if (vatAmount === undefined || grandTotal === undefined) return false;
  if (Math.abs(vatAmount - grandTotal) > CENT) return vatAmount >= grandTotal && grandTotal > 0;
  const vatClass = classifyMoneyLabel(options?.vatLabel);
  const totalClass = classifyMoneyLabel(options?.totalLabel);
  const distinctExplicit =
    vatClass === 'vat_amount' &&
    totalClass === 'grand_total' &&
    (options?.vatLabel ?? '').trim() !== (options?.totalLabel ?? '').trim();
  return !distinctExplicit;
}

export function grandTotalCannotEqualSubtotalWhenVatReconciles(input: {
  subtotal?: number;
  vatAmount?: number;
  grandTotal?: number;
  explicitGrandTotal?: number;
}): boolean {
  const subtotal = input.subtotal;
  const vat = input.vatAmount;
  const total = input.grandTotal;
  if (subtotal === undefined || vat === undefined || total === undefined) return false;
  if (Math.abs(subtotal - total) > CENT) return false;
  if (!(vat > CENT)) return false;
  const expected = Math.round((subtotal + vat) * 100) / 100;
  if (input.explicitGrandTotal !== undefined && Math.abs(input.explicitGrandTotal - expected) <= CENT) {
    return true;
  }
  return Math.abs(expected - total) > CENT;
}

export function sameSourceCannotOwnSubtotalAndGrandTotal(
  subtotalSource: string | undefined,
  grandTotalSource: string | undefined,
): boolean {
  if (!subtotalSource || !grandTotalSource) return false;
  return subtotalSource === grandTotalSource;
}

export function looksLikeVatRateNotAmount(value: number, rawText: string): boolean {
  if (/%/.test(rawText)) return true;
  return Number.isInteger(value) && value > 0 && value <= 23;
}

export function isPlausibleDocumentDiscount(candidate: DocumentMoneyCandidate): boolean {
  if (candidate.semanticClass !== 'discount') return false;
  if (candidate.confidence < 0.45) return false;
  if (looksLikeVatRateNotAmount(Math.abs(candidate.value), candidate.rawText)) return false;
  if (!candidate.label || TABLE_HEADER.test(candidate.label)) return false;
  return DISCOUNT_LABEL.test(candidate.label);
}

export type DocumentAmountRole =
  | 'merchandise_subtotal'
  | 'shipping'
  | 'fees'
  | 'discount_total'
  | 'taxable'
  | 'net_taxable'
  | 'vat_amount'
  | 'grand_total';

const INCOMPATIBLE_ROLES: Record<DocumentAmountRole, readonly DocumentAmountRole[]> = {
  merchandise_subtotal: ['vat_amount', 'shipping', 'grand_total'],
  taxable: ['vat_amount', 'shipping', 'grand_total'],
  net_taxable: ['vat_amount', 'shipping', 'grand_total'],
  vat_amount: ['merchandise_subtotal', 'taxable', 'net_taxable', 'shipping', 'grand_total'],
  shipping: ['merchandise_subtotal', 'taxable', 'net_taxable', 'vat_amount', 'grand_total'],
  fees: ['grand_total'],
  discount_total: ['vat_amount', 'grand_total'],
  grand_total: ['vat_amount', 'shipping', 'merchandise_subtotal', 'taxable', 'net_taxable'],
};

export function incompatibleAmountRoles(left: DocumentAmountRole, right: DocumentAmountRole): boolean {
  return left !== right && (INCOMPATIBLE_ROLES[left]?.includes(right) ?? false);
}

export function amountSourceKey(input: {
  pageIndex?: number;
  sourceLineIds?: readonly string[];
  boundingBox?: { x: number; y: number; width: number; height: number };
  rawToken?: string;
}): string {
  const valueId = input.sourceLineIds?.at(-1);
  if (valueId) return `${input.pageIndex ?? 0}:${valueId}`;
  const box = input.boundingBox;
  if (box) {
    return `${input.pageIndex ?? 0}:${Math.round(box.x)}:${Math.round(box.y)}:${input.rawToken ?? ''}`;
  }
  return `${input.pageIndex ?? 0}:${input.rawToken ?? ''}`;
}

export interface DiscountVatResolution {
  discount?: number;
  vatAmount?: number;
  netTaxable?: number;
  reason: string;
}

/**
 * Keep discount and VAT distinct when a document has no explicit subtotal.
 * Arithmetic may corroborate; it must not invent a class.
 */
export function resolveDocumentDiscountVsVat(
  candidates: readonly DocumentMoneyCandidate[],
): DiscountVatResolution {
  const namedDiscounts = candidates.filter((candidate) => candidate.semanticClass === 'discount');
  const discounts = namedDiscounts.filter(isPlausibleDocumentDiscount);
  const vats = candidates.filter((candidate) =>
    candidate.semanticClass === 'vat_amount'
    && !looksLikeVatRateNotAmount(Math.abs(candidate.value), candidate.rawText)
    && candidate.confidence >= 0.45,
  );
  const taxables = candidates.filter((candidate) =>
    candidate.semanticClass === 'net_taxable' && candidate.confidence >= 0.45,
  );
  const totals = candidates.filter((candidate) =>
    candidate.semanticClass === 'grand_total' && candidate.confidence >= 0.45,
  );
  const grosses = candidates.filter((candidate) =>
    candidate.semanticClass === 'gross' && candidate.confidence >= 0.45,
  );

  const best = (list: readonly DocumentMoneyCandidate[]) =>
    [...list].sort((left, right) => right.confidence - left.confidence)[0];

  const vat = best(vats);
  const discount = best(discounts);
  const taxable = best(taxables);
  const total = best(totals);
  const gross = best(grosses);
  const vatExcluded = candidates.some((candidate) =>
    isVatExcludedLanguage(candidate.label) || isVatExcludedLanguage(candidate.rawText));
  const vatConflictsWithTotal = sameAmountCannotBeTotalAndVat(vat?.value, total?.value, {
    vatLabel: vat?.label ?? vat?.rawText,
    totalLabel: total?.label ?? total?.rawText,
  });
  const safeVat = vat && !vatExcluded && !vatConflictsWithTotal ? vat : undefined;

  if (
    vat
    && namedDiscounts.some((candidate) => Math.abs(Math.abs(candidate.value) - Math.abs(vat.value)) <= CENT)
  ) {
    return {
      ...(safeVat ? { vatAmount: Math.abs(safeVat.value) } : {}),
      ...(taxable ? { netTaxable: taxable.value } : {}),
      reason: 'discount_equals_vat_amount_dropped_discount',
    };
  }

  const signedDiscount = discount
    ? -Math.abs(discount.value)
    : undefined;

  if (
    gross &&
    signedDiscount !== undefined &&
    taxable &&
    Math.abs(gross.value + signedDiscount - taxable.value) <= Math.max(CENT, Math.abs(taxable.value) * 0.02)
  ) {
    return {
      discount: signedDiscount,
      ...(safeVat ? { vatAmount: Math.abs(safeVat.value) } : {}),
      netTaxable: taxable.value,
      reason: 'gross_minus_discount_equals_taxable',
    };
  }

  if (
    taxable &&
    safeVat &&
    total &&
    Math.abs(taxable.value + Math.abs(safeVat.value) - total.value) <= Math.max(CENT, Math.abs(total.value) * 0.02)
  ) {
    return {
      ...(signedDiscount !== undefined ? { discount: signedDiscount } : {}),
      vatAmount: Math.abs(safeVat.value),
      netTaxable: taxable.value,
      reason: 'taxable_plus_vat_equals_total',
    };
  }

  if (!discount && !safeVat && !taxable) {
    return { reason: 'no_safe_discount_or_vat_semantics' };
  }

  return {
    ...(signedDiscount !== undefined ? { discount: signedDiscount } : {}),
    ...(safeVat ? { vatAmount: Math.abs(safeVat.value) } : {}),
    ...(taxable ? { netTaxable: taxable.value } : {}),
    reason: 'semantic_labels_only',
  };
}

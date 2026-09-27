export interface DocumentMonetarySnapshot {
  total?: number;
  subtotal?: number;
  vatAmount?: number;
  items?: readonly { total: number }[];
}

export interface SanitizedDocumentMonetaryFields extends DocumentMonetarySnapshot {
  rejected: string[];
  requiresReview: boolean;
}

const CENT_TOLERANCE = 0.05;

function finiteAmount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** P.IVA / VIN / altri ID numerici non devono finire negli importi. */
function looksLikeFiscalIdentifierAsAmount(value: number): boolean {
  if (!Number.isFinite(value) || value < 0) return false;
  if (Math.abs(value - Math.round(value)) > CENT_TOLERANCE) return false;
  const digits = String(Math.abs(Math.round(value)));
  return digits.length >= 9 && digits.length <= 13;
}

/**
 * Confronta un'IVA candidata con i totali gia' presenti sul documento.
 * Se imponibile e totale coincidono (o non tornano con l'IVA proposta) il candidato viene scartato:
 * meglio lasciare il valore esistente che sovrascriverlo con una cifra incoerente.
 */
export function reconcileVatWithExistingTotals(
  candidate: number | undefined,
  existing: { subtotal?: number; total?: number }
): { vatAmount?: number; rejected?: string } {
  const vatAmount = finiteAmount(candidate);
  if (vatAmount === undefined || Math.abs(vatAmount) <= CENT_TOLERANCE) {
    return vatAmount === undefined ? {} : { vatAmount };
  }
  const subtotal = finiteAmount(existing.subtotal);
  const total = finiteAmount(existing.total);
  if (subtotal === undefined || total === undefined) return { vatAmount };
  if (Math.abs(subtotal - total) <= CENT_TOLERANCE) {
    return { rejected: 'vat_conflicts_with_zero_vat_totals' };
  }
  if (Math.abs(subtotal + vatAmount - total) > CENT_TOLERANCE) {
    return { rejected: 'vat_breaks_existing_totals' };
  }
  return { vatAmount };
}

/**
 * Scarta importi palesemente incoerenti prima di salvarli o mostrarli.
 * Regola base: imponibile > totale → qualcosa non torna, meglio vuoto che sbagliato.
 */
export function sanitizeDocumentMonetaryFields(
  source: DocumentMonetarySnapshot
): SanitizedDocumentMonetaryFields {
  let total = finiteAmount(source.total);
  let subtotal = finiteAmount(source.subtotal);
  let vatAmount = finiteAmount(source.vatAmount);
  const rejected: string[] = [];

  const itemSum =
    source.items && source.items.length > 0
      ? source.items.reduce((sum, item) => sum + (finiteAmount(item.total) ?? 0), 0)
      : undefined;

  if (subtotal !== undefined && subtotal <= 0) {
    rejected.push('subtotal_non_positive');
    subtotal = undefined;
  }

  if (total !== undefined && total <= 0) {
    rejected.push('total_non_positive');
    total = undefined;
  }

  if (vatAmount !== undefined && vatAmount < 0) {
    rejected.push('vat_negative');
    vatAmount = undefined;
  }

  if (vatAmount !== undefined && looksLikeFiscalIdentifierAsAmount(vatAmount)) {
    rejected.push('vat_amount_looks_like_fiscal_id');
    vatAmount = undefined;
  }

  if (
    vatAmount !== undefined &&
    vatAmount > 0 &&
    vatAmount <= 23 &&
    Number.isInteger(vatAmount) &&
    (subtotal === undefined || subtotal > 200)
  ) {
    rejected.push('vat_amount_looks_like_rate');
    vatAmount = undefined;
  }

  if (subtotal !== undefined && looksLikeFiscalIdentifierAsAmount(subtotal)) {
    rejected.push('subtotal_looks_like_fiscal_id');
    subtotal = undefined;
  }

  if (total !== undefined && looksLikeFiscalIdentifierAsAmount(total)) {
    rejected.push('total_looks_like_fiscal_id');
    total = undefined;
  }

  // Footer/map scale OCR (for example `Scale 1:85.000.000`) can look like a
  // perfectly valid monetary amount.  When subtotal + VAT form a coherent
  // commercial total and the selected grand total is orders of magnitude
  // larger, prefer the coherent arithmetic total instead of persisting the
  // footer number.
  if (
    total !== undefined &&
    subtotal !== undefined &&
    vatAmount !== undefined &&
    subtotal > 0 &&
    vatAmount >= 0
  ) {
    const arithmeticTotal = Math.round((subtotal + vatAmount) * 100) / 100;
    const baseline = Math.max(arithmeticTotal, subtotal, itemSum ?? 0, 1);
    if (total > baseline * 100) {
      rejected.push('grand_total_absurd_vs_commercial_values');
      total = arithmeticTotal;
    }
  }

  // Grand total equal to the VAT amount, with a larger taxable subtotal, means
  // the VAT figure was selected as total. Repair before any "subtotal exceeds
  // total" wipe so both the subtotal and VAT amount stay available.
  if (
    total !== undefined &&
    vatAmount !== undefined &&
    subtotal !== undefined &&
    Math.abs(total - vatAmount) <= CENT_TOLERANCE &&
    subtotal > vatAmount + CENT_TOLERANCE
  ) {
    const derived = Math.round((subtotal + vatAmount) * 100) / 100;
    rejected.push('total_equals_vat_amount');
    total = derived;
  }

  if (total !== undefined && subtotal !== undefined && subtotal > total + CENT_TOLERANCE) {
    if (subtotal > total * 1.15) {
      rejected.push('subtotal_exceeds_total');
      subtotal = undefined;
      vatAmount = undefined;
    } else {
      rejected.push('subtotal_before_discount');
    }
  }

  if (
    total !== undefined &&
    vatAmount !== undefined &&
    subtotal !== undefined &&
    Math.abs(subtotal - total) <= CENT_TOLERANCE &&
    vatAmount > CENT_TOLERANCE
  ) {
    const expected = Math.round((subtotal + vatAmount) * 100) / 100;
    if (Math.abs(expected - total) > CENT_TOLERANCE) {
      rejected.push('grand_total_equals_subtotal_with_vat');
      total = expected;
    }
  }

  if (total !== undefined && vatAmount !== undefined && subtotal === undefined) {
    if (vatAmount > total + CENT_TOLERANCE) {
      rejected.push('vat_exceeds_total');
      vatAmount = undefined;
    } else if (Math.abs(vatAmount - total) <= CENT_TOLERANCE) {
      rejected.push('vat_equals_grand_total');
      vatAmount = undefined;
    }
  }

  // When the taxable subtotal + VAT already reconcile to the grand total, keep the
  // monetary triplet even if raw line items sum higher (discounts / gross lines / freight).
  const tripletCoherent =
    total !== undefined &&
    subtotal !== undefined &&
    vatAmount !== undefined &&
    Math.abs(subtotal + vatAmount - total) <= CENT_TOLERANCE;

  if (total !== undefined && itemSum !== undefined && itemSum > total * 1.02) {
    const looksLikeDiscountBeforeTotal =
      subtotal !== undefined &&
      subtotal >= itemSum * 0.98 &&
      subtotal > total + CENT_TOLERANCE;
    if (tripletCoherent) {
      rejected.push('line_items_exceed_total_ignored_coherent_triplet');
    } else if (!looksLikeDiscountBeforeTotal) {
      // Explicit labeled totals stay. Line-sum disagreement is a review signal
      // only — never delete the document total to force arithmetic equality.
      rejected.push('line_items_exceed_total');
    } else {
      rejected.push('discount_before_total');
    }
  }

  if (
    total !== undefined &&
    subtotal !== undefined &&
    subtotal > total * 2
  ) {
    rejected.push('subtotal_absurd_vs_total');
    subtotal = undefined;
    vatAmount = undefined;
    if (total < 100) {
      rejected.push('total_suspect_vs_subtotal');
      total = undefined;
    }
  }

  // Totale ridicolo rispetto a somma righe (es. 15 € invece di 680,70).
  if (
    total !== undefined &&
    total < 100 &&
    itemSum !== undefined &&
    itemSum > 200 &&
    itemSum > total * 4
  ) {
    rejected.push('total_too_small_vs_items');
    total = undefined;
  }

  if (
    total !== undefined &&
    total < 100 &&
    subtotal !== undefined &&
    subtotal > 500
  ) {
    rejected.push('total_too_small_vs_subtotal');
    total = undefined;
    subtotal = undefined;
    vatAmount = undefined;
  }

  return {
    ...(total !== undefined ? { total } : {}),
    ...(subtotal !== undefined ? { subtotal } : {}),
    ...(vatAmount !== undefined ? { vatAmount } : {}),
    rejected,
    requiresReview: rejected.length > 0,
  };
}

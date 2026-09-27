import type {
  DocumentEvidence,
  StructuredDocumentSummary,
  StructuredLineItem,
} from './document-structure';

export interface MonetaryConsistencyResult {
  items: StructuredLineItem[];
  summary: StructuredDocumentSummary;
  conflicts: string[];
  consistent: boolean;
  requiresReview: boolean;
}

const CENT_TOLERANCE = 0.02;

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= CENT_TOLERANCE;
}

function moneyCloseEnough(a: number, b: number): boolean {
  // OCR/imported documents can differ by one cent per commercial row because
  // discounts are rounded at row level. Keep the tolerance bounded: this is
  // not a license to hide materially inconsistent totals.
  return Math.abs(a - b) <= Math.max(CENT_TOLERANCE, Math.max(Math.abs(a), Math.abs(b)) * 0.00005);
}

function discountIsPercentage(evidence: DocumentEvidence<number> | undefined): boolean {
  if (!evidence) return false;
  const raw = String(evidence.rawValue ?? '');
  return /%/.test(raw) || evidence.reasons.some((reason) => /percent|discount_column/i.test(reason));
}

function conflictEvidence<T>(evidence: DocumentEvidence<T>, reason: string): DocumentEvidence<T> {
  return {
    ...evidence,
    validationStatus: 'ambiguous',
    reasons: [...new Set([...evidence.reasons, reason])],
    requiresReview: true,
    conflict: true,
  };
}

function numeric(evidence: DocumentEvidence<number> | undefined): number | undefined {
  return evidence?.normalizedValue;
}

function validateItem(item: StructuredLineItem, index: number): { item: StructuredLineItem; conflicts: string[] } {
  const quantity = numeric(item.quantity);
  const unitPrice = numeric(item.unitPrice);
  const lineTotal = numeric(item.lineTotal);
  if (quantity === undefined || unitPrice === undefined || lineTotal === undefined) {
    return { item, conflicts: [] };
  }
  const grossExpected = quantity * unitPrice;
  const discount = numeric(item.discount);
  const discountedExpected = discount !== undefined
    && discount > 0
    && discount < 100
    && discountIsPercentage(item.discount)
    ? grossExpected * (1 - discount / 100)
    : grossExpected;

  // Some invoices expose a discount column while the unit-price column is
  // already net. Accept either arithmetically demonstrated interpretation;
  // otherwise the row remains reviewable instead of forcing the discount twice.
  if (moneyCloseEnough(discountedExpected, lineTotal) || moneyCloseEnough(grossExpected, lineTotal)) {
    return { item, conflicts: [] };
  }
  const reason = `line_${index + 1}_quantity_price_total_mismatch`;
  return {
    item: {
      ...item,
      quantity: conflictEvidence(item.quantity!, reason),
      unitPrice: conflictEvidence(item.unitPrice!, reason),
      lineTotal: conflictEvidence(item.lineTotal!, reason),
      requiresReview: true,
    },
    conflicts: [reason],
  };
}

export function validateDocumentMonetaryConsistency(
  sourceItems: readonly StructuredLineItem[],
  sourceSummary: StructuredDocumentSummary,
): MonetaryConsistencyResult {
  const itemResults = sourceItems.map(validateItem);
  const items = itemResults.map((result) => result.item);
  const conflicts = itemResults.flatMap((result) => result.conflicts);
  let summary: StructuredDocumentSummary = {
    ...sourceSummary,
    conflicts: [...sourceSummary.conflicts],
  };

  const lineTotals = items.map((item) => numeric(item.lineTotal)).filter((value): value is number => value !== undefined);
  const subtotal = numeric(summary.subtotal) ?? numeric(summary.taxableAmount);
  if (lineTotals.length === items.length && items.length > 0 && subtotal !== undefined) {
    const sum = lineTotals.reduce((total, value) => total + value, 0);
    const documentDiscount = numeric(summary.discountTotal);
    const shipping = numeric(summary.shippingCost);
    const candidates = [
      sum,
      documentDiscount !== undefined ? sum - Math.abs(documentDiscount) : undefined,
      shipping !== undefined ? sum + shipping : undefined,
      documentDiscount !== undefined && shipping !== undefined
        ? sum - Math.abs(documentDiscount) + shipping
        : undefined,
    ].filter((value): value is number => value !== undefined);
    if (!candidates.some((candidate) => moneyCloseEnough(candidate, subtotal))) {
      const reason = 'line_sum_subtotal_mismatch';
      conflicts.push(reason);
      summary = {
        ...summary,
        ...(summary.subtotal ? { subtotal: conflictEvidence(summary.subtotal, reason) } : {}),
        ...(summary.taxableAmount ? { taxableAmount: conflictEvidence(summary.taxableAmount, reason) } : {}),
      };
    }
  }

  const vat = numeric(summary.vatAmount);
  const total = numeric(summary.total);
  if (subtotal !== undefined && vat !== undefined && total !== undefined && !moneyCloseEnough(subtotal + vat, total)) {
    const reason = 'subtotal_vat_total_mismatch';
    conflicts.push(reason);
    summary = {
      ...summary,
      ...(summary.subtotal ? { subtotal: conflictEvidence(summary.subtotal, reason) } : {}),
      vatAmount: conflictEvidence(summary.vatAmount!, reason),
      total: conflictEvidence(summary.total!, reason),
    };
  }

  const taxAmounts = summary.taxSummaries
    .map((entry) => numeric(entry.vatAmount))
    .filter((value): value is number => value !== undefined);
  if (vat !== undefined && taxAmounts.length > 1) {
    const taxSum = taxAmounts.reduce((sum, value) => sum + value, 0);
    if (!moneyCloseEnough(taxSum, vat)) {
      const reason = 'tax_summary_vat_mismatch';
      conflicts.push(reason);
      summary = { ...summary, vatAmount: conflictEvidence(summary.vatAmount!, reason) };
    }
  }

  const uniqueConflicts = [...new Set([...summary.conflicts, ...conflicts])];
  summary = {
    ...summary,
    conflicts: uniqueConflicts,
    requiresReview: summary.requiresReview || uniqueConflicts.length > 0,
  };
  return {
    items,
    summary,
    conflicts: uniqueConflicts,
    consistent: uniqueConflicts.length === 0,
    requiresReview: uniqueConflicts.length > 0 || items.some((item) => item.requiresReview) || summary.requiresReview,
  };
}

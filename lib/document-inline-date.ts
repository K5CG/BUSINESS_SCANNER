const INLINE_DOCUMENT_NUMBER_DATE =
  /\b(?:n[rº°o.]?|no\.?|nr\.?|num(?:ero)?(?:\s+documento)?|invoice\s+no\.?|order(?:\s+confirmation)?\s+no\.?|quote\s+no\.?|quotation\s+no\.?|document\s+no\.?|preventivo\s*n\.?|ordine\s*n\.?|fattura\s*n\.?|auftragsnummer|rechnungsnummer|angebotsnummer|n\.\s*documento)\s*[:\s#]*([A-Z0-9][A-Z0-9/._-]{1,28})\s+(?:\bdel\b|\bdated\b|\bdate\b|\bdu\b|\bvom\b|\bde\s+fecha\b)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/i;

const INLINE_CONNECTOR_DATE =
  /(?:\bdel\b|\bdated\b|\bdate\b|\bdu\b|\bvom\b|\bde\s+fecha\b)\s+(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\b/i;

const INLINE_CORRUPT_DATE =
  /(?:\bdel\b|\bdated\b|\bdate\b|\bdu\b|\bvom\b|\bde\s+fecha\b)\s+([0-9oOIl./-]{8,12})\b/;

const DOCUMENT_NUMBER_LABEL =
  /\b(?:n[rº°o.]?|no\.?|nr\.?|num(?:ero)?|invoice\s+no\.?|order(?:\s+confirmation)?\s+no\.?|quote\s+no\.?|quotation\s+no\.?|document\s+no\.?|preventivo\s*n\.?|ordine\s*n\.?|fattura\s*n\.?|auftragsnummer|rechnungsnummer|angebotsnummer)\b/i;

export interface InlineDocumentNumberDate {
  rawDate: string;
  identifier: string;
  dayFirst: boolean;
}

function dayFirstConnector(text: string): boolean {
  return /(?:\bdel\b|\bdu\b|\bvom\b|\bde\s+fecha\b)/i.test(text);
}

/** Constrained OCR repair for dates that follow a document-number connector. */
export function normalizeCorruptedInlineDateToken(raw: string): string | undefined {
  const compact = raw.replace(/\s+/g, '');
  // Real-device OCR can render `27/03/2026` as `27IO3/2026`: the slash
  // becomes I/l and the leading zero of the month becomes O. Repair only
  // this tightly constrained day-month-year shape after a document-date
  // connector; never apply it to arbitrary identifiers or amounts.
  const fusedSeparator = compact.match(/^(\d{1,2})[Il](?:[oO0])(\d)[./-](\d{2,4})$/);
  const match = fusedSeparator ?? compact.match(/^(\d{1,2})[oO0Il./-](\d{1,2})[vVIl./-](\d{2,4})$/);
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return undefined;
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined;
  if (year < 1990 || year > 2090) return undefined;
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

export function extractInlineDocumentNumberDate(text: string): InlineDocumentNumberDate | undefined {
  const match = text.match(INLINE_DOCUMENT_NUMBER_DATE);
  if (match?.[1] && match[2]) {
    return { identifier: match[1], rawDate: match[2], dayFirst: dayFirstConnector(text) };
  }
  if (!DOCUMENT_NUMBER_LABEL.test(text)) return undefined;
  const identifier = text.match(/\b([A-Z0-9][A-Z0-9/._-]{2,28})\b/i)?.[1];
  const dated = text.match(INLINE_CONNECTOR_DATE)?.[1];
  if (identifier && dated && !/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(identifier)) {
    return { identifier, rawDate: dated, dayFirst: dayFirstConnector(text) };
  }
  const corrupted = text.match(INLINE_CORRUPT_DATE)?.[1];
  if (!identifier || !corrupted) return undefined;
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(identifier)) return undefined;
  const normalized = normalizeCorruptedInlineDateToken(corrupted);
  if (!normalized) return undefined;
  return { identifier, rawDate: normalized, dayFirst: dayFirstConnector(text) };
}

export function hasInlineDocumentNumberDate(text: string): boolean {
  return !!extractInlineDocumentNumberDate(text);
}

/**
 * La data di un documento commerciale è un giorno di calendario, non un
 * istante: il 6 febbraio resta il 6 febbraio anche se il telefono cambia fuso.
 * Scritta come istante UTC tornerebbe indietro di un giorno a est di Greenwich,
 * quindi qui viaggia sempre come `YYYY-MM-DD` e rinasce alla mezzanotte locale.
 */

/** Campi che rappresentano un giorno di calendario e non un momento preciso. */
export const DOCUMENT_DATE_ONLY_FIELDS = [
  'quoteDate',
  'validUntil',
  'orderDate',
  'deliveryDate',
  'invoiceDate',
  'dueDate',
  'documentDate',
] as const;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function documentDateOnlyText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const iso = value.match(DATE_ONLY);
    if (iso) return value;
  }
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Rilegge un giorno salvato. I record scritti prima di questa forma contengono
 * un istante completo: continuano a essere letti come prima.
 */
export function documentDateFromStored(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value !== 'string') return undefined;
  const iso = value.match(DATE_ONLY);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function withDocumentDateOnlyFields(
  record: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...record };
  for (const field of DOCUMENT_DATE_ONLY_FIELDS) {
    if (out[field] == null) continue;
    const text = documentDateOnlyText(out[field]);
    if (text) out[field] = text;
  }
  return out;
}

export type VatColumnConfidence =
  | 'explicit_vat_header'
  | 'fuzzy_vat_header'
  | 'repeated_rate_column'
  | 'ambiguous_rate_column';

export const PLAUSIBLE_VAT_RATES = new Set([4, 5, 10, 19, 20, 21, 22, 23]);

const EXPLICIT_VAT_HEADER =
  /^(?:i?va|va|vat|tva|mwst\.?|ust\.?|aliq(?:uota)?\.?|aliquota|impuesto|tipo\s*iva|tax)(?:\s*%|\s+rate|\s+\(\s*%\s*\))?$/i;
const VAT_HEADER_TARGETS = ['iva', 'vat', 'tva', 'mwst', 'ust', 'aliq', 'aliquota'];
const DISCOUNT_HEADER = /^(?:sconto|scanto|discount|disc\.?|sc\.?|remise|rem\.?|rabatt|descuento|desc\.?|dto\.?)(?:\s*%|\s+listino|\s+\(\s*%\s*\))?$/i;
const DISCOUNT_HEADER_TARGETS = ['sconto', 'discount', 'remise', 'rabatt', 'descuento'];
const VAT_HEADER_FALSE_POSITIVES = new Set([
  'ht', 'ttc', 'qta', 'qty', 'qte', 'um', 'udm', 'sas', 'srl', 'gmbh', 'ltd', 'spa',
  'des', 'de', 'du', 'del', 'die', 'der', 'den', 'das', 'the', 'and', 'und', 'et',
  'la', 'le', 'el', 'di', 'da', 'of', 'to', 'sa', 'inc', 'bv', 'oy', 'ab', 'pu',
  'sconto', 'sc', 'remise', 'rabatt', 'prezzo', 'price', 'importo', 'amount',
]);

export interface VatColumnLine {
  text: string;
  x: number;
  centerX?: number;
  y?: number;
}

export interface VatColumnInput {
  existingColumns: Array<{ kind: string; x: number }>;
  bodyLines: readonly VatColumnLine[];
  headerLines?: readonly VatColumnLine[];
  pageWidth?: number;
}

export interface InferredVatColumn {
  x: number;
  confidence: VatColumnConfidence;
}

function compactToken(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

export function parseDiscountPercent(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const compact = trimmed.replace(/\s+/g, '');
  // O,00% / O,009% / 0,00% / O.00% are zero-like OCR, not 9%.
  const zeroLike = compact.replace(/^[oOQ](?=[.,])/, '0');
  if (/^0[.,](?:0+|00\d|009)\s*%$/.test(zeroLike)) return 0;
  const percent = compact.match(/^(-?\d{1,2})(?:[.,](\d{1,3}))?\s*%$/);
  if (percent) {
    const whole = Number(percent[1]);
    const frac = percent[2] ?? '';
    if (!Number.isFinite(whole) || whole < 0 || whole > 80) return undefined;
    if (frac.length <= 2) {
      const value = Number(`${percent[1]}.${frac || '0'}`.replace(/^\d+\.$/, `${percent[1]}.0`));
      if (!Number.isFinite(value) || value < 0 || value > 80) return undefined;
      return value;
    }
    // 10,009% / 10.009% in a discount column is OCR junk after two decimals.
    if (/^0+$/.test(frac) || /^00\d$/.test(frac) || /^009$/.test(frac)) return whole;
    return undefined;
  }
  const leadingDot = compact.match(/^\.(0{2,3}|00\d)\s*%$/);
  if (leadingDot) return 0;
  const ocrOh = compact.match(/^(-?\d{1,2})[oO]\s*%?$/);
  if (ocrOh) {
    const value = Number(ocrOh[1]);
    if (!Number.isFinite(value) || value < 0 || value > 80) return undefined;
    return value;
  }
  const bare = trimmed.match(/^(-?\d{1,2})$/);
  if (!bare) return undefined;
  const value = Number(bare[1]);
  if (!Number.isFinite(value) || value < 0 || value > 80) return undefined;
  return value;
}

/** Repair OCR-garbled VAT tokens that already sit in a VAT column. */
export function parseCorruptedVatToken(text: string): number | undefined {
  const clean = parsePlausibleVatRate(text);
  if (clean !== undefined) return clean;
  const compact = text.trim().replace(/\s+/g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[°º\u00ba\u00aa]/g, '');
  const cleaned = parsePlausibleVatRate(compact) ?? parsePlausibleVatRate(compact.replace(/[^\d%.,]/g, ''));
  if (cleaned !== undefined) return cleaned;
  if (/^2[z2il][%]?$/i.test(compact)) return 22;
  const trailingLetter = compact.match(/^([12]\d)[a-z]$/i);
  if (trailingLetter) {
    const rate = Number(trailingLetter[1]);
    return PLAUSIBLE_VAT_RATES.has(rate) ? rate : undefined;
  }
  const extraDigitPercent = compact.match(/^([12]\d)\d{1,3}%$/);
  if (extraDigitPercent) {
    const rate = Number(extraDigitPercent[1]);
    return PLAUSIBLE_VAT_RATES.has(rate) ? rate : undefined;
  }
  const junkPercent = compact.match(/^([12]\d)[^\d%]{1,3}%$/);
  if (junkPercent) {
    const rate = Number(junkPercent[1]);
    return PLAUSIBLE_VAT_RATES.has(rate) ? rate : undefined;
  }
  if (/[.,]\d{2}$/.test(compact)) return undefined;
  const digits = compact.replace(/[^0-9]/g, '');
  if (/^([12]\d)\d{1,3}$/.test(digits)) {
    const rate = Number(digits.slice(0, 2));
    if (PLAUSIBLE_VAT_RATES.has(rate) && rate >= 19) return rate;
  }
  return undefined;
}

export function parsePlausibleVatRate(text: string): number | undefined {
  const trimmed = text.trim();
  const percent = trimmed.match(/^([IIL1]?[0-9]{1,2}(?:[.,]\d{1,2})?)\s*%$/i);
  const bare = trimmed.match(/^([IIL1]?[0-9]{1,2}(?:[.,]\d{1,2})?)$/i);
  const raw = (percent?.[1] ?? bare?.[1])?.replace(/^[IIL]/i, '1');
  if (!raw) return undefined;
  const hasDecimals = /[.,]\d+/.test(raw);
  const value = Number(raw.replace(',', '.'));
  const normalized = value === 122 ? 22 : value;
  if (!PLAUSIBLE_VAT_RATES.has(normalized)) return undefined;
  // 10,00 / 4,00 look like money. Keep ,00 only for the common 19–23 VAT column form.
  if (hasDecimals && percent === null && (normalized < 19 || normalized > 23)) return undefined;
  return normalized;
}

export function isExplicitVatHeader(text: string): boolean {
  return EXPLICIT_VAT_HEADER.test(text.trim());
}

export function isFuzzyDiscountHeader(text: string): boolean {
  if (DISCOUNT_HEADER.test(text.trim()) || isExplicitVatHeader(text)) return false;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length > 2) return false;
  const compact = compactToken(text);
  if (!compact || compact.length < 4 || compact.length > 12) return false;
  return DISCOUNT_HEADER_TARGETS.some((target) => {
    if (Math.abs(compact.length - target.length) > 2) return false;
    return editDistance(compact, target) <= 2;
  });
}

export function isDiscountHeader(text: string): boolean {
  return DISCOUNT_HEADER.test(text.trim()) || isFuzzyDiscountHeader(text);
}

export function isFuzzyVatHeader(text: string): boolean {
  if (isExplicitVatHeader(text) || isDiscountHeader(text)) return false;
  if (/^v\.?a\.?$/i.test(text.trim())) return true;
  const words = text.trim().split(/\s+/).filter(Boolean);
  // Party names and sentences are not column headers. Keep "NA S" / "1 VA".
  if (words.length > 3) return false;
  const candidates = [compactToken(text)];
  if (words.length <= 2) {
    candidates.push(...words.map(compactToken));
  }
  return candidates.some((compact) => {
    if (!compact || VAT_HEADER_FALSE_POSITIVES.has(compact)) return false;
    if (compact.length < 3 || compact.length > 10 || /^\d+$/.test(compact)) return false;
    return VAT_HEADER_TARGETS.some((target) => {
      if (target.length <= 3 && compact.length !== target.length) return false;
      if (Math.abs(compact.length - target.length) > 1) return false;
      return editDistance(compact, target) <= 2;
    });
  });
}

export function vatHeaderConfidence(text: string): VatColumnConfidence | undefined {
  if (isExplicitVatHeader(text)) return 'explicit_vat_header';
  if (isFuzzyVatHeader(text)) return 'fuzzy_vat_header';
  return undefined;
}

function clusterByX(lines: readonly VatColumnLine[], tolerance: number): Array<{ x: number; lines: VatColumnLine[] }> {
  const clusters: Array<{ x: number; lines: VatColumnLine[] }> = [];
  const sorted = [...lines].sort((left, right) => left.x - right.x);
  for (const line of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(last.x - line.x) <= tolerance) {
      last.lines.push(line);
      last.x = last.lines.reduce((sum, entry) => sum + entry.x, 0) / last.lines.length;
    } else {
      clusters.push({ x: line.x, lines: [line] });
    }
  }
  return clusters;
}

function columnX(columns: Array<{ kind: string; x: number }>, kind: string): number | undefined {
  const matches = columns.filter((column) => column.kind === kind).map((column) => column.x);
  return matches.length > 0 ? Math.max(...matches) : undefined;
}

export function inferVatColumn(input: VatColumnInput): InferredVatColumn | undefined {
  const explicit = input.existingColumns.find((column) => column.kind === 'vatRate');
  if (explicit) return { x: explicit.x, confidence: 'explicit_vat_header' };

  const fuzzyHeader = (input.headerLines ?? []).find((line) => isFuzzyVatHeader(line.text));
  const width = input.pageWidth ?? 1200;
  const tolerance = Math.max(35, width * 0.02);
  const rateLines = input.bodyLines.filter((line) => parsePlausibleVatRate(line.text) !== undefined);
  if (rateLines.length < 2 && !fuzzyHeader) return undefined;

  const clusters = clusterByX(rateLines, tolerance).filter((cluster) => cluster.lines.length >= (fuzzyHeader ? 1 : 2));
  if (clusters.length === 0 && fuzzyHeader) {
    return { x: fuzzyHeader.x, confidence: 'fuzzy_vat_header' };
  }

  const discountX = columnX(input.existingColumns, 'discount');
  const quantityX = columnX(input.existingColumns, 'quantity');
  const totalX = columnX(input.existingColumns, 'lineTotal');
  const unitPriceX = columnX(input.existingColumns, 'unitPrice');
  const occupied = [discountX, quantityX, unitPriceX].filter((value): value is number => value !== undefined);

  const ranked = clusters
    .map((cluster) => {
      const rates = cluster.lines
        .map((line) => parsePlausibleVatRate(line.text))
        .filter((value): value is number => value !== undefined);
      const unique = new Set(rates);
      const rightOfPrice = unitPriceX === undefined || cluster.x > unitPriceX + tolerance * 0.4;
      const nearAmount = totalX === undefined
        || Math.abs(cluster.x - totalX) <= Math.max(180, width * 0.22)
        || cluster.x > totalX - tolerance;
      const besideTotal = rightOfPrice && nearAmount;
      const collidesOccupied = occupied.some((x) => Math.abs(cluster.x - x) <= tolerance);
      const onlyTypicalDiscount = unique.size === 1 && [...unique][0] === 10 && discountX === undefined;
      const headerNear = (input.headerLines ?? []).some((line) =>
        Math.abs(line.x - cluster.x) <= tolerance * 1.5 && (isExplicitVatHeader(line.text) || isFuzzyVatHeader(line.text)));
      return { cluster, rates, unique, besideTotal, collidesOccupied, onlyTypicalDiscount, headerNear };
    })
    .filter((entry) => !entry.collidesOccupied && entry.besideTotal);

  if (ranked.length === 0) return undefined;
  const best = [...ranked].sort((left, right) => (
    Number(right.headerNear) - Number(left.headerNear)
    || right.cluster.lines.length - left.cluster.lines.length
    || right.cluster.x - left.cluster.x
  ))[0];

  if (best.onlyTypicalDiscount && !best.headerNear) {
    return { x: best.cluster.x, confidence: 'ambiguous_rate_column' };
  }
  if (best.headerNear && fuzzyHeader) return { x: best.cluster.x, confidence: 'fuzzy_vat_header' };
  if (best.headerNear) return { x: best.cluster.x, confidence: 'fuzzy_vat_header' };
  if (best.unique.size >= 1 && best.cluster.lines.length >= 2) {
    return { x: best.cluster.x, confidence: 'repeated_rate_column' };
  }
  return { x: best.cluster.x, confidence: 'ambiguous_rate_column' };
}

export function shouldAssignInferredVat(confidence: VatColumnConfidence | undefined): boolean {
  return confidence === 'explicit_vat_header'
    || confidence === 'fuzzy_vat_header'
    || confidence === 'repeated_rate_column';
}

export interface InferredDiscountColumn {
  x: number;
  confidence: VatColumnConfidence;
}

export function inferDiscountColumn(input: VatColumnInput): InferredDiscountColumn | undefined {
  const explicit = input.existingColumns.find((column) => column.kind === 'discount');
  if (explicit) return { x: explicit.x, confidence: 'explicit_vat_header' };

  const header = (input.headerLines ?? []).find((line) => isDiscountHeader(line.text));
  const width = input.pageWidth ?? 1200;
  const tolerance = Math.max(35, width * 0.02);
  const percentLines = input.bodyLines.filter((line) =>
    /%\s*$/.test(line.text.trim()) && parseDiscountPercent(line.text) !== undefined);
  const vatX = columnX(input.existingColumns, 'vatRate');
  const totalX = columnX(input.existingColumns, 'lineTotal');
  const unitPriceX = columnX(input.existingColumns, 'unitPrice');

  if (header) return { x: header.x, confidence: 'fuzzy_vat_header' };
  if (percentLines.length < 2) return undefined;

  const clusters = clusterByX(percentLines, tolerance).filter((cluster) => cluster.lines.length >= 2);
  const ranked = clusters
    .map((cluster) => {
      const collidesVat = vatX !== undefined && Math.abs(cluster.x - vatX) <= tolerance;
      const leftOfTotal = totalX === undefined || cluster.x < totalX - tolerance * 0.3;
      const rightOfPrice = unitPriceX === undefined || cluster.x > unitPriceX - tolerance;
      return { cluster, collidesVat, leftOfTotal, rightOfPrice };
    })
    .filter((entry) => !entry.collidesVat && entry.leftOfTotal && entry.rightOfPrice);

  if (ranked.length === 0) return undefined;
  const best = [...ranked].sort((left, right) => right.cluster.lines.length - left.cluster.lines.length)[0];
  return { x: best.cluster.x, confidence: 'repeated_rate_column' };
}

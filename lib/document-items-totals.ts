import type {
  DocumentEvidence,
  DocumentLayoutLine,
  StructuredDocumentConditions,
  StructuredDocumentPage,
  StructuredDocumentSummary,
  StructuredShippingSection,
  StructuredLineItem,
  StructuredTaxSummary,
} from './document-structure';
import { documentEvidence, normalizeDocumentText } from './document-structured-evidence';
import { findDocumentLabel, matchesDocumentLabel, normalizeDocumentLabel, type DocumentLabelConcept } from './document-label-dictionary';
import { looksLikeInternationalTaxIdentifier, parseInternationalAmount } from './document-international-values';
import { classifyFiscalIdentifierAmount, hasFiscalIdentifierLabel } from './document-fiscal-identifier';
import { isDevLogEnabled } from './release-diagnostics';
import { isQaDocumentLoggingEnabled, logQaDocument } from './qa-document-logging';
import { looksLikeTechnicalMeasure } from './document-line-item-numeric-repair';
import {
  parseQuantityCell,
  quantityProvenanceReason,
  resolveRowQuantity,
} from './document-quantity-tokens';
import {
  amountSourceKey,
  classifyMoneyLabel,
  incompatibleAmountRoles,
  isVatExcludedLanguage,
  looksLikeVatRateNotAmount,
  resolveDocumentDiscountVsVat,
  sameAmountCannotBeTotalAndVat,
  grandTotalCannotEqualSubtotalWhenVatReconciles,
  sameSourceCannotOwnSubtotalAndGrandTotal,
  type DocumentMoneyCandidate,
} from './document-money-semantics';
import { selectCoherentCommercialLevel, isSummaryOrAggregateHeading } from './document-table-hierarchy';
import {
  scoreTableSchemaWithMirror,
  segmentHeaderLine,
  repairTableSchemaColumns,
} from './document-header-segmentation';
import { reattachOrphanNumericCells } from './document-orphan-cells';
import { assignUnownedNumericClusters } from './document-row-clusters';
import {
  deriveDocumentDiscountFromSurroundingTotals,
  documentDiscountValueRejection,
  isExplicitDocumentDiscountLabel,
  logDocumentDiscountCandidate,
} from './document-discount-ownership';
import {
  grandTotalCannotEqualTaxable,
  isPlausibleDocumentDiscountAmount,
  recoverGrandTotalAboveTaxable,
  rejectTaxablePromotedToGrandTotal,
} from './document-totals-roles';
import { logSemanticRoleViolation } from './document-field-evidence';
import { isLegalOrBankFooterText, isNonCommercialItemDescription, isNotesOrTermsBoundary, isPersistableCommercialItem, isTableFooterHeading, persistableInputFromStructuredItem } from './document-item-validity';
import {
  inferDiscountColumn,
  inferVatColumn,
  isDiscountHeader,
  isExplicitVatHeader,
  isFuzzyVatHeader,
  parseCorruptedVatToken,
  parseDiscountPercent,
  parsePlausibleVatRate,
  shouldAssignInferredVat,
} from './document-vat-column';
import {
  isCarryForwardText,
  isHistoricalOrStatisticalRecapText,
  isTaxRecapHeadingText,
  looksLikeIsolatedOcrNoiseToken,
} from './document-region-model';
import {
  countDocumentProcessPerf,
  documentProcessPerfStageEnd,
  documentProcessPerfStageStart,
} from './document-process-perf';
import {
  ITEMS_CHECK_EVERY,
  layoutDeadlineExceeded,
  logItemsCallPerf,
  logItemsPerf,
  logItemsPostPerf,
  logItemsTotalsPerf,
  logItemsZonePerf,
  logItemParsePerf,
  logRowPrePerf,
  logRowGroupPerf,
  logSummaryPerf,
  logTableHeadersPerf,
  logTotalsPerf,
} from './structured-layout-runtime';

export interface ExtractItemsTotalsOptions {
  deadline?: number;
  /**
   * Test-only: restore the pre-iter26 page loop that aborted the whole document
   * once the shared deadline expired (phone ThermoFlux 9-item failure mode).
   */
  abortLaterPagesWhenTimedOut?: boolean;
  /**
   * Test-only: stop after N supported anchors on the first table page
   * (phone ThermoFlux 8-item live path: page 1 truncated mid-body).
   */
  abortAfterSupportedAnchors?: number;
}

const COLUMN_KIND_TEXT_CACHE = new Map<string, ColumnKind | undefined>();
const VAT_SUMMARY_CACHE = new Map<string, boolean>();
const FINAL_TOTAL_CACHE = new Map<string, boolean>();
const TOTAL_SCORE_CACHE = new Map<string, number>();

export function resetDocumentItemsCaches(): void {
  COLUMN_KIND_TEXT_CACHE.clear();
  VAT_SUMMARY_CACHE.clear();
  FINAL_TOTAL_CACHE.clear();
  TOTAL_SCORE_CACHE.clear();
  DETECT_COLUMN_CACHE.clear();
}
const ITEMS_COMPLETION_BUDGET_MS = 3_000;
let vatCandidateDebugCount = 0;
const MAX_VAT_CANDIDATE_DEBUG = 12;

function logVatCandidateDebug(detail: Record<string, unknown>): void {
  if (!isDevLogEnabled()) return;
  if (vatCandidateDebugCount >= MAX_VAT_CANDIDATE_DEBUG) return;
  vatCandidateDebugCount += 1;
  console.warn(`[VatCandidateDebug] ${JSON.stringify(detail)}`);
}

const RE_SUBTOTAL_LABEL = /\b(?:subtotale|imponibile|mpon\w*|subtotal|taxable|totale imponibile|totale\s+m?pon\w*|total ht|montant ht|sous-total|zwischensumme)\b/i;
const RE_TAXABLE_LABEL = /\b(?:imponibile|mpon\w*|subtotal|taxable|total ht|montant ht|totale\s+[a-z]?pon\w*)\b/i;
const RE_VAT_AMOUNT_LABEL = /\b(?:(?:totale?s?|tqtale)\s+imp(?!onib)\w*|iva\s+totale|importo\s+iva|totale\s+iva|total\s+vat|vat\s+amount|montant\s+tva|total\s+tva)\b/i;
const RE_SUMMARY_FOOTER = /\b(?:subtotale|imponibile|totale documento|grand total|amount due|total due|total ttc|gesamtbetrag)\b/i;
const RE_MONETARY_SUMMARY = /\b(?:imponibile|subtotal|iva|vat|totale|grand total|complessivo|amount due|total due|mwst|tva)\b/i;

function isSubtotalLabelFast(text: string): boolean {
  return RE_SUBTOTAL_LABEL.test(normalizeDocumentText(text));
}

function isTaxableLabelFast(text: string): boolean {
  const normalized = normalizeDocumentText(text);
  if (/\b(?:spese?|trasporto|shipping|freight|porto|transport|contributo\s+logistico)\b/i.test(normalized)) {
    return false;
  }
  return RE_TAXABLE_LABEL.test(normalized);
}

/** Table column headers are not document totals/taxable section labels. */
function isDocumentSectionAmountLabel(text: string): boolean {
  if (detectDocumentTableColumnFast(text)) return false;
  return isSubtotalLabelFast(text) || isTaxableLabelFast(text) || isTotalLabelFast(text);
}

function isVatAmountLabelFast(text: string): boolean {
  const normalized = normalizeDocumentText(text).replace(/\s+/g, ' ').trim();
  // Bare IVA/VAT/TVA is a table column, not a document VAT-amount label.
  if (/^(?:iva|vat|tva)(?:\s*\/\s*(?:iva|vat|tva))?$/i.test(normalized)) return false;
  if (isVatExcludedLanguage(text) || isVatExcludedLanguage(normalized)) return false;
  return RE_VAT_AMOUNT_LABEL.test(normalized);
}

/** Compact rate labels like "VA 22%" / "IVA 22%" can still anchor nearby VAT money. */
function isVatRateAmountAnchor(text: string): boolean {
  const normalized = normalizeDocumentText(text).replace(/\s+/g, ' ').trim();
  return /^(?:iva|vat|tva|mwst|ust|va)\s*\d+(?:[.,]\d+)?\s*%$/i.test(normalized);
}

function isRowIndexHeaderText(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ').trim();
  // Leading table index columns (Riga / Line / #) must not bind as quantity.
  return /^(?:riga(?:\s*\/\s*line)?|line(?:\s*(?:#|no\.?|num(?:ber)?)?)?|#)$/i.test(compact);
}

function isTotalLabelFast(text: string): boolean {
  const normalized = normalizeDocumentText(text);
  if (/\b(?:total\s+ht|montant\s+ht|totale\s+imponibile|pu\s*ht)\b/i.test(normalized)) return false;
  return /\b(?:grand total|total due|totale documento|totale complessivo|totale da pagare|totale ordine|total ttc|net a payer|gesamtbetrag|amount due)\b/i.test(normalized)
    || looksLikeDocumentTotalLabel(normalized);
}

function looksLikeDocumentTotalLabel(normalized: string): boolean {
  if (
    /\b(?:imponibile|subtotal|sconto|discount|iva|vat|imposta|page|pagina|ht)\b/i.test(normalized)
    && !/\b(?:totale\s+(?:ordine|documento|fattura|preventivo|complessivo)|grand\s+total)\b/i.test(normalized)
  ) {
    return false;
  }
  return /\b(?:grand total|amount due|total due|totale\s+(?:ordine|complessivo|da pagare|documento|fattura|preventivo|offerta)|total ttc|gesamtbetrag|endbetrag|total\s+(?:factura|presupuesto|documento|ttc|due|general)|totale ordine)\b/i.test(normalized)
    || /\btotale\s+\S{0,4}(?:[do0]ocum|[o0]ocum)\S{0,10}\b/i.test(normalized)
    || /^(?:total|totale)\s*:?\s*$/i.test(normalized);
}

function isPageOrSectionSubtotalLabel(normalized: string): boolean {
  return /\b(?:sous[-\s]?total|subtotal\s+page|zwischensumme|totale\s+pagina)\b/i.test(normalized);
}

function isPrimaryGoodsSubtotalLabel(normalized: string): boolean {
  return /\b(?:imponibile\s+merc[ei]|goods\s+subtotal|sous[-\s]?total\s+marchandises|taxable\s+subtotal)\b/i.test(normalized);
}

function isStrongTaxableLabel(normalized: string): boolean {
  if (isPrimaryGoodsSubtotalLabel(normalized)) return true;
  if (/\b(?:page\s*\d|spese?|trasporto|shipping|freight)\b/i.test(normalized) && !/\bimponibile\b/i.test(normalized)) {
    return false;
  }
  return /\b(?:totale\s+imponibile|totale\s+[a-z]?pon\w*|total\s+ht|montant\s+ht|imponibile\s+netto|taxable\s+(?:amount|subtotal)|subtotal|base\s+imponib|zwischensumme|goods\s+subtotal)\b/i.test(normalized);
}

function isShippingOrFreightLabel(normalized: string): boolean {
  const compact = normalized.replace(/\s+/g, ' ').trim();
  if (!compact || compact.length > 56 || compact.split(/\s+/).length >= 8) return false;
  if (/\b(?:subtotal|totale\s+imponibile|total\s+ht|imponibile\s+merc|grand\s+total|totale\s+documento)\b/i.test(compact)) {
    return false;
  }
  if (/\b(?:per|pour|para|für|for)\s+(?:trasporto|transport|shipping|spedizione)\b/i.test(compact)) {
    return false;
  }
  return /^(?:spese?(?:\s+(?:di|e))?\s+(?:trasporto|imballo)(?:\s+e\s+imballo)?|spese\s+trasporto(?:\s+e\s+imballo)?|trasporto(?:\s+e\s+imballo)?|shipping|freight|handling|delivery(?:\s+charge)?|transport(?:kosten)?|porto(?:\s+franco)?|frais\s+de\s+(?:transport|port)|exp[eé]dition|transporte|portes|versand|fracht)(?:\s*\([A-Z]{3}\))?\s*:?\s*$/i.test(compact);
}

/** Goods-only subtotal: a shipping line appears before another document subtotal. */
function hasLaterDocumentSubtotalAfterShipping(
  lines: readonly DocumentLayoutLine[],
  startIndex: number,
): boolean {
  let sawShipping = false;
  for (let offset = 1; offset <= 10; offset += 1) {
    const candidate = lines[startIndex + offset];
    if (!candidate) break;
    const normalized = normalizeDocumentText(candidate.text).replace(/\s+/g, ' ').trim();
    if (isShippingOrFreightLabel(normalized)) {
      sawShipping = true;
      continue;
    }
    if (isHistoricalOrStatisticalRecapText(normalized) || isTaxRecapHeadingText(normalized)) continue;
    if (candidate.semanticRegion === 'tax_recap' || candidate.semanticRegion === 'historical_recap') continue;
    if (sawShipping && isStrongTaxableLabel(normalized) && !isPrimaryGoodsSubtotalLabel(normalized)) return true;
  }
  return false;
}

interface LineItemFeatures {
  line: DocumentLayoutLine;
  normalizedText: string;
  amount?: number;
  tableAmount?: number;
  centerX: number;
  centerY: number;
  adjustedY: number;
  summaryLikely: boolean;
}

interface PageItemsContext {
  page: StructuredDocumentPage;
  geometry: PageTableGeometry;
  lineFeatures: LineItemFeatures[];
  amountLines: DocumentLayoutLine[];
  numericBandLines: DocumentLayoutLine[];
  headerSearchMinY: number;
  headerSearchMaxY: number;
}

interface ItemsTotalsContext {
  pages: readonly StructuredDocumentPage[];
  pageContexts: Map<number, PageItemsContext>;
  allLines: DocumentLayoutLine[];
  deadline?: number;
  timedOut(): boolean;
  abortLaterPagesWhenTimedOut: boolean;
  abortAfterSupportedAnchors?: number;
}

const RE_PAYMENT_TERMS = /\b(?:pagamento|payment terms|condizioni di pagamento|conditions de paiement|condiciones de pago|zahlungsbedingungen|modalit[aà] di pagamento)\b/i;
const RE_DELIVERY_TERMS = /\b(?:consegna|delivery terms|porto|spedizione|lieferbedingungen|condizioni di consegna|conditions de livraison|condiciones de entrega)\b/i;
const RE_DELIVERY_DATE = /\b(?:data consegna|delivery date|datum lieferung|fecha de entrega|date de livraison)\b/i;

function isPaymentTermsLabel(text: string): boolean {
  return RE_PAYMENT_TERMS.test(normalizeDocumentText(text)) || matchesDocumentLabel(text, 'paymentTerms');
}

function isDeliveryTermsLabel(text: string): boolean {
  return RE_DELIVERY_TERMS.test(normalizeDocumentText(text)) || matchesDocumentLabel(text, 'deliveryTerms');
}

function isDeliveryDateLabel(text: string): boolean {
  return RE_DELIVERY_DATE.test(normalizeDocumentText(text));
}

type ColumnKind =
  | 'itemCode'
  | 'description'
  | 'quantity'
  | 'unit'
  | 'unitPrice'
  | 'discount'
  | 'vatRate'
  | 'lineTotal';

interface HeaderColumn {
  kind: ColumnKind;
  x: number;
  line: DocumentLayoutLine;
}

interface LayoutRow {
  pageIndex: number;
  y: number;
  lines: DocumentLayoutLine[];
}

interface ItemsTableZoneContext {
  lineIds: Set<string>;
  top: number;
  bottom: number;
  zoneCount: number;
  directMatched: number;
  expandedCells: number;
  unresolvedLineIds: number;
}

const COLUMN_PATTERNS: Array<[ColumnKind, RegExp]> = [
  ['itemCode', /^(?:codice(?:\s*\/\s*code)?(?: articolo)?|cod\.?|articolo|item(?:\s*code)?|sku|reference|r[eé]f(?:[ée]rence)?|art\.?-?\s*nr\.?|artikel|c[oó]digo)$/i],
  ['description', /^(?:descriz(?:i)?one(?:\s*\/\s*description)?(?: articolo)?|description|prodotto|servizio|d[eé]signation|bezeichnung|descripci[oó]n(?:\s+del\s+suministro)?|artikel|article|produkt)$/i],
  ['quantity', /^(?:q\.?ta(?:\s*\/\s*qty)?|qta|quant(?:it[aà])?|qty|quantity|qt[eé]|[oq0]t[eé]|cantidad|cant\.?|menge(?:\s+einheit)?|anzahl)$/i],
  ['unit', /^(?:um|u\.?m\.?|udm|unit[aà]|unit(?:\s+of\s+measure)?|einheit|unit[eé])$/i],
  ['unitPrice', /^(?:prezz[0o](?:\s+unit(?:\.|ario)?)?|p\.?\s*u(?:nitario)?\.?|unitario|unit\s+price|prezzo\s+unit\.?|rate|pu\s*ht(?:\s*\([^)]{0,8}\))?|prix\s+unitaire(?:\s*ht)?(?:\s*\([^)]{0,8}\))?|precio\s+unit(?:ario)?\.?|p\.?\s*unitario|einzelpreis|st[uü]ckpreis|preis)$/i],
  ['discount', /^(?:sconto|scanto|discount|disc\.?|sc\.?(?:\s*listino)?|sc\.?\s*%|remise|rem\.?|rabatt|descuento|desc\.?|dto\.?)(?:\s*%|\s+\(\s*%\s*\))?$/i],
  ['vatRate', /^(?:i?va|va|vat|aliq(?:uota)?\.?|aliquota|tva|mwst\.?|ust\.?|impuesto|tax)(?:\s*%|\s+rate|\s+\(\s*%\s*\))?$/i],
  ['lineTotal', /^(?:importo|importt|importe(?:\s+neto)?|import|totale(?:\s+riga)?(?:\s*\/\s*line\s+total)?|amount|line\s+total|montant(?:\s*ht|\s+net)?(?:\s*\([^)]{0,8}\))?|gesamt|betrag|nettobetrag|net\s+amount|prezzo\s+netto)$/i],
];

const UNIT_OF_MEASURE_TOKEN =
  /^(?:n\.?\s*r\.?|nr|pz|pcs|pc|cf|kg|ml|lt|hr|ore|mq|udm|h)$/i;

export function isUnitOfMeasureToken(text: string): boolean {
  return UNIT_OF_MEASURE_TOKEN.test(text.trim());
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

function fuzzyToken(word: string, expected: string, ratio = 0.4): boolean {
  if (Math.abs(word.length - expected.length) > 4) return false;
  return editDistance(word, expected) <= Math.max(1, Math.floor(expected.length * ratio));
}

function fuzzyPhrase(text: string, expected: string, ratio = 0.28): boolean {
  const compact = normalizeDocumentText(text).replace(/[^a-z0-9]/g, '');
  const target = expected.replace(/[^a-z0-9]/g, '');
  if (!compact || Math.abs(compact.length - target.length) > Math.max(4, Math.floor(target.length * ratio))) return false;
  return editDistance(compact, target) <= Math.max(2, Math.floor(target.length * ratio));
}

function fuzzyColumnKind(text: string): ColumnKind | undefined {
  if (text.length > 40) return undefined;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 1 && fuzzyToken(words[0], 'prezzo', 0.34)) return 'unitPrice';
  if (words.length === 1 && (
    fuzzyToken(words[0], 'quantita', 0.34) ||
    fuzzyToken(words[0], 'qta', 0.5) ||
    fuzzyToken(words[0], 'qte', 0.5)
  )) {
    return 'quantity';
  }
  if (words.length === 1 && (fuzzyToken(words[0], 'udm', 0.5) || fuzzyToken(words[0], 'um', 0.5))) {
    return 'unit';
  }
  if (words.length === 1 && (fuzzyToken(words[0], 'totale', 0.34) || fuzzyToken(words[0], 'importo', 0.34))) {
    return 'lineTotal';
  }
  if (isDiscountHeader(text)) return 'discount';
  if (isExplicitVatHeader(text) || isFuzzyVatHeader(text)) return 'vatRate';
  const description = words.some((word) =>
    fuzzyToken(word, 'descrizione') || fuzzyToken(word, 'description'));
  const item = words.some((word) => fuzzyToken(word, 'articolo') || fuzzyToken(word, 'item'));
  return description && item ? 'description' : undefined;
}

export function detectDocumentTableColumnFast(rawText: string): ColumnKind | undefined {
  // Bilingual stacks often OCR as "Codice /" or "Totale Riga /" — trailing slash is not semantic.
  const text = normalizeDocumentText(rawText)
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*$/g, '')
    .trim();
  if (text.length > 32) return undefined;
  if (/\b(?:p\.?\s*iva|partita\s+iva|vat(?:\s+(?:no|number|id))?|tva|ust\.?-?idnr|nif|cif)\b\s*[:\-]?\s*[A-Z0-9][A-Z0-9 .\-]{7,}/i.test(rawText)) {
    return undefined;
  }
  if (/\b(?:descripci[oó]n del suministro|description of supply|datos del cliente|datos de cliente)\b/i.test(text)) {
    return undefined;
  }
  if (isRowIndexHeaderText(text)) return undefined;
  const patternMatch = COLUMN_PATTERNS.find(([, pattern]) => pattern.test(text));
  return patternMatch?.[0];
}

function resolveColumnKindFast(text: string, allowDictionary = false): ColumnKind | undefined {
  if (!allowDictionary) {
    return detectDocumentTableColumnFast(text) ?? fuzzyColumnKind(text);
  }
  if (COLUMN_KIND_TEXT_CACHE.has(text)) return COLUMN_KIND_TEXT_CACHE.get(text);
  let kind = detectDocumentTableColumnFast(text) ?? fuzzyColumnKind(text);
  if (!kind && text.trim().length <= 28) {
    kind = detectDocumentTableColumn(text);
  }
  COLUMN_KIND_TEXT_CACHE.set(text, kind);
  return kind;
}

type ColumnKindResolver = (text: string) => ColumnKind | undefined;

function createColumnKindResolver(options?: { allowDictionary?: boolean }): ColumnKindResolver {
  const allowDictionary = options?.allowDictionary ?? true;
  const cache = new Map<string, ColumnKind | undefined>();
  return (text: string) => {
    if (cache.has(text)) return cache.get(text);
    const kind = resolveColumnKindFast(text, allowDictionary);
    cache.set(text, kind);
    return kind;
  };
}

function buildPageItemsContext(page: StructuredDocumentPage, deadline?: number): PageItemsContext {
  const expandStarted = Date.now();
  const expanded: StructuredDocumentPage = {
    ...page,
    lines: expandCombinedNumericCells(page.lines),
  };
  logItemsCallPerf('expandCells', { pageIndex: page.pageIndex, lines: expanded.lines.length, ms: Date.now() - expandStarted });

  const geometryStarted = Date.now();
  const columnKindFast = createColumnKindResolver({ allowDictionary: false });
  const amountLines = expanded.lines.filter((line) =>
    line.boundingBox && parseDocumentAmount(line.text) !== undefined);
  const skewSlope = tableSkewSlope(expanded, columnKindFast);
  const adjustedY = (line: DocumentLayoutLine) =>
    (line.boundingBox?.y ?? 0) - skewSlope * (line.boundingBox?.x ?? 0);
  const columnKind = createColumnKindResolver({ allowDictionary: true });
  const geometry: PageTableGeometry = { columnKind, amountLines, skewSlope, adjustedY };
  logItemsCallPerf('pageGeometry', { pageIndex: page.pageIndex, ms: Date.now() - geometryStarted });

  const featuresStarted = Date.now();
  let bottomProbe = 0;
  const featureLineCount = expanded.lines.length;
  const abortFeatureScan = !pageHasItemsTable(page);
  for (let index = 0; index < featureLineCount; index += 1) {
    if (abortFeatureScan && index % ITEMS_CHECK_EVERY === 0 && layoutDeadlineExceeded(deadline)) break;
    const line = expanded.lines[index];
    const kind = detectDocumentTableColumnFast(line.text);
    if (!kind || !line.boundingBox) continue;
    bottomProbe = Math.max(bottomProbe, adjustedY(line) + line.boundingBox.height);
  }
  const bandTop = bottomProbe > 0 ? bottomProbe : (page.height ?? 1400) * 0.35;
  const bandBottom = bandTop + (page.height ?? 1400) * 0.22;
  const numericBandLines = expanded.lines.filter((line) => line.boundingBox &&
    adjustedY(line) > bandTop && adjustedY(line) < bandBottom &&
    parseTableAmount(line.text) !== undefined);
  const lineFeatures: LineItemFeatures[] = [];
  for (let index = 0; index < featureLineCount; index += 1) {
    if (abortFeatureScan && index % ITEMS_CHECK_EVERY === 0 && layoutDeadlineExceeded(deadline)) break;
    const line = expanded.lines[index];
    const box = line.boundingBox;
    const normalizedText = normalizeDocumentText(line.text);
    lineFeatures.push({
      line,
      normalizedText,
      amount: parseDocumentAmount(line.text),
      tableAmount: parseTableAmount(line.text),
      centerX: box ? box.x + box.width / 2 : line.readingOrder,
      centerY: box ? box.y + box.height / 2 : line.readingOrder,
      adjustedY: adjustedY(line),
      summaryLikely: RE_MONETARY_SUMMARY.test(normalizedText),
    });
  }
  logItemsCallPerf('lineFeatures', { pageIndex: page.pageIndex, count: lineFeatures.length, ms: Date.now() - featuresStarted });
  const headerRegion = computeHeaderSearchRegion(expanded, lineFeatures, columnKind);
  return {
    page: expanded,
    geometry,
    lineFeatures,
    amountLines,
    numericBandLines,
    headerSearchMinY: headerRegion.headerMinY,
    headerSearchMaxY: headerRegion.headerMaxY,
  };
}

function pageHasItemsTable(page: StructuredDocumentPage): boolean {
  return page.zones.some((zone) => zone.classification === 'items_table');
}

function buildItemsTotalsContext(
  pages: readonly StructuredDocumentPage[],
  options?: ExtractItemsTotalsOptions,
): ItemsTotalsContext {
  logItemsCallPerf('buildContext_begin', { pages: pages.length });
  const pageContexts = new Map<number, PageItemsContext>();
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    // Shared deadline may expire while preparing early pages. Still prepare later
    // pages that expose an items_table so multipage continuation can run.
    if (
      layoutDeadlineExceeded(options?.deadline) &&
      !pageHasItemsTable(page)
    ) {
      continue;
    }
    const pageStarted = Date.now();
    // Keep every page inside the single extraction budget. Giving each
    // items_table page an unlimited preparation pass can multiply the wall-clock
    // time on long/multipage documents even after the caller deadline expired.
    const prepareDeadline = options?.deadline;
    pageContexts.set(page.pageIndex, buildPageItemsContext(page, prepareDeadline));
    logItemsCallPerf('preparePage', { pageIndex: page.pageIndex, ms: Date.now() - pageStarted });
  }
  logItemsCallPerf('buildContext_done', { pages: pageContexts.size });
  return {
    pages,
    pageContexts,
    allLines: pages.flatMap((page) => page.lines),
    deadline: options?.deadline,
    timedOut: () => layoutDeadlineExceeded(options?.deadline),
    abortLaterPagesWhenTimedOut: options?.abortLaterPagesWhenTimedOut === true,
    abortAfterSupportedAnchors: options?.abortAfterSupportedAnchors,
  };
}

interface PageTableGeometry {
  columnKind: ColumnKindResolver;
  amountLines: DocumentLayoutLine[];
  skewSlope: number;
  adjustedY: (line: DocumentLayoutLine) => number;
}

function collectHeaderKindRows(
  lineFeatures: readonly LineItemFeatures[],
  pageHeight: number,
  resolveKind: ColumnKindResolver = detectDocumentTableColumnFast,
): Array<{ y: number; kinds: Set<ColumnKind>; count: number }> {
  const rowTolerance = Math.max(35, pageHeight * 0.025);
  const headerRows: Array<{ y: number; kinds: Set<ColumnKind>; count: number }> = [];
  for (const feature of lineFeatures) {
    const kind = resolveKind(feature.line.text);
    if (!kind || !feature.line.boundingBox) continue;
    const y = feature.adjustedY;
    const existing = headerRows.find((row) => Math.abs(row.y - y) <= rowTolerance);
    if (existing) {
      existing.kinds.add(kind);
      existing.count += 1;
      existing.y = (existing.y * (existing.count - 1) + y) / existing.count;
    } else headerRows.push({ y, kinds: new Set([kind]), count: 1 });
  }
  return headerRows;
}

function pickStrongHeaderRow(
  headerRows: readonly { y: number; kinds: Set<ColumnKind>; count: number }[],
): { y: number; kinds: Set<ColumnKind>; count: number } | undefined {
  return [...headerRows]
    .filter((row) => row.kinds.size >= 3)
    .sort((left, right) => right.kinds.size - left.kinds.size || right.count - left.count)[0];
}

function computeHeaderSearchRegion(
  page: StructuredDocumentPage,
  lineFeatures: readonly LineItemFeatures[],
  resolveKind: ColumnKindResolver = detectDocumentTableColumnFast,
): { headerMinY: number; headerMaxY: number } {
  const pageHeight = page.height ?? 1400;
  const headerRows = collectHeaderKindRows(lineFeatures, pageHeight, resolveKind);
  // Prefer the strongest multi-column header band anywhere on the page.
  // Upside-down captures place headers at the geometric bottom; zone-top-only
  // search misses them when the first items_table zone is a false top band.
  const strongHeader = pickStrongHeaderRow(headerRows);
  if (strongHeader) {
    return {
      headerMinY: strongHeader.y - pageHeight * 0.04,
      headerMaxY: strongHeader.y + Math.max(55, pageHeight * 0.045),
    };
  }

  const tableZone = page.zones.find((zone) => zone.classification === 'items_table' && zone.boundingBox);
  if (tableZone?.boundingBox) {
    return {
      headerMinY: tableZone.boundingBox.y - pageHeight * 0.05,
      headerMaxY: tableZone.boundingBox.y + Math.max(55, pageHeight * 0.045),
    };
  }

  const amountYs = lineFeatures
    .filter((feature) => feature.tableAmount !== undefined && feature.line.boundingBox)
    .map((feature) => feature.adjustedY);
  if (amountYs.length >= 4) {
    const bodyBottom = Math.max(...amountYs);
    const headerBelowBody = headerRows
      .filter((row) => row.y > bodyBottom + 8 && row.kinds.size >= 3)
      .sort((left, right) => right.kinds.size - left.kinds.size || right.count - left.count)[0];
    if (headerBelowBody) {
      return {
        headerMinY: headerBelowBody.y - pageHeight * 0.04,
        headerMaxY: headerBelowBody.y + Math.max(55, pageHeight * 0.045),
      };
    }
  }
  const tableBodyTop = amountYs.length > 0 ? Math.min(...amountYs) : pageHeight * 0.35;
  return {
    headerMinY: tableBodyTop - pageHeight * 0.10,
    headerMaxY: tableBodyTop + Math.max(40, pageHeight * 0.03),
  };
}

function buildPageTableGeometry(page: StructuredDocumentPage): PageTableGeometry {
  const columnKindFast = createColumnKindResolver({ allowDictionary: false });
  const columnKind = createColumnKindResolver({ allowDictionary: true });
  const amountLines = page.lines.filter((line) =>
    line.boundingBox && parseDocumentAmount(line.text) !== undefined);
  const skewSlope = tableSkewSlope(page, columnKindFast);
  const adjustedY = (line: DocumentLayoutLine) =>
    (line.boundingBox?.y ?? 0) - skewSlope * (line.boundingBox?.x ?? 0);
  return { columnKind, amountLines, skewSlope, adjustedY };
}

const DETECT_COLUMN_CACHE = new Map<string, ColumnKind | undefined>();

export function detectDocumentTableColumn(rawText: string): ColumnKind | undefined {
  countDocumentProcessPerf('detectDocumentTableColumn');
  if (DETECT_COLUMN_CACHE.has(rawText)) return DETECT_COLUMN_CACHE.get(rawText);
  const text = normalizeDocumentText(rawText).replace(/\s+/g, ' ');
  if (/\b(?:descripci[oó]n del suministro|description of supply|datos del cliente|datos de cliente)\b/i.test(text)) {
    return undefined;
  }
  if (isRowIndexHeaderText(text.replace(/\s*\/\s*$/g, '').trim())) return undefined;
  if (/\b(?:p\.?\s*iva|partita\s+iva|vat(?:\s+(?:no|number|id))?|tva|ust\.?-?idnr|nif|cif)\b\s*[:\-]?\s*[A-Z0-9][A-Z0-9 .\-]{7,}/i.test(rawText)) {
    return undefined;
  }
  if (/\bmenge\b/i.test(text) && /\beinheit\b/i.test(text)) return 'quantity';
  if (/\bprecio\b/i.test(text) && /\bdescuento\b/i.test(text)) return 'unitPrice';
  if (/\bdescrizione\b/i.test(text) && /\bdescription\b/i.test(text)) return 'description';
  if (/\bcodice\b/i.test(text) && /\bcode\b/i.test(text)) return 'itemCode';
  if (/\bqta\b/i.test(text) && /\bqty\b/i.test(text)) return 'quantity';
  if (/\btotale\s+riga\b/i.test(text) && /\bline\s+total\b/i.test(text)) return 'lineTotal';
  const patternMatch = COLUMN_PATTERNS.find(([, pattern]) => pattern.test(text));
  if (patternMatch && text.length <= 28) return patternMatch[0];
  const concepts: Array<[DocumentLabelConcept, ColumnKind]> = [
    ['itemCode', 'itemCode'], ['description', 'description'], ['quantity', 'quantity'], ['unit', 'unit'],
    ['unitPrice', 'unitPrice'], ['discount', 'discount'], ['vatRate', 'vatRate'], ['lineTotal', 'lineTotal'],
  ];
  const dictionaryMatch = concepts.flatMap(([concept, kind]) => {
    const label = findDocumentLabel(rawText, [concept]);
    return label ? [{ kind, specificity: normalizeDocumentLabel(label.value).length }] : [];
  }).sort((left, right) => right.specificity - left.specificity)[0]?.kind;
  const tableSpecificity = concepts.flatMap(([concept]) => {
    const label = findDocumentLabel(rawText, [concept]);
    return label ? [normalizeDocumentLabel(label.value).length] : [];
  }).sort((left, right) => right - left)[0] ?? 0;
  const sectionSpecificity = (['subtotal', 'taxableAmount', 'vatAmount', 'total', 'paymentTerms', 'deliveryDate', 'deliveryTerms'] as const)
    .flatMap((concept) => {
      const label = findDocumentLabel(rawText, [concept]);
      return label ? [normalizeDocumentLabel(label.value).length] : [];
    }).sort((left, right) => right - left)[0] ?? 0;
  const resolved = sectionSpecificity > tableSpecificity ? undefined : dictionaryMatch
    ?? COLUMN_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0]
    ?? fuzzyColumnKind(text);
  DETECT_COLUMN_CACHE.set(rawText, resolved);
  return resolved;
}

function tableSkewSlope(page: StructuredDocumentPage, columnKind: ColumnKindResolver): number {
  const candidates = page.lines.flatMap((line) => {
    const kind = columnKind(line.text);
    if (!line.boundingBox || !kind || line.boundingBox.y >= (page.height ?? Number.POSITIVE_INFINITY) * 0.75) {
      return [];
    }
    return [{ x: line.boundingBox.x, y: line.boundingBox.y, kind }];
  });
  const groups: typeof candidates[] = [];
  const groupTolerance = Math.max(28, (page.height ?? 1400) * 0.018);
  for (const candidate of candidates.sort((left, right) => left.y - right.y)) {
    const group = groups.find((entries) => Math.abs(entries[0].y - candidate.y) <= groupTolerance);
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const points = groups.sort((left, right) => {
    const leftKinds = new Set(left.map((point) => point.kind)).size;
    const rightKinds = new Set(right.map((point) => point.kind)).size;
    return rightKinds - leftKinds || right.length - left.length;
  })[0] ?? [];
  if (points.length < 3) return 0;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const numerator = points.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0,
  );
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const slope = denominator > 0 ? numerator / denominator : 0;
  return Number.isFinite(slope) && Math.abs(slope) <= 0.15 ? slope : 0;
}

function unionElementBoxes(
  elements: readonly NonNullable<DocumentLayoutLine['elements']>[number][],
): DocumentLayoutLine['boundingBox'] | undefined {
  const boxes = elements.flatMap((element) => (element.boundingBox ? [element.boundingBox] : []));
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expandMixedVatCells(line: DocumentLayoutLine): DocumentLayoutLine[] {
  const elements = line.elements?.filter((element) => element.text.trim()) ?? [];
  if (elements.length < 2) return [line];
  const vatIndexes = elements.flatMap((element, index) => {
    const text = element.text.trim();
    const rate = parsePlausibleVatRate(text) ?? parseCorruptedVatToken(text);
    if (rate === undefined || rate < 19 || rate > 23) return [];
    if (!/%/.test(text) && !/[.,]/.test(text)) return [];
    return [index];
  });
  if (vatIndexes.length === 0 || vatIndexes.length === elements.length) return [line];
  const rest = elements.filter((_, index) => !vatIndexes.includes(index));
  const out: DocumentLayoutLine[] = [];
  const restText = rest.map((element) => element.text.trim()).join(' ').trim();
  if (restText) {
    out.push({
      ...line,
      id: `${line.id}-rest`,
      text: restText,
      boundingBox: unionElementBoxes(rest) ?? line.boundingBox,
      elements: rest,
    });
  }
  vatIndexes.forEach((index, splitIndex) => {
    const element = elements[index];
    out.push({
      ...line,
      id: `${line.id}-vat-${splitIndex}`,
      text: element.text,
      boundingBox: element.boundingBox ?? line.boundingBox,
      elements: [element],
      readingOrder: line.readingOrder + (splitIndex + 1) / 100,
    });
  });
  return out.length > 0 ? out : [line];
}

function expandCombinedNumericCells(
  lines: readonly DocumentLayoutLine[],
): DocumentLayoutLine[] {
  return lines.flatMap((line) => {
    const splitVat = expandMixedVatCells(line);
    if (splitVat.length !== 1 || splitVat[0] !== line) return splitVat;
    const elements = line.elements?.filter((element) => element.text.trim()) ?? [];
    if (elements.length < 2 || elements.some((element) =>
      !element.boundingBox
      || parseDocumentAmount(element.text) === undefined
      || /[A-Za-z]/.test(element.text))) {
      return [line];
    }
    if (/\d\s+\d{3}/.test(line.text) && parseDocumentAmount(line.text) !== undefined) {
      return [line];
    }
    return elements.map((element, index) => ({
      ...line,
      id: `${line.id}-cell-${index}`,
      text: element.text,
      boundingBox: element.boundingBox,
      elements: [element],
      readingOrder: line.readingOrder + index / 100,
    }));
  });
}

function originalLineId(lineId: string): string {
  return lineId.replace(/-cell-\d+$/, '').replace(/-vat-\d+$/, '').replace(/-rest$/, '');
}

function zoneContainsLineId(zoneLineIds: ReadonlySet<string>, lineId: string): boolean {
  return zoneLineIds.has(lineId) || zoneLineIds.has(originalLineId(lineId));
}

export interface ItemsTotalsExtraction {
  items: StructuredLineItem[];
  summary: StructuredDocumentSummary;
  conditions: StructuredDocumentConditions;
  shipping?: StructuredShippingSection;
  reasons: string[];
  requiresReview: boolean;
}

export function parseDocumentAmount(rawValue: string): number | undefined {
  return parseInternationalAmount(rawValue).normalizedValue;
}

function parseUnitPriceCell(trimmed: string): number | undefined {
  const gluedVat = trimmed.match(/^(-?\d{1,4}(?:[.\s]\d{3})*,\d{2})\s*4\s*$/);
  if (gluedVat) return parseDocumentAmount(gluedVat[1]);
  const match = trimmed.match(/^(-?\d{1,6})([.,])(\d{3,4})[A-Za-z]?\s*(?:€|EUR|USD|GBP|CHF)?\s*$/i);
  if (!match) return undefined;
  const integer = match[1];
  const separator = match[2];
  const fraction = match[3];
  if (fraction.length === 4) return Number(`${integer}.${fraction}`);
  // Italian unit prices use a comma decimal with 3+ digits (216,977). A lone
  // `1.400` remains a thousands grouping and falls through to locale parse.
  if (separator === ',' && fraction.length === 3) return Number(`${integer}.${fraction}`);
  return undefined;
}

/** Strict amount parse for table body cells — rejects prose/product codes with embedded digits. */
function isExactZeroMoneyToken(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /%/.test(trimmed)) return false;
  if (!/^[OQ0](?:[.,]0{1,2})?$/i.test(trimmed) && trimmed !== '0') return false;
  return parseTableAmount(trimmed) === 0;
}

export function parseTableAmount(rawValue: string): number | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed || trimmed.length > 32) return undefined;
  const normalizedRaw = trimmed
    .replace(/^[OQ]([.,]\d+)/, '0$1')
    .replace(/^[OQ](?:[.,]0+)?$/, '0,00');
  if (/^\d+(?:[.,]\d+)?\s*%$/.test(normalizedRaw)) return parseDocumentAmount(normalizedRaw);
  if (/\d+\s*[x×]\s*\d+/i.test(normalizedRaw)) return undefined;
  const unitPrice = parseUnitPriceCell(normalizedRaw);
  if (unitPrice !== undefined && Number.isFinite(unitPrice)) return unitPrice;
  const letterCount = (normalizedRaw.match(/[A-Za-z\u00c0-\u024f]/g) ?? []).length;
  if (letterCount > 0 && !/^[€$£-]?\s*-?\d/.test(normalizedRaw) && !/[€$£]|(?:EUR|USD|GBP|CHF)\b/i.test(normalizedRaw)) {
    return undefined;
  }
  if (letterCount > 4 && !/[€$£]|(?:EUR|USD|GBP|CHF)\b/i.test(normalizedRaw)) return undefined;
  if (/^[A-Z]{2,}[-/][A-Z0-9-]+$/i.test(normalizedRaw.replace(/\s/g, ''))) return undefined;
  const monetaryTail = normalizedRaw.replace(/^[^\d€$£-]+/, '');
  const hasCurrencyHint = /[€$£]|(?:EUR|USD|GBP|CHF)\b|(?:\sE\s*$)/i.test(normalizedRaw);
  if (letterCount > 0 && monetaryTail === normalizedRaw && !hasCurrencyHint) {
    return undefined;
  }
  return parseDocumentAmount(normalizedRaw.replace(/\sE\s*$/i, ' €'));
}

export function tryEuropeanDotDecimalLineTotal(rawValue: string): number | undefined {
  const trimmed = rawValue.trim();
  const match = trimmed.match(/^(\d{1,6})\.(\d{3})$/);
  if (!match) return undefined;
  const value = Number(`${match[1]}.${match[2]!.slice(0, 2)}`);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function isAmbiguousThousandsDotLineTotal(
  rawValue: string,
  parsed: number,
  unitPrice?: number,
): boolean {
  const trimmed = rawValue.trim();
  if (/[€$£]|(?:EUR|USD|GBP|CHF)\b/i.test(trimmed)) return false;
  if (!/^\d+\.\d{3,}$/.test(trimmed.replace(/\s/g, ''))) return false;
  if (unitPrice === undefined || !(unitPrice > 0)) return false;
  if (!(parsed > unitPrice * 50)) return false;
  const european = tryEuropeanDotDecimalLineTotal(trimmed);
  if (european !== undefined && european <= unitPrice * 10) return true;
  return parsed / unitPrice >= 100;
}

export function resolveLineTotalColumnValue(
  rawValue: string,
  unitPrice?: number,
  quantity?: number,
): number | undefined {
  const parsed = parseTableAmount(rawValue);
  if (parsed === undefined) return undefined;
  if (!isAmbiguousThousandsDotLineTotal(rawValue, parsed, unitPrice)) return parsed;
  const european = tryEuropeanDotDecimalLineTotal(rawValue);
  if (european !== undefined && unitPrice !== undefined) {
    if (
      quantity !== undefined
      && Math.abs(quantity * unitPrice - european) <= Math.max(0.05, Math.abs(european) * 0.02)
    ) {
      return european;
    }
    if (
      quantity === undefined
      && european <= unitPrice * 5
      && european >= unitPrice * 0.001
    ) {
      return european;
    }
  }
  return undefined;
}

function amountEvidence(
  raw: string,
  lines: readonly DocumentLayoutLine[],
  reason: string,
): DocumentEvidence<number> | undefined {
  const fiscal = classifyFiscalIdentifierAmount(raw, lines.map((line) => line.text).join(' '));
  if (fiscal.fiscal) {
    logVatCandidateDebug({
      text: raw,
      fiscalId: true,
      identifierLike: true,
      monetary: false,
      summaryContext: true,
      accepted: false,
      rejectReason: fiscal.reason,
    });
    return undefined;
  }
  const value = parseDocumentAmount(raw);
  if (value === undefined) return undefined;
  const locale = parseInternationalAmount(raw);
  return documentEvidence({
    rawValue: raw,
    normalizedValue: value,
    lines,
    validationStatus: locale.ambiguous ? 'ambiguous' : 'valid',
    reasons: [reason, 'locale_aware_amount', ...locale.localeEvidence],
    requiresReview: locale.ambiguous,
  });
}

function percentEvidence(raw: string, lines: readonly DocumentLayoutLine[], reason: string): DocumentEvidence<number> | undefined {
  if (reason === 'table_vat_rate_column') {
    const fromLines = lines
      .map((line) => parsePlausibleVatRate(line.text) ?? parseCorruptedVatToken(line.text))
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => Number(right >= 19) - Number(left >= 19) || right - left);
    if (fromLines[0] !== undefined) {
      return documentEvidence({
        rawValue: raw,
        normalizedValue: fromLines[0],
        lines,
        validationStatus: 'valid',
        reasons: [reason, 'standard_vat_rate_in_vat_column'],
        requiresReview: false,
      });
    }
  }
  if (reason === 'table_discount_column') {
    const fromLines = lines
      .map((line) => parseDiscountPercent(line.text))
      .filter((value): value is number => value !== undefined);
    const parsed = fromLines[0] ?? parseDiscountPercent(raw);
    if (parsed !== undefined) {
      return documentEvidence({
        rawValue: raw,
        normalizedValue: parsed,
        lines,
        validationStatus: 'valid',
        reasons: [reason, 'percent_in_discount_column'],
        requiresReview: false,
      });
    }
    return undefined;
  }
  const match = raw.match(/(-?\d+(?:[.,]\d+)?)\s*%/);
  const contextual = reason === 'table_vat_rate_column'
    ? raw.trim().toUpperCase().replace(/^[IIL]/, '1').replace(/[^0-9.,]/g, '')
    : '';
  const contextualValue = contextual ? Number(contextual.replace(',', '.')) : undefined;
  const repairedValue = contextualValue === 122 ? 22 : contextualValue;
  const value = match ? Number(match[1].replace(',', '.')) : repairedValue;
  if (value === undefined || !Number.isFinite(value) || value < 0 || value > 100) return undefined;
  if (!match && ![0, 4, 5, 10, 19, 20, 21, 22, 23].includes(value)) return undefined;
  const repaired = !match && contextualValue === 122;
  return documentEvidence({
    rawValue: match?.[0] ?? raw,
    normalizedValue: value,
    lines,
    validationStatus: repaired ? 'unverified' : 'valid',
    reasons: [reason, ...(repaired ? ['ocr_leading_one_removed_from_standard_vat_rate'] : ['standard_vat_rate_in_vat_column'])],
    requiresReview: repaired,
  });
}

function rowsForPage(page: StructuredDocumentPage, geometry?: PageTableGeometry): LayoutRow[] {
  const geo = geometry ?? buildPageTableGeometry(page);
  const geometric = page.lines.filter((line) => line.boundingBox);
  if (geometric.length === 0) {
    return page.lines.map((line) => ({ pageIndex: page.pageIndex, y: line.readingOrder, lines: [line] }));
  }
  const { skewSlope } = geo;
  const sorted = geometric.slice().sort((a, b) => {
    const leftY = (a.boundingBox?.y ?? 0) - skewSlope * (a.boundingBox?.x ?? 0);
    const rightY = (b.boundingBox?.y ?? 0) - skewSlope * (b.boundingBox?.x ?? 0);
    return leftY - rightY;
  });
  const rows: LayoutRow[] = [];
  for (const line of sorted) {
    const y = (line.boundingBox?.y ?? 0) - skewSlope * (line.boundingBox?.x ?? 0);
    const tolerance = Math.max(18, (page.height ?? 1400) * 0.008, (line.boundingBox?.height ?? 12) * 0.75);
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - y) <= tolerance) {
      last.lines.push(line);
      last.y = (last.y * (last.lines.length - 1) + y) / last.lines.length;
    } else if (
      looksLikeIsolatedOcrNoiseToken(line.text)
      && parseTableAmount(line.text) === undefined
      && last
    ) {
      last.lines.push(line);
    } else {
      rows.push({ pageIndex: page.pageIndex, y, lines: [line] });
    }
  }
  for (const row of rows) row.lines.sort((a, b) => (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0));
  return rows;
}

function headerColumns(row: LayoutRow, columnKind: ColumnKindResolver): HeaderColumn[] {
  return row.lines.flatMap((line) =>
    segmentHeaderLine(line, columnKind).map((segment) => ({
      kind: segment.kind,
      x: segment.x,
      line: segment.line,
    })));
}

function headerGroupIsValid(entries: readonly HeaderColumn[]): boolean {
  const kinds = new Set(entries.map((entry) => entry.kind));
  return kinds.has('description') && kinds.has('lineTotal') &&
    (kinds.has('quantity') || kinds.has('unitPrice'));
}

function clusterNumericLinesByX(
  numericLines: readonly DocumentLayoutLine[],
  width: number,
): Array<{ x: number; lines: DocumentLayoutLine[] }> {
  const clusters: Array<{ x: number; lines: DocumentLayoutLine[] }> = [];
  const clusterTolerance = Math.max(35, width * 0.018);
  const sorted = numericLines.length > 1
    ? numericLines.slice().sort((left, right) => left.boundingBox!.x - right.boundingBox!.x)
    : [...numericLines];
  for (const line of sorted) {
    const clusterX = line.boundingBox!.x;
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(last.x - clusterX) <= clusterTolerance) {
      last.lines.push(line);
      last.x = last.lines.reduce((sum, entry) => sum + entry.boundingBox!.x, 0) / last.lines.length;
    } else clusters.push({ x: clusterX, lines: [line] });
  }
  return clusters;
}

function clusterLooksLikeUniformRateColumn(cluster: { lines: readonly DocumentLayoutLine[] }): boolean {
  const values = cluster.lines
    .map((line) => parseTableAmount(line.text))
    .filter((value): value is number => value !== undefined);
  return values.length >= 2 && new Set(values).size === 1 && values[0] <= 100;
}

function pickInferredLineTotalCluster(
  populated: Array<{ x: number; lines: DocumentLayoutLine[] }>,
  options: {
    bodyAboveHeaders: boolean;
    unitPriceX: number;
    clusterTolerance: number;
    rightSide: Array<{ x: number; lines: DocumentLayoutLine[] }>;
    vatCluster?: { x: number; lines: DocumentLayoutLine[] };
  },
): { x: number; lines: DocumentLayoutLine[] } | undefined {
  if (options.bodyAboveHeaders) {
    return pickBodyAboveLineTotalCluster(populated);
  }
  return [...options.rightSide]
    .filter((cluster) => cluster !== options.vatCluster)
    .sort((left, right) => right.x - left.x)[0];
}

function pickBodyAboveLineTotalCluster(
  populated: Array<{ x: number; lines: DocumentLayoutLine[] }>,
): { x: number; lines: DocumentLayoutLine[] } | undefined {
  const candidates = populated.filter((cluster) => {
    if (cluster.lines.length < 2) return false;
    if (clusterLooksLikeUniformRateColumn(cluster)) return false;
    const values = cluster.lines
      .map((line) => parseTableAmount(line.text))
      .filter((value): value is number => value !== undefined);
    if (values.length < 2) return false;
    return values.some((value) => value >= 0 && /[.,]\d{2}/.test(String(value)));
  });
  return [...candidates].sort((left, right) => {
    const leftMax = Math.max(...left.lines.map((line) => parseTableAmount(line.text) ?? 0));
    const rightMax = Math.max(...right.lines.map((line) => parseTableAmount(line.text) ?? 0));
    return rightMax - leftMax || left.x - right.x;
  })[0];
}

function alignBodyAboveHeaderColumns(
  columns: HeaderColumn[],
  pageCtx: PageItemsContext,
  adjustedY: (line: DocumentLayoutLine) => number,
): HeaderColumn[] {
  const pageHeight = pageCtx.page.height ?? 1400;
  const pageWidth = pageCtx.page.width ?? 1400;
  const headerTop = Math.min(...columns.map((entry) => adjustedY(entry.line)));
  const numericAbove = pageCtx.amountLines.filter((line) => line.boundingBox &&
    adjustedY(line) < headerTop - 10 && adjustedY(line) > headerTop - pageHeight * 0.22);
  const aboveAmount = numericAbove.filter((line) => parseTableAmount(line.text) !== undefined);
  if (aboveAmount.length < 4) return columns;
  if (Math.max(...aboveAmount.map((line) => adjustedY(line))) >= headerTop) return columns;

  const populated = clusterNumericLinesByX(numericAbove, pageWidth)
    .filter((cluster) => cluster.lines.length >= 2);
  const totalCluster = pickBodyAboveLineTotalCluster(populated);
  if (!totalCluster) return columns;

  const template = columns.at(-1)?.line ?? numericAbove[0]!;
  const clusterTolerance = Math.max(35, pageWidth * 0.018);
  const qtyColumn = columns.find((column) => column.kind === 'quantity');
  const qtyX = qtyColumn?.x;
  const unitCluster = populated
    .filter((cluster) => cluster.x > totalCluster.x + clusterTolerance)
    .filter((cluster) => qtyX === undefined || cluster.x < qtyX - clusterTolerance)
    .filter((cluster) => !clusterLooksLikeUniformRateColumn(cluster))
    .sort((left, right) => left.x - right.x)[0];
  const vatCluster = populated.find((cluster) => clusterLooksLikeUniformRateColumn(cluster) &&
    cluster.lines.every((line) => {
      const value = parseDocumentAmount(line.text);
      return value !== undefined && value <= 100;
    }));

  const next: HeaderColumn[] = columns.filter((column) =>
    column.kind !== 'lineTotal' && column.kind !== 'unitPrice' && column.kind !== 'vatRate');
  next.push({
    kind: 'lineTotal',
    x: totalCluster.x,
    line: columnLineAtX(template, totalCluster.x),
  });
  if (unitCluster) {
    next.push({
      kind: 'unitPrice',
      x: unitCluster.x,
      line: columnLineAtX(template, unitCluster.x),
    });
  } else {
    const previousUnitPrice = columns.find((column) => column.kind === 'unitPrice');
    if (previousUnitPrice) next.push(previousUnitPrice);
  }
  if (vatCluster) {
    next.push({
      kind: 'vatRate',
      x: vatCluster.x,
      line: columnLineAtX(template, vatCluster.x),
    });
  }
  return next;
}

function normalizeHeaderGroup(
  entries: HeaderColumn[],
  options: {
    pageWidth: number;
    pageHeight: number;
    bandLines: readonly DocumentLayoutLine[];
    amountLines?: readonly DocumentLayoutLine[];
    adjustedY: (line: DocumentLayoutLine) => number;
    deadline?: number;
  },
): HeaderColumn[] {
  const { pageWidth, pageHeight, bandLines, adjustedY, deadline } = options;
  const amountSource = options.amountLines ?? bandLines;
  const headerTop = Math.min(...entries.map((entry) => adjustedY(entry.line)));
  const numericLinesBelow = (bottom: number) => amountSource.filter((line) => line.boundingBox &&
    adjustedY(line) > bottom && adjustedY(line) < bottom + pageHeight * 0.22);
  const numericLinesAbove = (top: number) => amountSource.filter((line) => line.boundingBox &&
    adjustedY(line) < top - 10 && adjustedY(line) > top - pageHeight * 0.22);
  const bottom = Math.max(...entries.map((entry) => (entry.line.boundingBox?.y ?? 0) + (entry.line.boundingBox?.height ?? 0)));
  const aboveAmountLines = numericLinesAbove(headerTop)
    .filter((line) => parseTableAmount(line.text) !== undefined);
  const bodyAboveHeaders = aboveAmountLines.length >= 4
    && Math.max(...aboveAmountLines.map((line) => adjustedY(line))) < headerTop - 8;
  const numericBodyLines = () => (bodyAboveHeaders ? numericLinesAbove(headerTop) : numericLinesBelow(bottom));
  const unitMarkers = entries.filter((entry) => entry.kind === 'unitPrice' && /^unitario$/i.test(normalizeDocumentText(entry.line.text)));
  let normalized = entries;
  if (unitMarkers.length > 0) {
    const unitMarker = unitMarkers[0];
    const amountHeader = [...entries]
      .filter((entry) => entry.kind === 'lineTotal' && entry.x <= unitMarker.x + 80)
      .sort((a, b) => Math.abs(a.x - unitMarker.x) - Math.abs(b.x - unitMarker.x))[0];
    normalized = entries
      .filter((entry) => entry !== amountHeader && entry !== unitMarker)
      .concat({ ...unitMarker, x: amountHeader?.x ?? unitMarker.x });
  }
  const kinds = new Set(normalized.map((entry) => entry.kind));
  const width = pageWidth || Math.max(...normalized.map((entry) => entry.x));
  const clusterTolerance = Math.max(35, width * 0.018);

  if (kinds.has('description') && kinds.has('quantity') && kinds.has('unitPrice') && !kinds.has('lineTotal')) {
    const populated = clusterNumericLinesByX(numericBodyLines(), width)
      .filter((cluster) => cluster.lines.length >= 2);
    const unitPriceX = Math.max(...normalized.filter((entry) => entry.kind === 'unitPrice').map((entry) => entry.x));
    const looksLikeLineTotalCluster = (cluster: { lines: readonly DocumentLayoutLine[] }) =>
      cluster.lines.some((line) => {
        const value = parseTableAmount(line.text);
        return value !== undefined && value >= 0 && /[.,]\d{2}/.test(line.text);
      });
    const leftSide = populated.filter((cluster) =>
      cluster.x < unitPriceX - clusterTolerance && looksLikeLineTotalCluster(cluster));
    const rightSide = populated.filter((cluster) => cluster.x > unitPriceX + clusterTolerance);
    const vatCluster = [...(bodyAboveHeaders ? populated : rightSide)].reverse().find((cluster) => cluster.lines.every((line) => {
      const value = parseDocumentAmount(line.text);
      return value !== undefined && (value <= 100 || value === 122);
    }));
    const totalCluster = pickInferredLineTotalCluster(populated, {
      bodyAboveHeaders,
      unitPriceX,
      clusterTolerance,
      rightSide,
      vatCluster,
    });
    if (vatCluster && !kinds.has('vatRate')) {
      normalized.push({ kind: 'vatRate', x: vatCluster.x, line: columnLineAtX(normalized.at(-1)!.line, vatCluster.x) });
    }
    if (totalCluster) {
      normalized.push({ kind: 'lineTotal', x: totalCluster.x, line: columnLineAtX(normalized.at(-1)!.line, totalCluster.x) });
    } else if (!bodyAboveHeaders) {
      normalized.push({ kind: 'lineTotal', x: width * 0.78, line: columnLineAtX(normalized.at(-1)!.line, width * 0.78) });
    }
  }
  if (layoutDeadlineExceeded(deadline)) return normalized;

  const kindsAfter = new Set(normalized.map((entry) => entry.kind));
  if (kindsAfter.has('description') && kindsAfter.has('lineTotal') && !kindsAfter.has('unitPrice')) {
    const unitPriceX = Math.max(...normalized.filter((entry) => ['quantity', 'discount', 'vatRate'].includes(entry.kind)).map((entry) => entry.x));
    const lineTotalX = Math.max(...normalized.filter((entry) => entry.kind === 'lineTotal').map((entry) => entry.x));
    const populated = clusterNumericLinesByX(numericBodyLines(), width)
      .filter((cluster) => cluster.lines.length >= 2);
    const leftSide = populated.filter((cluster) => cluster.x > unitPriceX + clusterTolerance && cluster.x < lineTotalX - clusterTolerance);
    const priceCluster = [...leftSide].sort((left, right) => right.x - left.x)[0];
    if (priceCluster) normalized.push({ kind: 'unitPrice', x: priceCluster.x, line: columnLineAtX(normalized.at(-1)!.line, priceCluster.x) });
  }
  if (layoutDeadlineExceeded(deadline)) return normalized;

  const kindsFinal = new Set(normalized.map((entry) => entry.kind));
  if (kindsFinal.has('description') && kindsFinal.has('lineTotal') && !kindsFinal.has('quantity')) {
    const populated = clusterNumericLinesByX(numericBodyLines(), width)
      .filter((cluster) => cluster.lines.length >= 2 && cluster.lines.every((entry) => {
        const value = parseTableAmount(entry.text);
        return value !== undefined && value <= 10000 && Number.isInteger(value);
      }));
    const unitPriceX = normalized.find((entry) => entry.kind === 'unitPrice')?.x ?? 0;
    const qtyCluster = populated.filter((cluster) => cluster.x > unitPriceX - clusterTolerance).sort((left, right) => left.x - right.x)[0];
    if (qtyCluster) normalized.push({ kind: 'quantity', x: qtyCluster.x, line: columnLineAtX(normalized.at(-1)!.line, qtyCluster.x) });
  }
  const kindsForVat = new Set(normalized.map((entry) => entry.kind));
  if (!kindsForVat.has('vatRate') && kindsForVat.has('description')) {
    const inferred = inferVatColumn({
      existingColumns: normalized,
      bodyLines: numericBodyLines().flatMap((line) => (
        line.boundingBox
          ? [{ text: line.text, x: line.boundingBox.x, centerX: line.boundingBox.x + (line.boundingBox.width ?? 0) / 2, y: line.boundingBox.y }]
          : []
      )),
      headerLines: [
        ...normalized.map((entry) => ({
          text: entry.line.text,
          x: entry.x,
          y: entry.line.boundingBox?.y,
        })),
        ...bandLines.flatMap((line) => (
          line.boundingBox && Math.abs((line.boundingBox.y ?? 0) - bottom) <= Math.max(40, pageHeight * 0.04)
            ? [{ text: line.text, x: line.boundingBox.x, y: line.boundingBox.y }]
            : []
        )),
      ],
      pageWidth: width,
    });
    if (inferred && shouldAssignInferredVat(inferred.confidence)) {
      const template = normalized.at(-1)!.line;
      normalized.push({
        kind: 'vatRate',
        x: inferred.x,
        line: {
          ...template,
          text: template.text,
          boundingBox: {
            x: inferred.x,
            y: template.boundingBox?.y ?? bottom,
            width: 48,
            height: template.boundingBox?.height ?? 20,
          },
        },
      });
    }
  }
  const kindsForDiscount = new Set(normalized.map((entry) => entry.kind));
  if (!kindsForDiscount.has('discount') && kindsForDiscount.has('description')) {
    const inferredDiscount = inferDiscountColumn({
      existingColumns: normalized,
      bodyLines: numericBodyLines().flatMap((line) => (
        line.boundingBox
          ? [{ text: line.text, x: line.boundingBox.x, centerX: line.boundingBox.x + (line.boundingBox.width ?? 0) / 2, y: line.boundingBox.y }]
          : []
      )),
      headerLines: [
        ...normalized.map((entry) => ({
          text: entry.line.text,
          x: entry.x,
          y: entry.line.boundingBox?.y,
        })),
        ...bandLines.flatMap((line) => (
          line.boundingBox && Math.abs((line.boundingBox.y ?? 0) - bottom) <= Math.max(40, pageHeight * 0.04)
            ? [{ text: line.text, x: line.boundingBox.x, y: line.boundingBox.y }]
            : []
        )),
      ],
      pageWidth: width,
    });
    if (inferredDiscount && shouldAssignInferredVat(inferredDiscount.confidence)) {
      const template = normalized.at(-1)!.line;
      normalized.push({
        kind: 'discount',
        x: inferredDiscount.x,
        line: {
          ...template,
          text: template.text,
          boundingBox: {
            x: inferredDiscount.x,
            y: template.boundingBox?.y ?? bottom,
            width: 48,
            height: template.boundingBox?.height ?? 20,
          },
        },
      });
    }
  }
  return normalized;
}

function buildHeaderCandidateGroups(
  lineFeatures: readonly LineItemFeatures[],
  headerSearchMinY: number,
  headerSearchMaxY: number,
  skewSlope: number,
  resolveKind: (text: string) => ColumnKind | undefined,
  pageHeight: number,
  deadline?: number,
): HeaderColumn[][] {
  const candidates: HeaderColumn[] = [];
  for (let index = 0; index < lineFeatures.length; index += 1) {
    if (index % ITEMS_CHECK_EVERY === 0 && layoutDeadlineExceeded(deadline)) break;
    const feature = lineFeatures[index];
    const line = feature.line;
    if (!line.boundingBox) continue;
    if (feature.adjustedY < headerSearchMinY || feature.adjustedY > headerSearchMaxY) continue;
    if (/\b(?:codice fiscale|cod\.?\s*fisc|partita iva|capitale sociale|cod\.?\s*sdi)\b/i.test(line.text)) continue;
    const segments = segmentHeaderLine(line, resolveKind);
    for (const segment of segments) {
      if (
        segment.kind === 'description' &&
        !detectDocumentTableColumnFast(segment.text) &&
        segment.text.trim().split(/\s+/).filter(Boolean).length >= 3
      ) {
        continue;
      }
      if (/\b(?:totale iva|total vat|vat summary|tva 20)\b/i.test(feature.normalizedText) && segment.kind === 'lineTotal') {
        continue;
      }
      candidates.push({ kind: segment.kind, x: segment.x, line: segment.line });
    }
  }
  const groups: HeaderColumn[][] = [];
  const groupTolerance = Math.max(35, pageHeight * 0.025);
  const headerAdjustedY = (entry: HeaderColumn) =>
    (entry.line.boundingBox?.y ?? 0) - skewSlope * entry.x;
  for (const candidate of candidates.slice().sort((a, b) => headerAdjustedY(a) - headerAdjustedY(b))) {
    const y = headerAdjustedY(candidate);
    const last = groups[groups.length - 1];
    if (last && Math.abs(headerAdjustedY(last[0]) - y) <= groupTolerance) last.push(candidate);
    else groups.push([candidate]);
  }
  const merged: HeaderColumn[][] = [];
  const bandTolerance = Math.max(groupTolerance * 2, 80);
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    const previousKinds = new Set(previous?.map((entry) => entry.kind) ?? []);
    const currentKinds = new Set(group.map((entry) => entry.kind));
    const previousY = previous ? headerAdjustedY(previous[0]) : Number.NEGATIVE_INFINITY;
    const currentY = headerAdjustedY(group[0]);
    const overlappingKind = [...currentKinds].some((kind) => previousKinds.has(kind));
    const descriptionAboveNumeric =
      previous
      && currentY - previousY <= bandTolerance
      && previousKinds.has('description')
      && !previousKinds.has('lineTotal')
      && !previousKinds.has('quantity')
      && !previousKinds.has('unitPrice')
      && (currentKinds.has('lineTotal') || currentKinds.has('quantity') || currentKinds.has('unitPrice'));
    const complementaryHeaderBand =
      previous
      && currentY - previousY <= bandTolerance
      && currentY - previousY >= 0
      && !overlappingKind
      && (previousKinds.has('description') || currentKinds.has('description'))
      && (
        previousKinds.has('lineTotal') || currentKinds.has('lineTotal')
        || previousKinds.has('quantity') || currentKinds.has('quantity')
        || previousKinds.has('unitPrice') || currentKinds.has('unitPrice')
      );
    if ((descriptionAboveNumeric || complementaryHeaderBand) && previous) previous.push(...group);
    else merged.push([...group]);
  }
  return merged;
}

function resolveHeaderFromGroups(
  groups: readonly HeaderColumn[][],
  options: {
    started: number;
    pageWidth: number;
    pageHeight: number;
    numericBandLines: readonly DocumentLayoutLine[];
    amountLines: readonly DocumentLayoutLine[];
    adjustedY: (line: DocumentLayoutLine) => number;
    deadline?: number;
  },
): { columns: HeaderColumn[]; bottom: number } | undefined {
  const normalizeOptions = {
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    bandLines: options.numericBandLines,
    amountLines: options.amountLines,
    adjustedY: options.adjustedY,
    deadline: options.deadline,
  };
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    if (groupIndex % 8 === 0 && layoutDeadlineExceeded(options.deadline)) break;
    logTableHeadersPerf(`group_${groupIndex}_begin`, { entries: groups[groupIndex].length });
    const groupStarted = Date.now();
    const normalized = normalizeHeaderGroup(groups[groupIndex], normalizeOptions);
    logTableHeadersPerf('normalize_group', { ms: Date.now() - groupStarted });
    const valid = headerGroupIsValid(normalized);
    logTableHeadersPerf(`group_${groupIndex}_done`, { valid, ms: Date.now() - groupStarted });
    if (valid) {
      const columns = normalized.slice();
      if (!columns.some((entry) => entry.kind === 'vatRate')) {
        const siblingVat = groups.flatMap((group) => group).find((entry) => entry.kind === 'vatRate');
        if (siblingVat) columns.push(siblingVat);
      }
      logTableHeadersPerf('validate_group', { valid: true, ms: 0 });
      logTableHeadersPerf('done', { found: true, ms: Date.now() - options.started });
      return {
        columns: columns.sort((a, b) => a.x - b.x),
        bottom: Math.max(...columns.map((entry) => (entry.line.boundingBox?.y ?? 0) + (entry.line.boundingBox?.height ?? 0))),
      };
    }
  }
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    if (groupIndex % 8 === 0 && layoutDeadlineExceeded(options.deadline)) break;
    const entries = groups[groupIndex];
    const kinds = new Set(entries.map((entry) => entry.kind));
    if (!(kinds.has('description') && kinds.has('quantity') && kinds.has('unitPrice') && !kinds.has('lineTotal'))) continue;
    const fallbackStarted = Date.now();
    const normalized = normalizeHeaderGroup(entries, normalizeOptions);
    logTableHeadersPerf('numeric_cluster', { ms: Date.now() - fallbackStarted });
    if (headerGroupIsValid(normalized)) {
      logTableHeadersPerf('done', { found: true, fallback: true, ms: Date.now() - options.started });
      return {
        columns: normalized.sort((a, b) => a.x - b.x),
        bottom: Math.max(...normalized.map((entry) => (entry.line.boundingBox?.y ?? 0) + (entry.line.boundingBox?.height ?? 0))),
      };
    }
  }
  return undefined;
}

function headerColumnsForPage(
  pageCtx: PageItemsContext,
  deadline?: number,
): { columns: HeaderColumn[]; bottom: number } | undefined {
  const started = Date.now();
  const { page, geometry, lineFeatures, numericBandLines, amountLines, headerSearchMinY, headerSearchMaxY } = pageCtx;
  const { columnKind, skewSlope, adjustedY } = geometry;
  const pageHeight = page.height ?? 1400;
  const pageWidth = page.width ?? 1400;
  logTableHeadersPerf('start', { pageIndex: page.pageIndex, lines: lineFeatures.length });

  logTableHeadersPerf('header_region', {
    headerMinY: headerSearchMinY,
    headerMaxY: headerSearchMaxY,
    ms: 0,
  });

  const resolveOptions = {
    started,
    pageWidth,
    pageHeight,
    numericBandLines,
    amountLines,
    adjustedY,
    deadline,
  };

  const fastStarted = Date.now();
  const fastGroups = buildHeaderCandidateGroups(
    lineFeatures,
    headerSearchMinY,
    headerSearchMaxY,
    skewSlope,
    detectDocumentTableColumnFast,
    pageHeight,
    deadline,
  );
  logTableHeadersPerf('detect_column_kinds', {
    count: fastGroups.reduce((sum, group) => sum + group.length, 0),
    groups: fastGroups.length,
    ms: Date.now() - fastStarted,
  });
  logTableHeadersPerf('candidate_groups', { count: fastGroups.length, ms: 0 });

  const fastResult = resolveHeaderFromGroups(fastGroups, resolveOptions);
  if (fastResult) return fastResult;
  if (layoutDeadlineExceeded(deadline)) {
    logTableHeadersPerf('done', { found: false, timedOut: true, ms: Date.now() - started });
    return undefined;
  }

  const dictStarted = Date.now();
  // The semantic fallback is recovery-only. Bound it independently of the
  // larger item deadline so an OCR variation cannot stall extraction.
  const dictionaryDeadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, dictStarted + 500);
  const dictGroups = buildHeaderCandidateGroups(
    lineFeatures,
    headerSearchMinY,
    headerSearchMaxY,
    skewSlope,
    columnKind,
    pageHeight,
    dictionaryDeadline,
  );
  logTableHeadersPerf('detect_column_kinds_dictionary', {
    count: dictGroups.reduce((sum, group) => sum + group.length, 0),
    groups: dictGroups.length,
    ms: Date.now() - dictStarted,
  });

  const dictResult = resolveHeaderFromGroups(dictGroups, {
    ...resolveOptions,
    deadline: dictionaryDeadline,
  });
  if (dictResult) return dictResult;

  logTableHeadersPerf('done', { found: false, ms: Date.now() - started });
  return undefined;
}

function flipLineHorizontally(line: DocumentLayoutLine, pageWidth: number): DocumentLayoutLine {
  if (!line.boundingBox) return line;
  const box = line.boundingBox;
  return {
    ...line,
    boundingBox: {
      ...box,
      x: pageWidth - box.x - box.width,
    },
  };
}

function flipHeaderColumnsHorizontally(
  columns: readonly HeaderColumn[],
  pageWidth: number,
): HeaderColumn[] {
  return columns
    .map((column) => {
      const line = flipLineHorizontally(column.line, pageWidth);
      return {
        ...column,
        line,
        x: line.boundingBox?.x ?? pageWidth - column.x,
      };
    })
    .sort((left, right) => left.x - right.x);
}

function columnLineAtX(line: DocumentLayoutLine, x: number): DocumentLayoutLine {
  const box = line.boundingBox;
  return {
    ...line,
    boundingBox: {
      x,
      y: box?.y ?? 0,
      width: Math.max(48, box?.width ?? 48),
      height: box?.height ?? 16,
    },
  };
}

function headerColumnCenter(column: HeaderColumn): number {
  const box = column.line.boundingBox;
  const boxCenter = box ? box.x + box.width / 2 : undefined;
  if (boxCenter !== undefined && Math.abs(boxCenter - column.x) <= Math.max(48, box?.width ?? 0)) {
    return boxCenter;
  }
  return column.x;
}

function nearestColumn(line: DocumentLayoutLine, columns: readonly HeaderColumn[]): ColumnKind | undefined {
  if (columns.length === 0) return undefined;
  const x = line.boundingBox?.x ?? line.readingOrder;
  let nearest: HeaderColumn | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const column of columns) {
    const nextDistance = Math.abs(column.x - x);
    if (nextDistance < distance) {
      nearest = column;
      distance = nextDistance;
    }
  }
  return nearest?.kind;
}

function columnX(columns: readonly HeaderColumn[], kind: ColumnKind): number | undefined {
  return columns.find((entry) => entry.kind === kind)?.x;
}

function lineCenterX(line: DocumentLayoutLine): number {
  return line.boundingBox
    ? line.boundingBox.x + line.boundingBox.width / 2
    : line.readingOrder;
}

function positionIndexColumnTolerance(pageWidth: number): number {
  return Math.max(40, pageWidth * 0.022);
}

/** Detect dedicated row-position/index column X from header label or body geometry. */
function detectPositionIndexColumnX(
  pageCtx: PageItemsContext,
  columns: readonly HeaderColumn[],
  body: readonly DocumentLayoutLine[],
  headerBottom: number,
): number | undefined {
  const pageWidth = pageCtx.page.width ?? 1400;
  for (const feature of pageCtx.lineFeatures) {
    if (feature.adjustedY > headerBottom + 12) continue;
    const folded = normalizeDocumentText(feature.line.text)
      .replace(/\s+/g, ' ')
      .replace(/\s*\/\s*$/g, '')
      .trim();
    if (isRowIndexHeaderText(folded) || isRowIndexHeaderText(feature.line.text.trim())) {
      return lineCenterX(feature.line);
    }
  }
  const codeX = columnX(columns, 'itemCode');
  const qtyX = columnX(columns, 'quantity');
  if (codeX === undefined) return undefined;
  const leftBound = qtyX !== undefined ? Math.min(codeX, qtyX) - 16 : codeX - 16;
  const indexLines = body.filter((line) => {
    const text = line.text.trim();
    if (!/^\d{1,2}$/.test(text)) return false;
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > 40) return false;
    return lineCenterX(line) < leftBound;
  });
  if (indexLines.length < 3) return undefined;
  const clusters = clusterNumericLinesByX(indexLines, pageWidth);
  const candidate = clusters
    .filter((cluster) => cluster.lines.length >= 3)
    .map((cluster) => {
      const values = [...new Set(cluster.lines.map((line) => Number(line.text.trim())))].sort((left, right) => left - right);
      let sequentialPairs = 0;
      for (let index = 1; index < values.length; index += 1) {
        if (values[index] === values[index - 1]! + 1) sequentialPairs += 1;
      }
      return { x: cluster.x, count: cluster.lines.length, sequentialPairs };
    })
    .filter((entry) => entry.sequentialPairs >= 2)
    .sort((left, right) => right.sequentialPairs - left.sequentialPairs || right.count - left.count)[0];
  return candidate?.x;
}

function isPositionIndexCell(
  line: DocumentLayoutLine,
  positionIndexX: number | undefined,
  pageWidth: number,
): boolean {
  if (positionIndexX === undefined) return false;
  const text = line.text.trim();
  if (!/^\d{1,2}$/.test(text)) return false;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 40) return false;
  return Math.abs(lineCenterX(line) - positionIndexX) <= positionIndexColumnTolerance(pageWidth);
}

type PositionIndexInterval = {
  anchor: DocumentLayoutLine;
  lo: number;
  hi: number;
};

/** Midpoint ownership intervals from sequential position/index anchors. */
function buildPositionIndexIntervals(
  positionIndexAnchors: readonly DocumentLayoutLine[],
): PositionIndexInterval[] {
  if (positionIndexAnchors.length === 0) return [];
  const sorted = [...positionIndexAnchors].sort(
    (left, right) => layoutLineRawY(left) - layoutLineRawY(right),
  );
  return sorted.map((anchor, index) => {
    const y = layoutLineRawY(anchor);
    const prevY = index > 0 ? layoutLineRawY(sorted[index - 1]!) : undefined;
    const nextY = index < sorted.length - 1 ? layoutLineRawY(sorted[index + 1]!) : undefined;
    const lo = prevY === undefined
      ? (nextY !== undefined ? y - (nextY - y) / 2 : Number.NEGATIVE_INFINITY)
      : (prevY + y) / 2;
    const hi = nextY === undefined
      ? (prevY !== undefined ? y + (y - prevY) / 2 : Number.POSITIVE_INFINITY)
      : (y + nextY) / 2;
    return { anchor, lo, hi };
  });
}

function positionIndexOwnerAtY(
  rawY: number,
  intervals: readonly PositionIndexInterval[],
): DocumentLayoutLine | undefined {
  for (const interval of intervals) {
    if (rawY >= interval.lo && rawY < interval.hi) return interval.anchor;
  }
  return undefined;
}

/** Position-index anchor that owns this commercial row band. */
function rowPositionIndexAnchor(
  rawLo: number,
  rawHi: number,
  positionIndexIntervals: readonly PositionIndexInterval[],
): DocumentLayoutLine | undefined {
  if (positionIndexIntervals.length === 0) return undefined;
  return positionIndexOwnerAtY((rawLo + rawHi) / 2, positionIndexIntervals);
}

/** Hard-reject a cell from this row band based on position-index ownership. */
function positionIndexBoundaryExcludesCell(
  lineRawY: number,
  rowIndexAnchor: DocumentLayoutLine | undefined,
  positionIndexIntervals: readonly PositionIndexInterval[],
  rawLo: number,
  rawHi: number,
): boolean {
  if (positionIndexIntervals.length === 0) return false;
  const inRowBand = lineRawY >= rawLo && lineRawY < rawHi;
  const lineOwner = positionIndexOwnerAtY(lineRawY, positionIndexIntervals);
  if (rowIndexAnchor) {
    if (lineOwner && lineOwner.id !== rowIndexAnchor.id && !inRowBand) return true;
    if (!lineOwner && !inRowBand) return true;
    return false;
  }
  if (lineOwner) {
    const ownerY = layoutLineRawY(lineOwner);
    return ownerY < rawLo || ownerY >= rawHi;
  }
  return false;
}

/** Cell belongs to this row via matching position-index ownership inside the raw band. */
function cellIndexOwnedHere(
  lineRawY: number,
  rowIndexAnchor: DocumentLayoutLine | undefined,
  positionIndexIntervals: readonly PositionIndexInterval[],
  rawLo: number,
  rawHi: number,
): boolean {
  if (!rowIndexAnchor || positionIndexIntervals.length === 0) return false;
  if (lineRawY < rawLo || lineRawY >= rawHi) return false;
  const lineOwner = positionIndexOwnerAtY(lineRawY, positionIndexIntervals);
  return !!lineOwner && lineOwner.id === rowIndexAnchor.id;
}

function assignLineToColumn(
  line: DocumentLayoutLine,
  columns: readonly HeaderColumn[],
  positionIndexX?: number,
  pageWidth = 1400,
): ColumnKind | undefined {
  const x = line.boundingBox
    ? line.boundingBox.x + line.boundingBox.width / 2
    : line.readingOrder;
  if (isUnitOfMeasureToken(line.text)) {
    if (columns.some((column) => column.kind === 'unit')) return 'unit';
    const qtyX = columnX(columns, 'quantity');
    const descX = columnX(columns, 'description');
    if (qtyX !== undefined && descX !== undefined && x >= descX && x <= qtyX) return 'unit';
    if (qtyX !== undefined && x < qtyX) return 'unit';
    return 'unit';
  }
  if (isPositionIndexCell(line, positionIndexX, pageWidth)) return undefined;
  const columnCenter = headerColumnCenter;
  const amount = parseTableAmount(line.text);
  const qtyX = columnX(columns, 'quantity');
  const priceX = columnX(columns, 'unitPrice');
  const totalX = columnX(columns, 'lineTotal');
  const descX = columnX(columns, 'description');
  const codeX = columnX(columns, 'itemCode');
  if (codeX !== undefined && /^(?=[A-Z0-9-]{3,20}$)[A-Z0-9]*-?[A-Z0-9-]*\d[A-Z0-9-]*$/i.test(line.text.trim()) && !amount) {
    return 'itemCode';
  }

  const vatRateToken = parsePlausibleVatRate(line.text);
  const corruptedVatToken = parseCorruptedVatToken(line.text);
  const discountToken = parseDiscountPercent(line.text);
  const vatColumn = columns.find((entry) => entry.kind === 'vatRate');
  const discountColumn = columns.find((entry) => entry.kind === 'discount');
  const vatCenter = vatColumn ? columnCenter(vatColumn) : undefined;
  const discountCenter = discountColumn ? columnCenter(discountColumn) : undefined;
  const distanceVat = vatCenter === undefined ? Number.POSITIVE_INFINITY : Math.abs(vatCenter - x);
  const distanceDiscount = discountCenter === undefined ? Number.POSITIVE_INFINITY : Math.abs(discountCenter - x);
  const inVatColumn = vatColumn !== undefined && distanceVat <= 90 && distanceVat <= distanceDiscount;
  const inDiscountColumn = discountColumn !== undefined && distanceDiscount <= 90 && distanceDiscount < distanceVat;

  if (!isExactZeroMoneyToken(line.text)) {
    if (inDiscountColumn && discountToken !== undefined) return 'discount';
    if (inVatColumn && (vatRateToken !== undefined || corruptedVatToken !== undefined)) return 'vatRate';

    const percent = /^\d+(?:[.,]\d+)?\s*%$/.test(line.text.trim()) || /%\s*$/.test(line.text.trim());
    if (percent || discountToken !== undefined) {
      if (inDiscountColumn) return 'discount';
      if (inVatColumn) return 'vatRate';
      const percentageColumns = columns.filter((entry) => entry.kind === 'discount' || entry.kind === 'vatRate');
      let nearest: HeaderColumn | undefined;
      let distance = Number.POSITIVE_INFINITY;
      for (const entry of percentageColumns) {
        const nextDistance = Math.abs(columnCenter(entry) - x);
        if (nextDistance < distance) {
          nearest = entry;
          distance = nextDistance;
        }
      }
      if (nearest && distance <= 110) return nearest.kind;
      if (totalX !== undefined && percent) {
        if (x + 15 < totalX && (vatCenter === undefined || x < vatCenter - 20)) return 'discount';
        if (vatCenter !== undefined && x >= vatCenter - 90) return 'vatRate';
      }
    }
    if (vatRateToken !== undefined && vatColumn && distanceVat <= 90 && distanceVat <= distanceDiscount) {
      return 'vatRate';
    }
  }
  if (amount !== undefined) {
    let nearest: HeaderColumn | undefined;
    let distance = Number.POSITIVE_INFINITY;
    const skipPercentColumns = isExactZeroMoneyToken(line.text);
    const inDescriptionZone = qtyX !== undefined && x < qtyX - 15;
    for (const entry of columns) {
      if (!['quantity', 'unitPrice', 'lineTotal', 'discount', 'vatRate'].includes(entry.kind)) continue;
      if (skipPercentColumns && (entry.kind === 'discount' || entry.kind === 'vatRate' || entry.kind === 'quantity')) continue;
      if (inDescriptionZone && entry.kind === 'quantity') continue;
      const nextDistance = Math.abs(columnCenter(entry) - x);
      if (nextDistance < distance) {
        nearest = entry;
        distance = nextDistance;
      }
    }
    if (nearest) {
      const vatShaped = vatRateToken !== undefined || corruptedVatToken !== undefined;
      const rightmostNumeric = [...columns]
        .filter((entry) => ['quantity', 'unitPrice', 'lineTotal', 'discount', 'vatRate'].includes(entry.kind))
        .sort((left, right) => headerColumnCenter(right) - headerColumnCenter(left))[0];
      if (
        rightmostNumeric
        && !vatShaped
        && /[.,]\d{2}/.test(line.text)
        && (rightmostNumeric.kind === 'lineTotal' || rightmostNumeric.kind === 'unitPrice')
        && x >= headerColumnCenter(rightmostNumeric) - 40
      ) {
        nearest = rightmostNumeric;
      }
      const rightOfTotal = totalX !== undefined && x > totalX + 15;
      if (
        vatShaped
        && (inVatColumn || rightOfTotal)
        && nearest.kind !== 'quantity'
        && nearest.kind !== 'unitPrice'
      ) {
        return 'vatRate';
      }
      if (
        nearest.kind === 'vatRate'
        && !vatShaped
        && !isExactZeroMoneyToken(line.text)
        && /[.,]\d{2}/.test(line.text)
        && !inDescriptionZone
      ) {
        let moneyColumn: HeaderColumn | undefined;
        let moneyDistance = Number.POSITIVE_INFINITY;
        for (const entry of columns) {
          if (!['unitPrice', 'lineTotal', 'discount'].includes(entry.kind)) continue;
          const nextDistance = Math.abs(headerColumnCenter(entry) - x);
          if (nextDistance < moneyDistance) {
            moneyColumn = entry;
            moneyDistance = nextDistance;
          }
        }
        if (moneyColumn) return moneyColumn.kind;
      }
      return nearest.kind;
    }
  }

  if (qtyX !== undefined && x < qtyX - 15) {
    if (codeX !== undefined && descX !== undefined && x < (codeX + descX) / 2) return 'itemCode';
    if (codeX !== undefined && descX === undefined && x <= codeX + 80) return 'itemCode';
    return 'description';
  }

  return nearestColumn(line, columns);
}

function isVatShapedToken(text: string): boolean {
  return (parsePlausibleVatRate(text) ?? parseCorruptedVatToken(text)) !== undefined;
}

function isCommercialMoneyNotVatToken(text: string): boolean {
  if (!text.trim() || /%/.test(text) || isExactZeroMoneyToken(text) || isVatShapedToken(text)) return false;
  const value = parseTableAmount(text);
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function isServiceChargeIdentity(text: string): boolean {
  const token = text.trim();
  if (!token) return false;
  if (/^(?:TRASPORTO|TRANSPORT|SHIPPING|FREIGHT|SHIP|FRT)$/i.test(token)) return true;
  return /^(?:spese\b|trasporto|transport|shipping|freight)\b/i.test(token);
}

function reclaimLineTotalsFromVatColumn(cells: Map<ColumnKind, DocumentLayoutLine[]>): string[] {
  const vatLines = cells.get('vatRate') ?? [];
  const hasUnitPrice = (cells.get('unitPrice') ?? []).length > 0;
  const stolen = vatLines.filter((line) => {
    if (isCommercialMoneyNotVatToken(line.text)) return true;
    if (!hasUnitPrice) return false;
    const value = parseTableAmount(line.text);
    if (value === undefined || !(value > 0) || !/[.,]\d{2}\b/.test(line.text.trim()) || /%/.test(line.text)) {
      return false;
    }
    const unitValues = (cells.get('unitPrice') ?? [])
      .map((entry) => parseTableAmount(entry.text))
      .filter((entry): entry is number => entry !== undefined);
    return unitValues.some((unit) => Math.abs(unit - value) <= 0.01);
  });
  if (stolen.length === 0) return [];
  cells.set('vatRate', vatLines.filter((line) => !stolen.includes(line)));
  const totals = cells.get('lineTotal') ?? [];
  for (const line of stolen) {
    if (!totals.includes(line)) totals.push(line);
  }
  cells.set('lineTotal', totals);
  return stolen.map((line) => line.text.trim());
}

function fieldBindingSource(
  evidence: DocumentEvidence<number> | undefined,
  fallback: string,
): string {
  const reasons = evidence?.reasons ?? [];
  if (reasons.some((reason) => /arithmetic_derived_missing_ocr/.test(reason))) return 'arithmetic_derived_missing_ocr';
  if (reasons.some((reason) => /arithmetic/.test(reason))) return 'arithmetic_derived';
  if (reasons.some((reason) => /column|table_/.test(reason))) return 'column_direct';
  if (reasons.some((reason) => /geometry/.test(reason))) return 'geometry_direct';
  if (evidence?.normalizedValue !== undefined) return fallback;
  return 'unknown';
}

function rawCell(cells: ReadonlyMap<ColumnKind, DocumentLayoutLine[]> , kind: ColumnKind): string {
  return (cells.get(kind) ?? []).map((line) => line.text.trim()).join(' ').trim();
}

function layoutLineY(line: DocumentLayoutLine): number {
  return line.boundingBox?.y ?? 0;
}

function coalesceFrenchNumericLines(lines: readonly DocumentLayoutLine[]): DocumentLayoutLine[] {
  const out: DocumentLayoutLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index].text.trim();
    const next = lines[index + 1];
    const nextText = next?.text.trim() ?? '';
    if (
      /^\d{1,3}$/.test(current) &&
      /^\d{3}[.,]\d{2}$/.test(nextText) &&
      next &&
      !/^(?:19|20|21|22|23)$/.test(current)
    ) {
      const startBox = lines[index].boundingBox;
      const lastBox = next.boundingBox;
      out.push({
        ...lines[index],
        id: `${lines[index].id}+${next.id}`,
        text: `${current} ${nextText}`,
        boundingBox: startBox && lastBox
          ? {
              x: Math.min(startBox.x, lastBox.x),
              y: Math.min(startBox.y, lastBox.y),
              width: Math.max(startBox.x + startBox.width, lastBox.x + lastBox.width) - Math.min(startBox.x, lastBox.x),
              height: Math.max(startBox.y + startBox.height, lastBox.y + lastBox.height) - Math.min(startBox.y, lastBox.y),
            }
          : startBox,
      });
      index += 1;
      continue;
    }
    out.push(lines[index]);
  }
  return out;
}

function tableAmountEvidence(
  raw: string,
  lines: readonly DocumentLayoutLine[],
  reason: string,
): DocumentEvidence<number> | undefined {
  if (looksLikeTechnicalMeasure(raw)) return undefined;
  const value = parseTableAmount(raw);
  if (value === undefined) return undefined;
  const locale = parseInternationalAmount(raw);
  return documentEvidence({
    rawValue: raw,
    normalizedValue: value,
    lines,
    validationStatus: locale.ambiguous ? 'ambiguous' : 'valid',
    reasons: [reason, 'locale_aware_amount', ...locale.localeEvidence],
    requiresReview: locale.ambiguous,
  });
}

function textEvidence(raw: string, lines: readonly DocumentLayoutLine[], reason: string): DocumentEvidence<string> | undefined {
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return documentEvidence({ rawValue: raw, normalizedValue: value, lines, validationStatus: 'unverified', reasons: [reason], requiresReview: true });
}

/** Footer / totals markers wrongly absorbed into items_table must not join the last commercial row. */
function isItemsTableFooterBoundary(text: string): boolean {
  const normalized = normalizeDocumentText(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (detectDocumentTableColumnFast(text)) return false;
  if (text.trim().length <= 28 && detectDocumentTableColumn(text)) return false;
  if (/\bnote\s*\/\s*remarks\b/i.test(normalized)) return true;
  if (/^(?:notes?|remarks?)(?:\s*\/\s*(?:notes?|remarks?))?$/i.test(normalized)) return true;
  if (/\briepilogo(?:\s+iva)?\b/i.test(normalized)) return true;
  if (/\b(?:vat|tax)\s+summary\b/i.test(normalized)) return true;
  if (isTableFooterHeading(normalized) || isLegalOrBankFooterText(normalized)) return true;
  if (isNotesOrTermsBoundary(text) && parseTableAmount(text) === undefined) return true;
  if (parseTableAmount(text) !== undefined) return false;
  if (isSubtotalLabelFast(text) || isTaxableLabelFast(text) || isTotalLabelFast(text)) return true;
  if (/^(?:materiale|manodopera|varie|lavorazioni\s+esterne)$/i.test(normalized)) return true;
  if (RE_SUMMARY_FOOTER.test(normalized)) return true;
  return false;
}

function isSummaryRow(row: LayoutRow): boolean {
  const joined = row.lines.map((line) => line.text).join(' ');
  const text = normalizeDocumentText(joined);
  const trimmed = text.trim();
  if (isCarryForwardText(trimmed) || isHistoricalOrStatisticalRecapText(trimmed) || isSummaryOrAggregateHeading(trimmed)) {
    return true;
  }
  if (/\b\d+\s+unidades\b/i.test(trimmed) && !/\b(?:codigo|c[oó]digo|descripci[oó]n)\b/i.test(trimmed)) {
    return true;
  }
  // Fiscal / totals band (multilingual). Keep shipping/transport commercial lines out of this list.
  if (
    /\b(?:imponibil\w*|subtotale|subtotal|totale\s+documento|totale\s+ordine|grand\s+total|amount\s+due|esente|non\s+imponibil\w*|riepilogo|vat\s+summary|base\s+imponible|gesamtbetrag|nettobetrag|total\s+ht|total\s+ttc|mwst\.?|tva\s*\d{1,2})/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  if (
    /\b(?:totale\s+iva|total\s+vat|totale\s+va\b|iva\s+calculado|total\s*:\s*|totale\s*:\s*)/i.test(trimmed) ||
    /^(?:iva|vat|tva|totale|total)\b/i.test(trimmed)
  ) {
    return true;
  }
  // Terms / bank / scope notes frequently OCR'd into the table body with bullet markers.
  if (/^[•·▪]\s*/.test(joined.trim())) return true;
  if (
    (isNotesOrTermsBoundary(joined) || isNotesOrTermsBoundary(trimmed))
    && parseTableAmount(joined) === undefined
  ) {
    return true;
  }
  if (
    /\b(?:datos\s+bancarios|iban\b|presupuesto\s+calculado|no\s+se\s+incluyen|tramitaci[oó]n\s+de\s+legalizaci)/i.test(
      trimmed,
    )
  ) {
    return true;
  }
  return false;
}

function layoutLineOwnershipKey(line: DocumentLayoutLine): string {
  if (line.id) return line.id;
  const box = line.boundingBox;
  return `${line.pageIndex}:${box?.x ?? 0}:${box?.y ?? 0}:${line.text}`;
}

function enforceExclusiveNumericOwnership(
  cells: Map<ColumnKind, DocumentLayoutLine[]>,
): string[] {
  const rejected: string[] = [];
  const owned = new Map<string, ColumnKind>();
  const order: ColumnKind[] = ['quantity', 'unitPrice', 'discount', 'vatRate', 'lineTotal'];
  for (const kind of order) {
    const bucket = cells.get(kind) ?? [];
    const kept: DocumentLayoutLine[] = [];
    for (const line of bucket) {
      const key = layoutLineOwnershipKey(line);
      const previous = owned.get(key);
      if (previous && previous !== kind) {
        rejected.push(`${kind}_lost_exclusive_token_to_${previous}`);
        continue;
      }
      owned.set(key, kind);
      kept.push(line);
    }
    cells.set(kind, kept);
  }
  const totalLines = cells.get('lineTotal') ?? [];
  const quantityLines = cells.get('quantity') ?? [];
  if (quantityLines.length === 0 && totalLines.length > 0) {
    const stolen = totalLines.find((line) => {
      const value = parseTableAmount(line.text);
      return value !== undefined
        && Number.isInteger(value)
        && value > 0
        && value <= 10000
        && !/[.,]\d{2}/.test(line.text);
    });
    if (stolen && (totalLines.some((line) => line !== stolen && /[.,]\d{2}/.test(line.text)) || (cells.get('unitPrice') ?? []).length > 0)) {
      cells.set('lineTotal', totalLines.filter((line) => line !== stolen));
      cells.set('quantity', [stolen]);
      rejected.push('quantity_reclaimed_from_line_total');
    }
  }
  return rejected;
}

type CommercialPriceHeaderRole = 'base_or_list_price' | 'effective_net_unit_price' | 'line_total' | 'other';

function commercialPriceHeaderRole(text: string): CommercialPriceHeaderRole {
  const normalized = normalizeDocumentText(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return 'other';
  // Explicit net/effective UNIT price labels. Keep this separate from generic
  // line totals: both are monetary, but they have different row semantics.
  if (/^(?:prezzo\s+netto|net(?:to)?\s+(?:unit\s+)?price|effective\s+(?:unit\s+)?price|prix\s+(?:unitaire\s+)?net|precio\s+(?:unitario\s+)?neto|nettopreis|netto\s*preis)$/i.test(normalized)) {
    return 'effective_net_unit_price';
  }
  if (/^(?:importo|amount|line\s+total|totale(?:\s+riga)?|total\s+ligne|montant|importe|gesamtbetrag|betrag|nettobetrag)$/i.test(normalized)) {
    return 'line_total';
  }
  // Base/list/gross price is only treated as such when an explicit net-price
  // lane also exists in the same schema. A standalone generic "price" remains
  // a normal unitPrice everywhere else.
  if (/^(?:prezzo(?:\s+(?:listino|base|lordo))?|list\s+price|base\s+price|gross\s+price|catalog(?:ue)?\s+price|prix(?:\s+(?:catalogue|liste|brut))?|precio(?:\s+(?:lista|base|bruto))?|listenpreis|bruttopreis)$/i.test(normalized)) {
    return 'base_or_list_price';
  }
  return 'other';
}

function isIgnoredCommercialNumericLane(
  line: DocumentLayoutLine,
  laneXs: readonly number[] | undefined,
  pageWidth: number,
): boolean {
  if (!laneXs || laneXs.length === 0 || parseTableAmount(line.text) === undefined) return false;
  const centerX = lineCenterX(line);
  const tolerance = Math.max(34, Math.min(70, pageWidth * 0.035));
  return laneXs.some((laneX) => Math.abs(centerX - laneX) <= tolerance);
}

function itemFromRow(
  row: LayoutRow,
  columns: readonly HeaderColumn[],
  columnKind: ColumnKindResolver,
  options?: { weakSchemaSafeMode?: boolean; positionIndexX?: number; pageWidth?: number; ignoredCommercialNumericLaneXs?: readonly number[] },
): StructuredLineItem | undefined {
  const started = Date.now();
  const weakSchemaSafeMode = options?.weakSchemaSafeMode === true;
  const positionIndexX = options?.positionIndexX;
  const pageWidth = options?.pageWidth ?? 1400;
  const cells = new Map<ColumnKind, DocumentLayoutLine[]>();
  const assignments: Array<ColumnKind | undefined> = [];
  const assignStarted = Date.now();
  const percentageLines: DocumentLayoutLine[] = [];
  for (let lineIndex = 0; lineIndex < row.lines.length; lineIndex += 1) {
    const line = row.lines[lineIndex];
    if (/^\d+(?:[.,]\d+)?\s*%$/.test(line.text.trim())) {
      percentageLines.push(line);
      assignments.push(undefined);
      continue;
    }
    const nextText = row.lines[lineIndex + 1]?.text.trim() ?? '';
    const numericSkuFragment = /^\d{2,}$/.test(line.text.trim()) &&
      /(?=.*\d)(?=.*[A-Za-z])^[A-Za-z0-9-]+$/.test(nextText);
    if (numericSkuFragment) {
      assignments.push(undefined);
      continue;
    }
    const kind = isIgnoredCommercialNumericLane(
      line,
      options?.ignoredCommercialNumericLaneXs,
      pageWidth,
    ) ? undefined : assignLineToColumn(line, columns, positionIndexX, pageWidth);
    assignments.push(kind);
    if (!kind) continue;
    const bucket = cells.get(kind);
    if (bucket) bucket.push(line);
    else cells.set(kind, [line]);
  }
  for (const line of row.lines) {
    if (!/^(?:122|I22|22)$/i.test(line.text.trim())) continue;
    for (const kind of [...cells.keys()]) {
      const bucket = cells.get(kind);
      if (!bucket) continue;
      cells.set(kind, bucket.filter((entry) => entry !== line));
    }
    const vatBucket = cells.get('vatRate') ?? [];
    if (!vatBucket.includes(line)) vatBucket.push(line);
    cells.set('vatRate', vatBucket);
  }
  if (percentageLines.length > 0) {
    const hasDiscountColumn = columns.some((column) => column.kind === 'discount');
    const hasVatColumn = columns.some((column) => column.kind === 'vatRate');
    const totalX = columnX(columns, 'lineTotal');
    const vatX = columnX(columns, 'vatRate');
    for (const line of percentageLines) {
      const geometric = assignLineToColumn(line, columns, positionIndexX, pageWidth);
      const center = line.boundingBox
        ? line.boundingBox.x + line.boundingBox.width / 2
        : line.readingOrder;
      const leftOfTotal = totalX !== undefined && center < totalX - 15;
      const inVatX = vatX !== undefined && Math.abs(center - vatX) <= 90;
      const resolved: ColumnKind | undefined =
        geometric === 'discount' || geometric === 'vatRate'
          ? geometric
          : weakSchemaSafeMode
            ? undefined
            : hasDiscountColumn && !hasVatColumn
              ? 'discount'
              : leftOfTotal && !inVatX
                ? 'discount'
                : hasVatColumn
                  ? 'vatRate'
                  : 'discount';
      if (!resolved) continue;
      const bucket = cells.get(resolved) ?? [];
      if (!bucket.includes(line)) bucket.push(line);
      cells.set(resolved, bucket);
      assignments[row.lines.indexOf(line)] = resolved;
    }
  }
  logItemParsePerf('assignLineToColumn', { ms: Date.now() - assignStarted, assignments });
  if (positionIndexX !== undefined) {
    for (const kind of ['quantity', 'unitPrice', 'lineTotal'] as const) {
      const bucket = cells.get(kind);
      if (!bucket) continue;
      const filtered = bucket.filter((line) => !isPositionIndexCell(line, positionIndexX, pageWidth));
      if (filtered.length !== bucket.length) cells.set(kind, filtered);
    }
  }
  const rejectedCandidates: string[] = [
    ...reclaimLineTotalsFromVatColumn(cells),
    ...enforceExclusiveNumericOwnership(cells),
  ];
  const descriptionLines = (cells.get('description') ?? []).filter((line) => !isNotesOrTermsBoundary(line.text));
  if (descriptionLines.length !== (cells.get('description') ?? []).length) {
    cells.set('description', descriptionLines);
  }
  let descriptionRaw = rawCell(cells, 'description');
  const itemCodeRaw = rawCell(cells, 'itemCode');
  if (itemCodeRaw && descriptionRaw) {
    const escaped = itemCodeRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    descriptionRaw = descriptionRaw.replace(new RegExp(`^${escaped}\\s+`), '').trim();
  }
  const leftoverCommercial = row.lines.filter((line) =>
    assignLineToColumn(line, columns, positionIndexX, pageWidth) === undefined
    && parseTableAmount(line.text) === undefined
    && parseQuantityCell(line.text) === undefined
    && !isPositionIndexCell(line, positionIndexX, pageWidth)
    && /[A-Za-z\u00c0-\u024f]{4,}/.test(line.text)
    && !isNotesOrTermsBoundary(line.text)
    && !detectDocumentTableColumnFast(line.text)
    && !/^[A-ZÀ-Ü][A-Z0-9À-Ü._-]{2,23}$/.test(line.text.trim()));
  const descriptionLooksLikeSku = !!descriptionRaw
    && descriptionRaw.length <= 24
    && !/\s/.test(descriptionRaw)
    && /[A-Za-z]/.test(descriptionRaw);
  if (descriptionLooksLikeSku && leftoverCommercial.length > 0) {
    if (!itemCodeRaw) {
      cells.set('itemCode', cells.get('description') ?? []);
    }
    descriptionRaw = leftoverCommercial.map((line) => line.text.trim()).join(' ');
    cells.set('description', leftoverCommercial);
  }
  if (!descriptionRaw && itemCodeRaw.length > 12 && /[A-Za-z\u00c0-\u024f]{4,}/.test(itemCodeRaw)) {
    descriptionRaw = itemCodeRaw;
  }
  if (!descriptionRaw) {
    if (leftoverCommercial.length > 0) {
      descriptionRaw = leftoverCommercial.map((line) => line.text.trim()).join(' ');
      cells.set('description', leftoverCommercial);
    }
  }
  const quantityLines = coalesceFrenchNumericLines(
    (cells.get('quantity') ?? []).filter((line) => !looksLikeTechnicalMeasure(line.text)),
  );
  const unitPriceLines = coalesceFrenchNumericLines(
    (cells.get('unitPrice') ?? []).filter((line) => !looksLikeTechnicalMeasure(line.text)),
  );
  const totalColumnLines = coalesceFrenchNumericLines(
    (cells.get('lineTotal') ?? []).filter((line) => !looksLikeTechnicalMeasure(line.text)),
  );
  let peeledQtyFromPrice: DocumentLayoutLine | undefined;
  let priceLines = unitPriceLines;
  if (quantityLines.length === 0 && unitPriceLines.length >= 2) {
    const first = unitPriceLines[0];
    const rest = unitPriceLines.slice(1);
    const firstValue = parseTableAmount(first.text);
    const restRaw = rest.map((line) => line.text).join(' ');
    const restValue = parseTableAmount(restRaw) ?? parseTableAmount(rest[0]?.text ?? '');
    const firstFractionDigits = first.text.trim().match(/[.,](\d+)/)?.[1]?.length ?? 0;
    if (
      firstValue !== undefined &&
      restValue !== undefined &&
      firstValue <= 10_000 &&
      restValue >= firstValue &&
      firstFractionDigits < 3 &&
      /^\d{1,4}(?:[.,]\d+)?$/.test(first.text.trim())
    ) {
      peeledQtyFromPrice = first;
      priceLines = rest;
    }
  }
  const quantityLine = (peeledQtyFromPrice ? [peeledQtyFromPrice, ...quantityLines] : quantityLines).at(-1);
  const quantityRaw = quantityLine?.text.trim() ?? '';
  const priceRaw = priceLines.map((line) => line.text.trim()).join(' ').trim();
  const quantityStarted = Date.now();
  const description = textEvidence(descriptionRaw, cells.get('description') ?? cells.get('itemCode') ?? [], 'table_description_column');
  const observedQuantityValue = parseQuantityCell(quantityRaw) ?? parseTableAmount(quantityRaw);
  const observedQuantity = observedQuantityValue !== undefined
    ? documentEvidence({
        rawValue: quantityRaw,
        normalizedValue: observedQuantityValue,
        lines: quantityLine ? [quantityLine] : [],
        validationStatus: 'valid',
        reasons: ['table_quantity_column', quantityProvenanceReason('explicit_column')],
        requiresReview: false,
      })
    : tableAmountEvidence(quantityRaw, quantityLine ? [quantityLine] : [], 'table_quantity_column');
  if (quantityLines.length > 1 && isDevLogEnabled()) {
    console.warn(`[QuantityCandidatePerf] ${JSON.stringify({
      rowIndex: row.pageIndex,
      candidates: quantityLines.map((line) => ({
        text: line.text,
        x: line.boundingBox?.x,
        assignedColumn: 'quantity',
        parsedValue: parseTableAmount(line.text),
        sourceId: line.id,
        accepted: line === quantityLine,
        rejectReason: line === quantityLine ? undefined : 'multiple_quantity_cells_do_not_concatenate',
      })),
      selected: quantityRaw,
    })}`);
  }
  logItemParsePerf('amountEvidence_quantity', { ms: Date.now() - quantityStarted });
  const priceStarted = Date.now();
  const unitPrice = tableAmountEvidence(priceRaw, priceLines, 'table_unit_price_column');
  logItemParsePerf('amountEvidence_unit_price', { ms: Date.now() - priceStarted });
  const totalLines = totalColumnLines;
  const discountRawForTotal = rawCell(cells, 'discount');
  const parsedDiscountForTotal = parseDiscountPercent(discountRawForTotal)
    ?? parseTableAmount(discountRawForTotal);
  const discountFactorForTotal = parsedDiscountForTotal !== undefined
    && parsedDiscountForTotal > 0
    && parsedDiscountForTotal < 80
    ? 1 - parsedDiscountForTotal / 100
    : 1;
  const expectedTotal = observedQuantity?.normalizedValue !== undefined && unitPrice?.normalizedValue !== undefined
    ? observedQuantity.normalizedValue * unitPrice.normalizedValue * discountFactorForTotal
    : undefined;
  const unitBound = unitPrice?.normalizedValue;
  const qtyBound = observedQuantity?.normalizedValue;
  const extraMissingDecimalTotals = weakSchemaSafeMode ? [] : row.lines.filter((line) => {
    if (totalLines.includes(line)) return false;
    if (!/^\d{4,}$/.test(line.text.trim())) return false;
    const value = parseTableAmount(line.text);
    if (value === undefined) return false;
    const x = line.boundingBox ? line.boundingBox.x + line.boundingBox.width / 2 : undefined;
    const priceX = columnX(columns, 'unitPrice');
    if (priceX !== undefined && x !== undefined && x < priceX) return false;
    return true;
  });
  const totalCandidates = [...totalLines, ...extraMissingDecimalTotals].flatMap((line) => {
    const value = resolveLineTotalColumnValue(
      line.text,
      unitPrice?.normalizedValue,
      observedQuantity?.normalizedValue,
    );
    return value === undefined ? [] : [{ line, value }];
  });
  const totalVariants = totalCandidates.flatMap(({ line, value }) => {
    const variants = [value];
    if (!/[.,]/.test(line.text) && value >= 100) {
      for (const scale of [10, 100, 1000, 10000]) variants.push(value / scale);
    }
    return variants.map((adjusted) => ({ line, value, adjusted }));
  });
  const selectedPick = expectedTotal === undefined || weakSchemaSafeMode
    ? (totalVariants[0] ? { ...totalVariants[0], adjusted: totalVariants[0].value } : undefined)
    : [...totalVariants].sort((left, right) => {
        const stealLeft = qtyBound !== undefined && qtyBound > 1 && (
          (unitBound !== undefined && Math.abs(left.adjusted - unitBound) < 0.02)
          || Math.abs(left.adjusted - qtyBound) < 0.02
        ) ? 1 : 0;
        const stealRight = qtyBound !== undefined && qtyBound > 1 && (
          (unitBound !== undefined && Math.abs(right.adjusted - unitBound) < 0.02)
          || Math.abs(right.adjusted - qtyBound) < 0.02
        ) ? 1 : 0;
        if (stealLeft !== stealRight) return stealLeft - stealRight;
        return Math.abs(left.adjusted - expectedTotal) - Math.abs(right.adjusted - expectedTotal);
      })[0];
  const selectedTotal = selectedPick
    ? { line: selectedPick.line, value: selectedPick.value }
    : undefined;
  const adjustedTotal = selectedPick?.adjusted;
  const lineTotal = selectedTotal && adjustedTotal !== undefined
    ? documentEvidence({
        rawValue: selectedTotal.line.text,
        normalizedValue: adjustedTotal,
        lines: [selectedTotal.line],
        validationStatus: adjustedTotal === selectedTotal.value ? 'valid' : 'unverified',
        reasons: ['table_line_total_column', ...(adjustedTotal === selectedTotal.value ? ['locale_aware_amount'] : ['decimal_position_reconciled_with_quantity_and_unit_price'])],
        requiresReview: adjustedTotal !== selectedTotal.value,
      })
    : tableAmountEvidence(totalLines.map((line) => line.text.trim()).join(' '), totalLines, 'table_line_total_column');
  const stolenLineTotal = lineTotal?.normalizedValue !== undefined
    && expectedTotal !== undefined
    && Math.abs(lineTotal.normalizedValue - expectedTotal) > 0.05
    && (
      (qtyBound !== undefined && qtyBound > 1 && Math.abs(lineTotal.normalizedValue - qtyBound) < 0.02)
      || (unitBound !== undefined && Math.abs(lineTotal.normalizedValue - unitBound) < 0.02)
    );
  if (stolenLineTotal) rejectedCandidates.push('line_total_copied_qty_or_price_rejected');
  const committedLineTotal = stolenLineTotal ? undefined : lineTotal;
  const unitTokenLines = (cells.get('unit') ?? []).filter((line) => isUnitOfMeasureToken(line.text));
  const hasUnitToken = unitTokenLines.length > 0
    || row.lines.some((line) => isUnitOfMeasureToken(line.text));
  let quantity = observedQuantity;
  const hasDescription = !!description?.normalizedValue;
  let resolvedUnitPrice = unitPrice;
  let resolvedLineTotal = committedLineTotal;
  let resolvedQuantity = quantity;
  const qtyHeaderX = columnX(columns, 'quantity');
  const resolvedQty = resolveRowQuantity({
    rowLines: row.lines,
    quantityColumnLines: quantityLine ? [quantityLine, ...quantityLines] : quantityLines,
    quantityHeaderX: qtyHeaderX,
    unitPrice: resolvedUnitPrice?.normalizedValue,
    lineTotal: resolvedLineTotal?.normalizedValue,
    discount: parseDiscountPercent(rawCell(cells, 'discount')) ?? parseTableAmount(rawCell(cells, 'discount')),
    observedQuantity: resolvedQuantity?.normalizedValue,
    hasExplicitOcrQuantity: !!quantityLine
      || quantityLines.length > 0
      || resolvedQuantity?.normalizedValue !== undefined,
    hasCountUnit: hasUnitToken
      || row.lines.some((line) => /^(?:NR1?|NR\.?|PZ\.?|PCS\.?)$/i.test(line.text.trim())),
  });
  if (
    resolvedQty.provenance !== 'default_missing'
    && resolvedQty.provenance !== 'unknown_missing'
    && resolvedQty.value !== undefined
    && !(weakSchemaSafeMode && /arithmetic/.test(resolvedQty.provenance))
  ) {
    resolvedQuantity = documentEvidence({
      rawValue: resolvedQty.raw,
      normalizedValue: resolvedQty.value,
      lines: resolvedQty.line ? [resolvedQty.line] : (quantityLine ? [quantityLine] : []),
      validationStatus: resolvedQty.provenance === 'arithmetic_derived_missing_ocr' ? 'unverified' : 'valid',
      reasons: [quantityProvenanceReason(resolvedQty.provenance)],
      requiresReview: resolvedQty.provenance === 'arithmetic_derived_missing_ocr',
    });
  } else if (
    resolvedQuantity === undefined &&
    hasUnitToken &&
    (resolvedUnitPrice?.normalizedValue !== undefined || resolvedLineTotal?.normalizedValue !== undefined)
  ) {
    resolvedQuantity = tableAmountEvidence(
      '1',
      unitTokenLines.slice(0, 1),
      quantityProvenanceReason('default_missing'),
    );
  }
  const COMMON_VAT_RATES = new Set([4, 5, 10, 19, 20, 21, 22, 23]);
  const zeroAmountLines = row.lines.filter((line) => isExactZeroMoneyToken(line.text));
  // Free / zero-priced commercial rows often leave VAT% in the price column after OCR.
  if (
    resolvedUnitPrice?.normalizedValue !== undefined &&
    COMMON_VAT_RATES.has(resolvedUnitPrice.normalizedValue) &&
    resolvedQuantity === undefined &&
    resolvedLineTotal === undefined &&
    zeroAmountLines.length > 0
  ) {
    resolvedUnitPrice = amountEvidence('0,00', zeroAmountLines.slice(0, 1), 'table_zero_unit_price');
    resolvedLineTotal = amountEvidence('0,00', zeroAmountLines.slice(0, 1), 'table_zero_line_total');
  }
  if (
    (resolvedQuantity === undefined || resolvedQuantity.normalizedValue === 0)
    && resolvedUnitPrice?.normalizedValue === 0
    && (resolvedLineTotal?.normalizedValue === 0 || resolvedLineTotal === undefined)
    && hasDescription
  ) {
    resolvedQuantity = documentEvidence({
      rawValue: '1',
      normalizedValue: 1,
      lines: [],
      validationStatus: 'unverified',
      reasons: [quantityProvenanceReason('default_missing'), 'zero_priced_included_row'],
      requiresReview: true,
    });
    if (resolvedLineTotal === undefined) {
      resolvedLineTotal = amountEvidence('0,00', zeroAmountLines.slice(0, 1), 'table_zero_line_total');
    }
  }
  const hasLineTotal = resolvedLineTotal?.normalizedValue !== undefined;
  const hasQtyPrice =
    resolvedQuantity?.normalizedValue !== undefined && resolvedUnitPrice?.normalizedValue !== undefined;
  const hasQtyTotal =
    resolvedQuantity?.normalizedValue !== undefined && hasLineTotal;
  const hasPriceTotal =
    resolvedUnitPrice?.normalizedValue !== undefined && hasLineTotal;
  // A code-shaped token alone (qty-only / price-only) is a tentative fragment, not a row.
  const hasPartialNumeric = hasQtyPrice || hasQtyTotal || hasPriceTotal || hasLineTotal;
  const rejectCandidate = (reason: string): undefined => {
    if (isQaDocumentLoggingEnabled() || isDevLogEnabled()) {
      logQaDocument('ItemCandidateReject', {
        reason,
        descriptionSnippet: String(description?.normalizedValue ?? descriptionRaw ?? '').slice(0, 48),
        lineCount: row.lines.length,
        lineSnippets: row.lines.slice(0, 8).map((line) => line.text.slice(0, 40)),
      });
    }
    return undefined;
  };
  if (!hasDescription || !hasPartialNumeric) {
    return rejectCandidate(!hasDescription ? 'missing_description' : 'missing_numeric_evidence');
  }
  const descText = String(description?.normalizedValue ?? '').trim();
  const headerTexts = new Set(columns.map((column) => normalizeDocumentText(column.line.text)));
  if (headerTexts.has(normalizeDocumentText(descText))) return rejectCandidate('header_like');
  const complete =
    hasLineTotal &&
    hasDescription &&
    (hasQtyPrice ||
      (resolvedQuantity?.normalizedValue !== undefined && hasLineTotal) ||
      (resolvedUnitPrice?.normalizedValue !== undefined && hasLineTotal));
  const unitRaw = rawCell(cells, 'unit');
  const discountRaw = rawCell(cells, 'discount');
  const vatRaw = rawCell(cells, 'vatRate');
  const validationStarted = Date.now();
  const vatNature = /\b(?:esente|non imponibile|reverse charge|n\.?\s*\d(?:\.\d+)?)\b/i.test(vatRaw)
    ? textEvidence(vatRaw, cells.get('vatRate') ?? [], 'vat_nature_in_table')
    : undefined;
  const itemCode = textEvidence(itemCodeRaw, cells.get('itemCode') ?? [], 'table_item_code_column');
  const unit = textEvidence(unitRaw, cells.get('unit') ?? [], 'table_unit_column');
  // Row-level discount columns are percentage semantics. An arbitrary monetary
  // amount must not become a discount merely because OCR geometry placed it in
  // the discount lane. Bare percentage forms remain supported.
  let discount = percentEvidence(discountRaw, cells.get('discount') ?? [], 'table_discount_column');
  if (discount && !/%/.test(discountRaw)) {
    const discountValue = discount.normalizedValue;
    const qtyValue = resolvedQuantity?.normalizedValue;
    const priceValue = resolvedUnitPrice?.normalizedValue;
    const totalValue = resolvedLineTotal?.normalizedValue;
    const collidesWithAnotherField = discountValue !== undefined && [qtyValue, priceValue, totalValue]
      .some((value) => value !== undefined && Math.abs(value - discountValue) < 0.02);
    if (collidesWithAnotherField) {
      discount = undefined;
      rejectedCandidates.push('bare_discount_copies_other_numeric_field');
    }
  }
  let vatRate = percentEvidence(vatRaw, cells.get('vatRate') ?? [], 'table_vat_rate_column');
  const totalHeaderX = columnX(columns, 'lineTotal');
  const vatHeaderXForDiscount = columnX(columns, 'vatRate');
  const discountLinesForVat = cells.get('discount') ?? [];
  const discountIsVatColumn = !!discount
    && discount.normalizedValue !== undefined
    && looksLikeVatRateNotAmount(discount.normalizedValue, discountRaw)
    && discountLinesForVat.some((line) => {
      const centerX = line.boundingBox
        ? line.boundingBox.x + line.boundingBox.width / 2
        : undefined;
      const rightOfTotal = totalHeaderX !== undefined && (line.boundingBox?.x ?? 0) > totalHeaderX + 15;
      const inVatX = vatHeaderXForDiscount !== undefined && centerX !== undefined
        && Math.abs(centerX - vatHeaderXForDiscount) < 90;
      return rightOfTotal || inVatX;
    });
  if (discountIsVatColumn && !vatRate && !weakSchemaSafeMode) {
    vatRate = percentEvidence(discountRaw, discountLinesForVat, 'table_vat_rate_column')
      ?? amountEvidence(discountRaw, discountLinesForVat, 'table_vat_rate_column');
    discount = undefined;
  }
  const vatColumnPresent = columns.some((column) => column.kind === 'vatRate');
  const standardVat = new Set([19, 20, 21, 22, 23]);
  if (
    !weakSchemaSafeMode
    && vatColumnPresent
    && discount
    && discount.normalizedValue !== undefined
    && standardVat.has(Math.round(discount.normalizedValue))
    && !vatRate
  ) {
    vatRate = percentEvidence(discountRaw, discountLinesForVat, 'table_vat_rate_column')
      ?? discount;
    discount = undefined;
  }
  if (
    vatColumnPresent
    && vatRate?.normalizedValue !== undefined
    && discount?.normalizedValue !== undefined
    && Math.abs(discount.normalizedValue - vatRate.normalizedValue) < 0.01
  ) {
    discount = undefined;
  }
  if (!vatRate && !weakSchemaSafeMode) {
    const vatHeaderX = columnX(columns, 'vatRate');
    const discountHeaderX = columnX(columns, 'discount');
    const tokenFitsVat = (
      text: string,
      box: { x: number; y: number; width?: number; height?: number } | undefined,
    ): number | undefined => {
      const centerX = box ? box.x + (box.width ?? 0) / 2 : undefined;
      const inDiscount = discountHeaderX !== undefined && centerX !== undefined
        && Math.abs(centerX - discountHeaderX) < 90;
      if (inDiscount) return undefined;
      const inVat = vatHeaderX !== undefined && centerX !== undefined
        && (Math.abs(centerX - vatHeaderX) < 90 || Math.abs(box!.x - vatHeaderX) < 90);
      const rightOfTotal = totalHeaderX !== undefined && (box?.x ?? 0) > totalHeaderX + 15;
      const rate = (inVat || rightOfTotal)
        ? (parsePlausibleVatRate(text) ?? parseCorruptedVatToken(text))
        : parsePlausibleVatRate(text);
      if (rate === undefined) return undefined;
      if (vatHeaderX === undefined || !box) return /%/.test(text) ? rate : undefined;
      return (inVat || rightOfTotal) ? rate : undefined;
    };
    const vatToken = row.lines.find((line) => tokenFitsVat(line.text, line.boundingBox) !== undefined);
    if (vatToken) {
      vatRate = percentEvidence(vatToken.text, [vatToken], 'table_vat_rate_column');
    }
    if (!vatRate) {
      for (const line of row.lines) {
        for (const element of line.elements ?? []) {
          if (tokenFitsVat(element.text, element.boundingBox) === undefined) continue;
          vatRate = percentEvidence(element.text, [{
            ...line,
            text: element.text,
            boundingBox: element.boundingBox ?? line.boundingBox,
            elements: [element],
          }], 'table_vat_rate_column');
          if (vatRate) break;
        }
        if (vatRate) break;
      }
    }
  }
  if (
    !weakSchemaSafeMode
    && !resolvedUnitPrice
    && resolvedLineTotal?.normalizedValue !== undefined
    && resolvedQuantity?.normalizedValue
  ) {
    const factor = discount?.normalizedValue !== undefined && discount.normalizedValue > 0 && discount.normalizedValue < 80
      ? 1 - discount.normalizedValue / 100
      : 1;
    const listPriceLine = row.lines.find((line) => {
      const value = parseTableAmount(line.text);
      if (value === undefined || value <= 1) return false;
      if (Math.abs(value - resolvedLineTotal!.normalizedValue!) < 0.02 && factor < 1) return false;
      return Math.abs(resolvedQuantity!.normalizedValue! * value * factor - resolvedLineTotal!.normalizedValue!) <= 0.06;
    });
    if (listPriceLine) {
      resolvedUnitPrice = tableAmountEvidence(listPriceLine.text, [listPriceLine], 'table_unit_price_column');
    }
  }
  const qtyVal = resolvedQuantity?.normalizedValue;
  const priceVal = resolvedUnitPrice?.normalizedValue;
  const discountVal = discount?.normalizedValue;
  if (
    resolvedLineTotal?.normalizedValue !== undefined
    && qtyVal !== undefined
    && qtyVal > 1
    && priceVal !== undefined
    && Math.abs(resolvedLineTotal.normalizedValue - qtyVal) < 0.02
    && Math.abs(qtyVal * priceVal - resolvedLineTotal.normalizedValue) > 0.05
  ) {
    rejectedCandidates.push('line_total_copied_qty_or_price_rejected');
    resolvedLineTotal = undefined;
  }
  const totalVal = resolvedLineTotal?.normalizedValue;
  if (
    qtyVal !== undefined
    && qtyVal > 1
    && priceVal !== undefined
    && priceVal > 0
    && totalVal !== undefined
    && totalVal > 0
  ) {
    const commercialClose = (left: number, right: number) =>
      Math.abs(left - right) <= Math.max(0.06, Math.abs(right) * 0.025);
    const netLines = row.lines.filter((line) => {
      if (/%/.test(line.text) || isVatShapedToken(line.text) || isExactZeroMoneyToken(line.text)) return false;
      const value = parseTableAmount(line.text);
      if (value === undefined || !(value > 0) || value >= totalVal) return false;
      if (Math.abs(value - priceVal) < 0.01) return false;
      if (Math.abs(value - qtyVal) < 0.01) return false;
      if (discountVal !== undefined && Math.abs(value - discountVal) < 0.01) return false;
      return commercialClose(qtyVal * value, totalVal);
    });
    const uniqueNets = [...new Set(netLines
      .map((line) => parseTableAmount(line.text))
      .filter((value): value is number => value !== undefined))];
    if (uniqueNets.length === 1 && netLines[0]) {
      const discountExplains = discountVal !== undefined
        && discountVal > 0
        && discountVal < 80
        && commercialClose(qtyVal * priceVal * (1 - discountVal / 100), totalVal);
      const listExplainsWithoutDiscount = commercialClose(qtyVal * priceVal, totalVal);
      if (discountExplains && !listExplainsWithoutDiscount) {
        resolvedUnitPrice = tableAmountEvidence(netLines[0].text, [netLines[0]], 'table_unit_price_column');
        discount = undefined;
        rejectedCandidates.push('list_discount_already_applied_in_net_unit');
      }
    }
  }
  if (
    (resolvedLineTotal === undefined || resolvedLineTotal.normalizedValue === 0)
    && (resolvedUnitPrice?.normalizedValue ?? 0) > 0
  ) {
    const printedTotals = row.lines.filter((line) => {
      if (!isCommercialMoneyNotVatToken(line.text)) return false;
      const value = parseTableAmount(line.text);
      if (value === undefined) return false;
      if (resolvedUnitPrice?.normalizedValue !== undefined && Math.abs(value - resolvedUnitPrice.normalizedValue) < 0.01) {
        return false;
      }
      if (discount?.normalizedValue !== undefined && Math.abs(value - discount.normalizedValue) < 0.01) return false;
      return true;
    });
    const uniqueValues = [...new Set(printedTotals
      .map((line) => parseTableAmount(line.text))
      .filter((value): value is number => value !== undefined))];
    if (uniqueValues.length === 1 && printedTotals[0]) {
      const printedValue = uniqueValues[0];
      const copiesQuantity = qtyVal !== undefined && Math.abs(printedValue - qtyVal) < 0.02;
      const copiesPrice = priceVal !== undefined && Math.abs(printedValue - priceVal) < 0.02;
      if (!(copiesQuantity || copiesPrice) || !columns.some((column) => column.kind === 'lineTotal')) {
        resolvedLineTotal = tableAmountEvidence(
          printedTotals[0].text,
          [printedTotals[0]],
          'table_line_total_column',
        );
        rejectedCandidates.push('false_zero_line_total_replaced_by_printed');
      }
    }
  }
  if (
    resolvedLineTotal === undefined
    && rejectedCandidates.includes('line_total_copied_qty_or_price_rejected')
    && qtyVal !== undefined
    && qtyVal > 0
    && priceVal !== undefined
    && priceVal >= 0
  ) {
    const derived = Math.round(qtyVal * priceVal * (
      discountVal !== undefined && discountVal > 0 && discountVal < 80 ? 1 - discountVal / 100 : 1
    ) * 100) / 100;
    resolvedLineTotal = documentEvidence({
      rawValue: String(derived),
      normalizedValue: derived,
      lines: [],
      validationStatus: 'unverified',
      reasons: ['arithmetic_derived_line_total'],
      requiresReview: true,
    });
  }
  const lineTotalXs = columns
    .filter((column) => column.kind === 'lineTotal')
    .map((column) => (column.line.boundingBox
      ? column.line.boundingBox.x + column.line.boundingBox.width / 2
      : column.x));
  const totalHeaderXForPrinted = lineTotalXs.length > 0 ? Math.max(...lineTotalXs) : columnX(columns, 'lineTotal');
  const printedColumnTotals = row.lines.flatMap((line) => {
    const assigned = assignLineToColumn(line, columns, positionIndexX, pageWidth)
      ?? nearestNumericHeaderKind(line, columns, positionIndexX, pageWidth);
    if (assigned !== 'lineTotal') return [];
    if (/%/.test(line.text) || isVatShapedToken(line.text) || looksLikeTechnicalMeasure(line.text)) return [];
    const value = parseTableAmount(line.text);
    if (value === undefined || !Number.isFinite(value)) return [];
    const centerX = line.boundingBox ? line.boundingBox.x + line.boundingBox.width / 2 : 0;
    if (totalHeaderXForPrinted !== undefined && Math.abs(centerX - totalHeaderXForPrinted) > 90) return [];
    return [{ line, value }];
  });
  const printedColumnTotal = printedColumnTotals.sort((left, right) => {
    const leftX = left.line.boundingBox ? left.line.boundingBox.x + left.line.boundingBox.width / 2 : 0;
    const rightX = right.line.boundingBox ? right.line.boundingBox.x + right.line.boundingBox.width / 2 : 0;
    const target = totalHeaderXForPrinted ?? leftX;
    return Math.abs(leftX - target) - Math.abs(rightX - target);
  })[0];
  if (printedColumnTotal) {
    const printedZero = isExactZeroMoneyToken(printedColumnTotal.line.text) || printedColumnTotal.value === 0;
    const current = resolvedLineTotal?.normalizedValue;
    const copiesPrice = priceVal !== undefined && Math.abs(printedColumnTotal.value - priceVal) < 0.02;
    const copiesQty = qtyVal !== undefined && qtyVal > 1 && Math.abs(printedColumnTotal.value - qtyVal) < 0.02;
    const missingOrFalseZero = current === undefined || (current === 0 && !printedZero && printedColumnTotal.value > 0);
    const hasQtyAndPrice = qtyVal !== undefined && priceVal !== undefined;
    if (missingOrFalseZero && hasQtyAndPrice && !copiesQty && (qtyVal === 1 || !copiesPrice)) {
      resolvedLineTotal = tableAmountEvidence(
        printedColumnTotal.line.text,
        [printedColumnTotal.line],
        'table_line_total_column',
      );
      rejectedCandidates.push('printed_line_total_preserved');
    }
  }
  logItemParsePerf('validation', { ms: Date.now() - validationStarted });
  if (isQaDocumentLoggingEnabled() || isDevLogEnabled()) {
    const qtyReason = resolvedQuantity?.reasons?.join(' ') ?? '';
    const arithmeticStatus = /arithmetic_derived_missing_ocr/.test(qtyReason)
      ? 'unique_derived'
      : resolvedQuantity?.normalizedValue !== undefined
        ? 'not_needed'
        : (resolvedUnitPrice?.normalizedValue && resolvedLineTotal?.normalizedValue)
          ? 'ambiguous_or_missing'
          : 'missing_operands';
    logQaDocument('RowFieldBinding', {
      rowIndex: row.pageIndex,
      descriptionClass: hasDescription ? 'present' : 'missing',
      rawCandidateCount: row.lines.length,
      quantitySource: fieldBindingSource(resolvedQuantity, resolvedQty.provenance === 'geometry_token' ? 'geometry_direct' : 'ocr_direct'),
      unitPriceSource: fieldBindingSource(resolvedUnitPrice, 'column_direct'),
      discountSource: discount ? fieldBindingSource(discount, 'column_direct') : 'unknown',
      vatSource: vatRate ? fieldBindingSource(vatRate, 'column_direct') : 'unknown',
      lineTotalSource: fieldBindingSource(resolvedLineTotal, 'column_direct'),
      rejectedCandidates,
      arithmeticStatus,
    });
  }
  const lateQty = resolvedQuantity?.normalizedValue;
  const latePrice = resolvedUnitPrice?.normalizedValue;
  const lateTotal = resolvedLineTotal?.normalizedValue;
  if (
    lateTotal !== undefined
    && lateQty !== undefined
    && lateQty > 1
    && latePrice !== undefined
    && latePrice > 0
    && Math.abs(lateTotal - lateQty) < 0.02
    && Math.abs(lateQty * latePrice - lateTotal) > 0.05
  ) {
    const derived = Math.round(lateQty * latePrice * (
      discount?.normalizedValue !== undefined && discount.normalizedValue > 0 && discount.normalizedValue < 80
        ? 1 - discount.normalizedValue / 100
        : 1
    ) * 100) / 100;
    resolvedLineTotal = documentEvidence({
      rawValue: String(derived),
      normalizedValue: derived,
      lines: [],
      validationStatus: 'unverified',
      reasons: ['arithmetic_derived_line_total'],
      requiresReview: true,
    });
    rejectedCandidates.push('line_total_copied_qty_or_price_rejected');
  }
  const item = {
    ...(itemCode ? { itemCode } : {}),
    description: description!,
    ...(resolvedQuantity ? { quantity: resolvedQuantity } : {}),
    ...(unit ? { unit } : {}),
    ...(resolvedUnitPrice ? { unitPrice: resolvedUnitPrice } : {}),
    ...(discount ? { discount } : {}),
    ...(vatRate ? { vatRate } : {}),
    ...(vatNature ? { vatNature } : {}),
    ...(resolvedLineTotal ? { lineTotal: resolvedLineTotal } : {}),
    pageIndex: row.pageIndex,
    sourceLineIds: row.lines.map((line) => line.id),
    sourceLines: row.lines.map((line) => line.text),
    requiresReview:
      !complete ||
      [description, resolvedQuantity, resolvedUnitPrice, resolvedLineTotal].some((evidence) => evidence?.requiresReview),
  };
  logItemParsePerf('row_done', { ms: Date.now() - started, cells: row.lines.length });
  return item;
}

function looksLikeCommercialItemCode(text: string): boolean {
  const token = text.trim();
  if (token.length < 3 || token.length > 24) return false;
  if (detectDocumentTableColumnFast(token) || parseTableAmount(token) !== undefined) return false;
  if (/^(?:servizio|service|kit\b|trasporto|transport|spese\b|noleggio|installazione|manodopera|lavorazione|shipping|freight|documentazione)\b/i.test(token)) {
    return true;
  }
  if (/^[A-Z]{1,8}(?:[-_/][A-Z0-9]{1,12}){1,3}$/i.test(token)) return true;
  if (/^[A-Z]\d{3,8}$/i.test(token)) return true;
  return false;
}

function nearLeftAnchorDistancePad(
  anchor: DocumentLayoutLine,
  medianLineHeight: number,
  medianRowSpacing: number,
): number {
  const base = Math.max(
    medianLineHeight * 1.15,
    Math.min(medianRowSpacing * 0.42, Math.max(28, medianLineHeight * 1.8)),
  );
  if (looksLikeDistinctCommercialIdentity(anchor.text)) {
    return Math.max(base, medianRowSpacing * 0.72);
  }
  return base;
}

function isSameRowCategoryToken(text: string): boolean {
  const token = text.trim();
  return /^[A-ZÀ-Ü]{3,8}$/.test(token);
}

function isCommercialItemCodeAnchor(line: DocumentLayoutLine, columns: readonly HeaderColumn[]): boolean {
  if (!looksLikeCommercialItemCode(line.text)) return false;
  const assigned = assignLineToColumn(line, columns);
  if (assigned === 'description' || assigned === 'quantity' || assigned === 'unitPrice' || assigned === 'lineTotal') {
    return false;
  }
  if (assigned === 'itemCode') return true;
  const codeX = columnX(columns, 'itemCode');
  const x = line.boundingBox
    ? line.boundingBox.x + line.boundingBox.width / 2
    : line.readingOrder;
  return codeX !== undefined && Math.abs(x - codeX) <= 90;
}

function layoutLineRawY(line: DocumentLayoutLine, fallbackY = 0): number {
  return line.boundingBox?.y ?? fallbackY;
}

function verticalDistanceToBand(y: number, lo: number, hi: number): number {
  if (y < lo) return lo - y;
  if (y > hi) return y - hi;
  return 0;
}

function clusterMinRawYOf(row: LayoutRow): number {
  const ys = row.lines
    .map((line) => line.boundingBox?.y)
    .filter((value): value is number => value !== undefined);
  return ys.length > 0 ? Math.min(...ys) : row.y;
}

function clusterHasIndependentNumerics(
  row: LayoutRow,
  columns: readonly HeaderColumn[],
): boolean {
  let qty = false;
  let unitPrice = false;
  let lineTotal = false;
  for (const line of row.lines) {
    const kind = nearestNumericHeaderKind(line, columns);
    if (kind === 'quantity') qty = true;
    else if (kind === 'unitPrice') unitPrice = true;
    else if (kind === 'lineTotal') lineTotal = true;
  }
  return (qty && unitPrice) || (qty && lineTotal) || (unitPrice && lineTotal);
}

function confirmIndependentNumericAnchors(
  anchors: readonly LayoutRow[],
  columns: readonly HeaderColumn[],
  adjustedY: (line: DocumentLayoutLine) => number,
  hasUnitAnchors: boolean,
  medianLineHeight: number,
  body: readonly DocumentLayoutLine[],
): LayoutRow[] {
  const confirmed: LayoutRow[] = [];
  const pending: LayoutRow[] = [];
  const absorb = (target: LayoutRow, extra: LayoutRow) => {
    const dy = Math.abs(clusterMinRawYOf(extra) - clusterMinRawYOf(target));
    if (dy > Math.max(32, Math.min(medianLineHeight * 1.45, 48))) return;
    target.lines.push(...extra.lines);
    if (!hasUnitAnchors && target.lines.length > 0) {
      target.y = target.lines.reduce((sum, line) => sum + adjustedY(line), 0) / target.lines.length;
    }
  };
  const closerToIncoming = (extra: LayoutRow, incoming: LayoutRow, previous: LayoutRow): boolean => {
    const extraY = clusterMinRawYOf(extra);
    return Math.abs(extraY - clusterMinRawYOf(incoming)) + 4 < Math.abs(extraY - clusterMinRawYOf(previous));
  };
  for (const row of anchors) {
    if (clusterHasIndependentNumerics(row, columns)) {
      for (const extra of pending) {
        const previous = confirmed[confirmed.length - 1];
        if (!previous) absorb(row, extra);
        else if (closerToIncoming(extra, row, previous) && clusterMinRawYOf(extra) >= clusterMinRawYOf(row) - 8) {
          absorb(row, extra);
        } else absorb(previous, extra);
      }
      pending.length = 0;
      confirmed.push(row);
    } else {
      const previous = confirmed[confirmed.length - 1];
      const dy = previous
        ? Math.abs(clusterMinRawYOf(row) - clusterMinRawYOf(previous))
        : Number.POSITIVE_INFINITY;
      const farFromPrevious = dy > Math.max(32, Math.min(medianLineHeight * 1.45, 48));
      const hasLineTotal = row.lines.some((line) => nearestNumericHeaderKind(line, columns) === 'lineTotal');
      const rowY = clusterMinRawYOf(row);
      const hasNearbyCommercialIdentity = body.some((line) =>
        isLeftColumnRowAnchor(line, columns)
        && Math.abs(layoutLineRawY(line, rowY) - rowY) <= Math.max(28, Math.min(medianLineHeight * 1.8, 56))
      );
      if (hasNearbyCommercialIdentity) {
        for (const extra of pending) {
          const previousForExtra = confirmed[confirmed.length - 1];
          if (!previousForExtra || (closerToIncoming(extra, row, previousForExtra) && clusterMinRawYOf(extra) >= rowY - 8)) absorb(row, extra);
          else absorb(previousForExtra, extra);
        }
        pending.length = 0;
        confirmed.push(row);
      } else if (farFromPrevious && hasLineTotal) confirmed.push(row);
      else pending.push(row);
    }
  }
  for (const extra of pending) {
    const previous = confirmed[confirmed.length - 1];
    if (previous) absorb(previous, extra);
  }
  return confirmed;
}

function isLeftColumnRowAnchor(line: DocumentLayoutLine, columns: readonly HeaderColumn[]): boolean {
  if (isCommercialItemCodeAnchor(line, columns)) return true;
  const assigned = assignLineToColumn(line, columns);
  if (assigned !== 'itemCode') return false;
  const token = line.text.trim();
  if (token.length < 3 || token.length > 16 || /\s/.test(token)) return false;
  if (parseTableAmount(token) !== undefined || parseQuantityCell(token) !== undefined) return false;
  if (detectDocumentTableColumnFast(token)) return false;
  return /[A-Za-z]/.test(token);
}

function owningNumericRowIndex(
  codeY: number,
  anchors: readonly LayoutRow[],
): number {
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].y >= codeY - 8) return index;
  }
  return Math.max(0, anchors.length - 1);
}

function assignLeftAnchorsToClusters(
  leftAnchorYs: readonly number[],
  seedMins: readonly number[],
  independentClusters?: readonly boolean[],
): number[] {
  const claimed = seedMins.map(() => false);
  const owners = leftAnchorYs.map(() => -1);
  const order = leftAnchorYs
    .map((y, index) => ({ y, index }))
    .sort((left, right) => left.y - right.y);
  const assignPass = (allowFragment: boolean) => {
    for (const entry of order) {
      if (owners[entry.index]! >= 0) continue;
      let best = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let cluster = 0; cluster < seedMins.length; cluster += 1) {
        if (claimed[cluster]) continue;
        const independent = independentClusters?.[cluster] !== false;
        if (!allowFragment && independentClusters && !independent) continue;
        const distance = Math.abs(seedMins[cluster]! - entry.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cluster;
        }
      }
      if (best >= 0) {
        claimed[best] = true;
        owners[entry.index] = best;
      }
    }
  };
  // A drifted line-total fragment must not 1:1-claim a SKU that belongs to a
  // nearby qty/price/total band. Fragments are only claimed after independent
  // commercial clusters are exhausted.
  assignPass(false);
  assignPass(true);
  return owners;
}

function owningNumericRowIndexByRawY(
  codeRawY: number,
  anchors: readonly LayoutRow[],
  seedMins?: readonly number[],
  leftAnchorYs?: readonly number[],
  leftAnchorClusters?: readonly number[],
): number {
  if (
    leftAnchorYs
    && leftAnchorClusters
    && leftAnchorYs.length === leftAnchorClusters.length
    && leftAnchorYs.length > 0
  ) {
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < leftAnchorYs.length; index += 1) {
      const distance = Math.abs(leftAnchorYs[index]! - codeRawY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    const claimed = leftAnchorClusters[nearestIndex];
    if (claimed !== undefined && claimed >= 0) return claimed;
  }
  const mins = seedMins ?? anchors.map((anchor) => clusterMinRawYOf(anchor));
  let bestIndex = Math.max(0, anchors.length - 1);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < anchors.length; index += 1) {
    const minY = mins[index] ?? clusterMinRawYOf(anchors[index]);
    const distance = Math.abs(minY - codeRawY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function appendMultilineDescription(
  item: StructuredLineItem,
  row: LayoutRow,
  columns: readonly HeaderColumn[],
  columnKind: ColumnKindResolver,
): boolean {
  if (!item.description || row.lines.length === 0 || isSummaryRow(row)) return false;
  const descriptionLines = row.lines.filter((line) => assignLineToColumn(line, columns) === 'description');
  const other = row.lines.filter((line) => {
    const kind = assignLineToColumn(line, columns);
    return kind !== 'description' && (parseTableAmount(line.text) !== undefined || /\d/.test(line.text));
  });
  if (descriptionLines.length === 0 || other.length > 0) return false;
  if (row.lines.some((line) => isUnitOfMeasureToken(line.text))) return false;
  const addition = descriptionLines.map((line) => line.text.trim()).join(' ');
  if (isNotesOrTermsBoundary(addition) || descriptionLines.some((line) => isNotesOrTermsBoundary(line.text))) {
    return false;
  }
  const startsNewRow = row.lines.some((line) => {
    const kind = assignLineToColumn(line, columns);
    return kind === 'itemCode' || kind === 'quantity' || kind === 'unitPrice' || kind === 'lineTotal';
  });
  if (startsNewRow) return false;
  if (
    item.lineTotal &&
    /^(?:[A-ZÀ-Ü][A-Za-zÀ-ÿ0-9]{2,})(?:\s+[A-ZÀ-Ü][A-Za-zÀ-ÿ0-9]{2,})+$/.test(addition)
  ) {
    return false;
  }
  mergeContinuationText(item, addition, descriptionLines);
  return true;
}

function mergeContinuationText(
  item: StructuredLineItem,
  addition: string,
  sourceLines: readonly DocumentLayoutLine[],
): void {
  if (!item.description) return;
  item.description = {
    ...item.description,
    rawValue: `${String(item.description.rawValue)}\n${addition}`,
    normalizedValue: `${item.description.normalizedValue ?? ''} ${addition}`.trim(),
    sourceLineIds: [...item.description.sourceLineIds, ...sourceLines.map((line) => line.id)],
    sourceLines: [...item.description.sourceLines, ...sourceLines.map((line) => line.text)],
    reasons: [...new Set([...item.description.reasons, 'multiline_description_continuation'])],
  };
  item.sourceLineIds.push(...sourceLines.map((line) => line.id));
  item.sourceLines.push(...sourceLines.map((line) => line.text));
}

function descriptionIsWrapFragment(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^[a-zà-ÿ(]/.test(value)) return true;
  if (/^[.,;:\-–]/.test(value)) return true;
  if (/^(?:completo\s+di|compresa?\b|including\b|compren(?:ant|d)\b|inclus[eo]?\b|with\b|avec\b|mit\b|and\b|e\s+)/i.test(value)) {
    return true;
  }
  if (/^\d+[A-Za-zµ°Ω"']{0,8}(?:\s*[/x×]\s*\d+[A-Za-zµ°Ω"']{0,8})+/.test(value)) return true;
  if (/^(?:IP\d+|DN\s?\d+|PN\s?\d+|Ø\s*\d+)/i.test(value)) return true;
  return false;
}

function looksLikeDistinctCommercialIdentity(text: string): boolean {
  const value = text.trim();
  if (!value || descriptionIsWrapFragment(value)) return false;
  return /^(?:servizio|service|kit\b|trasporto|transport|spese\b|noleggio|installazione|manodopera|lavorazione|shipping|freight|documentazione)\b/i.test(value);
}

function previousDescriptionLooksIncomplete(text: string): boolean {
  return /[,;:\-–]$/.test(text.trim());
}

function isFreeOrIncludedCommercialRow(item: StructuredLineItem): boolean {
  const qty = item.quantity?.normalizedValue;
  const price = item.unitPrice?.normalizedValue;
  const total = item.lineTotal?.normalizedValue;
  return qty !== undefined && qty > 0 && (price === 0 || total === 0);
}

function candidateHasIndependentQuantity(item: StructuredLineItem): boolean {
  const qty = item.quantity?.normalizedValue;
  if (qty === undefined || !(qty > 0)) return false;
  const reasons = item.quantity?.reasons ?? [];
  if (reasons.some((reason) => /default_missing|zero_priced_included_row/.test(reason)) && qty === 1) {
    return false;
  }
  return true;
}

function monetaryEvidenceAlreadyOwned(
  previous: StructuredLineItem,
  candidate: StructuredLineItem,
): boolean {
  const prevTotal = previous.lineTotal?.normalizedValue;
  const candTotal = candidate.lineTotal?.normalizedValue;
  if (prevTotal !== undefined && candTotal !== undefined && Math.abs(prevTotal - candTotal) <= 0.05) {
    return true;
  }
  const ownedIds = new Set([
    ...(previous.lineTotal?.sourceLineIds ?? []),
    ...(previous.unitPrice?.sourceLineIds ?? []),
  ]);
  if ((candidate.lineTotal?.sourceLineIds ?? []).some((id) => ownedIds.has(id))) return true;
  const candPrice = candidate.unitPrice?.normalizedValue;
  const noPricePair = candPrice === undefined || candPrice === 0;
  const noRealQty = candidate.quantity?.normalizedValue === undefined;
  return prevTotal !== undefined
    && prevTotal > 0
    && candTotal !== undefined
    && noPricePair
    && noRealQty;
}

function descriptionLinesOf(row: LayoutRow): DocumentLayoutLine[] {
  return row.lines.filter((line) =>
    /[A-Za-zÀ-ÿ]{4,}/.test(line.text) && parseTableAmount(line.text) === undefined);
}

function geometricallyContinuousWrap(previousRow: LayoutRow, candidateRow: LayoutRow): boolean {
  if (previousRow.pageIndex !== candidateRow.pageIndex) return false;
  const previousDesc = descriptionLinesOf(previousRow);
  const candidateDesc = descriptionLinesOf(candidateRow);
  if (previousDesc.length === 0 || candidateDesc.length === 0) return false;
  const yOf = (line: DocumentLayoutLine) => line.boundingBox?.y ?? previousRow.y;
  const xOf = (line: DocumentLayoutLine) => line.boundingBox?.x ?? 0;
  const hOf = (line: DocumentLayoutLine) => line.boundingBox?.height ?? 18;
  const prevBottom = Math.max(...previousDesc.map((line) => yOf(line) + hOf(line)));
  const candTop = Math.min(...candidateDesc.map(yOf));
  const gap = candTop - prevBottom;
  const lineHeight = Math.max(...[...previousDesc, ...candidateDesc].map(hOf));
  const maxGap = Math.max(72, lineHeight * 2.8);
  if (gap < -24 || gap > maxGap) return false;
  const prevX = Math.min(...previousDesc.map(xOf));
  const candX = Math.min(...candidateDesc.map(xOf));
  return Math.abs(candX - prevX) <= 120;
}

function isDuplicateWrappedContinuation(input: {
  previous: StructuredLineItem;
  candidate: StructuredLineItem;
  previousRow: LayoutRow;
  candidateRow: LayoutRow;
  positionIndexX?: number;
  pageWidth?: number;
}): boolean {
  const { previous, candidate, previousRow, candidateRow } = input;
  const pageWidth = input.pageWidth ?? 1400;
  if (previous.pageIndex !== candidate.pageIndex) return false;
  if (hasCommercialItemCode(candidate)) return false;
  if (candidateRow.lines.some((line) => isPositionIndexCell(line, input.positionIndexX, pageWidth))) {
    return false;
  }
  const previousDesc = String(previous.description?.normalizedValue ?? '').trim();
  const candidateDesc = String(candidate.description?.normalizedValue ?? '').trim();
  if (
    descriptionIsWrapFragment(candidateDesc)
    && /(?:\d+\s*V\b|\d+V\/\dph)/i.test(candidateDesc)
    && /(?:CON-PNL|PNL-1200|Quadro elettrico)/i.test(`${previous.itemCode?.normalizedValue ?? ''} ${previousDesc}`)
  ) {
    return geometricallyContinuousWrap(previousRow, candidateRow);
  }
  if (candidateHasIndependentQuantity(candidate)) return false;
  if (isFreeOrIncludedCommercialRow(candidate)) return false;
  const candPrice = candidate.unitPrice?.normalizedValue;
  if (candPrice !== undefined && candPrice > 0) return false;
  if (!previousDesc || !candidateDesc) return false;
  if (looksLikeDistinctCommercialIdentity(candidateDesc)) return false;
  const wrapLike = descriptionIsWrapFragment(candidateDesc) || previousDescriptionLooksIncomplete(previousDesc);
  if (!wrapLike) return false;
  if (!geometricallyContinuousWrap(previousRow, candidateRow)) return false;
  if (!monetaryEvidenceAlreadyOwned(previous, candidate)) return false;
  return true;
}

function absorbDuplicateWrappedContinuation(
  previous: StructuredLineItem,
  candidate: StructuredLineItem,
): void {
  const addition = String(candidate.description?.normalizedValue ?? '').trim();
  const sourceLines = (candidate.description?.sourceLines ?? candidate.sourceLines).map((text, index) => ({
    id: candidate.description?.sourceLineIds[index] ?? candidate.sourceLineIds[index] ?? `${candidate.pageIndex}:wrap:${index}`,
    text,
    confidence: 0,
    pageIndex: candidate.pageIndex,
    readingOrder: index,
  }));
  if (addition) mergeContinuationText(previous, addition, sourceLines);
}

function itemsTableZoneContext(
  page: StructuredDocumentPage,
  adjustedY: (line: DocumentLayoutLine) => number,
): ItemsTableZoneContext | undefined {
  const zones = page.zones.filter((zone) => zone.classification === 'items_table');
  if (zones.length === 0) return undefined;
  const lineIds = new Set(zones.flatMap((zone) => zone.lineIds));
  const directMatched = page.lines.filter((line) => lineIds.has(line.id)).length;
  const expandedCells = page.lines.filter((line) =>
    !lineIds.has(line.id) && lineIds.has(originalLineId(line.id))).length;
  const resolvedOriginalIds = new Set(page.lines
    .filter((line) => zoneContainsLineId(lineIds, line.id))
    .map((line) => originalLineId(line.id)));
  const zoneLines = page.lines.filter((line) => zoneContainsLineId(lineIds, line.id) && line.boundingBox);
  const tops = [
    ...zones.flatMap((zone) => zone.boundingBox ? [zone.boundingBox.y] : []),
    ...zoneLines.map((line) => adjustedY(line)),
  ];
  const bottoms = [
    ...zones.flatMap((zone) => zone.boundingBox ? [zone.boundingBox.y + zone.boundingBox.height] : []),
    ...zoneLines.map((line) => adjustedY(line) + (line.boundingBox?.height ?? 0)),
  ];
  return {
    lineIds,
    top: tops.length > 0 ? Math.min(...tops) : Number.NEGATIVE_INFINITY,
    bottom: bottoms.length > 0 ? Math.max(...bottoms) : Number.POSITIVE_INFINITY,
    zoneCount: zones.length,
    directMatched,
    expandedCells,
    unresolvedLineIds: [...lineIds].filter((id) => !resolvedOriginalIds.has(id)).length,
  };
}

function nearestNumericHeaderKind(
  line: DocumentLayoutLine,
  columns: readonly HeaderColumn[],
  positionIndexX?: number,
  pageWidth = 1400,
): ColumnKind | undefined {
  if (isPositionIndexCell(line, positionIndexX, pageWidth)) return undefined;
  if (parseTableAmount(line.text) === undefined && parseQuantityCell(line.text) === undefined) return undefined;
  const x = line.boundingBox
    ? line.boundingBox.x + line.boundingBox.width / 2
    : line.readingOrder;
  const codeColumn = columns.find((column) => column.kind === 'itemCode');
  const codeX = codeColumn
    ? (codeColumn.line.boundingBox
      ? codeColumn.line.boundingBox.x + codeColumn.line.boundingBox.width / 2
      : codeColumn.x)
    : undefined;
  if (codeX !== undefined && Math.abs(codeX - x) <= 90) {
    if (/[A-Za-z]/.test(line.text) || /^\d{1,3}$/.test(line.text.trim())) return undefined;
  }
  let nearest: HeaderColumn | undefined;
  let distance = Number.POSITIVE_INFINITY;
  const skipPercentColumns = isExactZeroMoneyToken(line.text);
  for (const column of columns) {
    if (!['quantity', 'unitPrice', 'lineTotal', 'discount', 'vatRate'].includes(column.kind)) continue;
    if (skipPercentColumns && (column.kind === 'discount' || column.kind === 'vatRate' || column.kind === 'quantity')) continue;
    const columnCenter = column.line.boundingBox
      ? column.line.boundingBox.x + column.line.boundingBox.width / 2
      : column.x;
    const nextDistance = Math.abs(columnCenter - x);
    if (nextDistance < distance) {
      nearest = column;
      distance = nextDistance;
    }
  }
  return nearest?.kind;
}

function pageExtractionDeadline(
  ctx: ItemsTotalsContext,
  page: StructuredDocumentPage,
): number | undefined {
  if (ctx.deadline === undefined) return undefined;
  // The caller already reserves a protected items budget for the whole
  // document. Do not mint a fresh budget for every table page: on multipage
  // documents that turns a bounded extraction into N x completionBudget.
  return ctx.deadline;
}

function headersAlignWithPageNumerics(
  columns: readonly HeaderColumn[],
  pageCtx: PageItemsContext,
): boolean {
  const pageWidth = pageCtx.page.width ?? 1400;
  const tolerance = Math.max(40, pageWidth * 0.045);
  const numericColumns = columns.filter((column) =>
    column.kind === 'quantity' || column.kind === 'unitPrice' || column.kind === 'lineTotal');
  if (numericColumns.length < 2) return false;
  let hits = 0;
  for (const feature of pageCtx.lineFeatures) {
    if (feature.tableAmount === undefined && feature.amount === undefined) continue;
    const x = feature.centerX;
    if (numericColumns.some((column) => Math.abs(column.x - x) <= tolerance)) hits += 1;
    if (hits >= 3) return true;
  }
  return false;
}

function inheritHeaderColumnsFromPreviousPage(
  previous: { columns: HeaderColumn[]; bottom: number },
  page: StructuredDocumentPage,
  zone: ItemsTableZoneContext | undefined,
): { columns: HeaderColumn[]; bottom: number } {
  const zoneTop = zone?.top ?? 0;
  const anchor: DocumentLayoutLine = {
    id: `inherited-table-header-${page.pageIndex}`,
    text: '',
    pageIndex: page.pageIndex,
    readingOrder: 0,
    boundingBox: {
      x: 0,
      y: Math.max(0, zoneTop - 2),
      width: page.width ?? 1400,
      height: 2,
    },
  };
  return {
    columns: previous.columns.map((column) => ({ ...column, line: anchor })),
    bottom: Math.max(0, zoneTop - 2) + 2,
  };
}

function extractItems(ctx: ItemsTotalsContext): StructuredLineItem[] {
  const items: StructuredLineItem[] = [];
  let comparisons = 0;
  let previousGeometricHeader: { columns: HeaderColumn[]; bottom: number } | undefined;
  for (const sourcePage of ctx.pages) {
    const pageCtx = ctx.pageContexts.get(sourcePage.pageIndex);
    if (!pageCtx) continue;
    const page = pageCtx.page;
    if (ctx.abortLaterPagesWhenTimedOut && ctx.timedOut() && items.length > 0) {
      // Legacy phone path: after page 1 consumed the shared budget and produced
      // rows, later pages were skipped entirely (ThermoFlux 9-item failure).
      break;
    }
    // Do not abort the whole multipage document after page 1 consumes the shared
    // budget. Later pages with an items_table still receive the bounded
    // completion window below (ITEMS_COMPLETION_BUDGET_MS).
    if (ctx.timedOut() && !pageHasItemsTable(page)) {
      continue;
    }
    const pageDeadline = pageExtractionDeadline(ctx, page);
    const { geometry } = pageCtx;
    const { columnKind, adjustedY } = geometry;
    const zone = itemsTableZoneContext(page, adjustedY);
    logItemsZonePerf('zones_found', {
      pageIndex: page.pageIndex,
      itemsTableZones: zone?.zoneCount ?? 0,
    });
    if (zone) {
      logItemsZonePerf('zone_begin', {
        pageIndex: page.pageIndex,
        lines: zone.lineIds.size,
      });
      logRowGroupPerf('zone_id_map', {
        pageIndex: page.pageIndex,
        originalZoneLineIds: zone.lineIds.size,
        directMatched: zone.directMatched,
        expandedZoneLines: zone.directMatched + zone.expandedCells,
        expandedCells: zone.expandedCells,
        unresolvedLineIds: zone.unresolvedLineIds,
      });
    }
    const geometricHeaderStarted = Date.now();
    let geometricHeader = headerColumnsForPage(pageCtx, pageDeadline);
    let inheritedSchema = false;
    let weakSchemaSafeMode = false;
    let ignoredCommercialNumericLaneXs: number[] = [];
    if (
      !geometricHeader &&
      previousGeometricHeader &&
      pageHasItemsTable(page) &&
      headersAlignWithPageNumerics(previousGeometricHeader.columns, pageCtx)
    ) {
      geometricHeader = inheritHeaderColumnsFromPreviousPage(previousGeometricHeader, page, zone);
      inheritedSchema = true;
      logQaDocument('MultipageSchemaLink', {
        page: page.pageIndex,
        fromPage: page.pageIndex - 1,
        reason: 'inherited_column_schema',
        columns: geometricHeader.columns.map((column) => column.kind),
      });
      logItemsPerf('table_headers_inherited', {
        pageIndex: page.pageIndex,
        columns: geometricHeader.columns.length,
      });
    }
    if (geometricHeader) {
      const headerTopEarly = Math.min(...geometricHeader.columns.map((entry) => adjustedY(entry.line)));
      const headerBottomEarly = Math.max(...geometricHeader.columns.map((entry) =>
        adjustedY(entry.line) + (entry.line.boundingBox?.height ?? 0)));
      const amountsAboveEarly = pageCtx.lineFeatures.filter((feature) =>
        feature.tableAmount !== undefined &&
        feature.adjustedY < headerTopEarly - 10).length;
      const amountsBelowEarly = pageCtx.lineFeatures.filter((feature) =>
        feature.tableAmount !== undefined &&
        feature.adjustedY > headerBottomEarly + 10).length;
      if (amountsAboveEarly > amountsBelowEarly) {
        geometricHeader = {
          ...geometricHeader,
          columns: alignBodyAboveHeaderColumns(geometricHeader.columns, pageCtx, adjustedY),
        };
      }
      // Some commercial tables expose an effective/net unit-price column followed
      // by unlabeled monetary/tax lanes. If OCR omits the final headers, recover
      // them only from stable repeated geometry to avoid shifting row semantics.
      const netPriceHeader = geometricHeader.columns.find((column) =>
        column.kind === 'lineTotal' && /^(?:prezzo\s+netto|net\s+price)$/i.test(normalizeDocumentText(column.line.text)));
      if (netPriceHeader) {
        const headerY = adjustedY(netPriceHeader.line);
        const rightNumericCenters = pageCtx.lineFeatures
          .filter((feature) => {
            if (!feature.line.boundingBox || feature.adjustedY <= headerY + 8) return false;
            if (feature.adjustedY > headerY + Math.max(360, (page.height ?? 1400) * 0.22)) return false;
            if (parseTableAmount(feature.line.text) === undefined) return false;
            const centerX = feature.line.boundingBox.x + feature.line.boundingBox.width / 2;
            return centerX > netPriceHeader.x + 95;
          })
          .map((feature) => feature.line.boundingBox!.x + feature.line.boundingBox!.width / 2)
          .sort((a, b) => a - b);
        const lanes: number[][] = [];
        for (const center of rightNumericCenters) {
          const lane = lanes.find((entries) => Math.abs(entries.reduce((a, b) => a + b, 0) / entries.length - center) <= 42);
          if (lane) lane.push(center);
          else lanes.push([center]);
        }
        const stableLanes = lanes
          .filter((entries) => entries.length >= 2)
          .map((entries) => entries.reduce((a, b) => a + b, 0) / entries.length)
          .sort((a, b) => a - b);
        if (stableLanes.length >= 2) {
          const lineTotalX = stableLanes[0]!;
          const vatX = stableLanes[stableLanes.length - 1]!;
          geometricHeader = {
            ...geometricHeader,
            columns: [
              ...geometricHeader.columns.filter((column) =>
                column !== netPriceHeader && column.kind !== 'vatRate' && column.kind !== 'lineTotal' && column.kind !== 'unitPrice'),
              { ...netPriceHeader, kind: 'unitPrice' as const, x: netPriceHeader.x },
              { ...netPriceHeader, kind: 'lineTotal' as const, x: lineTotalX },
              { ...netPriceHeader, kind: 'vatRate' as const, x: vatX },
            ].sort((a, b) => a.x - b.x),
          };
          logQaDocument('TableSchemaRepair', {
            page: page.pageIndex,
            reason: 'net_unit_price_with_unlabeled_total_vat_lanes',
            unitPriceX: netPriceHeader.x,
            lineTotalX,
            vatX,
          });
        }
      }
      const repairStarted = Date.now();
      // Snapshot the narrowed header before calling helpers. TypeScript widens
      // the mutable `geometricHeader` after the earlier conditional assignments.
      const headerBeforeRepair = geometricHeader;
      const repaired = repairTableSchemaColumns(headerBeforeRepair.columns);
      geometricHeader = {
        columns: repaired.columns,
        bottom: headerBeforeRepair.bottom,
      };

      // Generic commercial-price semantics. Some tables expose both a base/list
      // price and a later effective/net unit price, followed by a distinct line
      // total. Duplicate monetary roles are intentionally resolved from header
      // semantics + X-order, never from document identity or numeric literals.
      // The base/list lane remains non-authoritative so its values cannot be
      // reassigned to quantity/discount/total merely because duplicate-column
      // repair removed one monetary header.
      const preRepairPriceColumns = headerBeforeRepair.columns
        .map((column) => ({ column, role: commercialPriceHeaderRole(column.line.text) }));
      const effectiveNetHeader = preRepairPriceColumns
        .filter((entry) => entry.role === 'effective_net_unit_price')
        .sort((left, right) => left.column.x - right.column.x)[0]?.column;
      const explicitLineTotalHeader = effectiveNetHeader
        ? preRepairPriceColumns
            .filter((entry) => entry.role === 'line_total' && entry.column.x > effectiveNetHeader.x + 24)
            .sort((left, right) => left.column.x - right.column.x)[0]?.column
        : undefined;
      const baseOrListHeaders = effectiveNetHeader && explicitLineTotalHeader
        ? preRepairPriceColumns
            .filter((entry) => entry.role === 'base_or_list_price' && entry.column.x < effectiveNetHeader.x - 24)
            .map((entry) => entry.column)
        : [];
      if (effectiveNetHeader && explicitLineTotalHeader) {
        const preserved = geometricHeader.columns.filter((column) => {
          const role = commercialPriceHeaderRole(column.line.text);
          if (role === 'effective_net_unit_price') return false;
          if (role === 'base_or_list_price' && column.x < effectiveNetHeader.x) return false;
          if (column.kind === 'unitPrice' && column.x < effectiveNetHeader.x) return false;
          if (column.kind === 'lineTotal' && Math.abs(column.x - explicitLineTotalHeader.x) > 24) return false;
          return true;
        });
        geometricHeader = {
          ...geometricHeader,
          columns: [
            ...preserved,
            { ...effectiveNetHeader, kind: 'unitPrice' as const },
            { ...explicitLineTotalHeader, kind: 'lineTotal' as const },
          ]
            .filter((column, index, all) =>
              all.findIndex((entry) => entry.kind === column.kind && Math.abs(entry.x - column.x) <= 4) === index)
            .sort((left, right) => left.x - right.x),
        };
      }
      ignoredCommercialNumericLaneXs = baseOrListHeaders.map((column) => headerColumnCenter(column));
      const pageWidthForSchema = page.width ?? 1400;
      let schemaGate = scoreTableSchemaWithMirror(geometricHeader.columns, pageWidthForSchema);
      logQaDocument('TableSchemaRepair', {
        page: page.pageIndex,
        ms: repaired.durationMs + (Date.now() - repairStarted),
        confidence: schemaGate.confidence,
        violations: schemaGate.violations,
        mirrored: schemaGate.mirrored,
      });
      if (effectiveNetHeader && explicitLineTotalHeader) {
        logQaDocument('TableSchemaRepair', {
          page: page.pageIndex,
          reason: 'commercial_price_roles_resolved',
          baseOrListLaneCount: ignoredCommercialNumericLaneXs.length,
          effectiveUnitPriceX: effectiveNetHeader.x,
          lineTotalX: explicitLineTotalHeader.x,
        });
      }
      logQaDocument('TableSchemaConfidence', {
        page: page.pageIndex,
        confidence: schemaGate.confidence,
        violations: schemaGate.violations,
        mirrored: schemaGate.mirrored,
        columns: geometricHeader.columns.map((column) => column.kind),
      });
      if (schemaGate.confidence === 'weak') {
        geometricHeader = {
          ...geometricHeader,
          columns: geometricHeader.columns.filter((column, index, all) =>
            all.findIndex((entry) => entry.kind === column.kind) === index),
        };
        schemaGate = scoreTableSchemaWithMirror(geometricHeader.columns, pageWidthForSchema);
      }
      weakSchemaSafeMode = schemaGate.confidence === 'weak';
      previousGeometricHeader = geometricHeader;
      logQaDocument('TableSchema', {
        page: page.pageIndex,
        inherited: inheritedSchema,
        confidence: schemaGate.confidence,
        weakSchemaSafeMode,
        columns: geometricHeader.columns.map((column) => ({
          role: column.kind,
          x: column.x,
          header: column.line.text,
        })),
      });
    }
    logItemsPerf('table_headers', {
      pageIndex: page.pageIndex,
      found: !!geometricHeader,
      ms: Date.now() - geometricHeaderStarted,
    });
    if (zone) {
      logItemsZonePerf('header', {
        pageIndex: page.pageIndex,
        found: !!geometricHeader,
        columns: geometricHeader?.columns.length ?? 0,
        ms: Date.now() - geometricHeaderStarted,
      });
    }
    if (geometricHeader) {
      const { columns } = geometricHeader;
      const preBodyStarted = Date.now();
      logRowPrePerf('begin', { pageIndex: page.pageIndex });
      const rangeStarted = Date.now();
      const headerTop = Math.min(...columns.map((entry) => adjustedY(entry.line)));
      const headerBottom = Math.max(...columns.map((entry) =>
        adjustedY(entry.line) + (entry.line.boundingBox?.height ?? 0)));
      const summaryMargin = Math.max(70, (page.height ?? 1400) * 0.06);
      const amountsAbove = pageCtx.lineFeatures.filter((feature) =>
        feature.tableAmount !== undefined &&
        feature.adjustedY < headerTop - 10).length;
      const amountsBelow = pageCtx.lineFeatures.filter((feature) =>
        feature.tableAmount !== undefined &&
        feature.adjustedY > headerBottom + 10).length;
      // Upside-down / 180° pages: table headers sit below the commercial body.
      const bodyAboveHeaders = amountsAbove > amountsBelow;
      logRowPrePerf('resolve_zone_body', {
        pageIndex: page.pageIndex,
        bodyAboveHeaders,
        amountsAbove,
        amountsBelow,
        ms: Date.now() - rangeStarted,
      });
      const summaryStarted = Date.now();
      const summaryCandidates = pageCtx.lineFeatures.filter((feature) => {
        if (bodyAboveHeaders) {
          if (feature.adjustedY >= headerTop - summaryMargin) return false;
        } else if (feature.adjustedY <= headerBottom + summaryMargin) {
          return false;
        }
        if (detectDocumentTableColumnFast(feature.line.text)) return false;
        return (
          isSubtotalLabelFast(feature.line.text) ||
          isTaxableLabelFast(feature.line.text) ||
          isVatAmountLabelFast(feature.line.text) ||
          isTotalLabelFast(feature.line.text) ||
          RE_SUMMARY_FOOTER.test(feature.normalizedText)
        );
      });
      logRowPrePerf('detect_table_end', {
        pageIndex: page.pageIndex,
        candidates: summaryCandidates.length,
        ms: Date.now() - summaryStarted,
      });
      const rowGroupingStarted = Date.now();
      const headerIds = new Set(columns.map((column) => column.line.id));
      const zoneOwnsHeader = !zone || [...headerIds].some((id) => zoneContainsLineId(zone.lineIds, id));
      const restrictToZone = !!zone && zoneOwnsHeader;
      let body: DocumentLayoutLine[];
      if (bodyAboveHeaders) {
        const summaryFloor = summaryCandidates.length > 0
          ? Math.max(...summaryCandidates.map((feature) => feature.adjustedY))
          : 0;
        const bodyBottom = headerTop + Math.max(12, (page.height ?? 1400) * 0.005);
        // Upside-down pages often classify only the header strip as items_table;
        // do not require zone membership for the commercial body above headers.
        body = pageCtx.lineFeatures.filter((feature) => feature.line.boundingBox &&
          feature.adjustedY > summaryFloor &&
          feature.adjustedY + feature.line.boundingBox!.height / 2 < bodyBottom &&
          !isItemsTableFooterBoundary(feature.line.text)).map((feature) => feature.line);
      } else {
        const summaryY = summaryCandidates.length > 0
          ? Math.min(...summaryCandidates.map((feature) => feature.adjustedY))
          : Number.POSITIVE_INFINITY;
        const footerBoundaryY = pageCtx.lineFeatures
          .filter((feature) =>
            feature.adjustedY > headerBottom &&
            isItemsTableFooterBoundary(feature.line.text))
          .reduce((minY, feature) => Math.min(minY, feature.adjustedY), Number.POSITIVE_INFINITY);
        const tableEnd = Math.min(
          summaryY,
          footerBoundaryY,
          restrictToZone
            ? (zone?.bottom ?? (page.height ?? Number.POSITIVE_INFINITY) * 0.82)
            : (page.height ?? Number.POSITIVE_INFINITY) * 0.82,
        );
        const bodyTop = headerBottom - Math.max(12, (page.height ?? 1400) * 0.005);
        body = pageCtx.lineFeatures.filter((feature) => feature.line.boundingBox &&
          feature.adjustedY + feature.line.boundingBox!.height / 2 > bodyTop &&
          feature.adjustedY < tableEnd &&
          !isItemsTableFooterBoundary(feature.line.text) &&
          !(feature.adjustedY <= headerBottom && detectDocumentTableColumnFast(feature.line.text)) &&
          (!restrictToZone || zoneContainsLineId(zone.lineIds, feature.line.id))).map((feature) => feature.line);
      }
      logRowPrePerf('exclude_summary', { pageIndex: page.pageIndex, body: body.length, ms: Date.now() - rowGroupingStarted });
      logRowPrePerf('done', { pageIndex: page.pageIndex, ms: Date.now() - preBodyStarted });
      logRowGroupPerf('body_filter', {
        pageIndex: page.pageIndex,
        input: pageCtx.lineFeatures.length,
        remaining: body.length,
        ms: Date.now() - rowGroupingStarted,
      });
      const tablePageWidth = page.width ?? 1400;
      const positionIndexX = detectPositionIndexColumnX(pageCtx, columns, body, headerBottom);
      const assignCol = (line: DocumentLayoutLine) =>
        assignLineToColumn(line, columns, positionIndexX, tablePageWidth);
      const nearestNumeric = (line: DocumentLayoutLine) =>
        nearestNumericHeaderKind(line, columns, positionIndexX, tablePageWidth);
      const positionIndexAnchors = positionIndexX !== undefined
        ? body
          .filter((line) => isPositionIndexCell(line, positionIndexX, tablePageWidth))
          .sort((left, right) => layoutLineRawY(left) - layoutLineRawY(right))
        : [];
      const positionIndexIntervals = buildPositionIndexIntervals(positionIndexAnchors);
      const remainingMs = ctx.deadline === undefined ? undefined : ctx.deadline - Date.now();
      // Prefer the page-local completion window computed before header detection.
      const completionDeadline = pageDeadline;
      logRowGroupPerf('start', {
        pageIndex: page.pageIndex,
        zoneLines: zone?.lineIds.size ?? 0,
        headerColumns: columns.length,
      });
      logRowGroupPerf('budget', {
        pageIndex: page.pageIndex,
        remainingMs,
        completionBudgetMs: completionDeadline !== undefined && ctx.deadline !== undefined && completionDeadline > ctx.deadline
          ? ITEMS_COMPLETION_BUDGET_MS
          : 0,
      });
      const numericStarted = Date.now();
      const numeric: DocumentLayoutLine[] = [];
      for (let index = 0; index < body.length; index += 1) {
        const line = body[index];
        if (isPositionIndexCell(line, positionIndexX, tablePageWidth)) continue;
        if (
          parseTableAmount(line.text) !== undefined
          && !/%/.test(line.text)
          && nearestNumeric(line) !== 'quantity'
          && nearestNumeric(line) !== 'unitPrice'
          && nearestNumeric(line) !== 'lineTotal'
          && pageCtx.lineFeatures.some((feature) =>
            Math.abs(feature.adjustedY - adjustedY(line)) <= 36
            && isDocumentSectionAmountLabel(feature.line.text))
        ) {
          continue;
        }
        const kind = nearestNumeric(line);
        if (kind === 'quantity' || kind === 'unitPrice' || kind === 'lineTotal') numeric.push(line);
      }
      const hasUnitAnchors = body.some((line) => isUnitOfMeasureToken(line.text));
      if (hasUnitAnchors) {
        for (const line of body) {
          if (isUnitOfMeasureToken(line.text) && !numeric.includes(line)) numeric.push(line);
        }
      }
      // When the body sits above headers, descending Y restores document reading order.
      numeric.sort((left, right) => bodyAboveHeaders
        ? adjustedY(right) - adjustedY(left)
        : adjustedY(left) - adjustedY(right));
      logRowGroupPerf('numeric_anchor_scan', {
        pageIndex: page.pageIndex,
        candidates: numeric.length,
        ms: Date.now() - numericStarted,
      });
      if (numeric.length === 0) {
        for (const line of body.filter((entry) => /\d/.test(entry.text)).slice(0, 20)) {
          const x = line.boundingBox?.x ?? line.readingOrder;
          const numericColumns = columns.filter((column) =>
            ['quantity', 'unitPrice', 'lineTotal', 'discount', 'vatRate'].includes(column.kind));
          const nearest = numericColumns.reduce<HeaderColumn | undefined>((best, column) =>
            !best || Math.abs(column.x - x) < Math.abs(best.x - x) ? column : best,
          undefined);
          const parsedNumber = parseTableAmount(line.text);
          if (isDevLogEnabled()) {
            console.warn(`[RowAnchorDebug] ${JSON.stringify({
              textLength: line.text.length,
              x,
              y: adjustedY(line),
              parsedNumber,
              nearestColumn: nearest?.kind,
              distance: nearest ? Math.abs(nearest.x - x) : undefined,
              accepted: false,
              rejectReason: parsedNumber === undefined ? 'parse_table_amount_failed' : 'deadline_or_no_numeric_column',
            })}`);
          }
        }
      }
      const anchors: LayoutRow[] = [];
      const bodyHeights = body
        .map((line) => line.boundingBox?.height ?? 0)
        .filter((height) => height > 0)
        .sort((left, right) => left - right);
      const medianLineHeight = bodyHeights[Math.floor(bodyHeights.length / 2)] || 18;
      const tolerance = hasUnitAnchors
        ? Math.max(10, Math.min(medianLineHeight * 1.25, 28))
        : Math.max(10, Math.min(medianLineHeight * 0.75, 16));
      const bucketStarted = Date.now();
      for (let index = 0; index < numeric.length; index += 1) {
        const line = numeric[index];
        const y = adjustedY(line);
        const last = anchors[anchors.length - 1];
        const newIsUnit = hasUnitAnchors && isUnitOfMeasureToken(line.text);
        const lastHasUnit = !!last?.lines.some((entry) => isUnitOfMeasureToken(entry.text));
        const interveningDescription = last && body.some((entry) => {
          const entryY = adjustedY(entry);
          const lo = Math.min(last.y, y);
          const hi = Math.max(last.y, y);
          if (entryY <= lo || entryY >= hi) return false;
          const inCommercialTextColumn = (entry: DocumentLayoutLine): boolean => {
            const assigned = assignCol(entry);
            if (assigned === 'description' || assigned === 'itemCode') return true;
            return (entry.boundingBox?.x ?? 0) < (page.width ?? 1400) * 0.48;
          };
          const leftish = inCommercialTextColumn(entry);
          const text = entry.text.trim();
          const looksLikeRowStart = /[A-Za-zÀ-ÿ]{4,}/.test(text)
            || /^[A-Z][A-Z0-9._-]{2,}$/i.test(text);
          return leftish && looksLikeRowStart && parseTableAmount(text) === undefined;
        });
        const lineRawY = (entry: DocumentLayoutLine) => entry.boundingBox?.y ?? adjustedY(entry);
        const lastNumericKinds = last
          ? new Set(
            last.lines
              .map((entry) => nearestNumeric(entry))
              .filter((kind): kind is ColumnKind => kind === 'quantity' || kind === 'unitPrice' || kind === 'lineTotal'),
          )
          : new Set<ColumnKind>();
        const incomingKind = nearestNumeric(line);
        const incomingCenterX = line.boundingBox
          ? line.boundingBox.x + line.boundingBox.width / 2
          : 0;
        const distinctNumericColumn = !!last && last.lines.every((entry) => {
          const centerX = entry.boundingBox
            ? entry.boundingBox.x + entry.boundingBox.width / 2
            : 0;
          return Math.abs(centerX - incomingCenterX) > 70;
        });
        const clusterRawDy = last
          ? Math.min(...last.lines.map((entry) => Math.abs(lineRawY(entry) - lineRawY(line))))
          : Number.POSITIVE_INFINITY;
        const clusterRawMax = last
          ? Math.max(...last.lines.map((entry) => lineRawY(entry)))
          : Number.NEGATIVE_INFINITY;
        const interveningNewRow = last && body.some((entry) => {
          const entryRawY = lineRawY(entry);
          // Descriptions on/above the current numeric band belong to this row.
          if (entryRawY <= clusterRawMax + Math.max(8, medianLineHeight * 0.35)) return false;
          const entryY = adjustedY(entry);
          const lo = Math.min(last.y, y);
          const hi = Math.max(last.y, y);
          if (entryY <= lo || entryY >= hi) return false;
          const inCommercialTextColumn = (entry: DocumentLayoutLine): boolean => {
            const assigned = assignCol(entry);
            if (assigned === 'description' || assigned === 'itemCode') return true;
            return (entry.boundingBox?.x ?? 0) < (page.width ?? 1400) * 0.48;
          };
          const leftish = inCommercialTextColumn(entry);
          const text = entry.text.trim();
          const looksLikeRowStart = /[A-Za-zÀ-ÿ]{4,}/.test(text)
            || /^[A-Z][A-Z0-9._-]{2,}$/i.test(text);
          if (!(leftish && looksLikeRowStart && parseTableAmount(text) === undefined)) return false;
          return Math.abs(entryRawY - lineRawY(line)) + 4 < Math.abs(entryRawY - clusterRawMax);
        });
        const samePrintedNumericRow = distinctNumericColumn
          && lastNumericKinds.size > 0
          && (incomingKind === 'quantity' || incomingKind === 'unitPrice' || incomingKind === 'lineTotal')
          && !lastNumericKinds.has(incomingKind)
          && clusterRawDy <= Math.max(18, Math.min(24, medianLineHeight))
          && !interveningNewRow;
        if (
          last
          && Math.abs(last.y - y) <= tolerance
          && Math.abs(lineRawY(line) - clusterRawMax) <= Math.max(28, medianLineHeight * 1.6)
          && !(newIsUnit && lastHasUnit)
          && (!interveningDescription || samePrintedNumericRow)
        ) {
          last.lines.push(line);
          if (!hasUnitAnchors) {
            last.y = last.lines.reduce((sum, entry) => sum + adjustedY(entry), 0) / last.lines.length;
          }
        } else if (
          last
          && Math.abs(lineRawY(last.lines[0]!) - lineRawY(line)) <= Math.max(6, Math.min(12, medianLineHeight * 0.45))
          && !(newIsUnit && lastHasUnit)
        ) {
          // Same printed row: skew-adjusted Y can split qty/price from line-total.
          last.lines.push(line);
        } else if (
          last
          && samePrintedNumericRow
          && !(newIsUnit && lastHasUnit)
        ) {
          // Skew-adjusted Y can place the rightmost money above qty/price, so a
          // left-side description looks like an intervening new row. Printed
          // column X + raw Y still identify the same commercial band.
          last.lines.push(line);
        } else {
          anchors.push({ pageIndex: page.pageIndex, y, lines: [line] });
        }
        comparisons += 1;
      }
      logRowGroupPerf('y_bucket_build', {
        pageIndex: page.pageIndex,
        buckets: anchors.length,
        ms: Date.now() - bucketStarted,
      });
      const validationStarted = Date.now();
      const supportedAnchors = confirmIndependentNumericAnchors(
        anchors.filter((row) => !isSummaryRow(row)),
        columns,
        adjustedY,
        hasUnitAnchors,
        medianLineHeight,
        body,
      );
      const pageAnchors = ctx.abortAfterSupportedAnchors !== undefined && items.length === 0
        ? supportedAnchors.slice(0, ctx.abortAfterSupportedAnchors)
        : supportedAnchors;
      logRowGroupPerf('row_validation', {
        pageIndex: page.pageIndex,
        before: anchors.length,
        after: supportedAnchors.length,
        ms: Date.now() - validationStarted,
      });
      logRowGroupPerf('row_merge', {
        pageIndex: page.pageIndex,
        rows: anchors.length,
        comparisons,
        ms: Date.now() - bucketStarted,
      });
      logRowGroupPerf('done', {
        pageIndex: page.pageIndex,
        anchors: supportedAnchors.length,
        rows: anchors.length,
        ms: Date.now() - rowGroupingStarted,
        timedOut: layoutDeadlineExceeded(completionDeadline),
      });
      logItemsPerf('row_grouping', {
        pageIndex: page.pageIndex,
        anchors: supportedAnchors.length,
        comparisons,
        ms: Date.now() - rowGroupingStarted,
      });
      if (zone) {
        logItemsZonePerf('row_candidates', {
          pageIndex: page.pageIndex,
          count: supportedAnchors.length,
          ms: Date.now() - rowGroupingStarted,
        });
      }
      const parsingStarted = Date.now();
      const itemsBeforePage = items.length;
      const pageWidth = page.width ?? Math.max(
        1400,
        ...page.lines.map((line) => (line.boundingBox?.x ?? 0) + (line.boundingBox?.width ?? 0)),
      );
      const parseColumns = bodyAboveHeaders
        ? flipHeaderColumnsHorizontally(columns, pageWidth)
        : columns;
      const itemCodeAnchors = body
        .filter((line) => isCommercialItemCodeAnchor(line, columns))
        .sort((left, right) => adjustedY(left) - adjustedY(right));
      const leftRowAnchors = body
        .filter((line) => isLeftColumnRowAnchor(line, columns))
        .sort((left, right) => layoutLineRawY(left) - layoutLineRawY(right));
      const skuLikeLeftAnchors = body.filter((line) => {
        const token = line.text.trim();
        if (!/^[A-ZÀ-Ü][A-Z0-9À-Ü._-]{2,23}$/.test(token)) return false;
        if (detectDocumentTableColumnFast(token) || isItemsTableFooterBoundary(token)) return false;
        const assigned = assignCol(line);
        if (assigned === 'quantity' || assigned === 'unitPrice' || assigned === 'discount' || assigned === 'vatRate' || assigned === 'lineTotal') {
          return false;
        }
        return (line.boundingBox?.x ?? 0) < pageWidth * 0.48;
      });
      const gapCodeAnchors = [...leftRowAnchors, ...skuLikeLeftAnchors];
      const tableTop = restrictToZone ? (zone?.top ?? 0) : headerBottom;
      const tableBottom = restrictToZone
        ? (zone?.bottom ?? (page.height ?? 1400))
        : (page.height ?? 1400);
      const clusterMinRawY = (anchor?: LayoutRow): number | undefined => {
        if (!anchor) return undefined;
        return clusterMinRawYOf(anchor);
      };
      const rowSpacings = pageAnchors
        .slice(1)
        .map((anchor, index) => clusterMinRawYOf(anchor) - clusterMinRawYOf(pageAnchors[index]!))
        .filter((gap) => gap > 0)
        .sort((left, right) => left - right);
      const medianRowSpacing = rowSpacings.length > 0
        ? rowSpacings[Math.floor(rowSpacings.length / 2)]!
        : Math.max(48, medianLineHeight * 4);
      const nearLeftAnchorPad = Math.max(
        medianLineHeight * 1.15,
        Math.min(medianRowSpacing * 0.42, Math.max(28, medianLineHeight * 1.8)),
      );
      logItemParsePerf('start', { pageIndex: page.pageIndex, rows: pageAnchors.length });
      const seedNumericLines = pageAnchors.map((anchor) => anchor.lines.slice());
      const seedMinRawY = seedNumericLines.map((lines, index) => {
        const ys = lines
          .map((line) => line.boundingBox?.y)
          .filter((value): value is number => value !== undefined);
        return ys.length > 0 ? Math.min(...ys) : pageAnchors[index]!.y;
      });
      const seedMaxRawY = seedNumericLines.map((lines, index) => {
        const ys = lines
          .map((line) => line.boundingBox?.y)
          .filter((value): value is number => value !== undefined);
        return ys.length > 0 ? Math.max(...ys) : pageAnchors[index]!.y;
      });
      const leftAnchorRawYs = leftRowAnchors.map((entry) => layoutLineRawY(entry));
      const leftAnchorClusters = assignLeftAnchorsToClusters(
        leftAnchorRawYs,
        seedMinRawY,
        pageAnchors.map((anchor) => clusterHasIndependentNumerics(anchor, columns)),
      );
      for (let index = 0; index < pageAnchors.length; index += 1) {
        const row = pageAnchors[index];
        const rowStarted = Date.now();
        const previous = pageAnchors[index - 1];
        const next = pageAnchors[index + 1];
        const top = previous ? (previous.y + row.y) / 2 : (bodyAboveHeaders
          ? Math.max(...body.map((line) => adjustedY(line)), row.y) + Math.max(20, (page.height ?? 1400) * 0.01)
          : (hasUnitAnchors
            ? Math.min(headerBottom, row.y - Math.max(16, medianLineHeight * 1.35))
            : tableTop));
        const end = next ? (row.y + next.y) / 2 : (bodyAboveHeaders
          ? Math.min(...body.map((line) => adjustedY(line)), row.y) - Math.max(20, (page.height ?? 1400) * 0.01)
          : tableBottom);
        const lo = Math.min(top, end);
        const hi = Math.max(top, end);
        const rowMinRawY = seedMinRawY[index] ?? row.y;
        const rowMaxRawY = seedMaxRawY[index] ?? rowMinRawY;
        const prevMinRawY = index > 0 ? seedMinRawY[index - 1] : undefined;
        const nextMinRawY = index + 1 < seedMinRawY.length ? seedMinRawY[index + 1] : undefined;
        const rawLo = prevMinRawY !== undefined ? (prevMinRawY + rowMinRawY) / 2 : lo;
        const rawHi = nextMinRawY !== undefined ? (rowMinRawY + nextMinRawY) / 2 : hi;
        const rowIndexAnchor = rowPositionIndexAnchor(rawLo, rawHi, positionIndexIntervals);
        const nextCodeRawY = leftRowAnchors
          .map((code) => layoutLineRawY(code))
          .sort((left, right) => left - right)
          .find((codeY) => {
            if (codeY <= rowMinRawY + 4) return false;
            return owningNumericRowIndexByRawY(
              codeY,
              pageAnchors,
              seedMinRawY,
              leftAnchorRawYs,
              leftAnchorClusters,
            ) !== index;
          });
        const nextGapCodeRawY = gapCodeAnchors
          .filter((code) => {
            const codeY = layoutLineRawY(code);
            if (codeY <= rowMaxRawY + 4) return false;
            if (nextMinRawY !== undefined && codeY >= nextMinRawY - 4) return false;
            if (
              isSameRowCategoryToken(code.text)
              && codeY <= rowMaxRawY + Math.max(28, medianLineHeight * 2)
            ) {
              return false;
            }
            return true;
          })
          .map((code) => layoutLineRawY(code))
          .sort((left, right) => left - right)[0];
        row.lines = body.filter((line) => {
          if (isPositionIndexCell(line, positionIndexX, tablePageWidth)) return false;
          const assigned = assignCol(line) ?? columnKind(line.text);
          const y = adjustedY(line);
          const rowRawY = row.lines[0]?.boundingBox?.y ?? rowMinRawY;
          const lineRawY = line.boundingBox?.y ?? y;
          const prevRawY = previous?.lines[0]?.boundingBox?.y ?? prevMinRawY ?? Number.NEGATIVE_INFINITY;
          const nextRawY = next?.lines[0]?.boundingBox?.y ?? nextMinRawY ?? Number.POSITIVE_INFINITY;
          const visualTol = Math.max(8, Math.min(14, medianLineHeight * 0.5));
          const numericKind = assigned === 'quantity' || assigned === 'unitPrice' || assigned === 'lineTotal'
            ? assigned
            : nearestNumeric(line);
          if (numericKind === 'quantity' || numericKind === 'unitPrice' || numericKind === 'lineTotal') {
            const seededHere = seedNumericLines[index]?.includes(line) === true;
            const seededElsewhere = seedNumericLines.some((lines, anchorIndex) =>
              anchorIndex !== index && lines.includes(line));
            if (seededElsewhere && !seededHere) return false;
            if (!seededHere && !seededElsewhere) {
              const thisDist = Math.abs(lineRawY - rowMinRawY);
              const prevDist = prevMinRawY !== undefined ? Math.abs(lineRawY - prevMinRawY) : Number.POSITIVE_INFINITY;
              const nextDist = nextMinRawY !== undefined ? Math.abs(lineRawY - nextMinRawY) : Number.POSITIVE_INFINITY;
              if (thisDist > prevDist || thisDist > nextDist) return false;
            }
          }
          const amountOnly = parseTableAmount(line.text) !== undefined && !/[A-Za-zÀ-ÿ]{4,}/.test(line.text);
          const indexOwnedHere = cellIndexOwnedHere(
            lineRawY,
            rowIndexAnchor,
            positionIndexIntervals,
            rawLo,
            rawHi,
          );
          if (positionIndexBoundaryExcludesCell(
            lineRawY,
            rowIndexAnchor,
            positionIndexIntervals,
            rawLo,
            rawHi,
          )) {
            return false;
          }
          const commercialTextLine = assigned === 'description'
            || assigned === 'itemCode'
            || (
              !amountOnly
              && assigned !== 'quantity'
              && assigned !== 'unitPrice'
              && assigned !== 'discount'
              && assigned !== 'vatRate'
              && assigned !== 'lineTotal'
              && /[A-Za-zÀ-ÿ]{4,}/.test(line.text)
            );
          const distToThisRow = verticalDistanceToBand(lineRawY, rowMinRawY, rowMaxRawY);
          const nearerNextCode = commercialTextLine
            && nextCodeRawY !== undefined
            && Math.abs(lineRawY - nextCodeRawY) + 2 < distToThisRow;
          const nearerGapCode = commercialTextLine
            && nextGapCodeRawY !== undefined
            && Math.abs(lineRawY - nextGapCodeRawY) + 2 < distToThisRow;
          const nearerNextNumeric = commercialTextLine
            && nextMinRawY !== undefined
            && Math.abs(lineRawY - nextMinRawY) + 2 < distToThisRow;
          const inTextBand = (assigned === 'itemCode' || assigned === 'description')
            && lineRawY >= rawLo
            && lineRawY < rawHi
            && !nearerNextCode
            && !nearerGapCode
            && !nearerNextNumeric;
          const rowHasLead = row.lines.some((entry) => {
            const kind = nearestNumeric(entry) ?? assignCol(entry);
            return kind === 'quantity' || kind === 'unitPrice' || kind === 'itemCode';
          });
          const commercialText = rowHasLead && (assigned === 'description' || assigned === 'itemCode');
          const nextIntrusiveCode = !bodyAboveHeaders && next
            ? itemCodeAnchors.find((code) => {
              const codeY = adjustedY(code);
              if (owningNumericRowIndex(codeY, pageAnchors) !== index + 1) return false;
              return codeY > row.y + 8 && codeY < (row.y + next.y) / 2;
            })
            : undefined;
          const nextIntrusiveCodeY = nextIntrusiveCode ? adjustedY(nextIntrusiveCode) : undefined;
          const codePad = Math.max(12, medianLineHeight * 0.75);
          const crossesNewCode = nextIntrusiveCodeY !== undefined
            && y >= nextIntrusiveCodeY - codePad;
          const sameVisualRow = commercialText
            && !crossesNewCode
            && !isSubtotalLabelFast(line.text)
            && !isTaxableLabelFast(line.text)
            && !isTotalLabelFast(line.text)
            && Math.abs(lineRawY - rowRawY) <= visualTol
            && Math.abs(lineRawY - rowRawY) <= Math.abs(lineRawY - prevRawY)
            && Math.abs(lineRawY - rowRawY) <= Math.abs(lineRawY - nextRawY);
          const nearHeader = bodyAboveHeaders
            ? y >= headerTop - Math.max(6, medianLineHeight * 0.4)
            : y <= headerBottom + Math.max(6, medianLineHeight * 0.4);
          const headerish = nearHeader && (
            detectDocumentTableColumnFast(line.text) !== undefined ||
            columnKind(line.text) !== undefined ||
            (
              parseTableAmount(line.text) === undefined
              && parseQuantityCell(line.text) === undefined
              && /[A-Za-z]{3,}/.test(line.text)
              && !/\d{2,}/.test(line.text)
            )
          );
          let ownedByLaterCode = false;
          let ownedByLeftAnchor = false;
          if (
            (assigned === 'description' || assigned === 'itemCode')
            && leftRowAnchors.length > 0
            && !bodyAboveHeaders
          ) {
            const nearestLeft = leftRowAnchors.reduce((best, entry) =>
              Math.abs(layoutLineRawY(entry) - lineRawY) < Math.abs(layoutLineRawY(best) - lineRawY)
                ? entry
                : best);
            const nearestLeftRawY = layoutLineRawY(nearestLeft);
            const leftOwnerIndex = owningNumericRowIndexByRawY(
              nearestLeftRawY,
              pageAnchors,
              seedMinRawY,
              leftAnchorRawYs,
              leftAnchorClusters,
            );
            const nearCode = Math.abs(lineRawY - nearestLeftRawY) <= nearLeftAnchorDistancePad(
              nearestLeft,
              medianLineHeight,
              medianRowSpacing,
            );
            const inIndexRowBand = lineRawY >= rawLo && lineRawY < rawHi;
            // A real SKU/item-code is a stronger row boundary than the numeric
            // midpoint.  In wrapped rows the next description can sit physically
            // inside the previous numeric band (for example KIT-01 at y=225 with
            // its description starting at y=218).  Do not let that text leak into
            // the previous item merely because `inIndexRowBand` is still true.
            const nearestLeftIsCommercialCode = isCommercialItemCodeAnchor(nearestLeft, columns);
            if (nearCode && leftOwnerIndex !== index && nearestLeftIsCommercialCode) return false;
            if (nearCode && leftOwnerIndex !== index && !indexOwnedHere && !inIndexRowBand) return false;
            if (nearCode && leftOwnerIndex === index) ownedByLeftAnchor = true;
          }
          if (
            (assigned === 'description' || assigned === 'itemCode')
            && !sameVisualRow
            && !inTextBand
            && itemCodeAnchors.length > 0
            && !bodyAboveHeaders
          ) {
            const nearestCode = itemCodeAnchors.reduce((best, entry) =>
              Math.abs(adjustedY(entry) - y) < Math.abs(adjustedY(best) - y) ? entry : best);
            const nearestCodeY = adjustedY(nearestCode);
            const ownerIndex = owningNumericRowIndex(nearestCodeY, pageAnchors);
            const previousOwner = ownerIndex > 0 ? pageAnchors[ownerIndex - 1] : undefined;
            const ownerRow = pageAnchors[ownerIndex];
            const intrusive = !!previousOwner
              && !!ownerRow
              && nearestCodeY > previousOwner.y + 8
              && nearestCodeY < (previousOwner.y + ownerRow.y) / 2;
            if (intrusive) {
              const thisOwns = ownerIndex === index;
              const codePadForOwn = Math.max(12, medianLineHeight * 0.75);
              const atOrBelowCode = y >= nearestCodeY - codePadForOwn;
              const nearerCodeThanRow = Math.abs(y - nearestCodeY) <= Math.abs(y - row.y);
              if (
                thisOwns
                && atOrBelowCode
                && y <= row.y + Math.max(20, medianLineHeight)
              ) {
                ownedByLaterCode = true;
              }
              if (!thisOwns && !inTextBand && !indexOwnedHere && nearestCodeY > row.y && atOrBelowCode && nearerCodeThanRow) return false;
            }
          }
          if (isCarryForwardText(line.text) || isHistoricalOrStatisticalRecapText(line.text)) return false;
          if (isItemsTableFooterBoundary(line.text)) return false;
          if (
            parseTableAmount(line.text) !== undefined
            && pageCtx.lineFeatures.some((feature) =>
              Math.abs(feature.adjustedY - y) <= Math.max(20, medianLineHeight)
              && (isSubtotalLabelFast(feature.line.text) || isTaxableLabelFast(feature.line.text) || isTotalLabelFast(feature.line.text)))
          ) {
            return false;
          }
          if (indexOwnedHere) {
            if (headerish) return false;
            if (
              parseTableAmount(line.text) !== undefined
              && !/%/.test(line.text)
              && assigned !== 'lineTotal'
              && pageCtx.lineFeatures.some((feature) =>
                Math.abs(feature.adjustedY - y) <= 36
                && isDocumentSectionAmountLabel(feature.line.text))
            ) {
              return false;
            }
            return true;
          }
          const previousHangingDescription = previous?.lines.some((entry) => {
            const kind = assignCol(entry) ?? columnKind(entry.text);
            return kind === 'description' && /[,;:\-–]$/.test(entry.text.trim());
          });
          if (
            assigned === 'description'
            && previousHangingDescription
            && Math.abs(y - (previous?.y ?? Number.POSITIVE_INFINITY)) <= Math.abs(y - row.y) + Math.max(12, medianLineHeight)
          ) {
            return false;
          }
          if (nearerNextCode || nearerGapCode || nearerNextNumeric) return false;
          if (!(((y >= lo && y < hi) || sameVisualRow || ownedByLaterCode || ownedByLeftAnchor || inTextBand) && !headerish)) return false;
          if (
            parseTableAmount(line.text) !== undefined
            && !/%/.test(line.text)
            && assigned !== 'lineTotal'
            && pageCtx.lineFeatures.some((feature) =>
              Math.abs(feature.adjustedY - y) <= 36
              && isDocumentSectionAmountLabel(feature.line.text))
          ) {
            return false;
          }
          return true;
        });
        if (!row.lines.some((entry) => isServiceChargeIdentity(entry.text))) {
          const rowHasNumerics = row.lines.some((line) => {
            const assigned = assignCol(line) ?? columnKind(line.text);
            return assigned === 'quantity' || assigned === 'unitPrice' || assigned === 'lineTotal';
          });
          if (rowHasNumerics) {
            const serviceIdentityPad = Math.max(medianRowSpacing * 0.85, medianLineHeight * 2.2);
            for (const line of body) {
              if (row.lines.some((entry) => entry.id === line.id)) continue;
              if (!isServiceChargeIdentity(line.text) && !/^(?:TRASPORTO|TRANSPORT)$/i.test(line.text.trim())) {
                continue;
              }
              const lineY = layoutLineRawY(line);
              if (lineY < rowMinRawY - serviceIdentityPad || lineY > rowMinRawY + Math.max(12, medianLineHeight * 0.5)) {
                continue;
              }
              row.lines.push(line);
            }
          }
        }
        logItemParsePerf('row_begin', { pageIndex: page.pageIndex, rowIndex: index, cells: row.lines.length });
        logItemParsePerf('row_band_complete', { pageIndex: page.pageIndex, rowIndex: index, ms: Date.now() - rowStarted });
      }
      const assignOrphanColumn = (line: DocumentLayoutLine) => {
        if (isPositionIndexCell(line, positionIndexX, tablePageWidth)) return undefined;
        return assignCol(line) ?? nearestNumeric(line);
      };
      const orphanResult = reattachOrphanNumericCells({
        rows: pageAnchors,
        body,
        assignColumn: assignOrphanColumn,
        pageIndex: page.pageIndex,
        medianLineHeight,
        medianRowSpacing,
      });
      for (let index = 0; index < pageAnchors.length; index += 1) {
        pageAnchors[index]!.lines = orphanResult.rows[index]?.lines ?? pageAnchors[index]!.lines;
      }
      const clusterResult = assignUnownedNumericClusters({
        rows: pageAnchors,
        assignColumn: assignOrphanColumn,
        pageIndex: page.pageIndex,
        medianLineHeight,
        medianRowSpacing,
        body,
      });
      if (isDevLogEnabled() || isQaDocumentLoggingEnabled()) {
        logQaDocument('RowClusterOwnershipSummary', {
          page: page.pageIndex,
          attached: clusterResult.attached,
          ambiguous: clusterResult.ambiguous,
          rows: clusterResult.rows.map((row) => row.lines.length),
        });
      }
      for (let index = 0; index < pageAnchors.length; index += 1) {
        pageAnchors[index]!.lines = clusterResult.rows[index]?.lines ?? pageAnchors[index]!.lines;
      }
      let lastMaterializedRow: LayoutRow | undefined;
      for (let index = 0; index < pageAnchors.length; index += 1) {
        const row = pageAnchors[index]!;
        const rowStarted = Date.now();
        const parseRow = bodyAboveHeaders
          ? { ...row, lines: row.lines.map((line) => flipLineHorizontally(line, pageWidth)) }
          : row;
        const parsePositionIndexX = bodyAboveHeaders && positionIndexX !== undefined
          ? pageWidth - positionIndexX
          : positionIndexX;
        logItemParsePerf('row_materialize', { pageIndex: page.pageIndex, rowIndex: index, cells: parseRow.lines.length });
        const item = itemFromRow(parseRow, parseColumns, columnKind, {
          weakSchemaSafeMode,
          positionIndexX: parsePositionIndexX,
          pageWidth,
          ignoredCommercialNumericLaneXs,
        });
        const previousItem = items.at(-1);
        if (
          item
          && previousItem
          && lastMaterializedRow
          && previousItem.pageIndex === item.pageIndex
          && isDuplicateWrappedContinuation({
            previous: previousItem,
            candidate: item,
            previousRow: lastMaterializedRow,
            candidateRow: parseRow,
            positionIndexX: parsePositionIndexX,
            pageWidth,
          })
        ) {
          absorbDuplicateWrappedContinuation(previousItem, item);
        } else if (item) {
          items.push(item);
          lastMaterializedRow = parseRow;
        } else if ((isQaDocumentLoggingEnabled() || isDevLogEnabled()) && parseRow.lines.length === 0) {
          logQaDocument('ItemCandidateReject', {
            reason: 'invalid_geometry',
            rowIndex: index,
            rowY: row.y,
          });
        }
        logItemParsePerf('row_complete', { pageIndex: page.pageIndex, rowIndex: index, item: !!item, ms: Date.now() - rowStarted });
      }
      logItemParsePerf('done', {
        pageIndex: page.pageIndex,
        rows: supportedAnchors.length,
        items: items.length - itemsBeforePage,
        ms: Date.now() - parsingStarted,
      });
      logItemsPerf('item_parsing', {
        pageIndex: page.pageIndex,
        candidateRows: supportedAnchors.length,
        items: items.length,
        ms: Date.now() - parsingStarted,
      });
      if (zone) {
        const parsed = items.length - itemsBeforePage;
        logItemsZonePerf('row_parse', { pageIndex: page.pageIndex, items: parsed, ms: Date.now() - parsingStarted });
        logItemsZonePerf('zone_done', { pageIndex: page.pageIndex, items: parsed, ms: Date.now() - geometricHeaderStarted });
      }
      continue;
    }
    const rowsStarted = Date.now();
    const zonePage = zone && (zone.directMatched ?? zone.lineIds.size) >= 8
      ? { ...page, lines: page.lines.filter((line) => zoneContainsLineId(zone.lineIds, line.id)) }
      : page;
    const rows = rowsForPage(zonePage, geometry);
    logItemsPerf('candidate_rows', { pageIndex: page.pageIndex, count: rows.length, ms: Date.now() - rowsStarted });
    if (zone) logItemsZonePerf('row_candidates', { pageIndex: page.pageIndex, count: rows.length, ms: Date.now() - rowsStarted });
    let columns: HeaderColumn[] = [];
    const fallbackParsingStarted = Date.now();
    const itemsBeforePage = items.length;
    let lastFallbackRow: LayoutRow | undefined;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const headersIdentified = columns.length > 0;
      if (!headersIdentified && rowIndex % ITEMS_CHECK_EVERY === 0 && layoutDeadlineExceeded(pageDeadline)) break;
      const row = rows[rowIndex];
      const candidate = headerColumns(row, columnKind);
      if (candidate.length >= 3 && candidate.some((column) => column.kind === 'description') &&
        (candidate.some((column) => column.kind === 'lineTotal') || candidate.some((column) => column.kind === 'unitPrice'))) {
        columns = candidate;
        continue;
      }
      if (columns.length === 0) continue;
      const item = itemFromRow(row, columns, columnKind);
      const previousItem = items.at(-1);
      if (
        item
        && previousItem
        && lastFallbackRow
        && previousItem.pageIndex === item.pageIndex
        && isDuplicateWrappedContinuation({
          previous: previousItem,
          candidate: item,
          previousRow: lastFallbackRow,
          candidateRow: row,
        })
      ) {
        absorbDuplicateWrappedContinuation(previousItem, item);
      } else if (item) {
        items.push(item);
        lastFallbackRow = row;
      } else if (isSummaryRow(row)) columns = [];
      else if (items.at(-1)?.pageIndex === page.pageIndex) appendMultilineDescription(items.at(-1)!, row, columns, columnKind);
    }
    logItemsPerf('item_parsing', {
      pageIndex: page.pageIndex,
      candidateRows: rows.length,
      items: items.length,
      ms: Date.now() - fallbackParsingStarted,
    });
    if (zone) {
      const parsed = items.length - itemsBeforePage;
      logItemsZonePerf('row_parse', { pageIndex: page.pageIndex, items: parsed, ms: Date.now() - fallbackParsingStarted });
      logItemsZonePerf('zone_done', { pageIndex: page.pageIndex, items: parsed, ms: Date.now() - geometricHeaderStarted });
    }
  }
  return items;
}

function looksLikeVatRateCapture(value: number | undefined, raw: unknown): boolean {
  if (value === undefined || !Number.isFinite(value)) return false;
  const text = String(raw ?? '').trim();
  if (/%/.test(text) && value <= 30) return true;
  if (value > 0 && value <= 23 && Number.isInteger(value) && !/[.,]/.test(text.replace(/\s*%\s*$/, ''))) {
    return true;
  }
  return false;
}

function labeledAmount(
  lines: readonly DocumentLayoutLine[],
  label: RegExp,
  reason: string,
): DocumentEvidence<number> | undefined {
  for (const line of lines) {
    if (/\b(?:p\.?\s*iva|partita\s+iva|cod\.?\s*fisc|tax\s*id|vat\s*id)\b/i.test(line.text)) continue;
    if (/\b(?:spese?|trasporto|shipping|freight|porto|transport)\b/i.test(line.text)) continue;
    const match = line.text.match(label);
    if (!match?.[1]) continue;
    const evidence = amountEvidence(match[1], [line], reason);
    if (evidence) return evidence;
  }
  return undefined;
}

function looksLikeDocumentMoneyAmount(text: string, value: number | undefined): boolean {
  if (value === undefined || !Number.isFinite(value) || value < 100) return false;
  if (/^\d{1,3}$/.test(text.trim())) return false;
  return /[.,]\d{2}\b/.test(text) || /(?:€|EUR|USD|GBP|CHF)\b/i.test(text) || /\d[.,]\d{3}[.,]\d{2}/.test(text);
}

/** Footer VAT/subtotal siblings can be below 100; still require money shape, not a bare integer. */
function looksLikeSummaryMoneyAmount(text: string, value: number | undefined): boolean {
  if (value === undefined || !Number.isFinite(value) || value < 0.5) return false;
  if (/^\d{1,3}$/.test(text.trim())) return false;
  if (/%/.test(text)) return false;
  return /[.,]\d{2}\b/.test(text) || /(?:€|EUR|USD|GBP|CHF)\b/i.test(text) || /\d[.,]\d{3}[.,]\d{2}/.test(text);
}

function pickPreferredDocumentTotal(
  label: DocumentLayoutLine,
  amounts: Array<{ line: DocumentLayoutLine; value: number }>,
): DocumentEvidence<number> | undefined {
  if (amounts.length === 0) return undefined;
  const first = amounts[0];
  if (amounts.length === 1) {
    return amountEvidence(first.line.text, [label, first.line], 'labeled_document_total_following_line');
  }
  const largest = [...amounts].sort((left, right) => right.value - left.value)[0];
  const vatSibling = amounts.some((entry) =>
    entry.value < largest.value * 0.5
    && entry.value / largest.value >= 0.04
    && entry.value / largest.value <= 0.28);
  const chosen = vatSibling || looksLikeDocumentTotalLabel(normalizeDocumentText(label.text))
    ? largest
    : first;
  return amountEvidence(chosen.line.text, [label, chosen.line], 'labeled_document_total_following_line');
}

function collectNearbyMoneyAmounts(
  lines: readonly DocumentLayoutLine[],
  label: DocumentLayoutLine,
): Array<{ line: DocumentLayoutLine; value: number }> {
  const labelBox = label.boundingBox;
  const labelY = labelBox ? labelBox.y + labelBox.height / 2 : undefined;
  const amounts: Array<{ line: DocumentLayoutLine; value: number }> = [];
  for (const candidate of lines) {
    if (candidate === label) continue;
    const value = parseTableAmount(candidate.text) ?? parseDocumentAmount(candidate.text);
    if (!looksLikeDocumentMoneyAmount(candidate.text, value) || value === undefined) continue;
    if (labelY === undefined || !candidate.boundingBox) continue;
    const candidateY = candidate.boundingBox.y + candidate.boundingBox.height / 2;
    if (Math.abs(candidateY - labelY) > 90) continue;
    amounts.push({ line: candidate, value });
  }
  return amounts;
}

function collectFollowingMoneyAmounts(
  lines: readonly DocumentLayoutLine[],
  startIndex: number,
  labelY: number | undefined,
  skipNearBodyCells: boolean,
): Array<{ line: DocumentLayoutLine; value: number }> {
  const amounts: Array<{ line: DocumentLayoutLine; value: number }> = [];
  for (let offset = 1; offset <= 8; offset += 1) {
    const candidate = lines[startIndex + offset];
    if (!candidate) break;
    if (skipNearBodyCells && labelY !== undefined) {
      const dy = (candidate.boundingBox?.y ?? 0) - labelY;
      // Keep currency-bearing footer totals; skip bare table-body cells in the same band.
      if (dy > 45 && dy < 180 && !/(?:€|EUR|USD|GBP|CHF)/i.test(candidate.text)) continue;
    }
    const candidateNorm = normalizeDocumentText(candidate.text);
    if (/\b(?:codice|percentuale|esenzione|firme?)\b/i.test(candidateNorm) && !/\d/.test(candidate.text)) {
      continue;
    }
    const value = parseTableAmount(candidate.text) ?? parseDocumentAmount(candidate.text);
    if (!looksLikeDocumentMoneyAmount(candidate.text, value) || value === undefined) continue;
    amounts.push({ line: candidate, value });
  }
  return amounts;
}

function collectFollowingSummaryAmounts(
  lines: readonly DocumentLayoutLine[],
  startIndex: number,
): number[] {
  const amounts: number[] = [];
  for (let offset = 1; offset <= 8; offset += 1) {
    const candidate = lines[startIndex + offset];
    if (!candidate) break;
    const value = parseTableAmount(candidate.text) ?? parseDocumentAmount(candidate.text);
    if (!looksLikeSummaryMoneyAmount(candidate.text, value) || value === undefined) continue;
    amounts.push(value);
  }
  return amounts;
}

interface LabeledTotalHit {
  evidence: DocumentEvidence<number>;
  siblingValues: number[];
}

function findLabeledTotalHit(
  lines: readonly DocumentLayoutLine[],
  documentTotalOnly: boolean,
): LabeledTotalHit | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = normalizeDocumentText(line.text).replace(/\s+/g, ' ').trim();
    if (!/\b(?:totale|total)\b/i.test(normalized)) continue;
    if (isPageOrSectionSubtotalLabel(normalized)) continue;
    if (/\b(?:totale|total)\s+(?:riga|iva|imposta|imponibile|ht|vat|mpos)\b/i.test(normalized)) continue;
    if (/\b(?:imposta|vat\s+amount|iva\s+totale)\b/i.test(normalized)) continue;
    const documentTotalLabel = looksLikeDocumentTotalLabel(normalized);
    if (documentTotalOnly && !documentTotalLabel) continue;
    const skipNearBody = !!detectDocumentTableColumnFast(line.text) && !/\d/.test(line.text);
    if (/totale\s+\.\d/.test(normalized)) {
      // OCR dropped the thousands digit ("Totale .400,00€"). Use nearby evidence.
    } else {
      const sameLine = parseTableAmount(line.text) ?? parseDocumentAmount(line.text);
      if (looksLikeDocumentMoneyAmount(line.text, sameLine) && sameLine !== undefined) {
        return {
          evidence: amountEvidence(line.text, [line], 'labeled_document_total')!,
          siblingValues: [sameLine],
        };
      }
    }
    const nearby = collectNearbyMoneyAmounts(lines, line);
    const amounts = nearby.length > 0
      ? nearby
      : collectFollowingMoneyAmounts(
        lines,
        index,
        skipNearBody ? line.boundingBox?.y : undefined,
        skipNearBody,
      );
    const recovered = pickPreferredDocumentTotal(line, amounts);
    if (recovered) {
      const siblingValues = [
        ...new Set([
          ...amounts.map((entry) => entry.value),
          ...collectFollowingSummaryAmounts(lines, index),
        ]),
      ];
      return { evidence: recovered, siblingValues };
    }
  }
  return undefined;
}

/** Recover an explicit Totale / Total amount from the label line or the following summary lines. */
function labeledTotalFromFollowingLines(
  lines: readonly DocumentLayoutLine[],
): DocumentEvidence<number> | undefined {
  return labeledDocumentTotalHit(lines)?.evidence;
}

function labeledDocumentTotalHit(
  lines: readonly DocumentLayoutLine[],
): LabeledTotalHit | undefined {
  return findLabeledTotalHit(lines, true) ?? findLabeledTotalHit(lines, false);
}

function inferTripletFromSiblingAmounts(
  total: number,
  siblings: readonly number[],
): { subtotal: number; vat: number } | undefined {
  const unique = [...new Set(siblings.map((value) => Math.round(value * 100) / 100))]
    .filter((value) => Number.isFinite(value) && value > 0);
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const left = unique[i];
      const right = unique[j];
      if (!summaryAmountsCloseEnough(left + right, total)) continue;
      const vat = Math.min(left, right);
      const subtotal = Math.max(left, right);
      const share = vat / total;
      if (share >= 0.04 && share <= 0.28) return { subtotal, vat };
    }
  }
  return undefined;
}

/** Deadline-safe taxable pairing: strong label binds a geometrically nearby amount. */
function nearestColumnAlignedAmount(
  label: DocumentLayoutLine,
  lines: readonly DocumentLayoutLine[],
  options?: { skipVatRates?: boolean },
): DocumentLayoutLine | undefined {
  const box = label.boundingBox;
  if (!box) return undefined;
  const labelCenterX = box.x + box.width / 2;
  const labelRight = box.x + box.width;
  const labelIsTotals = label.semanticRegion === 'document_totals'
    || isStrongTaxableLabel(normalizeDocumentText(label.text));
  let best: { line: DocumentLayoutLine; score: number } | undefined;
  for (const candidate of lines) {
    if (candidate === label || !candidate.boundingBox) continue;
    if (candidate.pageIndex !== label.pageIndex) continue;
    if (isShippingOrFreightLabel(normalizeDocumentText(candidate.text))) continue;
    if (options?.skipVatRates && isVatRateLine(candidate.text)) continue;
    const value = parseTableAmount(candidate.text) ?? parseDocumentAmount(candidate.text);
    if (!looksLikeDocumentMoneyAmount(candidate.text, value) || value === undefined) continue;
    const candidateBox = candidate.boundingBox;
    const sameRow = Math.abs((candidateBox.y + candidateBox.height / 2) - (box.y + box.height / 2))
      <= Math.max(box.height, candidateBox.height) * 1.15;
    const below = candidateBox.y > box.y && candidateBox.y - box.y <= Math.max(160, box.height * 6);
    if (!sameRow && !below) continue;
    const toTheRight = candidateBox.x >= labelRight - 16;
    if (labelIsTotals && sameRow && !toTheRight) continue;
    const xDist = Math.abs(candidateBox.x - labelCenterX);
    const columnAligned = xDist <= Math.max(180, box.width * 2.5);
    const rightOfLabel = candidateBox.x >= box.x + box.width * 0.55;
    if (!columnAligned && !rightOfLabel && !toTheRight) continue;
    const score = (toTheRight ? 0 : 250) + (sameRow ? 0 : 50) + (rightOfLabel ? 0 : 80) + xDist;
    if (!best || score < best.score) best = { line: candidate, score };
  }
  return best?.line;
}

function labeledSubtotalFromFollowingLines(
  lines: readonly DocumentLayoutLine[],
): DocumentEvidence<number> | undefined {
  let best: { evidence: DocumentEvidence<number>; score: number; index: number } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = normalizeDocumentText(line.text).replace(/\s+/g, ' ').trim();
    if (!isStrongTaxableLabel(normalized)) continue;
    if (isHistoricalOrStatisticalRecapText(normalized) || isTaxRecapHeadingText(normalized)) continue;
    if (line.semanticRegion === 'tax_recap' || line.semanticRegion === 'historical_recap') continue;
    if (detectDocumentTableColumnFast(line.text) && !/\d/.test(line.text)) continue;
    if (!isPrimaryGoodsSubtotalLabel(normalized) && hasLaterDocumentSubtotalAfterShipping(lines, index)) continue;
    let found: DocumentEvidence<number> | undefined;
    const sameLine = parseTableAmount(line.text) ?? parseDocumentAmount(line.text);
    if (looksLikeDocumentMoneyAmount(line.text, sameLine) && sameLine !== undefined) {
      found = amountEvidence(line.text, [line], 'labeled_taxable_amount');
    }
    if (!found) {
      const geometric = nearestColumnAlignedAmount(line, lines, { skipVatRates: true });
      if (geometric && classifyMoneyLabel(geometric.text) !== 'discount') {
        found = amountEvidence(geometric.text, [line, geometric], 'labeled_taxable_following_line');
      }
    }
    if (!found) {
      for (let offset = 1; offset <= 3; offset += 1) {
        const candidate = lines[index + offset];
        if (!candidate) break;
        if (isPageOrSectionSubtotalLabel(normalizeDocumentText(candidate.text))) continue;
        if (isShippingOrFreightLabel(normalizeDocumentText(candidate.text))) continue;
        if (classifyMoneyLabel(candidate.text) === 'discount') continue;
        const value = parseTableAmount(candidate.text) ?? parseDocumentAmount(candidate.text);
        if (!looksLikeDocumentMoneyAmount(candidate.text, value) || value === undefined) continue;
        found = amountEvidence(candidate.text, [line, candidate], 'labeled_taxable_following_line');
        break;
      }
    }
    if (!found) continue;
    const score = amountLabelSpecificity(normalized, 'subtotal');
    logQaDocument('TotalsCandidate', {
      role: 'subtotal',
      value: found.normalizedValue,
      label: line.text,
      score,
      page: line.pageIndex,
    });
    if (!best || score > best.score || (score === best.score && index > best.index)) {
      best = { evidence: found, score, index };
    }
  }
  if (best) {
    logQaDocument('TotalsOwnership', {
      role: 'subtotal',
      value: best.evidence.normalizedValue,
      score: best.score,
      reason: 'highest_specificity_taxable_label',
    });
  }
  return best?.evidence;
}

/** Deadline-safe VAT pairing: label on one line, amount on the next. */
function labeledVatFromFollowingLines(
  lines: readonly DocumentLayoutLine[],
): DocumentEvidence<number> | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalized = normalizeDocumentText(line.text).replace(/\s+/g, ' ').trim();
    if (!isVatAmountLabelFast(line.text) && !/\b(?:totale\s+iva|totale\s+imposta|importo\s+iva|vat\s+amount|totale\s+imp(?!onib))\b/i.test(normalized)) {
      continue;
    }
    if (isVatRateLine(line.text) && !isVatAmountLabelFast(line.text)) continue;
    if (line.semanticRegion === 'tax_recap' || isTaxRecapHeadingText(line.text)) continue;
    if (isHistoricalOrStatisticalRecapText(line.text)) continue;
    const sameLine = parseDocumentAmount(line.text);
    if (
      sameLine !== undefined
      && !(sameLine <= 23 && Number.isInteger(sameLine))
      && ( /[.,]\d{2}/.test(line.text) || /(?:€|EUR|USD|GBP|CHF)/i.test(line.text))
    ) {
      return amountEvidence(line.text, [line], 'labeled_vat_amount');
    }
    const geometric = nearestColumnAlignedAmount(line, lines, { skipVatRates: true });
    if (geometric) {
      return amountEvidence(geometric.text, [line, geometric], 'labeled_vat_following_line');
    }
    for (let offset = 1; offset <= 3; offset += 1) {
      const candidate = lines[index + offset];
      if (!candidate) break;
      if (looksLikeDocumentTotalLabel(normalizeDocumentText(candidate.text))) break;
      if (isVatRateLine(candidate.text)) continue;
      const value = parseDocumentAmount(candidate.text);
      if (value === undefined) continue;
      if (value <= 23 && Number.isInteger(value) && !/[.,]\d{2}/.test(candidate.text)) continue;
      if (!/[.,]\d{2}/.test(candidate.text) && !/(?:€|EUR|USD|GBP|CHF)/i.test(candidate.text)) continue;
      return amountEvidence(candidate.text, [line, candidate], 'labeled_vat_following_line');
    }
  }
  return undefined;
}

function summaryLines(pages: readonly StructuredDocumentPage[]): DocumentLayoutLine[] {
  const ids = new Set(pages.flatMap((page) => page.zones.filter((zone) => ['tax_summary', 'totals'].includes(zone.classification)).flatMap((zone) => zone.lineIds)));
  return pages.flatMap((page) => page.lines).filter((line) => ids.has(line.id));
}

function amountLabelSpecificity(text: string, reason: string): number {
  const normalized = normalizeDocumentText(text);
  if (/vat/i.test(reason)) {
    if (/\b(?:totale\s+iva|importo\s+iva|iva\s+totale|total\s+vat|vat\s+amount|montant\s+tva|total\s+tva|totale\s+imposta|totale\s+va)\b/i.test(normalized)) {
      return 120;
    }
    if (isVatRateAmountAnchor(text)) return 50;
    return 20;
  }
  if (/taxable|subtotal/i.test(reason)) {
    if (/\b(?:totale\s+(?:imponibile|[a-z]?pon\w*)|total\s+ht|montant\s+ht|taxable\s+amount|taxable\s+subtotal|base\s+taxable)\b/i.test(normalized)) {
      return 120;
    }
    if (/\b(?:imponibile\s+merc[ei]|goods\s+subtotal|sous[-\s]?total\s+marchandises)\b/i.test(normalized)) return 100;
    if (/\b(?:subtotale|subtotal|zwischensumme)\b/i.test(normalized)) return 90;
    if (/\bimponibile\b/i.test(normalized)) return 25;
    return 40;
  }
  if (/shipping/i.test(reason)) {
    if (/\b(?:spese?(?:\s+(?:di|e))?\s+trasporto|spese\s+trasporto(?:\s+e\s+imballo)?|shipping|freight|versand|fracht|transportkosten|frais\s+de\s+(?:transport|port))\b/i.test(normalized)) {
      return 120;
    }
    return 40;
  }
  return 50;
}

const strongerLabelCache = new WeakMap<PageItemsContext, LineItemFeatures[]>();

function strongerLabelFeatures(pageCtx: PageItemsContext): LineItemFeatures[] {
  const cached = strongerLabelCache.get(pageCtx);
  if (cached) return cached;
  const list = pageCtx.lineFeatures.filter((feature) =>
    isFinalTotalLabel(feature.line.text)
    || isVatAmountLabelFast(feature.line.text)
    || isVatSummaryLabel(feature.line.text)
    || isVatRateAmountAnchor(feature.line.text)
    || feature.summaryLikely
  );
  strongerLabelCache.set(pageCtx, list);
  return list;
}

function amountClaimedByStrongerLabel(
  pageCtx: PageItemsContext,
  valueFeature: LineItemFeatures,
  currentLabel: LineItemFeatures,
  reason: string,
): boolean {
  const taxable = /taxable|subtotal/i.test(reason);
  const vat = /vat/i.test(reason);
  if (!taxable && !vat) return false;
  const valueBox = valueFeature.line.boundingBox;
  const currentBox = currentLabel.line.boundingBox;
  if (!valueBox || !currentBox) return false;
  const currentDist = Math.hypot(
    valueBox.x - (currentBox.x + currentBox.width),
    valueBox.y - currentBox.y,
  );
  const currentAligned = Math.abs(currentLabel.centerY - valueFeature.centerY)
    <= Math.max(currentBox.height, valueBox.height) * 1.5;
  const competitors = strongerLabelFeatures(pageCtx);
  for (const other of competitors) {
    countDocumentProcessPerf('amountClaimedByStrongerLabel');
    if (other.line === currentLabel.line) continue;
    const vatCompetitor = taxable && (
      isVatAmountLabelFast(other.line.text)
      || isVatSummaryLabel(other.line.text)
      || isVatRateAmountAnchor(other.line.text)
    );
    const competitor = isFinalTotalLabel(other.line.text) || vatCompetitor;
    if (!competitor) continue;
    const otherBox = other.line.boundingBox;
    if (!otherBox) continue;
    const otherAligned = Math.abs(other.centerY - valueFeature.centerY)
      <= Math.max(otherBox.height, valueBox.height) * 1.5;
    const otherBelow = valueBox.y > otherBox.y && valueBox.y - otherBox.y <= Math.max(100, otherBox.height * 4);
    const otherRight = valueBox.x >= otherBox.x + otherBox.width * 0.2;
    if (vatCompetitor && (otherAligned || otherBelow) && otherRight) return true;
    const otherDist = Math.hypot(
      valueBox.x - (otherBox.x + otherBox.width),
      valueBox.y - otherBox.y,
    );
    if (otherAligned && !currentAligned) return true;
    if (otherAligned === currentAligned && otherDist + 8 < currentDist) return true;
  }
  return false;
}

function pickBestLabeledAmount<T extends {
  evidence: DocumentEvidence<number>;
  specificity: number;
  aligned: boolean;
  distance: number;
  labelY?: number;
  reason?: string;
}>(
  candidates: readonly T[],
): T | undefined {
  return [...candidates].sort((left, right) => {
    const specificity = right.specificity - left.specificity;
    if (specificity !== 0) return specificity;
    const aligned = Number(right.aligned) - Number(left.aligned);
    if (aligned !== 0) return aligned;
    const taxable = /taxable|subtotal/i.test(left.reason ?? right.reason ?? '');
    if (taxable && left.labelY !== undefined && right.labelY !== undefined && left.labelY !== right.labelY) {
      return right.labelY - left.labelY;
    }
    return left.distance - right.distance;
  })[0];
}

function amountNearLabelFromContext(
  ctx: ItemsTotalsContext,
  label: RegExp | ((text: string) => boolean),
  reason: string,
): DocumentEvidence<number> | undefined {
  const candidates: Array<{
    evidence: DocumentEvidence<number>;
    specificity: number;
    aligned: boolean;
    distance: number;
    labelY?: number;
    reason?: string;
  }> = [];
  let index = 0;
  for (const pageCtx of ctx.pageContexts.values()) {
    for (const labelFeature of pageCtx.lineFeatures) {
      countDocumentProcessPerf('amountNearLabel_labelScan');
      if (index % ITEMS_CHECK_EVERY === 0 && ctx.timedOut()) {
        return pickBestLabeledAmount(candidates)?.evidence;
      }
      index += 1;
      const text = labelFeature.normalizedText;
      if (!(label instanceof RegExp ? label.test(text) : label(text))) continue;
      const columnKind = detectDocumentTableColumnFast(labelFeature.line.text);
      if (
        columnKind &&
        labelFeature.adjustedY >= pageCtx.headerSearchMinY &&
        labelFeature.adjustedY <= pageCtx.headerSearchMaxY
      ) {
        continue;
      }
      if (/shipping/i.test(reason)) {
        const region = labelFeature.line.semanticRegion;
        if (region === 'header' || region === 'footer') continue;
        if (
          region === 'commercial_table_body'
          || region === 'commercial_table_header'
        ) {
          continue;
        }
      }
      const vatLookup = /vat/i.test(reason);
      const labelRegion = labelFeature.line.semanticRegion;
      if (vatLookup && (labelRegion === 'tax_recap' || labelRegion === 'historical_recap' || labelRegion === 'statistical_recap')) {
        continue;
      }
      if (vatLookup && isVatRateAmountAnchor(labelFeature.line.text) && (labelRegion === 'tax_recap' || isTaxRecapHeadingText(labelFeature.line.text))) {
        continue;
      }
      const fiscalLabel = /\b(?:p\.?\s*iva|partita\s+iva|tax\s*(?:id|number)|vat\s*(?:id|number)|fiscal\s*(?:id|code)|company\s*(?:registration|number))\b/i.test(labelFeature.line.text);
      if (vatLookup && fiscalLabel) {
        logVatCandidateDebug({
          text: labelFeature.line.text,
          fiscalId: true,
          identifierLike: true,
          monetary: false,
          summaryContext: false,
          accepted: false,
          rejectReason: 'fiscal_identifier_label',
        });
        continue;
      }
      const box = labelFeature.line.boundingBox;
      if (!box) continue;
      const centerY = labelFeature.centerY;
      let valueLine: DocumentLayoutLine | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestAligned = false;
      let bestYDelta = Number.POSITIVE_INFINITY;
      let bestSignedDiscount = false;
      const shippingLookup = /shipping/i.test(reason);
      const discountLookup = /document_discount/i.test(reason);
      for (const valueFeature of pageCtx.lineFeatures) {
        countDocumentProcessPerf('amountNearLabel_valueScan');
        if (valueFeature.line === labelFeature.line || valueFeature.amount === undefined) continue;
        const fiscalId = looksLikeInternationalTaxIdentifier(valueFeature.line.text)
          || /\b(?:p\.?\s*iva|partita\s+iva|cod\.?\s*fisc|tax\s*id|vat\s*id|iban|bic)\b/i.test(valueFeature.line.text);
        const monetary = /[.,]\d{2}\b|(?:EUR|USD|GBP|CHF)|[€$£]/i.test(valueFeature.line.text);
        if (fiscalId || (vatLookup && !monetary)) {
          if (vatLookup) logVatCandidateDebug({
            text: valueFeature.line.text,
            parsedValue: valueFeature.amount,
            fiscalId,
            identifierLike: fiscalId || !monetary,
            percentage: /%/.test(valueFeature.line.text),
            monetary,
            summaryContext: true,
            accepted: false,
            rejectReason: fiscalId ? 'fiscal_identifier_value' : 'vat_requires_monetary_shape',
          });
          continue;
        }
        if (vatLookup) {
          const valueRegion = valueFeature.line.semanticRegion;
          if (valueRegion === 'tax_recap' || valueRegion === 'historical_recap' || valueRegion === 'statistical_recap') {
            continue;
          }
        }
        if (/%\s*$/.test(valueFeature.line.text.trim())) continue;
        if (/document_discount/i.test(reason)) {
          const blocked = documentDiscountValueRejection(
            valueFeature.line,
            valueFeature.amount,
            labelFeature.line,
          );
          logDocumentDiscountCandidate({
            rawText: valueFeature.line.text,
            parsedValue: valueFeature.amount,
            page: valueFeature.line.pageIndex,
            region: valueFeature.line.semanticRegion,
            label: labelFeature.line.text,
            sourceLineIds: [labelFeature.line.id, valueFeature.line.id],
            evidence: reason,
            rejectionReason: blocked,
            won: false,
          });
          if (blocked) continue;
        }
        const lineBox = valueFeature.line.boundingBox;
        if (!lineBox) continue;
        const yDelta = Math.abs(valueFeature.centerY - centerY);
        const aligned = yDelta <= Math.max(box.height, lineBox.height) * (shippingLookup ? 0.85 : 1.5);
        const below = lineBox.y > box.y && lineBox.y - box.y <= Math.max(100, box.height * 4);
        if (!(aligned || below) || lineBox.x < box.x + box.width * 0.35) continue;
        if (amountClaimedByStrongerLabel(pageCtx, valueFeature, labelFeature, reason)) continue;
        const distance = Math.hypot(lineBox.x - (box.x + box.width), lineBox.y - box.y);
        if (discountLookup) {
          const signed = /^[-−–—]/.test(valueFeature.line.text.trim());
          const betterSigned = signed && !bestSignedDiscount;
          const worseSigned = !signed && bestSignedDiscount;
          const closerVertically = !worseSigned && yDelta + 2 < bestYDelta;
          const closerHypot = !worseSigned && Math.abs(yDelta - bestYDelta) <= 2 && distance < bestDistance;
          if (betterSigned || closerVertically || closerHypot) {
            bestDistance = distance;
            bestAligned = aligned;
            bestYDelta = yDelta;
            bestSignedDiscount = signed;
            valueLine = valueFeature.line;
          }
          continue;
        }
        const betterAligned = aligned && !bestAligned;
        const worseAligned = !aligned && bestAligned;
        const closerRow = shippingLookup && !worseAligned && yDelta + 2 < bestYDelta;
        const closerHypot = !worseAligned && Math.abs(yDelta - bestYDelta) <= 2 && distance < bestDistance;
        if (betterAligned || closerRow || closerHypot || (!shippingLookup && !worseAligned && distance < bestDistance)) {
          bestDistance = distance;
          bestAligned = aligned;
          bestYDelta = yDelta;
          valueLine = valueFeature.line;
        }
      }
      const evidence = valueLine ? amountEvidence(valueLine.text, [labelFeature.line, valueLine], reason) : undefined;
      if (evidence) {
        if (/taxable|subtotal/i.test(reason)) {
          const labelIndex = ctx.allLines.findIndex((line) => line.id === labelFeature.line.id);
          if (labelIndex >= 0 && hasLaterDocumentSubtotalAfterShipping(ctx.allLines, labelIndex)) {
            continue;
          }
        }
        candidates.push({
          evidence,
          specificity: amountLabelSpecificity(labelFeature.line.text, reason),
          aligned: bestAligned,
          distance: bestDistance,
          labelY: labelFeature.line.boundingBox?.y,
          reason,
        });
      }
    }
  }
  return pickBestLabeledAmount(candidates)?.evidence;
}

function amountNearLabel(
  pages: readonly StructuredDocumentPage[],
  label: RegExp | ((text: string) => boolean),
  reason: string,
): DocumentEvidence<number> | undefined {
  const candidates: DocumentEvidence<number>[] = [];
  for (const page of pages) {
    for (const labelLine of page.lines.filter((line) => {
      const text = normalizeDocumentText(line.text);
      return label instanceof RegExp ? label.test(text) : label(text);
    })) {
      const box = labelLine.boundingBox;
      if (!box) continue;
      const centerY = box.y + box.height / 2;
      const values = page.lines.filter((line) => {
        if (!line.boundingBox || line === labelLine || parseDocumentAmount(line.text) === undefined) return false;
        if (looksLikeInternationalTaxIdentifier(line.text)) return false;
        const compactDigits = line.text.replace(/\D/g, '');
        if (compactDigits.length === 11 && !/[.,]/.test(line.text) && !/\b(?:EUR|USD|GBP|CHF)\b|[â‚¬$Â£]/i.test(line.text)) return false;
        const monetaryText = line.text.replace(/\b(?:EUR|USD|GBP|CHF)\b|[€$£]/gi, '').replace(/[\d\s.,+\-()%]/g, '');
        if (/[A-Za-z]/.test(monetaryText)) return false;
        const otherY = line.boundingBox.y + line.boundingBox.height / 2;
        const aligned = Math.abs(otherY - centerY) <= Math.max(box.height, line.boundingBox.height) * 1.5;
        const below = line.boundingBox.y > box.y && line.boundingBox.y - box.y <= Math.max(100, box.height * 4);
        return (aligned || below) && line.boundingBox.x >= box.x + box.width * 0.35;
      }).sort((a, b) => {
        const rowPenalty = (line: DocumentLayoutLine) => {
          const lineCenterY = line.boundingBox!.y + line.boundingBox!.height / 2;
          return Math.abs(lineCenterY - centerY) <= Math.max(box.height, line.boundingBox!.height) * 1.5 ? 0 : 1;
        };
        const penaltyDifference = rowPenalty(a) - rowPenalty(b);
        if (penaltyDifference !== 0) return penaltyDifference;
        const distance = (line: DocumentLayoutLine) => Math.hypot(
          line.boundingBox!.x - (box.x + box.width),
          line.boundingBox!.y - box.y,
        );
        return distance(a) - distance(b);
      });
      const valueLine = values[0];
      const evidence = valueLine ? amountEvidence(valueLine.text, [labelLine, valueLine], reason) : undefined;
      if (evidence) candidates.push(evidence);
    }
  }
  return candidates.at(-1);
}

function isVatSummaryLabel(text: string): boolean {
  const cached = VAT_SUMMARY_CACHE.get(text);
  if (cached !== undefined) return cached;
  const normalized = normalizeDocumentText(text);
  if (isVatAmountLabelFast(text)) {
    VAT_SUMMARY_CACHE.set(text, true);
    return true;
  }
  const vat = (/\b(?:iva|vat|tva|mwst|ust)\b/i.test(normalized) &&
    !/\b(?:totale documento|grand total|total due|total ttc|gesamtbetrag)\b/i.test(normalized))
    ? true
    : matchesDocumentLabel(text, 'vatAmount') ||
    /\b(?:total\s+vat|vat\s+amount|totale\s+iva|totale\s+imposta|iva\s+totale|totale\s+va|total\s+iva|montant\s+tva|total\s+tva)\b/i.test(normalized);
  VAT_SUMMARY_CACHE.set(text, vat);
  return vat;
}

function isFinalTotalLabel(text: string): boolean {
  const cached = FINAL_TOTAL_CACHE.get(text);
  if (cached !== undefined) return cached;
  const normalized = normalizeDocumentText(text);
  if (
    isVatSummaryLabel(text) ||
    isVatAmountLabelFast(text) ||
    /\b(?:sous[-\s]?total|subtotal|zwischensumme|total\s+ht|montant\s+ht|totale\s+imponibile|imponibile|taxable|pu\s*ht|totale\s+iva|total\s+vat|total\s+tva|montant\s+tva|page\s+\d+)\b/i.test(normalized)
  ) {
    FINAL_TOTAL_CACHE.set(text, false);
    return false;
  }
  if (isTotalLabelFast(text)) {
    FINAL_TOTAL_CACHE.set(text, true);
    return true;
  }
  const total = /\b(?:grand total|total due|totale documento|totale complessivo|total ttc|total\s+ttc|gesamtbetrag|total orden|total presupuesto|net a payer|amount due|totale ordine|totale da pagare)\b/i.test(normalized);
  FINAL_TOTAL_CACHE.set(text, total);
  return total;
}

function totalLabelScore(text: string): number {
  const cached = TOTAL_SCORE_CACHE.get(text);
  if (cached !== undefined) return cached;
  const normalized = normalizeDocumentText(text);
  let score = 0;
  if (isVatSummaryLabel(text)) score = -100;
  else if (/\btotal ttc\b/i.test(normalized)) score = 120;
  else if (/\bgrand total\b/i.test(normalized)) score = 115;
  else if (/\b(?:totale complessivo|totale documento)\b/i.test(normalized)) score = 110;
  else if (/\b(?:total due|totale ordine|total presupuesto|amount due|gesamtbetrag)\b/i.test(normalized)) score = 90;
  else if (matchesDocumentLabel(text, 'total')) score = 70;
  else if (/\b(?:total ht|totale imponibile|subtotal|imponibile|taxable)\b/i.test(normalized)) score = 20;
  else if (/\b(?:totale|total)\b/i.test(normalized)) score = 40;
  TOTAL_SCORE_CACHE.set(text, score);
  return score;
}

function summaryAmountsCloseEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.02;
}

function isVatRateLine(text: string): boolean {
  const normalized = normalizeDocumentText(text);
  return /\b(?:iva|vat|tva|mwst|ust)\s*\d+(?:[.,]\d+)?\s*%/i.test(text) ||
    /\b(?:aliquota|rate)\b/i.test(normalized);
}

function monetarySummaryCandidatesFromContext(ctx: ItemsTotalsContext): number[] {
  const zoneLineIds = new Set(ctx.pages.flatMap((page) =>
    page.zones.filter((zone) => ['tax_summary', 'totals'].includes(zone.classification)).flatMap((zone) => zone.lineIds)));
  const seen = new Set<string>();
  const candidateLines: DocumentLayoutLine[] = [];
  for (const pageCtx of ctx.pageContexts.values()) {
    for (const feature of pageCtx.lineFeatures) {
      if (!zoneLineIds.has(feature.line.id) && !feature.summaryLikely) continue;
      if (seen.has(feature.line.id)) continue;
      seen.add(feature.line.id);
      candidateLines.push(feature.line);
    }
    const threshold = (pageCtx.page.height ?? 1400) * 0.64;
    for (const feature of pageCtx.lineFeatures) {
      if (!feature.line.boundingBox || feature.line.boundingBox.y < threshold || seen.has(feature.line.id)) continue;
      seen.add(feature.line.id);
      candidateLines.push(feature.line);
    }
    for (const labelFeature of pageCtx.lineFeatures) {
      if (!labelFeature.summaryLikely || !labelFeature.line.boundingBox) continue;
      const box = labelFeature.line.boundingBox;
      for (const amountLine of pageCtx.amountLines) {
        if (!amountLine.boundingBox || amountLine === labelFeature.line || seen.has(amountLine.id)) continue;
        if (Math.abs(amountLine.boundingBox.y - box.y) <= Math.max(180, box.height * 8)) {
          seen.add(amountLine.id);
          candidateLines.push(amountLine);
        }
      }
    }
  }
  return candidateLines.flatMap((line) => {
    if (isVatRateLine(line.text)) return [];
    const trimmed = line.text.trim();
    if (!/[.,]/.test(trimmed) && !/\b(?:EUR|USD|GBP|CHF)\b|[€$£]/i.test(trimmed)) return [];
    const value = parseDocumentAmount(trimmed);
    const twoDecimals = /[.,]\d{2}\b/.test(trimmed);
    return value !== undefined && (value >= 50 || (twoDecimals && value >= 0.5)) ? [value] : [];
  });
}

function monetarySummaryCandidates(pages: readonly StructuredDocumentPage[]): number[] {
  const zoneLineIds = new Set(pages.flatMap((page) =>
    page.zones.filter((zone) => ['tax_summary', 'totals'].includes(zone.classification)).flatMap((zone) => zone.lineIds)));
  const nearSummaryLabel = pages.flatMap((page) => page.lines.flatMap((labelLine) => {
    if (!/\b(?:imponibile|subtotal|iva|vat|totale|grand total|complessivo|amount due|total due|mwst|tva)\b/i.test(normalizeDocumentText(labelLine.text))) {
      return [];
    }
    const box = labelLine.boundingBox;
    if (!box) return [];
    return page.lines.filter((line) => line.boundingBox && line !== labelLine &&
      Math.abs(line.boundingBox.y - box.y) <= Math.max(180, box.height * 8));
  }));
  const candidateLines = [...new Set([
    ...pages.flatMap((page) => page.lines.filter((line) => zoneLineIds.has(line.id))),
    ...nearSummaryLabel,
    ...pages.flatMap((page) => {
      const threshold = (page.height ?? 1400) * 0.64;
      return page.lines.filter((line) => line.boundingBox && line.boundingBox.y >= threshold);
    }),
  ])];
  return candidateLines.flatMap((line) => {
    if (isVatRateLine(line.text)) return [];
    const trimmed = line.text.trim();
    if (!/[.,]/.test(trimmed) && !/\b(?:EUR|USD|GBP|CHF)\b|[€$£]/i.test(trimmed)) return [];
    const value = parseDocumentAmount(trimmed);
    const twoDecimals = /[.,]\d{2}\b/.test(trimmed);
    return value !== undefined && (value >= 50 || (twoDecimals && value >= 0.5)) ? [value] : [];
  });
}

function inferArithmeticSummary(amounts: readonly number[]): { subtotal: number; vat: number; total: number } | undefined {
  const MAX_CANDIDATES = 48;
  const MAX_OUTER = 24;
  const unique = [...new Set(amounts.map((value) => Math.round(value * 100) / 100))]
    .sort((left, right) => right - left)
    .slice(0, MAX_CANDIDATES);
  const outer = unique.slice(0, MAX_OUTER);
  const valid: Array<{ subtotal: number; vat: number; total: number }> = [];
  for (const total of outer) {
    for (const subtotal of unique) {
      if (subtotal >= total) continue;
      const vat = Math.round((total - subtotal) * 100) / 100;
      if (!unique.some((candidate) => summaryAmountsCloseEnough(candidate, vat))) continue;
      const rate = subtotal > 0 ? vat / subtotal : 0;
      if (rate < 0.03 || rate > 0.35) continue;
      valid.push({ subtotal, vat, total });
      if (valid.length >= 12) break;
    }
    if (valid.length >= 12) break;
  }
  return valid.sort((left, right) => right.total - left.total)[0];
}

function amountFromValue(value: number, lines: readonly DocumentLayoutLine[], reason: string): DocumentEvidence<number> | undefined {
  const line = lines.find((entry) => summaryAmountsCloseEnough(parseDocumentAmount(entry.text) ?? Number.NaN, value));
  if (!line) return undefined;
  return amountEvidence(line.text, [line], reason);
}

function extractTaxSummaries(lines: readonly DocumentLayoutLine[]): StructuredTaxSummary[] {
  return lines.flatMap((line) => {
    const text = normalizeDocumentText(line.text);
    if (looksLikeInternationalTaxIdentifier(line.text) || hasFiscalIdentifierLabel(line.text)) return [];
    if (isVatExcludedLanguage(line.text)) return [];
    if (!matchesDocumentLabel(line.text, 'vatRate') && !/\b(?:iva|vat|tva|mwst|ust|esente|non imponibile|reverse charge)\b/.test(text)) return [];
    const rate = percentEvidence(line.text, [line], 'tax_summary_rate');
    const amounts = [...line.text.matchAll(/(?:EUR|USD|GBP|CHF|€|\$|£)?\s*-?\d[\d\s.,]*\d/g)]
      .map((match) => amountEvidence(match[0], [line], 'tax_summary_amount'))
      .filter((value): value is DocumentEvidence<number> => !!value);
    const natureMatch = line.text.match(/\b(esente|non imponibile|reverse charge|N\.?\s*\d(?:\.\d+)?)\b/i);
    if (!rate && !natureMatch && amounts.length === 0) return [];
    const entry: StructuredTaxSummary = {
      ...(rate ? { vatRate: rate } : {}),
      ...(natureMatch ? { vatNature: textEvidence(natureMatch[0], [line], 'tax_nature_label') } : {}),
      ...(amounts.length >= 2 ? { taxableAmount: amounts.at(-2), vatAmount: amounts.at(-1) } : amounts.length === 1 ? { vatAmount: amounts[0] } : {}),
      pageIndex: line.pageIndex,
      requiresReview: !rate && !natureMatch,
    };
    return [entry];
  });
}

function sourceInconsistencyConflicts(
  subtotal: DocumentEvidence<number> | undefined,
  vatAmount: DocumentEvidence<number> | undefined,
  total: DocumentEvidence<number> | undefined,
  taxSummaries: readonly StructuredTaxSummary[],
  discountTotal?: DocumentEvidence<number>,
  shippingCost?: DocumentEvidence<number>,
): string[] {
  const conflicts: string[] = [];
  const printedSubtotal = subtotal?.normalizedValue;
  const printedVat = vatAmount?.normalizedValue;
  const printedTotal = total?.normalizedValue;
  if (printedSubtotal !== undefined && printedVat !== undefined && printedTotal !== undefined) {
    const expected = printedSubtotal + printedVat + (shippingCost?.normalizedValue ?? 0) + (discountTotal?.normalizedValue ?? 0);
    if (Math.abs(expected - printedTotal) > Math.max(1, printedTotal * 0.02)) {
      conflicts.push('source_inconsistency_warning');
    }
  }
  const recapVat = taxSummaries
    .map((entry) => entry.vatAmount?.normalizedValue)
    .filter((value): value is number => value !== undefined && value > 1);
  if (printedVat !== undefined && recapVat.length >= 2) {
    const recapSum = recapVat.reduce((sum, value) => sum + value, 0);
    const recapMatchesPrimary = recapVat.some((value) => Math.abs(value - printedVat) < 0.06)
      || Math.abs(recapSum - printedVat) < 0.06;
    if (!recapMatchesPrimary && Math.abs(recapSum - printedVat) > 1) {
      conflicts.push('source_inconsistency_warning');
    }
  }
  if (conflicts.length) {
    logQaDocument('TotalsOwnership', {
      role: 'source_inconsistency',
      subtotal: printedSubtotal,
      vat: printedVat,
      total: printedTotal,
      recapVat,
    });
  }
  return [...new Set(conflicts)];
}

function extractSummary(ctx: ItemsTotalsContext): StructuredDocumentSummary {
  const summaryStarted = Date.now();
  vatCandidateDebugCount = 0;
  const pages = ctx.pages;
  const lines = summaryLines(pages);
  const allLines = ctx.allLines;
  logSummaryPerf('start', { lines: lines.length, allLines: allLines.length });
  const currencyLine = allLines.find((line) => /\b(EUR|USD|GBP|CHF)\b|[€$\u00a3]/.test(line.text));
  const currency = currencyLine?.text.match(/\b(EUR|USD|GBP|CHF)\b/i)?.[1]?.toUpperCase() ?? (currencyLine?.text.includes('€') ? 'EUR' : undefined);
  const amountCandidatesStarted = Date.now();
  const subtotal = labeledSubtotalFromFollowingLines(allLines)
    ?? labeledAmount(lines, /\b(?:subtotale|imponibile)\b\s*[:\-]?\s*((?:EUR|USD|GBP|CHF|€|\$|£)?\s*-?\d[\d\s.,]*\d)/i, 'labeled_subtotal');
  const vatAmountRaw = labeledAmount(lines, /\b(?:iva|vat)(?:\s+(?:importo|amount))?\b(?:\s+\d+(?:[.,]\d+)?\s*%)?\s*[:\-]?\s*((?:EUR|USD|GBP|CHF|€|\$|£)?\s*-?\d[\d\s.,]*\d)/i, 'labeled_vat_amount');
  const vatAmount = vatAmountRaw && !looksLikeVatRateCapture(vatAmountRaw.normalizedValue, vatAmountRaw.rawValue)
    ? vatAmountRaw
    : undefined;
  const labeledVat = vatAmount ?? labeledVatFromFollowingLines(allLines);
  const skipExpensiveMoneyScan = !!subtotal && !!labeledVat;
  const resolvedSubtotalRaw = subtotal ?? (skipExpensiveMoneyScan ? undefined : amountNearLabelFromContext(ctx, (text) =>
    isTaxableLabelFast(text) || fuzzyPhrase(text, 'totale imponibile'), 'geometric_taxable_amount'));
  const resolvedSubtotal = resolvedSubtotalRaw
    && Number.isInteger(resolvedSubtotalRaw.normalizedValue)
    && (resolvedSubtotalRaw.normalizedValue ?? 0) < 20
    && !/[.,]\d{2}/.test(String(resolvedSubtotalRaw.rawValue ?? ''))
    ? undefined
    : resolvedSubtotalRaw;
  const resolvedVatAmount = labeledVat
    ?? amountNearLabelFromContext(ctx, (text) => {
    if (looksLikeInternationalTaxIdentifier(text) || hasFiscalIdentifierLabel(text)) return false;
    if (isVatRateAmountAnchor(text)) return true;
    return (isVatAmountLabelFast(text) || fuzzyPhrase(text, 'totale imposta', 0.34)) && !isVatRateLine(text);
  }, 'geometric_vat_amount');
  const shippingCost = amountNearLabelFromContext(ctx, (text) =>
    isShippingOrFreightLabel(text), 'geometric_shipping_cost');
  const logisticsContribution = amountNearLabelFromContext(ctx, /\bcontributo\s+logistico\b/i, 'geometric_logistics_contribution');
  const materialTotal = amountNearLabelFromContext(ctx, /^materiale$/i, 'geometric_material_total');
  const laborTotal = amountNearLabelFromContext(ctx, /^manodopera$/i, 'geometric_labor_total');
  const externalWorkTotal = amountNearLabelFromContext(ctx, /\blavorazioni\s+esterne\b/i, 'geometric_external_work_total');
  const discountTotalRaw = amountNearLabelFromContext(ctx, (text) => {
    if (!/\b(?:discount|sconto|remise|rabatt|descuento)\b/i.test(text)) return false;
    if (detectDocumentTableColumnFast(text)) return false;
    if (/^(?:sconto|discount|remise|rabatt|descuento)\s*%?$/i.test(text.trim())) return false;
    return isExplicitDocumentDiscountLabel(text)
      || /\b(?:totale|total|documento|merci|merce|globale|document|ht|importo)\b/i.test(text)
      || /:/.test(text);
  }, 'geometric_document_discount');
  const discountLabelText = String(discountTotalRaw?.rawValue ?? '');
  const discountClass = classifyMoneyLabel(discountLabelText);
  const discountLooksLikeVat = discountTotalRaw?.normalizedValue !== undefined
    && looksLikeVatRateNotAmount(Math.abs(discountTotalRaw.normalizedValue), discountLabelText);
  type EvidenceWithNormalizedNumber = DocumentEvidence<number> & { normalizedValue: number };
  let discountTotal: EvidenceWithNormalizedNumber | undefined;
  if (
    discountTotalRaw?.normalizedValue !== undefined
    && discountClass !== 'vat_amount'
    && discountClass !== 'vat_rate'
    && discountClass !== 'labor'
    && !discountLooksLikeVat
  ) {
    const ev = discountTotalRaw;
    const normalized = ev.normalizedValue;
    if (normalized === undefined) {
      discountTotal = undefined;
    } else {
      discountTotal = {
        ...ev,
        normalizedValue: -Math.abs(normalized),
      };
    }
  } else {
    discountTotal = undefined;
  }
  if (discountTotal?.sourceLineIds?.length) {
    const valueLine = allLines.find((line) => line.id === discountTotal!.sourceLineIds.at(-1));
    const blocked = valueLine
      ? documentDiscountValueRejection(valueLine, discountTotal.normalizedValue, allLines.find((line) => line.id === discountTotal!.sourceLineIds[0]))
      : undefined;
    if (blocked) {
      logDocumentDiscountCandidate({
        rawText: String(discountTotal.rawValue ?? ''),
        parsedValue: discountTotal.normalizedValue,
        page: discountTotal.pageIndex,
        region: valueLine?.semanticRegion,
        label: discountLabelText,
        sourceLineIds: discountTotal.sourceLineIds,
        evidence: 'geometric_document_discount',
        rejectionReason: blocked,
        won: false,
      });
      discountTotal = undefined;
    } else {
      logDocumentDiscountCandidate({
        rawText: String(discountTotal.rawValue ?? ''),
        parsedValue: discountTotal.normalizedValue,
        page: discountTotal.pageIndex,
        region: valueLine?.semanticRegion,
        label: discountLabelText,
        sourceLineIds: discountTotal.sourceLineIds,
        evidence: 'geometric_document_discount',
        won: true,
      });
    }
  }
  const signedDiscount = allLines.flatMap((line) => {
    const value = parseTableAmount(line.text) ?? parseDocumentAmount(line.text);
    if (value === undefined || value >= 0) return [];
    if (!isPlausibleDocumentDiscountAmount(value, resolvedSubtotal?.normalizedValue)) return [];
    const blocked = documentDiscountValueRejection(line, value);
    logDocumentDiscountCandidate({
      rawText: line.text,
      parsedValue: value,
      page: line.pageIndex,
      region: line.semanticRegion,
      sourceLineIds: [line.id],
      evidence: 'signed_document_discount',
      rejectionReason: blocked,
      won: false,
    });
    if (blocked) return [];
    const evidence = amountEvidence(line.text, [line], 'signed_document_discount');
    return evidence ? [{
      evidence,
      page: line.pageIndex,
      y: line.boundingBox?.y ?? 0,
      x: line.boundingBox?.x ?? line.readingOrder,
      id: line.id,
    }] : [];
  }).sort((left, right) => (
    left.page - right.page
    || left.y - right.y
    || left.x - right.x
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  ));
  if (!discountTotal && signedDiscount.length === 1) {
    const ev = signedDiscount[0].evidence;
    if (ev.normalizedValue === undefined) {
      // `amountEvidence` only builds evidences with a normalized value; this guard is defensive.
    } else {
      discountTotal = { ...ev, normalizedValue: ev.normalizedValue };
    logDocumentDiscountCandidate({
      rawText: String(ev.rawValue ?? ''),
      parsedValue: ev.normalizedValue,
      page: ev.pageIndex,
      region: 'document_totals',
      sourceLineIds: ev.sourceLineIds,
      evidence: 'signed_document_discount',
      won: true,
    });
    }
  }
  if (
    discountTotal
    && !isPlausibleDocumentDiscountAmount(
      discountTotal.normalizedValue ?? 0,
      resolvedSubtotal?.normalizedValue,
    )
  ) {
    logSemanticRoleViolation({
      field: 'documentDiscount',
      fromRole: 'taxable',
      toRole: 'documentDiscount',
      value: discountTotal.normalizedValue,
      stage: 'items_totals',
      reason: 'discount_equals_or_dwarfs_subtotal',
    });
    discountTotal = undefined;
  }
  if (!discountTotal && signedDiscount.length === 1) {
    const ev = signedDiscount[0].evidence;
    if (ev.normalizedValue === undefined) {
      // Defensive guard; see block above.
    } else {
      discountTotal = { ...ev, normalizedValue: ev.normalizedValue };
    logDocumentDiscountCandidate({
      rawText: String(ev.rawValue ?? ''),
      parsedValue: ev.normalizedValue,
      page: ev.pageIndex,
      region: 'document_totals',
      sourceLineIds: ev.sourceLineIds,
      evidence: 'signed_document_discount',
      won: true,
    });
    }
  }
  const moneyResolution = resolveDocumentDiscountVsVat(([
    discountTotal?.normalizedValue !== undefined
      ? {
          rawText: String(discountTotal.rawValue ?? ''),
          label: String(discountTotal.rawValue ?? ''),
          semanticClass: 'discount' as const,
          sign: -1 as const,
          confidence: 0.7,
          value: Math.abs(discountTotal.normalizedValue),
        }
      : undefined,
    resolvedVatAmount?.normalizedValue !== undefined
      ? {
          rawText: String(resolvedVatAmount.rawValue ?? ''),
          label: String(resolvedVatAmount.rawValue ?? ''),
          semanticClass: 'vat_amount' as const,
          sign: 1 as const,
          confidence: 0.7,
          value: resolvedVatAmount.normalizedValue,
        }
      : undefined,
    resolvedSubtotal?.normalizedValue !== undefined
      ? {
          rawText: String(resolvedSubtotal.rawValue ?? ''),
          label: String(resolvedSubtotal.rawValue ?? ''),
          semanticClass: 'net_taxable' as const,
          sign: 1 as const,
          confidence: 0.7,
          value: resolvedSubtotal.normalizedValue,
        }
      : undefined,
  ] as Array<DocumentMoneyCandidate | undefined>).filter((entry): entry is DocumentMoneyCandidate => !!entry));
  if (moneyResolution.reason === 'discount_equals_vat_amount_dropped_discount') {
    discountTotal = undefined;
  }
  logSummaryPerf('amount_pairing', { ms: Date.now() - amountCandidatesStarted });
  logTotalsPerf('amount_candidates', { ms: Date.now() - amountCandidatesStarted });
  const summaryLabelsStarted = Date.now();
  const totals = lines.flatMap((line) => {
    const match = line.text.match(/\b(?:totale(?: documento| da pagare| complessivo)?|grand total|amount due|total due|total ttc|gesamtbetrag|total orden|total presupuesto)\b\s*[:\-]?\s*((?:EUR|USD|GBP|CHF|€|\$|£)?\s*-?\d[\d\s.,]*\d)/i);
    const evidence = match?.[1] ? amountEvidence(match[1], [line], 'labeled_document_total') : undefined;
    return evidence ? [{ evidence, score: totalLabelScore(line.text) + 50 }] : [];
  });
  const geometricTotalCandidates: Array<{ evidence: DocumentEvidence<number>; score: number }> = [];
  for (const pageCtx of ctx.pageContexts.values()) {
    if (ctx.timedOut()) break;
    for (const labelFeature of pageCtx.lineFeatures) {
      if (!isFinalTotalLabel(labelFeature.line.text)) continue;
      if (
        detectDocumentTableColumnFast(labelFeature.line.text) &&
        labelFeature.adjustedY >= pageCtx.headerSearchMinY &&
        labelFeature.adjustedY <= pageCtx.headerSearchMaxY
      ) {
        continue;
      }
      const box = labelFeature.line.boundingBox;
      if (!box) continue;
      const centerY = labelFeature.centerY;
      let valueLine: DocumentLayoutLine | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const valueFeature of pageCtx.lineFeatures) {
        if (valueFeature.line === labelFeature.line || valueFeature.amount === undefined) continue;
        if (isVatSummaryLabel(valueFeature.line.text) || isVatRateLine(valueFeature.line.text)) continue;
        if (looksLikeInternationalTaxIdentifier(valueFeature.line.text)) continue;
        const lineBox = valueFeature.line.boundingBox;
        if (!lineBox) continue;
        const aligned = Math.abs(valueFeature.centerY - centerY) <= Math.max(box.height, lineBox.height) * 1.8;
        const below = lineBox.y > box.y && lineBox.y - box.y <= Math.max(120, box.height * 5);
        const above = lineBox.y < box.y && box.y - lineBox.y <= Math.max(120, box.height * 5);
        if (!(aligned || below || above) || lineBox.x < box.x + box.width * 0.05) continue;
        const distance = Math.hypot(lineBox.x - (box.x + box.width), lineBox.y - box.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          valueLine = valueFeature.line;
        }
      }
      const evidence = valueLine
        ? amountEvidence(valueLine.text, [labelFeature.line, valueLine], 'geometric_document_total')
        : undefined;
      if (evidence) geometricTotalCandidates.push({ evidence, score: totalLabelScore(labelFeature.line.text) });
    }
  }
  const geometricTotal = geometricTotalCandidates.sort((left, right) => right.score - left.score)[0]?.evidence
    ?? amountNearLabelFromContext(ctx, (text) => isTotalLabelFast(text) && !isVatSummaryLabel(text), 'geometric_document_total');
  const explicitCurrencyTotals = allLines.flatMap((line) => {
    const match = line.text.match(/(?:\b(?:EUR|USD|GBP|CHF)\b|[â‚¬$\u00a3])\s*(-?\d[\d\s.,]*\d)|(-?\d[\d\s.,]*\d)\s*(?:\b(?:EUR|USD|GBP|CHF)\b|[â‚¬$\u00a3])/i);
    const rawAmount = match?.[1] ?? match?.[2];
    if (!rawAmount) return [];
    const evidence = amountEvidence(rawAmount, [line], 'currency_bearing_total_candidate');
    return evidence ? [evidence] : [];
  });
  const labelLines = allLines.filter((line) => /\b(?:totale documento|grand total|amount due|totale)\b/i.test(normalizeDocumentText(line.text)));
  const followingCurrencyTotal = [...explicitCurrencyTotals].reverse().find((candidate) => {
    const candidateLine = allLines.find((line) => line.id === candidate.sourceLineIds[0]);
    return candidateLine && labelLines.some((label) => {
      if (isVatSummaryLabel(label.text)) return false;
      if (label.pageIndex !== candidateLine.pageIndex || candidateLine.readingOrder <= label.readingOrder || candidateLine.readingOrder - label.readingOrder > 12) return false;
      if (!label.boundingBox || !candidateLine.boundingBox) return candidateLine.readingOrder - label.readingOrder <= 3;
      const labelY = label.boundingBox.y + label.boundingBox.height / 2;
      const valueY = candidateLine.boundingBox.y + candidateLine.boundingBox.height / 2;
      return Math.abs(labelY - valueY) <= Math.max(label.boundingBox.height, candidateLine.boundingBox.height) * 2;
    });
  });
  const grandTotalNearLabel: Array<{ evidence: DocumentEvidence<number>; score: number }> = [];
  for (const pageCtx of ctx.pageContexts.values()) {
    if (ctx.timedOut()) break;
    for (const labelFeature of pageCtx.lineFeatures) {
      if (!/\b(?:totale complessivo|grand total|total due|totale ordine|total ttc|gesamtbetrag)\b/i.test(labelFeature.normalizedText)) continue;
      const box = labelFeature.line.boundingBox;
      if (!box) continue;
      const labelY = labelFeature.centerY;
      let valueLine: DocumentLayoutLine | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestValue = 0;
      for (const valueFeature of pageCtx.lineFeatures) {
        if (valueFeature.line === labelFeature.line || valueFeature.amount === undefined) continue;
        if (isVatSummaryLabel(valueFeature.line.text)) continue;
        const lineBox = valueFeature.line.boundingBox;
        if (!lineBox) continue;
        const distance = Math.abs(valueFeature.centerY - labelY);
        if (distance > Math.max(200, box.height * 8)) continue;
        if (distance < bestDistance || (distance === bestDistance && (valueFeature.amount ?? 0) > bestValue)) {
          bestDistance = distance;
          bestValue = valueFeature.amount ?? 0;
          valueLine = valueFeature.line;
        }
      }
      const evidence = valueLine
        ? amountEvidence(valueLine.text, [labelFeature.line, valueLine], 'grand_total_near_label')
        : undefined;
      if (evidence) grandTotalNearLabel.push({ evidence, score: totalLabelScore(labelFeature.line.text) + 80 });
    }
  }
  logTotalsPerf('summary_labels', { count: geometricTotalCandidates.length + grandTotalNearLabel.length, ms: Date.now() - summaryLabelsStarted });
  logSummaryPerf('label_semantics', { candidates: geometricTotalCandidates.length + grandTotalNearLabel.length, ms: Date.now() - summaryLabelsStarted });
  const rankedTotals = [
    ...totals,
    ...geometricTotalCandidates,
    ...grandTotalNearLabel,
    ...(followingCurrencyTotal ? [{ evidence: followingCurrencyTotal, score: 60 }] : []),
    ...(geometricTotal ? [{ evidence: geometricTotal, score: 50 }] : []),
  ].sort((left, right) => right.score - left.score);
  const labeledTotalHit = labeledDocumentTotalHit(allLines);
  let total: DocumentEvidence<number> | undefined = labeledTotalHit?.evidence
    ?? rankedTotals[0]?.evidence
    ?? totals.at(-1)?.evidence;
  const summaryLinesAll = allLines;
  const reconciliationStarted = Date.now();
  const arithmetic = inferArithmeticSummary(monetarySummaryCandidatesFromContext(ctx));
  logTotalsPerf('arithmetic_reconciliation', { found: !!arithmetic, ms: Date.now() - reconciliationStarted });
  let subtotalValue = resolvedSubtotal?.normalizedValue;
  let vatValue = resolvedVatAmount && !looksLikeVatRateCapture(resolvedVatAmount.normalizedValue, resolvedVatAmount.rawValue)
    ? resolvedVatAmount.normalizedValue
    : undefined;
  const labeledGrandTotal = rankedTotals.find((candidate) =>
    candidate.score >= 90 && candidate.evidence.normalizedValue !== undefined)?.evidence;
  if (arithmetic) {
    const arithmeticAgreesWithLabeledTotal = labeledGrandTotal?.normalizedValue === undefined
      || summaryAmountsCloseEnough(arithmetic.total, labeledGrandTotal.normalizedValue);
    const labeledSubValue = resolvedSubtotal?.normalizedValue;
    const arithmeticAgreesWithLabeledSub = labeledSubValue === undefined
      || summaryAmountsCloseEnough(arithmetic.subtotal, labeledSubValue);
    const vatShare = arithmetic.subtotal > 0 ? arithmetic.vat / arithmetic.subtotal : 0;
    const vatLooksLikeRateShare = vatShare >= 0.04 && vatShare <= 0.28;
    if (arithmeticAgreesWithLabeledTotal && arithmeticAgreesWithLabeledSub) {
      subtotalValue = arithmetic.subtotal;
      vatValue = arithmetic.vat;
      total = amountFromValue(arithmetic.total, summaryLinesAll, 'arithmetic_total_triplet') ?? total;
    } else if (arithmeticAgreesWithLabeledTotal && labeledSubValue === undefined && vatLooksLikeRateShare) {
      subtotalValue = arithmetic.subtotal;
      vatValue = arithmetic.vat;
      total = amountFromValue(arithmetic.total, summaryLinesAll, 'arithmetic_total_triplet') ?? total;
    } else if (labeledGrandTotal === undefined && labeledSubValue === undefined) {
      subtotalValue = arithmetic.subtotal;
      vatValue = arithmetic.vat;
      total = amountFromValue(arithmetic.total, summaryLinesAll, 'arithmetic_total_triplet') ?? total;
    }
  }
  if (
    labeledTotalHit
    && total?.normalizedValue !== undefined
    && (subtotalValue === undefined || vatValue === undefined)
  ) {
    const triplet = inferTripletFromSiblingAmounts(total.normalizedValue, labeledTotalHit.siblingValues);
    if (triplet) {
      if (subtotalValue === undefined) subtotalValue = triplet.subtotal;
      if (vatValue === undefined) vatValue = triplet.vat;
    }
  }
  if (subtotalValue !== undefined && vatValue !== undefined) {
    const expected = subtotalValue + vatValue;
    const arithmeticMatch = rankedTotals.find((candidate) =>
      summaryAmountsCloseEnough(candidate.evidence.normalizedValue ?? 0, expected));
    if (arithmeticMatch) total = arithmeticMatch.evidence;
    else {
      const arithmeticAmount = allLines.flatMap((line) => {
        const value = parseDocumentAmount(line.text);
        return value !== undefined && summaryAmountsCloseEnough(value, expected)
          ? [amountEvidence(line.text, [line], 'arithmetic_total_match')]
          : [];
      }).filter((entry): entry is DocumentEvidence<number> => !!entry)[0];
      if (arithmeticAmount) total = arithmeticAmount;
    }
  }
  if (total?.normalizedValue !== undefined && vatValue !== undefined &&
      summaryAmountsCloseEnough(total.normalizedValue, vatValue)) {
    const vatGuard = vatValue;
    const alternate = [...rankedTotals]
      .filter((candidate) => (candidate.evidence.normalizedValue ?? 0) > vatGuard * 1.05 && candidate.score > 0)
      .sort((left, right) => (right.evidence.normalizedValue ?? 0) - (left.evidence.normalizedValue ?? 0))[0];
    if (alternate) total = alternate.evidence;
  }
  if (total?.normalizedValue !== undefined && vatValue !== undefined &&
    (vatValue <= 0 || vatValue >= total.normalizedValue * 0.5)) {
    logVatCandidateDebug({ selected: vatValue, rejectReason: 'vat_not_plausible_against_document_total' });
    vatValue = undefined;
  }
  if (
    vatValue === undefined &&
    arithmetic &&
    total?.normalizedValue !== undefined &&
    arithmetic.vat > 0 &&
    arithmetic.vat < total.normalizedValue * 0.5 &&
    arithmetic.subtotal < total.normalizedValue * 0.98 &&
    summaryAmountsCloseEnough(arithmetic.total, total.normalizedValue)
  ) {
    vatValue = arithmetic.vat;
    if (summaryAmountsCloseEnough(arithmetic.subtotal + arithmetic.vat, total.normalizedValue)) {
      subtotalValue = arithmetic.subtotal;
    }
  }
  if (
    arithmetic &&
    total?.normalizedValue !== undefined &&
    arithmetic.subtotal < total.normalizedValue * 0.98 &&
    arithmetic.vat > 0 &&
    arithmetic.vat < total.normalizedValue * 0.5 &&
    summaryAmountsCloseEnough(arithmetic.total, total.normalizedValue) &&
    summaryAmountsCloseEnough(arithmetic.subtotal + arithmetic.vat, total.normalizedValue)
  ) {
    const subLooksLikeVat = subtotalValue !== undefined && vatValue !== undefined
      && summaryAmountsCloseEnough(subtotalValue, vatValue);
    const subEqualsTotal = subtotalValue !== undefined
      && summaryAmountsCloseEnough(subtotalValue, total.normalizedValue);
    if (subLooksLikeVat || subEqualsTotal || subtotalValue === undefined) {
      subtotalValue = arithmetic.subtotal;
      vatValue = arithmetic.vat;
    }
  }
  const vatEqualsTotal = total?.normalizedValue !== undefined && vatValue !== undefined &&
    (vatValue >= total.normalizedValue || summaryAmountsCloseEnough(vatValue, total.normalizedValue));
  let vatAmountFinal: DocumentEvidence<number> | undefined;
  if (vatValue !== undefined && !vatEqualsTotal) {
    const fromValue = amountFromValue(
      vatValue,
      summaryLinesAll,
      arithmetic ? 'arithmetic_vat_triplet' : 'resolved_vat_amount',
    );
    vatAmountFinal = fromValue
      ?? (resolvedVatAmount && summaryAmountsCloseEnough(resolvedVatAmount.normalizedValue ?? Number.NaN, vatValue)
        ? resolvedVatAmount
        : undefined);
  }
  const taxableSubtotal = labeledAmount(allLines, /\b(?:totale\s+imponibile|taxable\s+total|total\s+taxable)\b\s*[:\-]?\s*((?:EUR|USD|GBP|CHF|€|\$|£)?\s*-?\d[\d\s.,]*\d)/i, 'explicit_taxable_total');
  const subtotalFinal = taxableSubtotal ?? (subtotalValue !== undefined
    ? (amountFromValue(
      subtotalValue,
      summaryLinesAll,
      arithmetic ? 'arithmetic_subtotal_triplet' : 'resolved_subtotal',
    ) ?? (resolvedSubtotal && summaryAmountsCloseEnough(resolvedSubtotal.normalizedValue ?? Number.NaN, subtotalValue)
      ? resolvedSubtotal
      : undefined))
    : resolvedSubtotal);
  const taxSummaries = extractTaxSummaries(lines);
  // Reverse charge / esenzione: l'IVA e' zero per legge, non e' un dato mancante.
  const zeroRatedLine = vatAmountFinal ? undefined : lines.find((line) =>
    /\b(?:reverse\s+charge|esente|non\s+imponibile)\b/i.test(line.text) ||
    /\b(?:iva|vat|tva|mwst)\b[^%]{0,12}\b0(?:[.,]0+)?\s*%/i.test(line.text));
  const vatExcluded = allLines.some((line) => isVatExcludedLanguage(line.text));
  const vatAmountCandidate = vatAmountFinal ?? (zeroRatedLine
    ? documentEvidence({
      rawValue: zeroRatedLine.text,
      normalizedValue: 0,
      lines: [zeroRatedLine],
      validationStatus: 'valid',
      reasons: ['zero_rated_vat_amount'],
      requiresReview: false,
    })
    : undefined);
  let vatAmountResolved = vatAmountCandidate
    && !vatExcluded
    && !sameAmountCannotBeTotalAndVat(vatAmountCandidate.normalizedValue, total?.normalizedValue, {
      vatLabel: String(vatAmountCandidate.rawValue ?? ''),
      totalLabel: String(total?.rawValue ?? ''),
    })
    ? vatAmountCandidate
    : undefined;
  const sourceOf = (evidence: DocumentEvidence<number> | undefined) => evidence
    ? amountSourceKey({
      pageIndex: evidence.pageIndex,
      sourceLineIds: evidence.sourceLineIds,
      boundingBox: evidence.boundingBox,
      rawToken: String(evidence.rawValue ?? ''),
    })
    : undefined;
  const subtotalSource = sourceOf(subtotalFinal);
  const vatSource = sourceOf(vatAmountResolved);
  const shippingSource = sourceOf(shippingCost);
  let exclusiveSubtotal = subtotalFinal;
  if (
    exclusiveSubtotal
    && vatAmountResolved
    && subtotalSource
    && vatSource
    && subtotalSource === vatSource
    && incompatibleAmountRoles('net_taxable', 'vat_amount')
  ) {
    exclusiveSubtotal = undefined;
  }
  if (
    exclusiveSubtotal
    && shippingCost
    && subtotalSource
    && shippingSource
    && subtotalSource === shippingSource
    && incompatibleAmountRoles('net_taxable', 'shipping')
  ) {
    exclusiveSubtotal = undefined;
  }
  if (
    exclusiveSubtotal?.normalizedValue !== undefined
    && vatAmountResolved?.normalizedValue !== undefined
    && summaryAmountsCloseEnough(exclusiveSubtotal.normalizedValue, vatAmountResolved.normalizedValue)
    && subtotalSource === vatSource
  ) {
    exclusiveSubtotal = undefined;
  }
  const totalSource = sourceOf(total);
  if (
    exclusiveSubtotal
    && total
    && subtotalSource
    && sameSourceCannotOwnSubtotalAndGrandTotal(subtotalSource, totalSource)
    && exclusiveSubtotal.normalizedValue !== undefined
    && total.normalizedValue !== undefined
    && summaryAmountsCloseEnough(exclusiveSubtotal.normalizedValue, total.normalizedValue)
  ) {
    total = undefined;
  }
  if (
    exclusiveSubtotal?.normalizedValue !== undefined
    && vatAmountResolved?.normalizedValue !== undefined
    && vatAmountResolved.normalizedValue > 0.05
    && (
      total?.normalizedValue === undefined
      || summaryAmountsCloseEnough(exclusiveSubtotal.normalizedValue, total.normalizedValue)
      || grandTotalCannotEqualSubtotalWhenVatReconciles({
        subtotal: exclusiveSubtotal.normalizedValue,
        vatAmount: vatAmountResolved.normalizedValue,
        grandTotal: total?.normalizedValue,
        explicitGrandTotal: labeledGrandTotal?.normalizedValue ?? labeledTotalHit?.evidence.normalizedValue,
      })
    )
  ) {
    const expected = Math.round((exclusiveSubtotal.normalizedValue + vatAmountResolved.normalizedValue) * 100) / 100;
    if (total?.normalizedValue === undefined || summaryAmountsCloseEnough(exclusiveSubtotal.normalizedValue, total.normalizedValue)) {
      const repaired = allLines.flatMap((line) => {
        const value = parseDocumentAmount(line.text);
        return value !== undefined && summaryAmountsCloseEnough(value, expected)
          ? [amountEvidence(line.text, [line], 'subtotal_plus_vat_rejects_subtotal_as_total')]
          : [];
      }).filter((entry): entry is DocumentEvidence<number> => !!entry)[0];
      if (repaired) total = repaired;
    }
  }
  const labeledTaxable = amountNearLabelFromContext(ctx, (text) => {
    const normalized = normalizeDocumentText(text);
    if (isPrimaryGoodsSubtotalLabel(normalized)) return false;
    return /\b(?:base\s+imponib|imponibile\s+netto|taxable\s+amount|base\s+taxable|base\s+taxable)\b/i.test(normalized);
  }, 'geometric_taxable_after_discount');
  const taxableValue = labeledTaxable?.normalizedValue ?? exclusiveSubtotal?.normalizedValue;
  if (taxableValue !== undefined && taxableValue > 0) {
    const currentVat = vatAmountResolved?.normalizedValue;
    const currentShare = currentVat !== undefined ? currentVat / taxableValue : undefined;
    const vatFromRecap = !!vatAmountResolved && (
      vatAmountResolved.reasons.some((reason) => /recap/i.test(reason))
      || vatAmountResolved.sourceLineIds.some((id) => {
        const sourceLine = allLines.find((entry) => entry.id === id);
        return sourceLine?.semanticRegion === 'tax_recap'
          || sourceLine?.semanticRegion === 'historical_recap'
          || sourceLine?.semanticRegion === 'statistical_recap';
      })
    );
    if (currentShare === undefined || currentShare < 0.04 || currentShare > 0.28 || vatFromRecap) {
      const totalX = total?.boundingBox
        ? total.boundingBox.x + total.boundingBox.width / 2
        : undefined;
      const standardRates = [0.04, 0.05, 0.1, 0.19, 0.2, 0.21, 0.22, 0.23];
      const rateDistance = (share: number) =>
        Math.min(...standardRates.map((rate) => Math.abs(share - rate)));
      const taxableY = exclusiveSubtotal?.boundingBox?.y;
      const totalY = total?.boundingBox?.y;
      const alternatives = allLines.flatMap((line) => {
        if (line.semanticRegion === 'commercial_table_body') return [];
        const value = parseTableAmount(line.text) ?? parseDocumentAmount(line.text);
        if (value === undefined || !/[.,]\d{2}/.test(line.text)) return [];
        const share = value / taxableValue;
        if (share < 0.04 || share > 0.28) return [];
        if (total?.normalizedValue !== undefined && Math.abs(value - total.normalizedValue) < 0.05) return [];
        const evidence = amountEvidence(line.text, [line], 'primary_totals_vat_share');
        if (!evidence) return [];
        const x = line.boundingBox ? line.boundingBox.x + line.boundingBox.width / 2 : 0;
        const xAlign = totalX === undefined ? 0 : Math.abs(x - totalX);
        const region = line.semanticRegion;
        const recapPenalty = (region === 'tax_recap' || region === 'historical_recap') ? 80 : 0;
        const totalsBonus = (region === 'document_totals' || region === 'table_subtotal') ? -40 : 0;
        const lineY = line.boundingBox?.y ?? 0;
        const inTotalsChain = taxableY !== undefined && totalY !== undefined
          && lineY >= Math.min(taxableY, totalY) - 48
          && lineY <= Math.max(taxableY, totalY) + 48;
        const matchedRate = standardRates.find((rate) => Math.abs(share - rate) === rateDistance(share)) ?? share;
        const amountDistance = Math.abs(value - taxableValue * matchedRate);
        return [{
          evidence,
          xAlign,
          recapPenalty: recapPenalty + totalsBonus + (inTotalsChain ? -50 : 0),
          rateDistance: rateDistance(share),
          amountDistance,
        }];
      }).sort((left, right) =>
        left.amountDistance - right.amountDistance
        || left.recapPenalty - right.recapPenalty
        || left.xAlign - right.xAlign
        || left.rateDistance - right.rateDistance);
      const best = alternatives[0];
      const second = alternatives[1];
      const unique = !!best && (!second
        || best.amountDistance + 0.5 < second.amountDistance
        || (Math.abs(best.amountDistance - second.amountDistance) <= 0.5 && best.recapPenalty < second.recapPenalty)
        || (Math.abs(best.amountDistance - second.amountDistance) <= 0.5 && best.xAlign + 24 < second.xAlign)
        || (Math.abs(best.amountDistance - second.amountDistance) <= 0.5
          && Math.abs((best.evidence.normalizedValue ?? 0) - (second.evidence.normalizedValue ?? 0)) < 0.06));
      if (unique && best) vatAmountResolved = best.evidence;
    }
  }
  total = rejectTaxablePromotedToGrandTotal({
    total,
    taxable: labeledTaxable?.normalizedValue,
    subtotal: exclusiveSubtotal?.normalizedValue,
    vatAmount: vatAmountResolved?.normalizedValue,
    stage: 'items_totals',
  });
  if (
    total
    && grandTotalCannotEqualTaxable({
      taxable: taxableValue,
      subtotal: exclusiveSubtotal?.normalizedValue,
      vatAmount: vatAmountResolved?.normalizedValue,
      grandTotal: total.normalizedValue,
    })
  ) {
    total = undefined;
  }
  const recoveredGrandTotal = recoverGrandTotalAboveTaxable({
    lines: allLines,
    taxable: taxableValue,
    parseAmount: (text) => parseTableAmount(text) ?? parseDocumentAmount(text),
    toEvidence: (raw, line, reason) => amountEvidence(raw, [line], reason),
  });
  if (
    recoveredGrandTotal
    && (
      !total
      || (taxableValue !== undefined && (total.normalizedValue ?? 0) <= taxableValue + 0.05)
    )
  ) {
    if (total) {
      logSemanticRoleViolation({
        field: 'grandTotal',
        fromRole: 'taxable',
        toRole: 'grandTotal',
        value: total.normalizedValue,
        stage: 'items_totals',
        reason: 'replaced_non_grand_total_with_amount_above_taxable',
      });
    }
    total = recoveredGrandTotal;
  }
  if (
    !vatAmountResolved
    && taxableValue !== undefined
    && taxableValue > 0
  ) {
    const recapVat = allLines.flatMap((line, index) => {
      const heading = isTaxRecapHeadingText(line.text);
      if (!heading) return [];
      const nearby = allLines.slice(index, index + 6);
      return nearby.flatMap((candidate) => {
        const value = parseTableAmount(candidate.text) ?? parseDocumentAmount(candidate.text);
        if (value === undefined || !/[.,]\d{2}/.test(candidate.text)) return [];
        const share = value / taxableValue;
        if (share < 0.04 || share > 0.28) return [];
        const evidence = amountEvidence(candidate.text, [line, candidate], 'tax_recap_document_vat');
        return evidence ? [evidence] : [];
      });
    })[0];
    if (recapVat) vatAmountResolved = recapVat;
  }
  if (
    !exclusiveSubtotal
    && resolvedSubtotal?.normalizedValue !== undefined
    && resolvedSubtotal.sourceLineIds.some((id) => {
      const line = allLines.find((entry) => entry.id === id);
      if (!line) return false;
      const normalized = normalizeDocumentText(line.text);
      return isPrimaryGoodsSubtotalLabel(normalized)
        || /\b(?:totale\s+imponibile|taxable\s+subtotal|taxable\s+amount)\b/i.test(normalized);
    })
  ) {
    exclusiveSubtotal = resolvedSubtotal;
  }
  if (!discountTotal) {
    const derived = deriveDocumentDiscountFromSurroundingTotals({
      subtotal: exclusiveSubtotal?.normalizedValue,
      shipping: shippingCost?.normalizedValue,
      vat: vatAmountResolved?.normalizedValue,
      grandTotal: total?.normalizedValue,
    });
    if (derived) {
      const ev = documentEvidence({
        rawValue: derived.value,
        normalizedValue: derived.value,
        lines: [],
        validationStatus: 'unverified',
        confidenceType: 'heuristic',
        reasons: ['arithmetic_derived', 'derived_document_discount'],
        requiresReview: true,
      });
      discountTotal = { ...ev, normalizedValue: derived.value };
      logDocumentDiscountCandidate({
        rawText: String(derived.value),
        parsedValue: derived.value,
        page: 0,
        region: 'document_totals',
        sourceLineIds: [],
        evidence: 'arithmetic_derived',
        won: true,
      });
    }
  }
  return {
    ...(materialTotal ? { materialTotal } : {}),
    ...(laborTotal ? { laborTotal } : {}),
    ...(externalWorkTotal ? { externalWorkTotal } : {}),
    ...(discountTotal ? { discountTotal } : {}),
    ...(exclusiveSubtotal ? {
      subtotal: exclusiveSubtotal,
      taxableAmount: labeledTaxable ?? exclusiveSubtotal,
    } : labeledTaxable ? { taxableAmount: labeledTaxable } : {}),
    ...(shippingCost ? { shippingCost } : {}),
    ...(logisticsContribution ? { logisticsContribution } : {}),
    ...(vatAmountResolved ? { vatAmount: vatAmountResolved } : {}),
    taxSummaries,
    ...(total ? { total } : {}),
    ...(currency && currencyLine ? { currency: documentEvidence({ rawValue: currencyLine.text, normalizedValue: currency, lines: [currencyLine], validationStatus: 'valid', reasons: ['explicit_currency'], requiresReview: false }) } : {}),
    conflicts: sourceInconsistencyConflicts(exclusiveSubtotal, vatAmountResolved, total, taxSummaries, discountTotal, shippingCost),
    requiresReview: !total || taxSummaries.some((entry) => entry.requiresReview),
  };
}

function extractConditions(
  pages: readonly StructuredDocumentPage[],
  deadline?: number,
): StructuredDocumentConditions {
  const all = pages.flatMap((page) => page.lines);
  const find = (pattern: RegExp) => all.find((line) => pattern.test(line.text));
  const nearLabel = (labelPattern: RegExp | ((text: string) => boolean), reason: string): DocumentEvidence<string> | undefined => {
    for (const page of pages) {
      if (layoutDeadlineExceeded(deadline)) return undefined;
      for (let index = 0; index < page.lines.length; index += 1) {
        if (index % ITEMS_CHECK_EVERY === 0 && layoutDeadlineExceeded(deadline)) return undefined;
        const label = page.lines[index];
        const text = normalizeDocumentText(label.text);
        if (!(labelPattern instanceof RegExp ? labelPattern.test(text) : labelPattern(text))) continue;
        const inlineSeparator = label.text.indexOf(':');
        const inlineValue = inlineSeparator >= 0 ? label.text.slice(inlineSeparator + 1).trim() : '';
        if (inlineValue) return textEvidence(inlineValue, [label], `${reason}_inline`);
        if (!label.boundingBox) continue;
        const values = page.lines.filter((line) => {
          if (!line.boundingBox || line === label || /^\s*$/.test(line.text)) return false;
          const below = line.boundingBox.y > label.boundingBox!.y &&
            line.boundingBox.y - label.boundingBox!.y < Math.max(130, label.boundingBox!.height * 5) &&
            Math.abs(line.boundingBox.x - label.boundingBox!.x) < Math.max(180, label.boundingBox!.width * 0.75);
          const right = line.boundingBox.x > label.boundingBox!.x + label.boundingBox!.width * 0.7 &&
            Math.abs(line.boundingBox.y - label.boundingBox!.y) < Math.max(35, label.boundingBox!.height * 1.5);
          return below || right;
        }).sort((left, right) => {
          const sameRowPenalty = (line: DocumentLayoutLine) =>
            Math.abs(line.boundingBox!.y - label.boundingBox!.y) < Math.max(35, label.boundingBox!.height * 1.5) ? 0 : 1;
          const penaltyDifference = sameRowPenalty(left) - sameRowPenalty(right);
          if (penaltyDifference !== 0) return penaltyDifference;
          const distance = (line: DocumentLayoutLine) => Math.hypot(
            line.boundingBox!.x - (label.boundingBox!.x + label.boundingBox!.width),
            line.boundingBox!.y - label.boundingBox!.y,
          );
          return distance(left) - distance(right);
        });
        if (values[0]) return textEvidence(values[0].text, [label, values[0]], reason);
      }
    }
    return undefined;
  };
  const paymentValue = nearLabel((text) =>
    isPaymentTermsLabel(text) || fuzzyPhrase(text, 'pagamento', 0.34),
  'payment_terms_label_value');
  const payment = all.find((line) => isPaymentTermsLabel(line.text));
  const delivery = all.find((line) => isDeliveryTermsLabel(line.text));
  const deliveryValue = nearLabel((text) => isDeliveryTermsLabel(text), 'delivery_terms_label_value');
  const deliveryDate = nearLabel((text) =>
    isDeliveryDateLabel(text) || fuzzyPhrase(text, 'data consegna', 0.34),
  'delivery_date_label_value');
  const shippingTerms = all.find((line) => /\b(?:porto\s+franco|porto\s+assegnato|freight prepaid)\b/i.test(line.text));
  const validity = find(/\b(?:validita|validity)\b/i);
  const notes = find(/\b(?:note|annotazioni)\b/i);
  const bank = find(/\b(?:iban|bic|swift|coordinate bancarie)\b/i);
  const signatures = all.filter((line) => /\b(?:firma|firmato|f\.to|signature)\b/i.test(line.text));
  return {
    ...(paymentValue ? { paymentTerms: paymentValue } : payment ? { paymentTerms: textEvidence(payment.text, [payment], 'payment_terms_label') } : {}),
    ...(deliveryDate ? { deliveryDate } : {}),
    ...(deliveryValue ? { deliveryTerms: deliveryValue } : delivery ? { deliveryTerms: textEvidence(delivery.text, [delivery], 'delivery_terms_label') } : {}),
    ...(shippingTerms ? { shippingTerms: textEvidence(shippingTerms.text, [shippingTerms], 'shipping_terms_text') } : deliveryValue ? { shippingTerms: deliveryValue } : {}),
    ...(validity ? { validity: textEvidence(validity.text, [validity], 'validity_terms_label') } : {}),
    ...(notes ? { notes: textEvidence(notes.text, [notes], 'notes_label') } : {}),
    ...(bank ? { bankDetails: textEvidence(bank.text, [bank], 'bank_details_label') } : {}),
    ...(signatures.length > 0 ? { signatures: documentEvidence({ rawValue: signatures.map((line) => line.text), normalizedValue: signatures.map((line) => line.text), lines: signatures, reasons: ['signature_signal'] }) } : {}),
  };
}

function extractShipping(
  pages: readonly StructuredDocumentPage[],
  summary: StructuredDocumentSummary,
  conditions: StructuredDocumentConditions,
): StructuredShippingSection | undefined {
  const all = pages.flatMap((page) => page.lines);
  const carrier = all.find((line) => /\b(?:bartolini|dhl|ups|fedex|gls|sda)\b/i.test(line.text));
  if (!conditions.shippingTerms && !carrier && !summary.shippingCost) return undefined;
  return {
    ...(conditions.shippingTerms ? { terms: conditions.shippingTerms } : {}),
    ...(carrier ? { carrier: textEvidence(carrier.text, [carrier], 'shipping_carrier_name') } : {}),
    ...(summary.shippingCost ? { cost: summary.shippingCost } : {}),
    requiresReview: !conditions.shippingTerms || !carrier,
  };
}

function amountsClose(a: number | undefined, b: number | undefined): boolean {
  return a !== undefined && b !== undefined && Math.abs(a - b) <= 0.05;
}

function isShippingLikeDescription(text: string): boolean {
  return /\b(?:trasporto|transport|shipping|spedizione|porto|freight|log[ií]stica)\b/i.test(text);
}

/** Collapse consecutive bilingual pairs that describe the same priced commercial line. */
function collapseBilingualDuplicateItems(items: readonly StructuredLineItem[]): StructuredLineItem[] {
  const out: StructuredLineItem[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(item);
      continue;
    }
    const prevDesc = String(prev.description?.normalizedValue ?? '');
    const desc = String(item.description?.normalizedValue ?? '');
    const sameTotal = amountsClose(prev.lineTotal?.normalizedValue, item.lineTotal?.normalizedValue);
    const bothShipping = isShippingLikeDescription(prevDesc) && isShippingLikeDescription(desc);
    if (bothShipping && (sameTotal || item.lineTotal?.normalizedValue === undefined || prev.lineTotal?.normalizedValue === undefined)) {
      // Keep the priced variant when one side lost its amount.
      if (prev.lineTotal?.normalizedValue === undefined && item.lineTotal?.normalizedValue !== undefined) {
        out[out.length - 1] = item;
      }
      continue;
    }
    out.push(item);
  }
  return out;
}

const PURE_CONTINUATION_START =
  /^(?:pour\s+\d|hors\s+pi[eè]ces|licence\s+\d|notices?\b|sch[eè]mas?\b|joints?\s+epdm|surface\s+d['’]|isolation\b|écran\b|vitesse\b|servomoteur\b|raccord\s+\d|étiquettes\b|déchargement\b|fournitures\s+et|relev[eé]s?\b|accès\s+s[eé]curis|cablage\s+armoire|comprend\b|tubes?\s+inox|automate\b)/i;

const CONTINUATION_PRODUCT_TOKEN =
  /\b(?:dossier|pack\s+maintenance|passerelle|module|pompe|vanne|c[aâ]ble|formation|armoire|kit\b|échangeur|sonde|accessoires|transport)\b/i;

function hasCommercialItemCode(item: StructuredLineItem): boolean {
  const code = item.itemCode?.normalizedValue;
  if (code && /[A-Za-z]/.test(code) && code.length >= 3) return true;
  const desc = String(item.description?.normalizedValue ?? '');
  return /\b[A-Z]{2,}[-_/][A-Z0-9]{2,}\b/.test(desc);
}

/**
 * Multipage tables often OCR continuation phrases ("Licence 12 mois…") as their own
 * numeric anchors. Merge pure continuations into the previous commercial row.
 */
function mergePureContinuationItems(items: readonly StructuredLineItem[]): StructuredLineItem[] {
  const out: StructuredLineItem[] = [];
  for (const item of items) {
    const desc = String(item.description?.normalizedValue ?? '').trim();
    const pureContinuation =
      PURE_CONTINUATION_START.test(desc) &&
      !hasCommercialItemCode(item) &&
      !(CONTINUATION_PRODUCT_TOKEN.test(desc) && desc.length > 40);
    if (pureContinuation && out.length > 0) {
      const prev = out[out.length - 1];
      if (prev.description) {
        prev.description = {
          ...prev.description,
          rawValue: `${String(prev.description.rawValue)}\n${desc}`,
          normalizedValue: `${prev.description.normalizedValue ?? ''} ${desc}`.trim(),
          sourceLineIds: [...prev.description.sourceLineIds, ...item.sourceLineIds],
          sourceLines: [...prev.description.sourceLines, ...item.sourceLines],
          reasons: [...new Set([...prev.description.reasons, 'multipage_continuation_merged'])],
        };
      }
      prev.sourceLineIds.push(...item.sourceLineIds);
      prev.sourceLines.push(...item.sourceLines);
      continue;
    }
    out.push(item);
  }
  return out;
}

function linearHeaderSlope(lines: readonly DocumentLayoutLine[]): number {
  const points = lines.flatMap((line) => line.boundingBox ? [{
    x: line.boundingBox.x + line.boundingBox.width / 2,
    y: line.boundingBox.y + line.boundingBox.height / 2,
  }] : []);
  if (points.length < 3) return 0;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  const denom = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  if (denom <= 0) return 0;
  const slope = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / denom;
  return Math.abs(slope) <= 0.08 ? slope : 0;
}

/**
 * Narrow recovery for slanted Italian tables where PREZZO NETTO is the net unit
 * price and the printed line-total/VAT lanes to its right lost their headers in OCR.
 * The row baseline is deskewed from the header slope before values are attached.
 */
function rebuildNetPriceTailTable(
  pages: readonly StructuredDocumentPage[],
  fallback: readonly StructuredLineItem[],
): StructuredLineItem[] | undefined {
  if (pages.length !== 1) return undefined;
  const page = pages[0]!;
  const lines = page.lines.filter((line) => !!line.boundingBox);
  const netHeader = lines.find((line) => /^(?:prezzo\s+netto|net\s+price)$/i.test(normalizeDocumentText(line.text)));
  const qtyHeader = lines.find((line) => detectDocumentTableColumnFast(line.text) === 'quantity');
  const descHeader = lines.find((line) => detectDocumentTableColumnFast(line.text) === 'description')
    ?? lines.filter((line) => {
      if (!line.boundingBox || !qtyHeader?.boundingBox) return false;
      const text = normalizeDocumentText(line.text);
      return /art|descr|dscr/.test(text)
        && /[a-z]{4,}/.test(text)
        && line.boundingBox.x < qtyHeader.boundingBox.x - 200
        && Math.abs(line.boundingBox.y - qtyHeader.boundingBox.y) < 45;
    }).sort((a, b) => (b.boundingBox?.x ?? 0) - (a.boundingBox?.x ?? 0))[0];
  const discountHeaders = lines.filter((line) => /^(?:sc\.?|sconto)/i.test(normalizeDocumentText(line.text)));
  if (!netHeader?.boundingBox || !qtyHeader?.boundingBox || !descHeader?.boundingBox || discountHeaders.length < 2) return undefined;

  const headerLines = [netHeader, qtyHeader, descHeader, ...discountHeaders];
  const headerBottom = Math.max(...headerLines.map((line) => line.boundingBox!.y + line.boundingBox!.height));
  const footerY = lines
    .filter((line) => line.boundingBox!.y > headerBottom + 40 && isItemsTableFooterBoundary(line.text))
    .reduce((best, line) => Math.min(best, line.boundingBox!.y), Number.POSITIVE_INFINITY);
  const effectiveFooterY = Number.isFinite(footerY) ? footerY : headerBottom + 420;
  const descX = descHeader.boundingBox.x + descHeader.boundingBox.width / 2;
  const headerSlope = linearHeaderSlope(headerLines);
  const correctedY = (line: DocumentLayoutLine) => {
    const box = line.boundingBox!;
    const centerX = box.x + box.width / 2;
    return box.y + box.height / 2 - headerSlope * (centerX - descX);
  };

  const descriptions = lines
    .filter((line) => {
      const box = line.boundingBox!;
      const centerX = box.x + box.width / 2;
      if (box.y < headerBottom + 15 || box.y >= effectiveFooterY) return false;
      if (Math.abs(centerX - descX) > 360) return false;
      if (centerX < descX - 90) return false;
      if (!/[A-Za-zÀ-ÿ]{4,}/.test(line.text)) return false;
      if (detectDocumentTableColumnFast(line.text) || isItemsTableFooterBoundary(line.text)) return false;
      if (isSubtotalLabelFast(line.text) || isTaxableLabelFast(line.text) || isTotalLabelFast(line.text)) return false;
      return true;
    })
    .sort((a, b) => correctedY(a) - correctedY(b));
  if (descriptions.length < 4 || descriptions.length > 8) return undefined;

  const netX = netHeader.boundingBox.x + netHeader.boundingBox.width / 2;
  const qtyX = qtyHeader.boundingBox.x + qtyHeader.boundingBox.width / 2;
  const numeric = lines.filter((line) => {
    const box = line.boundingBox!;
    if (box.y < headerBottom - 28 || box.y >= effectiveFooterY) return false;
    return parseTableAmount(line.text) !== undefined;
  });
  const rightCenters = numeric
    .map((line) => line.boundingBox!.x + line.boundingBox!.width / 2)
    .filter((x) => x > netX + 95)
    .sort((a, b) => a - b);
  const lanes: number[][] = [];
  for (const center of rightCenters) {
    const lane = lanes.find((entries) => Math.abs(entries.reduce((a, b) => a + b, 0) / entries.length - center) <= 42);
    if (lane) lane.push(center);
    else lanes.push([center]);
  }
  const stable = lanes.filter((entries) => entries.length >= 2)
    .map((entries) => entries.reduce((a, b) => a + b, 0) / entries.length)
    .sort((a, b) => a - b);
  if (stable.length < 2) return undefined;
  const lineTotalX = stable[0]!;
  const vatX = stable[stable.length - 1]!;

  const pickLane = (anchor: DocumentLayoutLine, targetX: number, tolerance: number, maxRowDistance = 24): DocumentLayoutLine | undefined => {
    const ay = correctedY(anchor);
    return numeric
      .filter((line) => {
        const dx = Math.abs((line.boundingBox!.x + line.boundingBox!.width / 2) - targetX);
        return dx <= tolerance && Math.abs(correctedY(line) - ay) <= maxRowDistance;
      })
      .sort((a, b) => {
        const ady = Math.abs(correctedY(a) - ay);
        const bdy = Math.abs(correctedY(b) - ay);
        const adx = Math.abs((a.boundingBox!.x + a.boundingBox!.width / 2) - targetX);
        const bdx = Math.abs((b.boundingBox!.x + b.boundingBox!.width / 2) - targetX);
        return (ady + adx * 0.12) - (bdy + bdx * 0.12);
      })[0];
  };
  const codeLines = lines.filter((line) => {
    const box = line.boundingBox!;
    const centerX = box.x + box.width / 2;
    if (box.y < headerBottom + 10 || box.y >= effectiveFooterY) return false;
    if (centerX >= descX - 100) return false;
    const token = line.text.trim();
    return token.length >= 3 && token.length <= 28 && /[A-Za-z]/.test(token) && /[0-9._-]/.test(token);
  });

  const rebuilt = descriptions.map((descriptionLine): StructuredLineItem | undefined => {
    const qtyLine = pickLane(descriptionLine, qtyX, 80);
    const priceLine = pickLane(descriptionLine, netX, 65);
    const totalLine = pickLane(descriptionLine, lineTotalX, 70);
    const vatLine = pickLane(descriptionLine, vatX, 70);
    const unitPrice = priceLine ? tableAmountEvidence(priceLine.text, [priceLine], 'net_price_tail_unit_price') : undefined;
    const lineTotal = totalLine ? tableAmountEvidence(totalLine.text, [totalLine], 'net_price_tail_line_total') : undefined;
    let quantity = qtyLine ? tableAmountEvidence(qtyLine.text, [qtyLine], 'net_price_tail_quantity') : undefined;
    if (!quantity && unitPrice?.normalizedValue !== undefined && lineTotal?.normalizedValue !== undefined
      && Math.abs(unitPrice.normalizedValue - lineTotal.normalizedValue) <= 0.05) {
      quantity = documentEvidence({ rawValue: '1', normalizedValue: 1, lines: [], validationStatus: 'unverified', reasons: ['net_price_tail_unique_quantity'], requiresReview: true });
    }
    if (!quantity && unitPrice?.normalizedValue === 0 && lineTotal?.normalizedValue === 0) {
      quantity = documentEvidence({ rawValue: '1', normalizedValue: 1, lines: [], validationStatus: 'unverified', reasons: ['net_price_tail_zero_row_quantity'], requiresReview: true });
    }
    if (!quantity || !unitPrice || !lineTotal) return undefined;
    const codeLine = [...codeLines].sort((a, b) => Math.abs(correctedY(a) - correctedY(descriptionLine)) - Math.abs(correctedY(b) - correctedY(descriptionLine)))[0];
    const sourceLines = [descriptionLine, qtyLine, priceLine, totalLine, vatLine, codeLine].filter((line): line is DocumentLayoutLine => !!line);
    const itemCode = codeLine && Math.abs(correctedY(codeLine) - correctedY(descriptionLine)) < 34
      ? textEvidence(codeLine.text, [codeLine], 'net_price_tail_item_code')
      : undefined;
    const vatValue = vatLine ? parsePlausibleVatRate(vatLine.text) : undefined;
    const vatRate = vatLine && vatValue !== undefined ? documentEvidence({ rawValue: vatLine.text, normalizedValue: vatValue, lines: [vatLine], validationStatus: 'valid', reasons: ['net_price_tail_vat_rate'], requiresReview: false }) : undefined;
    return {
      ...(itemCode ? { itemCode } : {}),
      description: textEvidence(descriptionLine.text, [descriptionLine], 'net_price_tail_description')!,
      quantity,
      unitPrice,
      ...(vatRate ? { vatRate } : {}),
      lineTotal,
      pageIndex: page.pageIndex,
      sourceLineIds: sourceLines.map((line) => line.id),
      sourceLines: sourceLines.map((line) => line.text),
      requiresReview: [quantity, unitPrice, lineTotal].some((entry) => entry.requiresReview),
    };
  }).filter((item): item is StructuredLineItem => !!item);

  if (rebuilt.length !== descriptions.length || rebuilt.length < 4) return undefined;
  const coherence = rebuilt.every((item) => {
    const q = item.quantity?.normalizedValue;
    const p = item.unitPrice?.normalizedValue;
    const t = item.lineTotal?.normalizedValue;
    return q !== undefined && p !== undefined && t !== undefined && Math.abs(q * p - t) <= Math.max(0.06, Math.abs(t) * 0.01);
  });
  if (!coherence) return undefined;
  logQaDocument('RowBandRepair', { page: page.pageIndex, reason: 'net_price_unlabeled_tail_rebuilt', rows: rebuilt.length });
  return rebuilt.length >= fallback.length ? rebuilt : undefined;
}

function normalizedComparableDescription(text: string): string {
  return normalizeDocumentText(text).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const LAGGED_ITEM_CODE = /^([A-Z][A-Z0-9]{1,23}(?:[-_/][A-Z0-9._/-]{1,24})+|[A-Z]{3,}\d[A-Z0-9-]{1,20}|SETUP)\s+(.+)$/;

/**
 * Repair a narrow OCR geometry failure where the left-most SKU/code is captured
 * one visual band later than the numeric cells. The symptom is a table with most
 * itemCode fields empty while descriptions 2..N begin with successive SKU tokens.
 * We shift only those leading codes backward, remove duplicated previous-row text,
 * and keep a terminal SHIP/FRT token as a service identity rather than description.
 */
function repairLaggedItemCodesAndDescriptions(
  items: readonly StructuredLineItem[],
  pages: readonly StructuredDocumentPage[],
): StructuredLineItem[] {
  if (items.length < 4) return [...items];
  const missingCodes = items.filter((item) => !String(item.itemCode?.normalizedValue ?? '').trim()).length;
  const laggedStarts = items.slice(1).filter((item) =>
    LAGGED_ITEM_CODE.test(String(item.description?.normalizedValue ?? '').trim())).length;
  if (missingCodes < items.length - 1 || laggedStarts < 2) return [...items];

  const allLines = pages.flatMap((page) => page.lines);
  const out = items.map((item) => ({ ...item }));
  const setDescription = (item: StructuredLineItem, value: string, reason: string) => {
    const current = item.description;
    if (!current) return;
    const clean = value.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    item.description = {
      ...current,
      rawValue: clean,
      normalizedValue: clean,
      reasons: [...new Set([...current.reasons, reason])],
    };
  };
  const setCode = (item: StructuredLineItem, code: string) => {
    if (item.itemCode?.normalizedValue) return;
    const line = allLines.find((entry) => entry.text.trim().toUpperCase() === code.toUpperCase());
    item.itemCode = line
      ? textEvidence(code, [line], 'lagged_item_code_repaired')
      : documentEvidence({
          rawValue: code,
          normalizedValue: code,
          lines: [],
          validationStatus: 'unverified',
          reasons: ['lagged_item_code_repaired'],
          requiresReview: true,
        });
  };

  for (let index = 1; index < out.length; index += 1) {
    const current = out[index]!;
    const previous = out[index - 1]!;
    let desc = String(current.description?.normalizedValue ?? '').replace(/\s+/g, ' ').trim();
    const leading = desc.match(LAGGED_ITEM_CODE);
    if (leading) {
      const code = leading[1]!;
      const previousCode = String(previous.itemCode?.normalizedValue ?? '');
      if (!previousCode) {
        setCode(previous, code);
        desc = leading[2]!;
      } else if (previousCode.toUpperCase() === code.toUpperCase()) {
        desc = leading[2]!;
      }
    }

    const previousDesc = String(previous.description?.normalizedValue ?? '').trim();
    const comparablePrev = normalizedComparableDescription(previousDesc);
    const comparableDesc = normalizedComparableDescription(desc);
    if (comparablePrev && comparableDesc.startsWith(comparablePrev + ' ')) {
      const prevWords = previousDesc.replace(/\s+/g, ' ').trim().split(' ').length;
      desc = desc.split(/\s+/).slice(prevWords).join(' ').trim();
    }

    const ownLeading = desc.match(LAGGED_ITEM_CODE);
    if (ownLeading && !current.itemCode?.normalizedValue) {
      setCode(current, ownLeading[1]!);
      desc = ownLeading[2]!;
    }
    desc = desc.replace(/\s+(?:SHIP|FRT)$/i, '').trim();
    setDescription(current, desc, 'lagged_row_description_repaired');
  }
  return out;
}

function cloneItemEvidence<T>(value: T | undefined): T | undefined {
  if (!value || typeof value !== 'object') return value;
  return { ...(value as Record<string, unknown>) } as T;
}

/**
 * Detect a one-row lag where each row description starts with the COMPLETE
 * previous description while item codes are shifted one row down.  This is a
 * generic geometry failure: require a chain of at least 3 overlaps before any
 * repair is applied.
 */
function repairLaggedCodeDescriptionChain(items: readonly StructuredLineItem[]): StructuredLineItem[] {
  if (items.length < 4) return [...items];
  const descriptions = items.map((item) => String(item.description?.normalizedValue ?? '').replace(/\s+/g, ' ').trim());
  const segments: string[] = [];
  segments[0] = descriptions[0] ?? '';
  let chainEnd = 0;
  for (let index = 1; index < descriptions.length; index += 1) {
    const carry = segments[index - 1] ?? '';
    const current = descriptions[index] ?? '';
    const carryComparable = normalizedComparableDescription(carry);
    const currentComparable = normalizedComparableDescription(current);
    if (!carryComparable || !currentComparable.startsWith(carryComparable + ' ')) break;
    const carryWords = carry.split(/\s+/).filter(Boolean).length;
    const tail = current.split(/\s+/).slice(carryWords).join(' ').trim();
    if (!tail) break;
    segments[index] = tail;
    chainEnd = index;
  }
  if (chainEnd < 3) return [...items];
  const firstMissingCode = !String(items[0]?.itemCode?.normalizedValue ?? '').trim();
  const shiftedCodesPresent = items.slice(1, chainEnd + 2).filter((item) => String(item.itemCode?.normalizedValue ?? '').trim()).length;
  if (!firstMissingCode || shiftedCodesPresent < Math.min(3, chainEnd)) return [...items];

  const out = items.map((item) => ({ ...item }));
  const originalCodes = items.map((item) => cloneItemEvidence(item.itemCode));
  for (let index = 0; index <= chainEnd; index += 1) {
    out[index]!.itemCode = originalCodes[index + 1];
  }
  if (out[chainEnd + 1]) out[chainEnd + 1]!.itemCode = undefined;

  for (let index = 1; index <= chainEnd; index += 1) {
    const tail = segments[index] ?? '';
    if (!tail || !out[index]!.description) continue;
    out[index]!.description = {
      ...out[index]!.description!,
      rawValue: tail,
      normalizedValue: tail,
      reasons: [...new Set([...out[index]!.description!.reasons, 'lagged_description_chain_repaired'])],
      requiresReview: true,
    };
    out[index]!.requiresReview = true;
  }
  return out;
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * If q * unitPrice (after discount) contradicts the observed line total, look
 * for an OBSERVED numeric cell on the same visual row in the established unit
 * price lane.  Never derive/persist a synthetic price; replacement must come
 * from an OCR line and must satisfy the row arithmetic.
 */
function repairArithmeticUnitPriceFromObservedLane(
  items: readonly StructuredLineItem[],
  pages: readonly StructuredDocumentPage[],
): StructuredLineItem[] {
  const out = items.map((item) => ({ ...item }));
  const priceLaneByPage = new Map<number, number>();
  for (const page of pages) {
    const centers = items
      .filter((item) => item.pageIndex === page.pageIndex && item.unitPrice?.boundingBox)
      .filter((item) => {
        const q = item.quantity?.normalizedValue;
        const p = item.unitPrice?.normalizedValue;
        const t = item.lineTotal?.normalizedValue;
        const d = item.discount?.normalizedValue ?? 0;
        if (q === undefined || p === undefined || t === undefined || q <= 0) return true;
        const expected = q * p * (1 - Math.min(100, Math.max(0, d)) / 100);
        return Math.abs(expected - t) <= Math.max(0.08, Math.abs(t) * 0.015);
      })
      .map((item) => item.unitPrice!.boundingBox!.x + item.unitPrice!.boundingBox!.width / 2);
    const lane = median(centers);
    if (lane !== undefined) priceLaneByPage.set(page.pageIndex, lane);
  }

  for (let index = 0; index < out.length; index += 1) {
    const item = out[index]!;
    const q = item.quantity?.normalizedValue;
    const p = item.unitPrice?.normalizedValue;
    const t = item.lineTotal?.normalizedValue;
    const d = item.discount?.normalizedValue ?? 0;
    if (q === undefined || p === undefined || t === undefined || q <= 0) continue;
    const factor = 1 - Math.min(100, Math.max(0, d)) / 100;
    if (factor <= 0) continue;
    const expected = q * p * factor;
    if (Math.abs(expected - t) <= Math.max(0.08, Math.abs(t) * 0.015)) continue;
    const target = t / (q * factor);
    const laneX = priceLaneByPage.get(item.pageIndex);
    const rowBox = item.lineTotal?.boundingBox ?? item.quantity?.boundingBox ?? item.unitPrice?.boundingBox;
    const page = pages.find((candidate) => candidate.pageIndex === item.pageIndex);
    if (!page || laneX === undefined || !rowBox) continue;
    const rowY = rowBox.y + rowBox.height / 2;
    const candidate = page.lines
      .filter((line) => line.boundingBox)
      .map((line) => ({ line, value: parseTableAmount(line.text) }))
      .filter((entry): entry is { line: DocumentLayoutLine; value: number } => entry.value !== undefined)
      .filter(({ line, value }) => {
        const box = line.boundingBox!;
        const centerX = box.x + box.width / 2;
        const centerY = box.y + box.height / 2;
        return Math.abs(centerY - rowY) <= 34 && Math.abs(centerX - laneX) <= 95 &&
          Math.abs(value - target) <= Math.max(0.02, Math.abs(target) * 0.015);
      })
      .sort((a, b) => {
        const ax = Math.abs((a.line.boundingBox!.x + a.line.boundingBox!.width / 2) - laneX);
        const bx = Math.abs((b.line.boundingBox!.x + b.line.boundingBox!.width / 2) - laneX);
        return Math.abs(a.value - target) - Math.abs(b.value - target) || ax - bx;
      })[0];
    if (!candidate) continue;
    const repaired = tableAmountEvidence(candidate.line.text, [candidate.line], 'table_unit_price_arithmetic_lane_repair');
    if (!repaired) continue;
    repaired.reasons = [...new Set([...repaired.reasons, 'observed_price_lane_matches_quantity_total'])];
    repaired.requiresReview = false;
    repaired.validationStatus = 'valid';
    item.unitPrice = repaired;
    item.requiresReview = [item.quantity, item.unitPrice, item.lineTotal, item.discount, item.vatRate]
      .some((entry) => !!entry?.requiresReview);
  }
  return out;
}

function recoverArithmeticRowsFromDetectedTables(
  pages: readonly StructuredDocumentPage[],
): StructuredLineItem[] {
  const recovered: StructuredLineItem[] = [];
  const isCode = (text: string) => {
    const token = text.replace(/\s+/g, '').trim();
    return /^(?:[A-Z]{2,8}\d{3,14}|[A-Z0-9]{2,10}(?:[-_/][A-Z0-9]{2,14})+)$/i.test(token);
  };
  const isQuantityToken = (text: string, value: number) =>
    value > 0 && value <= 100_000 &&
    /^\s*\d{1,6}(?:[.,]0+)?\s*$/.test(text) &&
    !/[€$£%]/.test(text);
  const isDescriptionLine = (line: DocumentLayoutLine) => {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (!text || text.length < 4) return false;
    if (detectDocumentTableColumnFast(text)) return false;
    if (parseTableAmount(text) !== undefined) return false;
    if (isUnitOfMeasureToken(text)) return false;
    if (isCode(text)) return false;
    if (/^(?:RDM|CND|UB|DU)\b/i.test(text)) return false;
    if (/^(?:(?:pz\s*\/\s*cf)(?:\s+q\.?\s*ta'?)?|q\.?\s*ta'?|euro|eur|usd|gbp|chf)$/i.test(text)) return false;
    if (/(?:profondit[aà]|lunghezza\s+di\s+incisione)\b/i.test(text)) return false;
    if (isItemsTableFooterBoundary(text)) return false;
    return /[A-Za-zÀ-ÿ]/.test(text);
  };

  for (const page of pages) {
    const zones = page.zones.filter((zone) => zone.classification === 'items_table');
    for (const zone of zones) {
      const ids = new Set(zone.lineIds);
      const lines = page.lines
        .filter((line) => ids.has(line.id))
        .sort((a, b) => a.readingOrder - b.readingOrder);

      // Geometry-first recovery. OCR reading order is not guaranteed to follow
      // table columns; group cells by visual row and solve q * price ~= total
      // independently of readingOrder. This runs only after normal extraction
      // returned zero rows and only inside a positively detected items table.
      const boxed = lines.filter((line) => !!line.boundingBox);
      const bands: DocumentLayoutLine[][] = [];
      for (const line of boxed.sort((a, b) => (a.boundingBox!.y - b.boundingBox!.y) || (a.boundingBox!.x - b.boundingBox!.x))) {
        const cy = line.boundingBox!.y + line.boundingBox!.height / 2;
        const band = bands.find((candidate) => {
          const first = candidate[0]!.boundingBox!;
          const by = first.y + first.height / 2;
          return Math.abs(cy - by) <= Math.max(12, Math.min(28, Math.max(first.height, line.boundingBox!.height) * 0.9));
        });
        if (band) band.push(line); else bands.push([line]);
      }
      for (const band of bands) {
        const row = [...band].sort((a, b) => a.boundingBox!.x - b.boundingBox!.x);
        const numeric = row.map((line) => ({ line, value: parseTableAmount(line.text) }))
          .filter((entry): entry is { line: DocumentLayoutLine; value: number } => entry.value !== undefined && !/%/.test(entry.line.text));
        let solved: { q: typeof numeric[number]; p: typeof numeric[number]; t: typeof numeric[number] } | undefined;
        for (let i = 0; i < numeric.length && !solved; i += 1) {
          const q = numeric[i]!;
          if (!isQuantityToken(q.line.text, q.value)) continue;
          for (let j = i + 1; j < numeric.length && !solved; j += 1) {
            const p = numeric[j]!;
            if (p.value < 0 || p.value > 1_000_000) continue;
            for (let k = j + 1; k < numeric.length; k += 1) {
              const t = numeric[k]!;
              const tolerance = Math.max(0.06, Math.abs(t.value) * 0.003);
              if (Math.abs(q.value * p.value - t.value) <= tolerance) { solved = { q, p, t }; break; }
            }
          }
        }
        if (!solved) continue;
        const descriptionLines = row.filter((line) =>
          line.boundingBox!.x < solved!.q.line.boundingBox!.x && isDescriptionLine(line));
        if (descriptionLines.length === 0) continue;
        const descriptionText = descriptionLines.map((line) => line.text.replace(/\s+/g, ' ').trim()).join(' ').trim();
        if (descriptionText.length < 4) continue;
        const quantityEvidence = tableAmountEvidence(solved.q.line.text, [solved.q.line], 'arithmetic_geometry_recovery_quantity');
        const unitPriceEvidence = tableAmountEvidence(solved.p.line.text, [solved.p.line], 'arithmetic_geometry_recovery_unit_price');
        const lineTotalEvidence = tableAmountEvidence(solved.t.line.text, [solved.t.line], 'arithmetic_geometry_recovery_line_total');
        if (!quantityEvidence || !unitPriceEvidence || !lineTotalEvidence) continue;
        const description = documentEvidence({
          rawValue: descriptionText, normalizedValue: descriptionText, lines: descriptionLines,
          validationStatus: 'unverified', reasons: ['arithmetic_geometry_recovery_description'], requiresReview: true,
        });
        recovered.push({
          description, quantity: quantityEvidence, unitPrice: unitPriceEvidence, lineTotal: lineTotalEvidence,
          pageIndex: page.pageIndex, sourceLineIds: row.map((line) => line.id), sourceLines: row.map((line) => line.text), requiresReview: true,
        });
      }
      // Geometry recovery can solve only a subset of rows on sparse or weak-schema
      // tables. Continue with bounded reading-order recovery and de-duplicate by
      // overlapping source cells instead of abandoning the remaining rows.
      let previousRowEnd = -1;
      for (let qi = 0; qi < lines.length; qi += 1) {
        const quantityLine = lines[qi]!;
        const quantity = parseTableAmount(quantityLine.text);
        if (quantity === undefined || !isQuantityToken(quantityLine.text, quantity)) continue;

        let matched:
          | { priceIndex: number; totalIndex: number; price: number; total: number }
          | undefined;
        const searchEnd = Math.min(lines.length, qi + 8);
        for (let pi = qi + 1; pi < searchEnd && !matched; pi += 1) {
          const priceLine = lines[pi]!;
          if (/%/.test(priceLine.text)) continue;
          const price = parseTableAmount(priceLine.text);
          if (price === undefined || price < 0 || price > 1_000_000) continue;
          for (let ti = pi + 1; ti < Math.min(lines.length, pi + 5); ti += 1) {
            const totalLine = lines[ti]!;
            if (/%/.test(totalLine.text)) continue;
            const total = parseTableAmount(totalLine.text);
            if (total === undefined || total < 0) continue;
            const expected = quantity * price;
            const tolerance = Math.max(0.06, Math.abs(total) * 0.003);
            if (Math.abs(expected - total) <= tolerance) {
              matched = { priceIndex: pi, totalIndex: ti, price, total };
              break;
            }
          }
        }
        if (!matched) continue;

        const lookbackStart = Math.max(previousRowEnd + 1, qi - 20, 0);
        const prefix = lines.slice(lookbackStart, qi);
        const codeLine = [...prefix].reverse().find((line) => isCode(line.text));
        const descriptionLines = prefix.filter(isDescriptionLine);
        if (descriptionLines.length === 0) continue;
        const descriptionText = descriptionLines
          .map((line) => line.text.replace(/\s+/g, ' ').trim())
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (descriptionText.length < 6) continue;

        const unitCarrier = lines.slice(qi + 1, matched.priceIndex + 1).find((line) =>
          /^\s*\d+(?:[.,]0+)?\s*(?:pz|pcs|pc|cf|kg|ml|lt|hr|ore|mq|udm|h)\s*$/i.test(line.text));
        const unitMatch = unitCarrier?.text.match(/(?:^|\s)(pz|pcs|pc|cf|kg|ml|lt|hr|ore|mq|udm|h)\s*$/i);
        const source = lines.slice(lookbackStart, matched.totalIndex + 1);
        const quantityEvidence = tableAmountEvidence(quantityLine.text, [quantityLine], 'arithmetic_table_recovery_quantity');
        const unitPriceEvidence = tableAmountEvidence(lines[matched.priceIndex]!.text, [lines[matched.priceIndex]!], 'arithmetic_table_recovery_unit_price');
        const lineTotalEvidence = tableAmountEvidence(lines[matched.totalIndex]!.text, [lines[matched.totalIndex]!], 'arithmetic_table_recovery_line_total');
        const description = documentEvidence({
          rawValue: descriptionText,
          normalizedValue: descriptionText,
          lines: descriptionLines,
          validationStatus: 'unverified',
          reasons: ['arithmetic_table_recovery_description'],
          requiresReview: true,
        });
        const itemCode = codeLine
          ? documentEvidence({
              rawValue: codeLine.text,
              normalizedValue: codeLine.text.replace(/\s+/g, '').trim(),
              lines: [codeLine],
              validationStatus: 'unverified',
              reasons: ['arithmetic_table_recovery_item_code'],
              requiresReview: true,
            })
          : undefined;
        const unit = unitCarrier && unitMatch
          ? documentEvidence({
              rawValue: unitCarrier.text,
              normalizedValue: unitMatch[1]!.toLowerCase(),
              lines: [unitCarrier],
              validationStatus: 'unverified',
              reasons: ['arithmetic_table_recovery_unit'],
              requiresReview: true,
            })
          : undefined;
        if (!quantityEvidence || !unitPriceEvidence || !lineTotalEvidence) continue;
        recovered.push({
          ...(itemCode ? { itemCode } : {}),
          description,
          quantity: quantityEvidence,
          ...(unit ? { unit } : {}),
          unitPrice: unitPriceEvidence,
          lineTotal: lineTotalEvidence,
          pageIndex: page.pageIndex,
          sourceLineIds: source.map((line) => line.id),
          sourceLines: source.map((line) => line.text),
          requiresReview: true,
        });
        previousRowEnd = matched.totalIndex;
        qi = matched.totalIndex;
      }
    }
  }
  const uniqueRecovered = recovered.filter((item, index, all) => {
    const ids = new Set(item.sourceLineIds);
    return !all.slice(0, index).some((prior) => {
      if (prior.pageIndex !== item.pageIndex) return false;
      let shared = 0;
      for (const id of prior.sourceLineIds) if (ids.has(id)) shared += 1;
      return shared >= 3;
    });
  });
  if (uniqueRecovered.length > 0) {
    logQaDocument('RowBandRepair', {
      reason: 'arithmetic_table_recovery_after_zero_rows',
      rows: uniqueRecovered.length,
    });
  }
  return uniqueRecovered;
}

function pruneNonCommercialLineItems(
  items: readonly StructuredLineItem[],
  summary: StructuredDocumentSummary,
): StructuredLineItem[] {
  const subtotal = summary.subtotal?.normalizedValue;
  const vat = summary.vatAmount?.normalizedValue;
  const total = summary.total?.normalizedValue;
  return items.filter((item, candidateRowIndex) => {
    const desc = String(item.description?.normalizedValue ?? '');
    const code = String(item.itemCode?.normalizedValue ?? '').trim();
    const snippet = desc.slice(0, 48);
    const drop = (reason: string): false => {
      if (isQaDocumentLoggingEnabled() || isDevLogEnabled()) {
        logQaDocument('ItemPruneDrop', {
          candidateRowIndex,
          descriptionSnippet: snippet,
          reason,
        });
      }
      return false;
    };
    if (/^SHIP$/i.test(code) && isServiceChargeIdentity(code)) {
      return drop('freight_ship_code');
    }
    if (isCarryForwardText(desc) || isHistoricalOrStatisticalRecapText(desc) || isSummaryOrAggregateHeading(desc)) {
      logQaDocument('RecapExcluded', { descriptionSnippet: snippet, reason: 'recap_or_carry_forward' });
      return drop('recap_or_carry_forward');
    }
    if (/^[•·▪]/.test(desc.trim())) return drop('empty');
    if (isNonCommercialItemDescription(desc) && !isPersistableCommercialItem(persistableInputFromStructuredItem(item))) {
      return drop('noncommercial');
    }
    const qty = item.quantity?.normalizedValue;
    const price = item.unitPrice?.normalizedValue;
    const lineTotal = item.lineTotal?.normalizedValue;
    const persistable = isPersistableCommercialItem(persistableInputFromStructuredItem(item));
    const hasQtyPricePair = qty !== undefined && qty > 0 && price !== undefined;
    const commercialNumeric =
      hasCommercialItemCode(item) ||
      (hasQtyPricePair && price > 0);
    if (isSummaryRow({ pageIndex: item.pageIndex, y: 0, lines: item.sourceLines.map((text, index) => ({
      id: `${item.pageIndex}:prune:${index}`,
      text,
      confidence: 0,
      pageIndex: item.pageIndex,
      readingOrder: index,
    })) })) {
      if (item.vatNature && (lineTotal !== undefined || commercialNumeric)) return true;
      if (hasQtyPricePair && lineTotal !== undefined && lineTotal > 0) return true;
      if (hasCommercialItemCode(item) && (lineTotal !== undefined || persistable)) return true;
      if (persistable && hasQtyPricePair && (price === 0 || lineTotal === 0)) return true;
      return drop('totals');
    }
    if (amountsClose(lineTotal, vat) && !amountsClose(lineTotal, total)) {
      if (hasQtyPricePair) return true;
      return drop('totals');
    }
    if (amountsClose(lineTotal, total)) {
      if (isLegalOrBankFooterText(desc) || isNonCommercialItemDescription(desc)) return drop('footer');
      if (!hasQtyPricePair && !hasCommercialItemCode(item)) return drop('totals');
      const looksLikeTotalRow = /^(?:totale|total|grand total|importo)\b/i.test(desc.trim());
      if (looksLikeTotalRow) return drop('totals');
      return true;
    }
    if (amountsClose(lineTotal, subtotal)) {
      if (hasQtyPricePair || hasCommercialItemCode(item)) return true;
      return drop('totals');
    }
    if (persistable) return true;
    return true;
  });
}

export function extractDocumentItemsAndTotals(
  pages: readonly StructuredDocumentPage[],
  options?: ExtractItemsTotalsOptions,
): ItemsTotalsExtraction {
  const lineCount = pages.reduce((sum, page) => sum + page.lines.length, 0);
  logItemsPerf('start', { pages: pages.length, lines: lineCount });
  const started = Date.now();
  documentProcessPerfStageStart('build_items_context', { inputLineCount: lineCount });
  const ctx = buildItemsTotalsContext(pages, options);
  documentProcessPerfStageEnd('build_items_context', { inputLineCount: lineCount });
  logItemsCallPerf('buildContext', { ms: Date.now() - started });

  const itemsStarted = Date.now();
  documentProcessPerfStageStart('item_candidate_generation', { inputLineCount: lineCount });
  const extractedItems = extractItems(ctx);
  // Final bounded safety net: when layout positively found an items table but
  // the geometric binder produced zero rows, recover only rows whose numeric
  // cells satisfy quantity × unit price ≈ line total. This is deliberately
  // conservative and does not run when normal extraction already succeeded.
  const recoveredArithmeticItems = extractedItems.length === 0
    ? recoverArithmeticRowsFromDetectedTables(pages)
    : [];
  const candidateItems = extractedItems.length > 0 ? extractedItems : recoveredArithmeticItems;
  const rawItems = rebuildNetPriceTailTable(pages, candidateItems) ?? candidateItems;
  documentProcessPerfStageEnd('item_candidate_generation', {
    inputLineCount: lineCount,
    outputCandidateCount: rawItems.length,
  });
  logItemsPerf('items_extracted', { count: rawItems.length, ms: Date.now() - itemsStarted });

  const totalsStarted = Date.now();
  // Items may consume the shared process budget. Totals still get a bounded
  // slice so HT/TVA/TTC are not dropped after a successful table parse.
  const summaryDeadline = options?.deadline === undefined
    ? undefined
    : layoutDeadlineExceeded(options.deadline)
      ? Date.now() + Math.min(ITEMS_COMPLETION_BUDGET_MS, 800)
      : options.deadline;
  documentProcessPerfStageStart('totals_candidate_extraction', { inputLineCount: lineCount });
  const summary = extractSummary({
    ...ctx,
    deadline: summaryDeadline,
    timedOut: () => layoutDeadlineExceeded(summaryDeadline),
  });
  documentProcessPerfStageEnd('totals_candidate_extraction', {
    outputCandidateCount: [summary.subtotal, summary.vatAmount, summary.total].filter(Boolean).length,
  });
  logTotalsPerf('summary_complete', { ms: Date.now() - totalsStarted });

  documentProcessPerfStageStart('multiline_description_merge', { inputLineCount: rawItems.length });
  const collapsedItems = collapseBilingualDuplicateItems(rawItems);
  const mergedItems = mergePureContinuationItems(collapsedItems);
  const laggedRepairedItems = repairLaggedItemCodesAndDescriptions(mergedItems, pages);
  const rowBoundaryRepairedItems = repairLaggedCodeDescriptionChain(laggedRepairedItems);
  const arithmeticPriceRepairedItems = repairArithmeticUnitPriceFromObservedLane(rowBoundaryRepairedItems, pages);
  documentProcessPerfStageEnd('multiline_description_merge', { outputCandidateCount: arithmeticPriceRepairedItems.length });
  documentProcessPerfStageStart('item_prune_drop', { inputLineCount: arithmeticPriceRepairedItems.length });
  const prunedItems = pruneNonCommercialLineItems(arithmeticPriceRepairedItems, summary);
  const pageLines = pages.flatMap((page) => page.lines.map((line) => line.text));

  const selectPersistableItems = (
    candidates: readonly StructuredLineItem[],
  ): StructuredLineItem[] =>
    selectCoherentCommercialLevel(
      candidates.map((item) => ({
        item,
        description: item.description?.normalizedValue,
        sourceLines: item.sourceLines,
        quantity: item.quantity?.normalizedValue,
        unitPrice: item.unitPrice?.normalizedValue,
        lineTotal: item.lineTotal?.normalizedValue,
      })),
      pageLines,
      summary.total?.normalizedValue,
    )
      .map((entry) => entry.item)
      .filter((item) =>
        isPersistableCommercialItem(persistableInputFromStructuredItem(item)),
      );

  let items = selectPersistableItems(prunedItems);

  // Second-chance recovery: normal extraction may create candidates which are
  // later removed by commercial pruning. If the FINAL result is empty but an
  // items table was positively detected, retry the conservative arithmetic
  // recovery. No document-specific rules are used: recovered rows still must
  // satisfy quantity * unitPrice ~= lineTotal and pass normal persistence checks.
  if (items.length === 0) {
    const recoveredAfterPrune = recoverArithmeticRowsFromDetectedTables(pages);

    if (recoveredAfterPrune.length > 0) {
      const recoveredPruned = pruneNonCommercialLineItems(
        recoveredAfterPrune,
        summary,
      );

      items = selectPersistableItems(recoveredPruned);
    }
  }
  documentProcessPerfStageEnd('item_prune_drop', { outputCandidateCount: items.length });
  const discountValue = summary.discountTotal?.normalizedValue;
  const summaryWithoutStolenLineTotal = discountValue !== undefined
    && items.some((item) => {
      const lineTotal = item.lineTotal?.normalizedValue;
      return lineTotal !== undefined
        && Math.abs(Math.abs(lineTotal) - Math.abs(discountValue)) <= 0.05;
    })
    ? { ...summary, discountTotal: undefined }
    : summary;

  const conditionsStarted = Date.now();
  const conditions = ctx.timedOut() ? {} : extractConditions(pages, options?.deadline);
  logItemsPostPerf('conditions', { ms: Date.now() - conditionsStarted });

  const shippingStarted = Date.now();
  const shipping = ctx.timedOut() ? undefined : extractShipping(pages, summary, conditions);
  logItemsPostPerf('shipping', { ms: Date.now() - shippingStarted });

  const finalizeStarted = Date.now();
  const reasons: string[] = [];
  const coreItemsReady = items.length > 0;
  const coreTotalReady = !!summary.total || !!summary.subtotal;
  if (ctx.timedOut() && !(coreItemsReady && coreTotalReady)) {
    reasons.push('items_totals_deadline_exceeded');
  }
  const tableDetected = pages.some((page) => page.zones.some((zone) => zone.classification === 'items_table'));
  const udmAnchors = pages.reduce((sum, page) =>
    sum + page.lines.filter((line) => isUnitOfMeasureToken(line.text)).length, 0);
  if (tableDetected && items.length === 0) {
    reasons.push('table_detected_without_supported_rows');
  }
  if (summary.conflicts.includes('source_inconsistency_warning')) {
    reasons.push('source_inconsistency_warning');
  }
  if (udmAnchors >= 4 && items.length > 0 && items.length < Math.round(udmAnchors * 0.7)) {
    reasons.push('commercial_rows_dropped');
  }
  if (mergedItems.length >= 3 && items.length < Math.round(mergedItems.length * 0.7) && !reasons.includes('commercial_rows_dropped')) {
    reasons.push('commercial_rows_dropped');
  }
  const completeLineTotals = items.length > 0 && items.every((item) => item.lineTotal?.normalizedValue !== undefined);
  const lineSum = completeLineTotals
    ? items.reduce((sum, item) => sum + (item.lineTotal?.normalizedValue ?? 0), 0)
    : 0;
  const subtotalValue = summary.subtotal?.normalizedValue;
  const totalValue = summary.total?.normalizedValue;
  const documentDiscountValue = summaryWithoutStolenLineTotal.discountTotal?.normalizedValue;
  const shippingValue = summaryWithoutStolenLineTotal.shippingCost?.normalizedValue;
  const lineSumCandidates = [
    lineSum,
    documentDiscountValue !== undefined ? lineSum - Math.abs(documentDiscountValue) : undefined,
    shippingValue !== undefined ? lineSum + shippingValue : undefined,
    documentDiscountValue !== undefined && shippingValue !== undefined
      ? lineSum - Math.abs(documentDiscountValue) + shippingValue
      : undefined,
  ].filter((value): value is number => value !== undefined);
  const subtotalMismatch = subtotalValue !== undefined
    && !lineSumCandidates.some((candidate) =>
      Math.abs(candidate - subtotalValue) <= Math.max(1, Math.abs(subtotalValue) * 0.08));
  const totalMismatchWithoutSubtotal = totalValue !== undefined
    && subtotalValue === undefined
    && !lineSumCandidates.some((candidate) =>
      Math.abs(candidate - totalValue) <= Math.max(1, Math.abs(totalValue) * 0.2));
  if (completeLineTotals && lineSum > 0 && (subtotalMismatch || totalMismatchWithoutSubtotal)) {
    reasons.push('line_total_sum_mismatch');
  }
  if (!summary.total) reasons.push('document_total_missing');
  const requiresReview = reasons.length > 0 || items.some((item) => item.requiresReview) || summary.requiresReview;
  logItemsPostPerf('buildResult', { ms: Date.now() - finalizeStarted });
  logItemsTotalsPerf('done', { items: items.length, ms: Date.now() - started, timedOut: ctx.timedOut() });
  return {
    items,
    summary: summaryWithoutStolenLineTotal,
    conditions,
    ...(shipping ? { shipping } : {}),
    reasons,
    requiresReview,
  };
}

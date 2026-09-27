import {
  OcrLine,
  QuoteDocument,
  OrderDocument,
  InvoiceDocument,
  FreeDocument,
  QuoteItem,
  OrderItem,
  DocumentType,
} from '../types';
import { createId } from './id';
import { normalizeOcrText, findDocumentCode, findCustomerName, findSlashDocumentNumber, isLikelyReaOrAddressCode, findLabeledDocumentDate, isTaxOrFiscalLabelText, isDocumentTypeHeaderText } from './ocr-normalize';
import { inferCustomerNameFromOcrLayout, type LayoutInferenceCapture } from './document-party-layout-inference';
import type { GeminiDocumentExtract } from './gemini-ocr';
import {
  reliabilityFromCloudExtract,
  type DocumentPageItem,
  type DocumentPageStructuredFields,
} from './document-page-extraction';
import {
  documentFieldAlternative,
  evaluateDocumentField,
  isApplicableDocumentField,
  strictDocumentDateToDate,
  validateDocumentAmount,
  validateStrictDocumentDate,
  type DocumentFieldReliability,
  type DocumentFieldReliabilityMap,
  type DocumentReliabilityFieldKey,
} from './document-field-reliability';
import { sanitizeDocumentMonetaryFields } from './document-monetary-guardrails';
import { matchesDocumentLabel } from './document-label-dictionary';
import { parseInternationalAmount } from './document-international-values';
import { PDF_LOCAL_DIAGNOSTICS } from './pdf-import-local';
import { isQaLogEnabled } from './release-diagnostics';

/** Importi: 1.400,00 (IT), 12,50 oppure 216,9770 (4 decimali officina). */
const ITALIAN_MONEY = /(\d{1,3}(?:\.\d{3})+,\d{2,4}|\d+[,\.]\d{2,4})/;
const INTERNATIONAL_MONEY_TOKEN =
  /(?:\b(?:USD|EUR|GBP|CHF|USO)\b|[\$€£])?\s*([+-]?\d{1,3}(?:[,'\s]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})/gi;

export interface ParseDocumentOptions {
  /** Layout geometrico OCR: solo in build_local, mai in page_results (Elabora). */
  useLayoutInference?: boolean;
}

/** Disabilitato su device: congela Elabora. Usare solo findCustomerName testuale in scan. */
const SCAN_LAYOUT_INFERENCE_ENABLED = false;
const DATE = /(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/;

const VEHICLE_BRANDS =
  /\b(FIAT|LANCIA|ALFA(?:\s*ROMEO)?|BMW|MERCEDES|VOLKSWAGEN|VW|AUDI|FORD|OPEL|PEUGEOT|RENAULT|TOYOTA|NISSAN|HONDA|HYUNDAI|KIA|JEEP|CITRO[eë]N|SEAT|SKODA|VOLVO|MAZDA|SUZUKI|DACIA|IVECO)\b/i;

function parseItalianDate(dateStr: string): Date | undefined {
  return strictDocumentDateToDate(dateStr);
}

export function parseAmount(amountStr: string): number | undefined {
  const result = validateDocumentAmount(amountStr);
  return result.validationStatus === 'valid' ? result.value : undefined;
}

function splitLines(rawText: string): string[] {
  return rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function normalizeRawText(rawText: string): string {
  return normalizeOcrText(rawText);
}

function normalizeMoneyLineForParsing(line: string): string {
  return line
    .replace(/\$(\d{1,2})\.(\d{3})\.(\d{2})\b/g, (_, head, thousands, decimals) =>
      `$${head}${thousands}.${decimals}`
    )
    .replace(/\$(\d{1,3}),(\d{3})\s+(\d{2})\b/g, '$$$1,$2.$3');
}

interface MoneyTokenSpan {
  start: number;
  end: number;
  amount: number;
}

/** Evita che "1.400,00" produca anche il sotto-match spurio "400,00". */
function collectNonOverlappingAmounts(
  line: string,
  regex: RegExp,
  parseToken: (match: RegExpMatchArray) => number | undefined
): number[] {
  const spans: MoneyTokenSpan[] = [];
  for (const match of line.matchAll(regex)) {
    if (match.index === undefined) continue;
    const amount = parseToken(match);
    if (amount === undefined || amount > 10_000_000) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      amount,
    });
  }
  const maximal = spans.filter(
    (span) =>
      !spans.some(
        (other) =>
          other !== span &&
          other.start <= span.start &&
          other.end >= span.end &&
          other.end - other.start > span.end - span.start
      )
  );
  return maximal.sort((left, right) => left.start - right.start).map((span) => span.amount);
}

function findMoneyInLine(line: string): number | undefined {
  const normalizedLine = normalizeMoneyLineForParsing(line);
  const amounts: number[] = [];
  const trimmed = normalizedLine.trim();
  const looksLikeMoneyOnly =
    /^[\s$€£+-]?[\d.,'’\s]+(?:\b(?:USD|EUR|GBP|CHF|USO)\b)?\s*$/i.test(trimmed) ||
    /^(?:\b(?:USD|EUR|GBP|CHF|USO)\b\s*)?[\d.,'’\s]+$/i.test(trimmed);
  if (looksLikeMoneyOnly) {
    const wholeLine = parseInternationalAmount(trimmed);
    if (wholeLine.normalizedValue !== undefined && wholeLine.normalizedValue <= 10_000_000) {
      amounts.push(wholeLine.normalizedValue);
    }
    const parsedWhole = parseAmount(trimmed);
    if (parsedWhole !== undefined && parsedWhole <= 10_000_000) {
      amounts.push(parsedWhole);
    }
  }
  const hasItalianGrouped = /\d{1,3}(?:\.\d{3})+,\d{2}/.test(normalizedLine);
  if (amounts.length === 0 && hasItalianGrouped) {
    amounts.push(
      ...collectNonOverlappingAmounts(
        line,
        new RegExp(ITALIAN_MONEY.source, 'g'),
        (match) => parseAmount(match[1])
      )
    );
  }
  if (amounts.length === 0) {
    amounts.push(
      ...collectNonOverlappingAmounts(normalizedLine, INTERNATIONAL_MONEY_TOKEN, (match) =>
        parseAmount((match[1] ?? match[0]).trim())
      )
    );
  }
  if (amounts.length === 0) {
    const intl = parseInternationalAmount(trimmed);
    if (intl.normalizedValue !== undefined && intl.normalizedValue <= 10_000_000) {
      amounts.push(intl.normalizedValue);
    }
  }
  if (amounts.length === 0) {
    amounts.push(
      ...collectNonOverlappingAmounts(
        line,
        new RegExp(ITALIAN_MONEY.source, 'g'),
        (match) => parseAmount(match[1])
      )
    );
  }
  const positive = amounts.filter((amount) => amount > 0);
  if (positive.length === 0) return undefined;
  return positive[positive.length - 1];
}

function isOcrTotalTypoLabel(line: string): boolean {
  const trimmed = line.replace(/:$/, '').trim().toLowerCase();
  return /^(?:tota[1il]|totai|t0tal|totaii|tota\s*1)$/.test(trimmed);
}

function isDocumentTotalLabelLine(line: string): boolean {
  const trimmed = line.replace(/:$/, '').trim();
  if (/^subtotal\b/i.test(trimmed) || matchesDocumentLabel(trimmed, 'subtotal')) {
    return false;
  }
  if (
    /\b(?:invoice\s+number|quote\s+number|order\s+number)\b/i.test(trimmed) &&
    /\b(?:amount\s+due|total)\b/i.test(trimmed)
  ) {
    return false;
  }
  if (isMislabeledImponibileTotalLine(line) || isTableHeaderTotalLine(line)) {
    return false;
  }
  if (/^totale\s+(?:iva|imposta|vat|tva|mwst|ust)\b/i.test(trimmed)) {
    return false;
  }
  return (
    matchesDocumentLabel(trimmed, 'total') ||
    /^totale\b/i.test(trimmed) ||
    isOcrTotalTypoLabel(trimmed)
  );
}

function isDepositSummaryLine(line: string): boolean {
  return /\b(?:deposit(?:\s+(?:requested|due))?|balance\s+due|amount\s+paid|saldo|acconto)\b/i.test(
    line.trim()
  );
}

function isDocumentSubtotalLabelLine(line: string): boolean {
  const trimmed = line.replace(/:$/, '').trim();
  return matchesDocumentLabel(trimmed, 'subtotal') || /^subtotale\b/i.test(trimmed);
}

function isDocumentVatLabelLine(line: string): boolean {
  const trimmed = line.replace(/:$/, '').trim();
  if (/^\+?tax$/i.test(trimmed) || /^sales\s+tax$/i.test(trimmed)) return true;
  return matchesDocumentLabel(trimmed, 'vatAmount') || /^iva\b/i.test(trimmed);
}

function findMoneyNearLabel(
  lines: string[],
  labelTest: RegExp | ((line: string) => boolean),
  lookahead = 3
): number | undefined {
  const matchesLabel =
    typeof labelTest === 'function'
      ? labelTest
      : (line: string) => labelTest.test(line);
  for (let i = 0; i < lines.length; i++) {
    if (!matchesLabel(lines[i])) continue;

    const inline = findMoneyInLine(lines[i]);
    if (inline !== undefined) return inline;

    for (let j = i + 1; j <= Math.min(i + lookahead, lines.length - 1); j++) {
      const next = findMoneyInLine(lines[j]);
      if (next !== undefined && !/^(qt|qta|descrizione|prezzo|qty|description|rate)/i.test(lines[j])) {
        return next;
      }
      if (/^[A-Za-zÀ-ÿ]{4,}/.test(lines[j]) && !matchesLabel(lines[j])) break;
    }
  }
  return undefined;
}

function inferDocumentDateText(
  rawText: string,
  lines: string[],
  kind: 'quote' | 'order'
): string | undefined {
  const labelPatterns =
    kind === 'quote'
      ? [/data\s*documento/i, /data\s*(?:di\s*)?preventivo/i]
      : [/data\s*documento/i, /data\s*(?:di\s*)?ordine/i];
  const excludePatterns = [
    /valido\s+fino/i,
    /valid\s+until/i,
    /due\s+date/i,
    /scadenza/i,
    /consegna/i,
    /delivery/i,
    /immatricolazione/i,
    /nascita/i,
    /birth/i,
  ];

  const labeled = findLabeledDocumentDate(rawText, lines, labelPatterns, excludePatterns);
  if (labeled) return labeled;
  const labeledMissing = rawText.match(
    /\bdata(?:\s+(?:documento|preventivo|ordine))?\b\s*[:\-]?\s*(N\/A|NA|n\.d\.?|non disponibile|unknown|not found|null|undefined|-)\b/i
  );
  if (labeledMissing?.[1]) return labeledMissing[1];

  const generic = lines
    .find(
      (line) =>
        !/\b(?:valido\s+fino|valid\s+until|due\s+date|scadenza|consegna|delivery|immatricolazione|nascita|birth)\b/i.test(
          line
        ) && DATE.test(line)
    )
    ?.match(DATE);
  return generic?.[1];
}

function inferDocumentDate(
  rawText: string,
  lines: string[],
  kind: 'quote' | 'order'
): Date | undefined {
  const rawDate = inferDocumentDateText(rawText, lines, kind);
  return rawDate ? parseItalianDate(rawDate) : undefined;
}

function inferQuoteNumber(rawText: string, lines: string[]): string {
  const fromSlash = findSlashDocumentNumber(rawText);
  if (fromSlash) return fromSlash;

  const invoiceNumber = rawText.match(/\b(INV-[A-Z0-9-]+)\b/i);
  if (invoiceNumber?.[1]) return invoiceNumber[1].toUpperCase();

  const labeled = rawText.match(
    /numero\s*documento\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{0,20})/i
  );
  if (labeled?.[1] && !/^destinatario$/i.test(labeled[1])) {
    return labeled[1].replace(/\s+/g, '');
  }

  const inline = rawText.match(
    /preventivo\s*(?:#|n\.?|num\.?|numero)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{1,20})/i
  );
  if (inline?.[1] && !/^senza$/i.test(inline[1])) return inline[1];

  for (let i = 0; i < lines.length; i++) {
    if (!/^quote$/i.test(lines[i].trim())) continue;
    for (let j = i + 1; j <= Math.min(i + 4, lines.length - 1); j++) {
      const candidate = lines[j].trim();
      if (/^\d{1,6}$/.test(candidate)) return candidate;
      if (/^INV-[A-Z0-9-]+$/i.test(candidate)) return candidate.toUpperCase();
    }
  }

  const fromCode = findDocumentCode(rawText);
  if (fromCode && !isLikelyReaOrAddressCode(fromCode)) return fromCode;

  for (let i = 0; i < lines.length; i++) {
    if (!/preventivo|ventivo/i.test(lines[i])) continue;
    const sameLine = lines[i].match(/(?:#|n\.?)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]+)/i);
    if (sameLine) return sameLine[1];
    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
      if (/^\d+\/[A-Z0-9]+$/i.test(lines[j].replace(/\s+/g, ''))) return lines[j].replace(/\s+/g, '');
      if (/^[A-Z]{1,3}-\d+/i.test(lines[j])) return lines[j].replace(/\s+/g, '-');
      if (/^[A-Z0-9][A-Z0-9\-\/]+$/.test(lines[j]) && lines[j].length <= 20) return lines[j];
    }
  }

  return '';
}

function isFooterOrRegistryMoneyLine(line: string): boolean {
  return /\b(?:capitale\s+sociale|registro\s+imprese|r\.?\s*e\.?\s*a\.?|cod\.?\s*fisc|p\.?\s*iva\s+\d|int\.?\s*ver)\b/i.test(
    line
  );
}

function isSummaryOrNonItemLine(line: string): boolean {
  if (/\b(?:varie|manodopera|lavorazioni\s+esterne|riepilogo|profondit|lunghezza|incisione)\b/i.test(line)) {
    return true;
  }
  if (/\bmm\b/i.test(line)) return true;
  if (/^rdm\b/i.test(line)) return true;
  if (/^,\.?0*\s*€?\s*0/i.test(line)) return true;
  if (/\b(?:capitale\s+sociale|cod\.?\s*fisc)\b/i.test(line)) return true;
  return false;
}

function isSmallUnitPriceLine(line: string): boolean {
  const match = line.match(/^(\d+[,\.]\d{2,4})\s*€?\s*$/);
  if (!match) return false;
  const amount = parseLineItemAmount(match[1]);
  return amount !== undefined && amount > 0 && amount < 10;
}

function itemSumLooksReliable(items: QuoteItem[], total?: number): boolean {
  if (items.length === 0) return false;
  if (items.some((item) => /^Voce \d+$/i.test(item.description.trim()))) return false;
  const sum = items.reduce((acc, item) => acc + item.total, 0);
  if (total !== undefined) {
    return sum >= total * 0.5 && sum <= total * 1.02;
  }
  return sum >= 20 && items.length >= 2;
}

function isMislabeledImponibileTotalLine(line: string): boolean {
  return /^totale\s+(?:im|mpon|pon|pob|pole|immp|d0c)/i.test(line.trim());
}

function isPrezzoUnitLine(line: string): boolean {
  return /^\d+[,\.]\d{3,4}\s*€?\s*$/i.test(line.trim());
}

function isVatCodeLine(line: string): boolean {
  return /^(?:122|I22|22|4)$/i.test(line.trim());
}

function parseTableImportoAmount(line: string): number | undefined {
  const trimmed = line.trim();
  const vatGlued = trimmed.match(/^(\d+[,\.]\d{2})4\s*$/);
  if (vatGlued) return parseLineItemAmount(vatGlued[1]);
  const vatSpaced = trimmed.match(/^(\d+[,\.]\d{2})\s+4\s*$/);
  if (vatSpaced) return parseLineItemAmount(vatSpaced[1]);
  const plain = trimmed.match(/^(\d+[,\.]\d{2})\s*€?\s*$/);
  if (plain) return parseLineItemAmount(plain[1]);
  return undefined;
}

function isLineItemImportoLine(line: string, previousLine?: string): boolean {
  if (parseTableImportoAmount(line) !== undefined) return true;
  if (previousLine !== undefined && isVatCodeLine(previousLine)) return true;
  return false;
}

function findExplicitDocumentTotal(lines: string[]): number | undefined {
  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFooterOrRegistryMoneyLine(line)) continue;
    if (isLineItemImportoLine(line, lines[i - 1])) continue;
    const trimmed = line.trim();
    const strict = trimmed.match(/^(\d{1,3}(?:\.\d{3})*,\d{2}|\d+[,\.]\d{2})\s*(?:EUR|€)\s*$/i);
    if (strict) {
      const amount = parseAmount(strict[1]);
      if (amount !== undefined && amount >= 1 && (/EUR/i.test(trimmed) || amount >= 100)) {
        candidates.push(amount);
      }
    }
  }
  if (candidates.length === 0) return undefined;
  return candidates[candidates.length - 1];
}

function isTableHeaderTotalLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === 'TOTALE') return true;
  return /^(?:prezz0?|importo|subtotale)\s*(?:€|eur)?\s*$/i.test(trimmed);
}

function findDocumentTotalNearLabel(lines: string[], lookahead = 6): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (!isDocumentTotalLabelLine(lines[i])) {
      continue;
    }

    const inline = findMoneyInLine(lines[i]);
    if (inline !== undefined && inline >= 15) return inline;

    for (let j = i + 1; j <= Math.min(i + lookahead, lines.length - 1); j++) {
      const next = lines[j];
      const money = findMoneyInLine(next);
      if (
        money !== undefined &&
        money > 0 &&
        !/^(qt|qta|descrizione|prezzo|qty|description|rate)/i.test(next)
      ) {
        return money;
      }
      if (/^[A-Za-zÀ-ÿ]{4,}/.test(next) && !isDocumentTotalLabelLine(next)) break;
    }
  }
  return undefined;
}

function preferLineItem(current: QuoteItem, candidate: QuoteItem): QuoteItem {
  if (candidate.total > 100000) return current;
  if (current.total > 100000) return candidate;
  if (candidate.total <= current.total * 1.02 && candidate.total >= current.total * 0.95) {
    return candidate.total <= current.total ? candidate : current;
  }
  return current;
}

function dedupeLineItems(items: QuoteItem[]): QuoteItem[] {
  const byDesc = new Map<string, QuoteItem>();
  for (const item of items) {
    const key = item.description.trim().toLowerCase();
    const existing = byDesc.get(key);
    byDesc.set(key, existing ? preferLineItem(existing, item) : item);
  }
  return [...byDesc.values()];
}

function isWeakLineItemDescription(description: string): boolean {
  const text = description.trim();
  if (text.length < 5) return true;
  if (/^(?:totale|subtotale|imponibile|iva)$/i.test(text)) return true;
  if (/^(\d+\s*)?(?:cf|pz|nr|h|the|bah)$/i.test(text)) return true;
  return false;
}

function isDocumentSummaryAmountLine(lines: string[], index: number): boolean {
  const previous = lines[index - 1]?.trim() ?? '';
  const beforePrevious = lines[index - 2]?.trim() ?? '';
  if (/^totale\s*$/i.test(previous)) return true;
  if (/^subtotale\s*$/i.test(previous)) return true;
  if (/^totale\s*$/i.test(beforePrevious) && /^subtotale\s*$/i.test(previous)) {
    return true;
  }
  return false;
}

const ORDER_NUMBER_STOPWORDS =
  /^(?:spett(?:\.|abile|ale)?|spettable|destinatario|cliente|fre|gui|ame|italy|nduda|ferma|ordine|conferma|cliente|ag|tra|vettore|descriz|quantit|prezzo|nas|spe|yana|urina|tal\b)$/i;

function isOrderDocumentHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (isDocumentTypeHeaderText(trimmed)) return true;
  return /^(?:conferma\s+ordine|ordine\s+cliente)\b/i.test(trimmed);
}

function looksLikeItalianOrderSerial(value: string): boolean {
  return /^20[0-9]{8,10}$/.test(value);
}

function inferOrderNumber(rawText: string, lines: string[]): string {
  const numbered = rawText.match(/\bN\.?\s*(\d{6,12})\s+del\s+/i);
  if (numbered?.[1]) return numbered[1];

  for (const line of lines) {
    const fromLine = line.match(/\bN\.?\s*(\d{6,12})\s+del\b/i);
    if (fromLine?.[1]) return fromLine[1];
  }

  const headerIdx = lines.findIndex((line) => /\bconferma\s+ordine\b/i.test(line));
  const searchStart = headerIdx >= 0 ? headerIdx : 0;
  const searchEnd = Math.min(searchStart + 30, lines.length);
  for (let i = searchStart; i < searchEnd; i++) {
    const loose = lines[i].match(/\bN\.?\s*(\d{8,12})\b/i);
    if (loose?.[1] && looksLikeItalianOrderSerial(loose[1])) return loose[1];
  }

  const inline = rawText.match(
    /\bordine\s*(?:#|n\.|nr\.|num\.?|numero)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]{1,20})/i
  );
  if (inline?.[1] && !ORDER_NUMBER_STOPWORDS.test(inline[1])) return inline[1];

  for (let i = 0; i < lines.length; i++) {
    if (isOrderDocumentHeaderLine(lines[i])) continue;
    if (!/\bordine\b/i.test(lines[i])) continue;
    const sameLine = lines[i].match(/\b(?:n\.|nr\.|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-\/]+)/i);
    if (sameLine?.[1] && !ORDER_NUMBER_STOPWORDS.test(sameLine[1])) return sameLine[1];
    for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
      if (ORDER_NUMBER_STOPWORDS.test(lines[j])) continue;
      if (/^[A-Z0-9][A-Z0-9\-\/]+$/.test(lines[j]) && lines[j].length <= 20) return lines[j];
    }
  }

  return '';
}

function inferCustomerName(
  rawText: string,
  lines: string[],
  ocrLines?: readonly OcrLine[],
  documentType: 'quote' | 'order' = 'quote',
  capture?: LayoutInferenceCapture,
  useLayoutInference = false,
): string {
  if (useLayoutInference && SCAN_LAYOUT_INFERENCE_ENABLED && ocrLines?.length) {
    const fromLayout = inferCustomerNameFromOcrLayout(ocrLines, rawText, documentType, capture);
    if (fromLayout) return cleanCustomerName(fromLayout);
  }

  const fromLabels = findCustomerName(rawText, lines);
  if (fromLabels) return cleanCustomerName(fromLabels);

  for (const line of lines) {
    const vehicle = line.match(
      new RegExp(`${VEHICLE_BRANDS.source}\\s+([A-Z0-9][A-Z0-9\\s\\-]{1,24})`, 'i')
    );
    if (vehicle) {
      return `${vehicle[1]} ${vehicle[2]}`.replace(/\s+/g, ' ').trim();
    }
  }

  return '';
}

function cleanCustomerName(value: string): string {
  const cleaned = value
    .replace(/\s+via\b.*/i, '')
    .replace(/\s+\d{5}\b.*/i, '')
    .replace(/[,\-–—]\s*$/, '')
    .trim();
  if (isTaxOrFiscalLabelText(cleaned) || isDocumentTypeHeaderText(cleaned)) return '';
  return cleaned;
}

function inferTotal(lines: string[], rawText: string): number | undefined {
  const fromLabel = findDocumentTotalNearLabel(lines, 6);
  if (fromLabel !== undefined) return fromLabel;

  const fromAmountDue = findMoneyNearLabel(
    lines,
    (line) =>
      /\bamount\s+due\b/i.test(line) ||
      matchesDocumentLabel(line.replace(/:$/, '').trim(), 'total'),
    5
  );
  if (fromAmountDue !== undefined && fromAmountDue >= 50) return fromAmountDue;

  const regexMatches = [
    ...rawText.matchAll(
      /(?<![A-Za-zÀ-ü])totale(?:\s+(?:triennale|documento|ordine|generale|d\s*documento|d0cumento))?\b\s*[:\-]?\s*€?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+[,\.]\d{2})/gi
    ),
  ];
  if (regexMatches.length > 0) {
    return parseAmount(regexMatches[regexMatches.length - 1][1]);
  }

  const labeled = rawText.match(
    /(?<![A-Za-zÀ-ü])totale(?:\s+(?:triennale|documento|ordine|generale|d\s*documento|d0cumento))?\b\s*[:\-]?\s*€?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+[,\.]\d{2})/i
  );
  if (labeled) return parseAmount(labeled[1]);

  const explicitEur = findExplicitDocumentTotal(lines);
  if (explicitEur !== undefined) return explicitEur;

  const explicitTotal = rawText.match(
    /\b(\d{1,3}(?:\.\d{3})*,\d{2})\s*(?:EUR|€)\b/i
  );
  if (explicitTotal) return parseAmount(explicitTotal[1]);

  const amounts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^(qt|qta|descrizione|prezzo|valore|logo)/i.test(line)) continue;
    if (isFooterOrRegistryMoneyLine(line) || isSummaryOrNonItemLine(line)) continue;
    if (isDepositSummaryLine(line) || isDepositSummaryLine(lines[index - 1] ?? '')) continue;
    const money = findMoneyInLine(line);
    if (money !== undefined && money >= 1 && money <= 100000) amounts.push(money);
  }

  if (amounts.length > 0) return amounts[amounts.length - 1];
  return undefined;
}

export function formatDocumentTotal(total: number | undefined): string {
  if (typeof total !== 'number' || !Number.isFinite(total)) return '';
  return total.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDocumentDate(date: Date | undefined): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function isSummaryLabelLine(line: string): boolean {
  return /\b(?:totale|subtotale|impon|contrib|spese|sconto|ponle|documento|logistico|trasporto)\b/i.test(
    line
  );
}

function findTaxableAmountNearLabel(lines: string[], total?: number): number | undefined {
  const labelRegex =
    /\b(?:subtotale|imponibile|totale\s+impon(?:ibile)?|im+pos\s*ta|totale\s+pob(?:ile)?)\b/i;
  for (let i = 0; i < lines.length; i++) {
    if (!labelRegex.test(lines[i])) continue;
    const inline = findMoneyInLine(lines[i]);
    if (inline !== undefined) return inline;

    const candidates: number[] = [];
    for (let j = i + 1; j <= Math.min(i + 12, lines.length - 1); j++) {
      const line = lines[j];
      if (
        line.trim().length > 28 &&
        /^[A-Za-zÀ-ÿ]{4,}/.test(line) &&
        !labelRegex.test(line) &&
        !isSummaryLabelLine(line) &&
        !/\d+[,\.]\d{2}/.test(line)
      ) {
        break;
      }
      const money = findMoneyInLine(line);
      if (money !== undefined && money >= 1 && !isFooterOrRegistryMoneyLine(line)) {
        candidates.push(money);
      }
    }
    if (candidates.length === 0) continue;
    if (total !== undefined) {
      const belowTotal = candidates.filter((amount) => amount < total - 0.01);
      if (belowTotal.length > 0) {
        return belowTotal.sort((a, b) => b - a)[0];
      }
    }
    return candidates[candidates.length - 1];
  }
  return undefined;
}

function inferSubtotalFromPax(lines: string[]): number | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (!/^subtotale\b/i.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
      const pax = lines[j].match(/(\d+[,\.]\d{2})\s*€?\s*[xX×]\s*(\d+)\s*pax/i);
      if (!pax) continue;
      const unit = parseAmount(pax[1]);
      const count = Number.parseInt(pax[2], 10);
      if (unit !== undefined && count > 0) return unit * count;
    }
  }
  return undefined;
}

function inferSubtotalFromCategorySummary(lines: string[]): number | undefined {
  const totalIndex = lines.findIndex((line) => isDocumentTotalLabelLine(line));
  if (totalIndex <= 0) return undefined;
  const window = lines.slice(Math.max(0, totalIndex - 8), totalIndex);
  const amounts: number[] = [];
  for (const line of window) {
    if (!/\b(?:materiale|manodopera|lavorazioni|varie)\b/i.test(line)) continue;
    for (const match of line.matchAll(new RegExp(ITALIAN_MONEY.source, 'g'))) {
      const value = parseAmount(match[1]);
      if (value !== undefined && value > 0) amounts.push(value);
    }
  }
  if (amounts.length < 2) return undefined;
  return Math.round(amounts.reduce((sum, amount) => sum + amount, 0) * 100) / 100;
}

function inferSubtotal(lines: string[], items: QuoteItem[], total?: number): number | undefined {
  const fromPax = inferSubtotalFromPax(lines);
  if (fromPax !== undefined) return fromPax;

  const fromCategorySummary = inferSubtotalFromCategorySummary(lines);
  if (
    fromCategorySummary !== undefined &&
    (total === undefined ||
      (fromCategorySummary >= total * 0.85 && fromCategorySummary <= total * 1.02))
  ) {
    return fromCategorySummary;
  }

  const fromImponibile = findTaxableAmountNearLabel(lines, total);
  if (fromImponibile !== undefined) return fromImponibile;

  const fromLabel = findMoneyNearLabel(lines, isDocumentSubtotalLabelLine, 3);
  if (fromLabel !== undefined) {
    if (total === undefined || fromLabel >= total * 0.5) return fromLabel;
  }

  const labeled = lines.join('\n').match(
    /(?:subtotale|imponibile|totale\s+impon(?:ibile)?)\s*[:\-]?\s*€?\s*(\d+[,\.]\d{2})/i
  );
  if (labeled) {
    const parsed = parseAmount(labeled[1]);
    if (parsed !== undefined && (total === undefined || parsed >= total * 0.5)) return parsed;
  }

  if (itemSumLooksReliable(items, total)) {
    return items.reduce((sum, item) => sum + item.total, 0);
  }
  return undefined;
}

function inferVatAmount(lines: string[], rawText: string, subtotal?: number, total?: number): number | undefined {
  const fromLabel = findMoneyNearLabel(lines, isDocumentVatLabelLine, 2);
  if (fromLabel !== undefined) return fromLabel;

  const labeled = rawText.match(/\biva\s*(?:\d+[,\.]?\d*)?\s*%\s*[:\-]?\s*€?\s*(\d+[,\.]\d{2})/i);
  if (labeled) return parseAmount(labeled[1]);

  if (subtotal !== undefined && total !== undefined && total > subtotal && subtotal >= total * 0.5) {
    const delta = Math.round((total - subtotal) * 100) / 100;
    if (delta > 0 && delta < total) return delta;
  }

  return undefined;
}

function parseLineItemAmount(amountStr: string): number | undefined {
  const cleaned = amountStr.replace(/[€\s]/g, '').trim();
  const fromStrict = parseAmount(cleaned);
  if (fromStrict !== undefined) return fromStrict;
  const match = cleaned.match(/^(\d+[,\.]\d{2,4})$/);
  if (!match) return undefined;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : undefined;
}

function descriptionFromRecentLines(lines: string[], index: number): string {
  for (let j = index - 1; j >= Math.max(0, index - 4); j--) {
    const line = lines[j];
    if (/^(?:NR|[A-Z]{1,4}|\d+|122|I22|THE|BAH|H)$/i.test(line)) continue;
    if (/^\d+[,\.]\d/.test(line)) continue;
    if (line.length >= 4 && !isSummaryOrNonItemLine(line)) {
      return line.trim();
    }
  }
  return `Voce ${index + 1}`;
}

function isOrderTableHeaderLine(line: string): boolean {
  return /^(?:prezzo(?:\s*netto)?|quantit|codice|descriz|sc\.|sg\.|nas)$/i.test(line.trim());
}

function parseStackedOrderLineItems(lines: string[]): QuoteItem[] {
  const items: QuoteItem[] = [];
  const productCode = /^(?:V-[A-Z0-9][A-Z0-9.\s\-]*|PERS)$/i;

  const collectBlockAmounts = (start: number, end: number): number[] => {
    const blockAmounts: number[] = [];
    for (let j = start; j <= end; j++) {
      const line = lines[j];
      const embedded = [...line.matchAll(/(\d+[,\.]\d{2})(?!\d)/g)];
      for (const match of embedded) {
        const value = parseAmount(match[1]);
        if (value !== undefined && value !== 22 && value !== 122 && value >= 1) {
          blockAmounts.push(value);
        }
      }
      const sole = line.match(/^(\d+[,\.]\d{2})$/);
      if (sole) {
        const value = parseAmount(sole[1]);
        if (value !== undefined && value !== 22 && value !== 122 && value >= 1) {
          blockAmounts.push(value);
        }
      }
      const dotted = line.match(/^(\d+)\.(\d{2})$/);
      if (dotted) {
        const value = parseAmount(`${dotted[1]},${dotted[2]}`);
        if (value !== undefined && value !== 22 && value >= 15) {
          blockAmounts.push(value);
        }
      }
    }
    return blockAmounts;
  };

  for (let i = 0; i < lines.length; i++) {
    if (!productCode.test(lines[i])) continue;
    let description = '';
    let blockAmounts = collectBlockAmounts(i + 1, Math.min(i + 8, lines.length - 1));

    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const line = lines[j];
      if (productCode.test(line)) break;
      if (!description && line.length > 8 && !/^\d+[,\.]/.test(line) && !isOrderTableHeaderLine(line)) {
        description = line.trim();
      }
      blockAmounts = [...collectBlockAmounts(j + 1, i - 1), ...blockAmounts];
    }

    for (let j = i + 1; j <= Math.min(i + 8, lines.length - 1); j++) {
      const line = lines[j];
      if (productCode.test(line)) break;
      if (/^Tempi di consegna/i.test(line)) break;
      if (!description && line.length > 8 && !/^\d+[,\.]/.test(line) && !/^22[,\.]00$/.test(line) && !isOrderTableHeaderLine(line)) {
        description = line.trim();
      }
    }

    const netCandidates = blockAmounts.filter((amount) => amount >= 15);
    const netTotal =
      netCandidates.length > 0 ? netCandidates.sort((a, b) => b - a)[0] : undefined;

    if (description && netTotal !== undefined && netTotal > 0) {
      items.push({
        description,
        quantity: 1,
        unitPrice: netTotal,
        total: netTotal,
      });
    }
  }

  return items.filter(
    (item, index, all) =>
      item.total !== 22 &&
      item.total !== 122 &&
      all.findIndex((other) => other.description === item.description) === index
  );
}

function parseStackedEnglishLineItems(lines: string[]): QuoteItem[] {
  const items: QuoteItem[] = [];
  const isMoneyLine = (line: string): boolean =>
    /(?:\b(?:USD|EUR|GBP|CHF|USO)\b|[\$€£])\s*[\d,.\s]+/i.test(line.trim()) ||
    findMoneyInLine(line) !== undefined;
  const isQtyLine = (line: string): boolean => /^\d+$/.test(line.trim());

  for (let i = 0; i < lines.length - 3; i++) {
    const description = lines[i].trim();
    if (
      description.length < 4 ||
      isMoneyLine(description) ||
      isQtyLine(description) ||
      /^(description|rate|qty|amount|quantity|subtotal|total|tax|discount|disc|notes|terms|payment)/i.test(
        description
      ) ||
      isSummaryOrNonItemLine(description)
    ) {
      continue;
    }
    const rateLine = lines[i + 1];
    const qtyLine = lines[i + 2];
    const amountLine = lines[i + 3];
    if (!isMoneyLine(rateLine) || !isQtyLine(qtyLine) || !isMoneyLine(amountLine)) {
      continue;
    }
    // Italian order OCR often stacks IVA % (22,00) + qty + net price — not EN rate/qty/amount.
    if (/^22[,\.]00$/.test(rateLine.trim())) {
      continue;
    }
    const unitPrice = findMoneyInLine(rateLine);
    const total = findMoneyInLine(amountLine);
    const quantity = Number.parseInt(qtyLine.trim(), 10);
    if (
      unitPrice === undefined ||
      total === undefined ||
      quantity <= 0 ||
      isWeakLineItemDescription(description) ||
      unitPrice > 1_000_000 ||
      total > 1_000_000
    ) {
      continue;
    }
    items.push({ description, quantity, unitPrice, total });
    i += 3;
  }
  return items;
}

function parseLineItems(lines: string[]): QuoteItem[] {
  const items: QuoteItem[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^(qt|qta|udm|um|descrizione|prezzo|valore|subtotale|totale|iva|fatturare|preventivo|ordine|dettaglio\s+documento)/i.test(line)) {
      continue;
    }
    if (/^(?:immatricolazione|targa|km|versione|telaio|marca|modello)\b/i.test(line)) {
      continue;
    }
    if (isSummaryOrNonItemLine(line)) continue;
    if (isSmallUnitPriceLine(line)) continue;
    if (isPrezzoUnitLine(line)) continue;
    if (isVatCodeLine(line)) continue;

    const tableImporto = parseTableImportoAmount(line);
    if (tableImporto !== undefined && tableImporto >= 15) {
      if (isDocumentSummaryAmountLine(lines, index)) continue;
      const description = descriptionFromRecentLines(lines, index);
      if (!isWeakLineItemDescription(description)) {
        items.push({
          description,
          quantity: 1,
          unitPrice: tableImporto,
          total: tableImporto,
        });
      }
      continue;
    }

    const udmQtyPrice = line.match(/^(?:NR|[A-Z]{1,4})\s+(\d+)\s+(\d+[,\.]\d{2,4})\s*€?\s*$/i);
    if (udmQtyPrice) {
      const unitPrice = parseLineItemAmount(udmQtyPrice[2]);
      if (unitPrice === undefined) continue;
      const quantity = parseFloat(udmQtyPrice[1]);
      items.push({
        description: `Voce ${items.length + 1}`,
        quantity,
        unitPrice,
        total: unitPrice * quantity,
      });
      continue;
    }

    const tableRow = line.match(/^(\d+)\s+(.+?)\s+(\d+[,\.]\d{2,4})\s+(\d+[,\.]\d{2,4})\s*€?\s*$/);
    if (tableRow) {
      const unitPrice = parseAmount(tableRow[3]);
      const total = parseAmount(tableRow[4]);
      if (unitPrice === undefined || total === undefined) continue;
      items.push({
        description: tableRow[2].trim(),
        quantity: parseFloat(tableRow[1]),
        unitPrice,
        total,
      });
      continue;
    }

    const qtyDescAmount = line.match(/^(\d+)\s+(.+?)\s+(\d+[,\.]\d{2,4})\s*€?\s*$/);
    if (qtyDescAmount && qtyDescAmount[2].length > 3) {
      const unitPrice = parseLineItemAmount(qtyDescAmount[3]);
      if (unitPrice === undefined) continue;
      const quantity = parseFloat(qtyDescAmount[1]);
      items.push({
        description: qtyDescAmount[2].trim(),
        quantity,
        unitPrice,
        total: unitPrice * quantity,
      });
      continue;
    }

    const endMatch = line.match(/^(.{4,}?)\s+(\d+[,\.]\d{2,4})\s*€?\s*[4]?\s*$/);
    if (!endMatch) {
      const importoOnly = line.match(/^(\d+[,\.]\d{2,4})\s*€?\s*[4]?\s*$/);
      if (importoOnly) {
        if (isDocumentSummaryAmountLine(lines, index)) continue;
        const total = parseLineItemAmount(importoOnly[1]);
        if (total !== undefined && total >= 15 && !isWeakLineItemDescription(descriptionFromRecentLines(lines, index))) {
          items.push({
            description: descriptionFromRecentLines(lines, index),
            quantity: 1,
            unitPrice: total,
            total,
          });
        }
      }
      continue;
    }

    const description = endMatch[1].trim();
    if (/^(totale|subtotale|imponibile|iva|mano\s*dop|varie)/i.test(description)) continue;
    if (/€\s*0/i.test(description)) continue;
    const unitPrice = parseLineItemAmount(endMatch[2]);
    if (unitPrice === undefined) continue;
    items.push({
      description,
      quantity: 1,
      unitPrice,
      total: unitPrice,
    });
  }

  const stacked = parseStackedOrderLineItems(lines);
  const stackedEnglish = parseStackedEnglishLineItems(lines);
  if (stacked.length > 0) return dedupeLineItems(stacked);
  if (stackedEnglish.length > 0) return dedupeLineItems(stackedEnglish);
  return dedupeLineItems(items);
}

function buildQuoteTitle(quoteNumber?: string, customerName?: string, date?: Date): string {
  if (quoteNumber) return `Preventivo ${quoteNumber}`;
  if (customerName) return `Preventivo — ${customerName}`;
  if (date) return `Preventivo ${date.toLocaleDateString('it-IT')}`;
  return 'Preventivo senza numero';
}

function buildOrderTitle(orderNumber?: string, customerName?: string, date?: Date): string {
  if (orderNumber) return `Ordine ${orderNumber}`;
  if (customerName) return `Ordine — ${customerName}`;
  if (date) return `Ordine ${date.toLocaleDateString('it-IT')}`;
  return 'Ordine senza numero';
}

function buildInvoiceTitle(invoiceNumber?: string, customerName?: string, date?: Date): string {
  if (invoiceNumber) return `Fattura ${invoiceNumber}`;
  if (customerName) return `Fattura — ${customerName}`;
  if (date) return `Fattura ${date.toLocaleDateString('it-IT')}`;
  return 'Fattura senza numero';
}

function documentReliabilityFromValues(
  values: {
    documentNumber?: unknown;
    customerName?: unknown;
    date?: unknown;
    vatNumber?: unknown;
    subtotal?: unknown;
    vatAmount?: unknown;
    total?: unknown;
    currency?: unknown;
    items?: unknown;
    extractedFields?: unknown;
  },
  source: 'local_ocr' | 'cloud_ai'
): DocumentFieldReliabilityMap {
  return {
    documentNumber: evaluateDocumentField(
      'documentNumber',
      values.documentNumber,
      {
        source,
        confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
      }
    ),
    customerName: evaluateDocumentField(
      'customerName',
      values.customerName,
      {
        source,
        confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
      }
    ),
    date: evaluateDocumentField('date', values.date, {
      source,
      confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
    }),
    vatNumber: evaluateDocumentField('vatNumber', values.vatNumber, {
      source,
      confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
    }),
    subtotal: evaluateDocumentField('subtotal', values.subtotal, {
      source,
      confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
    }),
    vatAmount: evaluateDocumentField('vatAmount', values.vatAmount, {
      source,
      confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
    }),
    total: evaluateDocumentField('total', values.total, {
      source,
      confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
    }),
    currency: evaluateDocumentField('currency', values.currency, {
      source,
      confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
    }),
    items: evaluateDocumentField('items', values.items, {
      source,
      confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
    }),
    extractedFields: evaluateDocumentField(
      'extractedFields',
      values.extractedFields,
      {
        source,
        confidenceType: source === 'cloud_ai' ? 'unknown' : 'heuristic',
      }
    ),
  };
}

export function parseQuoteDocument(
  lines: OcrLine[],
  rawText: string,
  options?: ParseDocumentOptions,
): QuoteDocument {
  const text = normalizeRawText(rawText);
  const docLines = splitLines(text);

  const quoteNumber = inferQuoteNumber(text, docLines);
  const rawQuoteDate = inferDocumentDateText(text, docLines, 'quote');
  const quoteDate = rawQuoteDate
    ? inferDocumentDate(text, docLines, 'quote')
    : undefined;
  const customerName = inferCustomerName(
    text,
    docLines,
    lines,
    'quote',
    undefined,
    options?.useLayoutInference === true,
  );
  const items = parseLineItems(docLines);
  const inferredTotal = inferTotal(docLines, text);
  const inferredSubtotal = inferSubtotal(docLines, items, inferredTotal);
  const inferredVat = inferVatAmount(docLines, text, inferredSubtotal, inferredTotal);
  const monetary = sanitizeDocumentMonetaryFields({
    total: inferredTotal,
    subtotal: inferredSubtotal,
    vatAmount: inferredVat,
    items,
  });

  const vatMatch = text.match(/(?:p\.?\s*iva|vat|partita\s*iva)\s*[:\-]?\s*([A-Z]{0,2}\d{8,12})/i);
  const currency = explicitDocumentCurrency(text);

  return {
    id: createId(),
    type: 'quote',
    title: buildQuoteTitle(quoteNumber, customerName, quoteDate),
    images: [],
    quoteNumber,
    quoteDate,
    customerName,
    customerVat: vatMatch?.[1],
    items,
    subtotal: monetary.subtotal,
    vatAmount: monetary.vatAmount,
    total: monetary.total,
    currency,
    rawText: text,
    fieldReliability: documentReliabilityFromValues(
      {
        documentNumber: quoteNumber,
        customerName,
        date: rawQuoteDate,
        vatNumber: vatMatch?.[1],
        subtotal: monetary.subtotal,
        vatAmount: monetary.vatAmount,
        total: monetary.total,
        currency,
        items,
      },
      'local_ocr'
    ),
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function parseOrderDocument(
  lines: OcrLine[],
  rawText: string,
  options?: ParseDocumentOptions,
): OrderDocument {
  const text = normalizeRawText(rawText);
  const docLines = splitLines(text);

  const orderNumber = inferOrderNumber(text, docLines);
  const rawOrderDate = inferDocumentDateText(text, docLines, 'order');
  const orderDate = rawOrderDate
    ? inferDocumentDate(text, docLines, 'order')
    : undefined;
  const customerName = inferCustomerName(
    text,
    docLines,
    lines,
    'order',
    undefined,
    options?.useLayoutInference === true,
  );
  const items: OrderItem[] = parseLineItems(docLines);
  const inferredTotal = inferTotal(docLines, text);
  const inferredSubtotal = inferSubtotal(docLines, items, inferredTotal);
  const inferredVat = inferVatAmount(docLines, text, inferredSubtotal, inferredTotal);
  const monetary = sanitizeDocumentMonetaryFields({
    total: inferredTotal,
    subtotal: inferredSubtotal,
    vatAmount: inferredVat,
    items,
  });

  const vatMatch = text.match(/(?:p\.?\s*iva|vat|partita\s*iva)\s*[:\-]?\s*([A-Z]{0,2}\d{8,12})/i);
  const currency = explicitDocumentCurrency(text);

  return {
    id: createId(),
    type: 'order',
    title: buildOrderTitle(orderNumber, customerName, orderDate),
    images: [],
    orderNumber,
    orderDate,
    customerName,
    customerVat: vatMatch?.[1],
    items,
    subtotal: monetary.subtotal,
    vatAmount: monetary.vatAmount,
    total: monetary.total,
    currency,
    rawText: text,
    fieldReliability: documentReliabilityFromValues(
      {
        documentNumber: orderNumber,
        customerName,
        date: rawOrderDate,
        vatNumber: vatMatch?.[1],
        subtotal: monetary.subtotal,
        vatAmount: monetary.vatAmount,
        total: monetary.total,
        currency,
        items,
      },
      'local_ocr'
    ),
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function parseInvoiceDocument(
  lines: OcrLine[],
  rawText: string,
  options?: ParseDocumentOptions,
): InvoiceDocument {
  const parsedQuote = parseQuoteDocument(lines, rawText, options);
  const {
    quoteNumber,
    quoteDate,
    type: _type,
    title: _title,
    ...shared
  } = parsedQuote;

  return {
    ...shared,
    type: 'invoice',
    title: buildInvoiceTitle(quoteNumber, parsedQuote.customerName, quoteDate),
    invoiceNumber: quoteNumber,
    invoiceDate: quoteDate,
  };
}

function isWeakGeminiRecipient(name: string): boolean {
  const n = name.trim();
  if (!n) return true;
  if (/^destinatario$/i.test(n)) return true;
  if (/^(?:le|sig\.?ra?|sig\.?|spett\.?)$/i.test(n)) return true;
  return n.split(/\s+/).filter(Boolean).length === 1 && n.length <= 3;
}

function isLikelyDateAsDocNumber(value: string): boolean {
  return /^\d{1,2}[\/\-\.]\d{1,2}/.test(value.trim());
}

function geminiDateLooksLikeValidUntil(rawText: string, date: string): boolean {
  if (!date.trim()) return false;
  const escaped = date.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`valido\\s+fino[^\\n]{0,60}${escaped}`, 'i').test(rawText);
}

function shouldPreferLocalTotal(
  geminiTotal: number | undefined,
  localTotal: number | undefined
): boolean {
  if (localTotal === undefined) return false;
  if (geminiTotal === undefined) return true;
  return localTotal >= 100 && geminiTotal < localTotal / 10;
}

/** Corregge campi deboli del JSON Gemini usando il rawText (regole locali). */
export function enrichGeminiDocumentExtract(
  extract: GeminiDocumentExtract,
  kind: 'quote' | 'order' = 'quote'
): GeminiDocumentExtract {
  const text = normalizeRawText(extract.rawText);
  if (!text) return extract;

  const lines = splitLines(text);
  const localNumber =
    kind === 'order' ? inferOrderNumber(text, lines) : inferQuoteNumber(text, lines);
  const localDate = inferDocumentDateText(text, lines, kind);
  const localRecipient = inferCustomerName(text, lines);
  const localTotal = inferTotal(lines, text);

  let documentNumber = extract.documentNumber?.trim() ?? '';
  if (
    !documentNumber ||
    isLikelyDateAsDocNumber(documentNumber) ||
    isLikelyReaOrAddressCode(documentNumber.replace(/\s+/g, '-').toUpperCase())
  ) {
    if (localNumber) documentNumber = localNumber;
  }

  let customerName = extract.customerName?.trim() ?? '';
  if (isWeakGeminiRecipient(customerName) && localRecipient) {
    customerName = localRecipient;
  }

  let date = extract.date?.trim() ?? '';
  if (localDate) {
    if (!date || geminiDateLooksLikeValidUntil(text, date)) {
      date = localDate;
    }
  }

  let total = extract.total;
  if (shouldPreferLocalTotal(total, localTotal)) {
    total = localTotal;
  }

  return {
    ...extract,
    ...(documentNumber ? { documentNumber } : {}),
    ...(customerName ? { customerName } : {}),
    ...(date ? { date } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

function uniqueDocumentAlternatives(
  alternatives: ReturnType<typeof documentFieldAlternative>[]
): ReturnType<typeof documentFieldAlternative>[] {
  return alternatives.filter(
    (candidate, index, values) =>
      values.findIndex(
        (value) => JSON.stringify(value) === JSON.stringify(candidate)
      ) === index
  );
}

function reconcileEnrichedCloudField(
  field: DocumentReliabilityFieldKey,
  cloud: DocumentFieldReliability | undefined,
  originalValue: unknown,
  enrichedValue: unknown
): DocumentFieldReliability {
  if (JSON.stringify(originalValue) === JSON.stringify(enrichedValue) && cloud) {
    return cloud;
  }

  const derivedFromCloudText = evaluateDocumentField(
    field,
    enrichedValue,
    {
      source: 'cloud_ai',
      confidenceType: 'unknown',
    }
  );
  if (!cloud || !isApplicableDocumentField(cloud)) {
    const cloudWasObserved =
      !!cloud &&
      (cloud.validationStatus !== 'missing' ||
        Object.prototype.hasOwnProperty.call(cloud, 'rawValue') &&
          cloud.rawValue !== undefined);
    return {
      ...derivedFromCloudText,
      alternatives: cloudWasObserved
        ? uniqueDocumentAlternatives([
            ...derivedFromCloudText.alternatives,
            documentFieldAlternative(cloud),
          ])
        : derivedFromCloudText.alternatives,
      requiresReview:
        derivedFromCloudText.requiresReview ||
        (cloudWasObserved && !!cloud?.requiresReview),
    };
  }

  if (
    JSON.stringify(derivedFromCloudText.value) ===
    JSON.stringify(cloud.value)
  ) {
    return {
      ...derivedFromCloudText,
      source: 'merged',
      alternatives: uniqueDocumentAlternatives([
        documentFieldAlternative(cloud),
        documentFieldAlternative(derivedFromCloudText),
      ]),
      requiresReview:
        derivedFromCloudText.requiresReview || cloud.requiresReview,
    };
  }

  const { value: _discardedValue, ...derivedWithoutValue } =
    derivedFromCloudText;
  return {
    ...derivedWithoutValue,
    source: 'merged',
    alternatives: uniqueDocumentAlternatives([
      documentFieldAlternative(cloud),
      documentFieldAlternative(derivedFromCloudText),
    ]),
    conflict: true,
    validationReasons: [
      ...derivedFromCloudText.validationReasons,
      'cloud_derived_value_conflict',
    ],
    requiresReview: true,
  };
}

function diagnoseBuildItems(
  inputItems: unknown,
  acceptedItems: QuoteItem[],
  rejectionReasons: Record<string, number>
): void {
  if (!PDF_LOCAL_DIAGNOSTICS || !isQaLogEnabled()) return;
  const list = Array.isArray(inputItems) ? inputItems : [];
  const first = list[0];
  const firstKeys =
    first && typeof first === 'object' && !Array.isArray(first)
      ? Object.keys(first as object)
      : [];
  const fieldTypes =
    first && typeof first === 'object' && !Array.isArray(first)
      ? Object.fromEntries(
          Object.entries(first as Record<string, unknown>).map(([key, value]) => [
            key,
            value && typeof value === 'object' && !Array.isArray(value)
              ? 'object'
              : typeof value,
          ])
        )
      : {};
  console.warn(
    `[PdfBuildItems] INPUT ${JSON.stringify({
      itemCount: list.length,
      firstItemKeys: firstKeys,
      fieldTypes,
    })}`
  );
  console.warn(
    `[PdfBuildItems] RESULT ${JSON.stringify({
      inputItems: list.length,
      acceptedItems: acceptedItems.length,
      rejectedItems: Math.max(0, list.length - acceptedItems.length),
      rejectionReasons,
    })}`
  );
}

function directDocumentItems(
  fieldReliability: DocumentFieldReliabilityMap
): QuoteItem[] {
  const evidence = fieldReliability.items;
  const rawList = Array.isArray(evidence?.value)
    ? evidence.value
    : Array.isArray(evidence?.rawValue)
      ? evidence.rawValue
      : [];
  const rejectionReasons: Record<string, number> = {};

  if (
    evidence &&
    !evidence.conflict &&
    (evidence.validationStatus === 'valid' ||
      evidence.validationStatus === 'unverified') &&
    Array.isArray(evidence.value)
  ) {
    const complete = completeGeminiItems(
      evidence.value as NonNullable<GeminiDocumentExtract['items']>,
      rejectionReasons
    );
    // Una riga incompleta non deve cancellare le altre già valide.
    if (complete.length > 0 && complete.length === evidence.value.length) {
      diagnoseBuildItems(evidence.value, complete, rejectionReasons);
      if (complete.length < evidence.value.length) {
        fieldReliability.items = {
          ...evidence,
          requiresReview: true,
          validationReasons: [
            ...evidence.validationReasons,
            'partial_items_applied',
          ],
        };
      }
      return complete;
    }
  }

  const observedCandidate =
    !!evidence &&
    (evidence.validationStatus !== 'missing' ||
      evidence.rawValue !== undefined);
  if (observedCandidate) {
    rejectionReasons[
      evidence?.conflict
        ? 'conflicting_items'
        : evidence?.validationStatus === 'invalid'
          ? 'invalid_items'
          : 'incomplete_items'
    ] = rawList.length || 1;
    const notApplied = evaluateDocumentField('items', [], {
      source: 'merged',
      confidenceType: 'unknown',
    });
    fieldReliability.items = {
      ...notApplied,
      alternatives: uniqueDocumentAlternatives([
        documentFieldAlternative(evidence),
        ...evidence.alternatives,
      ]),
      conflict: evidence.conflict,
      validationReasons: [
        ...notApplied.validationReasons,
        'incomplete_or_conflicting_items_not_applied',
      ],
      requiresReview: true,
    };
  }
  diagnoseBuildItems(rawList, [], rejectionReasons);
  return [];
}

function reliabilityForDirectCloudDocument(
  original: GeminiDocumentExtract,
  enriched: GeminiDocumentExtract,
  currency: string | undefined
): DocumentFieldReliabilityMap {
  const cloud = reliabilityFromCloudExtract(original);
  const result: DocumentFieldReliabilityMap = { ...cloud };
  const comparedFields = [
    'documentNumber',
    'customerName',
    'date',
    'subtotal',
    'vatAmount',
    'total',
    'items',
  ] as const;

  for (const field of comparedFields) {
    result[field] = reconcileEnrichedCloudField(
      field,
      cloud[field],
      original[field],
      enriched[field]
    );
  }
  result.currency = evaluateDocumentField('currency', currency, {
    source: 'cloud_ai',
    confidenceType: 'unknown',
  });
  return result;
}

function applicableReliabilityValue(
  reliability: DocumentFieldReliabilityMap,
  field: DocumentReliabilityFieldKey
): unknown {
  const evidence = reliability[field];
  return evidence && isApplicableDocumentField(evidence)
    ? evidence.value
    : undefined;
}

function completeGeminiItems(
  items: GeminiDocumentExtract['items'],
  rejectionReasons: Record<string, number> = {}
): QuoteItem[] {
  return (items ?? []).flatMap((item) => {
    const total =
      item.total !== undefined
        ? item.total
        : typeof (item as { lineTotal?: unknown }).lineTotal === 'number'
          ? (item as { lineTotal: number }).lineTotal
          : undefined;
    if (!item.description?.trim()) {
      rejectionReasons.missingDescription =
        (rejectionReasons.missingDescription ?? 0) + 1;
      return [];
    }
    if (item.quantity === undefined) {
      rejectionReasons.missingQuantity =
        (rejectionReasons.missingQuantity ?? 0) + 1;
      return [];
    }
    if (item.unitPrice === undefined) {
      rejectionReasons.missingUnitPrice =
        (rejectionReasons.missingUnitPrice ?? 0) + 1;
      return [];
    }
    if (total === undefined) {
      rejectionReasons.missingTotal = (rejectionReasons.missingTotal ?? 0) + 1;
      return [];
    }
    return [
      {
        description: item.description.trim(),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        total,
      },
    ];
  });
}

export function parseQuoteFromGemini(
  extract: GeminiDocumentExtract,
  options?: { enrich?: boolean }
): QuoteDocument {
  const enriched =
    options?.enrich === false
      ? extract
      : enrichGeminiDocumentExtract(extract, 'quote');
  const currency = explicitDocumentCurrency(enriched.rawText);
  const fieldReliability = reliabilityForDirectCloudDocument(
    extract,
    enriched,
    currency
  );
  const quoteNumberValue = applicableReliabilityValue(
    fieldReliability,
    'documentNumber'
  );
  const customerNameValue = applicableReliabilityValue(
    fieldReliability,
    'customerName'
  );
  const quoteDateValue = applicableReliabilityValue(
    fieldReliability,
    'date'
  );
  const quoteNumber =
    typeof quoteNumberValue === 'string' ? quoteNumberValue : undefined;
  const customerName =
    typeof customerNameValue === 'string' ? customerNameValue : undefined;
  const quoteDate =
    typeof quoteDateValue === 'string'
      ? strictDocumentDateToDate(quoteDateValue)
      : undefined;
  const items = directDocumentItems(fieldReliability);
  const subtotal = applicableReliabilityValue(fieldReliability, 'subtotal');
  const vatAmount = applicableReliabilityValue(fieldReliability, 'vatAmount');
  const total = applicableReliabilityValue(fieldReliability, 'total');
  const reliableCurrency = applicableReliabilityValue(
    fieldReliability,
    'currency'
  );

  return {
    id: createId(),
    type: 'quote',
    title: buildQuoteTitle(quoteNumber, customerName, quoteDate),
    images: [],
    quoteNumber,
    quoteDate,
    customerName,
    items,
    subtotal: typeof subtotal === 'number' ? subtotal : undefined,
    vatAmount: typeof vatAmount === 'number' ? vatAmount : undefined,
    total: typeof total === 'number' ? total : undefined,
    currency:
      typeof reliableCurrency === 'string' ? reliableCurrency : undefined,
    rawText: enriched.rawText,
    fieldReliability,
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function parseOrderFromGemini(
  extract: GeminiDocumentExtract,
  options?: { enrich?: boolean }
): OrderDocument {
  const enriched =
    options?.enrich === false
      ? extract
      : enrichGeminiDocumentExtract(extract, 'order');
  const currency = explicitDocumentCurrency(enriched.rawText);
  const fieldReliability = reliabilityForDirectCloudDocument(
    extract,
    enriched,
    currency
  );
  const orderNumberValue = applicableReliabilityValue(
    fieldReliability,
    'documentNumber'
  );
  const customerNameValue = applicableReliabilityValue(
    fieldReliability,
    'customerName'
  );
  const orderDateValue = applicableReliabilityValue(
    fieldReliability,
    'date'
  );
  const orderNumber =
    typeof orderNumberValue === 'string' ? orderNumberValue : undefined;
  const customerName =
    typeof customerNameValue === 'string' ? customerNameValue : undefined;
  const orderDate =
    typeof orderDateValue === 'string'
      ? strictDocumentDateToDate(orderDateValue)
      : undefined;
  const items: OrderItem[] = directDocumentItems(fieldReliability);
  const subtotal = applicableReliabilityValue(fieldReliability, 'subtotal');
  const vatAmount = applicableReliabilityValue(fieldReliability, 'vatAmount');
  const total = applicableReliabilityValue(fieldReliability, 'total');
  const reliableCurrency = applicableReliabilityValue(
    fieldReliability,
    'currency'
  );

  return {
    id: createId(),
    type: 'order',
    title: buildOrderTitle(orderNumber, customerName, orderDate),
    images: [],
    orderNumber,
    orderDate,
    customerName,
    items,
    subtotal: typeof subtotal === 'number' ? subtotal : undefined,
    vatAmount: typeof vatAmount === 'number' ? vatAmount : undefined,
    total: typeof total === 'number' ? total : undefined,
    currency:
      typeof reliableCurrency === 'string' ? reliableCurrency : undefined,
    rawText: enriched.rawText,
    fieldReliability,
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function parseInvoiceFromGemini(
  extract: GeminiDocumentExtract,
  options?: { enrich?: boolean }
): InvoiceDocument {
  const parsedQuote = parseQuoteFromGemini(extract, options);
  const {
    quoteNumber,
    quoteDate,
    type: _type,
    title: _title,
    ...shared
  } = parsedQuote;

  return {
    ...shared,
    type: 'invoice',
    title: buildInvoiceTitle(quoteNumber, parsedQuote.customerName, quoteDate),
    invoiceNumber: quoteNumber,
    invoiceDate: quoteDate,
  };
}

export function parseFreeDocument(
  lines: OcrLine[],
  rawText: string,
  options: { source?: 'local_ocr' | 'cloud_ai' } = {}
): FreeDocument {
  const text = normalizeRawText(rawText);
  const docNumberMatch = text.match(
    /(?:documento|document|doc\.?)\s*(?:n\.?|num\.?|numero|#)?\s*[:\-]?\s*([A-Z0-9\-\/]+)/i
  );
  const rawDate = inferDocumentDateText(text, splitLines(text), 'quote');
  const date = rawDate ? parseItalianDate(rawDate) : undefined;

  const extractedFields: Record<string, string> = {};
  lines
    .slice(0, 15)
    .map((l) => l.text.trim())
    .filter((t) => t.length > 3)
    .forEach((line, idx) => {
      extractedFields[`field_${idx + 1}`] = line;
    });

  return {
    id: createId(),
    type: 'free_document',
    title: docNumberMatch?.[1] ? `Documento ${docNumberMatch[1]}` : 'Documento libero',
    images: [],
    documentNumber: docNumberMatch?.[1],
    documentDate: date,
    extractedFields,
    rawText: text,
    fieldReliability: documentReliabilityFromValues(
      {
        documentNumber: docNumberMatch?.[1],
        date: rawDate,
        extractedFields,
      },
      options.source ?? 'local_ocr'
    ),
    confidence: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function sparseParsedPageItems(
  items: readonly (QuoteItem | OrderItem)[]
): DocumentPageItem[] {
  return items
    .map((item): DocumentPageItem => ({
      ...(item.description.trim()
        ? { description: item.description.trim() }
        : {}),
      ...(item.quantity != null && item.quantity >= 0
        ? { quantity: item.quantity }
        : {}),
      ...(item.unitPrice >= 0 ? { unitPrice: item.unitPrice } : {}),
      ...(item.total >= 0 ? { total: item.total } : {}),
      // Il parser locale usa oggi IVA 22 come default: non è evidenza della
      // singola pagina e quindi non viene promossa nel risultato sparse.
    }))
    .filter((item) => Object.keys(item).length > 0);
}

function sparseLineItems(lines: string[]): DocumentPageItem[] {
  const complete = sparseParsedPageItems(parseLineItems(lines));
  const partial = lines.flatMap((line): DocumentPageItem[] => {
    if (
      /^(\d+)\s+(.+?)\s+(\d+[,\.]\d{2})\s+(\d+[,\.]\d{2})\s*$/.test(
        line
      ) ||
      /^(\d+)\s+(.+?)\s+(\d+[,\.]\d{2})\s*$/.test(line)
    ) {
      return [];
    }
    const match = line.match(/^(.{4,}?)\s+(\d+[,\.]\d{2})\s*$/);
    if (!match) return [];
    const description = match[1].trim();
    if (/^(totale|subtotale|imponibile|iva|mano\s*dop)/i.test(description)) {
      return [];
    }
    const amount = parseAmount(match[2]);
    return amount === undefined
      ? []
      : [{ description, unitPrice: amount, total: amount }];
  });
  return [...complete, ...partial];
}

function explicitDocumentCurrency(rawText: string): string | undefined {
  const currencies = new Set(
    [...rawText.matchAll(/\b(EUR|USD|GBP|CHF|CAD|AUD|JPY|CNY|SEK|NOK|DKK|PLN)\b/gi)]
      .map((match) => match[1].toUpperCase())
  );
  if (rawText.includes('€')) currencies.add('EUR');
  if (rawText.includes('£')) currencies.add('GBP');
  return currencies.size === 1 ? [...currencies][0] : undefined;
}

/**
 * Adatta il parser locale al contratto per-pagina senza rendere affidabili i
 * suoi valori di default. In particolare, date predefinite, importi pari a
 * zero, stringhe vuote e collezioni vuote non entrano nei campi strutturati.
 *
 * La validazione delle date resta intenzionalmente fuori da questa funzione:
 * verrà affrontata nella Fase 3.
 */
function sparseCommercialPageFields(
  documentType: 'quote' | 'order' | 'invoice',
  normalizedText: string,
  normalizedLines: string[],
): DocumentPageStructuredFields {
  const pageItems = sparseLineItems(normalizedLines);
  const rawDate = inferDocumentDateText(
    normalizedText,
    normalizedLines,
    documentType === 'invoice' ? 'order' : documentType,
  );
  const documentNumber =
    findSlashDocumentNumber(normalizedText)?.trim()
    || findDocumentCode(normalizedText)?.trim()
    || '';
  const customerName = cleanCustomerName(findCustomerName(normalizedText, normalizedLines)?.trim() || '');
  const vatMatch = normalizedText.match(
    /(?:p\.?\s*iva|vat|partita\s*iva)\s*[:\-]?\s*([A-Z0-9][A-Z0-9 .\-]{7,})/i,
  );
  const total = findDocumentTotalNearLabel(normalizedLines, 6);
  const subtotal = findMoneyNearLabel(normalizedLines, isDocumentSubtotalLabelLine, 3);
  const vatAmount = findMoneyNearLabel(normalizedLines, isDocumentVatLabelLine, 2);
  return {
    ...(documentNumber ? { documentNumber } : {}),
    ...(customerName ? { customerName } : {}),
    ...(rawDate ? { date: rawDate } : {}),
    ...(vatMatch?.[1]?.trim() ? { vatNumber: vatMatch[1].trim() } : {}),
    ...(subtotal !== undefined ? { subtotal } : {}),
    ...(vatAmount !== undefined ? { vatAmount } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(explicitDocumentCurrency(normalizedText)
      ? { currency: explicitDocumentCurrency(normalizedText) }
      : {}),
    ...(pageItems.length > 0 ? { items: pageItems } : {}),
  };
}

/** Per Elabora/new_scan: solo campi header economici, niente parseLineItems. */
export function parseMinimalScanPageFields(
  documentType: DocumentType,
  lines: OcrLine[],
  rawText: string,
): DocumentPageStructuredFields {
  if (!rawText.trim() && lines.length === 0) return {};
  const normalizedText = normalizeRawText(rawText.slice(0, 4_000));
  const normalizedLines = splitLines(normalizedText).slice(0, 40);
  switch (documentType) {
    case 'quote':
    case 'order':
    case 'invoice': {
      const documentNumber =
        findSlashDocumentNumber(normalizedText)?.trim()
        || findDocumentCode(normalizedText)?.trim()
        || '';
      const rawDate = inferDocumentDateText(
        normalizedText,
        normalizedLines,
        documentType === 'invoice' ? 'order' : documentType,
      );
      return {
        ...(documentNumber ? { documentNumber } : {}),
        ...(rawDate ? { date: rawDate } : {}),
        ...(explicitDocumentCurrency(normalizedText)
          ? { currency: explicitDocumentCurrency(normalizedText) }
          : {}),
      };
    }
    case 'free_document': {
      const rawDate = inferDocumentDateText(normalizedText, normalizedLines, 'quote');
      const documentNumber =
        findSlashDocumentNumber(normalizedText)?.trim()
        || findDocumentCode(normalizedText)?.trim()
        || '';
      return {
        ...(documentNumber ? { documentNumber } : {}),
        ...(rawDate ? { date: rawDate } : {}),
        ...(explicitDocumentCurrency(normalizedText)
          ? { currency: explicitDocumentCurrency(normalizedText) }
          : {}),
      };
    }
    case 'business_card':
      return {};
  }
}

export function parseSparseDocumentPageFields(
  documentType: DocumentType,
  lines: OcrLine[],
  rawText: string
): DocumentPageStructuredFields {
  if (!rawText.trim() && lines.length === 0) return {};
  const normalizedText = normalizeRawText(rawText);
  const normalizedLines = splitLines(normalizedText);

  switch (documentType) {
    case 'quote':
      return sparseCommercialPageFields('quote', normalizedText, normalizedLines);
    case 'order':
      return sparseCommercialPageFields('order', normalizedText, normalizedLines);
    case 'invoice':
      return sparseCommercialPageFields('invoice', normalizedText, normalizedLines);
    case 'free_document': {
      const parsed = parseFreeDocument(lines, rawText);
      const normalizedText = normalizeRawText(rawText);
      const rawDate = inferDocumentDateText(
        normalizedText,
        splitLines(normalizedText),
        'quote'
      );
      return {
        ...(parsed.documentNumber?.trim()
          ? { documentNumber: parsed.documentNumber.trim() }
          : {}),
        ...(rawDate ? { date: rawDate } : {}),
        ...(explicitDocumentCurrency(rawText)
          ? { currency: explicitDocumentCurrency(rawText) }
          : {}),
        ...(Object.keys(parsed.extractedFields).length > 0
          ? { extractedFields: parsed.extractedFields }
          : {}),
      };
    }
    case 'business_card':
      return {};
  }
}

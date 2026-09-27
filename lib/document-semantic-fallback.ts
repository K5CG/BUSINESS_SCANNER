import type { StructuredDocumentType } from './document-structure';
import type { StructuredDocumentExtraction } from './document-structure';
import type { DocumentEvidence } from './document-structure';
import { findCustomerName, findSlashDocumentNumber, isDocumentTypeHeaderText, repairDocumentNumberPrefixOcr } from './ocr-normalize';
import { isImplausiblePartyName } from './document-parties-metadata';
import { isPaymentSectionContext, isRejectedIssuerName } from './document-issuer-model';
import { inferCanonicalDocumentType } from './document-label-dictionary';
import { parseInternationalDate } from './document-international-values';
import { extractInlineDocumentNumberDate } from './document-inline-date';
import { documentProcessPerfStageEnd, documentProcessPerfStageStart } from './document-process-perf';
import {
  isImplausibleOrganizationName,
  isSalesContactLabel,
  looksLikePartySectionHeading,
  resolveExclusivePartyRoles,
  shouldReplacePartyValue,
} from './document-party-roles';
import { isVatExcludedLanguage, sameAmountCannotBeTotalAndVat } from './document-money-semantics';
import { isYearLikeStandaloneAmount, looksLikeDocumentDiscountMoney } from './document-discount-ownership';
import { logSemanticRoleViolation } from './document-field-evidence';
import {
  classifyNumericFieldQuality,
  decideFallbackReplacement,
} from './document-field-quality';

export function fallbackDocumentEvidence<T>(
  rawValue: unknown,
  normalizedValue: T | undefined,
  reasons: string[],
  requiresReview = true,
): DocumentEvidence<T> {
  return {
    rawValue,
    ...(normalizedValue !== undefined ? { normalizedValue } : {}),
    pageIndex: 0,
    sourceLineIds: [],
    sourceLines: [],
    source: 'local',
    validationStatus: 'unverified',
    confidenceType: 'heuristic',
    reasons,
    requiresReview,
    alternatives: [],
  };
}

const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

const STRONG_NUMBER_PATTERNS: RegExp[] = [
  /\b([A-Z]{1,4}\s+\d{2,4}\/\d{3,8})\b/i,
  /\bnumero\s+documento\s*[:\-]?\s*(\d+\s*\/\s*[A-Z0-9]{1,4})/i,
  /\b(?:ordine|preventivo|fattura|conferma\s+ordine)\s+n\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.\-]{2,24})/i,
  /\b(?:quotation|quote|order|invoice)\s+(?:no\.?|number)\s*[:\-#]?[ \t]+([A-Z0-9][A-Z0-9/_.\-]{2,24})/i,
  /\b(?:Angebotsnummer|Auftragsnummer|Rechnungsnummer)\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.\-]{2,24})/i,
  /\b(?:num[eé]ro\s+de\s+devis|commande)\s*(?:n[°º.]?|no\.?)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.\-]{2,24})/i,
  /\b(?:presupuesto|pedido|factura)\s+n[°º.]?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.\-]{2,24})/i,
  /\b(?:facture|fattura|invoice|presupuesto)\s+([A-Z]{2,8}[-/]\d{2,4}[-/][A-Z0-9]{2,8}(?:-[A-Z])?)\b/i,
  /\bPresupuesto\s+N[°º.]?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.\-]{2,24})/i,
  /\bDevis\s+N[°º.]?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.\-]{2,24})/i,
  /\bQuotation\s+No\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/_.\-]{2,24})/i,
];

const HEADER_GRID_VALUE_NOISE =
  /^(?:amount|due|date|issued|number|total|subtotal|discount|tax|invoice|rate|qty|quantity|description|deposit)$/i;

const WEAK_ARTICLE_CODE = /^[A-Z]{2,4}-\d{1,3}$/i;
const REGISTRY_NOISE = /\b(?:registro\s+mercantil|reg\.?\s*merc|companies\s+house|hrb)\b/i;

const PARTY_ANCHOR =
  /^(?:client|cliente(?:\s*\/\s*intestazione\s+fattura)?|customer|kunde|destinatario|facturer\s+[àa]|fatturare\s+a|consegnare\s+a|livrer\s+[àa]|bill\s+to|ship\s+to|datos\s+del\s+cliente|cliente\s*\/\s*intestazione\s+fattura|to:?)(?:\s*\/\s*.+)?$/i;

const PARTY_SECTION_HEADER =
  /^(?:descripci[oó]n(?:\s+del\s+suministro)?|description|objet|subject|r[eé]f[eé]rence|nous avons|table|art\.?-?\s*nr|codice|referencia)$/i;

const OCR_NOISE_LINE = /^[A-Z]{1,4}$/;

const COMPANY_SUFFIX =
  /\b(?:S\.?\s*A\.?\s*S\.?|S\.?\s*r\.?\s*l\.?|GmbH|AG|Ltd\.?|S\.?\s*L\.?|S\.?\s*p\.?\s*A\.?|Inc\.?|Corp\.?|SAS|KG)\b/i;

function normalizeNumber(value: string): string {
  const trimmed = value.trim();
  const spacedPrefix = trimmed.match(/^([A-Z]{1,4})\s+(\d{2,4}\/\d{3,8})$/i);
  if (spacedPrefix) {
    return repairDocumentNumberPrefixOcr(`${spacedPrefix[1].toUpperCase()} ${spacedPrefix[2]}`);
  }
  return repairDocumentNumberPrefixOcr(trimmed.replace(/\s+/g, ''));
}

function isStrongDocumentNumberLabel(text: string): boolean {
  return /\b(?:quotation\s+no\.?|quote\s+no\.?|order\s+no\.?|invoice\s+no\.?|preventivo\s+n\.?|ordine\s+n\.?|fattura\s+n\.?|numero\s+documento|document\s+no\.?)\b/i.test(text);
}

function isLowConfidenceNumber(value: string, contextLine: string): boolean {
  const trimmed = normalizeNumber(value);
  if (!trimmed) return true;
  if (HEADER_GRID_VALUE_NOISE.test(trimmed)) return true;
  if (/^\d{1,2}\/\d{1,2}/.test(trimmed)) return true;
  if (WEAK_ARTICLE_CODE.test(trimmed) && !/\b(?:ordine|preventivo|fattura|quotation|order|invoice|devis|presupuesto|angebot)\b/i.test(contextLine)) {
    return true;
  }
  if (REGISTRY_NOISE.test(contextLine) && !/\b(?:n\.|no\.|numero|number|num[eé]ro)\b/i.test(contextLine)) {
    return true;
  }
  return false;
}

export function extractStrongDocumentNumber(
  rawText: string,
  lines: readonly string[],
): string | undefined {
  const slash = findSlashDocumentNumber(rawText);
  if (slash) return normalizeNumber(slash);

  const slashNearOrder = rawText.match(/\b(\d{4}\/\d{3,5})\b/);
  if (slashNearOrder?.[1] && /\bordine\s+n/i.test(rawText)) {
    return normalizeNumber(slashNearOrder[1]);
  }

  for (let i = 0; i < Math.min(lines.length, 80); i++) {
    const line = lines[i];
    if (/^(?:Invoice|Order|Quote|Quotation|Fattura|Preventivo|Ordine|Presupuesto|Devis)\s+(?:Number|No\.?|Numero)$/i.test(line.trim())) {
      for (let offset = 1; offset <= 4; offset++) {
        const next = lines[i + offset]?.trim();
        if (!next || HEADER_GRID_VALUE_NOISE.test(next) || isLowConfidenceNumber(next, `${line}\n${next}`)) continue;
        const token = next.match(/^([A-Z0-9][A-Z0-9/_.-]{2,24})$/i)?.[1];
        if (token && /\d/.test(token)) return normalizeNumber(token);
      }
    }
    if (/^(?:Quotation|Ordine|Preventivo|Presupuesto|Devis)\s+No\.?$/i.test(line.trim())) {
      const next = lines[i + 1]?.trim();
      if (next && !isLowConfidenceNumber(next, `${line}\n${next}`)) {
        return normalizeNumber(next);
      }
    }
    if (/^(?:Ordine|Preventivo|Fattura)\s+n\.?$/i.test(line.trim())) {
      for (let offset = 1; offset <= 8; offset++) {
        const candidate = lines[i - offset]?.trim() ?? lines[i + offset]?.trim();
        const slashMatch = candidate?.match(/^(\d{4}\/\d{3,5})$/);
        if (slashMatch?.[1]) return normalizeNumber(slashMatch[1]);
      }
    }
    if (/^Devis\s+N[°º.]?\s*:?\s*$/i.test(line.trim())) {
      const next = lines[i + 1]?.trim();
      if (next && !isLowConfidenceNumber(next, `${line}\n${next}`)) {
        return normalizeNumber(next);
      }
    }
    if (/^(?:Angebotsnummer|Auftragsnummer|Rechnungsnummer)\s*:?\s*$/i.test(line.trim())) {
      const next = lines[i + 1]?.trim();
      if (next && !isLowConfidenceNumber(next, `${line}\n${next}`)) {
        return normalizeNumber(next);
      }
    }
    for (const pattern of STRONG_NUMBER_PATTERNS) {
      const match = line.match(pattern);
      const candidate = match?.[1]?.trim();
      if (!candidate || isLowConfidenceNumber(candidate, line)) continue;
      if (/^[A-Z]{2,8}-[A-Z]{2,10}-\d{1,4}$/i.test(candidate) && !isStrongDocumentNumberLabel(line)) continue;
      return normalizeNumber(candidate);
    }
  }

  for (const pattern of STRONG_NUMBER_PATTERNS) {
    const match = rawText.match(pattern);
    const candidate = match?.[1]?.trim();
    if (!candidate || candidate.includes('\n') || isLowConfidenceNumber(candidate, match?.[0] ?? '')) continue;
    return normalizeNumber(candidate);
  }

  return undefined;
}

function parseAmount(text: string): number | undefined {
  if (/\b(?:siret|iban|bic|intracommunautaire|hrb|registro|mercantil)\b/i.test(text)) {
    return undefined;
  }
  const trimmed = text.trim();
  if (/^\d+\.\s+[A-Za-zÀ-ÿ]/.test(trimmed)) {
    return undefined;
  }
  if (/^(?:iva|tva|vat|mwst|ust)\s*[(:]?\s*\d+\s*%?\s*:?\s*$/i.test(trimmed)) {
    return undefined;
  }
  if (/^(?:tva|iva|vat|mwst)\s+\d+\s*%$/i.test(trimmed)) {
    return undefined;
  }
  if (/^\d+\s*%$/.test(trimmed)) {
    return undefined;
  }
  const amountMatch = text.match(/(\d[\d\s.,]{1,18})/);
  if (!amountMatch) return undefined;
  const raw = amountMatch[1].trim().replace(/\s/g, '');
  let normalized: string;
  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot
      ? raw.replace(/\./g, '').replace(',', '.')
      : raw.replace(/,/g, '');
  } else if (lastComma >= 0 && /,\d{2}$/.test(raw)) {
    normalized = raw.replace(/\./g, '').replace(',', '.');
  } else if (lastDot >= 0) {
    normalized = raw.replace(/,/g, '');
  } else {
    normalized = raw.replace(/,/g, '.');
  }
  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value) || value <= 0 || value > 10_000_000) return undefined;
  if (value <= 30 && /%/.test(text)) return undefined;
  if (/^(?:iva|tva|vat|mwst)\b/i.test(trimmed) && /%/.test(text) && value > 30 && !/\d[,\.]\d{2}/.test(raw)) return undefined;
  if (!/(?:€|EUR|GBP|USD)/i.test(text) && !/\d[,\.]\d{2}/.test(raw) && value <= 30) return undefined;
  return value;
}

function isTableColumnHeader(line: string): boolean {
  return /^(?:tva|iva|vat|mwst|qty|qt[eé]|qta|rate|amount|pu ht|montant ht(?:\s*\([o0]?\))?|ref|r[eé]f|codice|descrizione|description|sconto|discount|remise|rabatt|descuento)$/i.test(line.trim());
}

function isDescriptionLine(line: string): boolean {
  return /^(?:suministro|supply|installation|fourniture|descripci|description|proposta|nous avons|gerne bieten)/i.test(line.trim());
}

function isPartyAnchorLine(line: string): boolean {
  const trimmed = line.trim();
  return PARTY_ANCHOR.test(trimmed) || /^CLIENT$/i.test(trimmed) || /^datos\s+del\s+cliente$/i.test(trimmed);
}

function isSummaryContextLine(line: string): boolean {
  return /\b(?:total\s+(?:ht|ttc|net)|grand total|gesamtbetrag|totale\s+ordine|base\s+imponible|nettobetrag|amount due|subtotal|imponibile\s+netto|totale\s+iva|totale\s+imposta|importo\s+iva|vat\s+amount)\b/i.test(line)
    || /^(?:tax|iva|vat|tva|mwst)$/i.test(line.trim());
}

const PAGE_LEVEL_SUBTOTAL =
  /\b(?:sous[-\s]?total|subtotal|zwischensumme)\s+(?:page\s*)?\d+/i;

type SemanticTotalKind = 'subtotal' | 'vat' | 'total';

interface SemanticTotalRule {
  kind: SemanticTotalKind;
  pattern: RegExp;
  priority: number;
  field: string;
}

const SEMANTIC_TOTAL_RULES: SemanticTotalRule[] = [
  { kind: 'subtotal', field: 'net', pattern: /\btotal\s+ht\b/i, priority: 100 },
  { kind: 'subtotal', field: 'net', pattern: /\bmontant\s+ht\b/i, priority: 98 },
  { kind: 'subtotal', field: 'net', pattern: /\bbase\s+imponible\s+neta\b/i, priority: 98 },
  { kind: 'subtotal', field: 'net', pattern: /\bbase\s+imponible\b/i, priority: 94 },
  { kind: 'subtotal', field: 'net', pattern: /\bnettobetrag\b/i, priority: 96 },
  { kind: 'subtotal', field: 'net', pattern: /\bimponibile\s+netto\b/i, priority: 96 },
  { kind: 'subtotal', field: 'net', pattern: /\btotale\s+imponibile\b/i, priority: 99 },
  { kind: 'subtotal', field: 'net', pattern: /\btotale\s+m?pon\w*/i, priority: 97 },
  { kind: 'subtotal', field: 'net', pattern: /\bimponibile\b/i, priority: 90 },
  { kind: 'subtotal', field: 'net', pattern: /\bnet\s+amount\b/i, priority: 95 },
  { kind: 'subtotal', field: 'net', pattern: /\bsubtotal\b/i, priority: 70 },
  { kind: 'vat', field: 'vat', pattern: /\btva\s+\d+\s*%/i, priority: 100 },
  { kind: 'vat', field: 'vat', pattern: /\biva\s*(?:\(\d+\s*%\)|\d+\s*%)/i, priority: 100 },
  { kind: 'vat', field: 'vat', pattern: /\bvat\s*@\s*\d+\s*%/i, priority: 100 },
  { kind: 'vat', field: 'vat', pattern: /\bmwst\.?\s*\d+\s*%/i, priority: 100 },
  { kind: 'vat', field: 'vat', pattern: /\b(?:importo\s+iva|totale\s+iva|vat\s+amount|montant\s+tva|totale\s+imposta)\b/i, priority: 98 },
  { kind: 'vat', field: 'vat', pattern: /\b(?:iva|vat|tva)\s*\/\s*(?:iva|vat|tva)\b/i, priority: 96 },
  { kind: 'vat', field: 'vat', pattern: /\b(?:tva|iva|mwst)\s*[:\-]/i, priority: 92 },
  { kind: 'vat', field: 'vat', pattern: /^(?:tax|iva|vat|tva|mwst)\s*$/i, priority: 90 },
  { kind: 'total', field: 'grandTotal', pattern: /\btotal\s+ttc\b/i, priority: 100 },
  { kind: 'total', field: 'grandTotal', pattern: /\bgrand\s+total\b/i, priority: 100 },
  { kind: 'total', field: 'grandTotal', pattern: /\bgesamtbetrag\b/i, priority: 100 },
  { kind: 'total', field: 'grandTotal', pattern: /\btotale\s+ordine\b/i, priority: 98 },
  { kind: 'total', field: 'grandTotal', pattern: /\btotale\s+(?:documento|ordine|fattura|preventivo)\b/i, priority: 96 },
  { kind: 'total', field: 'grandTotal', pattern: /\bamount\s+due\b/i, priority: 96 },
  { kind: 'total', field: 'grandTotal', pattern: /\btotal\s+due\b/i, priority: 98 },
  { kind: 'total', field: 'grandTotal', pattern: /\btotal\s+(?:factura|presupuesto|documento)\b/i, priority: 96 },
  { kind: 'total', field: 'grandTotal', pattern: /^totale\b/i, priority: 88 },
  { kind: 'total', field: 'grandTotal', pattern: /^total\s*:?\s*$/i, priority: 97 },
  { kind: 'subtotal', field: 'pageSubtotal', pattern: PAGE_LEVEL_SUBTOTAL, priority: 15 },
];

interface SemanticAmountCandidate {
  kind: SemanticTotalKind;
  value: number;
  priority: number;
  labelText: string;
  valueText: string;
  pageIndex: number;
  distance: number;
  score: number;
  field: string;
}

function logSemanticCandidate(candidate: SemanticAmountCandidate): void {
  if (!IS_DEV) return;
  console.warn('[SemanticFallback] total_candidate', JSON.stringify({
    field: candidate.field,
    kind: candidate.kind,
    label: candidate.labelText,
    value: candidate.valueText,
    pageIndex: candidate.pageIndex,
    distance: candidate.distance,
    score: candidate.score,
  }));
}

function isPageSubtotalContext(lines: readonly string[], index: number): boolean {
  for (let offset = -2; offset <= 2; offset++) {
    if (offset === 0) continue;
    const line = lines[index + offset]?.trim() ?? '';
    if (PAGE_LEVEL_SUBTOTAL.test(line)) return true;
  }
  return false;
}

function looksLikeVatRateValue(value: number, text: string): boolean {
  if (/%/.test(text) && value <= 30) return true;
  if (value > 0 && value <= 23 && Number.isInteger(value) && !/[.,]\d/.test(text)) return true;
  if (Number.isInteger(value) && value > 23 && value <= 365 && /\b(?:validit[aà]|giorni|giorno|\bgg\b|days?)\b/i.test(text)) {
    return true;
  }
  return false;
}

function amountFromSameLine(labelLine: string, rule: SemanticTotalRule): number | undefined {
  if (rule.kind === 'total' && /(?:totale|total)\s+\.\d/i.test(labelLine)) return undefined;
  const match = labelLine.match(rule.pattern);
  const matchedLabel = match?.[0]?.replace(/[\d.,]+$/g, '').trim() ?? '';
  const after = match && match.index !== undefined
    ? labelLine.slice(match.index + matchedLabel.length)
    : labelLine.replace(rule.pattern, ' ');
  const parsed = parseAmount(after.replace(/[:\-–—]/g, ' '));
  if (parsed !== undefined && !looksLikeVatRateValue(parsed, after)) return parsed;
  if (rule.kind === 'total') {
    const amounts: number[] = [];
    const remainder = after.replace(/[:\-–—]/g, ' ');
    const global = remainder.matchAll(/(\d[\d\s.,]{2,18})/g);
    for (const token of global) {
      const value = parseAmount(token[1]);
      if (value !== undefined && value >= 100 && !looksLikeVatRateValue(value, token[1])) amounts.push(value);
    }
    if (amounts.length > 0) return Math.max(...amounts);
  }
  return parsed !== undefined && !looksLikeVatRateValue(parsed, after) ? parsed : undefined;
}

function collectAmountCandidates(
  lines: readonly string[],
  index: number,
  labelLine: string,
  rule: SemanticTotalRule,
): Array<{ value: number; valueText: string; distance: number; direction: 'same' | 'before' | 'after' }> {
  const candidates: Array<{ value: number; valueText: string; distance: number; direction: 'same' | 'before' | 'after' }> = [];
  const sameLineAmount = amountFromSameLine(labelLine, rule);
  if (sameLineAmount !== undefined) {
    candidates.push({ value: sameLineAmount, valueText: labelLine, distance: 0, direction: 'same' });
  }
  const maxDistance = rule.kind === 'total' || rule.priority >= 95 ? 8 : 3;
  const garbledTotal = rule.kind === 'total' && /(?:totale|total)\s+\.\d/i.test(labelLine);
  for (let distance = 1; distance <= maxDistance; distance++) {
    for (const direction of ['before', 'after'] as const) {
      if (garbledTotal && direction === 'before') continue;
      const idx = direction === 'before' ? index - distance : index + distance;
      const line = lines[idx]?.trim();
      if (!line) continue;
      const amount = parseAmount(line);
      if (amount === undefined) continue;
      if (looksLikeVatRateValue(amount, line)) continue;
      // Summary totals must have an actual monetary representation. This
      // rejects location codes and years such as CAP 42015 / Incoterms 2020
      // even when an inverted OCR reading order places them next to a label.
      if (!/(?:€|EUR|USD|GBP|CHF|\bE\b)|\d[.,]\d{2}\b/i.test(line)) continue;
      if (rule.kind === 'vat' && /\b(?:validit[aà]|giorni|giorno|\bgg\b|days?)\b/i.test(line) && !/(?:€|EUR|USD|GBP|CHF)|\d[.,]\d{2}\b/i.test(line)) {
        continue;
      }
      if (/^(?:page\s+\d|subject to|valid|thank you|notes|observaciones)/i.test(line)) continue;
      if (
        rule.kind === 'subtotal'
        && /\b(?:spese?|trasporto|shipping|freight|contributo\s+logistico|handling)\b/i.test(line)
      ) {
        continue;
      }
      candidates.push({ value: amount, valueText: line, distance, direction });
    }
  }
  return candidates;
}

function scoreAmountCandidate(
  candidate: { value: number; valueText: string; distance: number; direction: 'same' | 'before' | 'after' },
  rule: SemanticTotalRule,
  labelIndex: number,
  lines: readonly string[],
): number {
  let score = rule.priority;
  score -= candidate.distance * 6;
  if (candidate.direction === 'same') score += 8;
  if (rule.kind === 'total' && /\d[.,]\d{3}[.,]\d{2}/.test(candidate.valueText)) score += 24;
  if (rule.kind === 'total' && candidate.value >= 1000) score += 8;
  if (rule.kind === 'subtotal' && candidate.direction === 'same') score += 18;
  if (rule.kind === 'subtotal' && candidate.direction === 'after') score += 16;
  if (rule.kind === 'subtotal' && candidate.direction === 'before' && rule.priority < 90) score -= 18;
  if (rule.kind === 'subtotal' && candidate.direction === 'before' && rule.priority >= 90) score += 10;
  if (rule.kind === 'subtotal' && candidate.direction === 'after' && rule.priority >= 95) score += 12;
  if (rule.kind === 'total' && candidate.direction === 'after' && rule.priority >= 95) score += 12;
  if (rule.kind === 'total' && candidate.direction === 'before' && rule.priority >= 95) score += 12;
  if (rule.kind === 'vat' && candidate.direction === 'after' && rule.priority >= 90) score += 8;
  if (rule.kind === 'vat' && candidate.direction === 'before' && rule.priority >= 90) score += 4;
  if (rule.priority >= 85 && rule.priority < 95 && isPageSubtotalContext(lines, labelIndex)) {
    score -= 45;
  }
  if (rule.priority >= 85 && rule.priority < 95 && isPageSubtotalContext(lines, labelIndex + (candidate.direction === 'before' ? -candidate.distance : candidate.distance))) {
    score -= 35;
  }
  if (rule.priority <= 20) score -= 25;
  return score;
}

function findSemanticDiscount(lines: readonly string[]): number | undefined {
  const acceptable = (text: string, value: number | undefined): value is number => {
    if (value === undefined || !(value > 23)) return false;
    if (isYearLikeStandaloneAmount(text, value)) return false;
    return looksLikeDocumentDiscountMoney(text, value);
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\b(?:discount|sconto|remise|rabatt|descuento)\b/i.test(line)) continue;
    if (isTableColumnHeader(line)) continue;
    if (/\b(?:iva|vat|tva|mwst|manodopera|labor)\b/i.test(line)) continue;
    const stripped = line.replace(/\b(?:discount|sconto|remise|rabatt|descuento)\b/ig, ' ');
    if (/\d+(?:[.,]\d+)?\s*%/.test(line) && parseAmount(stripped) === undefined) continue;
    const documentLevel = /\b(?:totale|total|documento|merci|merce|globale|document|ht)\b/i.test(line)
      || /:/.test(line);
    const same = parseAmount(stripped);
    if (acceptable(line, same)) return -Math.abs(same);
    if (!documentLevel) continue;
    const nextLine = lines[index + 1];
    if (nextLine && /\b(?:iva|vat|tva|mwst)\b/i.test(nextLine)) continue;
    const next = nextLine ? parseAmount(nextLine) : undefined;
    if (nextLine && acceptable(nextLine, next)) return -Math.abs(next);
  }
  return undefined;
}

export function findSemanticDocumentTotals(
  lines: readonly string[],
): Partial<Record<SemanticTotalKind, number>> {
  const winners: Partial<Record<SemanticTotalKind, SemanticAmountCandidate>> = {};
  const pools: Record<SemanticTotalKind, SemanticAmountCandidate[]> = {
    subtotal: [],
    vat: [],
    total: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (!line) continue;
    if (isTableColumnHeader(line)) continue;
    if (/^montant\s+ht\s*\(/i.test(line)) continue;
    if (/\bsous[-\s]?total\b/i.test(line) && !/\btotal\s+ht\b/i.test(line) && PAGE_LEVEL_SUBTOTAL.test(line)) {
      continue;
    }
    if (/\bsubtotal\b/i.test(line) && /\bpage\b/i.test(line)) continue;

    for (const rule of SEMANTIC_TOTAL_RULES) {
      if (!rule.pattern.test(line)) continue;
      if (rule.priority <= 20) continue;
      if (rule.kind === 'vat' && isVatExcludedLanguage(line)) continue;
      if (rule.kind === 'vat' && rule.priority < 100 && !isSummaryContextLine(line) && !/[:)]/.test(line)) continue;
      if (rule.kind === 'subtotal' && rule.priority < 90 && PAGE_LEVEL_SUBTOTAL.test(line)) continue;
      if (rule.kind === 'subtotal' && rule.priority < 90 && /\bsous[-\s]?total\b/i.test(line)) continue;
      if (rule.kind === 'subtotal' && /\b(?:spese?|trasporto|shipping|freight|porto|transport|contributo\s+logistico|handling)\b/i.test(line)) continue;

      const amountCandidates = collectAmountCandidates(lines, i, line, rule);
      for (const amountCandidate of amountCandidates) {
        const score = scoreAmountCandidate(amountCandidate, rule, i, lines);
        if (score < 40) continue;
        const candidate: SemanticAmountCandidate = {
          kind: rule.kind,
          value: amountCandidate.value,
          priority: rule.priority,
          labelText: line,
          valueText: amountCandidate.valueText,
          pageIndex: 0,
          distance: amountCandidate.distance,
          score,
          field: rule.field,
        };
        logSemanticCandidate(candidate);
        pools[rule.kind].push(candidate);
        const current = winners[rule.kind];
        if (!current || candidate.score > current.score || (candidate.score === current.score && candidate.priority > current.priority)) {
          winners[rule.kind] = candidate;
        }
      }
    }
  }

  const vatExcluded = lines.some((line) => isVatExcludedLanguage(line));
  const reconciled = reconcileSemanticTotals(pools, lines);
  if (reconciled) {
    if (vatExcluded || sameAmountCannotBeTotalAndVat(reconciled.vat, reconciled.total)) {
      const { vat: _drop, ...rest } = reconciled;
      return rest;
    }
    return reconciled;
  }

  const vat = winners.vat?.value;
  const total = winners.total?.value;
  const dropVat = vatExcluded || sameAmountCannotBeTotalAndVat(vat, total);
  return {
    ...(winners.subtotal ? { subtotal: winners.subtotal.value } : {}),
    ...(winners.vat && !dropVat ? { vat: winners.vat.value } : {}),
    ...(winners.total ? { total: winners.total.value } : {}),
  };
}

function hasExplicitDocumentDiscount(lines: readonly string[]): boolean {
  return lines.some((line) => /\b(?:discount|sconto|remise|rabatt|descuento)\b/i.test(line)
    && /[-−].*\d|[€$£]\s*-|\d[.,]\d{2}/.test(line));
}

function reconcileSemanticTotals(
  pools: Record<SemanticTotalKind, SemanticAmountCandidate[]>,
  lines: readonly string[] = [],
): Partial<Record<SemanticTotalKind, number>> | null {
  const subs = [...pools.subtotal].sort((a, b) => b.score - a.score).slice(0, 4);
  const vats = [...pools.vat].sort((a, b) => b.score - a.score).slice(0, 4);
  const totals = [...pools.total].sort((a, b) => b.score - a.score).slice(0, 4);
  if (subs.length === 0 && vats.length === 0 && totals.length === 0) return null;

  let best: Partial<Record<SemanticTotalKind, number>> | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  const subValues = subs.length > 0 ? subs : [undefined];
  const vatValues = vats.length > 0 ? vats : [undefined];
  const totalValues = totals.length > 0 ? totals : [undefined];

  for (const sub of subValues) {
    for (const vat of vatValues) {
      for (const total of totalValues) {
        const subtotal = sub?.value;
        const vatAmount = vat?.value;
        const grandTotal = total?.value;
        if (subtotal === undefined && vatAmount === undefined && grandTotal === undefined) continue;
        if (subtotal !== undefined && vatAmount !== undefined && vatAmount >= subtotal) continue;
        if (vatAmount !== undefined && vatAmount <= 23 && Number.isInteger(vatAmount)) continue;
        if (subtotal !== undefined && grandTotal !== undefined && grandTotal < subtotal) {
          const gap = subtotal - grandTotal;
          if (!hasExplicitDocumentDiscount(lines) || gap > subtotal * 0.45) continue;
        }
        if (vatAmount !== undefined && grandTotal !== undefined && grandTotal < vatAmount) continue;
        if (sameAmountCannotBeTotalAndVat(vatAmount, grandTotal, {
          vatLabel: vat?.labelText,
          totalLabel: total?.labelText,
        })) {
          continue;
        }

        let score = (sub?.score ?? 0) + (vat?.score ?? 0) + (total?.score ?? 0);
        if (subtotal !== undefined && vatAmount !== undefined && grandTotal !== undefined) {
          const delta = Math.abs(subtotal + vatAmount - grandTotal);
          score += Math.max(0, 120 - delta);
        }
        if (score > bestScore) {
          bestScore = score;
          best = {
            ...(subtotal !== undefined ? { subtotal } : {}),
            ...(vatAmount !== undefined ? { vat: vatAmount } : {}),
            ...(grandTotal !== undefined ? { total: grandTotal } : {}),
          };
        }
      }
    }
  }

  return best;
}

function isBankOrPaymentLine(line: string): boolean {
  return /\b(?:iban|bic|swift|banca|bank|banque|banco|filiale|bonifico|virement|bank\s+details|coordinate\s+bancarie)\b/i.test(line);
}

function isBankAdjacentName(name: string, lines: readonly string[]): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (isBankOrPaymentLine(trimmed)) return true;
  const needle = trimmed.toLowerCase().slice(0, 10);
  if (needle.length < 4) return false;
  const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
  if (index < 0) return false;
  const window = lines.slice(Math.max(0, index - 1), index + 4).join('\n');
  return /\b(?:iban|bic|swift|filiale|bank\s+details|coordinate\s+bancarie|sort\s+code|account\s+no)\b/i.test(window);
}

function isPartyBlockStopLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (OCR_NOISE_LINE.test(trimmed)) return true;
  if (PARTY_SECTION_HEADER.test(trimmed)) return true;
  if (/^(?:quotation|order|invoice|devis|presupuesto|angebot)\s+no\.?$/i.test(trimmed)) return true;
  if (isBankOrPaymentLine(trimmed)) return true;
  if (/^(?:à l|a l|attention|attn|tel|tél|email|e-mail|car|ndi|jan|pai|ar|nd|nous avons|pour le|sehr geehrte|vielen dank|gerne bieten|referente|atención|atencion|telefono|tel[eé]fono|fax|cod\.|p\.?\s*iva|c\.?\s*f\.|iban|bic|siret|validit|date|datum|fecha)/i.test(trimmed)) {
    return true;
  }
  if (/^\d/.test(trimmed)) return true;
  if (/@|www\.|https?:/i.test(trimmed)) return true;
  return false;
}

function isLikelyPersonName(line: string): boolean {
  const trimmed = line.trim();
  if (COMPANY_SUFFIX.test(trimmed)) return false;
  if (/\b(?:service|officina|viticole|residencial|verpackung|institute|comunidad|motorparts|autofficina)\b/i.test(trimmed)) {
    return false;
  }
  return /^[A-ZÀ-ÿ][a-zà-ÿ'-]+\s+[A-ZÀ-ÿ][a-zà-ÿ'-]+$/.test(trimmed);
}

function isMarketingSloganLine(line: string): boolean {
  const trimmed = line.trim();
  if (/\bSince\s+(?:19|20)\d{2}\b/i.test(trimmed)) return true;
  // Dotted ALL-CAPS taglines without legal form (e.g. "PROUD. FAMILY. COMPANY.")
  if (
    !COMPANY_SUFFIX.test(trimmed) &&
    /^(?:[A-ZÀ-Ý]{2,}[.!]+\s*){2,}[A-ZÀ-Ý.!\s]{0,40}$/.test(trimmed)
  ) {
    return true;
  }
  return false;
}

function isPlausibleCompanyLine(line: string): boolean {
  const trimmed = line.trim();
  if (isPartyAnchorLine(trimmed)) return false;
  if (isDescriptionLine(trimmed)) return false;
  if (isLikelyPersonName(trimmed)) return false;
  if (isMarketingSloganLine(trimmed)) return false;
  if (looksLikePartySectionHeading(trimmed) || isSalesContactLabel(trimmed)) return false;
  if (/\b(?:codice cliente|vostro codice|riferimento cliente|your customer code)\b/i.test(trimmed)) return false;
  if (/\b(?:rich\.?\s*via\s+mail|via mail del)\b/i.test(trimmed)) return false;
  if (/^(?:destinazione\s+merce|destinatario\s+merc)/i.test(trimmed.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))) return false;
  if (/^[A-ZÀ-ÿ][A-ZÀ-ÿ' ]{2,40}\s*\/\s*[A-ZÀ-ÿ][A-ZÀ-ÿ' ]{2,40}$/.test(trimmed) && !/\d/.test(trimmed)) return false;
  if (trimmed.length < 8) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (/^\d/.test(trimmed)) return false;
  if (/@|www\.|https?:/i.test(trimmed)) return false;
  if (/^(?:via|rue|c\/|av\.|industriestra)/i.test(trimmed)) return false;
  if (/^(?:plazo de entrega|forma de pago|code article|item code|condiciones de)\s*:?$/i.test(trimmed)) return false;
  if (/\b(?:p\.?\s*iva|vat|cif|nif|tva|mwst)\b/i.test(trimmed) && trimmed.split(/\s+/).length <= 4) return false;
  return /[A-Za-zÀ-ÿ]{3,}/.test(trimmed);
}

export function findClientBlockCustomer(lines: readonly string[]): string | undefined {
  const blockCandidates: string[] = [];

  function collectFrom(indices: readonly number[]): string[] {
    const local: string[] = [];
    for (const j of indices) {
      const line = lines[j]?.trim() ?? '';
      if (PARTY_SECTION_HEADER.test(line)) {
        if (local.length > 0) break;
        continue;
      }
      if (/^(?:quotation|order|invoice|devis|presupuesto|angebot)\s+no\.?$/i.test(line)) continue;
      if (isBankOrPaymentLine(line)) continue;
      if (/\b(?:transferencia|bonifico|pagamento|payment\s+terms|bank\s+transfer|forma de pago)\b/i.test(line)) continue;
      if (/\b(?:iban|t?ban|bic|swift)\b/i.test(line) || /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/i.test(line.replace(/[\s.-]/g, ''))) {
        continue;
      }
      if (/^(?:rif\.?\s*cliente|customer\s+ref\.?|your\s+reference|riferimento\s+cliente)\s*(?:\/.*)?$/i.test(line)) {
        continue;
      }
      if (isPartyBlockStopLine(line)) {
        if (local.length > 0) break;
        continue;
      }
      if (isPlausibleCompanyLine(line)) {
        local.push(line.replace(/\s+-.*$/, '').trim());
      }
    }
    return local;
  }

  function preferNearest(local: readonly string[]): string | undefined {
    if (local.length === 0) return undefined;
    return [...local].sort((left, right) => {
      const leftWords = left.split(/\s+/).filter(Boolean).length;
      const rightWords = right.split(/\s+/).filter(Boolean).length;
      if (leftWords >= 2 && rightWords < 2) return -1;
      if (rightWords >= 2 && leftWords < 2) return 1;
      return right.length - left.length;
    })[0];
  }

  function considerBlock(startIndex: number, options?: { backward?: boolean }): void {
    const backward: number[] = [];
    const forward: number[] = [];
    if (options?.backward) {
      for (let j = startIndex - 1; j >= Math.max(0, startIndex - 12); j--) backward.push(j);
    }
    for (let j = startIndex + 1; j < Math.min(lines.length, startIndex + 14); j++) forward.push(j);
    const backwardNames = options?.backward ? collectFrom(backward) : [];
    const chosen = preferNearest(backwardNames) ?? preferNearest(collectFrom(forward));
    if (chosen) blockCandidates.push(chosen);
  }

  for (let i = 0; i < lines.length; i++) {
    const anchor = lines[i]?.trim() ?? '';
    if (!PARTY_ANCHOR.test(anchor) && !/^CLIENT$/i.test(anchor)) continue;
    considerBlock(i, {
      backward: /intestazione\s+fattura|destinatario|destinazione\s+merce|datos\s+del\s+cliente|bill\s+to|ship\s+to|fatturare\s+a/i.test(anchor),
    });
  }

  for (let i = 0; i < lines.length; i++) {
    if (!/^An$/i.test(lines[i]?.trim() ?? '')) continue;
    considerBlock(i);
  }

  for (let i = 0; i < lines.length; i++) {
    if (!/^datos\s+del\s+cliente$/i.test(lines[i]?.trim() ?? '')) continue;
    considerBlock(i);
  }

  for (let i = 0; i < Math.min(lines.length, 120); i++) {
    if (!/^(?:cliente\s*\/\s*intestazione\s+fattura|destinatario\s+merc|destinazione\s+merce)/i.test(lines[i]?.trim() ?? '')) {
      continue;
    }
    considerBlock(i);
  }

  if (blockCandidates.length === 0) return undefined;
  return [...blockCandidates].sort((left, right) => {
    const leftWords = left.split(/\s+/).filter(Boolean).length;
    const rightWords = right.split(/\s+/).filter(Boolean).length;
    if (leftWords >= 2 && rightWords < 2) return -1;
    if (rightWords >= 2 && leftWords < 2) return 1;
    return 0;
  })[0];
}

function inferIssuerName(lines: readonly string[], rawText: string): string | undefined {
  const header = lines.slice(0, 30);
  for (const line of header) {
    const trimmed = line.trim();
    if (trimmed.length < 8) continue;
    if (/@|www\.|tel|tél|iban|siret|intracom/i.test(trimmed)) continue;
    if (/^\d/.test(trimmed)) continue;
    if (isRejectedIssuerName(trimmed) || isPaymentSectionContext(trimmed)) continue;
    if (isImplausibleOrganizationName(trimmed) || isRejectedIssuerName(trimmed)) continue;
    if (COMPANY_SUFFIX.test(trimmed) && trimmed.split(/\s+/).length >= 2) {
      return trimmed;
    }
  }
  const headerText = (rawText ?? '').slice(0, 1200);
  const match = headerText.match(/\b([A-ZÀ-Ü][A-Za-zÀ-ü0-9&.'\- ]{4,60}(?:S\.?\s*A\.?\s*S\.?|S\.?\s*r\.?\s*l\.?|GmbH|AG|Ltd\.?|S\.?\s*L\.?|SAS))\b/);
  const inferred = match?.[1]?.trim();
  if (!inferred || isRejectedIssuerName(inferred) || isPaymentSectionContext(inferred)) return undefined;
  return inferred;
}

function inferCurrency(rawText: string, lines: readonly string[]): string | undefined {
  if (/€|EUR\b/i.test(rawText)) return 'EUR';
  if (/£|GBP\b/i.test(rawText)) return 'GBP';
  if (/\bUSD\b|\$/i.test(rawText)) return 'USD';
  for (const line of lines.slice(0, 80)) {
    const match = line.match(/\b(?:currency|moneda|devise)\s*[:\-]?\s*(EUR|GBP|USD|CHF)\b/i);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return undefined;
}

function inferIssueDate(lines: readonly string[]): string | undefined {
  const ranked: Array<{ score: number; value: string }> = [];
  const dateToken =
    /\b(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4}|\d{1,2}\s+(?:de\s+)?[A-Za-zÀ-ÿ]{3,12}\s+(?:de\s+)?\d{4})\b/i;
  const strongLabel =
    /\b(?:data\s+ordine|order\s+date|data\s+fattura|invoice\s+date|data\s+preventivo|quote\s+date|document\s+date|issue\s+date|issued|emess[ao]|fecha\s+presupuesto|date\s+du\s+devis|dte\s+docem)\b/i;
  const weakLabel =
    /\b(?:richiesta|rich\.|via\s+mail|request\s+date|delivery\s+date|due\s+date|validit)\b/i;
  const rejectedDateContext =
    /\b(?:non\s+usare\s+come\s+data(?:\s+documento)?|do\s+not\s+use\s+as\s+(?:document\s+)?date|serial(?:e|i|number|\s+no\.?|\s+numbers?)?|matricol[ae]|lotto|batch|telaio|vin|garanzia|warranty|manutenzione|maintenance)\b/i;
  for (const line of lines) {
    if (rejectedDateContext.test(line)) continue;
    const inline = extractInlineDocumentNumberDate(line);
    if (!inline) continue;
    const parsed = parseInternationalDate(inline.rawDate, inline.dayFirst ? 'it' : 'en').normalizedValue ?? inline.rawDate.trim();
    ranked.push({ score: 100, value: parsed });
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!strongLabel.test(lines[index] ?? '') || rejectedDateContext.test(lines[index] ?? '')) continue;
    for (let offset = -5; offset <= 5; offset += 1) {
      const other = lines[index + offset];
      if (!other || weakLabel.test(other) || rejectedDateContext.test(other)) continue;
      const match = other.match(dateToken);
      if (!match?.[1]) continue;
      const parsed = parseInternationalDate(match[1], 'it').normalizedValue ?? match[1].trim();
      ranked.push({ score: 100, value: parsed });
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const neighbors = [lines[index - 1], line, lines[index + 1]].filter(Boolean).join(' ');
    if (rejectedDateContext.test(line) || rejectedDateContext.test(neighbors)) continue;
    const match = line.match(dateToken);
    if (!match?.[1]) continue;
    const parsed = parseInternationalDate(match[1], 'it').normalizedValue ?? match[1].trim();
    let score = 40;
    if (strongLabel.test(neighbors)) {
      score = 100;
    } else if (weakLabel.test(neighbors)) {
      score = 15;
    } else if (/\b(?:data|date|fecha)\b/i.test(neighbors) && !/\bdel\b/i.test(neighbors)) {
      score = 70;
    }
    ranked.push({ score, value: parsed });
  }
  ranked.sort((left, right) => right.score - left.score);
  if (ranked[0] && ranked[0].score >= 70) return ranked[0].value;
  const typeIndex = lines.findIndex((line) =>
    /^(?:preventivo|offerta|fattura|ordine|devis|quotation|quote)\b/i.test(line.trim()));
  const numberIndex = lines.findIndex((line) => /^\d{2,5}\s*\/\s*[A-Z][A-Z0-9]{0,3}$/i.test(line.trim()));
  const start = [typeIndex, numberIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  if (start < 0) return undefined;
  for (let offset = 1; offset <= 6; offset += 1) {
    const line = lines[start + offset]?.trim() ?? '';
    if (/valido|finoal|fino\s+a|immatricol|scadenza|validit/i.test(line)) break;
    const match = line.match(/^(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})$/);
    if (!match) continue;
    return parseInternationalDate(match[1], 'it').normalizedValue ?? match[1];
  }
  return undefined;
}

function inferDocumentTypeHint(
  rawText: string,
  documentType: StructuredDocumentType,
): StructuredDocumentType {
  const header = (rawText ?? '').slice(0, 1200);
  if (/\b(?:ANGEBOT|Angebot|Angebotsnummer|Kostenvoranschlag)\b/.test(header)) return 'quote';
  if (/\b(?:DEVIS|Devis)\b/.test(header)) return 'quote';
  if (/\b(?:PRESUPUESTO|Presupuesto)\b/.test(header)) return 'quote';
  if (/\b(?:QUOTATION|Quotation)\b/.test(header)) return 'quote';
  if (/\b(?:PREVENTIVO|Preventivo)\b/.test(header)) return 'quote';
  if (/\b(?:ORDINE|Ordine)\b/.test(header)) return 'order';
  if (/\b(?:FACTURE|Factura|Fattura|Rechnung)\b/.test(header)) return 'invoice';
  const inferred = inferCanonicalDocumentType(header);
  if (inferred?.type === 'quotation') return 'quote';
  if (inferred?.type === 'order') return 'order';
  if (inferred?.type === 'invoice') return 'invoice';
  return documentType;
}

export interface SemanticFallbackSnapshot {
  documentType: StructuredDocumentType;
  documentNumber?: string;
  issuer?: string;
  customer?: string;
  currency?: string;
  subtotal?: number;
  vat?: number;
  total?: number;
  elapsedMs: number;
}

export function extractSemanticDocumentSnapshot(
  documentType: StructuredDocumentType,
  rawText: string,
  lines: readonly string[],
): SemanticFallbackSnapshot {
  const started = Date.now();
  const lineTexts = lines.map((line) => line.trim()).filter(Boolean);
  const totals = findSemanticDocumentTotals(lineTexts);
  return {
    documentType: inferDocumentTypeHint(rawText, documentType),
    documentNumber: extractStrongDocumentNumber(rawText, lineTexts),
    issuer: inferIssuerName(lineTexts, rawText),
    customer: findClientBlockCustomer(lineTexts),
    currency: inferCurrency(rawText, lineTexts),
    subtotal: totals.subtotal,
    vat: totals.vat,
    total: totals.total,
    elapsedMs: Date.now() - started,
  };
}

function totalsLookWrong(
  subtotal: number | undefined,
  vat: number | undefined,
  total: number | undefined,
): boolean {
  if (subtotal === undefined && vat === undefined && total === undefined) return true;
  if (subtotal !== undefined && vat !== undefined && subtotal < vat && vat > 1000) return true;
  if (subtotal !== undefined && total !== undefined && total < subtotal) {
    if (subtotal - total > Math.max(1, subtotal * 0.45)) return true;
  }
  if (vat !== undefined && total !== undefined && total < vat) return true;
  if (vat !== undefined && vat > 0 && vat <= 23 && Number.isInteger(vat) && (subtotal ?? 0) > 200) return true;
  if (subtotal !== undefined && total !== undefined && Math.abs(subtotal - total) <= 0.05 && (vat === undefined || vat <= 23)) return true;
  return false;
}

function validSummaryValue(extraction: StructuredDocumentExtraction, key: 'subtotal' | 'vatAmount' | 'total'): number | undefined {
  const evidence = extraction.summary[key === 'subtotal' ? 'subtotal' : key === 'vatAmount' ? 'vatAmount' : 'total'];
  if (!evidence || evidence.normalizedValue === undefined) return undefined;
  if (evidence.validationStatus === 'invalid') return undefined;
  return typeof evidence.normalizedValue === 'number' ? evidence.normalizedValue : undefined;
}

/** Estrazione veloce da OCR grezzo quando il layout avanzato fallisce o va in timeout. */
export function buildSemanticFallbackExtraction(
  documentType: StructuredDocumentType,
  rawText: string,
  lines: readonly string[],
  reason: string,
): Pick<StructuredDocumentExtraction, 'metadata' | 'summary' | 'requiresReview' | 'reasons' | 'issuer' | 'customer'> {
  const started = Date.now();
  documentProcessPerfStageStart('semantic_fallback', { inputLineCount: lines.length });
  const lineTexts = lines.map((line) => line.trim()).filter(Boolean);
  const resolvedType = inferDocumentTypeHint(rawText, documentType);
  const documentNumber = extractStrongDocumentNumber(rawText, lineTexts);
  const issueDate = inferIssueDate(lineTexts);
  const customerName = [findClientBlockCustomer(lineTexts), findCustomerName(rawText, [...lineTexts]).trim() || undefined]
    .map((value) => value?.trim())
    .find((value) =>
      value
      && !isBankAdjacentName(value, lineTexts)
      && !isDocumentTypeHeaderText(value)
      && !isMarketingSloganLine(value)
      && !isImplausibleOrganizationName(value)
      && !isImplausiblePartyName(value));
  const issuerName = inferIssuerName(lineTexts, rawText)?.trim();
  const currency = inferCurrency(rawText, lineTexts);
  const totals = findSemanticDocumentTotals(lineTexts);
  const subtotal = totals.subtotal;
  const vatAmount = totals.vat;
  const total = totals.total;
  const discountTotal = findSemanticDiscount(lineTexts);
  const elapsedMs = Date.now() - started;
  if (elapsedMs > 100 && IS_DEV) {
    console.warn(`[SemanticFallback] done ms=${elapsedMs} lines=${lineTexts.length}`);
  }
  documentProcessPerfStageEnd('semantic_fallback', {
    inputLineCount: lineTexts.length,
    outputCandidateCount: [subtotal, vatAmount, total].filter((value) => value !== undefined).length,
  });

  return {
    metadata: {
      ...(documentNumber
        ? {
            documentNumber: fallbackDocumentEvidence(
              documentNumber,
              documentNumber,
              ['semantic_fallback_strong_label'],
              false,
            ),
          }
        : {}),
      ...(issueDate
        ? {
            issueDate: fallbackDocumentEvidence(
              issueDate,
              issueDate,
              ['semantic_fallback_date'],
            ),
          }
        : {}),
      ...(currency
        ? {
            currency: fallbackDocumentEvidence(
              currency,
              currency,
              ['semantic_fallback_currency'],
              false,
            ),
          }
        : {}),
    },
    ...(issuerName
      ? {
          issuer: {
            role: 'issuer' as const,
            name: fallbackDocumentEvidence(
              issuerName,
              issuerName,
              ['semantic_fallback_issuer'],
              true,
            ),
            conflicts: [],
            requiresReview: true,
          },
        }
      : {}),
    ...(customerName
      ? {
          customer: {
            role: 'customer' as const,
            name: fallbackDocumentEvidence(
              customerName,
              customerName,
              ['semantic_fallback_customer_block'],
              true,
            ),
            conflicts: [],
            requiresReview: true,
          },
        }
      : {}),
    summary: {
      taxSummaries: [],
      conflicts: [],
      requiresReview: true,
      ...(subtotal !== undefined
        ? {
            subtotal: fallbackDocumentEvidence(
              String(subtotal),
              subtotal,
              ['semantic_fallback_subtotal'],
            ),
          }
        : {}),
      ...(vatAmount !== undefined
        ? {
            vatAmount: fallbackDocumentEvidence(
              String(vatAmount),
              vatAmount,
              ['semantic_fallback_vat'],
            ),
          }
        : {}),
      ...(total !== undefined
        ? {
            total: fallbackDocumentEvidence(
              String(total),
              total,
              ['semantic_fallback_total'],
            ),
          }
        : {}),
      ...(discountTotal !== undefined
        ? {
            discountTotal: fallbackDocumentEvidence(
              String(discountTotal),
              discountTotal,
              ['semantic_fallback_discount'],
            ),
          }
        : {}),
      ...(currency
        ? {
            currency: fallbackDocumentEvidence(
              currency,
              currency,
              ['semantic_fallback_currency'],
              false,
            ),
          }
        : {}),
    },
    requiresReview: true,
    reasons: [reason, 'semantic_fallback_applied', ...(documentNumber ? [] : ['semantic_fallback_missing_number'])],
  };
}

function missingEvidence(
  evidence: { normalizedValue?: unknown } | undefined,
): boolean {
  return !evidence || evidence.normalizedValue === undefined;
}

export function applySemanticFallbackOverlay(
  extraction: StructuredDocumentExtraction,
  documentType: StructuredDocumentType,
  rawText: string,
  lineTexts: readonly string[],
): StructuredDocumentExtraction {
  documentProcessPerfStageStart('semantic_overlay', { inputLineCount: lineTexts.length });
  const fallback = buildSemanticFallbackExtraction(documentType, rawText, lineTexts, 'semantic_overlay');
  const structuredSubtotal = validSummaryValue(extraction, 'subtotal');
  const structuredVat = validSummaryValue(extraction, 'vatAmount');
  const structuredTotal = validSummaryValue(extraction, 'total');
  const vatLooksLikeOrphanRate =
    structuredVat !== undefined &&
    structuredVat > 0 &&
    structuredVat <= 23 &&
    Number.isInteger(structuredVat) &&
    !(
      structuredSubtotal !== undefined &&
      structuredTotal !== undefined &&
      Math.abs(structuredSubtotal + structuredVat - structuredTotal) <= 0.05
    );
  const totalLooksLikeVatAmount =
    structuredTotal !== undefined &&
    structuredVat !== undefined &&
    structuredTotal > 23 &&
    Math.abs(structuredTotal - structuredVat) <= 0.05;
  const fallbackTotal = fallback.summary.total?.normalizedValue;
  const fallbackVat = fallback.summary.vatAmount?.normalizedValue;
  const fallbackTotalIsStronger =
    fallbackTotal !== undefined &&
    (
      (totalLooksLikeVatAmount && structuredVat !== undefined && fallbackTotal > structuredVat * 1.05) ||
      (fallbackVat !== undefined && Math.abs(fallbackTotal - (fallback.summary.subtotal?.normalizedValue ?? 0) - fallbackVat) <= 0.05)
    );
  // Timeout/overlay may only fill blanks, replace an orphan VAT-rate capture
  // that does not reconcile, or replace a grand total that is actually VAT.
  const fallbackSubtotalIsShipping =
    fallback.summary.subtotal !== undefined
    && lineTexts.some((line) =>
      /\b(?:spese?(?:\s+di)?\s+trasporto|shipping|freight|contributo\s+logistico)\b/i.test(line)
      && String(line).includes(String(fallback.summary.subtotal?.rawValue ?? '').slice(0, 4)));
  const fallbackSubtotalReconciles =
    fallback.summary.subtotal?.normalizedValue !== undefined
    && structuredVat !== undefined
    && structuredTotal !== undefined
    && Math.abs(fallback.summary.subtotal.normalizedValue + structuredVat - structuredTotal) <= 0.05;
  const shouldFillSubtotal = missingEvidence(extraction.summary.subtotal)
    && !fallbackSubtotalIsShipping
    && (fallbackSubtotalReconciles || structuredVat === undefined || structuredTotal === undefined);
  const fallbackVatConflicts = sameAmountCannotBeTotalAndVat(
    fallbackVat,
    fallbackTotal ?? structuredTotal,
  ) || lineTexts.some((line) => isVatExcludedLanguage(line));
  const shouldFillVat =
    (missingEvidence(extraction.summary.vatAmount) || vatLooksLikeOrphanRate)
    && !fallbackVatConflicts;
  const fallbackTotalValue = fallback.summary.total?.normalizedValue;
  const structuredTotalQuality = classifyNumericFieldQuality(structuredTotal, {
    weak: structuredSubtotal !== undefined && structuredTotal !== undefined
      && Math.abs(structuredTotal - structuredSubtotal) <= 0.05
      && structuredVat !== undefined && structuredVat > 0,
    strong: !!extraction.summary.total?.reasons.some((reason) => /grand|totale documento|total due|total:/i.test(reason)),
  });
  const fallbackTotalQuality = classifyNumericFieldQuality(fallbackTotalValue, {
    strong: !!fallback.summary.total?.reasons.some((reason) => /grand|total due|total:|semantic/i.test(reason)),
  });
  const fallbackTotalMatchesVatPlusNet =
    fallbackTotalValue !== undefined
    && structuredSubtotal !== undefined
    && structuredVat !== undefined
    && Math.abs(structuredSubtotal + structuredVat - fallbackTotalValue) <= 0.05;
  const totalReplaceDecision = decideFallbackReplacement(structuredTotalQuality, fallbackTotalQuality);
  const fallbackEqualsVat =
    fallbackTotalValue !== undefined
    && (
      (fallbackVat !== undefined && Math.abs(fallbackTotalValue - fallbackVat) <= 0.05)
      || (structuredVat !== undefined && Math.abs(fallbackTotalValue - structuredVat) <= 0.05)
    );
  const fallbackEqualsTaxable =
    fallbackTotalValue !== undefined
    && structuredSubtotal !== undefined
    && Math.abs(fallbackTotalValue - structuredSubtotal) <= 0.05
    && structuredVat !== undefined
    && structuredVat > 0;
  const shouldFillTotal = !fallbackEqualsVat
    && !fallbackEqualsTaxable
    && (
      missingEvidence(extraction.summary.total)
      || (totalLooksLikeVatAmount && fallbackTotalIsStronger)
      || (fallbackTotalMatchesVatPlusNet && totalReplaceDecision !== 'fallback_rejected_weaker')
    );
  if (fallbackEqualsVat || fallbackEqualsTaxable) {
    logSemanticRoleViolation({
      field: 'grandTotal',
      fromRole: fallbackEqualsVat ? 'vatAmount' : 'taxable',
      toRole: 'grandTotal',
      value: fallbackTotalValue,
      stage: 'semantic_fallback',
      reason: 'fallback_cannot_relabel_vat_or_taxable_as_total',
    });
  }
  if (IS_DEV) {
    console.warn(`[SemanticFallback] ${shouldFillTotal ? (fallbackTotalMatchesVatPlusNet ? totalReplaceDecision : 'fallback_fill') : 'fallback_rejected_weaker'}`, JSON.stringify({
      field: 'grandTotal',
      structured: structuredTotal,
      fallback: fallbackTotalValue,
    }));
  }
  const fallbackSubtotal = fallback.summary.subtotal?.normalizedValue;
  const structuredTripletOk =
    structuredSubtotal !== undefined
    && structuredVat !== undefined
    && structuredTotal !== undefined
    && Math.abs(structuredSubtotal + structuredVat - structuredTotal) <= 0.05;
  const fallbackSubtotalFits =
    fallbackSubtotal !== undefined
    && structuredVat !== undefined
    && structuredTotal !== undefined
    && Math.abs(fallbackSubtotal + structuredVat - structuredTotal) <= 0.05;
  const shouldReplaceIncoherentSubtotal =
    !shouldFillSubtotal
    && !structuredTripletOk
    && fallbackSubtotalFits
    && !hasExplicitDocumentDiscount(lineTexts);

  const structuredCustomer = extraction.customer?.name?.normalizedValue?.trim();
  const semanticCustomer = fallback.customer?.name?.normalizedValue?.trim();
  const structuredIssuer = extraction.issuer?.name?.normalizedValue?.trim();
  const semanticIssuer = fallback.issuer?.name?.normalizedValue?.trim();
  const shouldReplaceCustomer =
    !!semanticCustomer &&
    !isMarketingSloganLine(semanticCustomer) &&
    !isBankAdjacentName(semanticCustomer, lineTexts) &&
    !isImplausiblePartyName(semanticCustomer) &&
    !isImplausibleOrganizationName(semanticCustomer) &&
    shouldReplacePartyValue(structuredCustomer, semanticCustomer);
  const shouldReplaceIssuer =
    !!semanticIssuer &&
    !isImplausiblePartyName(semanticIssuer) &&
    !isRejectedIssuerName(semanticIssuer) &&
    !isImplausibleOrganizationName(semanticIssuer) &&
    shouldReplacePartyValue(structuredIssuer, semanticIssuer);

  const overlaid = {
    ...extraction,
    metadata: {
      ...extraction.metadata,
      ...(!missingEvidence(extraction.metadata.documentNumber) ? {} : fallback.metadata.documentNumber
        ? { documentNumber: fallback.metadata.documentNumber }
        : {}),
      ...(!missingEvidence(extraction.metadata.issueDate) ? {} : fallback.metadata.issueDate
        ? { issueDate: fallback.metadata.issueDate }
        : {}),
      ...(!missingEvidence(extraction.metadata.dueDate) ? {} : fallback.metadata.dueDate
        ? { dueDate: fallback.metadata.dueDate }
        : {}),
      ...(!missingEvidence(extraction.metadata.validityDate) ? {} : fallback.metadata.validityDate
        ? { validityDate: fallback.metadata.validityDate }
        : {}),
      ...(!missingEvidence(extraction.metadata.currency) ? {} : fallback.metadata.currency
        ? { currency: fallback.metadata.currency }
        : {}),
    },
    ...(shouldReplaceCustomer && fallback.customer ? { customer: fallback.customer } : {}),
    ...(shouldReplaceIssuer && fallback.issuer ? { issuer: fallback.issuer } : {}),
    summary: {
      ...extraction.summary,
      ...((shouldFillSubtotal || shouldReplaceIncoherentSubtotal) && fallback.summary.subtotal
        ? { subtotal: fallback.summary.subtotal }
        : {}),
      ...(shouldFillVat && fallback.summary.vatAmount ? { vatAmount: fallback.summary.vatAmount } : {}),
      ...(shouldFillTotal && fallback.summary.total ? { total: fallback.summary.total } : {}),
      ...(!extraction.summary.discountTotal && fallback.summary.discountTotal
        ? { discountTotal: fallback.summary.discountTotal }
        : {}),
      ...(fallback.summary.currency && !extraction.summary.currency ? { currency: fallback.summary.currency } : {}),
    },
    requiresReview: extraction.requiresReview || fallback.requiresReview,
    reasons: [...new Set([...extraction.reasons, ...fallback.reasons])],
  };
  const exclusive = resolveExclusivePartyRoles({
    issuer: overlaid.issuer?.name?.normalizedValue,
    customer: overlaid.customer?.name?.normalizedValue,
  });
  if (exclusive.customer === null && overlaid.customer) {
    overlaid.customer = {
      ...overlaid.customer,
      name: undefined,
    };
  }
  if (
    overlaid.customer?.vatNumber?.normalizedValue
    && overlaid.issuer?.vatNumber?.normalizedValue
    && overlaid.customer.vatNumber.normalizedValue === overlaid.issuer.vatNumber.normalizedValue
  ) {
    overlaid.customer = { ...overlaid.customer, vatNumber: undefined };
  }
  documentProcessPerfStageEnd('semantic_overlay', {
    inputLineCount: lineTexts.length,
    outputCandidateCount: overlaid.items.length,
  });
  return overlaid;
}

import type { DocumentEvidence, DocumentLayoutLine, StructuredDocumentType } from './document-structure';
import { documentEvidence, normalizeDocumentText } from './document-structured-evidence';
import { parseInternationalDate } from './document-international-values';
import { extractInlineDocumentNumberDate } from './document-inline-date';
import { logQaDocument } from './qa-document-logging';
import type { CanonicalCommercialDocumentType, DocumentLanguage } from './document-label-dictionary';

export type DateSemanticRole =
  | 'issueDate'
  | 'documentDate'
  | 'orderDate'
  | 'deliveryDate'
  | 'validityDate'
  | 'dueDate'
  | 'referenceDate';

export interface DateRoleCandidate {
  rawText: string;
  normalizedDate?: string;
  semanticRole: DateSemanticRole;
  label: string;
  page: number;
  x: number;
  y: number;
  score: number;
  roleConfidence: number;
  labelConfidence: number;
  regionPriority: number;
  sourceLineId: string;
  normalizedRaw: string;
  tieBreakKey: string;
  won: boolean;
  evidence: DocumentEvidence<string>;
}

const VALIDITY_LABEL =
  /\b(?:valido\s+fino(?:\s+a(?:l)?)?|validit[aà](?:\s+(?:dell?)?offerta)?|valid\s+until|validit[eé]|valable\s+jusqu|g[uü]ltig\s+bis|v[aá]lido\s+hasta|scadenza\s+offerta|date\s+devis\s+valable)\b/i;
const DUE_LABEL =
  /\b(?:scadenza|due\s+date|payment\s+due|[ée]ch[ée]ance|zahlungsziel|f[aä]llig(?:\s+am)?|vencimiento)\b/i;
const DELIVERY_LABEL =
  /\b(?:data\s+consegna|delivery\s+date|consegna\s+prevista|lieferdatum|date\s+de\s+livraison|data\s+ordine\s+consegna)\b/i;
const ORDER_LABEL =
  /\b(?:data\s+ordine|order\s+date|date\s+commande|auftragsdatum|bestelldatum)\b/i;
const ISSUE_LABEL =
  /\b(?:data\s+(?:documento|fattura|preventivo|offerta)|document\s+date|issue\s+date|invoice\s+date|quote\s+date|quotation\s+date|date\s+(?:devis|du\s+devis|d.?emission|facture)|fecha(?:\s+(?:de\s+)?)?(?:emisi[oó]n|presupuesto|factura)|belegdatum|rechnungsdatum|angebotsdatum|datum)\b/i;
const GENERIC_DATE_LABEL =
  /(?:^|\b)(?:data|date|fecha|datum)(?:\s*\/\s*(?:data|date|fecha|datum))?(?:\s*:?\s*)$/i;
const DATE_TOKEN =
  /\b([0-9Oo]{1,2}[./-][0-9Oo]{1,2}[./-][0-9Oo]{4}|\d{1,2}\s+(?:de\s+)?[A-Za-zÀ-ÿ]{3,12}\s+(?:de\s+)?\d{4})\b/gi;

const ISSUE_POOL = new Set<DateSemanticRole>(['issueDate', 'documentDate', 'orderDate']);

function lineX(line: DocumentLayoutLine): number {
  const box = line.boundingBox;
  return box ? Math.round((box.x + box.width / 2) * 100) / 100 : line.readingOrder;
}

function lineY(line: DocumentLayoutLine): number {
  return line.boundingBox ? Math.round(line.boundingBox.y * 100) / 100 : 0;
}

function regionPriority(line: DocumentLayoutLine): number {
  const region = line.semanticRegion;
  if (region === 'document_identity' || region === 'header') return 0;
  if (region === 'issuer_block' || region === 'customer_block') return 1;
  if (region === 'unknown' || region === undefined) return 2;
  if (region === 'notes' || region === 'footer' || region === 'payment_terms') return 6;
  return 4;
}

export function classifyDateLabelText(text: string): { role: DateSemanticRole; confidence: number } | undefined {
  const normalized = normalizeDocumentText(text);
  if (VALIDITY_LABEL.test(normalized) || VALIDITY_LABEL.test(text)) {
    return { role: 'validityDate', confidence: 100 };
  }
  if (DELIVERY_LABEL.test(normalized) || DELIVERY_LABEL.test(text)) {
    return { role: 'deliveryDate', confidence: 90 };
  }
  if (DUE_LABEL.test(normalized) || DUE_LABEL.test(text)) {
    if (/\bofferta\b/i.test(text)) return { role: 'validityDate', confidence: 100 };
    return { role: 'dueDate', confidence: 95 };
  }
  if (ORDER_LABEL.test(normalized) || ORDER_LABEL.test(text)) {
    return { role: 'orderDate', confidence: 96 };
  }
  if (ISSUE_LABEL.test(normalized) || ISSUE_LABEL.test(text)) {
    return { role: 'issueDate', confidence: 100 };
  }
  if (GENERIC_DATE_LABEL.test(normalized.trim()) || GENERIC_DATE_LABEL.test(text.trim())) {
    return { role: 'documentDate', confidence: 70 };
  }
  const compact = normalized.replace(/[^a-z]+/g, ' ').trim();
  if (/^(?:data|date|fecha|datum)(?: (?:data|date|fecha|datum))?$/.test(compact)) {
    return { role: 'documentDate', confidence: 70 };
  }
  return undefined;
}

function parseDateToken(raw: string, language?: DocumentLanguage): { value?: string; ambiguous: boolean } {
  const repaired = raw.replace(/\b(20)0(\d{2})\b/, '$1$2').replace(/(\d{1,2}[./-]\d{1,2})(\d{4})\b/, '$1/$2');
  const parsed = parseInternationalDate(repaired, language);
  return { ...(parsed.normalizedValue ? { value: parsed.normalizedValue } : {}), ambiguous: parsed.ambiguous };
}

function dateTokens(text: string): Array<{ raw: string; start: number; prefix: string }> {
  const tokens: Array<{ raw: string; start: number; prefix: string }> = [];
  const matcher = new RegExp(DATE_TOKEN.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    tokens.push({
      raw: match[1] ?? match[0],
      start: match.index,
      prefix: text.slice(Math.max(0, match.index - 48), match.index),
    });
  }
  return tokens;
}

export function compareDateTieBreak(left: DateRoleCandidate, right: DateRoleCandidate): number {
  if (right.roleConfidence !== left.roleConfidence) return right.roleConfidence - left.roleConfidence;
  if (right.labelConfidence !== left.labelConfidence) return right.labelConfidence - left.labelConfidence;
  if (left.regionPriority !== right.regionPriority) return left.regionPriority - right.regionPriority;
  if (left.page !== right.page) return left.page - right.page;
  if (left.y !== right.y) return left.y - right.y;
  if (left.x !== right.x) return left.x - right.x;
  if (left.sourceLineId !== right.sourceLineId) {
    return left.sourceLineId < right.sourceLineId ? -1 : 1;
  }
  if (left.normalizedRaw !== right.normalizedRaw) {
    return left.normalizedRaw < right.normalizedRaw ? -1 : 1;
  }
  return 0;
}

function tieBreakKey(candidate: Omit<DateRoleCandidate, 'tieBreakKey' | 'won' | 'evidence' | 'score'> & { score?: number }): string {
  return [
    String(1000 - candidate.roleConfidence).padStart(4, '0'),
    String(1000 - candidate.labelConfidence).padStart(4, '0'),
    String(candidate.regionPriority).padStart(2, '0'),
    String(candidate.page).padStart(3, '0'),
    candidate.y.toFixed(2).padStart(10, '0'),
    candidate.x.toFixed(2).padStart(10, '0'),
    candidate.sourceLineId,
    candidate.normalizedRaw,
  ].join('|');
}

function makeEvidence(
  raw: string,
  normalized: string,
  lines: readonly DocumentLayoutLine[],
  reason: string,
  ambiguous: boolean,
): DocumentEvidence<string> {
  return documentEvidence({
    rawValue: raw,
    normalizedValue: normalized,
    lines,
    validationStatus: ambiguous ? 'unverified' : 'valid',
    reasons: [reason, ambiguous ? 'ambiguous_day_month' : 'valid_calendar_date'],
    requiresReview: ambiguous,
  });
}

function hypot2(left: DocumentLayoutLine, right: DocumentLayoutLine): number {
  const dx = lineX(left) - lineX(right);
  const dy = lineY(left) - lineY(right);
  return dx * dx + dy * dy;
}

function labelDateColumnScore(label: DocumentLayoutLine, date: DocumentLayoutLine): number {
  if (!label.boundingBox || !date.boundingBox) {
    return Math.abs(date.readingOrder - label.readingOrder);
  }
  const verticalDistance = Math.abs(date.boundingBox.y - label.boundingBox.y);
  const sameColumn = Math.abs(
    date.boundingBox.x + date.boundingBox.width / 2 - (label.boundingBox.x + label.boundingBox.width / 2),
  ) <= Math.max(40, label.boundingBox.width * 0.75);
  const below = date.boundingBox.y >= label.boundingBox.y;
  const immediatelyBelow = below
    && date.boundingBox.y - label.boundingBox.y <= Math.max(80, label.boundingBox.height * 3.5);
  const sameRow = verticalDistance <= Math.max(35, label.boundingBox.height * 1.5);
  if (sameRow && date.boundingBox.x > label.boundingBox.x) return 0;
  if (sameColumn && immediatelyBelow) return 1;
  if (sameColumn && below) return 2;
  return 3;
}

function bindLabelsToDates(
  labels: ReadonlyArray<{ line: DocumentLayoutLine; role: DateSemanticRole; confidence: number }>,
  dateLines: readonly DocumentLayoutLine[],
): Map<string, { line: DocumentLayoutLine; role: DateSemanticRole; confidence: number }> {
  const pairs = labels.flatMap((label) => dateLines
    .filter((date) => date.pageIndex === label.line.pageIndex)
    .map((date) => ({
      label,
      date,
      columnScore: labelDateColumnScore(label.line, date),
      distance: hypot2(label.line, date),
    })));
  pairs.sort((left, right) => {
    if (left.columnScore !== right.columnScore) return left.columnScore - right.columnScore;
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.label.line.pageIndex !== right.label.line.pageIndex) {
      return left.label.line.pageIndex - right.label.line.pageIndex;
    }
    const labelY = lineY(left.label.line) - lineY(right.label.line);
    if (labelY !== 0) return labelY;
    const labelX = lineX(left.label.line) - lineX(right.label.line);
    if (labelX !== 0) return labelX;
    if (left.label.line.id !== right.label.line.id) {
      return left.label.line.id < right.label.line.id ? -1 : 1;
    }
    const dateY = lineY(left.date) - lineY(right.date);
    if (dateY !== 0) return dateY;
    const dateX = lineX(left.date) - lineX(right.date);
    if (dateX !== 0) return dateX;
    return left.date.id < right.date.id ? -1 : left.date.id > right.date.id ? 1 : 0;
  });
  const usedLabels = new Set<string>();
  const usedDates = new Set<string>();
  const bound = new Map<string, { line: DocumentLayoutLine; role: DateSemanticRole; confidence: number }>();
  for (const pair of pairs) {
    if (usedLabels.has(pair.label.line.id) || usedDates.has(pair.date.id)) continue;
    if (pair.columnScore > 1) continue;
    usedLabels.add(pair.label.line.id);
    usedDates.add(pair.date.id);
    bound.set(pair.date.id, pair.label);
  }
  return bound;
}

export function collectDateRoleCandidates(
  lines: readonly DocumentLayoutLine[],
  language?: DocumentLanguage,
): DateRoleCandidate[] {
  const labelLines = lines.flatMap((line) => {
    const classified = classifyDateLabelText(line.text);
    if (!classified) return [];
    if (dateTokens(line.text).length > 0 && classified.confidence < 100 && classified.role === 'documentDate') {
      return [];
    }
    return [{ line, role: classified.role, confidence: classified.confidence }];
  }).sort((left, right) => {
    if (left.line.pageIndex !== right.line.pageIndex) return left.line.pageIndex - right.line.pageIndex;
    const y = lineY(left.line) - lineY(right.line);
    if (y !== 0) return y;
    const x = lineX(left.line) - lineX(right.line);
    if (x !== 0) return x;
    return left.line.id < right.line.id ? -1 : left.line.id > right.line.id ? 1 : 0;
  });

  const dateLines = lines.filter((line) => dateTokens(line.text).length > 0);
  const bound = bindLabelsToDates(labelLines, dateLines);
  const candidates: DateRoleCandidate[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const nextLine = lines[lineIndex + 1];
    const adjacentSamePage = nextLine?.pageIndex === line.pageIndex ? nextLine : undefined;
    // Real OCR frequently splits `FATTURA N. ...` / `del ...` across two rows.
    // The inline parser itself stays strict (document-number label + connector),
    // while this bounded two-line join recovers that common layout without
    // allowing arbitrary nearby dates to become the issue date.
    const inlineSource = adjacentSamePage ? `${line.text} ${adjacentSamePage.text}` : line.text;
    const inline = extractInlineDocumentNumberDate(line.text) ?? extractInlineDocumentNumberDate(inlineSource);
    if (inline) {
      const parsed = parseInternationalDate(inline.rawDate, inline.dayFirst ? 'it' : language);
      if (parsed.normalizedValue) {
        const usedAdjacentLine = !extractInlineDocumentNumberDate(line.text) && !!adjacentSamePage;
        const evidenceLines = usedAdjacentLine ? [line, adjacentSamePage] : [line];
        const base = {
          rawText: inline.rawDate,
          normalizedDate: parsed.normalizedValue,
          semanticRole: 'issueDate' as const,
          label: 'inline_document_number_date',
          page: line.pageIndex,
          x: lineX(line),
          y: lineY(line),
          roleConfidence: 100,
          labelConfidence: 100,
          regionPriority: regionPriority(line),
          sourceLineId: usedAdjacentLine ? `${line.id}+${adjacentSamePage.id}` : line.id,
          normalizedRaw: parsed.normalizedValue,
        };
        const evidence = makeEvidence(
          inline.rawDate,
          parsed.normalizedValue,
          evidenceLines,
          'inline_document_number_date',
          parsed.ambiguous,
        );
        candidates.push({
          ...base,
          score: 100,
          tieBreakKey: tieBreakKey(base),
          won: false,
          evidence,
        });
      }
    }
    const tokens = dateTokens(line.text);
    for (const token of tokens) {
      const parsed = parseDateToken(token.raw, language);
      if (!parsed.value) continue;
      const prefixTail = token.prefix.trim().split(/\s+/).slice(-3).join(' ');
      const prefixRole = classifyDateLabelText(prefixTail)
        || classifyDateLabelText(token.prefix)
        || classifyDateLabelText(line.text);
      const nearest = prefixRole ? undefined : bound.get(line.id);
      const role = prefixRole?.role ?? nearest?.role;
      const labelConfidence = prefixRole?.confidence ?? nearest?.confidence ?? 0;
      if (!role || labelConfidence < 70) continue;
      if (role === 'deliveryDate' || role === 'referenceDate') continue;
      const labelText = prefixRole ? token.prefix.trim() || line.text : (nearest?.line.text ?? '');
      const base = {
        rawText: token.raw,
        normalizedDate: parsed.value,
        semanticRole: role,
        label: labelText,
        page: line.pageIndex,
        x: lineX(line),
        y: lineY(line),
        roleConfidence: labelConfidence,
        labelConfidence,
        regionPriority: regionPriority(line),
        sourceLineId: `${line.id}:${token.start}`,
        normalizedRaw: parsed.value,
      };
      const evidence = makeEvidence(
        token.raw,
        parsed.value,
        nearest && !prefixRole ? [nearest.line, line] : [line],
        role === 'validityDate'
          ? 'validity_date_label'
          : role === 'dueDate'
            ? 'due_date_label'
            : 'issue_date_near_header_label',
        parsed.ambiguous,
      );
      candidates.push({
        ...base,
        score: labelConfidence,
        tieBreakKey: tieBreakKey(base),
        won: false,
        evidence,
      });
    }
  }

  return candidates.sort(compareDateTieBreak);
}

type DateDocumentType = StructuredDocumentType | CanonicalCommercialDocumentType;

function issueRolePriority(role: DateSemanticRole, documentType?: DateDocumentType): number {
  if (documentType === 'order') {
    if (role === 'orderDate') return 0;
    if (role === 'issueDate') return 1;
    if (role === 'documentDate') return 2;
    return 3;
  }
  if (documentType === 'invoice' || documentType === 'quote' || documentType === 'quotation') {
    if (role === 'issueDate') return 0;
    if (role === 'documentDate') return 1;
    if (role === 'orderDate') return 2;
    return 3;
  }
  return 0;
}

function pickPool(
  candidates: DateRoleCandidate[],
  pool: ReadonlySet<DateSemanticRole> | DateSemanticRole,
  documentType?: DateDocumentType,
): DateRoleCandidate | undefined {
  const filtered = candidates.filter((entry) => (
    typeof pool === 'string' ? entry.semanticRole === pool : pool.has(entry.semanticRole)
  ));
  const useDocumentRolePriority = pool === ISSUE_POOL
    && (documentType === 'order' || documentType === 'invoice' || documentType === 'quote' || documentType === 'quotation');
  const ranked = [...filtered].sort((left, right) => {
    if (useDocumentRolePriority) {
      const rolePriority = issueRolePriority(left.semanticRole, documentType) - issueRolePriority(right.semanticRole, documentType);
      if (rolePriority !== 0) return rolePriority;
    }
    return compareDateTieBreak(left, right);
  });
  return ranked[0];
}

export function resolveDocumentDateRoles(
  lines: readonly DocumentLayoutLine[],
  language?: DocumentLanguage,
  documentType?: DateDocumentType,
): {
  issueDate?: DocumentEvidence<string>;
  validityDate?: DocumentEvidence<string>;
  dueDate?: DocumentEvidence<string>;
  candidates: DateRoleCandidate[];
} {
  const collected = collectDateRoleCandidates(lines, language);
  const issue = pickPool(collected, ISSUE_POOL, documentType);
  const validity = pickPool(collected, 'validityDate');
  const due = pickPool(collected, 'dueDate');
  const winnerKeys = new Set(
    [issue, validity, due]
      .filter((entry): entry is DateRoleCandidate => !!entry)
      .map((entry) => entry.tieBreakKey),
  );
  const candidates = collected.map((entry) => ({ ...entry, won: winnerKeys.has(entry.tieBreakKey) }));
  for (const entry of candidates) {
    logQaDocument('DateCandidate', {
      rawText: entry.rawText,
      normalizedDate: entry.normalizedDate,
      semanticRole: entry.semanticRole,
      label: entry.label.slice(0, 80),
      page: entry.page,
      x: entry.x,
      y: entry.y,
      score: entry.score,
      tieBreakKey: entry.tieBreakKey,
      won: entry.won,
    });
  }
  return {
    ...(issue ? { issueDate: issue.evidence } : {}),
    ...(validity ? { validityDate: validity.evidence } : {}),
    ...(due ? { dueDate: due.evidence } : {}),
    candidates,
  };
}

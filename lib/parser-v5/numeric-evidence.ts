import { isGenericProviderDomain } from '../parser-engine/extractors/website';
import type { NumericEvidenceMetadata } from '../parser-engine/card-extraction-result';

export type NumericEvidenceType = NumericEvidenceMetadata['evidenceType'];
export type NumericValidationStatus =
  NumericEvidenceMetadata['validationStatus'];

export interface NumericEvidence extends NumericEvidenceMetadata {}

export interface NumericEvidenceLine {
  lineId: number;
  pageIndex: number;
  text: string;
}

export interface NumericEvidenceResolution {
  accepted: readonly NumericEvidence[];
  ambiguous: readonly NumericEvidence[];
  rejected: readonly NumericEvidence[];
}

interface CandidateWithOffset {
  evidence: NumericEvidence;
  offset: number;
}

type LabelKind =
  | 'fax'
  | 'phone'
  | 'document'
  | 'postal'
  | 'combinedFiscal'
  | 'taxCode'
  | 'vat';

const TAX_CODE_RE = /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi;
const NUMERIC_SPAN_RE =
  /(?:\b(?!CF\b|PI\b)[A-Z]{2}\s*)?(?:\+|00)?[0-9OoIl|](?:[0-9OoIl| .()/-]{3,}[0-9OoIl|])/gi;

const LABEL_PATTERNS: ReadonlyArray<{
  kind: LabelKind;
  pattern: RegExp;
}> = [
  {
    kind: 'fax',
    pattern: /\b(?:fax|telefax|f(?=\s*[:.+\d]))\b/gi,
  },
  {
    kind: 'phone',
    pattern:
      /\b(?:tel(?:efono|ephone)?|phone|mobile|mob|cell(?:ulare)?|whatsapp|t(?=\s*[:.+\d]))\b/gi,
  },
  {
    kind: 'document',
    pattern:
      /\b(?:numero\s+documento|document(?:o)?|invoice|fattura|ordine|order|preventivo|quote|pratica|tessera|card\s*(?:no|number)|id\s*(?:no|number))\b/gi,
  },
  {
    kind: 'postal',
    pattern: /\b(?:cap|zip|postal\s*code)\b/gi,
  },
  {
    kind: 'combinedFiscal',
    pattern:
      /\b(?:(?:c\.?\s*f\.?|cod(?:ice)?\s+fiscale)\s*(?:\/|e|ed|and|\s)\s*(?:p\.?\s*(?:[i1l]\s*v\s*a[e]?|iva|i\.?|n\.?\s*a\.?)|pna|partita\s*iva|vat)|(?:p\.?\s*(?:[i1l]\s*v\s*a[e]?|iva|i\.?|n\.?\s*a\.?)|pna|partita\s*iva|vat)\s*(?:\/|e|ed|and|\s)\s*(?:c\.?\s*f\.?|cod(?:ice)?\s+fiscale))(?=\W|$)/gi, // P0 PNA SOURCE PROOF V2
  },
  {
    kind: 'taxCode',
    pattern:
      /\b(?:c\.?\s*f\.?|cod(?:ice)?\.?\s+f[i1l|]sc(?:ale)?|tax\s*code)\b/gi,
  },
  {
    kind: 'vat',
    pattern:
      /\b(?:p\.?\s*(?:[i1jl]\s*\.?\s*)?v\.?\s*a[e]?|p\.?\s*[i1jl]\.?(?=\s|[:=]|$)|p\.?\s*n\.?\s*a\.?|pna|part(?:ita)?\.?\s*(?:[i1jl]\s*\.?\s*)?v\.?\s*a[e]?|vat(?:\s*(?:no|number|id))?|ust-?id|tva|nif|cif|btw)(?=\W|$)/gi,
  },
];

const LEGAL_FORM_RE =
  /\b(?:s\.?\s*r\.?\s*l\.?|s\.?\s*p\.?\s*a\.?|s\.?\s*n\.?\s*c\.?|s\.?\s*a\.?\s*s\.?|srl|spa|snc|sas|gmbh|ag|ltd|llc|inc)\b/i;
const FISCAL_CONTEXT_RE =
  /\b(?:sede\s+legale|registro\s+imprese|camera\s+di\s+commercio|capitale\s+sociale|codice\s+f[i1l|]scale|tax\s+id|fiscal[ei]?|rea)\b/i;
const BUSINESS_DOMAIN_RE =
  /(?:@|https?:\/\/|www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})/gi;
const NON_DOMAIN_SUFFIX_RE =
  /\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|rtf|jpe?g|png|gif|svg|webp|tiff?|zip|rar|7z)$/i;
const ADDRESS_CONTEXT_RE =
  /\b(?:via|viale|piazza|corso|largo|strada|street|road|avenue|boulevard|sede)\b/i;

const TYPE_ORDER: Record<NumericEvidenceType, number> = {
  fax: 0,
  phone: 1,
  documentNumber: 2,
  postalCode: 3,
  taxCode: 4,
  vat: 5,
  unknownNumericIdentifier: 6,
};

function clampConfidence(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function normalizeDigits(rawValue: string): string {
  return rawValue
    .replace(/^\s*IT(?=\s*[0-9OoIl|])/i, '')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/\D/g, '');
}

function normalizeVatValue(rawValue: string): string {
  const prefix = rawValue.trim().match(/^([A-Z]{2})\s*(?=[0-9OoIl|])/i)?.[1]?.toUpperCase();
  const digits = normalizeDigits(rawValue);
  // OCR sometimes matches the numeric span starting at a VAT-label tail
  // (e.g. `P.VA ...` can become `VA ...`). In that case `VA` is not a country
  // prefix and must not be preserved.
  return prefix && !/^(?:IT|CF|PI|VA)$/.test(prefix) ? `${prefix}${digits}` : digits;
}

function normalizeTaxCode(rawValue: string): string {
  return rawValue.toUpperCase().replace(/\s+/g, '');
}

/** Checksum ufficiale della P.IVA italiana a 11 cifre. */
export function hasValidItalianVatChecksum(value: string): boolean {
  const digits = normalizeDigits(value);
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  let sum = 0;
  for (let index = 0; index < 10; index++) {
    const digit = Number(digits[index]);
    if (index % 2 === 0) {
      sum += digit;
    } else {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return (10 - (sum % 10)) % 10 === Number(digits[10]);
}

function lastLabelBefore(text: string, offset: number): LabelKind | null {
  const segmentStart = Math.max(
    text.lastIndexOf('|', offset - 1),
    text.lastIndexOf(';', offset - 1),
    text.lastIndexOf('\t', offset - 1),
    text.lastIndexOf('•', offset - 1)
  );
  // Default: only text before the numeric span (Aug22 certified behavior).
  // Overlap into the span is allowed ONLY when the span begins with the damaged
  // tail of a fiscal label that already started immediately before `offset`
  // (e.g. `P.`+`VA…`, `Part. `+`VA…`, `PJ`+`VA…`, `C.`+`F.…`).
  // Never search forward for an unrelated label that appears AFTER the digits.
  let contextEnd = offset;
  const before = text.slice(segmentStart + 1, offset);
  const spanHead = text.slice(offset, Math.min(text.length, offset + 6));
  const damagedFiscalOverlap =
    (/(?:^|[^A-Za-z0-9])p\.?\s*$/i.test(before) &&
      /^(?:[i1jl|]\s*\.?\s*)?v\.?\s*a/i.test(spanHead)) ||
    (/(?:^|[^A-Za-z0-9])part(?:ita)?\.?\s*$/i.test(before) &&
      /^(?:[i1jl|]\s*\.?\s*)?v\.?\s*a/i.test(spanHead)) ||
    (/(?:^|[^A-Za-z0-9])p[j1il]?$/i.test(before) && /^va(?:\b|(?=\s))/i.test(spanHead)) ||
    (/(?:^|[^A-Za-z0-9])c\.?\s*$/i.test(before) && /^f\.?(?=\W|$)/i.test(spanHead));
  if (damagedFiscalOverlap) {
    const token = spanHead.match(/^[A-Za-z.|]{1,6}/)?.[0] ?? '';
    contextEnd = Math.min(text.length, offset + Math.max(token.length, 2));
  }
  const prefix = text.slice(segmentStart + 1, contextEnd);
  let nearest: { kind: LabelKind; end: number; matchText: string } | null = null;
  let taxCodeMatch: { end: number; matchText: string } | null = null;

  for (const entry of LABEL_PATTERNS) {
    entry.pattern.lastIndex = 0;
    for (const match of prefix.matchAll(entry.pattern)) {
      const end = (match.index ?? 0) + match[0].length;
      if (entry.kind === 'taxCode') {
        if (!taxCodeMatch || end > taxCodeMatch.end) {
          taxCodeMatch = { end, matchText: match[0] ?? '' };
        }
      }
      if (!nearest || end > nearest.end) {
        nearest = { kind: entry.kind, end, matchText: match[0] ?? '' };
      }
    }
  }

  // Avoid mis-classifying `C.F.` as `fax` (the `f` abbreviation can match `F.:`).
  // If we also saw a valid tax-code label in the same window, prefer `taxCode`.
  if (nearest?.kind === 'fax' && taxCodeMatch) {
    const faxText = nearest.matchText.toLowerCase();
    const looksLikeFullFax =
      faxText.startsWith('fax') || faxText.startsWith('telefax');
    if (!looksLikeFullFax) return 'taxCode';
  }

  return nearest?.kind ?? null;
}

// P0 PNA SOURCE PROOF V2
// NUMERIC_SPAN_RE usa /i e quindi accetta anche "L" come OCR di 1.
// La coda deve usare la STESSA semantica case-insensitive.
function trimTrailingNumericOcrWordLeak(
  text: string,
  rawValue: string,
  offset: number
): { rawValue: string; offset: number } {
  const tail = rawValue.match(/\s+[oil|]{1,3}$/i)?.[0];
  if (!tail) return { rawValue, offset };

  const end = offset + rawValue.length;
  const next = text[end] ?? '';
  if (!/[a-zà-ÿ]/i.test(next)) return { rawValue, offset };

  const trimmed = rawValue.slice(0, rawValue.length - tail.length);
  if (!/[0-9oil|]$/i.test(trimmed)) return { rawValue, offset };

  return { rawValue: trimmed, offset };
}

function trimOverlappingVatLabelTail(
  text: string,
  rawValue: string,
  offset: number
): { rawValue: string; offset: number } {
  if (!/\bp\.?\s*$/i.test(text.slice(0, offset))) {
    return { rawValue, offset };
  }

  const overlap = rawValue.match(/^[i1jl|]\s*\.?\s*/i)?.[0];
  if (!overlap) return { rawValue, offset };

  const trimmed = rawValue.slice(overlap.length);
  if (!/[0-9OoIl|]/.test(trimmed)) return { rawValue, offset };

  return {
    rawValue: trimmed,
    offset: offset + overlap.length,
  };
}

function trimOverlappingPhoneLabel(
  rawValue: string,
  offset: number
): { rawValue: string; offset: number } {
  // NUMERIC_SPAN_RE tollera O/I/L come cifre OCR e puo quindi inglobare
  // l'etichetta `Tel.` nel candidato (`Tel. (0445)...`). Separala prima
  // della classificazione affinche lastLabelBefore veda davvero `Tel.` e
  // non erediti una precedente etichetta fiscale presente sulla stessa riga.
  const overlap = rawValue.match(
    /^(?:tel(?:efono|ephone)?|phone|ph|fax|telefax|mob(?:ile)?|cell(?:ulare)?|whatsapp|wa)\.?\s*[:._+-]?\s*/i
  )?.[0];
  if (!overlap) return { rawValue, offset };

  const trimmed = rawValue.slice(overlap.length);
  if (!/[0-9OoIl|]/.test(trimmed)) return { rawValue, offset };
  return { rawValue: trimmed, offset: offset + overlap.length };
}

function hasStrongBusinessContext(pageText: string): boolean {
  BUSINESS_DOMAIN_RE.lastIndex = 0;
  const hasBusinessDomain = [...pageText.matchAll(BUSINESS_DOMAIN_RE)].some(
    (match) => {
      const domain = (match[1] ?? '').toLowerCase();
      const offset = match.index ?? 0;
      const rawMatch = match[0] ?? '';
      const before = pageText[offset - 1] ?? '';
      const after = pageText[offset + rawMatch.length] ?? '';
      return (
        before !== '@' &&
        after !== '@' &&
        domain !== 'p.iva' &&
        domain !== 'c.f' &&
        !NON_DOMAIN_SUFFIX_RE.test(domain) &&
        !isGenericProviderDomain(domain)
      );
    }
  );
  BUSINESS_DOMAIN_RE.lastIndex = 0;
  const signals = [
    LEGAL_FORM_RE.test(pageText),
    FISCAL_CONTEXT_RE.test(pageText),
    hasBusinessDomain,
  ].filter(Boolean).length;
  return signals >= 2;
}

function looksLikeNonPhoneGrouping(rawValue: string): boolean {
  const value = rawValue.trim().replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(value)) return true;
  return /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(value);
}

function hasPhoneGrouping(rawValue: string): boolean {
  if (looksLikeNonPhoneGrouping(rawValue)) return false;
  const separators = rawValue.match(/[ .()/-]/g)?.length ?? 0;
  return separators >= 2;
}

function makeEvidence(
  line: NumericEvidenceLine,
  rawValue: string,
  evidenceType: NumericEvidenceType,
  reasonParts: readonly string[],
  confidence: number,
  validationStatus: NumericValidationStatus
): NumericEvidence {
  return {
    rawValue: rawValue.trim(),
    normalizedValue:
      evidenceType === 'taxCode'
        ? normalizeTaxCode(rawValue)
        : evidenceType === 'vat'
          ? normalizeVatValue(rawValue)
        : normalizeDigits(rawValue),
    lineId: line.lineId,
    pageIndex: line.pageIndex,
    evidenceType,
    reason: reasonParts.join('; '),
    confidence: clampConfidence(confidence),
    validationStatus,
  };
}

function classifyNumericSpan(
  line: NumericEvidenceLine,
  rawValue: string,
  offset: number,
  pageText: string
): NumericEvidence[] {
  const digits = normalizeDigits(rawValue);
  if (digits.length < 5 || digits.length > 15) return [];

  const label = lastLabelBefore(line.text, offset);
  const hasInternationalPrefix = /^\s*(?:\+|00)/.test(rawValue);
  const repaired = /[OoIl|]/.test(rawValue);
  const repairReason = repaired ? ['ocr_digit_repair'] : [];

  if (label === 'fax') {
    return [
      makeEvidence(
        line,
        rawValue,
        'fax',
        ['explicit_fax_label', ...repairReason],
        0.98,
        'not_applicable'
      ),
    ];
  }

  if (label === 'phone') {
    return [
      makeEvidence(
        line,
        rawValue,
        'phone',
        ['explicit_phone_label', ...repairReason],
        0.97,
        'not_applicable'
      ),
    ];
  }

  if (label === 'document') {
    return [
      makeEvidence(
        line,
        rawValue,
        'documentNumber',
        ['explicit_document_label', ...repairReason],
        0.96,
        'not_applicable'
      ),
    ];
  }

  if (
    label === 'postal' ||
    (digits.length === 5 && ADDRESS_CONTEXT_RE.test(line.text))
  ) {
    const validLength = digits.length === 5;
    return [
      makeEvidence(
        line,
        rawValue,
        'postalCode',
        [
          label === 'postal'
            ? 'explicit_postal_label'
            : 'postal_address_context',
          validLength ? 'postal_length_valid' : 'postal_length_invalid',
          ...repairReason,
        ],
        validLength ? (label === 'postal' ? 0.95 : 0.84) : 0.4,
        validLength ? 'valid' : 'invalid'
      ),
    ];
  }

  if (label === 'combinedFiscal' && digits.length === 11) {
    const checksumValid = hasValidItalianVatChecksum(digits);
    return [
      makeEvidence(
        line,
        rawValue,
        'vat',
        [
          'combined_fiscal_label',
          checksumValid
            ? 'italian_vat_checksum_valid'
            : 'italian_vat_checksum_invalid',
          ...repairReason,
        ],
        checksumValid ? 0.99 : 0.55,
        checksumValid ? 'valid' : 'invalid'
      ),
      makeEvidence(
        line,
        rawValue,
        'taxCode',
        ['combined_fiscal_label', ...repairReason],
        0.9,
        'unverified'
      ),
    ];
  }

  if (label === 'taxCode') {
    const validNumericLength = digits.length === 11;
    return [
      makeEvidence(
        line,
        rawValue,
        'taxCode',
        [
          'explicit_tax_code_label',
          validNumericLength
            ? 'numeric_tax_code_unverified'
            : 'numeric_tax_code_length_invalid',
          ...repairReason,
        ],
        validNumericLength ? 0.68 : 0.4,
        validNumericLength ? 'unverified' : 'invalid'
      ),
    ];
  }

  if (label === 'vat') {
    const checksumValid =
      digits.length === 11 && hasValidItalianVatChecksum(digits);
    const hasForeignPrefix =
      /^\s*(?!IT\b|CF\b|PI\b|VA\b)[A-Z]{2}\s*(?=[0-9OoIl|])/i.test(rawValue);
    const plausibleExplicitLength = digits.length >= 8 && digits.length <= 15;
    return [
      makeEvidence(
        line,
        rawValue,
        'vat',
        [
          'explicit_vat_label',
          checksumValid
            ? 'italian_vat_checksum_valid'
            : hasForeignPrefix && plausibleExplicitLength
              ? 'explicit_foreign_vat_observed'
              : 'italian_vat_checksum_invalid',
          ...repairReason,
        ],
        checksumValid ? 0.99 : hasForeignPrefix && plausibleExplicitLength ? 0.88 : 0.55,
        checksumValid ? 'valid' : hasForeignPrefix && plausibleExplicitLength ? 'not_applicable' : 'invalid'
      ),
    ];
  }

  if (hasInternationalPrefix && label === null) {
    return [
      makeEvidence(
        line,
        rawValue,
        'phone',
        ['international_phone_prefix', ...repairReason],
        0.93,
        'not_applicable'
      ),
    ];
  }

  if (digits.length >= 7 && hasPhoneGrouping(rawValue)) {
    return [
      makeEvidence(
        line,
        rawValue,
        'phone',
        ['phone_grouping', ...repairReason],
        0.82,
        'not_applicable'
      ),
    ];
  }

  if (
    digits.length === 11 &&
    hasValidItalianVatChecksum(digits) &&
    hasStrongBusinessContext(pageText)
  ) {
    return [
      makeEvidence(
        line,
        rawValue,
        'vat',
        [
          'italian_vat_checksum_valid',
          'strong_business_context',
          ...repairReason,
        ],
        0.84,
        'valid'
      ),
    ];
  }

  return [
    makeEvidence(
      line,
      rawValue,
      'unknownNumericIdentifier',
      ['unlabeled_numeric_sequence', ...repairReason],
      0.25,
      'unverified'
    ),
  ];
}

/**
 * Classifica ogni span numerico senza concatenare cifre appartenenti a
 * segmenti o pagine differenti.
 */
export function collectNumericEvidence(
  inputLines: readonly NumericEvidenceLine[]
): readonly NumericEvidence[] {
  const lines = [...inputLines].sort(
    (left, right) =>
      left.pageIndex - right.pageIndex ||
      left.lineId - right.lineId ||
      left.text.localeCompare(right.text)
  );
  const pageText = new Map<number, string>();
  for (const line of lines) {
    const previous = pageText.get(line.pageIndex);
    pageText.set(
      line.pageIndex,
      previous ? `${previous}\n${line.text}` : line.text
    );
  }

  const candidates: CandidateWithOffset[] = [];
  for (const line of lines) {
    TAX_CODE_RE.lastIndex = 0;
    for (const match of line.text.matchAll(TAX_CODE_RE)) {
      candidates.push({
        evidence: makeEvidence(
          line,
          match[0],
          'taxCode',
          ['italian_tax_code_format_valid'],
          0.98,
          'valid'
        ),
        offset: match.index ?? 0,
      });
    }

    NUMERIC_SPAN_RE.lastIndex = 0;
    for (const match of line.text.matchAll(NUMERIC_SPAN_RE)) {
      const phoneBoundedMatch = trimOverlappingPhoneLabel(
        match[0],
        match.index ?? 0
      );
      const normalizedMatch = trimOverlappingVatLabelTail(
        line.text,
        phoneBoundedMatch.rawValue,
        phoneBoundedMatch.offset
      );
      const boundedMatch = trimTrailingNumericOcrWordLeak(
        line.text,
        normalizedMatch.rawValue,
        normalizedMatch.offset
      );
      const offset = boundedMatch.offset;
      for (const evidence of classifyNumericSpan(
        line,
        boundedMatch.rawValue,
        offset,
        pageText.get(line.pageIndex) ?? line.text
      )) {
        candidates.push({ evidence, offset });
      }
    }
  }

  candidates.sort(
    (left, right) =>
      left.evidence.pageIndex - right.evidence.pageIndex ||
      left.evidence.lineId - right.evidence.lineId ||
      left.offset - right.offset ||
      TYPE_ORDER[left.evidence.evidenceType] -
        TYPE_ORDER[right.evidence.evidenceType] ||
      left.evidence.normalizedValue.localeCompare(
        right.evidence.normalizedValue
      )
  );

  const unique = new Map<string, NumericEvidence>();
  for (const candidate of candidates) {
    const evidence = candidate.evidence;
    const key = [
      evidence.pageIndex,
      evidence.lineId,
      evidence.evidenceType,
      evidence.normalizedValue,
    ].join('|');
    const previous = unique.get(key);
    if (!previous || evidence.confidence > previous.confidence) {
      unique.set(key, evidence);
    }
  }
  return [...unique.values()];
}

export function resolveNumericEvidence(
  evidence: readonly NumericEvidence[]
): NumericEvidenceResolution {
  const accepted: NumericEvidence[] = [];
  const ambiguous: NumericEvidence[] = [];
  const rejected: NumericEvidence[] = [];

  for (const candidate of evidence) {
    if (candidate.validationStatus === 'invalid') {
      rejected.push(candidate);
    } else if (
      candidate.evidenceType === 'unknownNumericIdentifier' ||
      candidate.validationStatus === 'unverified' ||
      candidate.confidence < 0.75
    ) {
      ambiguous.push(candidate);
    } else {
      accepted.push(candidate);
    }
  }

  return { accepted, ambiguous, rejected };
}

export function evidenceForPage(
  resolution: NumericEvidenceResolution,
  pageIndex: number,
  evidenceType?: NumericEvidenceType
): readonly NumericEvidence[] {
  return resolution.accepted.filter(
    (candidate) =>
      candidate.pageIndex === pageIndex &&
      (!evidenceType || candidate.evidenceType === evidenceType)
  );
}

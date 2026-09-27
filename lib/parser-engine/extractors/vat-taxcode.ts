import type { Candidate, FeatureVector, NormalizedInput } from '../types';
import { MAX_CARD_TEXT_LEN } from '../types';

export interface TaxIdValue {
  vatNumber?: string;
  taxCode?: string;
}

const EXTRACTOR = 'vat-taxcode';

const COMBINED_TAX_LABEL =
  /(?:c\.?\s*[fe]\.?\s*(?:e\s+|\/\s*)?(?:p\.?\s*iva|part\.?\s*iva|partita\s*iva)|(?:p\.?\s*iva|part\.?\s*iva|partita\s*iva)\s*(?:\/|e|ed|and)\s*(?:cod\.?\s*fisc(?:ale)?|codice\s*fiscale|c\.?\s*f\.?|cf)|(?:cod\.?\s*fisc(?:ale)?|codice\s*fiscale|c\.?\s*f\.?|cf)\s*(?:\/|e|ed|and)\s*(?:p\.?\s*iva|part\.?\s*iva|partita\s*iva))/i;

const COMBINED_TAX_VALUE =
  /(?:c\.?\s*[fe]\.?\s*(?:e\s+|\/\s*)?(?:p\.?\s*iva|part\.?\s*iva|partita\s*iva)|(?:p\.?\s*iva|part\.?\s*iva|partita\s*iva)\s*(?:\/|e|ed|and)\s*(?:cod\.?\s*fisc(?:ale)?|codice\s*fiscale|c\.?\s*f\.?|cf)|(?:cod\.?\s*fisc(?:ale)?|codice\s*fiscale|c\.?\s*f\.?|cf)\s*(?:\/|e|ed|and)\s*(?:p\.?\s*iva|part\.?\s*iva|partita\s*iva))\s*[:\-]?\s*([A-Z0-9]{8,16})/i;

const VAT_LABEL =
  /(?:p\.?\s*iva|partita\s*iva|vat(?:\s*(?:no|number|reg|id))?|ust-?id|tva|nif|cif)\s*[:\-]?\s*([A-Z]{0,2}\d{8,12})/i;

const TAX_CODE_LABEL =
  /(?:cod\.?\s*fisc\.?|codice\s*fiscale|c\.?\s*f\.?)\s*[:\-]?\s*([A-Z0-9]{11,16})/i;

const ITALIAN_TAX_CODE = /^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i;

function positionRank(lineIndex: number, lineCount: number): number {
  if (lineCount <= 1) return 0.5;
  return 1 - lineIndex / (lineCount - 1);
}

function classifyId(id: string): TaxIdValue {
  const upper = id.toUpperCase();
  if (/^\d{11}$/.test(upper)) return { vatNumber: upper, taxCode: upper };
  if (ITALIAN_TAX_CODE.test(upper)) return { taxCode: upper };
  return { vatNumber: upper };
}

function taxFeatures(
  line: { text: string; confidence: number; lineIndex: number } | undefined,
  lineCount: number,
  hasLabel: boolean
): FeatureVector {
  if (!line) {
    return { hasVatPattern: true, confidenceOcr: 0.7 };
  }
  return {
    positionRank: positionRank(line.lineIndex, lineCount),
    lineLength: line.text.length,
    confidenceOcr: line.confidence,
    hasVatPattern: true,
    hasEmailPattern: /@/.test(line.text),
  };
}

function makeCandidate(
  value: TaxIdValue,
  sourceLineIndices: number[],
  rawText: string,
  features: FeatureVector
): Candidate<TaxIdValue> {
  return {
    value,
    sourceLineIndices,
    extractor: EXTRACTOR,
    rawText,
    features,
  };
}

function pushUnique(
  candidates: Candidate<TaxIdValue>[],
  seen: Set<string>,
  value: TaxIdValue,
  sourceLineIndices: number[],
  rawText: string,
  features: FeatureVector
): void {
  const key = `${value.vatNumber ?? ''}|${value.taxCode ?? ''}`;
  if (!value.vatNumber && !value.taxCode) return;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(makeCandidate(value, sourceLineIndices, rawText, features));
}

function pushCombinedSharedTaxId(
  candidates: Candidate<TaxIdValue>[],
  seen: Set<string>,
  id: string,
  line: { text: string; confidence: number; lineIndex: number } | undefined,
  lineCount: number,
  rawText: string
): void {
  const upper = id.toUpperCase();
  const features = taxFeatures(line, lineCount, true);
  pushUnique(
    candidates,
    seen,
    { vatNumber: upper },
    line ? [line.lineIndex] : [],
    rawText,
    features
  );
  pushUnique(
    candidates,
    seen,
    { taxCode: upper },
    [],
    rawText,
    { ...features, crossPageAgreement: 0.82 }
  );
}

function extractFromFlatText(
  flat: string,
  line: { text: string; confidence: number; lineIndex: number } | undefined,
  lineCount: number,
  candidates: Candidate<TaxIdValue>[],
  seen: Set<string>
): void {
  const combined = flat.match(COMBINED_TAX_VALUE);
  if (combined) {
    pushCombinedSharedTaxId(
      candidates,
      seen,
      combined[1],
      line,
      lineCount,
      line?.text ?? combined[0]
    );
    return;
  }

  if (COMBINED_TAX_LABEL.test(flat)) {
    const shared = flat.match(/\b(\d{11})\b/);
    if (shared) {
      pushCombinedSharedTaxId(
        candidates,
        seen,
        shared[1],
        line,
        lineCount,
        line?.text ?? flat
      );
      return;
    }
  }

  let vatNumber: string | undefined;
  let taxCode: string | undefined;

  const vatMatch = flat.match(VAT_LABEL);
  if (vatMatch) vatNumber = vatMatch[1].toUpperCase();

  const cfMatch = flat.match(TAX_CODE_LABEL);
  if (cfMatch) {
    const id = cfMatch[1].toUpperCase();
    if (ITALIAN_TAX_CODE.test(id)) taxCode = id;
    else if (/^\d{11}$/.test(id) && !vatNumber) vatNumber = id;
    else if (!taxCode) taxCode = id;
  }

  const looseVat = flat.match(/\b(IT\s?)?(\d{11})\b/);
  if (!vatNumber && looseVat && /(?:p\.?\s*iva|partita|iva|vat|c\.?\s*f|cod\.?\s*fisc)/i.test(flat)) {
    vatNumber = looseVat[2];
    if (COMBINED_TAX_LABEL.test(flat)) taxCode = looseVat[2];
  }

  if (vatNumber || taxCode) {
    if (vatNumber && /^\d{11}$/.test(vatNumber) && COMBINED_TAX_LABEL.test(flat) && !taxCode) {
      pushCombinedSharedTaxId(
        candidates,
        seen,
        vatNumber,
        line,
        lineCount,
        line?.text ?? flat
      );
      return;
    }
    pushUnique(
      candidates,
      seen,
      { vatNumber, taxCode },
      line ? [line.lineIndex] : [],
      line?.text ?? flat,
      taxFeatures(line, lineCount, true)
    );
  }
}

/**
 * Estrae candidati P.IVA / codice fiscale da righe e testo aggregato.
 */
export function extractTaxIdCandidates(input: NormalizedInput): Candidate<TaxIdValue>[] {
  const { lines, repairedText } = input;
  const lineCount = lines.length;
  const candidates: Candidate<TaxIdValue>[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const flat = line.text.replace(/\s+/g, ' ').slice(0, MAX_CARD_TEXT_LEN);
    extractFromFlatText(flat, line, lineCount, candidates, seen);
  }

  const fullFlat = repairedText.replace(/\s+/g, ' ').slice(0, MAX_CARD_TEXT_LEN);
  extractFromFlatText(fullFlat, undefined, lineCount, candidates, seen);

  return candidates;
}

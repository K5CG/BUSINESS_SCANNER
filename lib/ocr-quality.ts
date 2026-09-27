import type {
  OcrConfidenceType,
  OcrLine,
  OcrQualityMetadata,
  OcrQualityReason,
} from '../types';

export interface OcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProviderOcrLineInput {
  text?: unknown;
  confidence?: unknown;
  boundingBox?: OcrBoundingBox;
}

export interface OcrQualityAssessmentOptions {
  confidenceType?: Exclude<OcrConfidenceType, 'measured'>;
  recognizedFieldCount?: number;
  conflictCount?: number;
  source?: 'local' | 'cloud' | 'derived';
}

const MIN_REVIEW_QUALITY = 0.55;
const MIN_MEASURED_CONFIDENCE = 0.6;
/**
 * Prior di compatibilità del parser precedente alla Fase 4.
 *
 * Non è una confidence OCR e non viene salvato né mostrato. Mantenerlo qui
 * evita che l'introduzione dei metadata 4C cambi i risultati strutturati:
 * l'adozione della quality nel ranking appartiene a un intervento parser
 * separato, con un proprio corpus di accettazione.
 */
const LEGACY_PROVIDER_PARSER_PRIOR = 0.85;
const LEGACY_MISSING_PARSER_PRIOR = 0.5;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundedUnit(value: number): number {
  return Math.round(clampUnit(value) * 1000) / 1000;
}

export function normalizeMeasuredConfidence(
  value: unknown
): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function alphanumericShare(text: string): number {
  const compact = [...text].filter((character) => !/\s/u.test(character));
  if (compact.length === 0) return 0;
  const readable = compact.filter((character) =>
    /[\p{L}\p{N}@.+\-_/():,;'’&]/u.test(character)
  ).length;
  return readable / compact.length;
}

function unusualCharacterShare(text: string): number {
  const compact = [...text].filter((character) => !/\s/u.test(character));
  if (compact.length === 0) return 0;
  const unusual = compact.filter(
    (character) =>
      /[\u0000-\u001f\u007f\ufffd]/u.test(character) ||
      !/[\p{L}\p{N}@.+\-_/():,;'’&€$£%#]/u.test(character)
  ).length;
  return unusual / compact.length;
}

function validGeometry(box: OcrBoundingBox | undefined): boolean {
  return Boolean(
    box &&
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      box.width > 0 &&
      box.height > 0
  );
}

/**
 * Stima per-linea usata dal ranking legacy quando il provider non espone una
 * misura. È intenzionalmente variabile e resta separata dalla confidence.
 */
export function estimateOcrLineQuality(
  text: string,
  boundingBox?: OcrBoundingBox
): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const lengthScore = Math.min(trimmed.length / 24, 1);
  const readability = alphanumericShare(trimmed);
  const geometryScore = boundingBox
    ? validGeometry(boundingBox)
      ? 1
      : 0
    : 0.5;
  const anomalyPenalty = Math.min(unusualCharacterShare(trimmed) * 2, 1);
  return roundedUnit(
    0.2 +
      lengthScore * 0.25 +
      readability * 0.35 +
      geometryScore * 0.2 -
      anomalyPenalty * 0.35
  );
}

/**
 * Adatta una riga del provider senza inventare una misura. Se il provider non
 * restituisce confidence, `confidenceType` resta `unknown`; il parser riceve
 * soltanto la stima euristica separata.
 */
export function createProviderOcrLine(
  input: ProviderOcrLineInput
): OcrLine {
  const text = normalizedText(input.text);
  const measuredConfidence = normalizeMeasuredConfidence(input.confidence);
  const heuristicQuality = estimateOcrLineQuality(text, input.boundingBox);
  return {
    text,
    confidence: measuredConfidence ?? heuristicQuality,
    ...(measuredConfidence !== undefined ? { measuredConfidence } : {}),
    heuristicQuality,
    confidenceType:
      measuredConfidence !== undefined ? 'measured' : 'unknown',
    ...(input.boundingBox ? { boundingBox: input.boundingBox } : {}),
  };
}

/**
 * Confine di compatibilità per il solo parser V5. Le righe create dal nuovo
 * adapter provider sono riconoscibili dalla provenance esplicita e mantengono
 * il prior storico; i dataset/record legacy conservano il proprio segnale.
 */
export function ocrParserCompatibilityConfidence(line: OcrLine): number {
  if (
    line.confidenceType === 'measured' ||
    line.confidenceType === 'unknown'
  ) {
    return LEGACY_PROVIDER_PARSER_PRIOR;
  }
  return Number.isFinite(line.confidence)
    ? line.confidence
    : LEGACY_MISSING_PARSER_PRIOR;
}

function detectedFieldCount(text: string): {
  contact: number;
  document: number;
} {
  const contactSignals = [
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    /(?:\+?\d{1,3}[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}/,
    /\b(?:https?:\/\/|www\.)\S+/i,
  ].filter((pattern) => pattern.test(text)).length;
  const documentSignals = [
    /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/,
    /(?:€|\bEUR\b|\bUSD\b|\bGBP\b|\bCHF\b)\s*\d|\d[\d.,]*\s*(?:€|\bEUR\b|\bUSD\b|\bGBP\b|\bCHF\b)/i,
    /\b(?:totale|total|ordine|order|preventivo|quote|fattura|invoice)\b/i,
  ].filter((pattern) => pattern.test(text)).length;
  return { contact: contactSignals, document: documentSignals };
}

function uniqueReasons(
  reasons: readonly OcrQualityReason[]
): OcrQualityReason[] {
  return [...new Set(reasons)];
}

export function emptyOcrQuality(
  options: Pick<OcrQualityAssessmentOptions, 'confidenceType' | 'source'> = {}
): OcrQualityMetadata {
  return {
    confidenceType: options.confidenceType ?? 'unknown',
    heuristicQuality: 0,
    qualityReasons: uniqueReasons([
      'provider_confidence_unavailable',
      'empty_text',
      ...(options.source === 'cloud'
        ? (['cloud_result'] as OcrQualityReason[])
        : []),
    ]),
    requiresReview: true,
  };
}

/**
 * Calcola una qualità diagnostica generale. Non valida campi, non cancella
 * dati e non influenza il merge: serve soltanto per review e avvisi.
 */
export function assessOcrQuality(
  lines: readonly OcrLine[],
  rawText: string,
  options: OcrQualityAssessmentOptions = {}
): OcrQualityMetadata {
  const text =
    rawText.trim() ||
    lines
      .map((line) => line.text.trim())
      .filter(Boolean)
      .join('\n');
  if (!text) return emptyOcrQuality(options);
  const veryShortText = text.length < 12;

  const meaningfulLines = lines.filter((line) => line.text.trim().length > 0);
  const measured = meaningfulLines.flatMap((line) => {
    const value = normalizeMeasuredConfidence(line.measuredConfidence);
    return line.confidenceType === 'measured' && value !== undefined
      ? [value]
      : [];
  });
  const allMeaningfulLinesMeasured =
    meaningfulLines.length > 0 && measured.length === meaningfulLines.length;
  const measuredConfidence = allMeaningfulLinesMeasured
    ? roundedUnit(
        measured.reduce((sum, value) => sum + value, 0) / measured.length
      )
    : undefined;
  const confidenceType: OcrConfidenceType =
    measuredConfidence !== undefined
      ? 'measured'
      : options.confidenceType ?? 'unknown';

  const readableLineRatio =
    meaningfulLines.length === 0
      ? alphanumericShare(text)
      : meaningfulLines.filter(
          (line) => alphanumericShare(line.text.trim()) >= 0.65
        ).length / meaningfulLines.length;
  const boxes = meaningfulLines.flatMap((line) =>
    line.boundingBox ? [line.boundingBox] : []
  );
  const geometryQuality =
    boxes.length === 0
      ? 0.5
      : boxes.filter(validGeometry).length / boxes.length;
  const anomalyShare = unusualCharacterShare(text);
  const signals = detectedFieldCount(text);
  const recognizedFieldCount = Math.max(
    0,
    Math.floor(options.recognizedFieldCount ?? 0)
  );
  const totalSignals =
    signals.contact + signals.document + recognizedFieldCount;
  const conflicts = Math.max(0, Math.floor(options.conflictCount ?? 0));

  const lengthQuality = Math.min(text.length / 120, 1);
  const signalQuality = Math.min(totalSignals / 3, 1);
  const heuristicQuality = roundedUnit(
    0.1 +
      lengthQuality * 0.3 +
      readableLineRatio * 0.25 +
      geometryQuality * 0.15 +
      signalQuality * 0.2 -
      Math.min(anomalyShare * 3, 1) * 0.35 -
      Math.min(conflicts, 3) * 0.08
  );

  const reasons: OcrQualityReason[] = [
    measuredConfidence !== undefined
      ? 'provider_confidence_available'
      : 'provider_confidence_unavailable',
    veryShortText ? 'very_short_text' : 'sufficient_text',
    readableLineRatio >= 0.7
      ? 'mostly_readable_lines'
      : 'low_readable_line_ratio',
    geometryQuality >= 0.8 ? 'coherent_geometry' : 'incomplete_geometry',
  ];
  if (anomalyShare >= 0.08) reasons.push('anomalous_characters');
  if (signals.contact > 0) reasons.push('recognized_contact_fields');
  if (signals.document > 0 || recognizedFieldCount > 0) {
    reasons.push('recognized_document_fields');
  }
  if (conflicts > 0) reasons.push('page_conflict');
  if (options.source === 'cloud') reasons.push('cloud_result');

  return {
    ...(measuredConfidence !== undefined ? { measuredConfidence } : {}),
    heuristicQuality,
    confidenceType,
    qualityReasons: uniqueReasons(reasons),
    requiresReview:
      veryShortText ||
      heuristicQuality < MIN_REVIEW_QUALITY ||
      (measuredConfidence !== undefined &&
        measuredConfidence < MIN_MEASURED_CONFIDENCE) ||
      conflicts > 0,
  };
}

/**
 * Aggregazione conservativa: una confidence complessiva è "measured" solo se
 * tutte le pagine incluse hanno una misura reale.
 */
export function aggregateOcrQuality(
  qualities: readonly (OcrQualityMetadata | undefined)[]
): OcrQualityMetadata {
  const hasMissingQuality = qualities.some((quality) => quality === undefined);
  const available = qualities.filter(
    (quality): quality is OcrQualityMetadata => Boolean(quality)
  );
  if (available.length === 0) return emptyOcrQuality();

  const heuristicValues = available.flatMap((quality) => {
    const value = normalizeMeasuredConfidence(quality.heuristicQuality);
    return value !== undefined ? [value] : [];
  });
  const measuredValues = available.flatMap((quality) => {
    const value = normalizeMeasuredConfidence(quality.measuredConfidence);
    return quality.confidenceType === 'measured' && value !== undefined
      ? [value]
      : [];
  });
  const allMeasured =
    !hasMissingQuality && measuredValues.length === available.length;
  const measuredConfidence = allMeasured
    ? roundedUnit(
        measuredValues.reduce((sum, value) => sum + value, 0) /
          measuredValues.length
      )
    : undefined;
  const heuristicQuality =
    heuristicValues.length > 0
      ? roundedUnit(
          heuristicValues.reduce((sum, value) => sum + value, 0) /
            heuristicValues.length
        )
      : undefined;
  const confidenceType: OcrConfidenceType = hasMissingQuality
    ? 'unknown'
    : allMeasured
      ? 'measured'
      : available.every((quality) => quality.confidenceType === 'heuristic')
        ? 'heuristic'
        : 'unknown';

  return {
    ...(measuredConfidence !== undefined ? { measuredConfidence } : {}),
    ...(heuristicQuality !== undefined ? { heuristicQuality } : {}),
    confidenceType,
    qualityReasons: uniqueReasons([
      ...available.flatMap((quality) => quality.qualityReasons),
      ...(hasMissingQuality
        ? (['provider_confidence_unavailable'] as OcrQualityReason[])
        : []),
      'multipage_aggregate',
    ]),
    requiresReview:
      hasMissingQuality ||
      available.some((quality) => quality.requiresReview) ||
      heuristicQuality === undefined ||
      heuristicQuality < MIN_REVIEW_QUALITY,
  };
}

/**
 * Conserva una misura autorevole ricevuta dall'extractor e arricchisce solo
 * l'asse euristico. Un metadata measured malformato viene degradato fail-safe.
 */
export function reconcileOcrQualityMetadata(
  supplied: OcrQualityMetadata | undefined,
  assessed: OcrQualityMetadata
): OcrQualityMetadata {
  if (!supplied) return assessed;

  const suppliedMeasured =
    supplied.confidenceType === 'measured'
      ? normalizeMeasuredConfidence(supplied.measuredConfidence)
      : undefined;
  const assessedMeasured =
    assessed.confidenceType === 'measured'
      ? normalizeMeasuredConfidence(assessed.measuredConfidence)
      : undefined;
  const measuredConfidence = suppliedMeasured ?? assessedMeasured;
  const confidenceType: OcrConfidenceType =
    measuredConfidence !== undefined
      ? 'measured'
      : supplied.confidenceType === 'heuristic'
        ? 'heuristic'
        : assessed.confidenceType === 'heuristic'
          ? 'heuristic'
          : 'unknown';
  const heuristicQuality =
    normalizeMeasuredConfidence(assessed.heuristicQuality) ??
    normalizeMeasuredConfidence(supplied.heuristicQuality);
  const invalidSuppliedMeasure =
    supplied.confidenceType === 'measured' &&
    suppliedMeasured === undefined;
  const nonProviderReasons = [
    ...supplied.qualityReasons,
    ...assessed.qualityReasons,
  ].filter(
    (reason) =>
      reason !== 'provider_confidence_available' &&
      reason !== 'provider_confidence_unavailable'
  );

  return {
    ...(measuredConfidence !== undefined ? { measuredConfidence } : {}),
    ...(heuristicQuality !== undefined ? { heuristicQuality } : {}),
    confidenceType,
    qualityReasons: uniqueReasons([
      ...nonProviderReasons,
      measuredConfidence !== undefined
        ? 'provider_confidence_available'
        : 'provider_confidence_unavailable',
    ]),
    requiresReview:
      supplied.requiresReview ||
      assessed.requiresReview ||
      invalidSuppliedMeasure,
  };
}

export function legacyOcrQualityMetadata(
  value: unknown
): OcrQualityMetadata | undefined {
  const heuristicQuality = normalizeMeasuredConfidence(value);
  if (heuristicQuality === undefined) return undefined;
  return {
    heuristicQuality,
    confidenceType: 'heuristic',
    qualityReasons: ['legacy_quality_estimate'],
    requiresReview: heuristicQuality < MIN_REVIEW_QUALITY,
  };
}

import type { DocumentEvidence, DocumentLayoutLine } from './document-structure';

const NORMALIZE_TEXT_CACHE = new Map<string, string>();

export function documentEvidence<T>(params: {
  rawValue: unknown;
  normalizedValue?: T;
  lines: readonly DocumentLayoutLine[];
  validationStatus?: DocumentEvidence<T>['validationStatus'];
  confidenceType?: DocumentEvidence<T>['confidenceType'];
  reasons: string[];
  requiresReview?: boolean;
  conflict?: boolean;
}): DocumentEvidence<T> {
  const validationStatus = params.validationStatus ?? 'unverified';
  const boxes = params.lines.flatMap((line) => line.boundingBox ? [line.boundingBox] : []);
  const boundingBox = boxes.length > 0 ? {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    width: Math.max(...boxes.map((box) => box.x + box.width)) - Math.min(...boxes.map((box) => box.x)),
    height: Math.max(...boxes.map((box) => box.y + box.height)) - Math.min(...boxes.map((box) => box.y)),
  } : undefined;
  return {
    rawValue: params.rawValue,
    ...(params.normalizedValue !== undefined ? { normalizedValue: params.normalizedValue } : {}),
    pageIndex: params.lines[0]?.pageIndex ?? 0,
    sourceLineIds: params.lines.map((line) => line.id),
    sourceLines: params.lines.map((line) => line.text),
    ...(boundingBox ? { boundingBox } : {}),
    evidenceText: params.lines.map((line) => line.text).join('\n'),
    source: 'local',
    validationStatus,
    confidenceType: params.confidenceType ?? 'heuristic',
    reasons: [...params.reasons],
    requiresReview:
      params.requiresReview ?? !['valid'].includes(validationStatus),
    alternatives: [],
    ...(params.conflict ? { conflict: true } : {}),
  };
}

export function normalizeDocumentText(value: string): string {
  const cached = NORMALIZE_TEXT_CACHE.get(value);
  if (cached !== undefined) return cached;
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/\s+/g, ' ')
    .trim();
  if (NORMALIZE_TEXT_CACHE.size >= 4000) NORMALIZE_TEXT_CACHE.clear();
  NORMALIZE_TEXT_CACHE.set(value, normalized);
  return normalized;
}

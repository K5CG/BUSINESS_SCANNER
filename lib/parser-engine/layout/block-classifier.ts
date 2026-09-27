import { inferLineKind } from './geometry';
import type { BlockDetectionResult, BlockFeatureVector, BlockKind, LayoutBlock } from './types';

const EMAIL_REGEX = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const WEBSITE_REGEX = /\b(?:https?:\/\/)?(?:www\.|ww\.)[a-z0-9.-]+\.[a-z]{2,}\b/i;
const PHONE_REGEX = /\b(?:\+?\d[\d./\s-]{6,}\d)\b/;
const ROLE_REGEX =
  /\b(manager|director|responsabile|consulente|amministratore|commercialista|revisore|engineer|specialist|sales|marketing)\b/i;
const ADDRESS_REGEX =
  /\b(via|viale|piazza|corso|vicolo|street|road|avenue|blvd|nr\.?|n\.)\b/i;
const POSTAL_CODE_REGEX = /\b\d{5}\b/;
const PROVINCE_HINT_REGEX = /\([A-Z]{2}\)|\b-\s*[A-Z]{2}\s*-/;
const LEGAL_FORM_REGEX =
  /\b(S\.?\s*R\.?\s*L\.?|S\.?\s*P\.?\s*A\.?|S\.?\s*N\.?\s*C\.?|S\.?\s*A\.?\s*S\.?|LLC|LTD|INC|GMBH|AG)\b/i;
const TAX_REGEX = /\b(p\.?\s*iva|partita\s*iva|c\.?\s*f\.?|codice\s*fiscale|vat|tax)\b/i;
const CATALOG_NOISE_REGEX =
  /\b(installazione|assistenza|catalogo|progettazione|soluzioni|componenti|prodotti|servizi)\b/i;

function blockText(block: LayoutBlock): string {
  return block.lines.map((l) => l.text).join(' ');
}

function tallyLineKinds(block: LayoutBlock): Map<BlockKind, number> {
  const counts = new Map<BlockKind, number>();
  for (const line of block.lines) {
    const kind = inferLineKind(line.text);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

function majorityLineKind(block: LayoutBlock): { kind: BlockKind; share: number } {
  const counts = tallyLineKinds(block);
  let bestKind: BlockKind = 'unknown';
  let bestCount = 0;
  for (const [kind, count] of counts) {
    if (count > bestCount) {
      bestKind = kind;
      bestCount = count;
    }
  }
  return { kind: bestKind, share: bestCount / Math.max(1, block.lines.length) };
}

function lineKindShare(block: LayoutBlock, kind: BlockKind): number {
  const counts = tallyLineKinds(block);
  return (counts.get(kind) ?? 0) / Math.max(1, block.lines.length);
}

export function computeBlockFeatures(block: LayoutBlock, verticalRank: number): BlockFeatureVector {
  const text = blockText(block);
  const hasEmail = EMAIL_REGEX.test(text);
  const hasWebsite = WEBSITE_REGEX.test(text);
  const hasPhone = PHONE_REGEX.test(text) || /\b(tel|fax|phone|mobile|cell)\b/i.test(text);
  const hasAddressHints = ADDRESS_REGEX.test(text);
  const hasPostalCode = POSTAL_CODE_REGEX.test(text);
  const hasProvinceHint = PROVINCE_HINT_REGEX.test(text);
  const hasLegalForm = LEGAL_FORM_REGEX.test(text);
  const hasRoleHints = ROLE_REGEX.test(text);
  const hasCatalogNoise = CATALOG_NOISE_REGEX.test(text);

  return {
    ...block.features,
    hasEmail,
    hasWebsite,
    hasPhone,
    hasAddressHints,
    hasPostalCode,
    hasProvinceHint,
    hasLegalForm,
    hasRoleHints,
    hasCatalogNoise,
    verticalRank,
  };
}

export function classifyBlock(
  block: LayoutBlock,
  features: BlockFeatureVector
): { kind: BlockKind; confidence: number; reasons: string[] } {
  const reasons: string[] = [];
  const majority = majorityLineKind(block);
  const text = blockText(block);

  reasons.push(`majority line kind: ${majority.kind} (${Math.round(majority.share * 100)}%)`);

  if (majority.kind !== 'unknown' && majority.share >= 0.34) {
    const confidence = Math.min(0.95, 0.55 + majority.share * 0.4);
    return { kind: majority.kind, confidence, reasons };
  }

  if (lineKindShare(block, 'tax') >= 0.5 || (TAX_REGEX.test(text) && features.avgNumericDensity >= 0.15)) {
    reasons.push('majority or dominant fiscal lines');
    return { kind: 'tax', confidence: 0.86, reasons };
  }
  if (lineKindShare(block, 'contact') >= 0.5) {
    reasons.push('majority contact lines');
    return { kind: 'contact', confidence: 0.84, reasons };
  }
  if (lineKindShare(block, 'address') >= 0.5) {
    reasons.push('majority address lines');
    return { kind: 'address', confidence: 0.82, reasons };
  }
  if (lineKindShare(block, 'noise') >= 0.5) {
    reasons.push('majority catalog/marketing lines');
    return { kind: 'noise', confidence: 0.78, reasons };
  }
  if (lineKindShare(block, 'role') >= 0.5) {
    reasons.push('majority role lines');
    return { kind: 'role', confidence: 0.8, reasons };
  }
  if (lineKindShare(block, 'company') >= 0.34) {
    reasons.push('plurality of company-like lines');
    return { kind: 'company', confidence: 0.76, reasons };
  }
  if (lineKindShare(block, 'identity') >= 0.34 && features.verticalRank <= 0.45) {
    reasons.push('identity lines in upper card area');
    return { kind: 'identity', confidence: 0.72, reasons };
  }

  reasons.push('insufficient semantic signals');
  return { kind: 'unknown', confidence: 0.45, reasons };
}

export function classifyBlocks(blocks: LayoutBlock[]): BlockDetectionResult {
  if (!blocks.length) {
    return { lines: [], blocks: [] };
  }

  const minY = Math.min(...blocks.map((b) => b.y));
  const maxBottom = Math.max(...blocks.map((b) => b.bottom));
  const span = Math.max(1, maxBottom - minY);

  const classified = blocks.map((block) => {
    const verticalRank = (block.y - minY) / span;
    const features = computeBlockFeatures(block, verticalRank);
    const outcome = classifyBlock(block, features);
    return { ...block, ...outcome, features };
  });

  const bestByKind = (kind: BlockKind) =>
    classified
      .filter((b) => b.kind === kind)
      .sort((a, b) => b.confidence - a.confidence)[0];

  return {
    lines: classified.flatMap((b) => b.lines),
    blocks: classified,
    possibleCompanyBlockId: bestByKind('company')?.id,
    possibleIdentityBlockId: bestByKind('identity')?.id,
    possibleContactBlockId: bestByKind('contact')?.id,
  };
}

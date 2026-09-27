import type { BlockKind, LayoutLine } from './types';

const EMAIL_REGEX = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const WEBSITE_REGEX = /\b(?:https?:\/\/)?(?:www\.|ww\.)[a-z0-9-]+\.[a-z]{2,}\b/i;
const PHONE_INLINE_REGEX = /\b(?:\+?\d[\d./\s-]{6,}\d)\b/;
const CONTACT_LABEL_REGEX =
  /\b(tel\.?|fax\.?|phone|mobile|cell\.?|e-?mail|pec|ph\.|mob\.|telefono|telefax|cmail)\b/i;
const ROLE_REGEX =
  /\b(manager|director|responsabile|consulente|amministratore|commercialista|revisore|contabile|engineer|specialist|sales|marketing|solutions|dottore|dottoressa)\b/i;
const ADDRESS_REGEX =
  /\b(via|viale|piazza|corso|vicolo|street|road|avenue|blvd|sede\s+operativa|registered\s+office)\b/i;
const POSTAL_CODE_REGEX = /\b\d{5}\b/;
const PROVINCE_FRAGMENT_REGEX = /^\(?[A-Za-z]{1,2}\)?$/;
const LEGAL_FORM_REGEX =
  /\b(S\.?\s*R\.?\s*L\.?|S\.?\s*P\.?\s*A\.?|S\.?\s*N\.?\s*C\.?|S\.?\s*A\.?\s*S\.?|LLC|LTD|INC|GMBH|AG)\b/i;
const TAX_REGEX = /\b(p\.?\s*iva|partita\s*iva|c\.?\s*f\.?|codice\s*fiscale|vat|tax|ce\/)\b/i;
const CATALOG_REGEX =
  /\b(installazione|assistenza|catalogo|progettazione|soluzioni|componenti|prodotti|servizi|serramenti|portoni|detraibili|costruzione)\b/i;
const TITLE_PREFIX_REGEX = /^(?:dott\.?|dottoressa?|ing\.?|avv\.?|prof\.?|geom\.?|sig\.?|sig\.ra|dr\.?)\s+/i;
const IDENTITY_NAME_REGEX = /^[A-ZÀ-Ü][a-zà-ü]+(?:\s+[A-ZÀ-Ü][a-zà-ü]+){1,3}$/;

export function normalizeCoordinate(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

export function normalizeSize(value: number, fallback = 1): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, value);
}

export function normalizeRect(rect?: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): { x: number; y: number; width: number; height: number } {
  const x = normalizeCoordinate(rect?.x ?? 0, 0);
  const y = normalizeCoordinate(rect?.y ?? 0, 0);
  const width = normalizeSize(rect?.width ?? 1, 1);
  const height = normalizeSize(rect?.height ?? 1, 1);
  return { x, y, width, height };
}

export function verticalGap(a: LayoutLine, b: LayoutLine): number {
  if (a.bottom <= b.y) return b.y - a.bottom;
  if (b.bottom <= a.y) return a.y - b.bottom;
  return 0;
}

export function horizontalOverlapRatio(a: LayoutLine, b: LayoutLine): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.right, b.right);
  const overlap = Math.max(0, right - left);
  const minWidth = Math.max(1, Math.min(a.width, b.width));
  return overlap / minWidth;
}

export function leftAlignmentDelta(a: LayoutLine, b: LayoutLine): number {
  return Math.abs(a.x - b.x);
}

export function centerAlignmentDelta(a: LayoutLine, b: LayoutLine): number {
  return Math.abs(a.centerX - b.centerX);
}

export function rightAlignmentDelta(a: LayoutLine, b: LayoutLine): number {
  return Math.abs(a.right - b.right);
}

export function estimateAverageLineHeight(lines: LayoutLine[]): number {
  if (!lines.length) return 1;
  const heights = lines.map((l) => l.height).filter((h) => Number.isFinite(h) && h > 0);
  if (!heights.length) return 1;
  const sum = heights.reduce((acc, cur) => acc + cur, 0);
  return Math.max(1, sum / heights.length);
}

export function areLinesInSameGraphicBlock(
  a: LayoutLine,
  b: LayoutLine,
  averageHeight: number
): boolean {
  if (a.pageIndex !== b.pageIndex) return false;

  const vGap = verticalGap(a, b);
  const overlap = horizontalOverlapRatio(a, b);
  const leftDelta = leftAlignmentDelta(a, b);
  const centerDelta = centerAlignmentDelta(a, b);
  const rightDelta = rightAlignmentDelta(a, b);

  const maxVGap = averageHeight * 1.25;
  const maxAlignDelta = Math.max(10, averageHeight * 2.2);
  const aligned =
    leftDelta <= maxAlignDelta || centerDelta <= maxAlignDelta || rightDelta <= maxAlignDelta;

  return vGap <= maxVGap && aligned && overlap >= 0.12;
}

function uppercaseRatio(text: string): number {
  const letters = text.replace(/[^A-Za-zÀ-Ü]/g, '');
  if (!letters.length) return 0;
  const upper = text.replace(/[^A-ZÀ-Ü]/g, '').length;
  return upper / letters.length;
}

function isMostlyNumericLine(text: string): boolean {
  const digits = text.replace(/\D/g, '').length;
  return digits >= 6 && digits / Math.max(text.length, 1) >= 0.45;
}

/** Classificazione generica di una singola riga OCR. */
export function inferLineKind(text: string): BlockKind {
  const t = text.trim();
  if (!t) return 'unknown';

  if (/^\s*[*•·\-–—]/.test(t)) return 'noise';
  if (t.length > 50 && /[,;:]/.test(t)) return 'noise';
  if (/^\s*(costruzione|installazione|assistenza)\b/i.test(t)) return 'noise';
  if (/\bper\s+interni\b/i.test(t)) return 'noise';

  if (EMAIL_REGEX.test(t) || WEBSITE_REGEX.test(t) || CONTACT_LABEL_REGEX.test(t)) return 'contact';
  if (PHONE_INLINE_REGEX.test(t) && isMostlyNumericLine(t)) return 'contact';

  if (TAX_REGEX.test(t) || (/\b\d{11}\b/.test(t) && /iva|fisc|c\.?\s*f/i.test(t))) return 'tax';

  if (ADDRESS_REGEX.test(t)) return 'address';
  if (POSTAL_CODE_REGEX.test(t) && /[A-Za-zÀ-ü]{3,}/.test(t)) return 'address';
  if (PROVINCE_FRAGMENT_REGEX.test(t)) return 'address';

  if (TITLE_PREFIX_REGEX.test(t)) return 'identity';
  if (IDENTITY_NAME_REGEX.test(t) && !ROLE_REGEX.test(t) && !LEGAL_FORM_REGEX.test(t)) return 'identity';

  if (LEGAL_FORM_REGEX.test(t)) return 'company';
  if (/^[a-zà-ü]/.test(t) && t.length <= 35 && !ADDRESS_REGEX.test(t) && !EMAIL_REGEX.test(t)) {
    return 'company';
  }

  const upper = uppercaseRatio(t);
  const alpha = t.replace(/[^A-Za-zÀ-ü]/g, '');
  if (alpha.length >= 3 && upper >= 0.72 && t.length <= 40 && !EMAIL_REGEX.test(t)) {
    return 'company';
  }

  // Brand token singolo o fused (es. Wise, ABellotto) prima di role/catalog generici.
  if (
    /^[A-ZÀ-Ü][A-Za-zÀ-ü&]{2,22}$/.test(t) &&
    !ROLE_REGEX.test(t) &&
    !ADDRESS_REGEX.test(t) &&
    !EMAIL_REGEX.test(t)
  ) {
    return 'company';
  }

  // Tagline aziendale mista (non elenco catalogo).
  if (
    CATALOG_REGEX.test(t) &&
    t.length <= 42 &&
    !/^\s*[*•·\-–—]/.test(t) &&
    upper < 0.72
  ) {
    return 'company';
  }

  if (ROLE_REGEX.test(t) && !LEGAL_FORM_REGEX.test(t)) return 'role';

  if (CATALOG_REGEX.test(t) && (t.length > 42 || /^\s*[*•·\-–—]/.test(t))) {
    return 'noise';
  }

  return 'unknown';
}

export function hasStrongCasingShift(a: LayoutLine, b: LayoutLine): boolean {
  const delta = Math.abs(a.uppercaseRatio - b.uppercaseRatio);
  return delta >= 0.38 && (a.uppercaseRatio >= 0.7 || b.uppercaseRatio >= 0.7);
}

const STRONG_KINDS = new Set<BlockKind>(['contact', 'tax', 'address', 'noise']);

export function isSectionBoundary(prevKind: BlockKind, nextKind: BlockKind): boolean {
  if (prevKind === nextKind) return false;
  if (STRONG_KINDS.has(prevKind) || STRONG_KINDS.has(nextKind)) return true;

  if ((prevKind === 'identity' || prevKind === 'role') && nextKind === 'address') return true;
  if ((prevKind === 'identity' || prevKind === 'role') && nextKind === 'company') return true;
  if (prevKind === 'role' && nextKind === 'identity') return true;
  if (prevKind === 'address' && nextKind === 'contact') return true;
  if (prevKind === 'address' && nextKind === 'company') return true;
  if ((prevKind === 'contact' || prevKind === 'tax') && nextKind === 'company') return true;
  if (prevKind === 'company' && nextKind === 'noise') return true;
  if (prevKind === 'company' && nextKind === 'contact') return true;
  if (prevKind === 'company' && nextKind === 'identity') return true;
  if (prevKind === 'noise' && (nextKind === 'identity' || nextKind === 'role')) return true;
  if (prevKind === 'noise' && nextKind === 'company') return true;

  return false;
}

/** True se due righe adiacenti appartengono a sezioni diverse del biglietto. */
export function shouldSplitLines(
  prev: LayoutLine,
  next: LayoutLine,
  averageHeight: number
): boolean {
  if (prev.pageIndex !== next.pageIndex) return true;

  const vGap = verticalGap(prev, next);
  if (vGap > averageHeight * 1.6) return true;

  const prevKind = inferLineKind(prev.text);
  const nextKind = inferLineKind(next.text);

  if (isSectionBoundary(prevKind, nextKind)) return true;

  const bothCompanyish =
    (prevKind === 'company' || prevKind === 'unknown') &&
    (nextKind === 'company' || nextKind === 'unknown');
  if (!bothCompanyish && hasStrongCasingShift(prev, next) && prevKind !== nextKind) return true;

  const prevContactish = prevKind === 'contact' || prevKind === 'tax';
  const nextCompanyish = nextKind === 'company';
  if (prevContactish && nextCompanyish) return true;

  const prevAlpha = prev.text.replace(/[^A-Za-zÀ-ü]/g, '').length;
  const nextNumeric = next.numericDensity >= 0.35 || nextKind === 'contact';
  if (prevAlpha >= 6 && nextNumeric && prevKind !== nextKind) return true;

  return false;
}

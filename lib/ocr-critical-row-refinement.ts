/**
 * Refinement puro per righe OCR critiche dei biglietti.
 *
 * Non inventa caratteri: decide soltanto se un SECONDO OCR focalizzato sui
 * pixel della stessa riga e' abbastanza coerente da sostituire la prima lettura.
 */

export type CriticalRowKind = 'phone' | 'fiscal' | 'address-civic' | 'address-qualifier';

export interface CriticalRowDecision {
  kind: CriticalRowKind | null;
  selected: string | null;
  changed: boolean;
  reason: string;
}

const STREET_RE = /\b(?:via|viale|vicolo|corso|piazza|strada|street|road|avenue|lane|drive|boulevard|blvd|rue|straat|strasse|straße)\b/iu;
const CONTACT_PREFIX_RE = /^\s*(?:tel(?:efono|ephone)?\.?|phone|ph\.?|fax|telefax|mob(?:ile)?\.?|cell(?:ulare)?\.?|t|f)\s*[:._+-]?\s*/iu;
const PHONE_ALLOWED_RE = /^[\s()+.,/\-0-9A-Za-z|]+$/u;
const FISCAL_LABEL_RE = /^\s*(?:p\.?\s*i(?:va)?|partita\s+iva|vat|c\.?\s*f\.?|codice\s+fiscale)\s*[:._+\-]?\s*/iu;
const ADDRESS_STRUCTURE_RE = /\b(?:p\.?\s*o\.?\s*box|postfach|unit|bldg|building|room|suite|floor|tower|block|zone|sector|lot|park|estate|campus|complex)\b/iu;
const ADDRESS_QUALIFIERS = ['phase', 'building', 'bldg', 'unit', 'room', 'suite', 'floor', 'tower', 'block', 'zone', 'sector', 'lot'];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index);
  const cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  const max = Math.max(left.length, right.length, 1);
  return 1 - levenshtein(left, right) / max;
}

function phonePayload(text: string): string | null {
  const match = text.match(CONTACT_PREFIX_RE);
  if (!match) return null;
  const payload = text.slice(match[0].length).trim();
  return payload || null;
}

function phoneDigits(text: string): string {
  return text.replace(/\D/g, '');
}

function isSuspiciousPhoneRow(text: string): boolean {
  const payload = phonePayload(text);
  if (!payload || !PHONE_ALLOWED_RE.test(payload)) return false;
  const digits = phoneDigits(payload);
  if (digits.length < 5) return false;
  return /[A-Za-z|]/.test(payload);
}

function isSuspiciousFiscalRow(text: string): boolean {
  const label = text.match(FISCAL_LABEL_RE);
  if (!label) return false;
  const payload = text.slice(label[0].length).trim();
  const digits = phoneDigits(payload);
  return digits.length >= 7 && digits.length <= 13 && /[A-Za-z|]/.test(payload);
}

function suspiciousAddressCivic(text: string): string | null {
  if (!STREET_RE.test(text)) return null;
  const match = text.match(/\b([BOSIl|])(?=\s*(?:[,;\-]|$))/u);
  return match?.[1] ?? null;
}

function suspiciousAddressQualifier(text: string): { observed: string; expected: string } | null {
  if (!ADDRESS_STRUCTURE_RE.test(text) && !STREET_RE.test(text)) return null;
  const words = text.match(/[\p{L}]{4,}/gu) ?? [];
  for (const observed of words) {
    const key = normalize(observed);
    if (!key) continue;
    for (const expected of ADDRESS_QUALIFIERS) {
      if (key === expected) continue;
      if (Math.abs(key.length - expected.length) > 1) continue;
      if (levenshtein(key, expected) === 1) return { observed, expected };
    }
  }
  return null;
}

export function criticalBusinessCardRowKind(text: string): CriticalRowKind | null {
  if (isSuspiciousFiscalRow(text)) return 'fiscal';
  if (isSuspiciousPhoneRow(text)) return 'phone';
  if (suspiciousAddressCivic(text)) return 'address-civic';
  if (suspiciousAddressQualifier(text)) return 'address-qualifier';
  return null;
}

function focusedCandidates(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8);
}

export function chooseFocusedCriticalRow(original: string, focusedText: string): CriticalRowDecision {
  const kind = criticalBusinessCardRowKind(original);
  if (!kind) return { kind: null, selected: null, changed: false, reason: 'not_critical' };
  const candidates = focusedCandidates(focusedText);
  if (!candidates.length) return { kind, selected: null, changed: false, reason: 'focused_empty' };

  if (kind === 'phone' || kind === 'fiscal') {
    const originalDigits = phoneDigits(original);
    const originalPayload = phonePayload(original) ?? original;
    const suspiciousGlyphCount = (originalPayload.match(/[A-Za-z|]/g) ?? []).length;
    const viable = candidates
      .filter((candidate) => {
        const payload = phonePayload(candidate) ?? candidate;
        if (!/^[\s()+.,/\-0-9]+$/.test(payload)) return false;
        const digits = phoneDigits(payload);
        const minDigits = kind === 'fiscal' ? 10 : 7;
        const maxDigits = kind === 'fiscal' ? 13 : 18;
        const allowedDelta = kind === 'fiscal' ? 2 : Math.max(2, Math.min(5, suspiciousGlyphCount + 1));
        if (digits.length < minDigits || digits.length > maxDigits || Math.abs(digits.length - originalDigits.length) > allowedDelta) return false;
        // Se il primo OCR conserva almeno il prefisso paese, la rilettura deve
        // concordare: impedisce che un altro numero vicino venga selezionato.
        const prefix = originalDigits.slice(0, Math.min(2, originalDigits.length));
        return kind === 'fiscal' || prefix.length < 2 || digits.startsWith(prefix);
      })
      .map((candidate) => ({ candidate, score: similarity(original, candidate) }))
      .filter((entry) => entry.score >= (kind === 'phone' && suspiciousGlyphCount >= 3 ? 0.35 : 0.58))
      .sort((a, b) => b.score - a.score);
    const selected = viable[0]?.candidate ?? null;
    return {
      kind,
      selected,
      changed: Boolean(selected && normalize(selected) !== normalize(original)),
      reason: selected ? `focused_${kind}_stronger` : `focused_${kind}_not_safe`,
    };
  }

  if (kind === 'address-qualifier') {
    const suspicious = suspiciousAddressQualifier(original);
    const viable = candidates
      .filter((candidate) => ADDRESS_STRUCTURE_RE.test(candidate) || STREET_RE.test(candidate))
      .map((candidate) => ({ candidate, score: similarity(original, candidate) }))
      .filter((entry) => entry.score >= 0.72)
      .filter((entry) => Boolean(
        suspicious && new RegExp(`\\b${suspicious.expected}\\b`, 'i').test(entry.candidate)
      ))
      .sort((a, b) => b.score - a.score);
    const selected = viable[0]?.candidate ?? null;
    return {
      kind,
      selected,
      changed: Boolean(selected && normalize(selected) !== normalize(original)),
      reason: selected ? 'focused_address_qualifier_stronger' : 'focused_address_qualifier_not_safe',
    };
  }

  const originalAmbiguous = suspiciousAddressCivic(original);
  const viable = candidates
    .filter((candidate) => STREET_RE.test(candidate))
    .map((candidate) => ({ candidate, score: similarity(original, candidate) }))
    .filter((entry) => entry.score >= 0.72)
    .filter((entry) => {
      if (!originalAmbiguous) return false;
      // Il secondo OCR deve produrre un civico numerico nella stessa zona
      // sintattica, non una riscrittura semantica dell'indirizzo.
      return /\b\d{1,5}[A-Za-z]?(?=\s*(?:[,;\-]|$))/u.test(entry.candidate);
    })
    .sort((a, b) => b.score - a.score);
  const selected = viable[0]?.candidate ?? null;
  return {
    kind,
    selected,
    changed: Boolean(selected && normalize(selected) !== normalize(original)),
    reason: selected ? 'focused_address_civic_stronger' : 'focused_address_not_safe',
  };
}

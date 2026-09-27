const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/gu;
const LATIN_ALNUM_RE = /[A-Za-z0-9]/g;

/**
 * Accetta una riga proveniente da un recognizer CJK soltanto quando contiene
 * evidenza CJK sostanziale. Evita che un singolo glifo spurio (es. un Hangul
 * davanti a un brand latino) contamini un biglietto interamente latino.
 */
export function hasSubstantiveCjkEvidence(text: string): boolean {
  const cjkCount = text.match(CJK_CHAR_RE)?.length ?? 0;
  if (cjkCount === 0) return false;
  if (cjkCount >= 2) return true;
  const latinCount = text.match(LATIN_ALNUM_RE)?.length ?? 0;
  return cjkCount >= latinCount;
}

/** Particelle onomastiche comuni (IT/EU) — casing conservativo. */
const NAME_PARTICLES = new Set([
  'de',
  'di',
  'da',
  'del',
  'della',
  'degli',
  'delle',
  'van',
  'von',
  'le',
  'la',
  'du',
  'dos',
  'das',
]);

/** Collassa spazi/tab e trim. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Suddivide in token alfanumerici (mantiene accenti e apostrofi interni). */
export function tokenize(text: string): string[] {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

/** Prima lettera maiuscola, resto minuscolo; particelle corte in Title Case. */
export function capitalizeWord(word: string): string {
  if (!word) return '';
  const lower = word.toLowerCase();
  if (word.length <= 3 && NAME_PARTICLES.has(lower)) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Title Case su un singolo token (preserva trattini interni). */
export function titleCaseWord(word: string): string {
  if (!word) return '';
  if (word.includes('-')) {
    return word
      .split('-')
      .map((part) => titleCaseWord(part))
      .join('-');
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Title Case su ogni token di una riga. */
export function titleCaseLine(text: string): string {
  return tokenize(text)
    .map((word) => titleCaseWord(word))
    .join(' ');
}

/** True se ogni lettera alfabetica è maiuscola (ignora cifre e punteggiatura). */
export function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^A-Za-zÀ-Üà-ü]/g, '');
  if (!letters) return false;
  return letters === letters.toUpperCase();
}

/** True se la maggior parte dei token è in Title Case. */
export function isTitleCase(text: string): boolean {
  const words = tokenize(text).filter((w) => /[A-Za-zÀ-Ü]/.test(w));
  if (words.length === 0) return false;
  const titleCased = words.filter((w) => /^[A-ZÀ-Ü][a-zà-ü'-]*$/.test(w));
  return titleCased.length >= Math.ceil(words.length / 2);
}

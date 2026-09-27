/** Ruolo con pattern OCR noise (GarbuIoDICKINson, …). */

export function isOcrRoleGarbage(value: string): boolean {
  if (!value?.trim()) return false;
  const compactActivity = value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();
  if (new Set([
    'consulting', 'consultancy', 'consulenza',
    'services', 'service', 'servizi',
    'solutions', 'soluzioni',
    'engineering', 'ingegneria',
    'technology', 'technologies', 'tecnologia',
  ]).has(compactActivity)) return true;
  if (/\b[A-Za-z]{2,}[a-z][A-Z][A-Za-z]{2,}\b/.test(value)) return true;
  if (/\b[A-Z]{3,}[a-z]{1,3}[A-Z][A-Za-z]+\b/.test(value)) return true;
  const letters = value.replace(/[^a-zà-ü]/gi, '');
  if (letters.length < 8) return false;
  const vowels = (letters.match(/[aeiouàèéìòù]/gi) ?? []).length;
  const ratio = vowels / letters.length;
  if (ratio < 0.18 && /[a-z][A-Z]|[A-Z]{4,}[a-z]/.test(value)) return true;
  if (/\b(?:group|gr[o0]up)\s+cio\b/i.test(value) && ratio < 0.28) return true;
  return false;
}

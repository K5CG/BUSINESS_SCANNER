/**
 * Prefisso CAP italiano (prime 2 cifre) → provincia più probabile.
 * Non esaustivo: copre le zone più frequenti nei biglietti QA.
 */
const CAP_PREFIX_TO_PROVINCE: Record<string, string> = {
  '10': 'TO',
  '20': 'MI',
  '21': 'VA',
  '25': 'BS',
  '31': 'TV',
  '34': 'GO',
  '35': 'PD',
  '36': 'VI',
  '37': 'VR',
  '40': 'BO',
  '41': 'BO',
  '44': 'MO',
  '45': 'PD',
  '46': 'MN',
  '47': 'RN',
  '48': 'RA',
  '50': 'FI',
  '51': 'FI',
  '56': 'PI',
  '60': 'AN',
  '61': 'PU',
  '70': 'BA',
  '80': 'NA',
  '90': 'PA',
  '00': 'RM',
  '01': 'RM',
};

export function provinceFromItalianCap(postalCode?: string | null): string | undefined {
  const cap = postalCode?.replace(/\s/g, '') ?? '';
  if (!/^\d{5}$/.test(cap)) return undefined;
  return CAP_PREFIX_TO_PROVINCE[cap.slice(0, 2)];
}

export function capProvinceCompatible(postalCode?: string | null, region?: string | null): boolean {
  const expected = provinceFromItalianCap(postalCode);
  if (!expected || !region?.trim()) return true;
  return region.trim().toUpperCase() === expected;
}

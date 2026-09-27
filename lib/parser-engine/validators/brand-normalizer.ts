import {
  COMMON_FIRST_NAMES,
  hasTerminalLegalFormSuffix,
  levenshteinDistance,
  normalizeBrandKey,
} from './dictionaries';
import {
  collectBrandKeysFromEmails,
  extractBusinessDomainRoot,
  formatBrandLabelFromKey,
  splitFusedDomainRoot,
} from './brand-domain';
import { getPrimaryBusinessEmailDomain } from './website';

/** OCR logo: slash o punto nel brand, prefisso accentato. */
const OCR_LOGO_FRAGMENT_RE =
  /\b[a-z]{2,}\s*[\/\\|.]\s*[a-z]{2,}\b/i;

const ADDRESS_LINE_RE =
  /\b(?:street|road|avenue|rue|strasse|calle|via|viale|corso|piazza|vicolo|lane|drive|boulevard|blvd)\b/i;

function titleCaseBrand(label: string): string {
  const t = label.trim();
  if (!t) return t;
  if (/^[A-Z0-9&.-]{2,}$/.test(t) && t === t.toUpperCase() && t.length <= 6) return t;
  if (/^[a-z0-9.-]+\.[a-z]{2,6}$/i.test(t.replace(/\s+/g, ''))) return t;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function formatBrandDisplay(key: string): string {
  if (!key) return '';
  const label = formatBrandLabelFromKey(key);
  if (label.length <= 3) return label;
  if (/^[A-Z]{2,4}$/.test(label)) return label;
  return titleCaseBrand(label);
}

function formatEvidenceBrand(original: string, evidenceLabel: string): string {
  const ev = evidenceLabel.trim();
  if (!ev) return original;
  if (original === original.toUpperCase() && /^[A-Z]{4,}$/.test(original)) {
    return ev.charAt(0).toUpperCase() + ev.slice(1).toLowerCase();
  }
  if (/^[A-Z][a-z]+$/.test(original)) {
    return ev.charAt(0).toUpperCase() + ev.slice(1).toLowerCase();
  }
  return titleCaseBrand(ev);
}

function pickBestEmailBrandKey(emails: string[] = []): string | null {
  const keys = collectBrandKeysFromEmails(emails).filter((k) => k.length >= 4);
  if (!keys.length) return null;
  return keys.sort((a, b) => b.length - a.length)[0] ?? null;
}

function brandKeysSimilar(a: string, b: string, maxDist = 3): boolean {
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return levenshteinDistance(a, b) <= maxDist;
}

/** Gestione conservativa dei prefissi nel local-part email rispetto ai nomi propri. */
export function normalizeEmailLocalBrandPart(part: string): string {
  const bare = part.trim();
  if (!bare) return '';
  const key = normalizeBrandKey(bare);
  if (COMMON_FIRST_NAMES.has(key)) return bare;
  return bare.replace(/^[a-z](?=[a-z]{3,})/i, '') || bare;
}

function collectEmailLocalBrandKeys(emails: string[] = []): Array<{ key: string; label: string; weight: number }> {
  const out: Array<{ key: string; label: string; weight: number }> = [];
  for (const email of emails) {
    const local = email.split('@')[0] ?? '';
    for (const part of local.split(/[._\-+]+/)) {
      const trimmed = normalizeEmailLocalBrandPart(part);
      const key = normalizeBrandKey(trimmed);
      if (key.length >= 4) out.push({ key, label: trimmed, weight: 2 });
    }
  }
  return out;
}

function collectAddressLineBrandKeys(rawText: string): Array<{ key: string; label: string; weight: number }> {
  const out: Array<{ key: string; label: string; weight: number }> = [];
  for (const line of rawText.split('\n')) {
    if (!ADDRESS_LINE_RE.test(line)) continue;
    for (const m of line.matchAll(/\b([A-Za-z]{4,})\b/g)) {
      const label = m[1];
      const key = normalizeBrandKey(label);
      if (key.length >= 4) out.push({ key, label, weight: 1 });
    }
  }
  return out;
}

/** True se il testo sembra un logo OCR corrotto (slash, prefisso È, ecc.). */
export function hasOcrBrandNoise(value: string): boolean {
  const t = value.trim();
  if (!t) return false;
  if (/^[èeÉ]\s/i.test(t)) return true;
  if (OCR_LOGO_FRAGMENT_RE.test(t) && !hasTerminalLegalFormSuffix(t)) return true;
  if (
    /[\\\/]/.test(t) &&
    !hasTerminalLegalFormSuffix(t) &&
    !/\b(?:s\.?\s*r\.?\s*l|gmbh|s\.?\s*p\.?\s*a)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

export function hasConfusableDigitInsideBrandToken(value: string): boolean {
  return value
    .split(/\s+/)
    .some(
      (token) =>
        /[\p{L}][01358](?=[\p{L}]|$)|[01358](?=[\p{L}])/u.test(token) &&
        /[\p{L}]/u.test(token)
    );
}

/**
 * Logo OCR con typo 1–2 caratteri: se email, nome persona o indirizzo concordano,
 * preferisce la variante con più evidenze (regola generica, nessun hardcode per biglietto).
 */
export function refineLogoBrandFromConvergentEvidence(
  company: string,
  emails: string[] = [],
  rawText: string = '',
  person?: { firstName?: string | null; lastName?: string | null }
): string | null {
  const brand = company.trim().split(/\s+/).slice(0, 2).join(' ');
  if (!brand || brand.split(/\s+/).length > 2 || brand.length < 4 || brand.length > 24) return null;

  const companyKey = normalizeBrandKey(brand);
  if (companyKey.length < 4) return null;
  if (COMMON_FIRST_NAMES.has(companyKey)) return null;
  const personFirstKey = person?.firstName ? normalizeBrandKey(person.firstName) : '';
  const personLastKey = person?.lastName ? normalizeBrandKey(person.lastName) : '';
  if (personFirstKey && companyKey === personFirstKey) return null;
  if (personLastKey && companyKey === personLastKey) return null;

  const evidence: Array<{ key: string; label: string; weight: number }> = [
    ...collectEmailLocalBrandKeys(emails),
    ...collectAddressLineBrandKeys(rawText),
  ];

  for (const name of [person?.lastName, person?.firstName]) {
    if (!name?.trim()) continue;
    const key = normalizeBrandKey(name);
    if (key.length >= 4) evidence.push({ key, label: name.trim(), weight: 2 });
  }

  const scored = new Map<string, { label: string; score: number }>();
  for (const ev of evidence) {
    if (ev.key === companyKey) continue;
    const dist = levenshteinDistance(companyKey, ev.key);
    if (dist < 1 || dist > 2) continue;
    if (Math.abs(companyKey.length - ev.key.length) > 1) continue;
    const score = ev.weight + (dist === 1 ? 1 : 0);
    const prev = scored.get(ev.key);
    if (!prev || score > prev.score) scored.set(ev.key, { label: ev.label, score });
  }

  let best: { key: string; label: string; score: number } | null = null;
  for (const [key, { label, score }] of scored) {
    if (!best || score > best.score) best = { key, label, score };
  }

  if (!best || best.score < 2) return null;
  return formatEvidenceBrand(brand, best.label);
}

/**
 * Corregge errori OCR tipici dei loghi usando pattern generici + dominio email.
 */
export function normalizeOcrBrandValue(
  value: string,
  emails: string[] = []
): string | null {
  let t = value.trim().replace(/\s+/g, ' ');
  if (!t) return null;

  const emailBrandKey = pickBestEmailBrandKey(emails);
  const valueKey = normalizeBrandKey(t);
  const preservesObservedBrandStructure =
    t.split(/\s+/).filter(Boolean).length >= 2 || /&/.test(t);

  if (OCR_LOGO_FRAGMENT_RE.test(t) && emailBrandKey) {
    return formatBrandDisplay(emailBrandKey);
  }

  if (/^[èeÉ]\s+/i.test(t)) {
    t = t.replace(/^[èeÉ]\s+/i, '').trim();
    if (emailBrandKey && brandKeysSimilar(valueKey, emailBrandKey, 4)) {
      return formatBrandDisplay(emailBrandKey);
    }
  }

  if (/[\\\/]/.test(t) && emailBrandKey) {
    const stripped = normalizeBrandKey(t.replace(/[^a-z0-9]/gi, ''));
    if (brandKeysSimilar(stripped, emailBrandKey, 4)) {
      return formatBrandDisplay(emailBrandKey);
    }
  }

  const domain = getPrimaryBusinessEmailDomain(emails);
  if (
    domain &&
    (
      !preservesObservedBrandStructure ||
      hasOcrBrandNoise(t) ||
      hasConfusableDigitInsideBrandToken(t)
    )
  ) {
    const root = splitFusedDomainRoot(extractBusinessDomainRoot(domain));
    const domainKey = normalizeBrandKey(root);
    if (domainKey && valueKey && brandKeysSimilar(valueKey, domainKey, 3)) {
      return formatBrandDisplay(domainKey);
    }
    if (domainKey.length >= 5 && valueKey.length >= 4 && domainKey.includes(valueKey.slice(0, 4))) {
      return formatBrandDisplay(domainKey);
    }
  }

// Prefisso OCR spurio iniziale: accettato solo con evidenza indipendente della forma troncata.
  if (valueKey.length >= 6 && /^[NI1L]/.test(t)) {
    const trimmedKey = valueKey.slice(1);
    if (emailBrandKey && trimmedKey === emailBrandKey) {
      return formatBrandDisplay(trimmedKey);
    }
    for (const email of emails) {
      const localKey = normalizeBrandKey(email.split('@')[0] ?? '');
      if (localKey.length >= 4 && trimmedKey === localKey) {
        return formatBrandDisplay(trimmedKey);
      }
    }
  }

  if (t !== value.trim()) return t;
  return null;
}

/** Brand canonico dal dominio email. */
export function resolveBrandFromEmailDomain(emails: string[] = []): string | null {
  const businessDomain = getPrimaryBusinessEmailDomain(emails);
  if (!businessDomain) return null;
  const key = normalizeBrandKey(
    splitFusedDomainRoot(extractBusinessDomainRoot(businessDomain))
  );
  return key.length >= 3 ? formatBrandDisplay(key) : null;
}

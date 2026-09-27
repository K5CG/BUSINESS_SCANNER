/**
 * Normalizzazione generica ragione sociale / brand (casing OCR, split dominio, hostname).
 */
import {
  extractBusinessDomainRoot,
  extractBusinessDomainRootCandidates,
  splitFusedDomainRoot,
} from '../parser-engine/validators/brand-domain';
import { hasLegalFormSuffix, levenshteinDistance, normalizeBrandKey, ROLE_KEYWORD_REGEX, stripLegalFormSuffix } from '../parser-engine/validators/dictionaries';

const FUSED_DOMAIN_SUFFIXES = [
  'motorbike',
  'motor',
  'ingegneria',
  'serramenti',
  'software',
  'solutions',
  'servizi',
  'consulting',
  'technology',
  'systems',
  'group',
  'bio',
  'tech',
  'digital',
  'logistic',
  'logistics',
  'soluzioni',
];

/** Corregge casing OCR su singola parola (es. sERVIZI → SERVIZI). */
export function fixOcrTokenCasing(word: string): string {
  const letters = word.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 3) return word;
  const upper = (letters.match(/[A-ZÀ-Ý]/g) ?? []).length;
  const ratio = upper / letters.length;
  if (ratio >= 0.5 && ratio < 0.95 && /[a-z]/.test(letters) && /[A-Z]/.test(letters)) {
    return word.toUpperCase();
  }
  return word;
}

export function normalizeCompanyPhraseCasing(phrase: string): string {
  return phrase
    .split(/(\s+)/)
    .map((chunk) => (/\s/.test(chunk) ? chunk : fixOcrTokenCasing(chunk)))
    .join('');
}

/** True se il valore è un hostname puro (non ragione sociale). */
export function isHostnameOnlyCompany(value: string): boolean {
  const t = value.trim().replace(/\s+/g, '');
  if (!t || t.length < 4) return false;
  if (/@|https?:\/\//i.test(t)) return true;
  if (/\b(?:via|viale|piazza|corso)\b/i.test(value)) return false;
  if (hasLegalFormSuffix(value)) return false;
  return /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,6}$/i.test(t);
}

/** Separa una radice dominio fusa (northstarmotorbike → Northstar Motorbike). */
export function splitFusedDomainBrand(root: string): string {
  const bare = root.replace(/^www\./i, '').trim();
  if (!bare) return root;
  if (bare.includes('-')) {
    return bare
      .split('-')
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join(' ');
  }
  const low = bare.toLowerCase();
  for (const suf of [...FUSED_DOMAIN_SUFFIXES].sort((a, b) => b.length - a.length)) {
    if (low.endsWith(suf) && low.length > suf.length + 2) {
      const prefix = bare.slice(0, bare.length - suf.length);
      const pCap = prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase();
      const sCap = suf.charAt(0).toUpperCase() + suf.slice(1).toLowerCase();
      return `${pCap} ${sCap}`;
    }
  }
  return bare.charAt(0).toUpperCase() + bare.slice(1).toLowerCase();
}

/** Normalizza gli spazi in una ragione sociale internazionale. */
export function repairInternationalCompanyOcr(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Varianti normalizzate della radice dominio per fuzzy match OCR. */
export function domainBrandRootVariants(domainRoot: string): string[] {
  const key = normalizeBrandKey(domainRoot);
  if (!key || key.length < 3) return [];
  return [...new Set([key, domainRoot.toLowerCase()])];
}

export function fuzzyCompanyDomainDistance(companyText: string, domainRoot: string): number {
  const lineKey = normalizeBrandKey(companyText.replace(/[^A-Za-zÀ-ÿ0-9]/g, ''));
  if (!lineKey || lineKey.length < 3) return 99;
  let best = 99;
  for (const variant of domainBrandRootVariants(domainRoot)) {
    if (lineKey === variant || lineKey.includes(variant) || variant.includes(lineKey)) {
      return 0;
    }
    best = Math.min(best, levenshteinDistance(lineKey, variant));
    if (variant.length >= 4 && lineKey.length >= 4) {
      if (lineKey.startsWith(variant.slice(0, 4)) || variant.startsWith(lineKey.slice(0, 4))) {
        best = Math.min(best, levenshteinDistance(lineKey, variant));
      }
    }
  }
  return best;
}

function brandKeyFromOcrCompanyLine(line: string): string {
  const stripped = line.trim().replace(/^[èeÉ]\s+/i, '');
  return normalizeBrandKey(stripped.replace(/[^A-Za-zÀ-ÿ]/g, ''));
}

/** Miglior riga OCR allineata in modo fuzzy col dominio email. */
export function pickBestFuzzyCompanyLineFromOcr(
  rawText: string,
  emails: string[] = [],
  websites: string[] = []
): string | null {
  if (!rawText?.trim() || (!emails.length && !websites.length)) return null;
  const emailHosts = emails
    .map(function(e) { return e.split('@')[1]?.toLowerCase().trim(); })
    .filter(function(d): d is string { return Boolean(d && !/^gmail|yahoo|hotmail|outlook|libero|pec/.test(d)); });
  const pickedRoot = pickBestDomainRoot(emailHosts, websites);
  if (!pickedRoot) return null;
  const domainRoot = splitFusedDomainRoot(pickedRoot);
  if (!domainRoot || domainRoot.length < 4) return null;

  let best: { line: string; dist: number; score: number } | null = null;
  for (const line of rawText.split('\n')) {
    const t = line.trim();
    if (!t || t.length < 4 || t.length > 48) continue;
    if (/@|www\.|https?:|tel|fax|\bvia\b/i.test(t)) continue;
    if (ROLE_KEYWORD_REGEX.test(t) && !hasLegalFormSuffix(t)) continue;
    const lineBrandKey = brandKeyFromOcrCompanyLine(t);
    const domainKeyForLine = normalizeBrandKey(domainRoot);
    const dist = fuzzyCompanyDomainDistance(t, domainRoot);
    let residualDist = 99;
    if (lineBrandKey && domainKeyForLine.length > lineBrandKey.length) {
      for (let n = 1; n <= 3 && n < domainKeyForLine.length; n += 1) {
        residualDist = Math.min(
          residualDist,
          levenshteinDistance(lineBrandKey, domainKeyForLine.slice(n)),
          levenshteinDistance(lineBrandKey, domainKeyForLine.slice(0, -n))
        );
      }
    }
    const effectiveDist = Math.min(dist, residualDist);
    if (effectiveDist > 2) continue;
    let score = (3 - effectiveDist) * 3;
    if (t === t.toUpperCase() && t.length <= 12) score += 1.5;
    if (hasLegalFormSuffix(t)) score += 2;
    if (!best || score > best.score || (score === best.score && dist < best.dist)) {
      best = { line: t, dist: effectiveDist, score };
    }
  }
  if (!best) return null;
  const brandKey = brandKeyFromOcrCompanyLine(best.line);
  const domainKey = normalizeBrandKey(domainRoot);
  const wordCount = best.line.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount >= 2 && wordCount <= 4 && brandKey.length >= 5 && domainKey.length > brandKey.length) {
    let match = null;
    for (let n = 1; n <= 3 && n < domainKey.length; n += 1) {
      const prefixCore = domainKey.slice(n);
      const prefixDist = levenshteinDistance(brandKey, prefixCore);
      if (prefixDist <= 2 && (!match || prefixDist < match.dist)) {
        match = { side: "prefix", extra: domainKey.slice(0, n), core: prefixCore, dist: prefixDist };
      }
      const suffixCore = domainKey.slice(0, -n);
      const suffixDist = levenshteinDistance(brandKey, suffixCore);
      if (suffixDist <= 2 && (!match || suffixDist < match.dist)) {
        match = { side: "suffix", extra: domainKey.slice(-n), core: suffixCore, dist: suffixDist };
      }
    }
    if (match) {
      const rawWords = best.line.trim().split(/\s+/).filter(Boolean);
      const canonicalWords = [];
      let offset = 0;
      for (let i = 0; i < rawWords.length; i += 1) {
        const tokenKey = brandKeyFromOcrCompanyLine(rawWords[i]);
        const remaining = match.core.slice(offset);
        const part = i === rawWords.length - 1 ? remaining : match.core.slice(offset, offset + tokenKey.length);
        if (!part) break;
        canonicalWords.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
        offset += part.length;
      }
      if (canonicalWords.length === rawWords.length && offset === match.core.length) {
        const observed = canonicalWords.join(" ");
        const extra = match.extra.toUpperCase();
        return match.side === "prefix" ? extra + " " + observed : observed + " " + extra;
      }
    }
  }
  const respelled = respellTokenFromDomainRoot(brandKey, domainRoot);
  if (hasLegalFormSuffix(best.line)) {
    const brand = respellTokenFromDomainRoot(
      brandKeyFromOcrCompanyLine(stripLegalFormSuffix(best.line)),
      domainRoot
    );
    const legal = best.line.match(/\b(?:s\.?\s*r\.?\s*l|s\.?\s*p\.?\s*a|s\.?\s*n\.?\s*c|gmbh|srl|spa)\b/i)?.[0];
    return legal ? `${brand} ${legal.replace(/\s+/g, ' ')}` : brand;
  }
  return respelled;
}

export function respellTokenFromDomainRoot(token: string, domainRoot: string): string {
  const cv = normalizeBrandKey(token);
  if (!cv || !domainRoot) return token;
  const candidates = domainBrandRootVariants(domainRoot);
  let best: { root: string; dist: number } | null = null;
  for (const root of candidates) {
    const cr = normalizeBrandKey(root);
    if (!cr) continue;
    const d = levenshteinDistance(cv, cr);
    if (d === 0) continue;
    if (d >= 1 && d <= 2 && Math.abs(cv.length - cr.length) <= 2) {
      if (!best || d < best.dist) best = { root, dist: d };
    }
  }
  if (!best) return token;
  const canonical = best.root;
  const split = splitFusedDomainBrand(canonical);
  if (split.includes(' ')) return split;
  return token === token.toUpperCase()
    ? canonical.toUpperCase()
    : canonical.charAt(0).toUpperCase() + canonical.slice(1).toLowerCase();
}

export function pickBestDomainRoot(
  emailHosts: string[],
  websiteHosts: string[]
): string | undefined {
  const score = new Map<string, number>();
  const add = (host: string, w: number) => {
    for (const root of extractBusinessDomainRootCandidates(host)) {
      if (root.length < 3) continue;
      score.set(root, (score.get(root) ?? 0) + w);
    }
  };
  for (const h of websiteHosts) add(h, 3);
  for (const h of emailHosts) add(h, 1);
  let best: string | undefined;
  let bestScore = 0;
  let bestIsTied = false;
  for (const [r, s] of score) {
    if (s > bestScore) {
      best = r;
      bestScore = s;
      bestIsTied = false;
    } else if (s === bestScore) {
      bestIsTied = true;
    }
  }
  return bestIsTied ? undefined : best;
}

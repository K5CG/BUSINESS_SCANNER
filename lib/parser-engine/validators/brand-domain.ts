import { isGenericProviderDomain } from '../extractors/website';
import { validateEmail } from './email';
import { isGenericEmailLocalPart } from '../extractors/email';
import { normalizeBrandKey } from './dictionaries';

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
];

const COMMON_COUNTRY_CODE_SECOND_LEVELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gen',
  'go',
  'gov',
  'id',
  'ltd',
  'me',
  'mil',
  'ne',
  'net',
  'nom',
  'or',
  'org',
  'plc',
  'sch',
]);

const RESERVED_REGISTRABLE_DOMAIN_LABELS = new Set([
  'example',
  'invalid',
  'localhost',
  'test',
]);

const INFRASTRUCTURE_SUBDOMAIN_LABELS = new Set([
  'api',
  'apac',
  'app',
  'apps',
  'assets',
  'cdn',
  'email',
  'emea',
  'eu',
  'files',
  'imap',
  'internal',
  'intranet',
  'mail',
  'media',
  'pop',
  'portal',
  'smtp',
  'staff',
  'static',
  'team',
  'web',
  'webmail',
  'www',
]);

/**
 * Estrae i label che possono rappresentare il brand. La radice registrabile
 * ha priorità; se è un host riservato/infrastrutturale (per esempio
 * brand.example.com), viene usato il sottodominio significativo più vicino.
 */
export function extractBusinessDomainRootCandidates(
  hostOrUrl: string
): string[] {
  const host = hostOrUrl
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    ?.split(':')[0] ?? '';
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) {
    const only = labels[0] ?? '';
    return only && !RESERVED_REGISTRABLE_DOMAIN_LABELS.has(only)
      ? [only]
      : [];
  }

  let rootIndex = labels.length - 2;
  const tld = labels[labels.length - 1] ?? '';
  const secondLevel = labels[labels.length - 2] ?? '';
  if (
    labels.length >= 3 &&
    tld.length === 2 &&
    COMMON_COUNTRY_CODE_SECOND_LEVELS.has(secondLevel)
  ) {
    rootIndex = labels.length - 3;
  }
  const root = labels[rootIndex] ?? '';
  const candidates = [
    ...(RESERVED_REGISTRABLE_DOMAIN_LABELS.has(root) ? [] : [root]),
    ...labels
      .slice(0, rootIndex)
      .reverse()
      .filter((label) => !INFRASTRUCTURE_SUBDOMAIN_LABELS.has(label)),
  ];
  return [...new Set(candidates)].filter(
    (label) => label.length >= 2 && /[a-z]/i.test(label)
  );
}

export function extractBusinessDomainRoot(hostOrUrl: string): string {
  const candidates = extractBusinessDomainRootCandidates(hostOrUrl);
  return candidates.length === 1 ? candidates[0] ?? '' : '';
}

/** Radice brand da host o local-part fuso (northstarmotorbike → northstar). */
export function splitFusedDomainRoot(root: string): string {
  const bare = root.replace(/^www\./i, '').trim().toLowerCase();
  if (!bare) return root;
  if (bare.includes('-')) {
    const parts = bare.split('-').filter(Boolean);
    // Preserva il nome completo unito da spazi/trattini (3a-strategy → 3a strategy)
    return parts.join(' ');
  }
  for (const suf of [...FUSED_DOMAIN_SUFFIXES].sort((a, b) => b.length - a.length)) {
    if (bare.endsWith(suf) && bare.length > suf.length + 2) {
      return bare.slice(0, bare.length - suf.length);
    }
  }
  return bare;
}

/** Chiavi brand da domini email e local-part hosted (northstarmotorbike → northstar). */
export function collectBrandKeysFromEmails(emails: string[] = []): string[] {
  const keys = new Set<string>();
  for (const email of emails) {
    if (!validateEmail(email) || isGenericEmailLocalPart(email)) continue;
    const [local, domainRaw] = email.split('@');
    const domain = domainRaw?.toLowerCase().trim();
    if (!domain) continue;

    if (!isGenericProviderDomain(domain)) {
      const hostRoot = extractBusinessDomainRoot(domain);
      if (hostRoot.length >= 3) {
        keys.add(normalizeBrandKey(hostRoot));
        keys.add(normalizeBrandKey(splitFusedDomainRoot(hostRoot)));
      }
      continue;
    }

    const localKey = normalizeBrandKey(local ?? '');
    if (localKey.length >= 4) {
      keys.add(localKey);
      keys.add(normalizeBrandKey(splitFusedDomainRoot(localKey)));
    }
  }
  return [...keys].filter(Boolean);
}

export function formatBrandLabelFromKey(brandKey: string): string {
  if (!brandKey) return '';
  if (brandKey.includes(' ') || brandKey.includes('-')) {
    const sep = brandKey.includes(' ') ? ' ' : '-';
    return brandKey
      .split(sep)
      .filter(Boolean)
      .map((p) => (p.length <= 3 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
      .join(sep);
  }
  return brandKey.length <= 4 ? brandKey.toUpperCase() : brandKey.charAt(0).toUpperCase() + brandKey.slice(1).toLowerCase();
}

import { isGenericProviderDomain } from '../extractors/website';
import { repairOcrContactText } from '../normalize/ocr-repair';
import { validateEmail } from './email';
import { isGenericEmailLocalPart } from '../extractors/email';
import { levenshteinDistance } from './dictionaries';

const WEBSITE_HOST_SOURCE =
  '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.[a-z]{2,63}';
const EXPLICIT_URL_REGEX = new RegExp(
  `(?:^|[^\\w@])((?:https?:\\/\\/(?:www\\.)?|www\\.)${WEBSITE_HOST_SOURCE})`,
  'gi'
);
const LABELED_WEBSITE_REGEX = new RegExp(
  `^\\s*(?:web|website|internet)\\s*:\\s*((?:https?:\\/\\/)?(?:www\\.)?${WEBSITE_HOST_SOURCE})`,
  'i'
);

function normalizeHostKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Un dominio email o hosting generico non identifica necessariamente la ragione sociale. */
export function isNonBusinessEmailDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '').trim();
  if (!d) return true;
  if (isGenericProviderDomain(d)) return true;
  const root = d.split('.')[0] ?? '';
  if (/^cyber\.(net|org|com|pk)/i.test(d)) return true;
  if (/\.net\.pk$/i.test(d) && root.length <= 6) return true;
  const hostingRoots = new Set([
    'cyber',
    'mail',
    'email',
    'host',
    'hosting',
    'server',
    'online',
    'box',
    'post',
    'smtp',
    'mx',
  ]);
  if (hostingRoots.has(root) && d.split('.').length <= 3) return true;
  return false;
}

/** Dominio email aziendale primario (non provider/hosting generici). */
export function getPrimaryBusinessEmailDomain(emails: string[] = []): string | null {
  let genericLocalDomain: string | null = null;
  for (const email of emails) {
    if (!validateEmail(email)) continue;
    const domain = email.split('@')[1]?.toLowerCase().trim();
    if (!domain || isGenericProviderDomain(domain) || isNonBusinessEmailDomain(domain)) continue;
    if (isGenericEmailLocalPart(email)) {
      genericLocalDomain = genericLocalDomain ?? domain;
      continue;
    }
    return domain;
  }
  return genericLocalDomain;
}

export function websiteHostMatchesEmailDomain(
  website: string,
  emailDomain: string
): boolean {
  const host =
    website
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('/')[0]
      ?.toLowerCase() ?? '';
  return host === emailDomain.toLowerCase() || host.endsWith(`.${emailDomain.toLowerCase()}`);
}

/** True se il sito OCR è assente, invalido o corrotto rispetto al dominio email. */
export function isWebsiteCorruptedForEmailDomain(
  website: string | undefined | null,
  emailDomain: string
): boolean {
  if (!website?.trim()) return true;

  const valid = validateWebsite(website);
  if (!valid) return true;
  if (websiteHostMatchesEmailDomain(valid, emailDomain)) return false;

  const host = valid.replace(/^www\./i, '').toLowerCase();
  if (host.endsWith(`.${emailDomain.toLowerCase()}`)) return false;
  if (isLegalFormWebsiteHost(host) || isPhoneLikeWebsiteHost(host)) return true;

  const siteRoot = host.split('.')[0] ?? '';
  const emailRoot = emailDomain.split('.')[0] ?? '';
  const siteKey = normalizeHostKey(siteRoot);
  const emailKey = normalizeHostKey(emailRoot);

  if (!siteKey || !emailKey) return true;
  // Stesso brand con host esplicito più descrittivo: non è corruzione OCR.
  if (siteKey.startsWith(emailKey) && siteKey.length >= emailKey.length + 2) return false;
  if (emailKey.endsWith(siteKey) || siteKey.endsWith(emailKey)) return true;
  if (host.includes(emailDomain) && host !== emailDomain) return true;
  if (
    Math.abs(siteKey.length - emailKey.length) <= 2 &&
    levenshteinDistance(siteKey, emailKey) <= 2
  ) {
    // Variante OCR 1 carattere: il www esplicito sul biglietto è affidabile
    if (levenshteinDistance(siteKey, emailKey) <= 1) return false;
    return true;
  }

  return false;
}

/**
 * Conserva soltanto un sito esplicitamente osservato e valido.
 *
 * Il dominio email può corroborare o segnalare incoerenza a valle, ma non è
 * evidenza sufficiente per creare o sostituire un sito web.
 */
export function resolveWebsiteWithPrimaryEmailDomain(
  website: string | undefined | null,
  emails: string[] = []
): string | null {
  void emails;
  return validateWebsite(website ?? undefined);
}

/** True se l'host sembra un numero di telefono (es. 0522629641, www.0522.629641). */
export function isPhoneLikeWebsiteHost(host: string): boolean {
  const bare = host
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    ?.split('.')[0] ?? '';
  if (!bare) return true;

  const alnum = bare.replace(/[^a-z0-9]/gi, '');
  const digits = alnum.replace(/\D/g, '').length;
  if (/^\d{5,}$/.test(alnum)) return true;
  if (digits >= 6 && digits / Math.max(alnum.length, 1) >= 0.55) return true;
  if (/^\d{2,4}[.\-_]?\d{5,}$/.test(bare)) return true;
  return false;
}

/** Host che replica forme giuridiche (www.s.rl, www.snc, www.spa, …). */
export function isLegalFormWebsiteHost(host: string): boolean {
  const bare = host
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .toLowerCase()
    .trim();
  if (!bare) return true;

  if (/^s\.?r\.?l(\.|$)/i.test(bare)) return true;
  if (/^(srl|snc|spa|sas|sapa)(\.[a-z]{2,})?$/i.test(bare)) return true;

  const root = bare.split('.')[0] ?? '';
  const compact = root.replace(/[.\s-]/g, '');
  if (/^(srl|snc|spa|sas|sapa)$/i.test(compact)) return true;
  if (/^sr+l$/i.test(compact)) return true;

  return false;
}

/** True se l'host ha struttura plausibile di dominio (non telefono, non solo cifre). */
export function isValidWebsiteHost(host: string): boolean {
  const normalized = host
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    ?.toLowerCase()
    .trim();
  if (!normalized) return false;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(normalized)) return false;
  if (isPhoneLikeWebsiteHost(normalized)) return false;
  if (isGenericProviderDomain(normalized)) return false;

  if (isLegalFormWebsiteHost(normalized)) return false;

  const labels = normalized.split('.');
  const domainLabel = labels[labels.length - 2] ?? '';
  if (!domainLabel || /^\d+$/.test(domainLabel)) return false;
  if (labels.every((label) => /^\d+$/.test(label))) return false;

  return true;
}

/** Normalizza e valida un sito web; ritorna `null` se host non plausibile. */
export function validateWebsite(url: string | undefined | null): string | null {
  const raw = url?.trim();
  if (!raw) return null;

  const stripped = raw.replace(/^https?:\/\//i, '').toLowerCase();
  const withWww = /^www\./i.test(stripped) ? stripped : `www.${stripped}`;
  const host = withWww.replace(/^www\./i, '').split('/')[0] ?? '';
  if (!isValidWebsiteHost(host)) return null;
  return withWww.split('/')[0];
}

/** Primo sito esplicito valido nel testo OCR, senza inferenze da email. */
export function resolveExplicitWebsiteFromText(
  rawText: string,
  emails: string[] = []
): string | undefined {
  void emails;
  const repaired = repairOcrContactText(rawText);
  for (const line of repaired.split(/\r?\n/)) {
    const labeled = line.match(LABELED_WEBSITE_REGEX)?.[1];
    const labeledValid = validateWebsite(labeled);
    if (labeledValid) return labeledValid;
  }

  for (const match of repaired.matchAll(EXPLICIT_URL_REGEX)) {
    const valid = validateWebsite(match[1]);
    if (valid) return valid;
  }
  return undefined;
}

/** Inferisce sito da dominio email aziendale (non provider generici). */
export function websiteFromEmailDomain(email: string): string | null {
  const domain = email.split('@')[1]?.toLowerCase().trim();
  if (!domain || isGenericProviderDomain(domain)) return null;
  return validateWebsite(`www.${domain}`);
}

/**
 * Coerenza email e sito web con gestione conservativa delle differenze OCR nel dominio.
 */
import { levenshteinDistance, normalizeBrandKey } from '../parser-engine/validators/dictionaries';
import { isGenericProviderDomain } from '../parser-engine/extractors/website';

function domainRoot(host: string | undefined): string {
  if (!host) return '';
  return normalizeBrandKey(host.replace(/^www\./i, '').split('.')[0] ?? '');
}

/** true se almeno un'email business ha dominio incoerente col sito. */
export function emailDomainIncoherentWithWebsite(
  emails: string[] = [],
  website?: string | null
): boolean {
  const webRoot = domainRoot(website?.replace(/^https?:\/\//i, ''));
  if (!webRoot || webRoot.length < 4) return false;

  for (const email of emails) {
    const dom = email.split('@')[1]?.toLowerCase().trim();
    if (!dom || isGenericProviderDomain(dom)) continue;
    const local = (email.split('@')[0] ?? '').trim();
    if (!local) continue;
    const emailRoot = domainRoot(dom);
    if (!emailRoot || emailRoot.length < 4) continue;
    if (emailRoot === webRoot) continue;
    const dist = levenshteinDistance(emailRoot, webRoot);
    const maxLen = Math.max(emailRoot.length, webRoot.length);
    if (dist > 0 && dist <= 2 && maxLen >= 5) return true;
    if (
      (emailRoot.includes(webRoot) || webRoot.includes(emailRoot)) &&
      emailRoot !== webRoot &&
      Math.abs(emailRoot.length - webRoot.length) <= 2
    ) {
      return true;
    }
    return true;
  }
  return false;
}

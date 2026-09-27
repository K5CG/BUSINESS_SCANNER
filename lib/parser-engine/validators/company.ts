import { hasLegalFormSuffix, hasTerminalLegalFormSuffix, isItalianCityName, levenshteinDistance, matchTerminalLegalFormSuffix, normalizeBrandKey, stripLegalFormSuffix, LEGAL_FORM_PATTERN_SOURCE, ROLE_KEYWORD_REGEX } from './dictionaries';
import { getPrimaryBusinessEmailDomain, isNonBusinessEmailDomain } from './website';
import { validateEmail } from './email';
import { preserveIfUnchanged } from './preserveIfUnchanged';
import { parsePersonNameFromLine } from './name';
import { isGenericProviderDomain } from '../extractors/website';
import {
  collectBrandKeysFromEmails,
  formatBrandLabelFromKey,
  splitFusedDomainRoot,
} from './brand-domain';
import { hasOcrBrandNoise, normalizeEmailLocalBrandPart, normalizeOcrBrandValue, resolveBrandFromEmailDomain } from './brand-normalizer';
import { repairInternationalCompanyOcr, respellTokenFromDomainRoot, domainBrandRootVariants, fuzzyCompanyDomainDistance } from '../../parser-v5/company-normalize';
import { isClaimLikeTerminalLegalPhrase } from './role';

const LEGAL_FORM_BEFORE_NUMBERED_LOCATION_RE = new RegExp(
  `^(.*?(?:^|[\\s,(])${LEGAL_FORM_PATTERN_SOURCE}\\)?)(?=\\s*(?:[,;:–—-]\\s*)?\\(?\\s*(?:blocco|block|lotto|lot|unit(?:a|à)?|scala|stair|piano|floor|edificio|building|suite|interno|int\\.?)\\b[^\\r\\n]{0,32}\\d)`,
  'i'
);

/**
 * Se una forma giuridica completa è seguita da un indicatore di sede
 * numerato, conserva soltanto la ragione sociale osservata.
 */
export function stripNumberedLocationAfterLegalForm(company: string): string {
  const value = company.trim();
  if (hasTerminalLegalFormSuffix(value)) return value;
  const match = value.match(LEGAL_FORM_BEFORE_NUMBERED_LOCATION_RE);
  if (!match?.[1]) return value;

  const candidate = match[1].trim().replace(/[,;:–—-]+$/, '').trim();
  const legal = matchTerminalLegalFormSuffix(candidate);
  if (!legal || normalizeBrandKey(legal.brand).length < 2) return value;
  return candidate;
}

function isHostnameOnlyValue(company: string): boolean {
  const t = company.trim().replace(/\s+/g, '');
  if (!t || t.length < 4) return false;
  if (hasTerminalLegalFormSuffix(company)) return false;
  if (/\b(?:via|viale|piazza|corso|group\s)/i.test(company) && !/\.[a-z]{2,6}$/i.test(t)) return false;
  return /^[a-z0-9][a-z0-9.\-]*\.[a-z]{2,6}$/i.test(t);
}

function recoverObservedWordBoundaries(
  brand: string,
  domainRoot: string,
  rawText?: string
): string | undefined {
  if (!rawText || /\s/.test(brand.trim())) return undefined;
  const target = normalizeBrandKey(domainRoot || brand);
  if (target.length < 6) return undefined;

  const candidates = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const words = line.split(/\s+/).filter(Boolean);
      if (words.length < 2 || words.length > 7) return false;
      if (/[@:/]|\b(?:tel|fax|mobile|email|www|department|manager)\b/i.test(line)) return false;
      const key = normalizeBrandKey(line);
      return key.length === target.length && levenshteinDistance(key, target) <= 1;
    })
    .sort((a, b) => a.length - b.length);
  const observed = candidates[0];
  if (!observed) return undefined;

  let offset = 0;
  const words = observed.split(/\s+/).filter(Boolean);
  const titleStyle = words.filter((word) => /^[A-ZÀ-Ü]/.test(word)).length >= 2;
  const rebuilt = words.map((word) => {
    const bare = normalizeBrandKey(word);
    if (!bare) return word;
    const canonical = target.slice(offset, offset + bare.length);
    offset += bare.length;
    if (canonical.length !== bare.length) return word;
    if (word === word.toUpperCase()) return canonical.toUpperCase();
    if (titleStyle && canonical.length > 2) {
      return canonical.charAt(0).toUpperCase() + canonical.slice(1);
    }
    return canonical;
  });
  return offset === target.length ? rebuilt.join(' ') : undefined;
}

/** Riga strutturata con etichetta esplicita: è evidenza di contatto, non company. */
export function isExplicitContactFieldLine(value: string): boolean {
  return /^(?:web(?:site)?|internet|url|e[\s-]?mail|mail|pec|contacts?|contatt[oi]|tel(?:ephone|efono)?|phone|mob(?:ile)?|cell(?:ulare)?|fax|skype|whatsapp)\s*(?::|=|\s[-–—]\s)/i.test(
    value.trim()
  );
}

/**
 * Narrow repair for a compact, uppercase domain-style brand where OCR reads
 * the final `I.` as `LL` (or confuses I/L/1 while retaining the separator).
 * It deliberately does not touch multi-word company names.
 */
function repairCompactOcrDomainBrand(value: string): string {
  const compact = value.trim().replace(/\s+/g, '');
  const doubledL = compact.match(/^([A-Z0-9][A-Z0-9-]{2,})LL(NET|COM|ORG|IT|EU)$/);
  if (doubledL) return `${doubledL[1]}I.${doubledL[2]}`;
  const separated = compact.match(/^([A-Z0-9][A-Z0-9-]{2,})(?:I|L|1)[._-](NET|COM|ORG|IT|EU)$/);
  if (separated) return `${separated[1]}I.${separated[2]}`;
  return value;
}

/** Rimuove prefissi/suffissi decorativi (---, ***, simboli) e titoli ruolo OCR. */
export function sanitizeCompanyValue(company: string): string {
  const withoutNumberedLocation = stripNumberedLocationAfterLegalForm(company);
  const preservesObservedLegalPeriod =
    Boolean(matchTerminalLegalFormSuffix(withoutNumberedLocation)) &&
    /\.\s*$/.test(withoutNumberedLocation);
  const sanitized = repairCompactOcrDomainBrand(withoutNumberedLocation)
    .trim()
    .replace(/^[-–—*_#./\\|]+/, '')
    .replace(/[-–—*_#./\\|]+$/, '')
    .replace(/^\d{5}\s*[-–—]\s*/i, '')
    .replace(
      /^(?:CEO|CTO|CFO|COO|founder|president|owner|director|managing\s+director|general\s+manager|gm)\s*-\s*/i,
      ''
    )
    // L'OCR spesso perde lo spazio dopo "&" nella ragione sociale; il
    // separatore resta valido solo se è seguito da una parola.
    .replace(/&(?=[A-Za-zÀ-Ü])/g, '& ')
    .replace(/\s+/g, ' ')
    .trim();
  return preservesObservedLegalPeriod && sanitized && !sanitized.endsWith('.')
    ? `${sanitized}.`
    : sanitized;
}

/** True se il valore è solo forma giuridica (es. "S.r.l") senza ragione sociale. */
export function isLegalFormOnlyCompany(company: string): boolean {
  const t = sanitizeCompanyValue(company);
  if (!hasLegalFormSuffix(t)) return false;
  const brand = stripLegalFormSuffix(t);
  const bare = (brand || t).replace(/[^A-Za-zÀ-ü0-9]/g, '').toLowerCase();
  if (/^(gmbh|srl|spa|snc|sas|ag|ltd|llc|inc|bv|nv|oy|ab|as|kg)(gmbh|srl|spa|snc|sas)?$/.test(bare)) {
    return true;
  }
  return !brand || brand.replace(/[^A-Za-zÀ-ü0-9]/g, '').length < 2;
}

const ACTIVITY_ONLY_COMPANY_WORDS = new Set([
  'accessori', 'assistenza', 'automazione', 'commercio', 'consulenza',
  'installazione', 'installazioni', 'pavimenti', 'produzione', 'progettazione',
  'ricambi', 'riparazione', 'riparazioni', 'rivestimenti', 'servizi',
  'trasporti', 'vendita',
]);

/**
 * Una riga composta esclusivamente da categorie di prodotti/servizi descrive
 * l'attività del titolare, non identifica da sola un'azienda. La verifica è
 * volutamente lessicale: "Pavimenti Rossi" resta ammissibile perché "Rossi"
 * non è una categoria, mentre "Pavimenti e Rivestimenti" viene scartata.
 */
function isActivityOnlyCompanyDescriptor(company: string): boolean {
  const words = company
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !/^(?:e|ed|and|&)$/.test(word));
  return words.length >= 2 && words.every((word) => ACTIVITY_ONLY_COMPANY_WORDS.has(word));
}

/** True se il testo non è una ragione sociale plausibile. */
export function isRejectedCompanyValue(company: string): boolean {
  const t = sanitizeCompanyValue(company);
  if (!t || t.length < 2) return true;
  if (isExplicitContactFieldLine(t)) return true;
  if (isLegalFormOnlyCompany(t)) return true;
  if (/@/.test(t)) return true;
  if (/\bskype\b/i.test(t)) return true;
  if (/\[[^\]]*\.[a-z]{2,}/i.test(t)) return true;
  if (/\bwww\./i.test(t) || /https?:\/\//i.test(t)) return true;
  if (/^www\s+/i.test(t)) return true;
  if (/\s+(?:com|it|net|org|eu)\b/i.test(t) && !/\.(?:com|it|net|org|eu)\b/i.test(t)) return true;
  if (
    /[\\/]/.test(t) &&
    !hasLegalFormSuffix(t) &&
    !hasTerminalLegalFormSuffix(t)
  ) {
    return true;
  }
  if (hasOcrBrandNoise(t)) return true;
  if (/\b(tel\.?|fax|telefono)\b/i.test(t)) return true;
  if (/^\d{5}\b/.test(t)) return true;
  if (/\b(via|viale|piazza|corso|vicolo|largo|str\.?)\b/i.test(t)) return true;
  if (isProviderDerivedCompanyName(t)) return true;
  if (isHostnameOnlyValue(t)) return true;
  if (isActivityOnlyCompanyDescriptor(t)) return true;
  return false;
}

function brandKeysAlign(a: string, b: string): boolean {
  if (!a || !b) return false;
  return (
    a === b ||
    a.includes(b) ||
    b.includes(a) ||
    levenshteinDistance(a, b) <= 2
  );
}

/**
 * Company = solo radice dominio senza legal form, mentre l'OCR contiene un'entità
 * Gestisce una ragione sociale osservata quando il brand del dominio email e diverso.
 * Non rifiuta ragioni sociali con forma giuridica né lo stesso brand con legal altrove.
 */
export function isDomainOnlyCompanyValue(
  company: string,
  emails: string[] = [],
  rawText?: string
): boolean {
  if (!company?.trim() || !rawText) return false;
  if (hasLegalFormSuffix(company)) return false;

  const domain = getPrimaryBusinessEmailDomain(emails);
  if (!domain) return false;
  const root = normalizeBrandKey(domain.split('.')[0] ?? '');
  const comp = normalizeBrandKey(stripLegalFormSuffix(company));
  if (!root || !comp || root.length < 4) return false;
  if (!brandKeysAlign(comp, root)) return false;

  const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
  let hasCompetingObservedLegalEntity = false;
  for (const line of lines) {
    const terminalLegal = matchTerminalLegalFormSuffix(line);
    if (
      !terminalLegal ||
      terminalLegal.strength !== 'strong' ||
      isClaimLikeTerminalLegalPhrase(line)
    ) {
      continue;
    }
    const lineBrand = normalizeBrandKey(terminalLegal.brand);
    if (lineBrand && brandKeysAlign(comp, lineBrand)) return false;
    hasCompetingObservedLegalEntity = true;
  }

  return (
    hasCompetingObservedLegalEntity ||
    /\b(?:&|figli|f\.?lli|s\.?n\.?c|falegnameria|impresa\s+edile)\b/i.test(rawText)
  );
}

/** Provider email/webmail OCR (libero, 1ibero, gmal, …) non è un'azienda. */
export function isProviderDerivedCompanyName(company: string): boolean {
  const compact = normalizeBrandKey(stripLegalFormSuffix(company));
  if (!compact || compact.length < 3) return false;
  const probes = [`${compact}.it`, `${compact}.com`, compact];
  for (const probe of probes) {
    if (isGenericProviderDomain(probe.includes('.') ? probe : `${probe}.it`)) return true;
  }
  return false;
}

function formatBrandFromEmailDomainRoot(domainRoot: string): string {
  return formatBrandLabelFromKey(splitFusedDomainRoot(domainRoot));
}

function shouldAlignBrandToDomain(brand: string, emailDomain: string, allEmails: string[] = []): boolean {
  const brandKey = normalizeBrandKey(stripLegalFormSuffix(brand));
  if (!brandKey) return false;

  const domainKeys = new Set<string>();
  const root = emailDomain.split('.')[0] ?? '';
  if (root) {
    domainKeys.add(normalizeBrandKey(root));
    domainKeys.add(normalizeBrandKey(splitFusedDomainRoot(root)));
  }
  for (const key of collectBrandKeysFromEmails(allEmails)) domainKeys.add(key);

  for (const domainKey of domainKeys) {
    if (!domainKey) continue;
    if (brandKey === domainKey) return false;
    if (domainKey.endsWith(brandKey) || brandKey.endsWith(domainKey)) return true;
    if (
      Math.abs(brandKey.length - domainKey.length) <= 2 &&
      levenshteinDistance(brandKey, domainKey) <= 2
    ) {
      return true;
    }
  }
  return false;
}

function pickAlignedBrandFromEmails(brand: string, emails: string[]): string | null {
  const brandKey = normalizeBrandKey(stripLegalFormSuffix(brand));
  if (!brandKey) return null;

  const domain = getPrimaryBusinessEmailDomain(emails);
  const domainKey = domain
    ? normalizeBrandKey(splitFusedDomainRoot(domain.split('.')[0] ?? ''))
    : '';
  if (domainKey && brandKeysAlign(brandKey, domainKey)) return null;

  let best: { key: string; dist: number } | null = null;
  for (const domainKeyCandidate of collectBrandKeysFromEmails(emails)) {
    if (!domainKeyCandidate || domainKeyCandidate === brandKey) continue;
    if (domainKey && domainKeyCandidate !== domainKey) continue;
    if (brandKey.includes(domainKeyCandidate) && brandKey.length > domainKeyCandidate.length + 1) continue;
    const dist = levenshteinDistance(brandKey, domainKeyCandidate);
    if (dist < 1 || dist > 2) continue;
    if (!best || dist < best.dist) best = { key: domainKeyCandidate, dist };
  }
  return best ? formatBrandLabelFromKey(best.key) : null;
}

function normalizeLegalFormToken(token: string): string {
  const compact = token.replace(/\s+/g, '').toUpperCase();
  if (/^S\.?R\.?L\.?\.?$/.test(compact)) return 'S.r.l.';
  return token.trim();
}

function extractNearbyLegalForm(rawText: string | undefined, company: string): string | null {
  if (!rawText || hasLegalFormSuffix(company)) return null;

  const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
  const anchor = sanitizeCompanyValue(company).split(/\s+/)[0]?.toLowerCase() ?? '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineLower = line.toLowerCase();
    if (anchor && !lineLower.includes(anchor)) continue;

    for (const nearby of [line, lines[i + 1], lines[i + 2]].filter(Boolean)) {
      const match = nearby.match(/\b(S\.?\s*R\.?\s*L\.?\.?|S\.?\s*P\.?\s*A\.?\.?|S\.?\s*N\.?\s*C\.?\.?)\b/i);
      if (match) return normalizeLegalFormToken(match[0]);
    }
  }

  for (const line of lines) {
    if (/^S\.?\s*R\.?\s*L\.?\s*$/i.test(line)) return 'S.r.l.';
  }

  return null;
}

/**
 * Allinea il marchio aziendale al dominio email primario e recupera la forma giuridica OCR.
 */
export function alignCompanyToEmailDomain(
  company: string,
  emails: string[] = [],
  rawText?: string
): string {
  let result = sanitizeCompanyValue(company);
  if (!result || isRejectedCompanyValue(result)) return result;
  result = repairInternationalCompanyOcr(result);

  const emailDomain = getPrimaryBusinessEmailDomain(emails);
  // Due righe di marchio impilate, entrambe osservate e coerenti con il
  // dominio aziendale, sono piu affidabili di una riga descrittiva che il
  // selettore ha promosso a company (es. attivita' professionale/tagline).
  const stackedObservedBrand = recoverStackedBrandLinesFromWebsite(
    result,
    emails,
    rawText
  );
  if (stackedObservedBrand) return sanitizeCompanyValue(stackedObservedBrand);
  const brandPart = stripLegalFormSuffix(result).trim() || result;
  const legalInValue = result.match(
    /\b(S\.?\s*R\.?\s*L\.?\.?|S\.?\s*P\.?\s*A\.?\.?|S\.?\s*N\.?\s*C\.?\.?|S\.?\s*A\.?\s*S\.?\.?)\b/i
  )?.[0];
  const legal =
    legalInValue ? normalizeLegalFormToken(legalInValue) : extractNearbyLegalForm(rawText, result);

  const domainRoot = emailDomain ? normalizeBrandKey(splitFusedDomainRoot(emailDomain.split('.')[0] ?? '')) : '';
  const brandKey = normalizeBrandKey(brandPart);
  const hostRoot = emailDomain ? splitFusedDomainRoot(emailDomain.split('.')[0] ?? '') : '';

  // Un token interamente minuscolo, non corroborato, appiccicato dopo un
  // brand che coincide esattamente con il dominio aziendale e' rumore OCR.
  // La condizione non usa parole note: richiede la coincidenza esatta fra la
  // parte sana gia osservata e il dominio della stessa carta.
  const brandWords = brandPart.split(/\s+/).filter(Boolean);
  const tail = brandWords.at(-1) ?? '';
  const head = brandWords.slice(0, -1).join(' ');
  const emailRootKey = normalizeBrandKey(emailDomain?.split('.')[0] ?? '');
  if (
    brandWords.length >= 2 &&
    /^[a-zà-ÿ][a-zà-ÿ'’-]{2,}$/i.test(tail) &&
    tail === tail.toLowerCase() &&
    /[A-Z0-9]/.test(head) &&
    normalizeBrandKey(head) === emailRootKey &&
    emailRootKey.length >= 5
  ) {
    return legal ? `${head} ${legal}` : head;
  }

  // I domini aziendali usano spesso un suffisso locale (es. corium-mi.it).
  // Se il marchio OCR e gia osservato integralmente, quel suffisso non e una
  // lettera mancante e non deve venire appiccicato al nome dell'azienda.
  const hostKey = normalizeBrandKey(hostRoot);
  // Caso inverso: l'OCR ha gia incollato un suffisso geografico del dominio
  // al brand (CORIUMMI da corium-mi.it). Se il dominio osservato e un prefisso
  // netto del brand e resta solo una sigla breve, si mantiene il brand del
  // dominio senza trascinare il suffisso nella ragione sociale.
  const appendedGeographicSuffix = brandKey.startsWith(hostKey)
    ? brandKey.slice(hostKey.length)
    : '';
  if (hostKey.length >= 4 && /^[a-z]{2,3}$/.test(appendedGeographicSuffix)) {
    const recovered = hostRoot.trim();
    return legal ? `${recovered} ${legal}` : recovered;
  }
  const geographicSuffix = hostKey.startsWith(brandKey)
    ? hostKey.slice(brandKey.length)
    : '';
  if (brandKey.length >= 4 && /^[a-z]{2,3}$/.test(geographicSuffix)) {
    return legal && !hasLegalFormSuffix(result)
      ? `${brandPart} ${legal}`
      : preserveIfUnchanged(company, sanitizeCompanyValue(result));
  }

  const observedSpacedBrand = recoverObservedWordBoundaries(
    brandPart,
    hostRoot,
    rawText
  );
  if (observedSpacedBrand) {
    const fixed = legal ? `${observedSpacedBrand} ${legal}` : observedSpacedBrand;
    return sanitizeCompanyValue(fixed);
  }

  if (domainRoot && brandKey && brandKeysAlign(brandKey, domainRoot)) {
    const brandWord = brandPart.split(/\s+/).filter(Boolean)[0] ?? brandPart;
    if (hostRoot) {
      for (const variant of domainBrandRootVariants(hostRoot)) {
        const vk = normalizeBrandKey(variant);
        if (vk === brandKey || levenshteinDistance(brandKey, vk) > 2) continue;
        const respelled = respellTokenFromDomainRoot(brandWord, variant);
        if (normalizeBrandKey(respelled) !== normalizeBrandKey(brandWord)) {
          const brandTail = brandPart.slice(brandWord.length);
          const observedBrand = `${respelled}${brandTail}`.trim();
          const fixed = legal ? `${observedBrand} ${legal}` : observedBrand;
          return sanitizeCompanyValue(fixed);
        }
      }
    }
    if (brandKey !== domainRoot && hostRoot) {
      const respelled = respellTokenFromDomainRoot(brandWord, hostRoot);
      if (normalizeBrandKey(respelled) !== normalizeBrandKey(brandWord)) {
        const brandTail = brandPart.slice(brandWord.length);
        const observedBrand = `${respelled}${brandTail}`.trim();
        const fixed = legal ? `${observedBrand} ${legal}` : observedBrand;
        return sanitizeCompanyValue(fixed);
      }
    }
    return legal && !hasLegalFormSuffix(result)
      ? `${brandPart} ${legal}`
      : preserveIfUnchanged(company, sanitizeCompanyValue(result));
  }

  if (domainRoot && brandKey && hostRoot && fuzzyCompanyDomainDistance(brandPart, hostRoot) <= 2) {
    const brandWord = brandPart.split(/\s+/).filter(Boolean)[0] ?? brandPart;
    const respelled = respellTokenFromDomainRoot(brandWord, hostRoot);
    if (normalizeBrandKey(respelled) !== normalizeBrandKey(brandWord)) {
      const brandTail = brandPart.slice(brandWord.length);
      const observedBrand = `${respelled}${brandTail}`.trim();
      const fixed = legal ? `${observedBrand} ${legal}` : observedBrand;
      return sanitizeCompanyValue(fixed);
    }
  }

  // Un token logo maiuscolo, privo di forma giuridica e senza altro riscontro
  // non prevale su due mailbox aziendali della stessa carta che attestano il
  // medesimo dominio. Regola stretta: non interviene sulle ragioni sociali
  // osservate, sulle sigle puntate o con una sola mailbox.
  const emailsOnPrimaryDomain = emailDomain
    ? emails.filter((email) => email.toLowerCase().endsWith(`@${emailDomain}`))
    : [];
  const exactRawCompanyLines = (rawText ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() === company.trim()).length;
  const uncorroboratedUppercaseToken =
    !legal &&
    /^[A-ZÀ-Ü]{7,}$/.test(result) &&
    !hasLegalFormSuffix(result) &&
    exactRawCompanyLines === 1;
  if (
    uncorroboratedUppercaseToken &&
    emailsOnPrimaryDomain.length >= 2 &&
    domainRoot.length >= 5 &&
    !brandKeysAlign(brandKey, domainRoot)
  ) {
    return formatBrandFromEmailDomainRoot(emailDomain!.split('.')[0] ?? '');
  }

  const alignedBrand =
    pickAlignedBrandFromEmails(brandPart, emails) ??
    (emailDomain && shouldAlignBrandToDomain(brandPart, emailDomain, emails)
      ? formatBrandFromEmailDomainRoot(emailDomain.split('.')[0] ?? '')
      : null);

  if (alignedBrand) {
    result = legal ? `${alignedBrand} ${legal}` : alignedBrand;
  } else if (legal && !hasLegalFormSuffix(result)) {
    result = `${brandPart} ${legal}`;
  }

  return preserveIfUnchanged(company, sanitizeCompanyValue(result));
}

function titleCaseWords(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const connector = w.match(/^&([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]*)$/);
      if (connector?.[1]) {
        return `& ${connector[1].charAt(0).toUpperCase()}${connector[1].slice(1).toLowerCase()}`;
      }
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

function pickBrandLineFromRaw(lines: string[], domainRoot: string): string | null {
  if (!domainRoot || domainRoot.length < 3) return null;
  for (const line of lines) {
    const key = normalizeBrandKey(line);
    if (key.length >= 3 && brandKeysAlign(key, domainRoot) && !isRejectedCompanyValue(line)) {
      if (isLegalFormOnlyCompany(line)) continue;
      return titleCaseWords(line.trim());
    }
  }
  return null;
}

const GENERIC_BUSINESS_CATEGORY_WORDS = new Set([
  'carrozzeria',
  'officina',
  'pasticceria',
  'gelateria',
  'panetteria',
  'ferramenta',
  'edilizia',
  'falegnameria',
  'imbottitura',
  'tappezzeria',
  'autolavaggio',
  'elettrauto',
]);

/** Categoria attività (Carrozzeria) — non ragione sociale da sola. */
export function isGenericBusinessCategoryWord(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length !== 1) return false;
  const key = normalizeBrandKey(words[0]!);
  return GENERIC_BUSINESS_CATEGORY_WORDS.has(key);
}

/** Token dominio-like senza @: non company né indirizzo. */
export function isOcrFusedEmailLikeLine(text: string): boolean {
  const t = text.trim().replace(/\s+/g, '');
  if (!t || t.includes('@')) return false;
  if (/^(?:https?:\/\/|www\.)/i.test(t)) return false;
  if (hasTerminalLegalFormSuffix(text)) return false;
  return /^[a-z]{4,}[a-z0-9-]*\.[a-z]{2,6}$/i.test(t);
}

const PRODUCT_CATEGORY_WORDS_RE =
  /\b(?:motorbike|motor\s*bike|gloves?|garments?|boots?|helmets?|tyres?|tires?|jackets?)\b/i;

/** Tagline prodotto sotto il logo (MOTORBIKE GLOVES) — non ragione sociale. */
export function isProductCategoryTagline(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 52) return false;
  if (!PRODUCT_CATEGORY_WORDS_RE.test(t)) return false;
  if (/\b(?:industries|industry|brothers|bros|holdings?|ltd|llc|gmbh|srl|spa|company|corp|corporation)\b/i.test(t)) {
    return false;
  }
  const words = t.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4;
}

const GENERIC_TAGLINE_COMPANY = new Set([
  'incubatore',
  'imprese',
  'innovative',
  'innovazione',
  'politecnico',
  'formazione',
  'startup',
  'accelerator',
  'acceleratore',
  'technology',
  'tech',
  'digital',
  'consulting',
  'consulenza',
  'services',
  'servizi',
  'solutions',
  'soluzioni',
  'center',
  'centre',
  'centro',
]);

function isGenericTaglineCompany(company: string): boolean {
  const words = company
    .trim()
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-zà-ü0-9]/gi, ''))
    .filter(Boolean);
  if (!words.length || words.length > 4) return false;
  return words.every((w) => GENERIC_TAGLINE_COMPANY.has(w));
}

/** Ragione sociale con forma giuridica allineata al dominio email (es. I3P S.c.p.a.). */
export function pickLegalEntityMatchingEmailDomain(
  rawText: string,
  emails: string[] = []
): string | null {
  if (!rawText?.trim()) return null;
  const domain = getPrimaryBusinessEmailDomain(emails);
  if (!domain) return null;
  const domainRoot = normalizeBrandKey(splitFusedDomainRoot(domain.split('.')[0] ?? ''));
  if (!domainRoot || domainRoot.length < 2) return null;

  for (const line of rawText.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (!hasLegalFormSuffix(line)) continue;
    const beforeAddr =
      line.split(/\b(?:via|viale|corso|piazza|vicolo|largo|str\.?)\b/i)[0]?.trim() ?? line;
    const brandPart = stripLegalFormSuffix(beforeAddr).trim();
    const brandKey = normalizeBrandKey(brandPart.split(/\s+/)[0] ?? brandPart);
    if (!brandKey) continue;
    if (!brandKeysAlign(brandKey, domainRoot) && !brandKeysAlign(normalizeBrandKey(brandPart), domainRoot)) {
      continue;
    }
    const cleaned = sanitizeCompanyValue(beforeAddr);
    if (cleaned && !isRejectedCompanyValue(cleaned)) return cleaned;
  }
  return null;
}

/** Company field è un nome persona — estrae persona e brand da sito/dominio. */
export function splitPersonNameFromCompanyValue(
  company: string,
  emails: string[] = [],
  rawText?: string
): { firstName: string; lastName: string; company: string } | null {
  const parsed = parsePersonNameFromLine(company);
  if (!parsed?.firstName || !parsed?.lastName) return null;
  if (hasLegalFormSuffix(company)) return null;
  if (INSTITUTIONAL_HEADER_RE.test(company)) return null;
  if (/\b(?:university|college)\b/i.test(company)) return null;

  const lines = rawText?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
  const legal = rawText ? pickLegalEntityMatchingEmailDomain(rawText, emails) : null;
  if (legal) {
    return { firstName: parsed.firstName, lastName: parsed.lastName, company: legal };
  }

  const headerBrand = rawText ? recoverOcrHeaderBrand(rawText, emails) : null;
  if (headerBrand && normalizeBrandKey(headerBrand) !== normalizeBrandKey(parsed.lastName)) {
    return { firstName: parsed.firstName, lastName: parsed.lastName, company: headerBrand };
  }

  const domain = getPrimaryBusinessEmailDomain(emails);
  if (domain) {
    const root = splitFusedDomainRoot(domain.split('.')[0] ?? '');
    const brand = formatBrandLabelFromKey(normalizeBrandKey(root));
    if (brand && normalizeBrandKey(brand) !== normalizeBrandKey(parsed.lastName)) {
      return { firstName: parsed.firstName, lastName: parsed.lastName, company: brand };
    }
  }

  const webMatch = rawText?.match(
    /(?:https?:\/\/|www\.)?([a-z0-9][a-z0-9.-]*\.(?:it|com|net|org|eu|pk|de|fr|uk))\b/i
  );
  const webRoot = webMatch?.[1]?.split('.')[0] ?? '';
  if (webRoot && !isNonBusinessEmailDomain(webMatch?.[1] ?? '')) {
    const brand = formatBrandLabelFromKey(normalizeBrandKey(webRoot));
    if (brand && normalizeBrandKey(brand) !== normalizeBrandKey(parsed.lastName)) {
      return { firstName: parsed.firstName, lastName: parsed.lastName, company: brand };
    }
  }

  return null;
}

/** Email su dominio hosting (cyber.net, …): preferisce marchio OCR rispetto al dominio. */
export function recoverBrandWhenHostingEmail(
  company: string,
  emails: string[] = [],
  rawText?: string
): string | null {
  if (!rawText?.trim()) return null;
  const usesHosting = emails.some((e) => isNonBusinessEmailDomain(e.split('@')[1] ?? ''));
  if (!usesHosting) return null;

  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const compKey = normalizeBrandKey(stripLegalFormSuffix(company));
  const personKeys = new Set(
    emails
      .flatMap((email) => (email.split('@')[0] ?? '').split(/[._\-+]+/))
      .map((part) => normalizeBrandKey(normalizeEmailLocalBrandPart(part)))
      .filter((part) => part.length >= 4)
  );

  let best: { candidate: string; score: number } | null = null;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i];
    if (line.length < 3 || line.length > 40) continue;
    if (/@|www\.|https?:|tel|fax|\broad\b|\bstreet\b/i.test(line)) continue;
    if (ROLE_KEYWORD_REGEX.test(line)) continue;
    if (parsePersonNameFromLine(line)) continue;
    const key = normalizeBrandKey(line);
    if (!key || key.length < 3 || key === compKey) continue;
    if (GENERIC_OCR_BRAND_SKIP.has(key)) continue;
    if (personKeys.has(key) && !/^[A-ZÀ-Ü]{3,8}$/.test(line)) continue;

    const looksLikeBrand =
      /^[A-ZÀ-Ü]{3,10}$/.test(line) ||
      (/^[A-ZÀ-Ü][A-ZÀ-Üa-z0-9&.-]{2,}$/.test(line) && line.split(/\s+/).length <= 3);
    if (!looksLikeBrand) continue;

    let candidate = normalizeOcrBrandValue(line, emails) ?? titleCaseWords(line);
    candidate = sanitizeCompanyValue(candidate);
    if (!candidate || isRejectedCompanyValue(candidate)) continue;

    const score = scoreOcrHeaderBrandCandidate(candidate, emails) + (10 - i) * 0.05;
    if (!best || score > best.score) best = { candidate, score };
  }

  if (best && best.score > 0) return best.candidate;
  return recoverOcrHeaderBrand(rawText, emails);
}

/**
 * Dominio composto + company parziale: recupera la riga OCR completa.
 */
export function recoverFullBrandLineFromOcr(
  company: string,
  emails: string[] = [],
  rawText?: string
): string | null {
  if (!company?.trim() || !rawText?.trim()) return null;
  const domain = getPrimaryBusinessEmailDomain(emails);
  if (!domain) return null;
  const hostRoot = domain.split('.')[0] ?? '';
  if (!hostRoot.includes('-')) return null;
  const fullKey = normalizeBrandKey(hostRoot);
  const compKey = normalizeBrandKey(stripLegalFormSuffix(company));
  if (!compKey || compKey.length < 3) return null;
  if (!brandKeysAlign(compKey, fullKey) || fullKey.length <= compKey.length + 2) return null;

  const lines = rawText.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line || line.length < 4 || line.length > 48) continue;
    if (/@|www\.|https?:\/\//i.test(line)) continue;
    if (ROLE_KEYWORD_REGEX.test(line)) continue;
    if (/\b(?:via|viale|piazza|corso|street|road|mobile|email)\b/i.test(line)) continue;
    const lineKey = normalizeBrandKey(line);
    if (!lineKey || lineKey.length < fullKey.length) continue;
    if (lineKey !== fullKey && !brandKeysAlign(lineKey, fullKey)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 4) continue;
    if (!words.every((w) => /^[A-Za-z&'.-]+$/.test(w))) continue;
    return words
      .map((w) => (/^[A-Z]{2,}$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join(' ');
  }
  return null;
}

/**
 * Categoria + nome marchio su righe adiacenti (CARROZZERIA + CRISTALLO) o suffisso nel dominio sito.
 */
export function recoverCompoundBrandFromAdjacentOcrLines(
  company: string,
  emails: string[] = [],
  rawText?: string
): string | null {
  if (!company?.trim() || !rawText?.trim()) return null;
  if (!isGenericBusinessCategoryWord(company)) return null;

  const compKey = normalizeBrandKey(company);
  const domain =
    getOrganizationHintDomain(emails, rawText) || getPrimaryBusinessEmailDomain(emails) || '';
  const domainKey = normalizeBrandKey(splitFusedDomainRoot(domain.split('.')[0] ?? ''));
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length - 1; i++) {
    const aKey = normalizeBrandKey(lines[i]!);
    const bKey = normalizeBrandKey(lines[i + 1]!);
    if (aKey.length < 4 || bKey.length < 4) continue;
    if (/@|www\.|https?:|tel|fax|\bvia\b/i.test(lines[i]!) || /@|www\.|https?:|tel|fax|\bvia\b/i.test(lines[i + 1]!)) {
      continue;
    }
    if (parsePersonNameFromLine(lines[i]!) || parsePersonNameFromLine(lines[i + 1]!)) continue;
    const combined = `${lines[i]} ${lines[i + 1]}`;
    const combinedKey = normalizeBrandKey(combined);
    if (domainKey && combinedKey.length >= 8 && domainKey.includes(combinedKey)) {
      return titleCaseWords(combined);
    }
    if (domainKey && domainKey.startsWith(aKey) && domainKey.startsWith(aKey + bKey)) {
      return titleCaseWords(combined);
    }
    if (isGenericBusinessCategoryWord(lines[i]!) && bKey.length >= 4) {
      return titleCaseWords(combined);
    }
  }

  if (!isGenericBusinessCategoryWord(company)) return null;

  for (let i = 0; i < lines.length - 1; i++) {
    if (normalizeBrandKey(lines[i]!) !== compKey) continue;
    const next = lines[i + 1]!;
    if (!next || next.length > 28 || /@|www\.|https?:|tel|fax|\bvia\b/i.test(next)) continue;
    if (parsePersonNameFromLine(next)) continue;
    const combined = `${lines[i]} ${next}`;
    const combinedKey = normalizeBrandKey(combined);
    if (domainKey && (combinedKey.length >= 5 && domainKey.includes(combinedKey))) {
      return titleCaseWords(combined);
    }
    if (domainKey && domainKey.startsWith(compKey) && normalizeBrandKey(next).length >= 4) {
      return titleCaseWords(combined);
    }
  }

  if (domainKey && domainKey.length > compKey.length + 3 && domainKey.startsWith(compKey)) {
    const suffixKey = domainKey.slice(compKey.length);
    if (suffixKey.length >= 4) {
      const suffix =
        suffixKey.charAt(0).toUpperCase() + suffixKey.slice(1).toLowerCase();
      return `${titleCaseWords(company.trim())} ${suffix}`;
    }
  }

  return null;
}

/** Due righe brand impilate (CARROZZERIA/CRISTALLO) coerenti col dominio sito. */
export function recoverStackedBrandLinesFromWebsite(
  company: string,
  emails: string[] = [],
  rawText?: string
): string | null {
  if (!rawText?.trim()) return null;
  const domain =
    getOrganizationHintDomain(emails, rawText) || getPrimaryBusinessEmailDomain(emails) || '';
  const domainKey = normalizeBrandKey(splitFusedDomainRoot(domain.split('.')[0] ?? ''));
  if (!domainKey || domainKey.length < 8) return null;

  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    const aKey = normalizeBrandKey(lines[i]!);
    const bKey = normalizeBrandKey(lines[i + 1]!);
    if (aKey.length < 4 || bKey.length < 4) continue;
    if (/@|www\.|https?:|tel|fax|\bvia\b/i.test(lines[i]!) || /@|www\.|https?:|tel|fax|\bvia\b/i.test(lines[i + 1]!)) {
      continue;
    }
    const combinedKey = normalizeBrandKey(`${lines[i]} ${lines[i + 1]}`);

    // P0 CARROZZERIA REAL bounded stacked repair: sito realmente osservato, una meta esatta e
    // l'altra con massimo 2 errori OCR. Nessun token inventato fuori dominio.
    if (combinedKey.length >= 8 && Math.abs(domainKey.length - combinedKey.length) <= 2) {
      if (domainKey.endsWith(bKey) && domainKey.length > bKey.length) {
        const firstFromDomain = domainKey.slice(0, domainKey.length - bKey.length);
        if (
          firstFromDomain.length >= 4 &&
          levenshteinDistance(firstFromDomain, aKey) <= 2
        ) {
          return titleCaseWords(`${firstFromDomain} ${lines[i + 1]}`);
        }
      }
      if (domainKey.startsWith(aKey) && domainKey.length > aKey.length) {
        const secondFromDomain = domainKey.slice(aKey.length);
        if (
          secondFromDomain.length >= 4 &&
          levenshteinDistance(secondFromDomain, bKey) <= 2
        ) {
          return titleCaseWords(`${lines[i]} ${secondFromDomain}`);
        }
      }
    }

    if (parsePersonNameFromLine(lines[i]!) || parsePersonNameFromLine(lines[i + 1]!)) continue;
    if (domainKey.includes(combinedKey) || combinedKey.length >= 8 && domainKey.startsWith(aKey + bKey)) {
      return titleCaseWords(`${lines[i]} ${lines[i + 1]}`);
    }
  }
  return null;
}

/** Company = solo dominio ma l'OCR contiene una ragione sociale completa. */
export function recoverRegisteredCompanyNameFromOcr(
  company: string,
  emails: string[] = [],
  rawText?: string
): string | null {
  if (!company?.trim() || !rawText?.trim()) return null;
  const domain = getPrimaryBusinessEmailDomain(emails);
  if (!domain) return null;
  const compKey = normalizeBrandKey(stripLegalFormSuffix(company));
  const domainKey = normalizeBrandKey(domain.split('.')[0] ?? '');
  if (!compKey || !domainKey || !brandKeysAlign(compKey, domainKey)) return null;

  let best: { line: string; score: number } | null = null;
  for (const line of rawText.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (!line || line.length < 8 || line.length > 72) continue;
    if (/@|www\.|https?:\/\//i.test(line)) continue;
    if (isProductCategoryTagline(line)) continue;
    if (ROLE_KEYWORD_REGEX.test(line)) continue;
    if (!/\b(?:industries|industry|brothers|bros|ltd|llc|gmbh|srl|spa|corporation|company)\b/i.test(line)) {
      continue;
    }
    let score = 0;
    if (/\bindustries\b/i.test(line)) score += 3;
    if (/\bbrothers\b/i.test(line)) score += 2;
    score += Math.min(line.split(/\s+/).filter(Boolean).length, 5);
    if (!best || score > best.score) best = { line, score };
  }
  return best?.line ?? null;
}

function pickCardBrandOverEmailDomain(lines: string[], company: string, emails: string[]): string | null {
  const domain = getPrimaryBusinessEmailDomain(emails);
  const domainRoot = normalizeBrandKey(domain?.split('.')[0] ?? '');
  const compKey = normalizeBrandKey(stripLegalFormSuffix(company));
  if (!domainRoot || !compKey || !brandKeysAlign(compKey, domainRoot)) return null;

  const brandPart = stripLegalFormSuffix(company).trim();
  if (
    compKey === domainRoot &&
    /^[A-Z][a-zA-Z0-9&.-]{3,}$/.test(brandPart) &&
    brandPart !== brandPart.toUpperCase()
  ) {
    return null;
  }

  const personKeysFromEmail = new Set(
    emails
      .flatMap((email) => (email.split('@')[0] ?? '').split(/[._\-+]+/))
      .map((part) => normalizeBrandKey(normalizeEmailLocalBrandPart(part)))
      .filter((part) => part.length >= 4)
  );

  for (const line of lines) {
    const t = line.trim();
    if (!t || t.length < 4 || t.length > 48) continue;
    if (/@|www\.|https?:\/\//i.test(t)) continue;
    if (ROLE_KEYWORD_REGEX.test(t)) continue;
    if (isItalianCityName(t)) continue;
    if (/\b(?:italy|italia|germany|france|belgium|pakistan|spain|uk|usa)\b/i.test(t)) continue;
    if (/\d{5}/.test(t)) continue;
    if (/\b(?:via|viale|corso|piazza|street|road)\b/i.test(t)) continue;
    if (isClaimLikeTerminalLegalPhrase(t)) continue;
    if (parsePersonNameFromLine(t)) continue;
    const key = normalizeBrandKey(t);
    if (!key || key.length < 4 || brandKeysAlign(key, domainRoot)) continue;
    if (personKeysFromEmail.has(key) && parsePersonNameFromLine(t)) continue;
    if (/^[A-ZÀ-Ü][A-ZÀ-Ü\s&.-]{3,}$/.test(t) && !hasTerminalLegalFormSuffix(t)) {
      return titleCaseWords(t);
    }
  }
  return null;
}

const ROLE_AS_COMPANY_RE =
  /^(?:rapporti\s+istituzionali|gestionale|responsabile|direttore|delegato|partner|commercial|marketing|amministr|ufficio|dirigente)\b/i;

/** Ruolo isolato (Dirigente, Partner, …) scelto come company. */
function isIsolatedRoleCompanyLabel(company: string): boolean {
  const t = sanitizeCompanyValue(company);
  if (!t || hasLegalFormSuffix(t)) return false;
  if (/^(?:dirigente|partner|delegato|presidente|titolare)$/i.test(t)) return true;
  if (ROLE_KEYWORD_REGEX.test(t) && t.split(/\s+/).filter(Boolean).length <= 3) return true;
  return false;
}

const GENERIC_OCR_BRAND_SKIP = new Set([
  'group',
  'holding',
  'company',
  'click',
  'italia',
  'italy',
  'consulting',
  'consulenza',
  'servizi',
  'services',
  'net',
  'partner',
  'solutions',
  'italia',
  'management',
  'international',
  'gmbh',
  'srl',
  'sports',
  'sport',
]);

function scoreOcrHeaderBrandCandidate(line: string, emails: string[] = []): number {
  const key = normalizeBrandKey(line);
  if (!key || key.length < 3) return -10;
  if (GENERIC_OCR_BRAND_SKIP.has(key)) return -8;
  if (ROLE_AS_COMPANY_RE.test(line)) return -8;

  const domain = getPrimaryBusinessEmailDomain(emails);
  const domainKey = domain
    ? normalizeBrandKey(splitFusedDomainRoot(domain.split('.')[0] ?? ''))
    : '';
  const localOnlyKeys = new Set<string>();
  for (const email of emails) {
    for (const part of (email.split('@')[0] ?? '').split(/[._\-+]+/)) {
      const key = normalizeBrandKey(normalizeEmailLocalBrandPart(part));
      if (key.length >= 4) localOnlyKeys.add(key);
    }
  }
  if (domainKey && localOnlyKeys.has(key) && key !== domainKey) return -6;

  let score = 0;
  if (domainKey && brandKeysAlign(key, domainKey)) score += 5;
  if (/^[A-Z][a-z][A-Za-z0-9&]{2,}$/.test(line.trim())) score += 2;
  if (/^[A-ZÀ-Ü]{4,}$/.test(line.trim()) && !GENERIC_OCR_BRAND_SKIP.has(key)) score += 1;
  if (line.length >= 4 && line.length <= 20) score += 0.5;
  return score;
}

export function shouldPreferEmailBrandOverCompany(
  company: string,
  emails: string[] = [],
  rawText?: string
): boolean {
  if (!company?.trim()) return Boolean(resolveBrandFromEmailDomain(emails));
  if (hasTerminalLegalFormSuffix(company)) return false;
  if (/\b(?:studio\s+legale|avvocat|notai|commercialist)\b/i.test(company)) return false;
  if (hasOcrBrandNoise(company)) return true;
  const domain = getPrimaryBusinessEmailDomain(emails);
  if (!domain || isNonBusinessEmailDomain(domain)) return false;
  const domainKey = normalizeBrandKey(splitFusedDomainRoot(domain.split('.')[0] ?? ''));
  const compKey = normalizeBrandKey(stripLegalFormSuffix(company));
  if (!domainKey || !compKey) return false;
  if (
    rawText &&
    compKey !== domainKey &&
    rawText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(?:e|è)\s+\S+/iu.test(line))
      .some((line) => {
        const normalized = normalizeOcrBrandValue(line, emails);
        return Boolean(
          normalized &&
          normalizeBrandKey(stripLegalFormSuffix(normalized)) === domainKey
        );
      })
  ) {
    return true;
  }
  if (brandKeysAlign(compKey, domainKey)) return false;
  if (isGenericTaglineCompany(company)) return true;
  if (GENERIC_OCR_BRAND_SKIP.has(compKey)) return true;
  if (rawText && pickCardBrandOverEmailDomain(rawText.split('\n').map((l) => l.trim()).filter(Boolean), company, emails)) {
    return false;
  }
  if (rawText) {
    for (const line of rawText.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (normalizeBrandKey(line) === compKey && line.length <= 12 && /^[A-Z]{2,8}$/.test(line)) {
        return false;
      }
    }
  }
  if (isRejectedCompanyValue(company)) return true;
  return false;
}

function getOrganizationHintDomain(emails: string[] = [], rawText?: string): string {
  for (const email of emails) {
    if (!validateEmail(email)) continue;
    const domain = email.split('@')[1]?.toLowerCase().trim();
    if (domain && !isGenericProviderDomain(domain)) return domain;
  }

  // P0 DOMAIN HINT SCAN ALL HOSTS
  // Non fermarsi al primo hostname presente nel raw OCR: puo essere il dominio
  // di una mailbox generica (es. provider consumer) che precede il vero sito
  // aziendale sulla stessa riga. Scorri tutti gli host osservati e scegli il
  // primo non-generico, senza inventare alcun dominio.
  const text = rawText ?? '';
  const webRe =
    /(?:https?:\/\/|www\.)?([a-z0-9][a-z0-9.-]*\.(?:it|com|net|org|eu|pk|de|fr|uk))\b/gi;

  for (const match of text.matchAll(webRe)) {
    const webHost = match[1]?.toLowerCase();
    if (!webHost) continue;
    if (isGenericProviderDomain(webHost)) continue;
    return webHost;
  }

  return '';
}

const INSTITUTIONAL_HEADER_RE =
  /\b(?:istituto|universit[aà]|university|college|ospedale|ministero|agenzia|fondazione|consorzio|scuola|polutecnico|politecnico|school\s+of\s+management|cameral|regione|provincia|comune|federazione|associazione|laboratorio|ente\s+pubblico|studio\s+(?:legale|notarile|tecnico|commerciale)|commercialisti\s+associati|avvocati\s+associati)\b/i;

function domainTokensOverlapLine(domainRoot: string, lineKey: string): boolean {
  if (!domainRoot || !lineKey) return false;
  return brandKeysAlign(domainRoot, lineKey);
}

/**
 * Recupera organizzazione da intestazioni OCR con evidenze concordanti
 * (dominio email, sito, lessico istituzionale) — niente hardcode per ente.
 */
export function pickOrganizationHeaderFromEvidence(
  rawText: string,
  emails: string[] = []
): string | null {
  if (!rawText?.trim()) return null;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const domain = getOrganizationHintDomain(emails, rawText) || getPrimaryBusinessEmailDomain(emails) || '';
  const domainRoot = normalizeBrandKey(splitFusedDomainRoot(domain.split('.')[0] ?? ''));
  const webMatch = rawText.match(/(?:https?:\/\/|www\.)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i);
  const webRoot = normalizeBrandKey(splitFusedDomainRoot(webMatch?.[1]?.split('.')[0] ?? ''));

  let best: { line: string; score: number } | null = null;
  for (const line of lines) {
    const hasShorterObservedCopularPrefix = lines.some((other) => {
      const shorter = other.trim();
      if (!shorter || shorter === line || shorter.length >= line.length) return false;
      if (!line.toLowerCase().startsWith(shorter.toLowerCase())) return false;
      const tail = line.slice(shorter.length).trim();
      return /^(?:\u00e8|e['\u2019]|is|are)\b/i.test(tail);
    });
    if (hasShorterObservedCopularPrefix) continue;
    if (line.length < 10 || line.length > 96) continue;
    if (/@|\btel\b|\bfax\b|\be-?mail\b/i.test(line)) continue;
    if (ROLE_AS_COMPANY_RE.test(line) && !hasTerminalLegalFormSuffix(line)) continue;
    if (isClaimLikeTerminalLegalPhrase(line)) continue;

    let evidence = 0;
    let score = 0;
    const lineKey = normalizeBrandKey(stripLegalFormSuffix(line));
    if (INSTITUTIONAL_HEADER_RE.test(line)) {
      evidence += 1;
      score += 2.5;
    }
    if (hasTerminalLegalFormSuffix(line)) {
      evidence += 1;
      score += 2;
    }
    if (domainRoot && domainTokensOverlapLine(domainRoot, lineKey)) {
      evidence += 1;
      score += 2;
    }
    if (webRoot && webRoot.length >= 3 && domainTokensOverlapLine(webRoot, lineKey)) {
      evidence += 1;
      score += 1.5;
    }
    if (evidence < 1 || score < 2) continue;

    const cleaned = sanitizeCompanyValue(line);
    if (!cleaned || isRejectedCompanyValue(cleaned) || isDomainOnlyCompanyValue(cleaned, emails, rawText)) {
      continue;
    }
    if (!best || score > best.score) best = { line: cleaned, score };
  }
  if (best?.line) {
    return best.line;
  }
  return null;
}

/**
 * Preferisce ragione sociale OCR rispetto a brand/dominio/ruolo/forma giuridica sola.
 */
export function resolveOrganizationFromOcr(
  company: string,
  emails: string[] = [],
  rawText?: string
): string | null {
  if (!company?.trim() || !rawText?.trim()) return null;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);
  const domain = getOrganizationHintDomain(emails, rawText) || getPrimaryBusinessEmailDomain(emails) || '';
  const domainRoot = normalizeBrandKey(domain.split('.')[0] ?? '');
  const webMatch = rawText.match(/(?:https?:\/\/|www\.)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i);
  const webRoot = normalizeBrandKey(splitFusedDomainRoot(webMatch?.[1]?.split('.')[0] ?? ''));
  const compKey = normalizeBrandKey(stripLegalFormSuffix(company));

  const stackedBrand = recoverStackedBrandLinesFromWebsite(company, emails, rawText);
  if (stackedBrand) return stackedBrand;

  const domainBrandKey = normalizeBrandKey(splitFusedDomainRoot(domain.split('.')[0] ?? ''));
  if (isGenericTaglineCompany(company)) {
    const legal = pickLegalEntityMatchingEmailDomain(rawText, emails);
    if (legal) return legal;
  }

  if (hasOcrBrandNoise(company) || isGenericBusinessCategoryWord(company)) {
    const compound = recoverCompoundBrandFromAdjacentOcrLines(company, emails, rawText);
    if (compound) return compound;
    const domainBrand = resolveBrandFromEmailDomain(emails);
    if (domainBrand && normalizeBrandKey(domainBrand) !== normalizeBrandKey(company)) {
      return domainBrand;
    }
  }

  const fragmentedWords = company.trim().split(/\s+/).filter(Boolean);
  if (
    fragmentedWords.length === 2 &&
    fragmentedWords[0]!.length <= 3 &&
    resolveBrandFromEmailDomain(emails)
  ) {
    const domainBrand = resolveBrandFromEmailDomain(emails);
    if (domainBrand && normalizeBrandKey(domainBrand).includes(normalizeBrandKey(fragmentedWords.join('')))) {
      return domainBrand;
    }
  }

  if (
    compKey.length <= 8 &&
    company.trim().split(/\s+/).length === 1 &&
    !hasLegalFormSuffix(company)
  ) {
    const headerOrg = pickOrganizationHeaderFromEvidence(rawText, emails);
    if (headerOrg && normalizeBrandKey(headerOrg) !== compKey) return headerOrg;
    for (const line of lines.slice(0, 12)) {
      if (line.length < 8 || line.length > 48) continue;
      if (/@|www\.|https?:|tel|fax|\bvia\b/i.test(line)) continue;
      if (isRejectedCompanyValue(line)) continue;
      if (ROLE_KEYWORD_REGEX.test(line) && !hasLegalFormSuffix(line)) continue;
      const words = line.split(/\s+/).filter(Boolean);
      if (words.length < 2 || words.length > 4) continue;
      if (parsePersonNameFromLine(line)) continue;
      if (isGenericBusinessCategoryWord(line)) continue;
      const lineKey = normalizeBrandKey(line);
      if (
        (
          webRoot &&
          webRoot.includes(compKey) &&
          domainTokensOverlapLine(webRoot, lineKey) &&
          lineKey.length > compKey.length + 2
        ) ||
        (
          compKey.length <= 4 &&
          domainTokensOverlapLine(domainRoot || webRoot, lineKey) &&
          lineKey.length > compKey.length + 3
        )
      ) {
        return titleCaseWords(line);
      }
    }
  }

  if (domainRoot && compKey && !brandKeysAlign(compKey, domainRoot)) {
    const localKeys = emails
      .flatMap((email) => (email.split('@')[0] ?? '').split(/[._-]+/))
      .map((part) => normalizeBrandKey(normalizeEmailLocalBrandPart(part)))
      .filter((part) => part.length >= 4);
    if (localKeys.some((part) => part === compKey || compKey.includes(part) || part.includes(compKey))) {
      const domainBrand = pickBrandLineFromRaw(lines, domainRoot);
      if (domainBrand) return domainBrand;
    }
  }

  if (ROLE_AS_COMPANY_RE.test(company.trim()) || isIsolatedRoleCompanyLabel(company)) {
    const headerOrg = pickOrganizationHeaderFromEvidence(rawText, emails);
    if (headerOrg) return headerOrg;
  }

  if (isLegalFormOnlyCompany(company)) {
    const brand = pickBrandLineFromRaw(lines, domainRoot);
    if (brand) {
      const legal = company.trim();
      return `${brand} ${legal.replace(/\s+/g, ' ')}`.trim();
    }
  }

  if (domainRoot && compKey && brandKeysAlign(compKey, domainRoot)) {
    const fullBrand = recoverFullBrandLineFromOcr(company, emails, rawText);
    if (fullBrand) return fullBrand;

    const registered = recoverRegisteredCompanyNameFromOcr(company, emails, rawText);
    if (registered) return registered;

    const headerOrg = pickOrganizationHeaderFromEvidence(rawText, emails);
    if (headerOrg) return headerOrg;

    if (!hasLegalFormSuffix(company)) {
      const cardBrand = pickCardBrandOverEmailDomain(lines, company, emails);
      if (cardBrand) return cardBrand;
    }

    for (const line of lines) {
      if (!hasTerminalLegalFormSuffix(line)) continue;
      if (isClaimLikeTerminalLegalPhrase(line)) continue;
      const cleaned = sanitizeCompanyValue(line);
      if (cleaned && !isRejectedCompanyValue(cleaned) && !isDomainOnlyCompanyValue(cleaned, emails, rawText)) {
        return cleaned;
      }
    }
  }

  if (isDomainOnlyCompanyValue(company, emails, rawText)) {
    const headerOrg = pickOrganizationHeaderFromEvidence(rawText, emails);
    if (headerOrg) return headerOrg;
  }

  return null;
}

/** Company plausibile prima della finalizzazione — non va azzerata senza sostituto più forte. */
export function isPreservableCompanyCandidate(company: string): boolean {
  const t = sanitizeCompanyValue(company);
  if (!t || t.length < 3 || t.length > 72) return false;
  if (isRejectedCompanyValue(t)) return false;
  if (/@|\b(?:tel\.?|fax|e-?mail|skype)\b/i.test(t)) return false;
  if (/\bwww\.|https?:\/\//i.test(t)) return false;
  if (/^\d{5}\b/.test(t)) return false;
  if (/\b(?:via|viale|piazza|corso|vicolo)\b/i.test(t)) return false;
  if (isHostnameOnlyValue(t)) return false;
  if (ROLE_KEYWORD_REGEX.test(t) && !hasTerminalLegalFormSuffix(t)) return false;
  if (isLegalFormOnlyCompany(t)) return false;
  return true;
}

/** Recupera marchio plausibile dalle prime righe OCR (logo in testa al biglietto). */
export function recoverOcrHeaderBrand(rawText: string, emails: string[] = []): string | null {
  if (!rawText?.trim()) return null;
  const lines = rawText.split('\n').map((l) => l.trim()).filter(Boolean);

  let best: { candidate: string; score: number } | null = null;

  for (let i = 0; i < Math.min(8, lines.length); i++) {
    const line = lines[i];
    if (line.length < 4 || line.length > 28) continue;
    if (/@|www\.|https?:\/\/|\btel\.?\b|\bfax\b/i.test(line)) continue;
    if (ROLE_KEYWORD_REGEX.test(line)) continue;
    if (isItalianCityName(line)) continue;
    if (/\b(?:via|viale|corso|piazza|street|road)\b/i.test(line)) continue;
    if (/\d{5}/.test(line)) continue;
    if (parsePersonNameFromLine(line)) continue;

    // La punteggiatura terminale isolata (es. "MOTOTECNICA,") è spesso
    // un artefatto OCR/grafico e non deve impedire il riconoscimento del brand.
    const brandLine = line.replace(/[,:;]+\s*$/, '').trim();
    const toks = brandLine.split(/\s+/).filter(Boolean);
    const isHeaderBrand =
      toks.length === 1 &&
      (/^[A-ZÀ-Ü][A-Za-z0-9&]{2,}$/.test(brandLine) || /^[A-ZÀ-Ü]{4,}$/.test(brandLine));
    const isShortCapsBrand =
      toks.length <= 2 &&
      toks.every((tok) => /^[A-ZÀ-Ü][A-ZÀ-Üa-z0-9&.-]{1,}$/.test(tok)) &&
      !hasTerminalLegalFormSuffix(brandLine);

    if (!isHeaderBrand && !isShortCapsBrand) continue;

    let candidate = normalizeOcrBrandValue(brandLine, emails) ?? brandLine;
    candidate = sanitizeCompanyValue(candidate);
    if (!candidate || isRejectedCompanyValue(candidate)) continue;
    if (isDomainOnlyCompanyValue(candidate, emails, rawText)) continue;

    const score = scoreOcrHeaderBrandCandidate(candidate, emails) - i * 0.15;
    if (!best || score > best.score) best = { candidate, score };
  }

  return best && best.score > 0 ? best.candidate : null;
}

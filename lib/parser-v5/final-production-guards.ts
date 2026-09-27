import type { Phone } from '../../types';
import type { V5AddressParts, V5Field } from './engine';
import {
  hasTerminalLegalFormSuffix,
  normalizeBrandKey,
  stripLegalFormSuffix,
} from '../parser-engine/validators/dictionaries';
import { isProductCategoryTagline } from '../parser-engine/validators/company';
import { isNonBusinessEmailDomain } from '../parser-engine/validators/website';
import { splitFusedDomainBrand } from './company-normalize';

export interface FinalProductionGuardInput {
  rawText: string;
  firstName: V5Field<string>;
  lastName: V5Field<string>;
  company: V5Field<string>;
  emails: string[];
  website: string | null;
  address: V5AddressParts | null;
  phones: Phone[];
  vatNumber: string | null;
  taxCode: string | null;
}

export interface FinalProductionGuardOutput extends FinalProductionGuardInput {
  repairedEmails: string[];
}

const ROLE_TOKEN_RE = /^(?:general|sales|marketing|account|project|product|export|commercial|managing|manager|director|president|partner|owner|officer|responsabile|direttore|amministratore|presidente|titolare|posatore)$/i;
const ACTIVITY_WORD_RE = /\b(?:pavimenti?|rivestimenti?|serramenti?|impianti?|automazioni?|riparazioni?|accessori|ricambi|verniciatura|sabbiatura|consulenza|servizi|soluzioni|produzione|vendita)\b/i;
const INSTITUTION_RE = /\b(?:politecnico|universit[aà]|university|college|istituto|institute|academy|accademia|school)\b/i;
const DEPARTMENT_RE = /\b(?:department|dipartimento|division|unit|ufficio|office|ict|management|marketing|sales|engineering|ingegneria)\b/i;
const STREET_RE = /(?:\b(?:via|viale|piazza|corso|strada|galleria|street|road|rd\.?|avenue|lane|drive|court|p\.?o\.?\s*box)\b|(?:^|\s)s\.s\.\s)/i;

function field<T>(current: V5Field<T>, value: T | null, reason: string, scoreCap = 0.82): V5Field<T> {
  return {
    ...current,
    value,
    score: value == null ? 0 : Math.min(Math.max(current.score, 0.62), scoreCap),
    reasons: [...current.reasons, reason],
    source: 'observed',
  };
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function cap(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/(^|[\s'’.-])\p{L}/gu, (match) => match.toLocaleUpperCase());
}

/** Compact uppercase brand where OCR has read the final `I.` as `LL`. */
function recoverCompactOcrDomainBrand(value: string): string | null {
  const compact = value.replace(/\s+/g, '');
  const doubledL = compact.match(/^([A-Z0-9][A-Z0-9-]{2,})LL(NET|COM|ORG|IT|EU)$/);
  if (doubledL) return `${doubledL[1]}I.${doubledL[2]}`;
  const separated = compact.match(/^([A-Z0-9][A-Z0-9-]{2,})(?:I|L|1)[._-](NET|COM|ORG|IT|EU)$/);
  if (separated) return `${separated[1]}I.${separated[2]}`;
  return null;
}

function levenshtein(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 0; i < left.length; i += 1) {
    let previous = row[0]!;
    row[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const old = row[j + 1]!;
      row[j + 1] = Math.min(
        row[j + 1]! + 1,
        row[j]! + 1,
        previous + (left[i] === right[j] ? 0 : 1),
      );
      previous = old;
    }
  }
  return row.at(-1) ?? left.length;
}

function reconcileEmailLocalWithObservedPerson(
  emails: string[],
  firstName: V5Field<string>,
  lastName: V5Field<string>,
): string[] {
  if (!firstName.value || !lastName.value) return emails;
  const firstKey = normalizeBrandKey(firstName.value);
  const lastKey = normalizeBrandKey(lastName.value);
  return emails.map((email) => {
    const [local = '', host = ''] = email.toLowerCase().split('@');
    const tokens = local.split(/[._+\-]+/).filter(Boolean);
    if (!host || tokens.length !== 2) return email;
    const observedFirst = normalizeBrandKey(tokens[0]!);
    const observedLast = normalizeBrandKey(tokens[1]!);
    if (
      observedFirst === firstKey &&
      observedLast !== lastKey &&
      Math.abs(observedLast.length - lastKey.length) <= 1 &&
      levenshtein(observedLast, lastKey) === 1
    ) {
      return `${firstKey}.${lastKey}@${host}`;
    }
    return email;
  });
}

function recoverConsecutiveLegalCompany(rawText: string, current: string, roots: string[]): string | null {
  const lines = rawText.split(/\r?\n/).map(clean).filter(Boolean);
  const currentKey = normalizeBrandKey(current);
  if (lines.some((line) => hasTerminalLegalFormSuffix(line) && normalizeBrandKey(line) === currentKey)) {
    return null;
  }
  const matchesBusinessRoot = (candidate: string): boolean => {
    const first = stripLegalFormSuffix(candidate).split(/\s+/)[0] ?? '';
    const firstKey = normalizeBrandKey(first).replace(/5/g, 's').replace(/0/g, 'o');
    const ampersandExpandedKey = normalizeBrandKey(first.replace(/&/g, 'e')).replace(/5/g, 's').replace(/0/g, 'o');
    const ampLead = first.match(/^([a-z])&/i)?.[1]?.toLowerCase();
    return roots.some((root) => {
      const rootKey = normalizeBrandKey(root);
      return rootKey === firstKey || rootKey === ampersandExpandedKey ||
        rootKey.startsWith(firstKey) || rootKey.startsWith(ampersandExpandedKey) ||
        firstKey.startsWith(rootKey) || ampersandExpandedKey.startsWith(rootKey) ||
        Boolean(ampLead && rootKey.startsWith(`${ampLead}and`));
    });
  };

  // Prefer an independently observed legal-company line over a parser value
  // polluted by a slogan/header immediately above it.
  const standalone = lines.find((line) => {
    if (line.split(/\s+/).length > 8 || !hasTerminalLegalFormSuffix(line)) return false;
    const lineKey = normalizeBrandKey(line);
    const currentIsDomainDerived = roots.some((root) => {
      const rootKey = normalizeBrandKey(root);
      return rootKey.length >= 3 &&
        (currentKey === rootKey || currentKey === `${rootKey}srl` || currentKey === `${rootKey}spa`);
    });
    const currentContainsBusinessRoot = roots.some((root) => {
      const rootKey = normalizeBrandKey(root);
      return rootKey.length >= 3 && currentKey.includes(rootKey);
    });
    if ((!currentKey.includes(lineKey) && !currentIsDomainDerived && !currentContainsBusinessRoot) || currentKey === lineKey) return false;
    const brand = clean(stripLegalFormSuffix(line));
    const hasIndependentBrand = normalizeBrandKey(brand).length >= 3 && !/^(?:e|and|&)\b/i.test(brand);
    return hasIndependentBrand && (roots.length === 0 || matchesBusinessRoot(line) || currentIsDomainDerived);
  });
  if (standalone) return standalone;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const head = lines[index]!;
    const tail = lines[index + 1]!;
    if (head.split(/\s+/).length > 5 || /@|www\.|https?:|\d{4,}/i.test(head)) continue;
    if (!hasTerminalLegalFormSuffix(tail)) continue;
    const joined = clean(`${head} ${tail}`);
    const joinedKey = normalizeBrandKey(joined);
    const headKey = normalizeBrandKey(head);
    const aligned = currentKey.includes(joinedKey) || joinedKey.includes(currentKey) || roots.some((root) => normalizeBrandKey(root).startsWith(headKey));
    if (aligned) return joined;
  }
  return null;
}

function canonicalizeCompanyDisplay(value: string): string {
  let normalized = clean(value)
    // Un codice a barre, un artefatto grafico o una sequenza numerica OCR non
    // sono parte di una ragione sociale. La rimozione richiede una sequenza
    // lunga iniziale e lascia intatti codici societari che compaiono altrove.
    .replace(/^(?:[0-9OoIl]{8,}\s+)+(?=\p{L})/u, '')
    // ML Kit può separare ogni lettera della forma giuridica. Questa è una
    // grafia esatta osservata, non una correzione fuzzy: canonicalizzala prima
    // di calcolare brand e suffisso.
    .replace(/\bS\s+R\s+L\s*\.?$/i, 'S.r.l.')
    .replace(/\bS\s+P\s+A\s*\.?$/i, 'S.p.A.')
    .replace(/\bS\s+N\s+C\s*\.?$/i, 'S.n.c.')
    .replace(/\bS\s+A\s+S\s*\.?$/i, 'S.a.s.')
    .replace(/\bs\.?\s*r\.?\s*l\.?$/i, 'S.r.l.');
  // Nei marchi di due lettere l'OCR può aggiungere uno spazio solo dopo "&".
  // È punteggiatura interna osservata, non espansione/invenzione del brand.
  normalized = normalized.replace(/([A-Za-z])&\s+([A-Za-z])(?=\s|$)/g, '$1&$2');
  const legalFree = stripLegalFormSuffix(normalized).trim();
  const legalSuffix = normalized.slice(stripLegalFormSuffix(normalized).length).trim().replace(/^[,;:\-]+\s*/, '');
  // Non ricomporre sigle spezzate o puntate: i separatori del brand sono
  // contenuto osservato, non una forma giuridica. Canonicalizziamo soltanto
  // il suffisso legale già riconosciuto, senza inventare punti o togliere spazi.
  return normalized
    .replace(/\binternational\b/gi, 'International')
    .replace(/\bco\s*,?\s*ltd\.?$/i, 'Co., Ltd.')
    .replace(/\bco\.\s*,?\s*ltd\.?$/i, 'Co., Ltd.')
    .replace(/\bs\.?\s*r\.?\s*l\.?\s*u\.?$/i, 'S.r.l.u.')
    .replace(/\bs\.?\s*n\.?\s*c\.?$/i, 'S.n.c.')
    .replace(/\bgmbh\b/gi, 'GmbH');
}

function hostFromWebsite(website: string | null): string | null {
  const host = (website ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    ?.trim();
  return host && host.includes('.') ? host : null;
}

function businessRoots(emails: string[], website: string | null): string[] {
  const roots = new Set<string>();
  const addHost = (host: string | null | undefined) => {
    if (!host) return;
    const normalized = host.toLowerCase().replace(/^www\./, '').split('/')[0] ?? '';
    if (!normalized.includes('.') || isNonBusinessEmailDomain(normalized)) return;
    const root = normalized.split('.')[0]?.replace(/[^a-z0-9-]/g, '') ?? '';
    if (root.length >= 3) roots.add(root);
    const first = root.split('-')[0] ?? '';
    if (first.length >= 3) roots.add(first);
  };
  emails.forEach((email) => addHost(email.split('@')[1]));
  addHost(hostFromWebsite(website));
  return [...roots];
}

function repairStructuredEmailAndWebsite(
  rawText: string,
  emails: string[],
  website: string | null,
): { emails: string[]; website: string | null; repairedEmails: string[] } {
  const next = new Set<string>();
  const repairedEmails: string[] = [];
  let nextWebsite = website;

  for (const email of emails) {
    const fused = email.match(/^([^@\s]+@[a-z0-9.-]+?\.[a-z]{2,})-www\.([a-z0-9.-]+\.[a-z]{2,})$/i);
    if (fused && fused[1] && fused[2]) {
      next.add(fused[1].toLowerCase());
      nextWebsite = `www.${fused[2].toLowerCase()}`;
      repairedEmails.push(fused[1].toLowerCase());
    } else {
      next.add(email.toLowerCase());
    }
  }

  for (const line of rawText.split(/\r?\n/)) {
    const fused = line.match(/([a-z0-9._%+\-]+@[a-z0-9.-]+?\.[a-z]{2,})\s*-\s*(www\.[a-z0-9.-]+\.[a-z]{2,})/i);
    if (fused?.[1] && fused[2]) {
      next.add(fused[1].toLowerCase());
      nextWebsite = fused[2].toLowerCase();
      repairedEmails.push(fused[1].toLowerCase());
    }
  }

  // Riparti sempre dal www realmente osservato. A monte un dominio email con
  // un glifo errato può aver già sostituito il sito corretto; qui la prova
  // esplicita sul biglietto deve tornare la base del confronto.
  const explicitWebsite = [...rawText.matchAll(/\bwww\.\s*([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)]
    .map((match) => match[1]?.replace(/\s+/g, '').toLowerCase())
    .find((value): value is string => Boolean(value));
  if (explicitWebsite) nextWebsite = `www.${explicitWebsite}`;

  // Una mailbox con chiocciola resa come parentesi può offrire un dominio più
  // affidabile del sito: accettalo solo quando differisce dal www osservato
  // esclusivamente per la confusione OCR 0/O o 1/I/l.
  const bracketedHosts = rawText.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/\b[a-z0-9._%+\-]{3,}\s*[\[\(\{]\s*([a-z0-9-]+\.[a-z]{2,})\b/i);
    return match?.[1] ? [match[1].toLowerCase()] : [];
  });
  if (nextWebsite) {
    const currentHost = hostFromWebsite(nextWebsite);
    const bracketedHost = bracketedHosts.find((candidate) => {
      if (!currentHost || candidate.split('.').at(-1) !== currentHost.split('.').at(-1)) return false;
      const normalizedCandidate = candidate.replace(/0/g, 'o').replace(/[1Il]/g, 'i');
      const normalizedCurrent = currentHost.replace(/0/g, 'o').replace(/[1Il]/g, 'i');
      return normalizedCandidate === normalizedCurrent && candidate !== currentHost;
    });
    if (bracketedHost) nextWebsite = `www.${bracketedHost}`;
  }

  const host = hostFromWebsite(nextWebsite) ?? (() => {
    const explicit = rawText.match(/(?:https?:\/\/)?www\.\s*([a-z0-9][a-z0-9.\-\s]*\.[a-z]{2,})/i)?.[1];
    return explicit?.replace(/\s+/g, '').toLowerCase() ?? null;
  })();
  if (host) {
    for (const line of rawText.split(/\r?\n/)) {
      const spaced = line.trim().match(/^([a-z0-9._%+\-]{3,})\s+[aAeE]\s+([a-z0-9-]+)\s+([a-z]{2,})$/i);
      if (spaced) {
        const observedHost = `${spaced[2]}.${spaced[3]}`.toLowerCase();
        if (observedHost === host && /[._-]/.test(spaced[1]!)) {
          const repaired = `${spaced[1]!.toLowerCase()}@${host}`;
          next.add(repaired);
          repairedEmails.push(repaired);
        }
      }
      const compact = line.replace(/\s+/g, '');
      const lower = compact.toLowerCase();
      if (!lower.endsWith(host)) continue;
      const prefix = compact.slice(0, compact.length - host.length);
      const separator = prefix.slice(-1);
      const local = prefix.slice(0, -1).toLowerCase();
      if (/^[o0]$/i.test(separator) && /^[a-z0-9._%+\-]{3,}$/.test(local) && /[._-]/.test(local)) {
        const repaired = `${local}@${host}`;
        next.add(repaired);
        repairedEmails.push(repaired);
      }

      // Alcuni font rendono la chiocciola come parentesi o quadra. Accettiamo
      // il recupero soltanto quando il dominio letto coincide con il sito
      // esplicito (ammettendo un solo glifo OCR lettera/cifra nel dominio).
      const bracketed = line.match(/\b([a-z0-9._%+\-]{3,})\s*[\[\(\{]\s*([a-z0-9-]+\.[a-z]{2,})\b/i);
      if (bracketed?.[1] && bracketed[2]) {
        const local = bracketed[1].toLowerCase();
        const observedHost = bracketed[2].toLowerCase();
        const normalizedObserved = observedHost.replace(/0/g, 'o').replace(/[1l]/g, 'i');
        const normalizedHost = host.replace(/0/g, 'o').replace(/[1l]/g, 'i');
        if (
          /^[a-z0-9._%+\-]{3,}$/.test(local) &&
          (observedHost === host || (normalizedObserved.length === normalizedHost.length && levenshtein(normalizedObserved, normalizedHost) <= 1))
        ) {
          const repaired = `${local}@${host}`;
          next.add(repaired);
          repairedEmails.push(repaired);
        }
      }
    }
  }

  // Se il sito ha un solo glifo OCR errato ma l'email valida osservata porta
  // lo stesso brand e TLD, preferisci il dominio dell'email. Non interviene su
  // provider generici o su domini semanticamente diversi.
  const businessEmailHost = [...next]
    .map((email) => email.split('@')[1]?.toLowerCase())
    .find((value): value is string => Boolean(value && !isNonBusinessEmailDomain(value)));
  const websiteHost = hostFromWebsite(nextWebsite);
  if (businessEmailHost && websiteHost && businessEmailHost !== websiteHost) {
    const [emailRoot = '', emailTld = ''] = businessEmailHost.split('.');
    const [siteRoot = '', siteTld = ''] = websiteHost.split('.');
    const brandLines = rawText.split(/\r?\n/).map(clean).filter((line) =>
      line.length >= 4 && line.length <= 80 &&
      !/@|www\.|https?:|\d{5,}|\b(?:tel|fax|phone|mobile|cell|via|viale|street|road)\b/i.test(line)
    );
    const distanceToObservedBrand = (root: string): number => {
      const key = normalizeBrandKey(root);
      return brandLines.reduce((best, line) => {
        const lineKey = normalizeBrandKey(stripLegalFormSuffix(line));
        if (!lineKey) return best;
        if (lineKey.includes(key) || key.includes(lineKey)) return Math.min(best, Math.abs(lineKey.length - key.length));
        return Math.min(best, levenshtein(lineKey, key));
      }, Number.POSITIVE_INFINITY);
    };
    const emailBrandDistance = distanceToObservedBrand(emailRoot);
    const siteBrandDistance = distanceToObservedBrand(siteRoot);
    const emailRootExtendsObservedBrand = brandLines.some((line) => {
      const lineKey = normalizeBrandKey(stripLegalFormSuffix(line));
      return lineKey.length >= 4 && emailRoot.startsWith(lineKey);
    });
    if (
      emailRoot.length >= 4 && emailTld === siteTld &&
      Math.abs(emailRoot.length - siteRoot.length) <= 2 &&
      levenshtein(emailRoot, siteRoot) <= 2 &&
      (
        (emailBrandDistance <= 2 && emailBrandDistance + 1 <= siteBrandDistance) ||
        emailRootExtendsObservedBrand
      )
    ) {
      nextWebsite = `www.${businessEmailHost}`;
    }
  }

  // Variante prudente per due glifi errati: il dominio dell'e-mail prevale
  // solo se il suo root estende un brand stampato e conserva lo stesso TLD.
  // Evita di fondere domini diversi o provider generici.
  const finalWebsiteHost = hostFromWebsite(nextWebsite);
  const supportedEmailHost = [...next]
    .map((email) => email.split('@')[1]?.toLowerCase())
    .find((value): value is string => Boolean(value && !isNonBusinessEmailDomain(value) && finalWebsiteHost && value !== finalWebsiteHost && (() => {
      const [emailRoot = '', emailTld = ''] = value.split('.');
      const [siteRoot = '', siteTld = ''] = finalWebsiteHost.split('.');
      return emailRoot.length >= 4 && emailTld === siteTld &&
        Math.abs(emailRoot.length - siteRoot.length) <= 2 &&
        levenshtein(emailRoot, siteRoot) <= 2 &&
        rawText.split(/\r?\n/).map(clean).some((line) => {
          const lineKey = normalizeBrandKey(stripLegalFormSuffix(line));
          return lineKey.length >= 4 && emailRoot.startsWith(lineKey) && !/@|www\.|https?:/i.test(line);
        });
    })()));
  if (supportedEmailHost) nextWebsite = `www.${supportedEmailHost}`;

  return { emails: [...next], website: nextWebsite, repairedEmails };
}

function repairOwnerIdentity(
  rawText: string,
  firstName: V5Field<string>,
  lastName: V5Field<string>,
): { firstName: V5Field<string>; lastName: V5Field<string> } {
  const owner = rawText.split(/\r?\n/).map(clean).find((line) => /^di\s+[\p{L}'’.-]+\s+[\p{L}'’.-]+$/iu.test(line));
  const match = owner?.match(/^di\s+([\p{L}'’.-]+)\s+([\p{L}'’.-]+)$/iu);
  if (!match?.[1] || !match[2]) return { firstName, lastName };
  const currentDirect = normalizeBrandKey(`${firstName.value ?? ''} ${lastName.value ?? ''}`);
  const observedDirect = normalizeBrandKey(`${match[1]} ${match[2]}`);
  if (currentDirect !== observedDirect) return { firstName, lastName };
  const socialCorroboration = rawText.split(/\r?\n/).map(clean).some((line) =>
    /^(?:facebook|instagram|linkedin)\s*:/i.test(line) &&
    normalizeBrandKey(line).endsWith(normalizeBrandKey(`di ${match[1]} ${match[2]}`)));
  if (!socialCorroboration) return { firstName, lastName };
  return {
    firstName: field(firstName, cap(match[2]), 'formula italiana "di Cognome Nome": ordine proprietario ripristinato'),
    lastName: field(lastName, cap(match[1]), 'formula italiana "di Cognome Nome": ordine proprietario ripristinato'),
  };
}

function socialOwnerBrand(rawText: string): string | null {
  for (const line of rawText.split(/\r?\n/).map(clean)) {
    const match = line.match(/^(?:facebook|instagram|linkedin)\s*:?\s*(.+?)\s+di\s+[\p{L}'’.-]+\s+[\p{L}'’.-]+$/iu);
    if (!match?.[1]) continue;
    const brand = clean(match[1]);
    if (brand.length >= 2 && brand.split(/\s+/).length <= 5) return brand;
  }
  return null;
}

function observedSpacedBrand(rawText: string, current: string): string | null {
  const key = normalizeBrandKey(stripLegalFormSuffix(current));
  if (!key || /\s/.test(stripLegalFormSuffix(current))) return null;
  const candidates = rawText.split(/\r?\n/).map(clean).filter((line) => {
    if (!line || /@|https?:|^www\b|www\.|\d{4,}/i.test(line)) return false;
    if (line.split(/\s+/).length < 2 || line.split(/\s+/).length > 5) return false;
    if (ROLE_TOKEN_RE.test(line) || STREET_RE.test(line)) return false;
    return normalizeBrandKey(stripLegalFormSuffix(line)) === key;
  });
  return [...new Set(candidates)].sort((a, b) => a.length - b.length)[0] ?? null;
}

function repairCompany(
  rawText: string,
  current: V5Field<string>,
  firstName: V5Field<string>,
  lastName: V5Field<string>,
  emails: string[],
  website: string | null,
): V5Field<string> {
  let company = current;
  const roots = businessRoots(emails, website);
  const websiteRoots = businessRoots([], website);
  const observedLines = rawText.split(/\r?\n/).map(clean).filter(Boolean);

  // A compact domain-style header is self-contained business evidence and
  // must win over an adjacent vertical school/department descriptor.
  const observedCompactDomainBrand = observedLines
    .map(recoverCompactOcrDomainBrand)
    .find((value): value is string => Boolean(value));
  if (observedCompactDomainBrand) {
    company = field(company, observedCompactDomainBrand, 'brand dominio compatto OCR separato dal descrittore adiacente', 0.72);
  }

  // Ricompone soltanto marchi impilati che coincidono esattamente con una
  // radice business osservata (es. riga, "&", riga): niente dizionari.
  for (let i = 0; i + 2 < observedLines.length; i += 1) {
    const left = observedLines[i] ?? '';
    const join = observedLines[i + 1] ?? '';
    const right = observedLines[i + 2] ?? '';
    if (join !== '&' || /[@\d]/.test(`${left}${right}`)) continue;
    const compact = normalizeBrandKey(`${left}${right}`);
    if (compact.length < 4 || !roots.some((root) => normalizeBrandKey(root) === compact)) continue;
    company = field(company, cap(`${left} & ${right}`), 'marchio impilato ricomposto da tre righe OCR e dominio osservato');
    break;
  }

  // Un brand breve esatto nel testo prevale sulla forma ottenuta incollando
  // un suffisso geografico del dominio ("-mi", "-uk", ecc.).
  if (company.value) {
    const currentKey = normalizeBrandKey(company.value);
    const observedBrand = observedLines.find((line) => {
      const key = normalizeBrandKey(line);
      return /^[A-Z0-9&.-]{4,20}$/.test(line) &&
        roots.some((root) => normalizeBrandKey(root).startsWith(key)) &&
        (currentKey === key || currentKey === `${key}mi` || currentKey === `${key}uk` || currentKey === `${key}us`);
    });
    if (observedBrand) company = field(company, cap(observedBrand), 'brand OCR osservato preservato senza suffisso geografico del dominio');
  }
  const socialBrand = socialOwnerBrand(rawText);
  if (socialBrand) {
    company = field(company, socialBrand, 'brand osservato nella pagina social accanto alla formula proprietario');
  }

  // Le schede social contengono spesso handle e descrizioni ("official",
  // "about us", "podcast"...) che non fanno parte della ragione sociale.
  // Se il dominio e una riga breve OCR concordano, conserva solo quel brand.
  if (company.value && /\b(?:official|about\s+us|podcast|instagram|facebook|youtube|spotify|linkedin)\b/i.test(company.value)) {
    const observedDomainBrand = observedLines.find((line) => {
      if (!/^[A-Za-z0-9&.-]{4,30}$/.test(line)) return false;
      const lineKey = normalizeBrandKey(line);
      return roots.some((root) => normalizeBrandKey(root) === lineKey);
    });
    if (observedDomainBrand) {
      company = field(company, cap(observedDomainBrand), 'descrizione social rimossa: mantenuto il marchio OCR confermato dal dominio');
    }
  }

  if (company.value) {
    const roleTail = company.value.match(/^(.*?)(?:\s+|[|/,-])(?:sales|marketing|sales\s*\/\s*marketing|managing\s+partner|general\s+manager)\b.*$/i);
    if (roleTail?.[1] && normalizeBrandKey(roleTail[1]).length >= 3) {
      company = field(company, clean(roleTail[1]), 'ruolo/area commerciale rimossa dalla company');
    }
  }

  if (company.value) {
    const compactCompany = company.value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hostnameChosenAsCompany = compactCompany.match(/^www([a-z0-9-]{3,})(?:com|it|net|org|co|de|fr|be)$/i);
    if (hostnameChosenAsCompany?.[1]) {
      company = field(
        company,
        splitFusedDomainBrand(hostnameChosenAsCompany[1]),
        'hostname OCR escluso dalla company e convertito nella sola radice business',
        0.72,
      );
    }
  }

  if (company.value) {
    const consecutiveLegal = recoverConsecutiveLegalCompany(rawText, company.value, roots);
    if (consecutiveLegal) {
      company = field(company, consecutiveLegal, 'ragione sociale su righe consecutive ricomposta senza duplicare il dominio');
    }
  }

  if (company.value && roots.length) {
    const companyValue = company.value;
    const legal = companyValue.slice(stripLegalFormSuffix(companyValue).length).trim();
    const words = stripLegalFormSuffix(companyValue).split(/\s+/).filter(Boolean);
    const first = words[0] ?? '';
    const firstKey = normalizeBrandKey(first).replace(/5/g, 's');
    const candidates = roots.filter((root) => {
      const rootKey = normalizeBrandKey(root);
      if (rootKey === firstKey) return true;
      if (rootKey.startsWith(firstKey) || firstKey.startsWith(rootKey)) return Math.min(rootKey.length, firstKey.length) >= 3;
      return firstKey.length >= 3 && rootKey.length >= 3 && levenshtein(firstKey, rootKey) <= 2;
    });
    const shared = candidates.sort((a, b) => {
      const aExact = normalizeBrandKey(a) === firstKey ? 0 : 1;
      const bExact = normalizeBrandKey(b) === firstKey ? 0 : 1;
      const aDistance = levenshtein(normalizeBrandKey(a), firstKey);
      const bDistance = levenshtein(normalizeBrandKey(b), firstKey);
      // Un suffisso geografico del dominio (es. "-mi") non diventa parte del
      // brand: scegli il completamento compatibile più vicino all'OCR.
      return aExact - bExact || aDistance - bDistance || a.length - b.length;
    })[0];
    const sharedIsWebsiteBacked = Boolean(
      shared && websiteRoots.some((root) => normalizeBrandKey(root) === normalizeBrandKey(shared)),
    );
    const observedConfusionKey = normalizeBrandKey(first.replace(/5/g, 'S').replace(/0/g, 'O'));
    const observedConfusionSupported = /[50]/.test(first) &&
      normalizeBrandKey(shared ?? '').startsWith(observedConfusionKey) &&
      observedConfusionKey.length >= 3;
    const exactObservedLegalCompany = hasTerminalLegalFormSuffix(companyValue) && rawText
      .split(/\r?\n/)
      .map(clean)
      .some((line) => normalizeBrandKey(line) === normalizeBrandKey(companyValue));
    if (
      shared &&
      firstKey !== normalizeBrandKey(shared) &&
      normalizeBrandKey(shared).length >= firstKey.length &&
      (sharedIsWebsiteBacked || observedConfusionKey === normalizeBrandKey(shared)) &&
      (!exactObservedLegalCompany || observedConfusionSupported)
    ) {
      const sharedKey = normalizeBrandKey(shared);
      const correctedObservedPrefix = first.replace(/5/g, 'S').replace(/0/g, 'O');
      const replacement = sharedKey.startsWith(firstKey) ? correctedObservedPrefix : shared;
      const display = replacement === correctedObservedPrefix
        ? correctedObservedPrefix
        : companyValue === companyValue.toUpperCase()
          ? replacement.toUpperCase()
          : cap(replacement.replace(/-/g, ' '));
      company = field(
        company,
        clean([display, ...words.slice(1), legal].filter(Boolean).join(' ')),
        'primo token del brand riconciliato con dominio business osservato',
      );
    }
  }

  // Il glifo "5" può essere letto al posto della S nel nome di una società.
  // Lo correggiamo soltanto se: il dominio aziendale contiene esattamente la
  // forma corretta e il testo OCR riporta separatamente il token corretto.
  if (company.value && /5/.test(company.value) && roots.length) {
    const repaired = company.value.replace(/5/g, 'S');
    const repairedKey = normalizeBrandKey(stripLegalFormSuffix(repaired));
    const supportedByDomain = roots.some((root) => normalizeBrandKey(root).startsWith(repairedKey));
    const correctedTokens = [...company.value.matchAll(/[A-Za-z]*5[A-Za-z]*/g)]
      .map((match) => match[0]!.replace(/5/g, 'S'))
      .filter((token) => token.length >= 4);
    const supportedByRaw = correctedTokens.some((token) =>
      new RegExp(`\\b${token.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(rawText)
    );
    if (supportedByDomain && supportedByRaw) {
      company = field(company, repaired, 'glifo 5/S corretto con prova indipendente in dominio e testo OCR', 0.69);
    }
  }

  if (company.value) {
    const institutional = company.value.match(/^(.*?\b(?:politecnico|universit[aà]|university|college|istituto|institute|academy|accademia|school)\b.*?)\s*\/\s*(.+)$/i);
    const hierarchicalInstitutionTail = institutional?.[2] &&
      /\b(?:college|faculty|school|division\s+of|department\s+of|dipartimento\s+di)\b/i.test(institutional[2]);
    if (institutional?.[1] && institutional[2] && DEPARTMENT_RE.test(institutional[2]) && !hierarchicalInstitutionTail) {
      company = field(company, clean(institutional[1]), 'dipartimento separato dalla denominazione istituzionale');
    }
  }

  if (company.value) {
    const fusedObserved = observedSpacedBrand(rawText, company.value);
    if (fusedObserved) company = field(company, fusedObserved, 'spazi del brand ripristinati dalla riga OCR osservata');
  }

  if (company.value && /[,\s][!1I|]TD\.?$/i.test(company.value)) {
    company = field(company, company.value.replace(/[,\s][!1I|]TD\.?$/i, ' Ltd.'), 'forma giuridica LTD riparata da un singolo glifo OCR', 0.69);
  }

  if (company.value) {
    const canonical = canonicalizeCompanyDisplay(company.value);
    if (canonical !== company.value) company = field(company, canonical, 'forma giuridica internazionale canonicalizzata');
  }

  if (company.value && /^([A-Z])&\s*(?=[A-Za-z])/.test(company.value)) {
    const lead = company.value[0]!.toLowerCase();
    const domainPair = roots
      .map((root) => root.match(/^([a-z])and([a-z])$/i))
      .find((match) => match?.[1]?.toLowerCase() === lead);
    if (domainPair?.[2]) {
      company = field(
        company,
        company.value.replace(/^([A-Z])&/i, `$1&${domainPair[2].toUpperCase()} `).replace(/\s+/g, ' '),
        'lettera mancante nell’acronimo & recuperata dal dominio business',
        0.69,
      );
    }
  }

  // Un'intestazione OCR come "G&HINTERNATIONAL" rappresenta un acronimo a
  // due lettere seguito da una parola, non "G& Hinternational". La divisione
  // è ammessa solo quando il dominio conferma la coppia A-and-B.
  const observedAmpersandInternational = observedLines.find((line) => {
    const match = line.match(/^([A-Z])&([A-Z])INTERNATIONAL\s+CO[,.]?\s*LTD\.?$/i);
    if (!match?.[1] || !match[2]) return false;
    return roots.some((root) => normalizeBrandKey(root) === `${match[1].toLowerCase()}and${match[2].toLowerCase()}`);
  });
  if (observedAmpersandInternational) {
    const match = observedAmpersandInternational.match(/^([A-Z])&([A-Z])INTERNATIONAL/i)!;
    company = field(company, `${match[1]}&${match[2]} International Co., Ltd.`, 'acronimo & e denominazione internazionale ricomposti da riga OCR e dominio', 0.72);
  }

  const companyIsPerson = Boolean(
    company.value && firstName.value && lastName.value &&
    normalizeBrandKey(company.value) === normalizeBrandKey(`${firstName.value} ${lastName.value}`)
  );
  if (companyIsPerson) {
    const rootsNow = businessRoots(emails, website);
    const header = rawText.split(/\r?\n/).map(clean).find((line) => {
      if (!/^[A-Z][A-Z0-9&.-]{2,15}$/.test(line)) return false;
      const key = normalizeBrandKey(line);
      return rootsNow.some((root) => normalizeBrandKey(root).startsWith(key));
    });
    if (header) company = field(company, header, 'persona rimossa dalla company; brand header confermato dal dominio');
  }

  if (company.value && lastName.value && websiteRoots.length) {
    const companyKey = normalizeBrandKey(company.value);
    const personKey = normalizeBrandKey(lastName.value);
    const websiteConfirmsPersonBrand = websiteRoots.some((root) =>
      normalizeBrandKey(root).startsWith(personKey)
    );
    if (
      companyKey.length >= 4 && personKey.length >= 4 &&
      websiteConfirmsPersonBrand && levenshtein(companyKey, personKey) <= 1
    ) {
      company = field(company, cap(lastName.value), 'logo OCR riconciliato con cognome osservato e sito esplicito');
    }
  }

  const hasBusinessAuthority = roots.length > 0 || hasTerminalLegalFormSuffix(company.value ?? '');
  if (
    company.value && !hasBusinessAuthority && firstName.value && lastName.value &&
    (isProductCategoryTagline(company.value) ||
      (ACTIVITY_WORD_RE.test(company.value) && company.value.split(/\s+/).some((token) => ROLE_TOKEN_RE.test(token))))
  ) {
    company = field(company, null, 'attività/professione priva di evidenza societaria esclusa dalla company');
  }

  // Le regole di ricomposizione successive possono reintrodurre una spaziatura
  // OCR attorno alla punteggiatura del marchio: applica una sola normalizzazione
  // di display prima dell'uscita, senza alterare le parole del brand.
  if (company.value) {
    const canonical = canonicalizeCompanyDisplay(company.value);
    if (canonical !== company.value) company = field(company, canonical, 'spaziatura del marchio canonicalizzata dopo ricomposizione');
  }

  return company;
}

function repairPersonFromObservedEmail(
  rawText: string,
  firstName: V5Field<string>,
  lastName: V5Field<string>,
  emails: string[],
): { firstName: V5Field<string>; lastName: V5Field<string> } {
  if (!firstName.value || !lastName.value) return { firstName, lastName };

  // Un "nome" che coincide esattamente con il marchio del dominio è un
  // handle/brand, non una persona, se non esiste una riga persona distinta.
  const personKey = normalizeBrandKey(`${firstName.value}${lastName.value}`);
  const brandKeys = emails
    .map((email) => normalizeBrandKey((email.split('@')[1] ?? '').split('.')[0] ?? ''))
    .filter((key) => key.length >= 5);
  if (brandKeys.includes(personKey)) {
    const hasDistinctPersonLine = rawText.split(/\r?\n/).some((line) => {
      const words = clean(line.replace(/^(?:ing\.?|dott\.?|dr\.?|avv\.?)\s+/i, '')).match(/[\p{L}][\p{L}'’.-]*/gu) ?? [];
      return words.length === 2 && normalizeBrandKey(`${words[0]}${words[1]}`) === personKey;
    });
    if (!hasDistinctPersonLine) {
      return {
        firstName: field(firstName, null, 'handle social coincidente con dominio escluso dalla persona'),
        lastName: field(lastName, null, 'handle social coincidente con dominio escluso dalla persona'),
      };
    }
  }

  // L'OCR a valle può incollare al cognome una o più iniziali che appartengono
  // alla mailbox ("i.cognome" → "Icognome"). Non si usa alcun dizionario: la
  // grafia di ripristino deve essere presente nel testo OCR insieme al nome.
  const rawKey = normalizeBrandKey(rawText);
  const firstKeyObserved = normalizeBrandKey(firstName.value);
  const lastKeyObserved = normalizeBrandKey(lastName.value);
  const initials = (firstName.value.match(/[\p{L}]+/gu) ?? [])
    .map((part) => normalizeBrandKey(part).charAt(0))
    .join('');
  if (initials && rawKey.includes(firstKeyObserved)) {
    for (const email of emails) {
      const localKey = normalizeBrandKey(email.split('@')[0] ?? '');
      if (!localKey.startsWith(initials) || localKey.length <= initials.length + 2) continue;
      const emailSurnameKey = localKey.slice(initials.length);
      const gluedPrefix = [...initials]
        .map((_, index) => initials.slice(index))
        .find((prefix) => lastKeyObserved === `${prefix}${emailSurnameKey}`);
      if (!gluedPrefix) continue;

      const observedWords = rawText.split(/\r?\n/).flatMap((line) =>
        line.match(/[\p{L}][\p{L}'’.-]*/gu) ?? []
      );
      let observedSurname: string | null = null;
      for (let start = 0; start < observedWords.length && !observedSurname; start += 1) {
        for (let width = 1; width <= 3 && start + width <= observedWords.length; width += 1) {
          const candidate = observedWords.slice(start, start + width).join(' ');
          if (normalizeBrandKey(candidate) === emailSurnameKey) {
            observedSurname = candidate;
            break;
          }
        }
      }
      if (observedSurname || emailSurnameKey.length >= 4) {
        return {
          firstName,
          lastName: field(lastName, cap(observedSurname ?? emailSurnameKey), 'iniziale della mailbox separata dal cognome OCR con prova nel testo'),
        };
      }
    }
  }

  // Se la riga OCR osservata riporta lo stesso nome e un cognome a un solo
  // glifo dal valore finale, prevale la grafia osservata sulla derivazione
  // dall'e-mail (che può contenere a sua volta un glifo OCR errato).
  const observedNearSurname = rawText.split(/\r?\n/).map(clean).map((line) => {
    if (/\d/.test(line)) return null;
    const words = line.replace(/^(?:ing\.?|dott\.?|dr\.?|avv\.?)\s+/i, '').match(/[\p{L}][\p{L}'’.-]*/gu) ?? [];
    if (words.length !== 2 || normalizeBrandKey(words[0] ?? '') !== firstKeyObserved) return null;
    return words[1] ?? null;
  }).find((surname): surname is string =>
    Boolean(surname) &&
    normalizeBrandKey(surname!) !== lastKeyObserved &&
    levenshtein(normalizeBrandKey(surname!), lastKeyObserved) === 1
  );
  if (observedNearSurname) {
    return {
      firstName,
      lastName: field(lastName, cap(observedNearSurname), 'cognome OCR osservato preferito a variante email a un glifo'),
    };
  }

  // Una local-part mononimo (es. cognome@azienda) può confermare una coppia
  // Nome Cognome già letta nel biglietto. Non inventa nomi: sostituisce solo
  // un candidato quando cognome e riga persona sono entrambi osservati.
  for (const email of emails) {
    const local = (email.split('@')[0] ?? '').toLowerCase();
    if (!/^[a-z\p{L}'’.-]{3,}$/iu.test(local) || /[._+\-]/.test(local)) continue;
    // Non attraversare righe OCR: un testo aziendale su due righe può
    // somigliare casualmente a "Nome Cognome". La prova è valida solo su una
    // riga isolata di esattamente due parole, con cognome uguale alla mailbox.
    const observed = rawText.split(/\r?\n/).map(clean).map((line) => ({
      line,
      match: line.match(/^([\p{L}][\p{L}'’.-]{1,})[ \t]+([\p{L}][\p{L}'’.-]{1,})$/u),
    })).find(({ line, match }) => {
      const first = match?.[1] ?? '';
      const last = match?.[2] ?? '';
      // Mai usare etichette di canale, slogan o una riga tutta maiuscola come
      // persona: solo una coppia con grafia da nome osservata.
      if (!first || !last || line === line.toLocaleUpperCase()) return false;
      if (/^(?:skype|tel|telephone|phone|fax|mobile|mob|cell|email|mail|web|www|info|contact|office|sales|marketing|business|motorbike|gloves|group)$/i.test(first)) return false;
      return normalizeBrandKey(last) === normalizeBrandKey(local);
    })?.match;
    if (observed?.[1] && observed[2] &&
      normalizeBrandKey(`${observed[1]} ${observed[2]}`) !== normalizeBrandKey(`${firstName.value} ${lastName.value}`)) {
      return {
        firstName: field(firstName, cap(observed[1]), 'nome osservato confermato dalla local-part email'),
        lastName: field(lastName, cap(observed[2]), 'cognome osservato confermato dalla local-part email'),
      };
    }
  }
  const firstKey = normalizeBrandKey(firstName.value);
  const fullObserved = rawText.split(/\r?\n/).map(clean).some((line) =>
    normalizeBrandKey(line) === normalizeBrandKey(`${firstName.value} ${lastName.value}`));
  const strongUppercaseObservation = rawText.split(/\r?\n/).map(clean).some((line) =>
    normalizeBrandKey(line) === normalizeBrandKey(`${firstName.value} ${lastName.value}`) &&
    line === line.toLocaleUpperCase() && /\p{Lu}/u.test(line));
  if (fullObserved && !strongUppercaseObservation) {
    for (const email of emails) {
      const localFirst = (email.split('@')[0] ?? '').split(/[._+\-]/)[0] ?? '';
      const key = normalizeBrandKey(localFirst);
      if (key.length >= 3 && key.length === firstKey.length && levenshtein(key, firstKey) === 1) {
        return {
          firstName: field(firstName, cap(localFirst), 'un glifo del nome riconciliato con email personale osservata'),
          lastName,
        };
      }
    }
  }

  const firstRole = ['general', 'sales', 'account', 'project', 'product'].some((role) =>
    levenshtein(firstKey, role) <= (Math.max(firstKey.length, role.length) >= 6 ? 3 : 2));
  const lastKey = normalizeBrandKey(lastName.value);
  const lastRole = ['manager', 'director', 'marketing', 'partner'].some((role) => levenshtein(lastKey, role) <= 2);
  if (firstRole && lastRole) {
    return {
      firstName: field(firstName, null, 'riga OCR simile a un ruolo esclusa dalla persona'),
      lastName: field(lastName, null, 'riga OCR simile a un ruolo esclusa dalla persona'),
    };
  }
  return { firstName, lastName };
}

const PHONE_COUNTRY_ANCHORS: Array<{ prefix: string; country: RegExp; canonical: string }> = [
  { prefix: '353', country: /\b(?:ireland|irlanda)\b/i, canonical: 'Ireland' },
  { prefix: '44', country: /\b(?:uk|united kingdom|england)\b/i, canonical: 'UK' },
  { prefix: '49', country: /\b(?:germany|deutschland)\b/i, canonical: 'Germany' },
  { prefix: '33', country: /\b(?:france|francia)\b/i, canonical: 'France' },
  { prefix: '39', country: /\b(?:italy|italia)\b/i, canonical: 'Italy' },
  { prefix: '32', country: /\b(?:belgium|belgio|belgique)\b/i, canonical: 'Belgium' },
  { prefix: '92', country: /\bpakistan\b/i, canonical: 'Pakistan' },
  { prefix: '81', country: /\bjapan\b/i, canonical: 'Japan' },
  { prefix: '886', country: /\btaiwan\b/i, canonical: 'Taiwan' },
  { prefix: '971', country: /\b(?:uae|united arab emirates)\b/i, canonical: 'UAE' },
];

function recoverPhoneAnchoredCountryAddress(rawText: string, phones: Phone[]): V5AddressParts | null {
  const lines = rawText.split(/\r?\n/).map(clean).filter(Boolean);
  const explicitCountries = PHONE_COUNTRY_ANCHORS.filter((entry) =>
    lines.some((line) => entry.country.test(line))
  );
  if (explicitCountries.length < 2) return null;
  const phoneDigits = phones
    .filter((phone) => /^\s*(?:\+|00)/.test(phone.number))
    .map((phone) => phone.number.replace(/\D/g, '').replace(/^00/, ''));
  const anchor = explicitCountries.find((entry) =>
    phoneDigits.some((digits) => digits.startsWith(entry.prefix))
  );
  if (!anchor) return null;
  const countryIndex = lines.findIndex((line) => anchor.country.test(line));
  if (countryIndex < 0) return null;
  for (let index = countryIndex - 1; index >= Math.max(0, countryIndex - 4); index -= 1) {
    const line = lines[index]!;
    if (/@|www\.|https?:|\b(?:tel|fax|phone|mobile|cell|skype)\b/i.test(line)) continue;
    const district = line.match(/^([\p{L}][\p{L}\p{M}'’ .-]{1,40}?)\s+(\d{1,2})$/u);
    const postal = line.match(/^([A-Z]{0,2}-?\d{4,6})\s+([\p{L}][\p{L}\p{M}'’ .-]{1,40})$/u);
    if (district?.[1]) {
      return {
        full: `${line}, ${anchor.canonical}`,
        city: clean(district[1]),
        country: anchor.canonical,
        completeness: 0.34,
        partial: true,
        rawLines: [line, lines[countryIndex]!],
        requiresReview: true,
      };
    }
    if (postal?.[1] && postal[2]) {
      return {
        full: `${line}, ${anchor.canonical}`,
        postalCode: postal[1],
        city: clean(postal[2]),
        country: anchor.canonical,
        completeness: 0.52,
        partial: true,
        rawLines: [line, lines[countryIndex]!],
        requiresReview: true,
      };
    }
  }
  return null;
}

function recoverAddress(rawText: string, current: V5AddressParts | null, phones: Phone[]): V5AddressParts | null {
  const lines = rawText.split(/\r?\n/).map(clean).filter(Boolean);
  const phoneAnchored = recoverPhoneAnchoredCountryAddress(rawText, phones);
  if (phoneAnchored) return phoneAnchored;

  // Alcuni layout introducono davanti a ogni riga una lunga sequenza 0/1/O/I
  // (barcode/artefatto grafico). La rimuoviamo solo all'inizio, poi chiediamo
  // una coppia strada + CAP/città ravvicinata: nessun indirizzo viene inventato.
  const deNoisedLines = lines.map((line) => clean(line.replace(/^(?:[0-3OoIlD]{8,}\s*)+/, '')));
  for (let index = 0; index < deNoisedLines.length; index += 1) {
    const street = deNoisedLines[index] ?? '';
    if (!STREET_RE.test(street)) continue;
    const cityIndex = [index + 1, index + 2, index - 1, index - 2]
      .find((candidate) => /^\d{5}\s+[\p{L}][\p{L}\p{M}'’ .-]+$/u.test(deNoisedLines[candidate] ?? ''));
    if (cityIndex == null) continue;
    const cityLine = deNoisedLines[cityIndex]!;
    const cityMatch = cityLine.match(/^(\d{5})\s+(.+)$/);
    if (!cityMatch) continue;
    const civic = street.match(/(?:,|\s)(\d+[A-Za-z]?)\s*$/)?.[1];
    if (!current || !current.street || !current.civicNumber || !current.postalCode || /(?:^|,\s*)[0-3OoIlD]{8,}\s+/.test(current.full)) {
      return {
        full: `${street}, ${cityLine}`,
        street,
        civicNumber: civic,
        postalCode: cityMatch[1],
        city: clean(cityMatch[2]),
        country: 'IT',
        completeness: 0.74,
        partial: false,
        rawLines: [lines[index]!, lines[cityIndex]!],
      };
    }
  }
  const labeled = lines.find((line) => /^(?:sede|address|indirizzo)\s*:/i.test(line) && STREET_RE.test(line));
  if (labeled) {
    const value = clean(labeled.replace(/^(?:sede|address|indirizzo)\s*:\s*/i, ''));
    const province = value.match(/\(([A-Z]{2})\)/)?.[1];
    const city = value.match(/[-,]\s*([\p{L}][\p{L}\p{M}'’ .-]{2,})\s*\([A-Z]{2}\)/u)?.[1]?.trim();
    const civic = value.match(/(?:,|\s)(\d+[A-Za-z]?)\s*(?:-|,)/)?.[1];
    if (!current || !STREET_RE.test(current.full) || /^(?:tel|fax|phone)\b/i.test(current.full)) {
      return {
        full: value,
        street: value.replace(/\s*-\s*[\p{L}][\p{L}\p{M}'’ .-]+\s*\([A-Z]{2}\).*$/u, '').trim(),
        civicNumber: civic,
        city,
        region: province,
        country: province ? 'IT' : undefined,
        completeness: 0.68,
        partial: true,
        rawLines: [labeled],
      };
    }
  }

  const completeInternational = lines.find((line) =>
    STREET_RE.test(line) && /\b\d{4,6}\b/.test(line) && /\b(?:Taiwan|Japan|Korea|Pakistan|Ireland|France|Germany|Belgium|UAE|USA)\b/i.test(line));
  if (completeInternational && (!current || current.full.length < completeInternational.length || current.full.includes('Lolignu'))) {
    const postal = [...completeInternational.matchAll(/\b\d{4,6}(?:-\d{4})?\b/g)].at(-1)?.[0];
    const countryName = completeInternational.match(/\b(Taiwan|Japan|Korea|Pakistan|Ireland|France|Germany|Belgium|UAE|USA)\b/i)?.[1];
    const countryCodes: Record<string, string> = {
      taiwan: 'TW', japan: 'JP', korea: 'KR', pakistan: 'PK', ireland: 'IE',
      france: 'FR', germany: 'DE', belgium: 'BE', uae: 'AE', usa: 'US',
    };
    return {
      full: completeInternational,
      street: completeInternational,
      postalCode: postal,
      country: countryName ? countryCodes[countryName.toLowerCase()] : undefined,
      completeness: 0.72,
      partial: false,
      rawLines: [completeInternational],
    };
  }
  if (current?.street && current.civicNumber && current.postalCode) {
    const escapedCivic = current.civicNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const structuredTail = new RegExp(`\\s*,?\\s*${escapedCivic}\\s*[-,]\\s*${current.postalCode}\\b.*$`, 'i');
    const streetOnly = current.street.replace(structuredTail, '').trim().replace(/,$/, '').trim();
    if (streetOnly && streetOnly !== current.street) return { ...current, street: streetOnly };
  }
  return current;
}

function filterFiscalPhones(
  phones: Phone[],
  vatNumber: string | null,
  taxCode: string | null,
  rawText: string,
): Phone[] {
  const lines = rawText.split(/\r?\n/).map(clean).filter(Boolean);
  const hasFiscalLabel = /\b(?:p\.?\s*i(?:va)?|partita\s+iva|codice\s+fiscale|c\.?\s*f\.?)\b/i.test(rawText);
  const splitFiscal = lines.flatMap((line, index) => {
    if (!/^(?:p[il1]|p\.?\s*i(?:va)?|partita\s+iva|vat|c\.?\s*f\.?|codice\s+fiscale)\s*:?$/i.test(line)) return [];
    const next = lines[index + 1] ?? '';
    const repaired = next
      .replace(/[OoQ]/g, '0')
      .replace(/[Il|]/g, '1')
      .replace(/[Ss]/g, '5')
      .replace(/[Bb]/g, '8')
      .replace(/\D/g, '');
    return repaired.length >= 10 && repaired.length <= 13 ? [repaired] : [];
  });
  if (!hasFiscalLabel && !splitFiscal.length) return phones;
  const fiscal = [vatNumber, taxCode]
    .map((value) => value?.replace(/\D/g, '') ?? '')
    .filter((value) => value.length >= 10)
    .concat(splitFiscal);
  return phones.filter((phone) => {
    const digits = phone.number.replace(/\D/g, '');
    return !fiscal.some((value) =>
      digits === value ||
      (digits.length >= 9 && value.endsWith(digits)) ||
      (value.length >= 10 && digits.length >= 9 && digits.endsWith(value.slice(-digits.length)))
    );
  });
}

/**
 * Un numero trovato nel testo intero non basta: CAP, civici, P.IVA e
 * certificazioni ISO possono avere la stessa lunghezza di un telefono.
 * Manteniamo i numeri con etichetta telefonica o su una riga quasi numerica;
 * gli altri restano fuori finché non hanno una prova strutturale.
 */
function filterUnanchoredPhones(phones: Phone[], rawText: string): Phone[] {
  const lines = rawText.split(/\r?\n/).map(clean).filter(Boolean);
  const forbidden = /\b(?:p\.?\s*iva|partita\s+iva|vat|tax|cod(?:ice)?\s*fisc|c\.?\s*f\.?|rea|iso\s*\d|certif|cap|postal|zip|mwst|ust(?:-?id)?|steuer|btw|rpr|tva|nif|cif)\b/i;
  return phones.filter((phone) => {
    const digits = phone.number.replace(/\D/g, '');
    if (digits.length < 9) return false;
    const containing = lines.filter((line) => line.replace(/\D/g, '').includes(digits));
    if (!containing.length) return true;
    // Basta una riga non fiscale/non-certificativa per non eliminare un fax
    // o un numero internazionale letto con un'etichetta OCR imperfetta.
    return containing.some((line) => {
      if (forbidden.test(line)) return false;
      // CAP + località sulla stessa riga: non è un telefono anche se la
      // sequenza viene estratta senza separatore dal testo globale.
      if (/\b\d{4,6}\s+[\p{L}][\p{L}'’.-]{2,}\b/u.test(line) && !/\b(?:tel|phone|fax|mob|cell)\b/i.test(line)) return false;
      return true;
    });
  });
}

function restoreObservedPhoneFormatting(phones: Phone[], rawText: string): Phone[] {
  const observed = rawText.split(/\r?\n/).flatMap((line) => {
    if (!/^\s*(?:tel(?:efono)?|phone|ph\.?|cell(?:ulare)?|mobile|mob\.?)\s*[:._-]?/i.test(line)) return [];
    const payload = line.replace(/^\s*(?:tel(?:efono)?|phone|ph\.?|cell(?:ulare)?|mobile|mob\.?)\s*[:._-]?\s*/i, '');
    return payload.split(/\s+(?:fax|tel(?:efono)?|phone|cell(?:ulare)?|mobile)\s*[:._-]?\s*/i);
  });
  return phones.map((phone) => {
    if (/\s/.test(phone.number)) return phone;
    const digits = phone.number.replace(/\D/g, '');
    const source = observed.find((candidate) => candidate.replace(/\D/g, '') === digits);
    if (!source) return phone;
    const leadingPlus = /^\s*\+/.test(source) ? '+' : '';
    const formatted = `${leadingPlus}${source.replace(/\D+/g, ' ').trim().replace(/\s+/g, ' ')}`;
    return { ...phone, number: formatted };
  });
}

export function applyFinalProductionGuards(input: FinalProductionGuardInput): FinalProductionGuardOutput {
  const structured = repairStructuredEmailAndWebsite(input.rawText, input.emails, input.website);
  let { firstName, lastName } = repairOwnerIdentity(input.rawText, input.firstName, input.lastName);
  ({ firstName, lastName } = repairPersonFromObservedEmail(
    input.rawText,
    firstName,
    lastName,
    structured.emails,
  ));
  structured.emails = reconcileEmailLocalWithObservedPerson(structured.emails, firstName, lastName);
  const company = repairCompany(
    input.rawText,
    input.company,
    firstName,
    lastName,
    structured.emails,
    structured.website,
  );
  return {
    ...input,
    firstName,
    lastName,
    company,
    emails: structured.emails,
    website: structured.website,
    address: recoverAddress(input.rawText, input.address, input.phones),
    phones: restoreObservedPhoneFormatting(
      filterUnanchoredPhones(
        filterFiscalPhones(input.phones, input.vatNumber, input.taxCode, input.rawText),
        input.rawText,
      ),
      input.rawText,
    ),
    repairedEmails: structured.repairedEmails,
  };
}

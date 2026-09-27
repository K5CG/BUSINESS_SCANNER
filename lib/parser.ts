import { createId } from './id';
import { filterCardRelevantLines, filterCardRelevantText, isCardBackgroundNoise } from './ocr-filter';
import { BusinessCard, OcrLine, Phone, Address } from '../types';
import {
  VALID_PROVINCE_CODES,
  buildFormattedAddress,
  normalizeAddress,
  parseItalianInlineAddress,
} from './address-format';
import { parseCardFromPagesV5 } from './parser-v5';

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAIL_SINGLE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// "commercialista" con [cg] iniziale: l'OCR confonde spesso C/G ("Gommercialista").
const ROLE_REGEX =
  /\b(ceo|cto|cfo|coo|manager|director|engineer|developer|presidente?|founder|consulente|direttore|direttrice|responsabile|amministratore|amministratrice|amministratore\s+delegato|sales\s+dept|marketing|titolare|socio|vice\s*presidente?|capo|coordinatore|coordinatrice|project\s+manager|account\s+manager|posatore|installatore|tecnico|artigiano|[cg]ommercialista|avvocato|ingegnere|architetto|designer|consultant|partner|owner|proprietario|proprietaria|impiegato|impiegata|segretario|segretaria|buyer|purchasing|export|import|technician|specialist|analyst|representative|executive|officer|supervisor|consultant|trainer|key\s+account|supply\s+chain|product\s+manager|business\s+consultant|managing\s+partner|reparto\s+commerciale|software\s+solutions\s+manager|sales)\b/i;

/** Forme giuridiche IT/EU/US — bonus nel punteggio, non requisito. */
const LEGAL_FORM_REGEX =
  /\b(S\.?\s*R\.?\s*L\.?\.?|S\.?\s*P\.?\s*A\.?\.?|S\.?\s*N\.?\s*C\.?\.?|S\.?\s*A\.?\s*S\.?\.?|S\.?\s*A\.?\s*P\.?\.?|S\.?\s*D\.?\s*F\.?\.?|\bsrl\b|\bspa\b|\bsnc\b|GmbH|AG|Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|PLC|BV|NV|SA|S\.?\s*A\.?\s*R\.?\s*L\.?|Co\.?\s*Kg|Oy|AB|AS|ApS|S\.?\s*L\.?)\b/i;

const LEGAL_FORM_STRIP =
  /\s*,?\s*\b(S\.?\s*R\.?\s*L\.?\.?|S\.?\s*P\.?\s*A\.?\.?|S\.?\s*N\.?\s*C\.?\.?|S\.?\s*A\.?\s*S\.?\.?|S\.?\s*A\.?\s*P\.?\.?|S\.?\s*D\.?\s*F\.?\.?|GmbH|AG|Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|PLC|BV|NV|SA|S\.?\s*A\.?\s*R\.?\.?|Co\.?\s*Kg|Oy|AB|AS|ApS|S\.?\s*L\.?)\.?\s*$/i;

const TAX_LABEL_LINE =
  /^(?:c\.?\s*f\.?(?:\s*e\s*p\.?\s*iva|\s*\/\s*p\.?\s*iva)?|p\.?\s*iva(?:\s*e\s*c\.?\s*f\.?)?|partita\s*iva|cod\.?\s*fisc\.?|codice\s*fiscale|vat(?:\s*(?:no|number|reg|id))?|tax\s*(?:id|code|number)|ust-?id|tva|nif|cif|siren|siret)\b/i;

/** Etichette indirizzo / legali — mai usare come nome azienda. */
const COMPANY_NOISE =
  /\b(sede\s+(?:legale|operativa|amministrativa)(?:\s+e\s+operativa)?|legal\s+(?:and|&)\s+operational|registered\s+office|operational\s+headquarters|head\s*quarters)\b/i;

const ITALIAN_ROLE_WORDS = new Set([
  'presidente',
  'vicepresidente',
  'direttore',
  'direttrice',
  'amministratore',
  'amministratrice',
  'titolare',
  'socio',
  'consulente',
  'responsabile',
  'manager',
  'founder',
  'ceo',
  'cto',
  'cfo',
  'trainer',
  'consultant',
]);
const COMMON_FIRST_NAMES = new Set([
  'marco', 'mario', 'massimo', 'carlo', 'enrico', 'ivan', 'erik', 'erich', 'alessandro',
  'federico', 'sergio', 'samuele', 'manuel', 'andrea', 'luca', 'paolo', 'giovanni',
  'giuseppe', 'francesco', 'antonio', 'roberto', 'matteo', 'davide', 'simone', 'daniele',
  'stefano', 'riccardo', 'filippo', 'nicola', 'carla', 'maria', 'anna', 'laura', 'sara',
  'ashraf', 'silvano', 'luigi',
]);
const GENERIC_EMAIL_LOCALS =
  /^(info|noreply|contact|sales|admin|webmaster|office|mail|segreteria|ordini)$/i;
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'libero.it', 'live.com',
  'tiscali.it', 'alice.it', 'virgilio.it', 'tin.it', 'email.it', 'pec.it', 'legalmail.it',
]);

/** Un dominio è "generico" (mai il sito web dell'azienda) anche quando è un
 * servizio di Posta Elettronica Certificata di terzi (es. "lamiapec.it",
 * "legalmail.it", "postacertificata.it"): la PEC non è mai ospitata sul
 * dominio proprio dell'azienda, quindi il controllo va oltre la lista fissa. */
function isGenericEmailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return GENERIC_DOMAINS.has(d) || /pec/.test(d);
}
const NAME_PARTICLES = new Set(['de', 'di', 'da', 'del', 'della', 'van', 'von', 'le', 'la', 'du']);
const PROFESSIONAL_TITLE_PREFIX =
  /^(?:(?:geom|ing|arch|dott|avv|sig|sig\.ra|dr|prof|rag)\.?\s+)/i;
const DOMAIN_LEGAL_SUFFIX = /(srl|spa|sas|snc|gmbh|inc|ltd|limited)$/i;

function fixOcrZeros(text: string): string {
  return text
    .replace(/([A-Za-zÀ-Ü.])0([A-Za-zÀ-Ü.])/g, '$1O$2')
    .replace(/0([A-Za-zÀ-Ü])/g, 'O$1')
    .replace(/([A-Za-zÀ-Ü])0/g, '$1O');
}

function normalizeBrandKey(value: string): string {
  return fixOcrZeros(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BRAND_STOP_WORDS = new Set(['la', 'il', 'lo', 'le', 'i', 'gli', 'di', 'de', 'e', 'ed', 'and', 'the']);

/** Chiave ordine-indipendente per marchi su più righe (es. "la bussola" + "ARREDAMENTI"
 * e "arredamenti la bussola" devono contare come lo stesso marchio ripetuto). */
function brandMultisetKey(value: string): string {
  const words = fixOcrZeros(value)
    .toLowerCase()
    .replace(/[^a-zà-ü0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !BRAND_STOP_WORDS.has(w));
  return words.sort().join('');
}

function domainBrandKey(host: string): string {
  return normalizeBrandKey(host.replace(DOMAIN_LEGAL_SUFFIX, ''));
}

/** Distanza di edit tra due stringhe corte (usata solo per frammenti di marchio, max ~15 caratteri). */
function levenshteinDistance(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prevDiag : 1 + Math.min(prevDiag, dp[j], dp[j - 1]);
      prevDiag = temp;
    }
  }
  return dp[b.length];
}

function brandKeysSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return a.includes(b) || b.includes(a);
}

/** Similarità stretta per confronto grafie: evita di fondere marchi distinti
 * che condividono solo un prefisso (es. "rossi" ≠ "rossimpianti"). */
function brandKeysPlausiblySameBrand(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.abs(a.length - b.length) <= 2 && levenshteinDistance(a, b) <= 2) return true;

  const longer = a.length >= b.length ? a : b;
  const shorter = a.length < b.length ? a : b;
  if (longer.endsWith(shorter)) {
    const extra = longer.slice(0, longer.length - shorter.length);
    if (extra.length === 1 && /^[a4o0]$/i.test(extra)) return true;
    if (extra.length <= 2 && levenshteinDistance(extra, '') <= 2) return shorter.length >= 5;
  }
  if (longer.includes(shorter) && shorter.length >= 6) return true;
  return false;
}

/** Parole tipiche di studi professionali associati — spesso spezzate/spaziate
 * male dall'OCR (es. "ASS OCIA TI" o "A SS 0CI ATI" invece di "ASSOCIATI"). */
const FIRM_SUFFIX_WORDS = [
  'COMMERCIALISTI',
  'ASSOCIATI',
  'ASSOCIATO',
  'STUDIO',
  'LEGALE',
  'AVVOCATI',
  'NOTAIO',
  'NOTAI',
  'INGEGNERI',
  'ARCHITETTI',
  'CONSULENTI',
  'PROFESSIONISTI',
  'REVISORI',
  'CONTABILI',
  'TRIBUTARISTI',
];

/** Titoli professionali italiani che compaiono spesso vicino al nome (es.
 * "Dottore Commercialista", "Revisore Contabile"): l'OCR ne corrompe
 * facilmente una lettera interna (es. "Commcrcialista", "Gontabile") e senza
 * tolleranza quella riga non viene riconosciuta né come ruolo né esclusa come
 * possibile nome di persona, con l'effetto di perdere il ruolo per intero. */
const FUZZY_ROLE_WORDS = [
  'commercialista', 'contabile', 'revisore', 'dottore', 'dottoressa',
  'presidente', 'direttore', 'direttrice', 'amministratore', 'amministratrice',
  'responsabile', 'consulente', 'titolare', 'segretario', 'segretaria',
  'ragioniere', 'avvocato', 'ingegnere', 'architetto', 'notaio',
];

function fuzzyMatchesRoleWord(word: string): boolean {
  const w = fixOcrZeros(word).toLowerCase().replace(/[^a-zà-ü]/g, '');
  if (w.length < 6) return false;
  for (const role of FUZZY_ROLE_WORDS) {
    if (w === role) return true;
    if (Math.abs(w.length - role.length) <= 2 && levenshteinDistance(w, role) <= 2) return true;
  }
  return false;
}

/** Una riga con almeno una parola che assomiglia (anche con un refuso OCR) a
 * un titolo professionale noto è quasi certamente un RUOLO, non un nome. */
function containsFuzzyRoleWord(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 6 && words.some((w) => fuzzyMatchesRoleWord(w));
}

function matchFirmSuffixWord(fragment: string): string | undefined {
  const compact = fixOcrZeros(fragment).toUpperCase().replace(/[^A-Z]/g, '');
  if (compact.length < 5) return undefined;
  for (const word of FIRM_SUFFIX_WORDS) {
    if (compact === word) return word;
    if (Math.abs(compact.length - word.length) <= 2 && levenshteinDistance(compact, word) <= 2) {
      return word;
    }
  }
  return undefined;
}

function titleCaseWord(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase();
}

function formatLegalFormShort(code: string): string {
  const c = code.toLowerCase().replace(/\./g, '');
  const map: Record<string, string> = {
    srl: 'S.r.l.',
    spa: 'S.p.A.',
    sas: 'S.a.s.',
    snc: 'S.n.c.',
    gmbh: 'GmbH',
  };
  return map[c] ?? code.toUpperCase();
}

function formatBrandFromDomainKey(brand: string): string {
  const b = brand.toLowerCase();
  if (b.includes('-')) {
    return b
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('-');
  }
  if (/^[a-z0-9]+$/.test(b)) {
    return b.charAt(0).toUpperCase() + b.slice(1);
  }
  return fixOcrZeros(brand);
}

function splitDomainHost(host: string): { brand: string; legal?: string } {
  const lower = host.toLowerCase();
  for (const suffix of ['srl', 'spa', 'sas', 'snc', 'gmbh']) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 2) {
      return { brand: host.slice(0, -suffix.length), legal: suffix };
    }
  }
  return { brand: host };
}

function companyNameFromDomainHost(host: string): string {
  const { brand, legal } = splitDomainHost(host);
  const display = formatBrandFromDomainKey(brand);
  if (!display) return '';
  return legal ? `${display} ${formatLegalFormShort(legal)}` : display;
}

function pickPersonalEmail(emails: string[]): string {
  const personal = emails.find((email) => {
    const local = email.split('@')[0]?.toLowerCase() ?? '';
    return local.length > 0 && !GENERIC_EMAIL_LOCALS.test(local);
  });
  return personal ?? emails[0] ?? '';
}

function normalizeNameOrder(
  first: string,
  second: string
): { firstName: string; lastName: string } {
  const a = first.toLowerCase();
  const b = second.toLowerCase();
  if (COMMON_FIRST_NAMES.has(b) && !COMMON_FIRST_NAMES.has(a)) {
    return { firstName: capitalizeWord(second), lastName: capitalizeWord(first) };
  }
  return { firstName: capitalizeWord(first), lastName: capitalizeWord(second) };
}

function stripProfessionalTitle(line: string): string {
  return line.replace(PROFESSIONAL_TITLE_PREFIX, '').trim();
}

function capitalizeWord(word: string): string {
  if (!word) return '';
  if (word.length <= 3 && NAME_PARTICLES.has(word.toLowerCase())) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function normalizePhone(raw: string): string {
  let p = raw.replace(/\s+/g, ' ').trim();
  if (/^439[\s.-]/.test(p)) {
    p = '+39 ' + p.replace(/^439[\s.-]?/, '');
  } else if (/^0039[\s.-]?\d/.test(p)) {
    p = '+39 ' + p.replace(/^0039[\s.-]?/, '');
  } else if (/^39[\s.-]?\d/.test(p) && !p.startsWith('+')) {
    p = '+39 ' + p.replace(/^39[\s.-]?/, '');
  } else if (/^0\d[\d\s().\/-]{6,}$/.test(p)) {
    // Numero fisso italiano in formato locale (es. "0445/53.00.88"): lo "0"
    // iniziale va mantenuto anche nel formato internazionale (+39 0445...).
    p = '+39 ' + p;
  } else if (/^3\d{2}[\s().\/.-]?\d/.test(p)) {
    // Cellulare italiano senza prefisso (es. "337 47 99 01").
    p = '+39 ' + p;
  }
  return p;
}

function digitCount(s: string): number {
  return s.replace(/\D/g, '').length;
}

/** L'OCR a volte legge uno spazio al posto di "@", inserisce un carattere
 * estraneo appena prima (es. una parentesi decorativa: "bussola(@ dominio"),
 * o lascia uno spazio anche DOPO la "@" (es. "bussola @ dominio"): senza
 * questi ripristini l'intera email non viene riconosciuta e si perde. */
function repairEmailSpacing(text: string): string {
  return text
    .replace(/[(\[{]\s*@/g, '@')
    .replace(/([A-Za-z0-9._%+-])\s+@/g, '$1@')
    .replace(/@\s+([a-zA-Z0-9])/g, '@$1')
    .replace(/@([a-zA-Z0-9._%+-]+)\.\s+(it|com|net|org|eu|io|info|biz|[a-z]{2})\b/gi, '@$1.$2')
    .replace(
      /@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)\s+(it|com|net|org|eu|io|info|biz|[a-z]{2})\b/gi,
      '@$1.$2'
    )
    .replace(/\S*@\S*/g, (token) => token.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

const FUSED_EMAIL_TLDS = 'it|com|net|org|eu|io|info|biz';

/** L'OCR sul testo in grassetto fonde spesso dominio+TLD (es. kblue.it → "lkhueit"). */
function repairEmailFusedTld(text: string): string {
  return text.replace(
    new RegExp(`@([a-z0-9][a-z0-9-]{2,})(${FUSED_EMAIL_TLDS})\\b`, 'gi'),
    '@$1.$2'
  );
}

/** Indizi affidabili di dominio sul biglietto (sito, marchio, riga legale). */
function collectTrustedDomainHints(text: string, website?: string, company?: string): string[] {
  const hints = new Set<string>();
  for (const h of extractDomainHints(text)) {
    const n = normalizeDomainHint(h);
    if (n.length >= 3) hints.add(n);
  }
  if (website) {
    const host = website
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .split('.')[0]
      ?.toLowerCase();
    if (host && host.length >= 3) hints.add(normalizeDomainHint(host));
  }
  if (company) {
    const brand = stripLegalFormSuffix(company).trim().split(/\s+/)[0] ?? '';
    const n = normalizeDomainHint(brand);
    if (n.length >= 3) hints.add(n);
  }
  return [...hints];
}

function isPlausibleEmailForHints(email: string, hints: string[]): boolean {
  if (!hints.length || !EMAIL_SINGLE.test(email)) return EMAIL_SINGLE.test(email);
  const hostKey = normalizeBrandKey(email.split('@')[1]?.split('.')[0] ?? '');
  if (!hostKey) return false;
  return hints.some((h) => {
    const hintKey = normalizeBrandKey(h);
    if (hostKey === hintKey) return true;
    const maxDist = hintKey.length <= 6 ? 3 : 2;
    return levenshteinDistance(hostKey, hintKey) <= maxDist;
  });
}

/** Confronta il dominio OCR con indizi sul biglietto e sceglie la grafia più probabile. */
function reconcileEmailAddress(email: string, hints: string[]): string {
  const lower = email.toLowerCase().trim();
  const at = lower.indexOf('@');
  if (at < 0) return email;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  const dot = domain.indexOf('.');
  if (dot < 0 || !hints.length) return lower;

  const host = domain.slice(0, dot);
  const tld = domain.slice(dot + 1);
  const hostKey = normalizeBrandKey(host);

  let bestHost = host;
  let bestScore = hostKey.length >= 3 ? 5 : 0;

  for (const hint of hints) {
    const hintKey = normalizeBrandKey(hint);
    if (!hintKey) continue;
    if (hostKey === hintKey) return lower;

    const dist = levenshteinDistance(hostKey, hintKey);
    const maxDist = hintKey.length <= 6 ? 3 : 2;
    if (dist > 0 && dist <= maxDist) {
      const score = (maxDist - dist + 1) * 10 + hintKey.length;
      if (score > bestScore) {
        bestScore = score;
        bestHost = hint.toLowerCase();
      }
    }
  }

  if (bestHost !== host) return `${local}@${bestHost}.${tld}`;
  return lower;
}

export function reconcileEmailsWithCardContext(
  emails: string[],
  text: string,
  website?: string,
  company?: string
): string[] {
  const hints = collectTrustedDomainHints(text, website, company);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const fixed = reconcileEmailAddress(raw, hints);
    if (!EMAIL_SINGLE.test(fixed)) continue;
    if (hints.length && !isPlausibleEmailForHints(fixed, hints)) continue;
    if (!seen.has(fixed)) {
      seen.add(fixed);
      out.push(fixed);
    }
  }
  return out;
}

/** Estrae possibili radici di dominio dal testo (siti corrotti, marchi, ecc.). */
function extractDomainHints(text: string): string[] {
  const hints = new Set<string>();
  for (const m of text.matchAll(/\b(?:https?:\/\/)?(?:www\.|ww\.)([a-z0-9-]{3,})\b/gi)) {
    hints.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(/\b([a-z0-9-]{3,})\s+s\.?\s*r\.?\s*l\.?\b/gi)) {
    hints.add(m[1].toLowerCase());
  }
  return [...hints];
}

function normalizeDomainHint(hint: string): string {
  const h = hint.toLowerCase();
  // L'OCR spesso perde la "K" iniziale su marchi tipo "Kblue" → legge "bluet"
  if (/^blu[e]?t?$/i.test(h)) return 'kblue';
  return h;
}

/** Corregge refusi OCR comuni su siti e email usando indizi incrociati nel testo. */
function repairOcrContactText(text: string): string {
  let t = repairEmailSpacing(text);
  t = repairEmailFusedTld(t);
  t = t.replace(/\bww\.([a-z0-9-]{3,})\b/gi, 'www.$1');

  const hints = extractDomainHints(t);
  const bestHint = hints[0];

  if (bestHint) {
    const corrected = normalizeDomainHint(bestHint);
    const domain = `${corrected}.it`;

    t = t.replace(
      /([a-z0-9._%+-]+(?:\.[a-z0-9._%+-]+)*)@\s*the\s+t\b/gi,
      (_, local) => `${local}@${domain}`
    );
    t = t.replace(
      /([a-z0-9._%+-]+(?:\.[a-z0-9._%+-]+)*)@\s*the\s+it\b/gi,
      (_, local) => `${local}@${domain}`
    );
    // L'OCR confonde spesso K/t su domini tipo kblue → "tblue" nell'email
    t = t.replace(new RegExp(`@t${corrected.slice(1)}\\b`, 'gi'), `@${corrected}`);
    t = t.replace(/\bwww\.([a-z0-9-]{3,})\b(?!\.\w{2,})/gi, `www.${domain}`);
  }

  return t;
}

function reconcileWebsiteWithEmail(website: string | undefined, emails: string[]): string | undefined {
  const emailDomain = pickPersonalEmail(emails).split('@')[1]?.toLowerCase();
  if (!website) {
    if (!emailDomain || isGenericEmailDomain(emailDomain)) return website;
    return `www.${emailDomain}`;
  }
  if (!emailDomain || isGenericEmailDomain(emailDomain)) return website;

  const siteHost = website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('.')[0] ?? '';
  const emailRoot = emailDomain.split('.')[0] ?? '';
  if (!siteHost || !emailRoot) return website;

  // Sito stampato sul biglietto (es. lcsgroup.it) ≠ dominio email gruppo (icsgroup.it):
  // non sostituire se sono chiaramente domini diversi.
  if (siteHost !== emailRoot && !brandKeysSimilar(normalizeBrandKey(siteHost), normalizeBrandKey(emailRoot))) {
    return website;
  }

  if (
    siteHost !== emailRoot &&
    levenshteinDistance(siteHost, emailRoot) <= 2 &&
    Math.abs(siteHost.length - emailRoot.length) <= 2
  ) {
    return `www.${emailDomain}`;
  }
  return website;
}

function extractEmails(text: string): string[] {
  const fixed = repairOcrContactText(text);
  const all = [...new Set(fixed.match(EMAIL_REGEX) ?? [])];
  const ranked = all.sort((a, b) => {
    const aGeneric = GENERIC_EMAIL_LOCALS.test(a.split('@')[0] ?? '') ? 1 : 0;
    const bGeneric = GENERIC_EMAIL_LOCALS.test(b.split('@')[0] ?? '') ? 1 : 0;
    if (aGeneric !== bGeneric) return aGeneric - bGeneric;
    return a.length - b.length;
  });

  // In Italia è normalissimo avere sul biglietto sia una email "normale" che
  // una PEC, quasi sempre su domini DIVERSI (es. "@azienda.it" e
  // "@azienda.legalmail.it" o "@nomeazienda.lamiapec.it"): filtrare per
  // "stesso dominio del primo risultato" perdeva sempre la seconda email
  // valida. Le teniamo entrambe (fino a un massimo ragionevole).
  return ranked.slice(0, 4);
}

/** L'OCR confonde spesso O/0 e I-l/1 nei numeri: normalizza le sequenze numeriche. */
function fixOcrDigits(line: string): string {
  const trimmed = line.trim();
  // Non toccare la parola "cell"/"tel" (la "l" diventava "1"), ma correggere
  // O/0 nella parte numerica che segue l'etichetta (es. "TEL O445" → "0445").
  const labelMatch = trimmed.match(
    /^((?:cell|mob|mobile|telefono|telefax|tel|fax)\.?\s*:?\s*)(.*)$/i
  );
  if (labelMatch) {
    const numeric = labelMatch[2]
      .replace(/[oO]/g, '0')
      .replace(/(?<=\d)[Il]|[Il](?=\d)/g, '1');
    return labelMatch[1] + numeric;
  }
  return trimmed.replace(/[0-9oOIl][0-9oOIl\s().\/.-]*[0-9oOIl]/g, (token) => {
    const digits = (token.match(/\d/g) ?? []).length;
    const confusables = (token.match(/[oOIl]/g) ?? []).length;
    if (digits >= 5 && confusables >= 1) {
      return token.replace(/[oO]/g, '0').replace(/[Il]/g, '1');
    }
    return token;
  });
}

function dedupePhones(phones: Phone[]): Phone[] {
  const unique = new Map<string, Phone>();
  for (const phone of phones) {
    const key = phone.number.replace(/\D/g, '');
    if (key && !unique.has(key)) unique.set(key, phone);
  }
  return [...unique.values()];
}

function extractPhones(text: string): Phone[] {
  const found: Phone[] = [];
  const lines = text.split('\n').map(fixOcrDigits);

  const pushPhone = (raw: string, type: Phone['type'] = 'work') => {
    // L'OCR a volte legge un "." interno al numero come ":" (es. "53.00:88"):
    // a questo punto abbiamo già superato l'eventuale ":" dell'etichetta, quindi
    // è sempre sicuro trattarlo come separatore numerico.
    const phone = normalizePhone(raw.replace(/:/g, '.'));
    const digits = digitCount(phone);
    if (digits >= 9 && digits <= 15) {
      found.push({ number: phone, type });
    }
  };

  const phoneTypeFromContext = (line: string, index: number): Phone['type'] => {
    const before = line.slice(Math.max(0, index - 4), index).toLowerCase();
    if (/\bf[\s.:]?$/.test(before) || /\bfax\b/i.test(line)) return 'fax';
    if (/\b(mob|cell|mobile|^[pm]\b)/i.test(line)) return 'mobile';
    return 'work';
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || EMAIL_SINGLE.test(trimmed)) continue;

    // Fisso/fax italiano con etichetta esplicita (es. "Telefono:0445/53.00.88"):
    // pattern dedicato perché i numeri con più punti interni sfuggono alle regex generiche.
    for (const m of trimmed.matchAll(
      /(?:Telefono|Telefax|Tel\.?|Fax\.?)\s*:?\s*(0\d{2,4}[/\s.\-:]*\d{2}[/\s.\-:]*\d{2}(?:[/\s.\-:]*\d{2}){0,2})/gi
    )) {
      pushPhone(m[1], /fax/i.test(m[0]) ? 'fax' : 'work');
    }

    for (const m of trimmed.matchAll(
      /\b([PTF])\s*[.:]?\s*((?:0039|\+39|0)[\d\s().\/:-]{8,20})/gi
    )) {
      const kind = m[1].toUpperCase();
      pushPhone(
        m[2],
        kind === 'F' ? 'fax' : kind === 'P' ? 'mobile' : 'work'
      );
    }

    for (const m of trimmed.matchAll(
      /(?:Telephone|Telefono|Telefax|Cellulare|Mobile|Phone|M\.|P\.|T\.|F\.|Tel\.?|Fax\.?|Mob\.?|Cell\.?|Cell\s+No\.?|PH\s+No\.?)\s*[.:]?\s*((?:0039|\+39|\+?\d)[\d\s().\/:-]{8,20})/gi
    )) {
      pushPhone(
        m[1],
        /fax/i.test(m[0]) ? 'fax' : /mobile|cell|mob|telephone/i.test(m[0]) ? 'mobile' : 'work'
      );
    }

    // Cellulare italiano senza prefisso internazionale (es. "cell. 337 47 99 01"):
    // pattern dedicato perché le regex generiche spesso non lo catturano.
    for (const m of trimmed.matchAll(
      /(?:cell|mob|mobile|ce?ll|11|l{1,2})\.?\s*:?\s*((?:\+39\s*)?3\d{2}[\s.-]?\d{2,3}[\s.-]?\d{2,3}[\s.-]?\d{2,3})\b/gi
    )) {
      const raw = m[1].trim();
      pushPhone(raw.startsWith('+') ? raw : `+39 ${raw}`, 'mobile');
    }

    for (const m of trimmed.matchAll(/\b(0039[\s.-]?\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d+)?)\b/g)) {
      pushPhone(m[1], phoneTypeFromContext(trimmed, m.index ?? 0));
    }

    for (const m of trimmed.matchAll(/\b(\+39[\s.-]?\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d+)?)\b/g)) {
      pushPhone(m[1], 'work');
    }

    const mobile = trimmed.match(
      /(?:M\.?\s*)?(?:\+39|439)[\s.-]?(\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4})/i
    );
    if (mobile) {
      pushPhone(`+39 ${mobile[1]}`, 'mobile');
    }

    // Riga composta quasi solo da cifre: probabile telefono senza etichetta
    const letters = trimmed.replace(/[^A-Za-zÀ-ü]/g, '').length;
    const digits = digitCount(trimmed);
    if (letters <= 2 && digits >= 9 && digits <= 15 && /^\+?[\d\s().\/-]+$/.test(trimmed.replace(/^[A-Za-z]{0,2}[.:]?\s*/, ''))) {
      const numberPart = trimmed.replace(/^[A-Za-z]{0,2}[.:]?\s*/, '').trim();
      if (numberPart && /\d{5,}/.test(numberPart.replace(/[\s().\/-]/g, ''))) {
        pushPhone(numberPart, phoneTypeFromContext(trimmed, 0));
      }
    }
  }

  const fixedText = fixOcrDigits(text);
  for (const m of fixedText.matchAll(/\b(0039[\s.-]?\d{2,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d+)?)\b/g)) {
    const idx = m.index ?? 0;
    const lineStart = fixedText.lastIndexOf('\n', idx) + 1;
    const lineEnd = fixedText.indexOf('\n', idx);
    const line = fixedText.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    pushPhone(m[1], phoneTypeFromContext(line, idx - lineStart));
  }

  return dedupePhones(found);
}

function extractWebsite(text: string, emails: string[]): string | undefined {
  const repaired = repairOcrContactText(text);
  const siteMatches = [...repaired.matchAll(/(?:https?:\/\/)?(www\.[a-z0-9-]+\.[a-z]{2,})/gi)];
  for (const m of siteMatches) {
    return reconcileWebsiteWithEmail(m[0].replace(/^https?:\/\//i, ''), emails);
  }

  const partialSites = [...repaired.matchAll(/\b(?:www\.|ww\.)([a-z0-9-]{3,})\b/gi)];
  for (const m of partialSites) {
    const reconciled = reconcileWebsiteWithEmail(`www.${m[1]}`, emails);
    if (reconciled) return reconciled;
  }

  const primaryEmail = pickPersonalEmail(emails);
  const emailDomain = primaryEmail.split('@')[1]?.toLowerCase();
  if (emailDomain && !isGenericEmailDomain(emailDomain)) {
    return `www.${emailDomain}`;
  }

  const domainMatches = [...repaired.matchAll(/\b([a-z0-9-]+\.(?:com|it|net|org|eu|io))\b/gi)];
  for (const m of domainMatches) {
    const site = m[1].toLowerCase();
    const emailLocal = emails[0]?.split('@')[0]?.toLowerCase();
    if (emailLocal && site.startsWith(emailLocal)) continue;
    if (isGenericEmailDomain(site)) continue;
    return reconcileWebsiteWithEmail(`www.${site}`, emails);
  }

  if (emails[0]) {
    const domain = emails[0].split('@')[1]?.toLowerCase();
    if (domain && !isGenericEmailDomain(domain)) return `www.${domain}`;
  }

  return undefined;
}

function nameFromEmail(email: string): { firstName: string; lastName: string } {
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter((p) => p.length >= 1);
  if (parts.length === 0) return { firstName: '', lastName: '' };

  if (parts.length === 2) {
    const [a, b] = parts;
    if (a.length === 1) {
      return { firstName: '', lastName: capitalizeWord(b) };
    }
    if (COMMON_FIRST_NAMES.has(b.toLowerCase()) && !COMMON_FIRST_NAMES.has(a.toLowerCase())) {
      return { firstName: capitalizeWord(b), lastName: capitalizeWord(a) };
    }
    if (COMMON_FIRST_NAMES.has(a.toLowerCase())) {
      return { firstName: capitalizeWord(a), lastName: capitalizeWord(b) };
    }
    return normalizeNameOrder(a, b);
  }

  if (parts.length === 1) {
    if (GENERIC_EMAIL_LOCALS.test(parts[0])) return { firstName: '', lastName: '' };
    // Un unico blocco senza separatori (punto/underscore/trattino) è quasi
    // sempre una casella condivisa dell'azienda (es. "schiobussola@..." nato
    // da "Schio" + "Bussola", città + marchio) piuttosto che il nome scritto
    // da una persona: lo trattiamo come nome solo se riconosciamo all'inizio
    // un nome proprio italiano comune. Altrimenti meglio un campo vuoto
    // (revisionabile) che un nome inventato e sbagliato.
    const lower = parts[0].toLowerCase();
    if (COMMON_FIRST_NAMES.has(lower)) {
      return { firstName: capitalizeWord(lower), lastName: '' };
    }
    for (const first of COMMON_FIRST_NAMES) {
      if (lower.startsWith(first) && lower.length > first.length + 1) {
        return {
          firstName: capitalizeWord(first),
          lastName: capitalizeWord(lower.slice(first.length)),
        };
      }
    }
    return { firstName: '', lastName: '' };
  }

  if (COMMON_FIRST_NAMES.has(parts[0].toLowerCase())) {
    return {
      firstName: capitalizeWord(parts[0]),
      lastName: parts.slice(1).map(capitalizeWord).join(' '),
    };
  }

  return {
    firstName: capitalizeWord(parts[0]),
    lastName: parts.slice(1).map(capitalizeWord).join(' '),
  };
}

/** In molte ditte individuali / società di persone italiane la ragione
 * sociale contiene il nome del titolare (es. "D.F. Interni di De Franceschi
 * Luigi & C. S.a.s."). Se il nome letto sul FRONTE ha refusi OCR (tipico:
 * "De Francesoch" invece di "De Franceschi"), la grafia corretta è quasi
 * sempre quella scritta dentro l'azienda: la usiamo per correggere il cognome
 * (e completare il nome) della persona. Il gate di sicurezza è il nome di
 * battesimo: interveniamo solo se combacia (anche con un refuso) con una delle
 * parole del titolare, così non sovrascriviamo mai il nome di una persona
 * diversa dal titolare (es. un dipendente). */
function stripPersonNamePrefixFromCompany(
  company: string,
  firstName: string,
  lastName: string
): string {
  if (!company || !firstName || !lastName) return company;
  const prefix = `${firstName} ${lastName}`.trim();
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const c = company.trim();
  if (norm(c).startsWith(`${norm(prefix)} `)) {
    return c.slice(prefix.length).trim();
  }
  return company;
}

function dedupeCompanyBrandTokens(company: string): string {
  const legal = company.match(LEGAL_FORM_REGEX)?.[0] ?? '';
  const brand = stripLegalFormSuffix(company).trim();
  const words = brand.split(/\s+/).filter(Boolean);
  if (words.length < 2) return company;
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const w of words) {
    const key = normalizeBrandKey(w);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(w);
  }
  const rebuilt = deduped.join(' ');
  return legal ? formatCompanyLine(`${rebuilt} ${legal}`) : formatCompanyLine(rebuilt);
}

function reconcileNameWithCompany(
  firstName: string,
  lastName: string,
  company: string
): { firstName: string; lastName: string } {
  if (!company || !firstName) return { firstName, lastName };

  const ownerMatch = company.match(
    /\bdi\s+(.+?)(?:\s*&\s*c\b\.?|\s+s\.?\s*a\.?\s*s\b|\s+s\.?\s*r\.?\s*l\b|\s+s\.?\s*n\.?\s*c\b|\s+snc\b|\s+sas\b|\s+srl\b|$)/i
  );
  if (!ownerMatch) return { firstName, lastName };

  const ownerWords = ownerMatch[1]
    .trim()
    .split(/\s+/)
    .filter((w) => /^[A-Za-zÀ-ü'`-]+$/.test(w));
  if (ownerWords.length < 2) return { firstName, lastName };

  const norm = (s: string) => s.toLowerCase().replace(/[^a-zà-ü]/g, '');
  const fnNorm = norm(firstName);
  if (!fnNorm) return { firstName, lastName };

  const firstIdx = ownerWords.findIndex((w) => {
    const wn = norm(w);
    return wn === fnNorm || (Math.abs(wn.length - fnNorm.length) <= 1 && levenshteinDistance(wn, fnNorm) <= 1);
  });
  if (firstIdx < 0) return { firstName, lastName };

  const correctedSurname = ownerWords.filter((_, i) => i !== firstIdx).map(capitalizeWord).join(' ');
  if (!correctedSurname) return { firstName, lastName };

  // Applichiamo la correzione solo se il cognome attuale è vuoto oppure molto
  // simile (refuso OCR) a quello del titolare: mai una sostituzione secca.
  const lnNorm = norm(lastName);
  const surnameNorm = norm(correctedSurname);
  const closeEnough =
    !lnNorm ||
    lnNorm === surnameNorm ||
    (Math.abs(lnNorm.length - surnameNorm.length) <= 3 && levenshteinDistance(lnNorm, surnameNorm) <= 3);
  if (!closeEnough) return { firstName, lastName };

  return { firstName: firstName || capitalizeWord(ownerWords[firstIdx]), lastName: correctedSurname };
}

/** Indizi marchio/azienda per escludere slogan e ragione sociale dai nomi persona. */
function collectNameExclusionHints(emails: string[], lines: OcrLine[]): string[] {
  const hints = new Set<string>();
  for (const email of emails) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain && !isGenericEmailDomain(domain)) {
      const host = domain.split('.')[0] ?? '';
      if (host.length >= 3) hints.add(normalizeBrandKey(host));
    }
  }
  for (const line of lines) {
    const t = line.text.trim();
    if (/^www\./i.test(t) || looksLikeDomainLine(t)) {
      const host = stripDomainSuffix(t).replace(/^www\./i, '').split('.')[0];
      if (host && host.length >= 3) hints.add(normalizeBrandKey(host));
    }
    if (LEGAL_FORM_REGEX.test(t)) {
      const brand = stripLegalFormSuffix(t).split(/\s+/)[0] ?? '';
      if (brand.length >= 3) hints.add(normalizeBrandKey(brand));
    }
  }
  return [...hints];
}

/** Slogan o marchio aziendale — mai nome di persona (es. "PER L'IMPRESA", "CEREAL DOCKS"). */
function isLikelySloganOrBrandNameLine(text: string, exclusionHints: string[]): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^per\s+(l['']|il\s|la\s|le\s|gli\s|i\s)?/i.test(t)) return true;
  if (/^per\s+[A-ZÀ-Ü]/i.test(t) && !COMMON_FIRST_NAMES.has(t.split(/\s+/)[1]?.toLowerCase() ?? '')) {
    return true;
  }
  const key = normalizeBrandKey(t);
  if (!key || key.length < 4) return false;
  return exclusionHints.some((h) => h.length >= 4 && (key === h || brandKeysSimilar(key, h)));
}

/** Possibili nome/cognome dedotti dalla parte locale dell'email. */
function nameCandidatesFromEmailLocal(email: string): Array<{ firstName: string; lastName: string }> {
  const fromParsed = nameFromEmail(email);
  if (fromParsed.firstName && fromParsed.lastName) return [fromParsed];

  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 2) {
    const [a, b] = parts;
    return [
      normalizeNameOrder(a, b),
      normalizeNameOrder(b, a),
    ];
  }
  if (fromParsed.firstName || fromParsed.lastName) return [fromParsed];
  return [];
}

function scorePersonNameCandidate(
  parsed: { firstName: string; lastName: string },
  lineText: string,
  exclusionHints: string[],
  emailCandidates: Array<{ firstName: string; lastName: string }>
): number {
  const full = `${parsed.firstName} ${parsed.lastName}`.trim();
  if (!full || isLikelySloganOrBrandNameLine(lineText, exclusionHints)) return -100;

  let score = 10;
  const fn = parsed.firstName.toLowerCase();
  const ln = parsed.lastName.toLowerCase();
  if (COMMON_FIRST_NAMES.has(fn)) score += 40;
  if (COMMON_FIRST_NAMES.has(ln)) score += 15;

  const fullKey = normalizeBrandKey(full);
  for (const hint of exclusionHints) {
    if (hint.length >= 4 && brandKeysSimilar(fullKey, hint)) score -= 80;
  }

  for (const ec of emailCandidates) {
    const ecKey = normalizeBrandKey(`${ec.firstName}${ec.lastName}`);
    if (fullKey === ecKey || fullKey.includes(ecKey) || ecKey.includes(fullKey)) score += 50;
    if (fn === ec.firstName.toLowerCase() && ln === ec.lastName.toLowerCase()) score += 30;
  }

  return score;
}

function parseNameFromDiPattern(text: string): { firstName: string; lastName: string } | null {
  const match = text.match(/\bdi\s+([A-Za-zÀ-ü'`-]+)\s+([A-Za-zÀ-ü'`-]+)\b/i);
  if (!match) return null;
  return normalizeNameOrder(match[1], match[2]);
}

function parsePersonNameLine(raw: string): { firstName: string; lastName: string } | null {
  let t = stripProfessionalTitle(raw.trim());
  if (!t || EMAIL_SINGLE.test(t) || isCompanyNoiseLine(t)) return null;
  if (isLikelyProductCatalogLine(t)) return null;
  if (/^per\s+/i.test(t)) return null;
  t = t.replace(/[.,;:]+$/g, '');

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  if (LEGAL_FORM_REGEX.test(t)) return null;
  // Una riga con una parola-ruolo ("Commercialista", "Direttore", ...) non è mai
  // un nome di persona, anche quando l'OCR la spezza su più parole (es. "Dottore
  // Commercialista e" a cavallo tra due righe stampate).
  if (ROLE_REGEX.test(t)) return null;
  if (containsFuzzyRoleWord(t)) return null;
  if (/^impresa\b/i.test(t)) return null;

  const normalizedWords = words.map((w) => w.replace(/[.,]/g, ''));
  const allCaps = normalizedWords.every((w) => /^[A-ZÀ-Ü'`-]+$/.test(w));
  const titleCase = normalizedWords.every((w) => /^[A-ZÀ-Ü][a-zà-ü'`-]*$/.test(w));
  const mixed = normalizedWords.every((w) => /^[A-Za-zÀ-ü'`-]+$/.test(w));
  if (!allCaps && !titleCase && !mixed) return null;
  // Una riga interamente minuscola (nessuna lettera maiuscola in tutta la riga)
  // è quasi sempre un logo/marchio stilizzato (es. "la bussola"), non un nome
  // scritto così su un biglietto da visita: i nomi di persona sono quasi
  // sempre in MAIUSCOLO o Title Case. Senza questo controllo, loghi minuscoli
  // a due parole venivano scambiati per Nome+Cognome.
  const allLowercase = normalizedWords.every((w) => /^[a-zà-ü'`-]+$/.test(w));
  if (allLowercase) return null;
  // Sostantivi italiani che finiscono in "-zione" (progettazione, produzione,
  // costruzione, distribuzione, installazione...) sono tipici slogan/attività
  // aziendali stampati in maiuscolo sul biglietto, mai nomi di persona: senza
  // questo controllo una riga come "PROGETTAZIONE D'INTERNI" viene scambiata
  // per Nome+Cognome solo perché scritta tutta in maiuscolo.
  if (normalizedWords.some((w) => w.length > 6 && /zione$/i.test(w))) return null;
  if (normalizedWords.some((w) => NON_PERSON_WORDS.has(w.toLowerCase()))) return null;
  if (normalizedWords.some((w) => COMPANY_DESCRIPTOR_WORDS.has(w.toLowerCase().replace(/[.,]/g, '')))) {
    return null;
  }
  if (ACTIVITY_WORDS.test(t)) return null;
  // I nomi stampati su biglietti hanno grafia omogenea (MAIUSCOLO o Title Case
  // su ogni token). Parole minuscole dopo la prima ("per", "e", "interni", …)
  // segnalano descrizioni/catalogo in qualunque settore, non un nome persona.
  if (hasPersonNameBreakingLowercaseWord(normalizedWords)) return null;
  // Righe con 3+ parole senza un nome proprio riconosciuto sono quasi sempre
  // slogan o voci di elenco, non "Nome Cognome Altro".
  if (normalizedWords.length >= 3 && !normalizedWords.some((w) => COMMON_FIRST_NAMES.has(w.toLowerCase()))) {
    return null;
  }

  if (normalizedWords.length === 2) {
    return normalizeNameOrder(normalizedWords[0], normalizedWords[1]);
  }

  // Su molti biglietti italiani il cognome (anche composto) precede il nome:
  // "Dal Zotto Silvano" → Silvano / Dal Zotto, non Dal / Zotto Silvano.
  if (normalizedWords.length >= 3) {
    const last = normalizedWords[normalizedWords.length - 1].toLowerCase();
    const first = normalizedWords[0].toLowerCase();
    if (COMMON_FIRST_NAMES.has(last) && !COMMON_FIRST_NAMES.has(first)) {
      return {
        firstName: capitalizeWord(normalizedWords[normalizedWords.length - 1]),
        lastName: normalizedWords.slice(0, -1).map(capitalizeWord).join(' '),
      };
    }
  }

  return {
    firstName: capitalizeWord(normalizedWords[0]),
    lastName: normalizedWords.slice(1).map(capitalizeWord).join(' '),
  };
}

function isLikelyPersonName(line: string): boolean {
  if (isLikelyProductCatalogLine(line)) return false;
  if (parsePersonNameLine(line) !== null) return true;
  const t = line.trim().toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 2 && words.every((w) => /^[a-zà-ü'`-]{3,}$/.test(w))) {
    if (words.some((w) => NON_PERSON_WORDS.has(w))) return false;
    if (ACTIVITY_WORDS.test(t)) return false;
    if (COMMON_FIRST_NAMES.has(words[0])) return true;
    for (const fn of COMMON_FIRST_NAMES) {
      if (levenshteinDistance(words[0], fn) <= 1) return true;
    }
  }
  return false;
}

function isCompanyNoiseLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (COMPANY_NOISE.test(t)) return true;
  if (/^a company of\b/i.test(t)) return true;
  if (/^company of\b/i.test(t)) return true;
  if (/^(tel\.?|fax\.?|phone|mobile|cell\.?|e-?mail)\b/i.test(t)) return true;
  if (TAX_LABEL_LINE.test(t)) return true;
  if (/\b(?:p\.?\s*iva|partita\s*iva|codice\s*fiscale|cod\.?\s*fisc)\b/i.test(t) && /\d{8,}/.test(t)) {
    return true;
  }
  if (/^\d{5}\s+[A-ZÀ-Ü]/i.test(t)) return true;
  if (/^(via|viale|piazza|corso|galleria)\b/i.test(t)) return true;
  return false;
}

/** Piccole congiunzioni che restano minuscole quando non sono la prima parola del ruolo. */
const ROLE_LOWERCASE_WORDS = new Set(['e', 'ed', 'di', 'del', 'della', 'dei', 'and', 'of', 'the', '&']);

function capitalizeRole(role: string): string {
  return role
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && ROLE_LOWERCASE_WORDS.has(lower)) return lower;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

function stripLegalFormSuffix(text: string): string {
  return text.replace(LEGAL_FORM_STRIP, '').replace(/\s+/g, ' ').trim();
}

function brandRoot(text: string): string {
  return stripLegalFormSuffix(stripDomainSuffix(text)).toLowerCase();
}

/** Domini casella dove la parte locale è il marchio aziendale (non gmail/libero
 * dove spesso c'è nome+cognome fusi, es. dalzottosilvano@gmail.com). */
const LOCAL_BRAND_MAILBOX_DOMAINS = new Set(['email.it']);

function emailBrandKey(emails: string[]): string | undefined {
  const email = pickPersonalEmail(emails) || emails[0];
  if (!email?.includes('@')) return undefined;
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!local || local.length < 3 || GENERIC_EMAIL_LOCALS.test(local)) return undefined;

  const localKey = normalizeBrandKey(local);
  if (LOCAL_BRAND_MAILBOX_DOMAINS.has(domain)) return localKey;

  if (isGenericEmailDomain(domain)) return undefined;

  const hostKey = domainBrandKey(domain.split('.')[0] ?? '');
  return hostKey || localKey;
}

function emailDomainRoot(emails: string[]): string | undefined {
  const domain = emails[0]?.split('@')[1]?.toLowerCase();
  if (!domain || isGenericEmailDomain(domain)) {
    return emailBrandKey(emails);
  }
  return domain.split('.')[0];
}

/** Indizi di marchio da contatti digitati (email, dominio, sito): usati solo per
 * confrontare grafie simili all'OCR, non come fonte primaria del nome azienda. */
type BrandSpellingHint = { key: string; display: string; reliability: number };

function brandHintCandidates(emails: string[], website?: string): BrandSpellingHint[] {
  const out: BrandSpellingHint[] = [];
  const email = pickPersonalEmail(emails) || emails[0];
  if (!email?.includes('@')) return out;

  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const domain = email.split('@')[1]?.toLowerCase() ?? '';

  if (local.length >= 3 && !GENERIC_EMAIL_LOCALS.test(local)) {
    out.push({
      key: normalizeBrandKey(local),
      display: formatBrandName(local),
      reliability: LOCAL_BRAND_MAILBOX_DOMAINS.has(domain) ? 3 : 2,
    });
  }
  if (!isGenericEmailDomain(domain)) {
    const hostKey = domainBrandKey(domain.split('.')[0] ?? '');
    if (hostKey) {
      out.push({
        key: hostKey,
        display: formatBrandFromDomainKey(hostKey),
        reliability: 3,
      });
    }
  }
  const wRoot = websiteDomainRoot(website);
  if (wRoot) {
    const wKey = domainBrandKey(wRoot);
    if (wKey) {
      out.push({ key: wKey, display: formatBrandName(wRoot), reliability: 2 });
    }
  }
  return out;
}

/** Quanto è probabile questa grafia rispetto a ciò che l'OCR ha letto sul biglietto. */
function scoreBrandSpellingCandidate(
  candidateKey: string,
  ocrKey: string,
  reliability: number
): number {
  if (!candidateKey || !ocrKey) return -1;
  if (!brandKeysPlausiblySameBrand(candidateKey, ocrKey)) return -1;

  let score = reliability * 10;
  if (candidateKey === ocrKey) score += 15;

  // OCR con prefisso spurio (es. "4"→"A": abellotto vs bellotto)
  if (ocrKey.endsWith(candidateKey) && ocrKey.length - candidateKey.length === 1) {
    const extra = ocrKey.slice(0, ocrKey.length - candidateKey.length);
    if (/^[a4o0]$/i.test(extra)) {
      if (candidateKey !== ocrKey) score += 14;
      else score -= 10;
    }
  }

  // OCR troncato (es. "lotto" dentro "bellotto")
  if (candidateKey.includes(ocrKey) && ocrKey.length >= 4 && candidateKey.length > ocrKey.length) {
    score += candidateKey === ocrKey ? -8 : 10;
  }

  const dist = levenshteinDistance(candidateKey, ocrKey);
  if (dist <= 2) score += (3 - dist) * 4;

  if (candidateKey.length < ocrKey.length && dist > 0) score += 3;

  return score;
}

function ocrBrandBaselineScore(ocrKey: string, hints: BrandSpellingHint[]): number {
  let score = scoreBrandSpellingCandidate(ocrKey, ocrKey, 3);
  for (const hint of hints) {
    if (!brandKeysPlausiblySameBrand(hint.key, ocrKey)) continue;
    if (ocrKey.endsWith(hint.key) && ocrKey.length - hint.key.length === 1) {
      const extra = ocrKey.slice(0, 1);
      if (/^[a4o0]$/i.test(extra)) score -= 12;
    }
    if (hint.key.includes(ocrKey) && hint.key.length > ocrKey.length && ocrKey.length >= 4) {
      score -= 8;
    }
  }
  return score;
}

/** Tra OCR e indizi email/dominio/sito, sceglie la grafia più plausibile. */
function resolveMostProbableBrandWord(
  ocrWord: string,
  hints: BrandSpellingHint[]
): string {
  const ocrKey = normalizeBrandKey(ocrWord);
  let bestDisplay = ocrWord;
  let bestScore = ocrBrandBaselineScore(ocrKey, hints);

  for (const hint of hints) {
    const s = scoreBrandSpellingCandidate(hint.key, ocrKey, hint.reliability);
    if (s > bestScore) {
      bestScore = s;
      bestDisplay = hint.display;
    }
  }
  return formatBrandName(bestDisplay);
}

/** Se il marchio OCR è simile a un indizio di contatto, confronta le grafie e
 * tiene la più probabile; altrimenti lascia l'OCR com'è. */
function reconcileCompanySpelling(company: string, emails: string[], website?: string): string {
  if (!company.trim()) return company;
  const hints = brandHintCandidates(emails, website);
  if (!hints.length) return formatCompanyLine(company);

  const words = company.trim().split(/\s+/);
  const firstWord = words[0] ?? company;
  const firstKey = normalizeBrandKey(firstWord);
  const hasSimilarHint = hints.some((h) => brandKeysPlausiblySameBrand(firstKey, h.key));
  if (!hasSimilarHint) return formatCompanyLine(company);

  const fixedFirst = resolveMostProbableBrandWord(firstWord, hints);
  const rest = words.slice(1).join(' ');
  return formatCompanyLine(rest ? `${fixedFirst} ${rest}` : fixedFirst);
}

/** L'azienda letta dall'OCR è coerente con almeno un indizio di contatto? */
function companyAlignsWithBrandHints(company: string, emails: string[], website?: string): boolean {
  const hints = brandHintCandidates(emails, website);
  if (!hints.length || !company.trim()) return true;
  const firstKey = normalizeBrandKey(company.split(/\s+/)[0] ?? '');
  return hints.some(
    (h) =>
      brandKeysPlausiblySameBrand(firstKey, h.key) ||
      (firstKey.length >= 4 && h.key.startsWith(firstKey)) ||
      (h.key.length >= 4 && firstKey.startsWith(h.key))
  );
}

function ocrCompanyLooksUnreliable(company: string, emails: string[], website?: string): boolean {
  if (!company.trim()) return true;
  if (isLikelyPersonName(company)) return true;
  const first = company.split(/\s+/)[0] ?? '';
  if (isLikelyPersonName(first)) return true;
  return !companyAlignsWithBrandHints(company, emails, website);
}

/** @deprecated alias interno — usa reconcileCompanySpelling */
function reconcileCompanyWithEmail(company: string, emails: string[], website?: string): string {
  return reconcileCompanySpelling(company, emails, website);
}

function websiteDomainRoot(website?: string): string | undefined {
  if (!website) return undefined;
  const host = stripDomainSuffix(website).toLowerCase();
  const root = host.split('.')[0];
  return root && root.length >= 2 ? root : undefined;
}

function isLikelyRoleLine(text: string): boolean {
  const t = text.trim().replace(/^ruolo\s*[:\-]\s*/i, '');
  if (!t || t.length < 3 || t.length > 55) return false;
  if (EMAIL_SINGLE.test(t)) return false;
  if (digitCount(t) >= 6) return false;
  if (isCompanyNoiseLine(t)) return false;
  if (isLikelyPersonName(t)) return false;
  if (looksLikeDomainLine(t)) return false;
  if (TAX_LABEL_LINE.test(t)) return false;
  if (/^(via|viale|piazza|corso|galleria|tel\.?|fax\.?|phone|mobile)\b/i.test(t)) return false;

  if (ROLE_REGEX.test(t)) return true;
  if (containsFuzzyRoleWord(t)) return true;

  const word = t.replace(/[.,]/g, '').trim();
  if (word.length >= 4 && word.length <= 28 && ITALIAN_ROLE_WORDS.has(word.toLowerCase())) {
    return true;
  }

  const words = t.split(/\s+/);
  if (words.length >= 2 && words.length <= 5 && ROLE_REGEX.test(t)) return true;
  if (/^(responsabile|capo|head\s+of|chief|senior|junior|vice|ass\.?|assistente)\b/i.test(t)) {
    return true;
  }
  if (/\b(sales|marketing|purchase|quality|export|import)\s+dept\b/i.test(t)) return true;

  return false;
}

/** Parole tipiche di settore/slogan aziendale — mai nome persona o ragione sociale. */
const ACTIVITY_WORDS =
  /\b(domotica|automation|automazione|industrial|building|hotel|hotels|home|smart|solutions?|systems?|technology|technologies|engineering|services?|consulting|software|hardware|networking|security|energy|renewable|logistics?|trading|import|export|wholesale|retail|manufacturing|production|produzione|progettazione|intermediazioni?|commercio|consulenza|assistenza|installazioni?|riparazioni?|vendita|noleggio|trasporti?)\b/i;

const NON_PERSON_WORDS = new Set([
  'industrial', 'automation', 'automazione', 'domotica', 'building', 'hotel', 'home',
  'dept', 'department', 'sales', 'marketing', 'solutions', 'systems', 'technology',
  'engineering', 'services', 'consulting', 'software', 'smart', 'automation',
]);

/** Parole tipiche di ragione sociale / settore — non cognome (es. "Wise Ingegneria"). */
const COMPANY_DESCRIPTOR_WORDS = new Set([
  'ingegneria', 'soluzioni', 'software', 'serramenti', 'componenti', 'arredamenti',
  'interni', 'impianti', 'automazione', 'costruzioni', 'servizi', 'commercio',
  'industrie', 'group', 'holding', 'consulting', 'logistica', 'docks', 'spa',
]);

function lineLooksLikeCompanyBrand(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 8) return false;
  if (hasLegalFormSuffix(text)) return true;
  return words.some((w) => COMPANY_DESCRIPTOR_WORDS.has(w.toLowerCase().replace(/[.,]/g, '')));
}

const LEGAL_FORM_LOWERCASE = new Set([
  'srl', 'spa', 'snc', 'sas', 'sap', 'sdf', 'ltd', 'llc', 'inc', 'gmbh', 'ag', 'bv', 'nv', 'oy', 'ab', 'as', 'aps',
]);

/** Parole minuscole dopo la prima token: segnale generico di descrizione/catalogo
 * (es. "Porte per interni", "Finestre e Pompeiane"), mai di un nome stampato. */
function hasPersonNameBreakingLowercaseWord(words: string[]): boolean {
  for (let i = 1; i < words.length; i++) {
    const bare = words[i].replace(/[.,'`-]/g, '');
    const lower = bare.toLowerCase();
    if (LEGAL_FORM_LOWERCASE.has(lower)) continue;
    if (bare && /^[a-zà-ü'-]+$/.test(bare)) return true;
  }
  return false;
}

/** Riga che per struttura/grammatica è un elenco o una descrizione, non un contatto.
 * Nessuna parola legata a un settore: solo layout e pattern linguistici. */
function isLikelyProductCatalogLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^[*•·\-–—]\s/.test(t)) return true;
  if (/^\d+[\s.)]/.test(t)) return true;
  if (t.length > 50 && /[,;:](\s|$)/.test(t)) return true;
  if (/\d+\s*%/.test(t)) return true;
  if (/\s-\s/.test(t) && t.split(/\s+/).length >= 3) return true;
  if (/\w-\s*$/.test(t)) return true;

  const words = t.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.,'`-]/g, ''));
  if (words.length >= 2 && hasPersonNameBreakingLowercaseWord(words)) return true;
  return false;
}

function personNamesLookWrong(firstName: string, lastName: string, emails: string[]): boolean {
  const full = `${firstName} ${lastName}`.trim();
  if (!full) return false;
  if (isLikelyProductCatalogLine(full) || isLikelyActivityLine(full)) return true;
  if (parsePersonNameLine(full) === null) return true;

  const personal = pickPersonalEmail(emails);
  const localRaw = personal.split('@')[0]?.toLowerCase().replace(/[._-]/g, '') ?? '';
  const fullKey = normalizeBrandKey(full);
  // La parte locale dell'email che ripete nome+cognome CONFERMA la persona.
  if (localRaw && localRaw.length >= 4 && (fullKey === localRaw || localRaw.includes(fullKey))) {
    return false;
  }

  const brandKey = emailBrandKey(emails);
  if (brandKey && brandKeysSimilar(fullKey, brandKey)) return true;
  return false;
}

function sanitizePersonNames(
  firstName: string,
  lastName: string,
  emails: string[],
  _lines: OcrLine[]
): { firstName: string; lastName: string } {
  if (personNamesLookWrong(firstName, lastName, emails)) {
    return { firstName: '', lastName: '' };
  }
  return { firstName, lastName };
}

/** Ripristina slogan/attività quando l'OCR fonde parole o perde l'apostrofo
 * (es. "PROGETTAZIONEDINTERNI" → "Progettazione d'interni"). */
function fixOcrActivityWords(text: string): string {
  return text
    .replace(/progettazionedinterni/gi, "Progettazione d'interni")
    .replace(/progettazione\s*d\s*['']?\s*interni/gi, "Progettazione d'interni")
    .replace(/progettazione\s*dinterni/gi, "Progettazione d'interni");
}

/** Righe che descrivono l'ATTIVITÀ svolta (progettazione, intermediazioni, …)
 * e non il nome dell'azienda: non vanno mai scelte come ragione sociale. */
function isLikelyActivityLine(text: string): boolean {
  const t = fixOcrActivityWords(text).trim();
  if (!t || t.length < 5) return false;
  if (ACTIVITY_WORDS.test(t)) return true;
  if (/\b(intermediazioni?|progettazione|produzione|commercio|consulenza|assistenza|riparazioni?|installazioni?|vendita|noleggio|trasporti?)\b/i.test(t)) {
    return true;
  }
  if (/progettazion/i.test(t) && /interni/i.test(t)) return true;
  return false;
}

/** Conta quante volte un marchio compare nel testo (anche su righe diverse o
 * pagine diverse): se "arredamenti la bussola" compare due volte è l'azienda,
 * non lo slogan "progettazione d'interni" che compare una sola volta. */
function buildBrandRepetitionScores(lines: OcrLine[]): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (text: string) => {
    const key = normalizeBrandKey(text);
    const mKey = brandMultisetKey(text);
    if (key.length >= 6) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (mKey.length >= 6) counts.set(mKey, (counts.get(mKey) ?? 0) + 1);
  };

  const tryPair = (a: string, b: string) => {
    if (!a || !b || isCompanyNoiseLine(b) || isLikelyActivityLine(b)) return;
    if (isLikelyPersonName(`${a} ${b}`) || isLikelyPersonName(a) || isLikelyPersonName(b)) return;
    bump(`${a} ${b}`);
    bump(combineBrandFragments(a, b));
  };

  for (let i = 0; i < lines.length; i++) {
    const t = fixOcrZeros(lines[i].text.trim().replace(/\s+/g, ' '));
    if (!t) continue;
    bump(t);
    if (i + 1 < lines.length) {
      const next = fixOcrZeros(lines[i + 1].text.trim());
      tryPair(t, next);
    }
    if (i > 0) {
      const prev = fixOcrZeros(lines[i - 1].text.trim());
      tryPair(prev, t);
    }
  }
  return counts;
}

function repetitionBonusFor(text: string, repetition: Map<string, number>): number {
  const key = normalizeBrandKey(text);
  const mKey = brandMultisetKey(text);
  const count = Math.max(repetition.get(key) ?? 0, repetition.get(mKey) ?? 0);
  if (count >= 2) return 50;
  if (count === 1) return 0;
  // Anche sotto-chiavi ripetute (es. "arredamenti" + "bussola" su righe vicine)
  for (const [k, c] of repetition) {
    if (c >= 2 && (key.includes(k) || mKey.includes(k)) && k.length >= 8) return 35;
  }
  return 0;
}

function scoreCompanyLine(
  text: string,
  ctx: { root?: string; websiteRoot?: string; domainKey?: string; repetition?: Map<string, number> }
): number {
  const t = fixOcrActivityWords(text.trim().replace(/\s+/g, ' '));
  if (!t || t.length < 2 || t.length > 55) return -100;
  if (isLikelyActivityLine(t)) return -100;
  if (isLikelyProductCatalogLine(t)) return -100;
  // Mai un numero di telefono/fax/P.IVA: troppe cifre non è mai un nome azienda
  if (digitCount(t) >= 6 && !LEGAL_FORM_REGEX.test(t)) return -100;
  if (PHONE_HINT.test(t)) return -100;
  if (/\b(tax|tel|fax|tol)\b/i.test(t)) return -100;
  if (digitCount(t) >= 8 && !LEGAL_FORM_REGEX.test(t)) return -100;
  if (isCompanyNoiseLine(t)) return -100;
  if (isLikelyPersonName(t)) return -100;
  if (isLikelyRoleLine(t)) return -80;
  if (isLikelyIndustryAcronymLine(t)) return -100;
  if (looksLikeDomainLine(t)) return -40;
  if (TAX_LABEL_LINE.test(t)) return -100;
  if (/@/.test(t)) return -100;
  if (/^\d{5}\s+[A-ZÀ-Ü]/i.test(t)) return -100;
  if (/^(via|viale|piazza|corso|galleria)\b/i.test(t)) return -100;

  let score = 8;
  const lower = t.toLowerCase();
  const core = brandRoot(t);

  if (ctx.root) {
    if (core === ctx.root) score += 45;
    else if (lower.includes(ctx.root)) score += 35;
    else if (ctx.root.includes(core) && core.length >= 4) score += 20;
  }

  if (ctx.websiteRoot) {
    if (core === ctx.websiteRoot) score += 30;
    else if (lower.includes(ctx.websiteRoot)) score += 20;
  }

  if (hasLegalFormSuffix(t)) score += 65;

  if (/^[A-ZÀ-Ü0-9&][A-ZÀ-Ü0-9&.\-'\s]{1,24}$/.test(t) && !/\s/.test(t.trim())) {
    score += 18;
  }

  const words = t.split(/\s+/);
  if (words.length >= 1 && words.length <= 3) {
    if (words.every((w) => /^[A-ZÀ-Ü]/.test(w) && w.length <= 22)) score += 10;
  }

  if (ctx.domainKey) {
    const lineKey = normalizeBrandKey(t);
    if (brandKeysSimilar(ctx.domainKey, lineKey)) score += 50;
  }

  if (ctx.repetition) score += repetitionBonusFor(t, ctx.repetition);

  if (/\d/.test(t) && !LEGAL_FORM_REGEX.test(t)) score -= 20;

  return score;
}

function combineBrandFragments(first: string, second: string): string {
  const a = first.trim();
  const b = second.trim();
  if (!a || !b) return `${a} ${b}`.trim();
  // Logo tipico: parola grande in maiuscolo sopra/sotto sottotitolo minuscolo
  // (es. "ARREDAMENTI" + "la bussola" oppure invertiti dall'OCR).
  const aIsMainCaps = /^[A-ZÀ-Ü]{3,}$/.test(a);
  const bIsMainCaps = /^[A-ZÀ-Ü]{3,}$/.test(b);
  const aIsSubtitle = /^[a-zà-ü]/.test(a);
  const bIsSubtitle = /^[a-zà-ü]/.test(b);
  if (aIsMainCaps && bIsSubtitle) return `${a} ${b}`;
  if (bIsMainCaps && aIsSubtitle) return `${b} ${a}`;
  return `${a} ${b}`;
}

function isPlausibleBrandContinuation(text: string): boolean {
  const nextClean = fixOcrZeros(text.replace(/\s+/g, ' ').trim());
  if (isLikelyActivityLine(nextClean)) return false;
  const nextWordCount = nextClean.split(/\s+/).filter(Boolean).length;
  return (
    nextClean.length >= 2 &&
    nextClean.length <= 30 &&
    nextWordCount >= 1 &&
    nextWordCount <= 4 &&
    digitCount(nextClean) < 3 &&
    !/@/.test(nextClean) &&
    !isCompanyNoiseLine(nextClean) &&
    !isLikelyRoleLine(nextClean) &&
    !isLikelyPersonName(nextClean) &&
    !PHONE_HINT.test(nextClean) &&
    !looksLikeDomainLine(nextClean) &&
    !TAX_LABEL_LINE.test(nextClean) &&
    !/^(via|viale|piazza|corso|galleria|vicolo|v\.le|c\.so)\b/i.test(nextClean)
  );
}

function findPersonNameLineIndex(lines: OcrLine[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (isLikelyPersonName(lines[i].text.trim())) return i;
  }
  return -1;
}

function parseName(lines: OcrLine[], emails: string[]): { firstName: string; lastName: string; lineIndex: number } {
  const exclusionHints = collectNameExclusionHints(emails, lines);
  const personalEmailEarly = pickPersonalEmail(emails);
  const emailCandidates = personalEmailEarly ? nameCandidatesFromEmailLocal(personalEmailEarly) : [];

  if (personalEmailEarly && emailCandidates.length) {
    const localParts = personalEmailEarly.split('@')[0]?.toLowerCase().split(/[._-]+/).filter(Boolean) ?? [];
    if (localParts.length === 2) {
      const [a, b] = localParts;
      for (let i = 0; i < lines.length; i++) {
        const words = lines[i].text.trim().toLowerCase().replace(/[.,]+$/g, '').split(/\s+/);
        if (words.length !== 2) continue;
        const orders = [
          [words[0], words[1]],
          [words[1], words[0]],
        ];
        for (const [w0, w1] of orders) {
          if (
            (levenshteinDistance(w0, a) <= 2 && levenshteinDistance(w1, b) <= 2) ||
            (levenshteinDistance(w0, b) <= 2 && levenshteinDistance(w1, a) <= 2)
          ) {
            if (
              !isLikelyActivityLine(lines[i].text) &&
              !isLikelyRoleLine(lines[i].text) &&
              !isLikelySloganOrBrandNameLine(lines[i].text, exclusionHints)
            ) {
              return { ...normalizeNameOrder(w0, w1), lineIndex: i };
            }
          }
        }
      }
    }
  }

  // Nome e cognome su due righe separate, spesso tutto minuscolo (es. "carlo" / "foletto").
  for (let i = 0; i < lines.length - 1; i++) {
    const lineA = lines[i].text.trim().replace(/[.,]+$/g, '');
    const lineB = lines[i + 1].text.trim().replace(/[.,]+$/g, '');
    if (!/^[a-zà-ü]{2,18}$/.test(lineA) || !/^[a-zà-ü]{2,18}$/.test(lineB)) continue;
    if (isCompanyNoiseLine(lineA) || isCompanyNoiseLine(lineB)) continue;
    if (isLikelyRoleLine(lineA) || isLikelyRoleLine(lineB)) continue;
    if (NON_PERSON_WORDS.has(lineA.toLowerCase()) || NON_PERSON_WORDS.has(lineB.toLowerCase())) continue;
    if (ACTIVITY_WORDS.test(lineA) || ACTIVITY_WORDS.test(lineB)) continue;
    if (
      COMMON_FIRST_NAMES.has(lineA.toLowerCase()) ||
      COMMON_FIRST_NAMES.has(lineB.toLowerCase())
    ) {
      return {
        firstName: capitalizeWord(lineA),
        lastName: capitalizeWord(lineB),
        lineIndex: i,
      };
    }
  }

  let best: { firstName: string; lastName: string; lineIndex: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parsePersonNameLine(lines[i].text);
    if (!parsed) continue;
    const score = scorePersonNameCandidate(parsed, lines[i].text, exclusionHints, emailCandidates);
    if (!best || score > best.score) {
      best = { ...parsed, lineIndex: i, score };
    }
  }
  if (best && best.score > 0) {
    return { firstName: best.firstName, lastName: best.lastName, lineIndex: best.lineIndex };
  }

  for (let i = 0; i < lines.length; i++) {
    const fromDi = parseNameFromDiPattern(lines[i].text);
    if (fromDi) return { ...fromDi, lineIndex: i };
  }

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    if (!EMAIL_SINGLE.test(text)) continue;
    const beforeEmail = text.split(EMAIL_SINGLE)[0]?.trim() ?? '';
    const parsed = parsePersonNameLine(beforeEmail);
    if (parsed) return { ...parsed, lineIndex: i };
  }

  const personalEmail = pickPersonalEmail(emails);
  if (personalEmail) {
    const local = personalEmail.split('@')[0]?.toLowerCase() ?? '';
    const localParts = local.split(/[._-]+/).filter(Boolean);

    if (localParts.length >= 2) {
      const [a, b] = localParts;
      for (let i = 0; i < lines.length - 1; i++) {
        const lineA = lines[i].text.trim().toLowerCase().replace(/[.,]+$/g, '');
        const lineB = lines[i + 1].text.trim().toLowerCase().replace(/[.,]+$/g, '');
        if (
          lineA.length >= 3 &&
          lineB.length >= 3 &&
          levenshteinDistance(lineA, a) <= 2 &&
          levenshteinDistance(lineB, b) <= 2 &&
          !isLikelyActivityLine(`${lineA} ${lineB}`) &&
          !isLikelyRoleLine(`${lineA} ${lineB}`)
        ) {
          const lastName =
            lineB.length >= b.length ? capitalizeWord(lineB) : capitalizeWord(b);
          return {
            firstName: capitalizeWord(a),
            lastName,
            lineIndex: i,
          };
        }
      }

      for (let i = 0; i < lines.length; i++) {
        const text = stripProfessionalTitle(lines[i].text.trim());
        const match = text.match(
          new RegExp(
            `\\b(${a}|${b})\\s+([A-ZÀ-ÜA-Za-zà-ü][A-Za-zÀ-ü\\'-]+)\\b`,
            'i'
          )
        );
        if (match) {
          return {
            ...normalizeNameOrder(match[1], match[2]),
            lineIndex: i,
          };
        }

        const singleLocal = text.match(
          new RegExp(`\\b(${local})\\s+([A-ZÀ-ÜA-Za-zà-ü][A-Za-zÀ-ü\\'-]+)`, 'i')
        );
        if (singleLocal) {
          return {
            firstName: capitalizeWord(singleLocal[1]),
            lastName: capitalizeWord(singleLocal[2]),
            lineIndex: i,
          };
        }
      }
    }

    const fromEmail = nameFromEmail(personalEmail);
    if (fromEmail.firstName && fromEmail.lastName) {
      return { ...fromEmail, lineIndex: findPersonNameLineIndex(lines) };
    }
  }

  const personalFallback = pickPersonalEmail(emails);
  if (personalFallback) {
    const fromEmail = nameFromEmail(personalFallback);
    if (fromEmail.firstName || fromEmail.lastName) {
      return { ...fromEmail, lineIndex: findPersonNameLineIndex(lines) };
    }
  }

  return { firstName: '', lastName: '', lineIndex: -1 };
}

function stripDomainSuffix(label: string): string {
  return label
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[®™©]/g, '')
    .replace(/\.(com|it|net|org|eu|io|biz|info)(\/.*)?$/i, '')
    .trim();
}

function formatBrandName(label: string): string {
  const cleaned = fixOcrZeros(stripDomainSuffix(label.replace(/\s+/g, ' ').trim()));
  if (!cleaned) return '';
  if (/^[a-z0-9-]+$/.test(cleaned)) {
    if (cleaned.includes('-')) {
      return cleaned
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('-');
    }
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  // Alcuni loghi uniscono su una riga parole TUTTE MAIUSCOLE (il nome
  // principale, in grande) e parole tutte minuscole (un sottotitolo/claim in
  // piccolo, es. "ARREDAMENTI la bussola"): per leggibilità uniformiamo in
  // Title Case invece di lasciare il mix incoerente ereditato dall'OCR.
  const words = cleaned.split(' ').filter(Boolean);
  const hasAllCapsWord = words.some((w) => w.length > 1 && /^[A-ZÀ-Ü]+$/.test(w));
  const hasAllLowerWord = words.some((w) => w.length > 1 && /^[a-zà-ü]+$/.test(w));
  if (hasAllCapsWord && hasAllLowerWord) {
    return words.map((w) => (/^[A-Za-zÀ-ü]+$/.test(w) ? capitalizeWord(w) : w)).join(' ');
  }
  if (words.length >= 2 && words.every((w) => /^[a-zà-ü]+$/.test(w))) {
    return words.map((w) => capitalizeWord(w)).join(' ');
  }
  return cleaned;
}

function looksLikeDomainLine(text: string): boolean {
  return (
    /^https?:\/\//i.test(text) ||
    /^www\./i.test(text) ||
    /^[a-z0-9-]+\.(com|it|net|org|eu|io)\b/i.test(text)
  );
}

/** Nelle ragioni sociali italiane il connettivo "di" (es. "Rossi S.r.l. di
 * Mario Rossi", più spesso "Azienda X **d** Cognome & C.") perde facilmente
 * la "i" finale in OCR, restando una "d" isolata minuscola: la ripristiniamo.
 * Non tocca abbreviazioni MAIUSCOLE come "D.F." (altro significato/contesto). */
function fixBareDiConnector(text: string): string {
  return text.replace(/(^|\s)d(\s)/g, '$1di$2');
}

/** Refusi OCR sulle forme giuridiche (es. S.r.I. letto al posto di S.r.l.). */
function normalizeLegalFormOcr(text: string): string {
  return fixOcrZeros(text)
    .replace(/\bS\.?\s*R\.?\s*[Il1|]\.?\b/gi, 'S.r.l.')
    .replace(/\bS\.?\s*P\.?\s*[A@4]\.?\b/gi, 'S.p.A.')
    .replace(/\bS\.?\s*A\.?\s*S\.?\b/gi, 'S.a.s.')
    .replace(/\bS\.?\s*N\.?\s*C\.?\b/gi, 'S.n.c.');
}

function hasLegalFormSuffix(text: string): boolean {
  return LEGAL_FORM_REGEX.test(normalizeLegalFormOcr(text));
}

/** Sigle di settore (MES & WMS, ERP/CRM…): reparto/prodotto, non ragione sociale. */
function isLikelyIndustryAcronymLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 45) return false;
  if (hasLegalFormSuffix(t)) return false;
  if (isLikelyPersonName(t)) return false;
  const parts = t
    .split(/\s*(?:&|\/|,|\+)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 6) return false;
  return parts.every((p) => /^[A-Z]{2,6}$/.test(p));
}

function formatCompanyLine(text: string): string {
  const cleaned = normalizeLegalFormOcr(fixBareDiConnector(text).replace(/\s+/g, ' ').trim());
  const legal = cleaned.match(LEGAL_FORM_REGEX)?.[0];
  const brandPart = stripLegalFormSuffix(cleaned);
  const brand = formatBrandName(brandPart) || brandPart;
  if (legal) {
    const form = formatLegalFormShort(legal.replace(/\./g, ''));
    return `${brand} ${form}`.trim();
  }
  return formatBrandName(cleaned);
}

/** Seconda riga sotto il marchio (es. "SERRAMENTI & COMPONENTI"): breve, senza
 * contatti/indirizzo, spesso il sottotitolo dell'azienda — mai una regola di settore. */
function isPlausibleCompanyTagline(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 55) return false;
  if (isCompanyNoiseLine(t) || isLikelyPersonName(t) || looksLikeDomainLine(t)) return false;
  if (isLikelyProductCatalogLine(t) || isLikelyActivityLine(t)) return false;
  if (/@/.test(t) || digitCount(t) >= 4) return false;
  if (/^(via|viale|piazza|corso|galleria|vicolo)\b/i.test(t)) return false;
  return true;
}

/** Da una riga in poi, raccoglie le eventuali parole di qualifica dello
 * studio (es. "Commercialisti Associati"), saltando connettivi isolati
 * ("&", "e") su righe a sé, tipici quando l'OCR separa un piccolo logo. */
function collectFirmSuffixWords(lines: OcrLine[], fromIdx: number): string[] {
  const suffixWords: string[] = [];
  for (let k = fromIdx; k < Math.min(fromIdx + 6, lines.length); k++) {
    const candidate = fixOcrZeros(lines[k].text.trim());
    if (!candidate) continue;
    if (/@/.test(candidate) || looksLikeDomainLine(candidate) || digitCount(candidate) >= 3) {
      break;
    }
    const bareLetters = candidate.toUpperCase().replace(/[^A-Z]/g, '');
    if (!bareLetters || /^(E|ED|AND)$/.test(bareLetters)) continue;
    const word = matchFirmSuffixWord(candidate);
    if (!word) break;
    suffixWords.push(word);
  }
  return suffixWords;
}

function inferCompanyFromEmailAndText(
  emails: string[],
  rawText: string,
  lines: OcrLine[]
): string {
  const email = emails[0];
  if (!email?.includes('@')) return '';

  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const brandKey = emailBrandKey(emails);
  if (!brandKey) return '';

  const host = domain.split('.')[0] ?? '';
  const domainKey = isGenericEmailDomain(domain) ? brandKey : domainBrandKey(host);
  const spellingHints = brandHintCandidates(emails);

  const companyFromBrandMatch = (lineText: string, lineIdx: number): string => {
    const words = lineText.trim().split(/\s+/);
    const first = words[0] ?? lineText;
    let company = resolveMostProbableBrandWord(first, spellingHints);
    if (words.length > 1) company = `${company} ${words.slice(1).join(' ')}`;
    const next = lines[lineIdx + 1]?.text?.trim();
    if (next && isPlausibleCompanyTagline(next)) {
      company = `${resolveMostProbableBrandWord(first, spellingHints)} ${formatBrandName(next)}`;
    }
    return formatCompanyLine(company);
  };

  for (const line of lines) {
    const t = fixOcrZeros(line.text.trim());
    if (!LEGAL_FORM_REGEX.test(t)) continue;
    const lineKey = normalizeBrandKey(stripLegalFormSuffix(t));
    if (brandKeysSimilar(domainKey, lineKey)) {
      return companyFromBrandMatch(t, lines.indexOf(line));
    }
  }

  for (const line of lines) {
    const t = fixOcrZeros(line.text.trim());
    // Mai usare email, siti o telefoni come nome azienda
    if (/@/.test(t) || looksLikeDomainLine(t) || digitCount(t) >= 6) continue;
    if (isLikelyPersonName(t) || isLikelyRoleLine(t) || isLikelyProductCatalogLine(t)) continue;
    const lineKey = normalizeBrandKey(t);
    if (!lineKey || lineKey.length < 3) continue;
    if (brandKeysSimilar(domainKey, lineKey)) {
      const lineIdx = lines.indexOf(line);
      for (const candidate of lines) {
        const legalLine = fixOcrZeros(candidate.text.trim());
        if (/@/.test(legalLine) || looksLikeDomainLine(legalLine)) continue;
        if (LEGAL_FORM_REGEX.test(legalLine) && normalizeBrandKey(legalLine).includes(lineKey)) {
          return formatCompanyLine(legalLine);
        }
      }

      // Il dominio può nascere dall'unione di due nomi (es. "garbinmaule.it" =
      // "Garbin" + "Maule", tipico degli studi professionali associati): se questa
      // riga copre solo l'INIZIO del dominio, cerca il pezzo mancante nelle righe
      // vicine e uniscili invece di restituire un nome azienda troncato.
      if (domainKey.length > lineKey.length && domainKey.startsWith(lineKey)) {
        const remainder = domainKey.slice(lineKey.length);
        const lineIdx = lines.indexOf(line);
        for (let j = lineIdx + 1; j < Math.min(lineIdx + 5, lines.length); j++) {
          const otherRaw = fixOcrZeros(lines[j].text.trim()).replace(/^&\s*/, '').trim();
          if (!otherRaw || /@/.test(otherRaw) || looksLikeDomainLine(otherRaw) || digitCount(otherRaw) >= 4) {
            continue;
          }
          const otherKey = normalizeBrandKey(otherRaw);
          if (otherKey.length < 3) continue;

          const exactMatch = remainder.startsWith(otherKey) || otherKey.startsWith(remainder);
          // Tollera un refuso OCR di 1-2 lettere (es. "LAULE" invece di "MAULE"):
          // se la riga ha la stessa lunghezza attesa ed è molto vicina al resto del
          // dominio, la accettiamo comunque, correggendola con l'ortografia del dominio
          // (l'email, scritta a mano in fase di registrazione, è più affidabile dell'OCR).
          const fuzzyMatch =
            !exactMatch &&
            Math.abs(otherKey.length - remainder.length) <= 1 &&
            levenshteinDistance(otherKey, remainder) <= 2;

          if (exactMatch || fuzzyMatch) {
            // Un dominio nato dall'unione di due cognomi (tipico studi professionali
            // associati, es. "garbinmaule.it") è quasi sempre scritto per esteso come
            // "Nome1 & Nome2": anche quando l'OCR perde del tutto il simbolo "&"
            // (spesso un piccolo logo/decorazione, non testo), lo ripristiniamo.
            const secondPart = fuzzyMatch ? formatBrandFromDomainKey(remainder) : otherRaw;
            let companyName = `${t} & ${secondPart}`;

            const suffixWords = collectFirmSuffixWords(lines, j + 1);
            if (suffixWords.length) {
              companyName += ` ${suffixWords.map(titleCaseWord).join(' ')}`;
            }

            return formatCompanyLine(companyName);
          }

          // Riga breve ma non correlata al dominio (probabile rumore OCR isolato,
          // es. un frammento di "&" mal separato): continua a cercare oltre invece
          // di arrenderti subito.
        }
      }

      // Caso simmetrico al precedente: questa riga copre solo la FINE del
      // dominio (es. riga "&MAULE" che copre solo "maule" di "gartbinmaule",
      // perché l'OCR ha corrotto l'inizio del dominio con una lettera in più
      // e la corrispondenza "esatta" con "GARBIN" è fallita). Cerca la prima
      // parte nelle righe PRECEDENTI invece di restituire un nome troncato.
      if (domainKey.length > lineKey.length && domainKey.endsWith(lineKey)) {
        const remainder = domainKey.slice(0, domainKey.length - lineKey.length);
        const lineIdx = lines.indexOf(line);
        for (let j = lineIdx - 1; j >= Math.max(0, lineIdx - 5); j--) {
          const otherRaw = fixOcrZeros(lines[j].text.trim())
            .replace(/^&\s*/, '')
            .replace(/\s*&$/, '')
            .trim();
          if (!otherRaw || /@/.test(otherRaw) || looksLikeDomainLine(otherRaw) || digitCount(otherRaw) >= 4) {
            continue;
          }
          const otherKey = normalizeBrandKey(otherRaw);
          if (otherKey.length < 3) continue;

          const exactMatch = remainder.endsWith(otherKey) || otherKey.endsWith(remainder) || otherKey === remainder;
          const fuzzyMatch =
            !exactMatch &&
            Math.abs(otherKey.length - remainder.length) <= 1 &&
            levenshteinDistance(otherKey, remainder) <= 2;

          if (exactMatch || fuzzyMatch) {
            const firstPart = fuzzyMatch ? formatBrandFromDomainKey(remainder) : otherRaw;
            const thisPart = t.replace(/^&\s*/, '').trim();
            let companyName = `${firstPart} & ${thisPart}`;

            const suffixWords = collectFirmSuffixWords(lines, lineIdx + 1);
            if (suffixWords.length) {
              companyName += ` ${suffixWords.map(titleCaseWord).join(' ')}`;
            }

            return formatCompanyLine(companyName);
          }
        }
      }

      return companyFromBrandMatch(t, lineIdx);
    }
  }

  const rawMatch = rawText.match(
    /([A-Z0-9][A-Z0-9.\s&'-]{1,30}\s+S\.?\s*R\.?\s*L\.?\.?)/i
  );
  if (rawMatch && brandKeysSimilar(domainKey, normalizeBrandKey(rawMatch[1]))) {
    return companyFromBrandMatch(rawMatch[1], -1);
  }

  return '';
}

function pickBestCompanyCandidate(
  lines: OcrLine[],
  ctx: { root?: string; websiteRoot?: string; domainKey?: string; repetition?: Map<string, number> }
): string {
  const candidates: { text: string; score: number; index: number }[] = [];

  lines.forEach((line, index) => {
    const t = fixOcrZeros(line.text.trim().replace(/\s+/g, ' '));
    if (!t) return;
    const score = scoreCompanyLine(t, ctx);
    if (score > 0) candidates.push({ text: t, score, index });
  });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return '';

  // Molti marchi si scrivono su due righe di peso grafico diverso (es.
  // "ARREDAMENTI" grande + "la bussola" più piccola sotto): se la riga
  // vincente è UNA SOLA parola e quella immediatamente successiva è breve e
  // non è rumore/ruolo/indirizzo/contatto/nome di persona, è quasi certamente
  // la continuazione del nome dell'azienda, non un dato non correlato.
  let bestText = best.text;
  const nextRaw = lines[best.index + 1]?.text?.trim();
  const prevRaw = lines[best.index - 1]?.text?.trim();
  if (best.text.split(/\s+/).length === 1 && !isLikelyActivityLine(best.text)) {
    if (nextRaw && isPlausibleBrandContinuation(nextRaw)) {
      const nextWithSpacedAmp = fixOcrZeros(nextRaw.replace(/\s+/g, ' ').trim()).replace(/^&(?=\S)/, '& ');
      bestText = combineBrandFragments(best.text, nextWithSpacedAmp);
      const suffixWords = collectFirmSuffixWords(lines, best.index + 2);
      if (suffixWords.length) {
        bestText += ` ${suffixWords.map(titleCaseWord).join(' ')}`;
      }
    } else if (prevRaw && isPlausibleBrandContinuation(prevRaw)) {
      const prevClean = fixOcrZeros(prevRaw.replace(/\s+/g, ' ').trim());
      bestText = combineBrandFragments(prevClean, best.text);
    }
  }

  if (ctx.domainKey && brandKeysSimilar(ctx.domainKey, normalizeBrandKey(bestText))) {
    return formatCompanyLine(bestText);
  }

  if (ctx.root) {
    const lower = bestText.toLowerCase();
    const idx = lower.indexOf(ctx.root);
    if (idx >= 0) {
      return formatCompanyLine(bestText.slice(idx));
    }
  }

  return formatCompanyLine(stripLegalFormSuffix(bestText));
}

/** Cerca righe con forma giuridica (S.r.l., Spa, GmbH…) anche su più righe OCR. */
function extractCompanyFromLegalForm(
  lines: OcrLine[],
  emails: string[] = [],
  website?: string
): string {
  const brandKey = emailBrandKey(emails);
  const websiteRoot = websiteDomainRoot(website);

  for (let i = 0; i < lines.length; i++) {
    const raw = fixOcrZeros(lines[i].text.trim().replace(/\s+/g, ' '));
    if (!raw) continue;
    const line = normalizeLegalFormOcr(raw);
    if (!hasLegalFormSuffix(line)) continue;
    if (/@/.test(line) || looksLikeDomainLine(line) || digitCount(line) >= 6) continue;

    let company = line;

    if (/^e\s+/i.test(line) && i > 0) {
      const prevJoin = fixOcrZeros(lines[i - 1].text.trim().replace(/\s+/g, ' '));
      if (
        prevJoin &&
        lineLooksLikeCompanyBrand(prevJoin) &&
        !isLikelyPersonName(prevJoin) &&
        !hasLegalFormSuffix(prevJoin)
      ) {
        company = `${prevJoin} ${line}`.replace(/\s+/g, ' ');
      }
    } else {
      const prefixParts: string[] = [];
      for (let back = 1; back <= 5 && i - back >= 0; back++) {
        const prevRaw = fixOcrZeros(lines[i - back].text.trim().replace(/\s+/g, ' '));
        if (!prevRaw) break;
        if (hasLegalFormSuffix(prevRaw)) break;
        if (/@/.test(prevRaw) || looksLikeDomainLine(prevRaw) || digitCount(prevRaw) >= 4) break;
        if (isLikelyPersonName(prevRaw)) break;
        if (isLikelyRoleLine(prevRaw) || isLikelyIndustryAcronymLine(prevRaw)) break;
        if (isLikelyActivityLine(prevRaw) && !/^e\s+/i.test(prevRaw)) continue;
        if (prevRaw.length > 50) break;
        prefixParts.unshift(prevRaw);
        if (!/^e\s+/i.test(line)) break;
        if (!/^e\s+/i.test(prevRaw)) break;
      }
      if (prefixParts.length) {
        company = `${prefixParts.join(' ')} ${company}`.replace(/\s+/g, ' ');
      }
    }

    const formatted = dedupeCompanyBrandTokens(formatCompanyLine(company));
    const stripped = normalizeBrandKey(stripLegalFormSuffix(formatted));
    if (brandKey && stripped.length >= 3 && !brandKeysSimilar(brandKey, stripped)) {
      const lineBrand = normalizeBrandKey(stripLegalFormSuffix(line));
      if (websiteRoot && brandKeysSimilar(normalizeBrandKey(websiteRoot), lineBrand)) {
        return formatted;
      }
      if (websiteRoot) {
        const wKey = normalizeBrandKey(websiteRoot);
        if (!stripped.includes(wKey.slice(0, Math.min(5, wKey.length)))) continue;
      } else {
        continue;
      }
    }
    return formatted;
  }
  return '';
}

function parseCompany(
  rawText: string,
  emails: string[],
  lines: OcrLine[] = [],
  website?: string
): string {
  const domain = emails[0]?.split('@')[1]?.toLowerCase();
  const host = domain?.split('.')[0];
  const brandKey = emailBrandKey(emails);
  const root = emailDomainRoot(emails);
  const websiteRoot = websiteDomainRoot(website) ?? root;
  const ctx = {
    root,
    websiteRoot,
    domainKey: brandKey ?? (host ? domainBrandKey(host) : undefined),
    repetition: buildBrandRepetitionScores(lines),
  };

  const rawLines = rawText.split('\n').map((l) => ({ text: l.trim(), confidence: 1 }));

  const fromLegal =
    extractCompanyFromLegalForm(lines, emails, website) ||
    extractCompanyFromLegalForm(rawLines, emails, website);
  if (fromLegal) {
    return reconcileCompanySpelling(fromLegal, emails, website);
  }

  let company = '';
  for (const candidate of [
    pickBestCompanyCandidate(lines, ctx),
    pickBestCompanyCandidate(rawLines, ctx),
  ]) {
    if (
      candidate &&
      !isLikelyActivityLine(candidate) &&
      !isLikelyProductCatalogLine(candidate) &&
      !isLikelyIndustryAcronymLine(candidate)
    ) {
      company = candidate;
      break;
    }
  }

  if (company) {
    const reconciled = reconcileCompanySpelling(company, emails, website);
    if (!ocrCompanyLooksUnreliable(reconciled, emails, website)) {
      return reconciled;
    }
    const fromEmail = inferCompanyFromEmailAndText(emails, rawText, lines);
    if (fromEmail) {
      return reconcileCompanySpelling(fromEmail, emails, website);
    }
    return reconciled;
  }

  const fromEmail = inferCompanyFromEmailAndText(emails, rawText, lines);
  if (fromEmail) {
    return reconcileCompanySpelling(fromEmail, emails, website);
  }

  if (host && domain && !isGenericEmailDomain(domain)) {
    const derived = companyNameFromDomainHost(host);
    if (derived) return derived;
  }

  return '';
}

/** Corregge refusi OCR molto comuni e non ambigui in una parola di ruolo già individuata. */
function fixRoleTypos(role: string): string {
  return role.replace(/\bgommercialista\b/gi, 'Commercialista');
}

function formatRoleLine(text: string): string {
  const cleaned = text.trim().replace(/^ruolo\s*[:\-]\s*/i, '').replace(/[.,]+$/g, '');
  const match = cleaned.match(ROLE_REGEX);
  if (match && cleaned.length <= match[0].length + 8) {
    return fixRoleTypos(capitalizeRole(match[0]));
  }
  return fixRoleTypos(capitalizeRole(cleaned));
}

/** Riga di reparto/ufficio che spesso segue il ruolo (es. "Ufficio Comunicazione"). */
function isLikelyDepartmentContinuation(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 3 || t.length > 40) return false;
  if (EMAIL_SINGLE.test(t) || looksLikeDomainLine(t) || TAX_LABEL_LINE.test(t)) return false;
  if (PHONE_HINT.test(t) || digitCount(t) >= 4) return false;
  if (LEGAL_FORM_REGEX.test(t)) return false;
  if (STREET_TYPE.test(t)) return false;
  // Parola di reparto/ufficio: ha priorità anche se somiglia a un nome proprio
  // (es. "Ufficio Comunicazione" è title-case come un nome, ma non lo è).
  if (/\b(ufficio|reparto|dipartimento|divisione|area|settore|department|division)\b/i.test(t)) {
    return true;
  }
  if (isLikelyPersonName(t)) return false;
  const words = t.split(/\s+/);
  return words.length >= 1 && words.length <= 4 && words.every((w) => /^[A-ZÀ-Ü]/.test(w));
}

/** La riga finisce con una congiunzione "a metà frase" (es. "Dottore Commercialista e"):
 * segno quasi certo che il ruolo prosegue sulla riga successiva. */
const ROLE_CONTINUATION_ENDING = /\b(?:e|ed|and|di|&)$/i;

function parseRoleFromLines(lines: OcrLine[], nameLineIndex: number): string {
  const withContinuation = (rawRoleLine: string, idx: number): string => {
    const next = lines[idx + 1]?.text.trim();
    if (!next) return formatRoleLine(rawRoleLine);

    const beforeNext = rawRoleLine.replace(/[.,]+$/, '').trim();
    if (ROLE_CONTINUATION_ENDING.test(beforeNext)) {
      return formatRoleLine(`${beforeNext} ${next}`.replace(/\s+/g, ' '));
    }

    if (isLikelyDepartmentContinuation(next)) {
      const dept = next.replace(/[.,]+$/g, '').trim();
      return `${formatRoleLine(rawRoleLine)} ${dept}`.trim();
    }
    return formatRoleLine(rawRoleLine);
  };

  if (nameLineIndex >= 0) {
    for (let offset = 1; offset <= 3; offset++) {
      const idx = nameLineIndex + offset;
      const next = lines[idx]?.text.trim();
      if (!next) continue;
      if (isLikelyIndustryAcronymLine(next)) {
        const roleLine = lines[idx + 1]?.text.trim();
        if (roleLine && isLikelyRoleLine(roleLine)) {
          return withContinuation(`${next} · ${roleLine}`, idx + 1);
        }
        continue;
      }
      if (isLikelyRoleLine(next)) return withContinuation(next, idx);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (!isLikelyRoleLine(t)) continue;
    return withContinuation(t, i);
  }

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (isLikelyActivityLine(t) && !isLikelyPersonName(t) && !isLikelyProductCatalogLine(t)) {
      return formatRoleLine(fixOcrActivityWords(t));
    }
  }

  return '';
}

function parseRole(text: string, lines: OcrLine[] = [], nameLineIndex = -1): string {
  const fromLines = parseRoleFromLines(lines, nameLineIndex);
  if (fromLines) return fromLines;

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (isLikelyRoleLine(t)) return formatRoleLine(t);
  }

  return '';
}

function extractTaxIds(text: string): { vatNumber?: string; taxCode?: string } {
  const flat = text.slice(0, MAX_CARD_TEXT_LEN).replace(/\s+/g, ' ');

  // "f" ed "e" sono spesso confuse dall'OCR (es. "C.F" letto come "C.E"); la
  // sigla può anche comparire per esteso come "Part. IVA" invece di "P.IVA".
  const combined = flat.match(
    /(?:c\.?\s*[fe]\.?\s*(?:e\s+|\/\s*)?(?:p\.?\s*iva|part\.?\s*iva|partita\s*iva)|(?:p\.?\s*iva|part\.?\s*iva|partita\s*iva)\s*(?:e\s+)?c\.?\s*[fe]\.?)\s*[:\-]?\s*([A-Z0-9]{8,16})/i
  );
  if (combined) {
    const id = combined[1].toUpperCase();
    if (/^\d{11}$/.test(id)) return { vatNumber: id, taxCode: id };
    if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i.test(id)) return { taxCode: id };
    return { vatNumber: id };
  }

  let vatNumber: string | undefined;
  let taxCode: string | undefined;

  const vatMatch = flat.match(
    /(?:p\.?\s*iva|partita\s*iva|vat(?:\s*(?:no|number|reg|id))?|ust-?id|tva|nif|cif)\s*[:\-]?\s*([A-Z]{0,2}\d{8,12})/i
  );
  if (vatMatch) vatNumber = vatMatch[1].toUpperCase();

  const cfMatch = flat.match(
    /(?:cod\.?\s*fisc\.?|codice\s*fiscale|c\.?\s*f\.?)\s*[:\-]?\s*([A-Z0-9]{11,16})/i
  );
  if (cfMatch) {
    const id = cfMatch[1].toUpperCase();
    if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/.test(id)) taxCode = id;
    else if (/^\d{11}$/.test(id) && !vatNumber) vatNumber = id;
    else if (!taxCode) taxCode = id;
  }

  const looseVat = flat.match(/\b(IT\s?)?(\d{11})\b/);
  if (!vatNumber && looseVat && /(?:p\.?\s*iva|partita|iva|vat|c\.?\s*f)/i.test(flat)) {
    vatNumber = looseVat[2];
  }

  return { vatNumber, taxCode };
}

function isValidAddressCandidate(candidate: string, emailLocal: string): boolean {
  const s = candidate.trim();
  if (s.length < 5) return false;
  if (/@/.test(s)) return false;
  if (emailLocal && s.toLowerCase().includes(emailLocal)) return false;
  if (/^www\./i.test(s) || /^https?:/i.test(s)) return false;
  if (/[a-z0-9-]+\.(com|it|net|org|eu)\b/i.test(s)) return false;
  if (/^\d{5}\s*$/.test(s)) return false;
  return true;
}

/** Tipo di strada — se presente è un forte segnale, ma non obbligatorio. */
const STREET_TYPE =
  /\b(?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?|street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.?)\b/i;

const PHONE_HINT =
  /(?:^|\s)(?:M\.|P\.|T\.|F\.|Tel\.?|Fax\.?|Mob\.?|Cell\.?|Telephone|Mobile|Phone)\s*[.+]?\d|^\s*[PTF]\s+[+(]?\d|^0039\b|^\+39\b/i;

/** Alcuni biglietti scrivono civico e CAP senza alcun separatore (es.
 * "Tessitori, 1536015" invece di "Tessitori, 15, 36015" o "15-36015"): senza
 * staccarli l'OCR legge un unico numero enorme e sia il civico sia CAP+città
 * vanno persi. Una cifra 1-4 seguita da esattamente 5 cifre (il CAP è sempre
 * lungo 5 in Italia) viene quindi separata con uno spazio; il backtracking
 * della regex individua da solo l'unico split che lascia 5 cifre finali.
 */
function splitFusedCivicAndCap(text: string): string {
  return text.replace(/\b(\d{1,4})(\d{5})\b/g, '$1 $2');
}

/** Rimuove etichette se l'OCR le include — mai richieste. */
function stripAddressLabel(text: string): string {
  return text
    .trim()
    .replace(/^(?:indirizzo|address|addr\.?|sede(?:\s+(?:legale|operativa|amministrativa))?)\s*[:\-–]\s*/i, '')
    .replace(/^(?:cap|c\.?\s*p\.?|zip|postal\s*code)\s*[:\-–]\s*/i, '')
    .replace(/^(?:citt[aà]|city|localit[aà]|comune|provincia|prov\.?)\s*[:\-–]\s*/i, '')
    .trim();
}

function isAddressExcludedLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2) return true;
  if (EMAIL_SINGLE.test(t)) return true;
  if (looksLikeDomainLine(t)) return true;
  if (TAX_LABEL_LINE.test(t)) return true;
  if (PHONE_HINT.test(t)) return true;
  if (isLikelyPersonName(t)) return true;
  if (isLikelyRoleLine(t)) return true;
  if (ROLE_REGEX.test(t) && !STREET_TYPE.test(t)) return true;
  if (/\b(ufficio|comunicazione|reparto|department|responsabile)\b/i.test(t)) return true;
  if (LEGAL_FORM_REGEX.test(t) && !STREET_TYPE.test(t) && !/\b\d{5}\b/.test(t)) return true;
  return false;
}

function isLikelyCityOnlyLine(text: string): boolean {
  const t = text.trim();
  if (!t || isAddressExcludedLine(t)) return false;
  if (STREET_TYPE.test(t)) return false;
  if (/[·•]/.test(t)) return false;
  if (/\b\d{5}\b/.test(t)) return false;
  if (/\([A-Z]{2}\)/.test(t) || /\b(ITALY|IT|I\.T\.)\s*$/i.test(t)) return true;
  const words = t.split(/\s+/);
  if (words.length === 1 && /^[A-Z\u00C0-\u00D6\u00D8-\u00DE]{2,}$/.test(words[0])) return true;
  if (words.length <= 2 && words.every((w) => /^[A-Z\u00C0-\u00D6\u00D8-\u00DE]{2,}$/.test(w))) {
    return true;
  }
  return false;
}

interface CapCityParts {
  postalCode: string;
  city: string;
  province?: string;
  country?: string;
}

/** L'OCR spesso perde/aggiunge lettere in "ITALY" (es. TALY, ITAL, ITALIA). */
function normalizeCountryToken(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = raw.replace(/\./g, '').toUpperCase();
  if (['ITALY', 'ITALIA', 'ITALI', 'TALY', 'TALIA', 'ITAL', 'IT'].includes(t)) return 'ITALY';
  return t.length >= 3 ? t : undefined;
}

/** Sigle di provincia: vedi `address-format.ts` (import `VALID_PROVINCE_CODES`). */

function extractCapCity(text: string): CapCityParts | null {
  // CAP di 5 caratteri con O/I letti al posto di 0/1 (es. 2502O → 25020)
  const capFixed = stripAddressLabel(text).replace(/\b([0-9oOIl]{5})\b/g, (token) => {
    const digits = (token.match(/\d/g) ?? []).length;
    return digits >= 3 ? token.replace(/[oO]/g, '0').replace(/[Il]/g, '1') : token;
  });
  const t = fixOcrDigits(capFixed.replace(/\s+/g, ' ').trim());
  if (!t || isAddressExcludedLine(t)) return null;

  // "36010 zanè vi italy" — provincia senza parentesi prima del paese.
  const capProvCountry = t.match(
    /\b(\d{5})\s+([A-Za-zÀ-ü][A-Za-zÀ-ü'`,.-]{0,28})\s+([A-Za-z]{2})\s+(italy|italia|it)\s*$/i
  );
  if (capProvCountry) {
    const provCode = capProvCountry[3].toUpperCase();
    return {
      postalCode: capProvCountry[1],
      city: capProvCountry[2].trim().replace(/[,\s]+$/, ''),
      province: VALID_PROVINCE_CODES.has(provCode) ? `(${provCode})` : undefined,
      country: normalizeCountryToken(capProvCountry[4]),
    };
  }

  // Il paese finale è decorativo e spesso corrotto dall'OCR (es. "TALY" invece di "ITALY"):
  // non deve mai far fallire il riconoscimento di CAP e città.
  // La provincia tra parentesi dovrebbe avere 2 lettere (es. "(VI)"), ma l'OCR a
  // volte ne perde una (es. "(V)" invece di "(VI)") o taglia anche la parentesi
  // di chiusura a fine riga (es. "Schio (V" invece di "Schio (VI)"): senza
  // tollerare anche la ")" mancante l'intero match di CAP+città falliva,
  // perdendo anche quei due campi (provincia mancante viene comunque recuperata
  // dopo, tramite resolveProvince, in base al nome della città).
  const full = t.match(
    /\b(\d{5})\s*[-–]?\s+([A-Z\u00C0-\u00D6\u00D8-\u00DEA-Za-z\u00E0-\u00FF][A-Za-z\u00C0-\u00FF\s'-]{0,35}?)(?:\s*\(([A-Z]{1,2})\)?)?(?:\s+([A-Za-z]{3,10}))?\s*$/i
  );
  if (full) {
    return {
      postalCode: full[1],
      city: full[2].trim(),
      province: full[3] ? `(${full[3]})` : undefined,
      country: normalizeCountryToken(full[4]),
    };
  }

  if (/^\d{5}$/.test(t)) {
    return { postalCode: t, city: '' };
  }

  const cityOnly = t.match(
    /^([A-Z\u00C0-\u00D6\u00D8-\u00DEA-Za-z\u00E0-\u00FF][A-Za-z\u00C0-\u00FF\s'-]{1,35}?)(?:\s*\(([A-Z]{1,2})\)?)?(?:\s+([A-Za-z]{3,10}))?\s*$/i
  );
  if (cityOnly && isLikelyCityOnlyLine(t)) {
    return {
      postalCode: '',
      city: cityOnly[1].trim(),
      province: cityOnly[2] ? `(${cityOnly[2]})` : undefined,
      country: normalizeCountryToken(cityOnly[3]),
    };
  }

  // Ultimo fallback: quando il CAP è così corrotto dall'OCR da non contenere
  // più 5 cifre riconoscibili (es. "y6o1" invece di "36015": non solo lettere
  // scambiate per cifre, ma un carattere mancante) i pattern sopra falliscono
  // e si perde l'intero indirizzo, pur essendo "CITTÀ (PROVINCIA)" ancora
  // perfettamente leggibile in coda alla riga. Recuperiamo almeno città e
  // provincia, ignorando il prefisso illeggibile: meglio un indirizzo
  // parziale corretto che nessun indirizzo.
  const tail = t.match(
    /\b([A-Z\u00C0-\u00D6\u00D8-\u00DEA-Za-z\u00E0-\u00FF][A-Za-z\u00C0-\u00FF'-]{1,25})\s*\(([A-Za-z]{1,2})\)?\s*$/
  );
  if (tail && !isLikelyPersonName(tail[1]) && !isCompanyNoiseLine(tail[1])) {
    return {
      postalCode: '',
      city: tail[1].trim(),
      province: `(${tail[2].toUpperCase()})`,
    };
  }

  return null;
}

// Il suffisso dopo il civico (es. "12/A") accetta un trattino SOLO se seguito da una
// lettera: un trattino seguito da altre cifre (es. "15-36015") è quasi sempre il
// separatore col CAP sulla stessa riga, non parte del numero civico.
const STREET_TYPED_PATTERN =
  /^(?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?|street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.?)\s+(?:[A-Z]\.\s*)?[A-Za-z0-9\u00C0-\u00FF .'-]+(?:\s+[A-Za-z0-9\u00C0-\u00FF .'-]+)*(?:,?\s+(?:n\.?\s*)?\d+(?:[a-zA-Z\/]|-(?=[A-Za-z]))?)?/i;

/** Alcuni biglietti spezzano l'indirizzo mettendo solo la provincia tra parentesi
 * sulla riga successiva (es. "...36015 Schio" poi "(VI)", a volte letta "(V)"
 * quando l'OCR perde una lettera). */
function extractBareProvince(text: string): string | undefined {
  const m = text.trim().match(/^\(?\s*([A-Za-zÀ-Ü]{1,2})\s*\)?$/);
  return m ? `(${m[1].toUpperCase()})` : undefined;
}

function extractStreet(text: string): string | null {
  const t = stripAddressLabel(text).replace(/\s+/g, ' ').trim();
  if (!t || t.length < 5 || isAddressExcludedLine(t)) return null;
  if (/^\d{5}\b/.test(t) && !STREET_TYPE.test(t)) return null;

  // Cerca il tipo di via ovunque nella riga: ignora eventuale testo prima
  // (es. nome azienda incollato dall'OCR: "GIVI erl Via S. Guasimodo, 45")
  const typeMatch = STREET_TYPE.exec(t);
  if (typeMatch) {
    const fromType = t.slice(typeMatch.index);
    const typed = fromType.match(STREET_TYPED_PATTERN);
    if (typed) {
      const street = typed[0]
        .replace(/\s+\d{5}\b.*$/, '')
        .replace(/[,-]\s*$/, '')
        .trim();
      if (street.length >= 6 && !isLikelyPersonName(street)) return street;
    }
  }

  // Fallback (via senza parola-tipo, es. "Rossi 12") solo se la riga non
  // sembra iniziare con un nome azienda/marchio in maiuscolo.
  if (!STREET_TYPE.test(t) && !/^[A-Z\u00C0-\u00D6\u00D8-\u00DE]{3,}\b/.test(t)) {
    const civicEnd = t.match(
      /^(?:[A-Z]\.\s*)?[A-Za-z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF0-9 .'-]{2,48},?\s+(?:n\.?\s*)?\d+[a-zA-Z/-]?\s*$/i
    );
    if (civicEnd) {
      const street = civicEnd[0].replace(/,\s*$/, '').trim();
      if (street.length >= 8 && !isLikelyPersonName(street) && !ROLE_REGEX.test(street)) {
        return street;
      }
    }
  }

  return null;
}

function buildAddress(parts: {
  street?: string;
  civicNumber?: string;
  postalCode?: string;
  city?: string;
  province?: string;
  country?: string;
}): Address | undefined {
  return buildFormattedAddress({
    street: parts.street,
    civicNumber: parts.civicNumber,
    postalCode: parts.postalCode,
    city: parts.city,
    region: parts.province?.replace(/[()]/g, '').trim(),
    country: parts.country,
  });
}

function scoreAddressCandidate(addr: Address): number {
  let score = 0;
  if (addr.street && STREET_TYPE.test(addr.street)) score += 100;
  else if (addr.street) score += 40;
  if (addr.postalCode) score += 80;
  if (addr.city) score += 25;
  if (addr.full && /\s-\s[A-Z]{2}\s-\s(?:IT|UK|US|DE|FR|CH)\s*$/i.test(addr.full)) score += 10;
  if (addr.full && /\b(IT|ITALY|ITALIA)\s*$/i.test(addr.full)) score += 8;
  if (addr.full && isLikelyPersonName(addr.full)) score -= 300;
  if (addr.full && /\b(ufficio|comunicazione|responsabile|reparto)\b/i.test(addr.full)) score -= 300;
  if (addr.full && !addr.postalCode && !addr.street) score -= 200;
  score += Math.min(addr.full?.length ?? 0, 40);
  return score;
}

function parseDotSeparatedAddress(line: string): Address | undefined {
  const trimmed = line.trim();
  if (!/^(?:via|viale|piazza|corso|vicolo|largo|galleria|v\.|str\.)/i.test(trimmed)) {
    return undefined;
  }

  const inline = parseItalianInlineAddress(trimmed);
  if (inline) return buildFormattedAddress(inline);

  if (!/[\u00b7\u2022·•]/.test(line)) return undefined;
  let parts = trimmed
    .split(/\s*[\u00b7\u2022·•]\s*/g)
    .map((p) => p.trim().replace(/[.,]+$/g, ''))
    .filter(Boolean);
  if (parts.length < 2) {
    // Separatori OCR con punto spaziato (es. "Torrebelvicino . VI"), ma NON
    // le abbreviazioni "S. D." nella via.
    const alt = trimmed
      .split(/\s+\.\s+(?=[A-ZÀ-Ü][a-zà-ü]{2,})/g)
      .map((p) => p.trim().replace(/[.,]+$/g, ''))
      .filter(Boolean);
    if (alt.length >= 2) parts = alt;
  }
  if (parts.length < 2) return undefined;

  const street = parts[0];
  const city = parts[1];
  let province: string | undefined;
  let country: string | undefined;

  for (let i = 2; i < parts.length; i++) {
    const p = parts[i].trim();
    if (/^(IT|ITALY|ITALIA)$/i.test(p)) {
      country = p.toUpperCase() === 'IT' ? 'IT' : p;
    } else if (/^[A-Z]{2}$/i.test(p)) {
      province = p.toUpperCase();
    }
  }

  return buildAddress({ street, city, province, country });
}

function parseAddressFromText(text: string, emails: string[]): Address | undefined {
  const emailLocal = emails[0]?.split('@')[0]?.toLowerCase() ?? '';
  const cleaned = splitFusedCivicAndCap(stripAddressLabel(text).trim());
  const flat = cleaned.replace(/\s+/g, ' ');

  const inlineAddr = parseItalianInlineAddress(flat);
  if (inlineAddr) {
    const fromInline = buildAddress({
      street: inlineAddr.street,
      civicNumber: inlineAddr.civicNumber,
      city: inlineAddr.city,
      province: inlineAddr.region,
      country: inlineAddr.country,
    });
    if (fromInline?.full && isValidAddressCandidate(fromInline.full, emailLocal)) return fromInline;
  }

  const dotAddr = parseDotSeparatedAddress(flat);
  if (dotAddr?.full && isValidAddressCandidate(dotAddr.full, emailLocal)) return dotAddr;

  const tryBuild = (parts: {
    street?: string;
    postalCode?: string;
    city?: string;
    province?: string;
    country?: string;
  }): Address | undefined => {
    const candidate = buildAddress(parts);
    if (candidate?.full && isValidAddressCandidate(candidate.full, emailLocal)) return candidate;
    return undefined;
  };

  // Via + civico e CAP+città sulla stessa riga OCR
  const splitAtCap = flat.match(/^(.+?\d[a-zA-Z]?)\s+(\d{5}\s+\S.+)$/);
  if (splitAtCap) {
    const street = extractStreet(splitAtCap[1]) ?? splitAtCap[1].trim();
    const capCity = extractCapCity(splitAtCap[2]);
    const merged = tryBuild({
      street,
      postalCode: capCity?.postalCode,
      city: capCity?.city,
      province: capCity?.province,
      country: capCity?.country,
    });
    if (merged) return merged;
  }

  const street = extractStreet(flat);
  const capCity = extractCapCity(flat);
  const combined = tryBuild({
    street: street ?? undefined,
    postalCode: capCity?.postalCode,
    city: capCity?.city,
    province: capCity?.province,
    country: capCity?.country,
  });
  if (combined) return combined;

  if (street) {
    const partial = tryBuild({ street });
    if (partial) return partial;
  }

  const lineParts = cleaned.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lineParts.length; i++) {
    const s = extractStreet(lineParts[i]);
    for (let j = i; j < Math.min(i + 3, lineParts.length); j++) {
      const cc = extractCapCity(lineParts[j]);
      if (s && cc?.city) {
        const merged = tryBuild({ street: s, ...cc });
        if (merged) return merged;
      }
    }
  }

  return undefined;
}

function parseAddressFromLines(lines: OcrLine[], text: string, emails: string[]): Address | undefined {
  const emailLocal = emails[0]?.split('@')[0]?.toLowerCase() ?? '';
  let best: Address | undefined;
  let bestScore = 0;

  const consider = (candidate: Address | undefined) => {
    if (!candidate?.full || !isValidAddressCandidate(candidate.full, emailLocal)) return;
    const score = scoreAddressCandidate(candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  };

  consider(parseAddressFromText(text, emails));

  const lineTexts = lines
    .map((l) => splitFusedCivicAndCap(stripAddressLabel((l.text ?? '').trim())))
    .filter((t) => t.length >= 2 && !isAddressExcludedLine(t));

  for (let i = 0; i < lineTexts.length; i++) {
    consider(parseDotSeparatedAddress(lineTexts[i]));
    consider(parseAddressFromText(lineTexts[i], emails));

    const street = extractStreet(lineTexts[i]);
    let capCity = extractCapCity(lineTexts[i]);
    if (capCity?.city && !capCity.province) {
      const bareProvince = extractBareProvince(lineTexts[i + 1] ?? '');
      if (bareProvince) capCity = { ...capCity, province: bareProvince };
    }

    if (street && capCity?.city) {
      consider(buildAddress({ street, ...capCity }));
    } else if (street) {
      for (let j = i - 1; j >= Math.max(0, i - 2); j--) {
        let prevCap = extractCapCity(lineTexts[j]);
        if (prevCap?.city && !prevCap.province) {
          const bareProvince = extractBareProvince(lineTexts[j + 1] ?? '');
          if (bareProvince) prevCap = { ...prevCap, province: bareProvince };
        }
        if (prevCap?.city || prevCap?.postalCode) {
          consider(buildAddress({ street, ...prevCap }));
        }
      }
      for (let j = i + 1; j < Math.min(i + 3, lineTexts.length); j++) {
        let nearCap = extractCapCity(lineTexts[j]);
        if (nearCap?.city && !nearCap.province) {
          const bareProvince = extractBareProvince(lineTexts[j + 1] ?? '');
          if (bareProvince) nearCap = { ...nearCap, province: bareProvince };
        }
        if (nearCap?.city || nearCap?.postalCode) {
          consider(buildAddress({ street, ...nearCap }));
        }
        if (/^\d{5}$/.test(lineTexts[j]) && j + 1 < lineTexts.length) {
          const merged = extractCapCity(`${lineTexts[j]} ${lineTexts[j + 1]}`);
          if (merged?.city) consider(buildAddress({ street, ...merged }));
        }
      }
    } else if (capCity?.postalCode && !capCity.city && i + 1 < lineTexts.length) {
      const merged = extractCapCity(`${lineTexts[i]} ${lineTexts[i + 1]}`);
      const prevStreet = i > 0 ? extractStreet(lineTexts[i - 1]) : null;
      if (merged?.city) {
        consider(buildAddress({ street: prevStreet ?? undefined, ...merged }));
      }
    } else if (capCity?.city) {
      const prevStreet =
        (i > 0 ? extractStreet(lineTexts[i - 1]) : null) ??
        (i > 1 ? extractStreet(lineTexts[i - 2]) : null);
      consider(buildAddress({ street: prevStreet ?? undefined, ...capCity }));
    }
  }

  for (let i = 0; i < lineTexts.length; i++) {
    const block = lineTexts.slice(i, Math.min(i + 4, lineTexts.length)).join('\n');
    consider(parseAddressFromText(block, emails));
  }

  return best;
}

export { normalizeAddress } from './address-format';

export { buildCardTitle } from './card-title';

export interface CardPage {
  lines: OcrLine[];
  rawText: string;
}

const MAX_CARD_LINES = 120;
const MAX_CARD_LINE_LEN = 180;
const MAX_CARD_TEXT_LEN = 6000;

/** Riordina le righe secondo l'ordine naturale di lettura (dall'alto in
 * basso, da sinistra a destra) quando ci sono le coordinate. È una difesa:
 * a volte l'OCR consegna le righe in ordine sparso (o addirittura dal basso
 * verso l'alto), il che manda in tilt il riconoscimento di ruolo e azienda.
 * Se anche una sola riga è priva di coordinate NON tocchiamo l'ordine, per
 * non rischiare di peggiorarlo affidandoci a dati incompleti. */
function sortLinesTopToBottom(lines: OcrLine[]): OcrLine[] {
  if (lines.length < 2) return lines;
  if (!lines.every((l) => l.boundingBox && typeof l.boundingBox.y === 'number')) {
    return lines;
  }
  return [...lines].sort((a, b) => {
    const ay = a.boundingBox?.y ?? 0;
    const by = b.boundingBox?.y ?? 0;
    if (Math.abs(ay - by) > 12) return ay - by;
    return (a.boundingBox?.x ?? 0) - (b.boundingBox?.x ?? 0);
  });
}

function clampCardPage(page: CardPage): CardPage {
  const ordered = sortLinesTopToBottom(page.lines);
  const lines = ordered.slice(0, MAX_CARD_LINES).map((line) => ({
    ...line,
    text: (line.text ?? '').slice(0, MAX_CARD_LINE_LEN),
  }));
  const rawText = (page.rawText ?? '').slice(0, MAX_CARD_TEXT_LEN);
  return { lines, rawText };
}

export type CardFields = Pick<
  BusinessCard,
  | 'firstName'
  | 'lastName'
  | 'role'
  | 'company'
  | 'emails'
  | 'phones'
  | 'address'
  | 'vatNumber'
  | 'taxCode'
  | 'website'
  | 'rawText'
  | 'confidence'
  | 'emailEvidence'
  | 'extractionReview'
  | 'contactReviewState'
>;

function emptyCardFields(rawText: string): CardFields {
  return {
    firstName: '',
    lastName: '',
    role: '',
    company: '',
    emails: [],
    phones: [],
    address: undefined,
    vatNumber: undefined,
    taxCode: undefined,
    website: undefined,
    rawText,
    confidence: {
      firstName: 0.2,
      lastName: 0.2,
      company: 0.2,
      role: 0.2,
      emails: 0.2,
      phones: 0.2,
    },
  };
}

function cardLinesForParsing(lines: OcrLine[], rawText: string): OcrLine[] {
  const fromOcr = lines
    .map((line) => ({ ...line, text: (line.text ?? '').trim() }))
    .filter((line) => line.text.length >= 1 && !isCardBackgroundNoise(line.text));
  if (fromOcr.length >= 1) return fromOcr;

  const filtered = filterCardRelevantLines(lines);
  if (filtered.length >= 1) return filtered;

  const relaxed = lines
    .map((line) => ({ ...line, text: (line.text ?? '').trim() }))
    .filter((line) => line.text.length >= 2 && !isCardBackgroundNoise(line.text));
  if (relaxed.length >= 1) return relaxed;

  return rawText
    .split('\n')
    .map((text) => text.trim())
    .filter((text) => text.length >= 2)
    .map((text) => ({ text, confidence: 0.7 }));
}

function cardTextForParsing(lines: OcrLine[], rawText: string): string {
  const parsedLines = cardLinesForParsing(lines, rawText);
  const fromLines = parsedLines.map((l) => l.text).join('\n').trim();
  if (fromLines.length >= 8) return fromLines;
  return filterCardRelevantText(lines, rawText) || rawText.trim() || fromLines;
}

function parseCardFields(lines: OcrLine[], rawText: string): CardFields {
  const parsedLines = cardLinesForParsing(lines, rawText);
  const parsedText = repairOcrContactText(cardTextForParsing(lines, rawText));
  const repairedRaw = repairOcrContactText(rawText.trim());

  const emails = extractEmails(parsedText);
  const phones = [
    ...extractPhones(parsedText),
    ...extractPhones(repairedRaw),
  ].filter(
    (phone, index, list) =>
      list.findIndex((p) => p.number.replace(/\D/g, '') === phone.number.replace(/\D/g, '')) === index
  );
  let website = extractWebsite(parsedText, emails);
  const taxFromRelevant = extractTaxIds(parsedText);
  const taxIds =
    taxFromRelevant.vatNumber || taxFromRelevant.taxCode ? taxFromRelevant : extractTaxIds(repairedRaw);

  let { firstName, lastName, lineIndex: nameLineIndex } = parseName(parsedLines, emails);
  const personalEmail = pickPersonalEmail(emails);
  if ((!firstName || !lastName) && personalEmail) {
    const fromEmail = nameFromEmail(personalEmail);
    if (!firstName && fromEmail.firstName) firstName = fromEmail.firstName;
    if (!lastName && fromEmail.lastName) lastName = fromEmail.lastName;
    if (nameLineIndex < 0) nameLineIndex = findPersonNameLineIndex(parsedLines);
  }

  const company =
    parseCompany(parsedText, emails, parsedLines, website) ||
    parseCompany(repairedRaw, emails, lines, website);
  const reconciledEmails = reconcileEmailsWithCardContext(
    emails,
    `${parsedText}\n${repairedRaw}`,
    website,
    company
  );
  if (reconciledEmails.length > 0) {
    website = reconcileWebsiteWithEmail(website, reconciledEmails);
    if ((!firstName || !lastName) && reconciledEmails[0]) {
      const fromEmail = nameFromEmail(pickPersonalEmail(reconciledEmails));
      if (!firstName && fromEmail.firstName) firstName = fromEmail.firstName;
      if (!lastName && fromEmail.lastName) lastName = fromEmail.lastName;
    }
  }
  const role =
    parseRole(parsedText, parsedLines, nameLineIndex) ||
    parseRole(repairedRaw, lines, findPersonNameLineIndex(lines));
  ({ firstName, lastName } = sanitizePersonNames(firstName, lastName, emails, parsedLines));
  const address =
    normalizeAddress(
      parseAddressFromLines(parsedLines, parsedText, emails) ??
        parseAddressFromLines(lines, repairedRaw, emails)
    ) ?? undefined;

  return {
    firstName,
    lastName,
    role,
    company,
    emails: reconciledEmails.length > 0 ? reconciledEmails : emails,
    phones,
    address,
    vatNumber: taxIds.vatNumber,
    taxCode: taxIds.taxCode,
    website,
    rawText: repairedRaw,
    confidence: {
      firstName: firstName ? 0.9 : 0.3,
      lastName: lastName ? 0.85 : 0.2,
      company: company ? 0.9 : 0.3,
      role: role ? 0.8 : 0.2,
      emails: (reconciledEmails.length > 0 ? reconciledEmails : emails).length > 0 ? 0.95 : 0.2,
      phones: phones.length > 0 ? 0.9 : 0.2,
    },
  };
}

function mergeEmails(parts: CardFields[]): string[] {
  const all = [...new Set(parts.flatMap((p) => p.emails))];
  return all.sort((a, b) => {
    if (a.startsWith('info@')) return 1;
    if (b.startsWith('info@')) return -1;
    return a.localeCompare(b);
  });
}

function mergePhones(parts: CardFields[]): Phone[] {
  const byDigits = new Map<string, Phone>();
  for (const part of parts) {
    for (const phone of part.phones) {
      const key = phone.number.replace(/\D/g, '');
      if (key.length >= 9 && key.length <= 15) {
        byDigits.set(key, phone);
      }
    }
  }
  return [...byDigits.values()];
}

function mergeName(parts: CardFields[]): { firstName: string; lastName: string } {
  const withFullName = parts.filter((p) => p.firstName && p.lastName);
  const best = withFullName.sort((a, b) => b.lastName.length - a.lastName.length)[0];
  if (best) return { firstName: best.firstName, lastName: best.lastName };
  return {
    firstName: parts.find((p) => p.firstName)?.firstName ?? '',
    lastName: parts.find((p) => p.lastName)?.lastName ?? '',
  };
}

function companyScore(name: string): number {
  let score = name.length;
  if (/\.(com|it|net|org|eu)\b/i.test(name)) score -= 50;
  if (/^www\./i.test(name)) score -= 50;
  if (/sede\s+(legale|operativa)/i.test(name)) score -= 100;
  if (/\b(tax|tel|fax|tol)\b/i.test(name)) score -= 200;
  if (digitCount(name) >= 6) score -= 150;
  if (isLikelyPersonName(name)) score -= 200;
  if (isLikelyActivityLine(name)) score -= 150;
  if (isLikelyIndustryAcronymLine(name)) score -= 250;
  if (hasLegalFormSuffix(name)) score += 80;
  if (LEGAL_FORM_REGEX.test(name)) score += 8;
  if (/^[A-ZÀ-Ü0-9&-]{3,20}$/.test(name.trim())) score += 12;
  return score;
}

function mergeCompany(parts: CardFields[]): string {
  const companies = parts.map((p) => p.company).filter(Boolean);
  const pool = companies.filter(
    (c) =>
      !isLikelyActivityLine(c) &&
      !isLikelyPersonName(c) &&
      !isLikelyIndustryAcronymLine(c)
  );
  const fallback = companies.filter((c) => !isLikelyActivityLine(c));
  const candidates = pool.length ? pool : fallback.length ? fallback : companies;
  return candidates.sort((a, b) => companyScore(b) - companyScore(a))[0] ?? '';
}

function mergeRole(parts: CardFields[]): string {
  const roles = parts.map((p) => p.role).filter(Boolean);
  const jobRoles = roles.filter((r) => {
    const t = r.trim();
    return /\b(sales|marketing|dept|direttore|responsabile|manager|commercialista)\b/i.test(t);
  });
  if (jobRoles.length) return jobRoles.sort((a, b) => b.length - a.length)[0];
  const nonActivity = roles.filter((r) => !isLikelyActivityLine(r));
  return (nonActivity.length ? nonActivity : roles).sort((a, b) => b.length - a.length)[0] ?? '';
}

/** Ricalcola l'azienda guardando TUTTE le righe di TUTTE le pagine. Usato solo
 * per correggere slogan/attività scambiati per azienda, o per completare un
 * marchio parziale (es. "ARREDAMENTI" → "Arredamenti La Bussola"). */
function resolveCompanyFromAllPages(
  currentCompany: string,
  pageCompanies: string[],
  allLines: OcrLine[],
  emails: string[] = [],
  website?: string,
  pages: CardPage[] = []
): string {
  let fromLegal = '';
  for (const page of pages) {
    const legal = extractCompanyFromLegalForm(page.lines, emails, website);
    if (legal.length > fromLegal.length) fromLegal = legal;
  }
  if (!fromLegal) {
    fromLegal = extractCompanyFromLegalForm(allLines, emails, website);
  }
  if (
    fromLegal &&
    (!currentCompany ||
      isLikelyIndustryAcronymLine(currentCompany) ||
      !hasLegalFormSuffix(currentCompany))
  ) {
    return fromLegal;
  }

  const repetition = buildBrandRepetitionScores(allLines);
  const candidates = new Set<string>();

  for (let i = 0; i < allLines.length; i++) {
    const t = fixOcrZeros(allLines[i].text.trim().replace(/\s+/g, ' '));
    if (!t || t.length < 4 || isLikelyActivityLine(t) || isCompanyNoiseLine(t)) continue;
    if (isLikelyIndustryAcronymLine(t)) continue;
    if (/^(interni|gmail|yahoo|hotmail)$/i.test(t)) continue;
    if (/\b(tax|tel|fax|tol)\b/i.test(t) || digitCount(t) >= 8) continue;
    const ctx = { repetition };
    if (scoreCompanyLine(t, ctx) > 0) candidates.add(t);
    if (i + 1 < allLines.length) {
      const next = fixOcrZeros(allLines[i + 1].text.trim());
      if (next && !isLikelyActivityLine(next) && !isCompanyNoiseLine(next)) {
        const combined = combineBrandFragments(t, next);
        if (scoreCompanyLine(combined, ctx) > 0) candidates.add(combined);
      }
    }
    if (i > 0) {
      const prev = fixOcrZeros(allLines[i - 1].text.trim());
      if (
        prev &&
        !isLikelyActivityLine(prev) &&
        !isCompanyNoiseLine(prev) &&
        !isLikelyPersonName(prev)
      ) {
        const combined = combineBrandFragments(prev, t);
        if (scoreCompanyLine(combined, ctx) > 0) candidates.add(combined);
      }
    }
  }

  const ranked = [...candidates].sort(
    (a, b) => scoreCompanyLine(b, { repetition }) - scoreCompanyLine(a, { repetition })
  );
  const best = ranked[0] ? formatCompanyLine(ranked[0]) : '';

  if (!currentCompany || isLikelyActivityLine(currentCompany) || isLikelyIndustryAcronymLine(currentCompany)) {
    return best || currentCompany;
  }

  if (hasLegalFormSuffix(currentCompany)) {
    return currentCompany;
  }

  // Completa un marchio PARZIALE già riconosciuto (stessa radice o stesso multiset)
  const curKey = normalizeBrandKey(currentCompany);
  const curMKey = brandMultisetKey(currentCompany);
  if (
    best &&
    best.length > currentCompany.length &&
    (normalizeBrandKey(best).includes(curKey.slice(0, Math.min(curKey.length, 8))) ||
      brandMultisetKey(best) === curMKey ||
      (curMKey.length >= 6 && brandMultisetKey(best).includes(curMKey)))
  ) {
    return best;
  }

  return currentCompany;
}

function mergeCardFields(parts: CardFields[]): CardFields {
  const { firstName, lastName } = mergeName(parts);
  const emails = mergeEmails(parts);
  const phones = mergePhones(parts);
  const company = mergeCompany(parts);
  const role = mergeRole(parts);
  const address =
    parts
      .map((p) => p.address)
      .filter((a): a is Address => Boolean(a?.full))
      .sort((a, b) => scoreAddressCandidate(b) - scoreAddressCandidate(a))[0] ??
    undefined;
  // Preferisci un sito scritto esplicitamente sul biglietto (letteralmente
  // presente nel testo OCR) rispetto a uno solo dedotto dal dominio email,
  // che può differire dal sito reale (es. email @givi.it, sito www.givimoto.com).
  const website =
    parts.find((p) => p.website && p.rawText.toLowerCase().includes(p.website.toLowerCase()))
      ?.website ??
    parts.find((p) => p.website?.startsWith('www.'))?.website ??
    parts.find((p) => p.website)?.website;
  const vatNumber = parts.find((p) => p.vatNumber)?.vatNumber;
  const taxCode = parts.find((p) => p.taxCode)?.taxCode;
  const rawText = parts.map((p) => p.rawText.trim()).filter(Boolean).join('\n\n---\n\n');

  return {
    firstName,
    lastName,
    role,
    company,
    emails,
    phones,
    address,
    vatNumber,
    taxCode,
    website,
    rawText,
    confidence: {
      firstName: firstName ? 0.9 : 0.3,
      lastName: lastName ? 0.85 : 0.2,
      company: company ? 0.9 : 0.3,
      role: role ? 0.8 : 0.2,
      emails: emails.length > 0 ? 0.95 : 0.2,
      phones: phones.length > 0 ? 0.9 : 0.2,
    },
  };
}

/** Analizza ogni foto separatamente e unisce i campi (ordine libero). */
/**
 * Struttura restituita dal fallback AI (solo testo, nessuna immagine): stesso
 * significato dei campi di un biglietto ma tutti opzionali, perché il modello
 * può lasciare vuoto ciò che non trova nel testo.
 */
export interface AiCardFields {
  firstName?: string;
  lastName?: string;
  role?: string;
  company?: string;
  emails?: string[];
  phones?: Array<{ number: string; type?: Phone['type'] }>;
  website?: string;
  address?: { street?: string; postalCode?: string; city?: string; full?: string };
  vatNumber?: string;
  taxCode?: string;
}

/**
 * Un motore a regole, per quanto raffinato, riconosce pattern: non "capisce"
 * un layout mai visto prima. Quando mancano più dati vitali (nome, azienda,
 * un contatto), conviene chiedere aiuto a un modello AI che ragiona sul
 * TESTO già letto gratis da ML Kit (nessuna immagine, costo minimo), invece
 * di continuare ad aggiungere regole sempre più specifiche.
 */
export function cardNeedsAiHelp(
  card: Pick<CardFields, 'firstName' | 'lastName' | 'company' | 'emails' | 'phones' | 'address'>
): boolean {
  const hasName = Boolean(card.firstName || card.lastName);
  const hasCompany = Boolean(card.company);
  const hasContact = card.emails.length > 0 || card.phones.length > 0;
  const hasAddress = Boolean(
    card.address?.street || (card.address?.postalCode && card.address?.city)
  );
  const missing = [!hasName, !hasCompany, !hasContact, !hasAddress].filter(Boolean).length;
  return missing >= 2;
}

/** L'AI a volte restituisce città e provincia unite (es. "Schio (VI)"): le
 * separiamo per poterle ricomporre correttamente con buildAddress/resolveProvince. */
function splitCityProvince(city?: string): { city?: string; province?: string } {
  const t = city?.trim();
  if (!t) return {};
  const m = t.match(/^(.*?)\s*\(([A-Za-z]{1,2})\)\s*$/);
  if (m) return { city: m[1].trim(), province: m[2].toUpperCase() };
  return { city: t };
}

/**
 * Un motore a regole capisce PATTERN, non layout: per nome/cognome, email,
 * telefoni, P.IVA/CF — dati dal formato rigido e ben definito — resta la
 * fonte più affidabile, quindi l'AI riempie solo eventuali buchi. Per
 * azienda, ruolo e indirizzo, invece — i campi che dipendono dal LAYOUT del
 * biglietto e che nella pratica sono quelli che continuano a spezzarsi su
 * ogni nuova variante di layout/rumore OCR — la lettura dell'AI (quando
 * disponibile) è quasi sempre più affidabile di qualunque regex, perché
 * ragiona sul significato del testo invece di cercare pattern predefiniti:
 * la preferiamo quindi anche quando il dato locale non è vuoto ma è solo
 * "diverso".
 */
export function mergeAiCardFields<T extends CardFields>(local: T, ai: AiCardFields | null): T {
  if (!ai) return local;

  const aiPhones = (ai.phones ?? [])
    .map((p) => ({ number: (p.number ?? '').trim(), type: p.type ?? ('work' as const) }))
    .filter((p) => p.number);
  const phones = aiPhones.length > 0 ? dedupePhones([...local.phones, ...aiPhones]) : local.phones;

  const aiCompanyRaw = (ai.company ?? '').trim();
  const aiRole = (ai.role ?? '').trim();
  const websiteHint = local.website || (ai.website ?? '').trim() || undefined;
  const companyDraft = reconcileCompanySpelling(aiCompanyRaw || local.company, local.emails, websiteHint);
  // Il parser locale conserva provenance per riga. Una stringa proposta
  // dall'AI non ha quella garanzia e non può entrare nei recapiti operativi.
  const emails = [...local.emails];
  const company = reconcileCompanySpelling(aiCompanyRaw || local.company, emails, websiteHint);

  let firstName = local.firstName;
  let lastName = local.lastName;
  if (personNamesLookWrong(firstName, lastName, emails)) {
    firstName = '';
    lastName = '';
  }
  const aiFirst = (ai.firstName ?? '').trim();
  const aiLast = (ai.lastName ?? '').trim();
  if (aiFirst || aiLast) {
    const aiFull = `${aiFirst} ${aiLast}`.trim();
    if (!personNamesLookWrong(aiFirst, aiLast, emails) && parsePersonNameLine(aiFull)) {
      if (!firstName) firstName = aiFirst;
      if (!lastName) lastName = aiLast;
    }
  }

  let address = local.address;
  if (ai.address && (ai.address.street || ai.address.city || ai.address.full)) {
    const { city: aiCity, province: aiProvince } = splitCityProvince(ai.address.city);
    address =
      normalizeAddress({
        street: ai.address.street?.trim() || local.address?.street,
        postalCode: ai.address.postalCode?.trim() || local.address?.postalCode,
        city: aiCity || local.address?.city,
        region: aiProvince || local.address?.region,
        country: local.address?.country,
        full: ai.address.full?.trim() || local.address?.full,
      }) ?? local.address;
  }

  const aiRoleClean =
    aiRole && !isLikelyProductCatalogLine(aiRole) && !isLikelyActivityLine(aiRole) ? aiRole : '';

  return {
    ...local,
    firstName,
    lastName,
    role: aiRoleClean || local.role,
    company,
    emails,
    phones,
    website: local.website || (ai.website ?? '').trim() || local.website,
    address,
    vatNumber: local.vatNumber || (ai.vatNumber ?? '').trim() || local.vatNumber,
    taxCode: local.taxCode || (ai.taxCode ?? '').trim() || local.taxCode,
    confidence: {
      firstName: firstName ? (local.firstName ? local.confidence.firstName : 0.75) : local.confidence.firstName,
      lastName: lastName ? (local.lastName ? local.confidence.lastName : 0.75) : local.confidence.lastName,
      company: aiCompanyRaw ? 0.85 : local.confidence.company,
      role: aiRoleClean ? 0.8 : local.confidence.role,
      emails: local.confidence.emails,
      phones: phones.length > local.phones.length ? Math.max(local.confidence.phones, 0.7) : local.confidence.phones,
    },
  };
}

/**
 * Parser principale dell'app: delega interamente a parser-v5.
 * La firma e il tipo di ritorno restano invariati per compatibilità con
 * gli import esistenti (MultiPageScanner, parseCard, ecc.). CardPage è
 * strutturalmente identico a CardPageV5 ({ lines, rawText }).
 */
export function parseCardFromPages(
  pages: CardPage[]
): Omit<BusinessCard, 'type' | 'title' | 'images'> {
  return parseCardFromPagesV5(pages);
}

export function parseCard(lines: OcrLine[], rawText: string): Omit<BusinessCard, 'type' | 'title' | 'images'> {
  return parseCardFromPages([{ lines, rawText }]);
}

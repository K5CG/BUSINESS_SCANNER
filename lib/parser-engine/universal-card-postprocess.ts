import type { Address, Phone } from '../../types';
import type { BusinessCardExtractionResult, ExtractedField } from './card-extraction-result';
import { validateEmail } from './validators/email';
import { validateWebsite } from './validators/website';
import { validatePhone } from './validators/phone';

export interface UniversalCardOverrides {
  firstName?: ExtractedField<string>;
  lastName?: ExtractedField<string>;
  company?: ExtractedField<string>;
  role?: ExtractedField<string>;
  emails?: ExtractedField<string[]>;
  phones?: ExtractedField<Phone[]>;
  website?: ExtractedField<string>;
  address?: ExtractedField<Address | null>;
  vatNumber?: ExtractedField<string>;
  taxCode?: ExtractedField<string>;
}

type LineKind =
  | 'email'
  | 'website'
  | 'phone'
  | 'address'
  | 'tax'
  | 'person'
  | 'role'
  | 'company'
  | 'slogan'
  | 'noise'
  | 'unknown';

interface SemanticLine {
  text: string;
  index: number;
  normalized: string;
  kind: LineKind;
  reasons: string[];
}

const LEGAL_FORM_RE = /\b(?:s\.?n\.?c\.?|snc|s\.?r\.?l\.?|srl|s\.?p\.?a\.?|spa|s\.?a\.?s\.?|sas|gmbh|ag|ltd|llc|inc|s\.a\.|s\.a\.s\.|s\.p\.a\.)\b/i;
const EMAIL_RE = /[A-Z0-9._%+-]+\s*@\s*[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const WEBSITE_RE = /(?:https?:\/\/)?(?:www\.)?[A-Z0-9][A-Z0-9-]*(?:\.[A-Z0-9][A-Z0-9-]*)+\b/gi;
const PHONE_LABEL_RE = /\b(?:tel\.?|telefono|cell\.?|cellulare|mob\.?|mobile|phone|fax|whatsapp|wa)\b/i;
const ROLE_RE = /\b(?:manager|director|direttore|responsabile|commerciale|consulente|consultant|sales|amministratore|delegato|ceo|cfo|cto|presidente|partner|owner|titolare|promotore|coordinatore|marketing|account|project|supply|chain|avv\.?|dott\.?|dott\.ssa|ing\.?|geom\.?|prof\.?)\b/i;
const PERSON_PREFIX_RE = /^(?:(?:di|del|della|dello|dei|degli|de)\s+)?(?:(?:dott\.?ssa?|dr\.?|sig\.?ra?|sig\.?|ing\.?|arch\.?|avv\.?|prof\.?|geom\.?|rag\.?)\s+)?/i;
const OWNER_PERSON_RE = /^(?:di|del|della|dello|dei|degli|de)\s+(?:(?:dott\.?ssa?|dott\.?|dr\.?|sig\.?ra?|sig\.?|ing\.?|arch\.?|avv\.?|prof\.?|geom\.?|rag\.?)\s+)?([A-Za-zÀ-ü][A-Za-zÀ-ü'`.-]+)\s+([A-Za-zÀ-ü][A-Za-zÀ-ü'`.-]+(?:\s+[A-Za-zÀ-ü][A-Za-zÀ-ü'`.-]+)?)\s*$/i;
const TITLED_PERSON_RE = /^(?:(?:dott\.?ssa?|dott\.?|dr\.?|sig\.?ra?|sig\.?|ing\.?|arch\.?|avv\.?|prof\.?|geom\.?|rag\.?)\s+)+([A-Za-zÀ-ü][A-Za-zÀ-ü'`.-]+)\s+([A-Za-zÀ-ü][A-Za-zÀ-ü'`.-]+(?:\s+[A-Za-zÀ-ü][A-Za-zÀ-ü'`.-]+)?)\s*$/i;
const ADDRESS_PREFIX_RE = /\b(?:via|viale|piazza|p\.zza|piazzale|p\.le|corso|c\.so|vicolo|v\.le|contr[aà]|localit[aà]|zona|strada|largo|vico|sede|headquarters|address)\b/i;
const IT_CAP_RE = /\b\d{5}\b/;
const PROVINCE_RE = /\(([A-Z]{2})\)/i;
const TAX_LABEL_RE = /\b(?:p\.?\s*iva|partita\s+iva|cod\.?\s*fisc\.?|codice\s+fiscale|c\.?\s*f\.?|vat|tax)\b/i;
const COMBINED_TAX_RE = /(?:p\.?\s*iva|partita\s+iva)\s*(?:\/|e|-)\s*(?:cod\.?\s*fisc\.?|codice\s+fiscale|c\.?\s*f\.?)|(?:cod\.?\s*fisc\.?|codice\s+fiscale|c\.?\s*f\.?)\s*(?:\/|e|-)\s*(?:p\.?\s*iva|partita\s+iva)/i;

const DESCRIPTION_WORDS = [
  'attrezzato', 'centri', 'storici', 'microsabbiatura', 'verniciatura', 'idropulitura',
  'progettazione', 'installazione', 'vendita', 'produzione', 'servizi', 'soluzioni',
  'consulenza', 'consulting', 'software', 'technology', 'innovation', 'business',
  'marketing', 'luxury', 'racewear', 'authorized', 'dealer', 'manutenzione',
  'impianti', 'forniture', 'sportive', 'aziendali', 'sistemi', 'qualita', 'qualità',
  'certificata', 'certificato', 'division', 'divisione', 'real', 'world', 'adventures',
];

const NOISE_WORDS = [
  'cert', 'iso', 'ukas', 'rina', 'orari', 'apertura', 'chiusura', 'catalogo', 'privacy',
  'about', 'facebook', 'instagram', 'linkedin', 'skype', 'qr', 'rea', 'sdi', 'pec',
];

const COMPANY_STOPWORDS = new Set([
  'srl', 'spa', 'snc', 'sas', 'ag', 'gmbh', 'ltd', 'inc', 'llc', 'consulting', 'consulenza',
  'software', 'solutions', 'soluzioni', 'systems', 'sistemi', 'group', 'gruppo', 'studio',
  'azienda', 'impresa', 'service', 'services', 'italia', 'italy', 'international', 'the', 'and',
]);

function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/[|]/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compactKey(text: string): string {
  return normalizeForMatch(text).replace(/[^a-z0-9]+/g, '');
}

function titleCaseCompany(text: string): string {
  const legal = text.match(LEGAL_FORM_RE)?.[0];
  const normalized = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((part) => {
      if (/^[A-Z0-9&.-]{2,}$/.test(part) && !/^[A-Z]{2,}[a-z]/.test(part)) return part;
      if (/^s\.?n\.?c\.?$/i.test(part)) return 'S.n.c.';
      if (/^s\.?r\.?l\.?$/i.test(part)) return 'S.r.l.';
      if (/^s\.?p\.?a\.?$/i.test(part)) return 'S.p.A.';
      if (/^s\.?a\.?s\.?$/i.test(part)) return 'S.a.s.';
      if (/^[a-zà-ü]/.test(part)) return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      return part;
    })
    .join(' ')
    .replace(/\s+([.,])/g, '$1');
  if (!legal) return normalized;
  return normalized
    .replace(/S\.n\.c\.+/gi, 'S.n.c.')
    .replace(/S\.r\.l\.+/gi, 'S.r.l.')
    .replace(/S\.p\.A\.+/g, 'S.p.A.')
    .replace(/S\.a\.s\.+/gi, 'S.a.s.')
    .replace(/\bS\.n\.c\.?\b/i, 'S.n.c.')
    .replace(/\bS\.r\.l\.?\b/i, 'S.r.l.')
    .replace(/\bS\.p\.A\.?\b/i, 'S.p.A.')
    .replace(/\bS\.a\.s\.?\b/i, 'S.a.s.')
    .replace(/\.\.+/g, '.');
}

function splitLines(rawText: string): string[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function digitCount(text: string): number {
  return text.replace(/\D/g, '').length;
}

function hasDescriptionSignal(text: string): boolean {
  const n = normalizeForMatch(text);
  return DESCRIPTION_WORDS.some((word) => n.includes(word));
}

function hasNoiseSignal(text: string): boolean {
  const n = normalizeForMatch(text);
  return NOISE_WORDS.some((word) => n.includes(word));
}

function extractEmails(rawText: string): string[] {
  const out = new Set<string>();
  const repaired = rawText
    .replace(/\s*@\s*/g, '@')
    .replace(/\s+\.\s*/g, '.')
    .replace(/\(\s*@/g, '@');
  for (const match of repaired.matchAll(EMAIL_RE)) {
    const valid = validateEmail(match[0]);
    if (valid) out.add(valid.toLowerCase());
  }
  return [...out];
}

function isDomainMatchPartOfEmail(text: string, index: number, value: string): boolean {
  const before = text[index - 1] ?? '';
  const after = text[index + value.length] ?? '';
  return before === '@' || after === '@';
}

function inferWebsitesFromEmails(emails: string[]): string[] {
  const out = new Set<string>();
  for (const email of emails) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || !domain.includes('.')) continue;
    if (/^(gmail|hotmail|yahoo|libero|tiscali|email|pec|legalmail|outlook|icloud)\./i.test(domain)) continue;
    out.add(`www.${domain}`);
  }
  return [...out];
}

function isLegalFormHost(value: string): boolean {
  const host = value.toLowerCase().replace(/^www\./, '');
  return /^(?:s\.?n\.?c|s\.?r\.?l|s\.?p\.?a|s\.?a\.?s|snc|srl|spa|sas|p\.?iva|iva|cod|c\.?f)(?:\.|$)/i.test(host);
}

function extractWebsites(rawText: string): string[] {
  const out = new Set<string>();
  const repaired = rawText.replace(/\s+\.\s*/g, '.');
  for (const match of repaired.matchAll(WEBSITE_RE)) {
    const value = match[0].replace(/^https?:\/\//i, '').toLowerCase();
    if (isDomainMatchPartOfEmail(repaired, match.index ?? 0, match[0])) continue;
    if (value.includes('@')) continue;
    const validated = validateWebsite(value.startsWith('www.') ? value : `www.${value}`);
    if (!validated) continue;
    out.add(validated);
  }
  return [...out];
}

function domainRoots(emails: string[], websites: string[]): string[] {
  const roots = new Set<string>();
  const addHost = (host: string) => {
    const clean = host
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]
      .trim();
    const parts = clean.split('.').filter(Boolean);
    if (parts.length < 2) return;
    const root = parts[parts.length - 2];
    if (root && root.length >= 3 && !['gmail', 'hotmail', 'yahoo', 'libero', 'tiscali', 'email', 'pec'].includes(root)) {
      roots.add(root);
    }
  };
  for (const email of emails) addHost(email.split('@')[1] ?? '');
  for (const site of websites) addHost(site);
  return [...roots];
}

function lineKind(text: string): LineKind {
  if (EMAIL_RE.test(text)) return 'email';
  EMAIL_RE.lastIndex = 0;
  if (PHONE_LABEL_RE.test(text) || /^\+?\d[\d\s./()-]{6,}$/.test(text)) return 'phone';
  if (TAX_LABEL_RE.test(text) || /\b\d{11}\b/.test(text)) return 'tax';
  if (ADDRESS_PREFIX_RE.test(text) || (IT_CAP_RE.test(text) && PROVINCE_RE.test(text))) return 'address';
  if (/\b(?:www\.|https?:\/\/)/i.test(text)) return 'website';
  if (OWNER_PERSON_RE.test(text) || TITLED_PERSON_RE.test(text)) return 'person';
  if (ROLE_RE.test(text)) return 'role';
  if (hasNoiseSignal(text)) return 'noise';
  if (hasDescriptionSignal(text)) return 'slogan';
  if (LEGAL_FORM_RE.test(text)) return 'company';
  return 'unknown';
}

function semanticLines(rawText: string): SemanticLine[] {
  return splitLines(rawText).map((text, index) => ({
    text,
    index,
    normalized: normalizeForMatch(text),
    kind: lineKind(text),
    reasons: [],
  }));
}

function domainMatchScore(text: string, roots: string[]): number {
  const key = compactKey(text);
  if (!key) return 0;
  let best = 0;
  for (const root of roots) {
    const r = compactKey(root);
    if (!r) continue;
    if (key.includes(r) || r.includes(key)) best = Math.max(best, 1);
    const tokens = normalizeForMatch(text).split(/\s+/).filter((t) => t.length >= 3 && !COMPANY_STOPWORDS.has(t));
    const hit = tokens.some((token) => r.includes(token) || token.includes(r));
    if (hit) best = Math.max(best, 0.75);
  }
  return best;
}

function isLikelyCompanyText(text: string): boolean {
  if (!text || text.length < 2) return false;
  if (EMAIL_RE.test(text)) return false;
  EMAIL_RE.lastIndex = 0;
  if (PHONE_LABEL_RE.test(text) || digitCount(text) >= 7) return false;
  if (ADDRESS_PREFIX_RE.test(text) || (IT_CAP_RE.test(text) && PROVINCE_RE.test(text))) return false;
  if (TAX_LABEL_RE.test(text)) return false;
  if (OWNER_PERSON_RE.test(text) || TITLED_PERSON_RE.test(text)) return false;
  return true;
}

function scoreCompanyLine(line: SemanticLine, roots: string[], lineCount: number): { score: number; reasons: string[] } {
  if (!isLikelyCompanyText(line.text)) return { score: -99, reasons: ['non-company strutturale'] };
  const reasons: string[] = [];
  let score = 0;
  const tokens = line.normalized.split(/\s+/).filter(Boolean);
  const hasLegal = LEGAL_FORM_RE.test(line.text);
  const domainScore = domainMatchScore(line.text, roots);
  const description = hasDescriptionSignal(line.text);
  const topBonus = line.index <= Math.max(2, Math.floor(lineCount * 0.25)) ? 10 : 0;

  if (hasLegal) {
    score += 70;
    reasons.push('forma giuridica');
  }
  if (domainScore > 0) {
    score += 60 * domainScore;
    reasons.push('coerente con dominio email/sito');
  }
  if (/^[A-Z0-9& .'-]{3,}$/.test(line.text) && /[A-Z]{2}/.test(line.text)) {
    score += 18;
    reasons.push('casing da brand');
  }
  if (tokens.length >= 1 && tokens.length <= 5) {
    score += 15;
    reasons.push('lunghezza compatibile con brand');
  }
  score += topBonus;
  if (topBonus) reasons.push('posizione alta');

  if (description && !hasLegal && domainScore < 0.5) {
    score -= 55;
    reasons.push('descrizione/slogan senza dominio/legal form');
  }
  if (line.kind === 'slogan') score -= 35;
  if (line.kind === 'role' || line.kind === 'address' || line.kind === 'tax') score -= 70;
  if (tokens.length > 7 && !hasLegal) score -= 30;
  if (hasNoiseSignal(line.text)) score -= 35;

  return { score, reasons };
}

function joinCompanyWithLegalForm(lines: SemanticLine[], index: number): string | null {
  const current = lines[index];
  if (!current || LEGAL_FORM_RE.test(current.text)) return null;
  for (let j = index + 1; j <= Math.min(index + 2, lines.length - 1); j++) {
    const next = lines[j];
    if (!next || !LEGAL_FORM_RE.test(next.text)) continue;
    if (!isLikelyCompanyText(next.text)) continue;
    return `${current.text} ${next.text}`.replace(/\s+/g, ' ').trim();
  }
  return null;
}

function extractCompany(rawText: string): ExtractedField<string> | undefined {
  const lines = semanticLines(rawText);
  const emails = extractEmails(rawText);
  const sites = extractWebsites(rawText);
  const roots = domainRoots(emails, sites);
  let best: { value: string; score: number; reasons: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const variants = [lines[i].text];
    const joined = joinCompanyWithLegalForm(lines, i);
    if (joined) variants.push(joined);

    for (const variant of variants) {
      const semantic = { ...lines[i], text: variant, normalized: normalizeForMatch(variant) };
      const scored = scoreCompanyLine(semantic, roots, lines.length);
      if (!best || scored.score > best.score) {
        best = { value: variant, score: scored.score, reasons: scored.reasons };
      }
    }
  }

  if (!best || best.score < 45) return undefined;
  const score01 = Math.min(1, Math.max(0.45, best.score / 130));
  return {
    value: titleCaseCompany(best.value),
    confidence: score01 >= 0.72 ? 'high' : score01 >= 0.45 ? 'medium' : 'low',
    score: score01,
    source: roots.length ? 'website' : 'ocr',
    reasons: [`semantic company score ${best.score.toFixed(0)}`, ...best.reasons],
  };
}

function parseName(rawText: string): { firstName?: ExtractedField<string>; lastName?: ExtractedField<string> } {
  const lines = splitLines(rawText);
  for (const line of lines) {
    const owner = line.match(OWNER_PERSON_RE);
    const titled = line.match(TITLED_PERSON_RE);
    const match = owner || titled;
    if (!match) continue;
    const first = cleanNamePart(match[1]);
    const last = cleanNamePart(match[2]);
    if (!first || !last) continue;
    const reason = owner ? 'pattern titolare "di Nome Cognome"' : 'titolo professionale + Nome Cognome';
    return {
      firstName: { value: first, confidence: 'high', score: 0.9, source: 'ocr', reasons: [reason] },
      lastName: { value: last, confidence: 'high', score: 0.9, source: 'ocr', reasons: [reason] },
    };
  }
  return {};
}

function cleanNamePart(value: string): string {
  return value
    .replace(PERSON_PREFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function formatCity(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\p{L}/gu, (m) => m.toUpperCase());
}

function parseAddress(rawText: string): ExtractedField<Address | null> | undefined {
  const oneLine = splitLines(rawText).join(' ');
  const patterns = [
    /\b(?<postal>\d{5})\s+(?<city>[A-ZÀ-Ü][A-ZÀ-Ü' -]{2,})\s*\((?<region>[A-Z]{2})\)\s+(?<street>(?:via|viale|piazza|p\.zza|piazzale|p\.le|corso|c\.so|vicolo|contr[aà]|localit[aà]|strada|largo)\s+[^\n,;]+?)\s*,?\s*(?<civic>\d+[A-Za-z]?)\b/i,
    /(?<street>(?:via|viale|piazza|p\.zza|piazzale|p\.le|corso|c\.so|vicolo|contr[aà]|localit[aà]|strada|largo)\s+[^\n,;]+?)\s*,?\s*(?<civic>\d+[A-Za-z]?)\s*[-,]?\s*(?<postal>\d{5})\s+(?<city>[A-ZÀ-Ü][A-ZÀ-Ü' -]{2,})\s*\((?<region>[A-Z]{2})\)/i,
  ];

  for (const pattern of patterns) {
    const match = oneLine.match(pattern);
    const groups = match?.groups as Record<string, string> | undefined;
    if (!groups) continue;
    const street = groups.street.replace(/\s+/g, ' ').trim();
    const civic = groups.civic?.trim();
    const city = formatCity(groups.city.replace(/\b(?:ITALY|ITALIA)\b/gi, '').trim());
    const region = groups.region.toUpperCase();
    const postal = groups.postal;
    const full = `${street}${civic ? `, ${civic}` : ''} - ${postal} ${city} (${region})`;
    return {
      value: { street, civicNumber: civic, postalCode: postal, city, region, country: 'IT', full },
      confidence: 'high',
      score: 0.94,
      source: 'ocr',
      reasons: ['pattern CAP + città + provincia + via/civico'],
    };
  }
  return undefined;
}

function parseSharedTax(rawText: string): { vatNumber?: ExtractedField<string>; taxCode?: ExtractedField<string> } {
  const oneLine = splitLines(rawText).join(' ');
  if (!COMBINED_TAX_RE.test(oneLine)) return {};
  const labelIndex = oneLine.search(COMBINED_TAX_RE);
  const nearby = oneLine.slice(Math.max(0, labelIndex - 40), labelIndex + 120);
  const number = nearby.match(/\b\d{11}\b/)?.[0];
  if (!number) return {};
  const field: ExtractedField<string> = {
    value: number,
    confidence: 'high',
    score: 0.92,
    source: 'ocr',
    reasons: ['P.IVA / codice fiscale condivisi da etichetta combinata'],
  };
  return { vatNumber: field, taxCode: field };
}

function parseStructured(rawText: string): Pick<UniversalCardOverrides, 'emails' | 'website'> {
  const emails = extractEmails(rawText);
  const explicitWebsites = extractWebsites(rawText).filter((site) => !emails.some((email) => site.includes(email.split('@')[1] ?? '')) || site.startsWith('www.'));
  const websites = explicitWebsites.length > 0 ? explicitWebsites : inferWebsitesFromEmails(emails);
  const out: Pick<UniversalCardOverrides, 'emails' | 'website'> = {};
  if (emails.length) {
    out.emails = {
      value: emails,
      confidence: 'high',
      score: 0.9,
      source: 'ocr',
      reasons: ['email valida da OCR'],
    };
  }
  if (websites.length) {
    const preferred =
      websites.find((site) => validateWebsite(site) && !emails.some((email) => site.includes(email.split('@')[1] ?? ''))) ??
      websites.find((site) => validateWebsite(site)) ??
      websites[0];
    const valid = validateWebsite(preferred);
    if (!valid) return out;
    out.website = {
      value: valid,
      confidence: explicitWebsites.length ? 'high' : 'medium',
      score: explicitWebsites.length ? 0.88 : 0.78,
      source: explicitWebsites.length ? 'ocr' : 'email',
      reasons: [
        explicitWebsites.length
          ? 'sito web valido da OCR'
          : 'sito derivato da dominio email aziendale',
      ],
    };
  }
  return out;
}

export function extractUniversalCardOverrides(rawText: string): UniversalCardOverrides {
  const company = extractCompany(rawText);
  const name = parseName(rawText);
  const address = parseAddress(rawText);
  const tax = parseSharedTax(rawText);
  const structured = parseStructured(rawText);
  return {
    ...structured,
    ...tax,
    ...(company ? { company } : {}),
    ...name,
    ...(address ? { address } : {}),
  };
}

function betterScalar<T>(current: ExtractedField<T>, override: ExtractedField<T> | undefined): ExtractedField<T> {
  if (!override?.value) return current;
  if (!current.value) return override;
  if (override.confidence === 'high' && override.score >= current.score - 0.06) return override;
  if (current.confidence !== 'high' && override.score > current.score) return override;
  return current;
}

export function applyUniversalOverrides(result: BusinessCardExtractionResult): BusinessCardExtractionResult {
  const overrides = extractUniversalCardOverrides(result.rawText);
  const next: BusinessCardExtractionResult = {
    ...result,
    firstName: betterScalar(result.firstName, overrides.firstName),
    lastName: betterScalar(result.lastName, overrides.lastName),
    company: betterScalar(result.company, overrides.company),
    role: result.role,
    emails: betterScalar(result.emails, overrides.emails),
    phones: result.phones,
    website: betterScalar(result.website, overrides.website),
    address: betterScalar(result.address, overrides.address),
    vatNumber: betterScalar(result.vatNumber, overrides.vatNumber),
    taxCode: betterScalar(result.taxCode, overrides.taxCode),
  };
  return next;
}

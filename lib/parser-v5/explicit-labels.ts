/**
 * Estrazione campi da layout etichettati (JSON-like, vCard, tessere membership, biglietti strutturati).
 * Regole generiche — nessun hardcode per contatto/azienda.
 */
import { parsePersonNameFromLine, validatePersonName } from '../parser-engine/validators/name';
import { ROLE_KEYWORD_REGEX, COMMON_FIRST_NAMES, levenshteinDistance } from '../parser-engine/validators/dictionaries';

export interface ExplicitLabelFields {
  firstName: string | null;
  lastName: string | null;
  role: string | null;
  company: string | null;
  emails: string[];
  phones: string[];
  /** Tessera/biglietto con etichette Cognome/Nome (o equivalenti bilingue). */
  labeledCard: boolean;
}

const FIRST_NAME_INLINE_RE =
  /^(?:nome|first\s*names?|given\s*name|name)\s*[-–—:=]\s*(.+)$/i;
const LAST_NAME_INLINE_RE =
  /^(?:cognome|surname|family\s*name|last\s*name)\s*[-–—:=]\s*(.+)$/i;

const FIRST_NAME_LABEL_ONLY_RE =
  /^(?:nome|first\s*names?|given\s*name)(?:\s*[-–—]\s*(?:first\s*names?|nome|given\s*name))?\s*$/i;
const LAST_NAME_LABEL_ONLY_RE =
  /^(?:cognome|surname|family\s*name|last\s*name)(?:\s*[-–—]\s*(?:family\s*name|cognome|surname|last\s*name))?\s*$/i;

const FIRST_NAME_SYNONYM_RE = /^(?:first\s*names?|given\s*name|nome)$/i;
const LAST_NAME_SYNONYM_RE = /^(?:family\s*name|cognome|surname|last\s*name)$/i;

function isBilingualLabelTail(value: string): boolean {
  const t = value.trim();
  return FIRST_NAME_SYNONYM_RE.test(t) || LAST_NAME_SYNONYM_RE.test(t);
}

const GENERIC_LABEL_ONLY_RE =
  /^(?:name|nome|title|titolo|role|ruolo|email|e-?mail|mobile|cell|phone|telefono)$/i;

const LABEL_NOISE_VALUE_RE =
  /^(?:data\s+di\s+nascita|born|sede\s+emittente|issuing\s+office|firma|signature|card\s*n\.?|membership\s+card)\b/i;

const ORG_LINE_RE =
  /\b(?:centro|associazione|fondazione|istituto|universit[aà]|societ[aà]|turist\w+|studentesc\w+|giovanil\w+|cooperativ\w+|consorzi\w+|federazione|presidenza|nazionale)\b/i;

function repairOcrDigitsInName(s: string): string {
  return s
    .replace(/([A-Za-z])10(?=[A-Za-z])/gi, '$1IO')
    .replace(/([A-Za-z])0([A-Za-z])/g, '$1O$2')
    .replace(/\b0(?=[a-z])/gi, 'O')
    .replace(/(?<=[a-z])0\b/gi, 'o');
}

function cleanQuotedValue(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`,;]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalizeNameToken(s: string): string {
  const repaired = repairOcrDigitsInName(cleanQuotedValue(s));
  if (!repaired) return '';
  if (/^[A-ZÀ-Ü]{2,}$/.test(repaired)) {
    return repaired.charAt(0) + repaired.slice(1).toLowerCase();
  }
  return repaired.charAt(0).toUpperCase() + repaired.slice(1).toLowerCase();
}

function isPlausibleLabelValue(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (GENERIC_LABEL_ONLY_RE.test(t)) return false;
  if (FIRST_NAME_LABEL_ONLY_RE.test(t) || LAST_NAME_LABEL_ONLY_RE.test(t)) return false;
  if (LABEL_NOISE_VALUE_RE.test(t)) return false;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(t)) return false;
  if (/^[\d.\s-]+$/.test(t)) return false;
  if (/^R\d{1,4}$/i.test(t)) return false;
  return true;
}

function closestCommonFirstName(token: string): string | null {
  const low = repairOcrDigitsInName(token).toLowerCase();
  if (COMMON_FIRST_NAMES.has(low)) return low;
  let best: string | null = null;
  let bestDist = 3;
  for (const name of COMMON_FIRST_NAMES) {
    if (name.length < 5) continue;
    const dist = levenshteinDistance(low, name);
    if (dist <= 2 && dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

function parseSingleFirstName(value: string): string | null {
  const repaired = repairOcrDigitsInName(cleanQuotedValue(value));
  if (!repaired) return null;
  const fuzzy = closestCommonFirstName(repaired);
  const firstName = fuzzy ? capitalizeNameToken(fuzzy) : capitalizeNameToken(repaired);
  const validated = validatePersonName({ firstName, lastName: '' });
  return validated?.firstName?.trim() || null;
}

function parseSingleLastName(value: string): string | null {
  const repaired = repairOcrDigitsInName(cleanQuotedValue(value));
  if (!repaired) return null;
  const normalized = capitalizeNameToken(repaired);
  const validated = validatePersonName({ firstName: '', lastName: normalized });
  if (validated?.lastName?.trim()) return validated.lastName.trim();

  // Un cognome esplicitamente etichettato non va scartato solo per omonimia geografica.
  const explicitSurnameSyntaxOk = /^[A-Za-zÀ-ü'-]+(?:\s+[A-Za-zÀ-ü'-]+)*$/.test(normalized);
  const looksLikeRole = ROLE_KEYWORD_REGEX.test(normalized);
  const looksLikeNoise = LABEL_NOISE_VALUE_RE.test(normalized);
  if (explicitSurnameSyntaxOk) {
    if (!looksLikeRole) {
      if (!looksLikeNoise) return normalized;
    }
  }
  return null;
}

function splitPersonValue(value: string): { firstName: string | null; lastName: string | null } {
  const repaired = repairOcrDigitsInName(cleanQuotedValue(value));
  const fromLine = parsePersonNameFromLine(repaired);
  if (fromLine) {
    const v = validatePersonName(fromLine);
    if (v) return { firstName: v.firstName || null, lastName: v.lastName || null };
  }
  const parts = repaired.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const v = validatePersonName({
      firstName: parts[0],
      lastName: parts.slice(1).join(' '),
    });
    if (v) return { firstName: v.firstName || null, lastName: v.lastName || null };
  }
  if (parts.length === 1) {
    const first = parseSingleFirstName(parts[0]);
    if (first) return { firstName: first, lastName: null };
    const last = parseSingleLastName(parts[0]);
    if (last) return { firstName: null, lastName: last };
  }
  return { firstName: null, lastName: null };
}

function normalizeLabelKey(key: string | undefined): string {
  if (!key) return '';
  const k = key.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(?:cognome|surname|family name|last name)$/.test(k)) return 'cognome';
  if (/^(?:nome|first names?|given name|name)$/.test(k)) return 'nome';
  return k;
}

function extractLabeledValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const lastInline = line.match(LAST_NAME_INLINE_RE);
    if (lastInline && !isBilingualLabelTail(lastInline[1])) {
      out.set('cognome', cleanQuotedValue(lastInline[1]));
      continue;
    }
    const firstInline = line.match(FIRST_NAME_INLINE_RE);
    if (firstInline && !isBilingualLabelTail(firstInline[1])) {
      out.set('nome', cleanQuotedValue(firstInline[1]));
      continue;
    }

    if (LAST_NAME_LABEL_ONLY_RE.test(line)) {
      const next = (lines[i + 1] ?? '').trim();
      if (next && isPlausibleLabelValue(next)) {
        out.set('cognome', cleanQuotedValue(next.replace(/^:\s*/, '')));
        i++;
      }
      continue;
    }
    if (FIRST_NAME_LABEL_ONLY_RE.test(line)) {
      const next = (lines[i + 1] ?? '').trim();
      if (next && isPlausibleLabelValue(next)) {
        out.set('nome', cleanQuotedValue(next.replace(/^:\s*/, '')));
        i++;
      }
      continue;
    }

    const inline = line.match(
      /^(name|nome|title|titolo|role|ruolo|email|e-?mail|mobile|cell|phone|telefono)\s*[:=]\s*(.+)$/i
    );
    if (inline) {
      const key = normalizeLabelKey(inline[1]);
      if (key) out.set(key, cleanQuotedValue(inline[2]));
      continue;
    }

    const keyOnly = line.match(GENERIC_LABEL_ONLY_RE);
    if (keyOnly) {
      const key = normalizeLabelKey(keyOnly[1]);
      const next = (lines[i + 1] ?? '').trim();
      if (next && isPlausibleLabelValue(next)) {
        out.set(key, cleanQuotedValue(next.replace(/^:\s*/, '')));
        i++;
      }
      continue;
    }

    const keyColonNext = line.match(GENERIC_LABEL_ONLY_RE);
    if (keyColonNext && lines[i + 1]?.trim().startsWith(':')) {
      const key = normalizeLabelKey(keyColonNext[1]);
      out.set(key, cleanQuotedValue(lines[i + 1].replace(/^:\s*/, '')));
      i++;
    }
  }

  const blob = normalized.replace(/\n+/g, ' ');
  for (const m of blob.matchAll(
    /"(name|nome|cognome|title|titolo|role|ruolo|email|mobile|cell|phone|telefono)"\s*:\s*"([^"]+)"/gi
  )) {
    const key = normalizeLabelKey(m[1]);
    if (key) out.set(key, cleanQuotedValue(m[2]));
  }

  return out;
}

function titleCaseOrganization(line: string): string {
  return cleanQuotedValue(line)
    .split(/\s+/)
    .map((w) => {
      if (/^(?:e|di|del|della|dei|degli|da|in|a|per|il|la|lo|gli|le|and|of|the)$/i.test(w)) {
        return w.toLowerCase();
      }
      return capitalizeNameToken(w);
    })
    .join(' ');
}

function extractOrganizationFromLabeledCard(lines: string[]): string | null {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.length < 12) continue;
    if (LABEL_NOISE_VALUE_RE.test(line)) continue;
    if (FIRST_NAME_LABEL_ONLY_RE.test(line) || LAST_NAME_LABEL_ONLY_RE.test(line)) continue;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(line)) continue;
    if (/^[\d.\s-]+$/.test(line)) continue;
    if (/\bvia\b|\bstreet\b|\bstrada\b|\broad\b/i.test(line) && /\d{5}\b/.test(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 3) continue;
    if (!ORG_LINE_RE.test(line)) continue;
    return titleCaseOrganization(line);
  }
  return null;
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 7) return null;
  return raw.trim().replace(/\s+/g, ' ');
}

function normalizeEmail(raw: string): string | null {
  const e = raw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\.com\s*$/i, '.com')
    .replace(/\.com(?!\.)/gi, '.com');
  const fixed = e.replace(/@([a-z0-9._%+\-]+)\.([a-z]{2,})/, '@$1.$2');
  if (/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(fixed)) return fixed;
  return null;
}

/**
 * Estrae persona/ruolo/contatti da etichette esplicite nel testo OCR.
 */
export function extractExplicitLabelFields(rawText: string): ExplicitLabelFields {
  const labels = extractLabeledValues(rawText);
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const result: ExplicitLabelFields = {
    firstName: null,
    lastName: null,
    role: null,
    company: null,
    emails: [],
    phones: [],
    labeledCard: false,
  };

  const lastVal = labels.get('cognome');
  const firstVal = labels.get('nome');
  const fullNameVal = labels.get('name');

  if (lastVal) {
    result.lastName = parseSingleLastName(lastVal);
  }
  if (firstVal) {
    result.firstName = parseSingleFirstName(firstVal);
  }
  if (fullNameVal && !result.firstName && !result.lastName) {
    const p = splitPersonValue(fullNameVal);
    result.firstName = p.firstName;
    result.lastName = p.lastName;
  }

  result.labeledCard = Boolean(
    labels.has('cognome') ||
      labels.has('nome') ||
      lines.some((l) => LAST_NAME_LABEL_ONLY_RE.test(l.trim()) || FIRST_NAME_LABEL_ONLY_RE.test(l.trim()))
  );

  if (result.labeledCard) {
    result.company = extractOrganizationFromLabeledCard(lines);
  }

  const roleVal = labels.get('title') ?? labels.get('titolo') ?? labels.get('role') ?? labels.get('ruolo');
  if (roleVal?.trim()) {
    const role = cleanQuotedValue(roleVal);
    if (ROLE_KEYWORD_REGEX.test(role) || role.split(/\s+/).length <= 8) {
      result.role = role;
    }
  }

  for (const key of ['email', 'e-mail']) {
    const raw = labels.get(key);
    if (raw) {
      const e = normalizeEmail(raw);
      if (e && !result.emails.includes(e)) result.emails.push(e);
    }
  }

  for (const key of ['mobile', 'cell', 'phone', 'telefono']) {
    const raw = labels.get(key);
    if (raw) {
      const p = normalizePhone(raw);
      if (p && !result.phones.includes(p)) result.phones.push(p);
    }
  }

  return result;
}

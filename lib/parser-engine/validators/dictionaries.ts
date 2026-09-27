import {
  INTERNATIONAL_LEGAL_FORM_PATTERN_SOURCE,
  NON_LATIN_LEGAL_FORM_PATTERN_SOURCE,
  canonicalizeKnownLegalForm,
  isAmbiguousNakedLegalFormKey,
  isKnownLegalFormTypography,
  legalFormCompactKey,
} from './legal-form-catalog';

/** Dizionari e pattern generici per il parser engine. Nessun brand o biglietto reale. */

export const COMMON_FIRST_NAMES = new Set([
  'marco', 'mario', 'massimo', 'carlo', 'enrico', 'ivan', 'alessandro', 'federico', 'sergio',
  'samuele', 'manuel', 'andrea', 'luca', 'paolo', 'giovanni', 'giuseppe', 'francesco', 'antonio',
  'roberto', 'matteo', 'davide', 'simone', 'daniele', 'stefano', 'riccardo', 'filippo', 'nicola',
  'carla', 'maria', 'anna', 'laura', 'sara', 'silvana', 'silvano', 'luigi', 'michela', 'fabrizio',
  'elena', 'giulia', 'chiara', 'valentina', 'francesca', 'alberto', 'giorgio', 'pietro', 'vincenzo',
  'daniela', 'christian', 'tony', 'enrico', 'ashraf', 'giantonio', 'deana', 'franco',
  'adam', 'adrian', 'alex', 'alexander', 'amelia', 'amy', 'andrew', 'arthur', 'benjamin', 'charles',
  'charlotte', 'chloe', 'diana', 'diane', 'edward', 'emma', 'eric', 'eva', 'george', 'grace',
  'hannah', 'harry', 'helen', 'henry', 'isabel', 'jack', 'jacob', 'james', 'jane', 'jennifer',
  'jessica', 'john', 'joseph', 'kevin', 'leo', 'liam', 'linda', 'louis', 'lucas', 'mark', 'martin',
  'mary', 'michael', 'natalie', 'nathan', 'nora', 'oliver', 'patrick', 'paul', 'peter', 'philip',
  'rachel', 'richard', 'robert', 'sam', 'samantha', 'sarah', 'sean', 'simon', 'sophia', 'stephen', 'steven',
  'susan', 'thomas', 'victor', 'william', 'ana', 'carlos', 'javier', 'jose', 'juan', 'luis', 'miguel',
  'hans', 'karl', 'klaus', 'lukas', 'pierre', 'jean', 'julien', 'laurent', 'marie', 'claire',
  'camille', 'luc', 'andrzej', 'piotr', 'tomasz', 'jan', 'pavel', 'marek', 'katarzyna', 'agnieszka',
  'ahmed', 'mohamed', 'muhammad', 'ali', 'omar', 'fatima', 'aisha', 'wei', 'min', 'yuki', 'kenji',
  'hiroshi', 'arjun', 'rahul', 'priya', 'anita', 'sanjay',
]);

export const ITALIAN_CITY_NAMES = new Set([
  'milano', 'roma', 'torino', 'napoli', 'padova', 'venezia', 'bologna', 'firenze', 'genova', 'verona',
  'vicenza', 'treviso', 'bergamo', 'brescia', 'modena', 'parma', 'ravenna', 'trieste', 'udine', 'bolzano',
  'bollate', 'schio', 'legnaro', 'gorizia', 'ancona', 'palermo', 'catania', 'bari', 'perugia', 'parma',
]);

/** True se il token è una città italiana nota (OCR spesso la confonde col cognome). */
export function isItalianCityName(token?: string | null): boolean {
  if (!token?.trim()) return false;
  const norm = token
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z]/g, '');
  return ITALIAN_CITY_NAMES.has(norm);
}

export const NAME_PARTICLES = new Set([
  'de', 'di', 'da', 'del', 'della', 'degli', 'delle', 'van', 'von', 'le', 'la', 'du', 'dos', 'das',
]);

export const ITALIAN_ROLE_WORDS = new Set([
  'presidente', 'vicepresidente', 'direttore', 'direttrice', 'amministratore', 'amministratrice',
  'titolare', 'socio', 'consulente', 'responsabile', 'manager', 'founder', 'ceo', 'cto', 'cfo',
  'trainer', 'consultant', 'commercialista', 'avvocato', 'ingegnere', 'architetto', 'revisore',
]);

export const FUZZY_ROLE_WORDS = [
  'commercialista', 'contabile', 'revisore', 'dottore', 'dottoressa', 'presidente', 'direttore',
  'direttrice', 'amministratore', 'amministratrice', 'responsabile', 'consulente', 'titolare',
  'segretario', 'segretaria', 'ragioniere', 'avvocato', 'ingegnere', 'architetto', 'notaio',
];

export const FIRM_SUFFIX_WORDS = [
  'COMMERCIALISTI', 'ASSOCIATI', 'ASSOCIATO', 'STUDIO', 'LEGALE', 'AVVOCATI', 'NOTAIO', 'NOTAI',
  'INGEGNERI', 'ARCHITETTI', 'CONSULENTI', 'PROFESSIONISTI', 'REVISORI', 'CONTABILI', 'TRIBUTARISTI',
];

/** True se il testo è solo un suffisso professionale isolato (es. "COMMERCIALISTI"). */
export function isStandaloneFirmSuffixWord(text: string): boolean {
  const compact = text.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!compact || compact.length < 5) return false;
  for (const word of FIRM_SUFFIX_WORDS) {
    if (compact === word) return true;
    if (Math.abs(compact.length - word.length) <= 1 && levenshteinDistance(compact, word) <= 1) {
      return true;
    }
  }
  return false;
}

function normalizeLexiconToken(token: string): string {
  return token.toLowerCase().replace(/[^a-zà-ü]/g, '');
}

function isFuzzyFirmSuffixLexiconWord(word: string): boolean {
  const token = normalizeLexiconToken(word);
  if (token.length < 3) return false;

  const lexicon = new Set<string>([
    ...FIRM_SUFFIX_WORDS.map((w) => w.toLowerCase()),
    ...[...COMPANY_DESCRIPTOR_WORDS].map((w) => w.toLowerCase()),
  ]);
  if (lexicon.has(token)) return true;

  for (const suffix of FIRM_SUFFIX_WORDS) {
    const normalized = suffix.toLowerCase();
    if (
      Math.abs(token.length - normalized.length) <= 2 &&
      levenshteinDistance(token, normalized) <= 2
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True se il testo rappresenta solo suffissi/descrittori professionali
 * (anche OCR corrotti), senza token marchio reali.
 */
export function isSuffixOnlyCompany(text: string): boolean {
  const t = text.trim();
  if (!t || hasLegalForm(t)) return false;
  if (isStandaloneFirmSuffixWord(t)) return true;

  const tokens = t
    .split(/\s+/)
    .map((w) => normalizeLexiconToken(w))
    .filter((w) => w.length >= 3);
  if (!tokens.length || tokens.length > 8) return false;

  let suffixLike = 0;
  let brandLike = 0;
  for (const token of tokens) {
    if (isFuzzyFirmSuffixLexiconWord(token)) suffixLike++;
    else brandLike++;
  }

  return suffixLike > 0 && brandLike === 0;
}

export const NON_PERSON_WORDS = new Set([
  'industrial', 'automation', 'automazione', 'domotica', 'building', 'hotel', 'home', 'dept',
  'department', 'sales', 'marketing', 'solutions', 'systems', 'technology', 'engineering', 'services',
  'consulting', 'software', 'smart', 'logistica', 'progettazione', 'interni', 'commercio',
  'concessionaria', 'concessionario', 'dealership', 'dealer', 'digitale', 'sanità', 'sanita',
  'sports', 'sport',
]);

export const COMPANY_DESCRIPTOR_WORDS = new Set([
  'ingegneria', 'soluzioni', 'software', 'serramenti', 'componenti', 'arredamenti', 'interni',
  'impianti', 'automazione', 'costruzioni', 'servizi', 'commercio', 'industrie', 'group', 'holding',
  'consulting', 'logistica', 'commercialisti', 'associati', 'studio', 'legale', 'docks',
]);

export const BRAND_STOP_WORDS = new Set([
  'la', 'il', 'lo', 'le', 'i', 'gli', 'di', 'de', 'e', 'ed', 'and', 'the',
]);

export const LEGAL_FORM_LOWERCASE = new Set([
  'srl', 'srls', 'spa', 'snc', 'sas', 'sasu', 'sap', 'sapa', 'sdf', 'scarl', 'stp',
  'ltd', 'llc', 'llp', 'inc', 'gmbh', 'ag', 'bv', 'nv', 'oy', 'ab', 'as', 'aps',
  'kg', 'kft',
]);

/**
 * Grammatica canonica delle forme giuridiche riconosciute dal parser V5.
 * I consumer possono aggiungere soltanto i vincoli di posizione (presenza o
 * suffisso terminale), senza mantenere copie divergenti della lista.
 */
// P0 observed compound legal form: preserva i repair OCR legacy già validati,
// poi estende il riconoscimento al catalogo societario internazionale centralizzato.
const LEGACY_LEGAL_FORM_PATTERN_SOURCE = String.raw`(?:[S5]\.?\s*r\.?\s*[lI1i|]\.?\s*s\.?|[S5]\.?\s*r\.?\s*[lI1i|]\.?|[S5]\.?\s*p\.?\s*[aA@4]\.?|[S5]\.?\s*c\.?\s*p\.?\s*[aA@4]\.?|[S5]\.?\s*n\.?\s*c\.?|[S5]\.?\s*a\.?\s*[sS5]\.?\s*u\.?|[S5]\.?\s*a\.?\s*[sS5]\.?|[S5]\.?\s*a\.?\s*p\.?\s*[aA@4]\.?|[S5]\.?\s*d\.?\s*f\.?|s\.?\s*c\.?\s*(?:a\.?\s*)?r\.?\s*l\.?|s\.?\s*t\.?\s*p\.?|srls?|spa|scpa|snc|sas|sasu|scarl|sapa|sdf|stp|bvba|cvba|vzw|GmbH\s*&\s*Co\.?\s*KG|Co\.?\s*KG|GmbH|A\.?G\.?|S\.?A\.?R\.?L\.?|S\.?A\.?S\.?U\.?|B\.?V\.?|N\.?V\.?|\(?\s*Private\s*\)?\s+(?:Limited|Ltd\.?)|Ltd\.?|Limited|LLC|LLP|Inc\.?|Corp\.?|Corporation|PLC|Oy|AB|A\/S|AS|KG|e\.?K\.?|S\.?A\.?|Kft|Sp\.?\s*z\s*o\.?o\.?|ApS|S\.?\s*L\.?)`;

export const LEGAL_FORM_PATTERN_SOURCE =
  `(?:${LEGACY_LEGAL_FORM_PATTERN_SOURCE}|${INTERNATIONAL_LEGAL_FORM_PATTERN_SOURCE})`;

// Contratto condiviso: riconoscimento in linea con un confine sintattico.
// Non usa \b come unico confine perché le forme CJK/Hangul non sono "word"
// per il motore RegExp JavaScript.
export const LEGAL_FORM_REGEX = new RegExp(
  `(?:^|[\\s,(])(${LEGAL_FORM_PATTERN_SOURCE})(?=[\\s.,;:)]|$)`,
  'iu'
);

// Conservato per compatibilità di import; stripLegalFormSuffix usa il matcher
// terminale strutturale sotto, così non tronca brand che finiscono per "AS"/"SA".
export const LEGAL_FORM_STRIP = new RegExp(
  `\\s*,?\\s*(?:${LEGAL_FORM_PATTERN_SOURCE})[\\s.,;:)]*$`,
  'iu'
);

const TERMINAL_LEGAL_FORM_REGEX = new RegExp(
  `(?:^|[\\s,(])(${LEGAL_FORM_PATTERN_SOURCE})[\\s.,;:)]*$`,
  'iu'
);

const TERMINAL_NON_LATIN_LEGAL_FORM_REGEX = new RegExp(
  `(${NON_LATIN_LEGAL_FORM_PATTERN_SOURCE})[\\s.,;:)]*$`,
  'u'
);


const WHOLE_LEGAL_FORM_REGEX = new RegExp(
  `^\s*(?:${LEGAL_FORM_PATTERN_SOURCE})[\s.,;:)]*$`,
  'iu'
);

export const ROLE_KEYWORD_REGEX =
  /\b(ceo|cto|cfo|coo|manager|director|engineer|developer|presidente?|dirigente|founder|consulente|direttore|direttrice|responsabile|amministratore|amministratrice|amministratore\s+delegato|sales\s+dept|marketing|human\s+resources|titolare|socio|vice\s*presidente?|capo|coordinatore|coordinatrice|project\s+manager|account\s+manager|perito|posatore|installatore|tecnico|artigiano|[cg]ommercialista|avvocato|ingegnere|architetto|designer|consultant|partner|owner|proprietario|proprietaria|impiegato|impiegata|segretario|segretaria|buyer|purchasing|export|import|technician|specialist|analyst|representative|executive|officer|supervisor|trainer|key\s+account|supply\s+chain|product\s+manager|business\s+consultant|managing\s+partner|reparto\s+commerciale|software\s+solutions\s+manager|sales)\b/i;

export const ACTIVITY_WORDS_REGEX =
  /\b(domotica|automation|automazione|industrial|building|hotel|hotels|home|smart|solutions?|systems?|technology|technologies|engineering|services?|consulting|software|hardware|networking|security|energy|renewable|logistics?|trading|import|export|wholesale|retail|manufacturing|production|produzione|progettazione|intermediazioni?|commercio|consulenza|assistenza|installazioni?|riparazioni?|vendita|noleggio|trasporti?)\b/i;

export const PROFESSIONAL_TITLE_PREFIX_REGEX =
  /^(?:(?:geom|ing|arch|dott|avv|avy|sig|sig\.ra|dr|prof|rag)\.?\s+)/i;

export const COMPANY_NOISE_REGEX =
  /\b(sede\s+(?:legale|operativa|amministrativa)(?:\s+e\s+operativa)?|legal\s+(?:and|&)\s+operational|registered\s+office|operational\s+headquarters|head\s*quarters)\b/i;

export const TAX_LABEL_REGEX =
  /^(?:c\.?\s*f\.?(?:\s*e\s*p\.?\s*iva|\s*\/\s*p\.?\s*iva)?|p\.?\s*iva(?:\s*e\s*c\.?\s*f\.?)?|partita\s*iva|cod\.?\s*fisc\.?|codice\s*fiscale|vat(?:\s*(?:no|number|reg|id))?|tax\s*(?:id|code|number)|ust-?id|tva|nif|cif|siren|siret)\b/i;

export const ADDRESS_LINE_PREFIX_REGEX =
  /^(?:via|viale|piazza|corso|vicolo|largo|galleria|street|road|avenue|blvd|str\.?)\b/i;

export const DEPARTMENT_REGEX =
  /\b(sales|marketing|purchase|quality|export|import|hr|it|rd)\s+dept\b/i;

export const EMAIL_SINGLE_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export const GENERIC_EMAIL_LOCAL_REGEX =
  /^(info|noreply|contact|sales|admin|webmaster|office|mail|segreteria|ordini|formazione|training|education)$/i;

export function levenshteinDistance(a: string, b: string): number {
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

export function isCommonFirstName(word: string): boolean {
  const w = word.toLowerCase();
  if (COMMON_FIRST_NAMES.has(w)) return true;
  for (const name of COMMON_FIRST_NAMES) {
    if (Math.abs(w.length - name.length) <= 1 && levenshteinDistance(w, name) <= 1) return true;
  }
  return false;
}

export function fuzzyMatchesRoleWord(word: string): boolean {
  const w = word.toLowerCase().replace(/[^a-zà-ü]/g, '');
  if (w.length < 6) return false;
  for (const role of FUZZY_ROLE_WORDS) {
    if (w === role) return true;
    if (Math.abs(w.length - role.length) <= 2 && levenshteinDistance(w, role) <= 2) return true;
  }
  return false;
}

export function containsFuzzyRoleWord(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= 6 && words.some((w) => fuzzyMatchesRoleWord(w));
}

export function hasLegalForm(text: string): boolean {
  return LEGAL_FORM_REGEX.test(text);
}

export function normalizeLegalFormOcr(text: string): string {
  const normalized = text
    .replace(/\b[S5]\.?\s*R\.?\s*[LI1|]\.?\s*S\.?(?=[\s.,;:)]|$)/gi, 'S.r.l.s.')
    .replace(/\b[S5]\.?\s*R\.?\s*[LI1|]\.?(?!\s*\.?\s*S\.?(?=[\s.,;:)]|$))(?=[\s.,;:)]|$)/gi, 'S.r.l.')
    .replace(/\b[S5]\.?\s*C\.?\s*P\.?\s*[A@4]\.?(?=[\s.,;:)]|$)/gi, 'S.c.p.A.')
    .replace(/\b[S5]\.?\s*P\.?\s*[A@4]\.?(?=[\s.,;:)]|$)/gi, 'S.p.A.')
    .replace(/\b[S5]\.?\s*N\.?\s*C\.?(?=[\s.,;:)]|$)/gi, 'S.n.c.')
    .replace(/\b[S5]\.?\s*A\.?\s*[S5]\.?\s*U\.?(?=[\s.,;:)]|$)/gi, 'S.A.S.U.')
    .replace(/\b[S5]\.?\s*A\.?\s*[S5]\.?(?=[\s.,;:)]|$)/gi, 'S.a.s.')
    .replace(/\b[S5]\.?\s*A\.?\s*P\.?\s*[A@4]\.?(?=[\s.,;:)]|$)/gi, 'S.a.p.A.')
    .replace(/\bsrls\b/gi, 'S.r.l.s.')
    .replace(/\bsrl\b/gi, 'S.r.l.')
    .replace(/\bspa\b/gi, 'S.p.A.')
    .replace(/\bsnc\b/gi, 'S.n.c.')
    .replace(/\bsasu\b/gi, 'S.A.S.U.')
    .replace(/\bsas\b/gi, 'S.a.s.')
    .replace(/\bsapa\b/gi, 'S.a.p.A.');

  // Se il valore è SOLO una forma societaria del catalogo (es. "S R L",
  // "L.L.C.", "SpA"), canonicalizzala senza toccare il brand circostante.
  return canonicalizeKnownLegalForm(normalized.trim()) ?? normalized;
}

export function hasLegalFormSuffix(text: string): boolean {
  return LEGAL_FORM_REGEX.test(normalizeLegalFormOcr(text));
}

export interface TerminalLegalFormMatch {
  brand: string;
  suffix: string;
  strength: 'strong' | 'ambiguous';
}

/**
 * Divide una forma giuridica terminale dal brand senza attribuirle da solo
 * valore probatorio. Le sigle brevi nude (AS, SA, AG, ...) restano ambigue:
 * il chiamante può accettarle soltanto con un'evidenza aziendale indipendente.
 */
export function matchTerminalLegalFormSuffix(
  text: string
): TerminalLegalFormMatch | null {
  const observed = text.trim();
  let match = observed.match(TERMINAL_LEGAL_FORM_REGEX);
  let attachedNonLatin = false;

  // CJK/Hangul possono essere attaccati direttamente alla denominazione.
  if (!match) {
    const nonLatin = observed.match(TERMINAL_NON_LATIN_LEGAL_FORM_REGEX);
    if (nonLatin) {
      match = nonLatin;
      attachedNonLatin = true;
    }
  }

  if (!match || match.index === undefined || !match[1]) return null;
  const brand = observed
    .slice(0, match.index)
    .trim()
    .replace(/[,(]\s*$/, '')
    .trim();
  const brandAlphaNumericLength =
    brand.replace(/[^\p{L}\p{N}]/gu, '').length;
  if (brandAlphaNumericLength < 2 || !/[\p{L}]/u.test(brand)) {
    return null;
  }

  const observedSuffix = match[1].trim();
  const observedKnown = isKnownLegalFormTypography(observedSuffix);
  const normalizedObservedSuffix = normalizeLegalFormOcr(observedSuffix).trim();
  const suffix = observedKnown
    ? observedSuffix.replace(/\s+/g, ' ').trim()
    : (
        canonicalizeKnownLegalForm(normalizedObservedSuffix) ??
        normalizedObservedSuffix
      );
  const compact = legalFormCompactKey(suffix);
  const separator = attachedNonLatin ? '' : observed.slice(match.index, match.index + 1);
  const prefixWithSeparator = observed.slice(0, match.index);
  const hasLegalPunctuation =
    /[./]/.test(observedSuffix) ||
    separator === ',' ||
    separator === '(' ||
    /[,(]\s*$/.test(prefixWithSeparator) ||
    attachedNonLatin;

  return {
    brand,
    suffix,
    strength:
      isAmbiguousNakedLegalFormKey(compact) && !hasLegalPunctuation
        ? 'ambiguous'
        : 'strong',
  };
}

/**
 * True solo quando la forma giuridica chiude una ragione sociale e lascia
 * davanti a sé un brand significativo. Le sigle brevi linguisticamente
 * ambigue richiedono punteggiatura societaria; la validità semantica del
 * brand resta responsabilità del chiamante.
 */
export function hasTerminalLegalFormSuffix(text: string): boolean {
  return matchTerminalLegalFormSuffix(text)?.strength === 'strong';
}

/** Riga che richiede evidenza aziendale esterna per disambiguare il suffisso. */
export function isAmbiguousTerminalLegalPhrase(text: string): boolean {
  return matchTerminalLegalFormSuffix(text)?.strength === 'ambiguous';
}

/**
 * Una sigla giuridica breve dopo ':' o '=' è semanticamente ambigua: la
 * stessa forma può essere una label/valore oppure un marchio stilizzato.
 * Questa funzione segnala soltanto l'ambiguità sintattica; non decide né
 * accettazione né rifiuto senza evidenze indipendenti del biglietto.
 */
export function hasAmbiguousTerminalLegalSeparator(text: string): boolean {
  const legal = matchTerminalLegalFormSuffix(text);
  if (!legal) return false;
  const compactSuffix = legalFormCompactKey(legal.suffix);
  return (
    isAmbiguousNakedLegalFormKey(compactSuffix) &&
    /[:=]/u.test(legal.brand)
  );
}

export function normalizeBrandKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function brandMultisetKey(value: string): string {
  const words = value
    .toLowerCase()
    .replace(/[^a-zà-ü0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !BRAND_STOP_WORDS.has(w));
  return words.sort().join('');
}

/** True se la riga è solo una forma giuridica isolata (es. "Spa", "S.r.l."). */
export function isIsolatedLegalFormOnly(text: string): boolean {
  const t = normalizeLegalFormOcr(text.trim());
  if (!t || t.length > 24) return false;
  if (!hasLegalForm(t) && !/^(spa|srl|snc|sas|gmbh|ag|llc|ltd)\.?$/i.test(t)) return false;
  const brand = stripLegalFormSuffix(t);
  return !brand || brand.replace(/[^a-zà-ü]/gi, '').length <= 2;
}

/** Sigle di settore (MES & WMS, ERP/CRM…): reparto/prodotto, non ragione sociale. */
export function isLikelyIndustryAcronymLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 45) return false;
  if (hasLegalFormSuffix(t)) return false;
  const parts = t
    .split(/\s*(?:&|\/|,|\+)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 6) return false;
  return parts.every((p) => /^[A-Z]{2,6}$/.test(p));
}

export function fixBareDiConnector(text: string): string {
  return text.replace(/\b([A-Za-zÀ-ü]{1,4})\s+d\s+([A-Za-zÀ-ü])/i, '$1 di $2');
}

export function stripLegalFormSuffix(text: string): string {
  const observed = text.trim();
  if (!observed) return '';

  // Una riga che è SOLO una forma societaria deve poter essere consumata dai
  // resolver brand + legal-form adiacente (es. "(Private) Limited").
  if (WHOLE_LEGAL_FORM_REGEX.test(observed)) {
    const compact = legalFormCompactKey(normalizeLegalFormOcr(observed));
    if (!isAmbiguousNakedLegalFormKey(compact)) return '';
  }

  const legal = matchTerminalLegalFormSuffix(observed);
  if (!legal) return observed.replace(/\s+/g, ' ').trim();

  // Compatibilità strutturale: le sigle brevi ambigue (AG, SA, AS, BV, ...)
  // restano parte della chiave osservata. Molti resolver storici usano questa
  // proprietà per non trasformare claim/label in brand incompleti.
  if (isAmbiguousNakedLegalFormKey(legal.suffix)) {
    return observed.replace(/\s+/g, ' ').trim();
  }

  return legal.brand.replace(/\s+/g, ' ').trim();
}

export function stripProfessionalTitle(line: string): string {
  return line.replace(PROFESSIONAL_TITLE_PREFIX_REGEX, '').trim();
}

export function hasPersonNameBreakingLowercaseWord(words: string[]): boolean {
  for (let i = 1; i < words.length; i++) {
    const bare = words[i].replace(/[.,'`-]/g, '');
    const lower = bare.toLowerCase();
    if (LEGAL_FORM_LOWERCASE.has(lower)) continue;
    if (bare && /^[a-zà-ü'-]+$/.test(bare)) return true;
  }
  return false;
}

export function isCompanyNoiseLine(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (COMPANY_NOISE_REGEX.test(t)) return true;
  if (/^a company of\b/i.test(t)) return true;
  if (/^(tel\.?|fax\.?|phone|mobile|cell\.?|e-?mail)\b/i.test(t)) return true;
  if (TAX_LABEL_REGEX.test(t)) return true;
  if (ADDRESS_LINE_PREFIX_REGEX.test(t)) return true;
  return false;
}

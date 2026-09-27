/**
 * Catalogo centralizzato delle forme societarie internazionali.
 *
 * Base: forme_societarie_internazionali.csv fornito per il QA del 2026-09-15,
 * più le forme legacy già riconosciute dal parser V5 per non introdurre regressioni.
 *
 * IMPORTANTE:
 * - riconoscimento tipografico tollerante: punti/spazi/slash possono variare;
 * - la canonicalizzazione NON cambia il tipo societario, normalizza solo la sigla;
 * - le sigle brevi linguisticamente ambigue restano marcate come tali;
 * - nessun brand/azienda reale è codificato in questo catalogo.
 */

export interface LegalFormCatalogEntry {
  canonical: string;
  areas: readonly string[];
  names: readonly string[];
}

export const LEGAL_FORM_CATALOG: readonly LegalFormCatalogEntry[] = [
  { canonical: "S.S.", areas: ["Italia"], names: ["Società semplice"] },
  { canonical: "S.n.c.", areas: ["Italia"], names: ["Società in nome collettivo"] },
  { canonical: "S.a.s.", areas: ["Italia"], names: ["Società in accomandita semplice"] },
  { canonical: "S.r.l.", areas: ["Italia"], names: ["Società a responsabilità limitata"] },
  { canonical: "S.r.l.u.", areas: ["Italia"], names: ["Società a responsabilità limitata unipersonale"] },
  { canonical: "S.r.l.s.", areas: ["Italia"], names: ["Società a responsabilità limitata semplificata"] },
  { canonical: "S.p.A.", areas: ["Italia"], names: ["Società per azioni"] },
  { canonical: "S.a.p.a.", areas: ["Italia"], names: ["Società in accomandita per azioni"] },
  { canonical: "S.coop.", areas: ["Italia"], names: ["Società cooperativa"] },
  { canonical: "S.T.P.", areas: ["Italia"], names: ["Società tra professionisti"] },
  { canonical: "SE", areas: ["Unione Europea"], names: ["Societas Europaea"] },
  { canonical: "Inc.", areas: ["Stati Uniti", "Canada"], names: ["Incorporated"] },
  { canonical: "Corp.", areas: ["Stati Uniti"], names: ["Corporation"] },
  { canonical: "Co.", areas: ["Stati Uniti"], names: ["Company"] },
  { canonical: "LLC", areas: ["Stati Uniti"], names: ["Limited Liability Company"] },
  { canonical: "LP", areas: ["Stati Uniti", "Regno Unito"], names: ["Limited Partnership"] },
  { canonical: "LLP", areas: ["Stati Uniti", "Regno Unito"], names: ["Limited Liability Partnership"] },
  { canonical: "Ltd.", areas: ["Canada", "Hong Kong"], names: ["Limited"] },
  { canonical: "Ltd", areas: ["Regno Unito", "Australia", "Nuova Zelanda", "Sudafrica"], names: ["Limited"] },
  { canonical: "PLC", areas: ["Regno Unito", "India"], names: ["Public Limited Company"] },
  { canonical: "S.A.", areas: ["Francia", "Belgio", "Spagna", "Portogallo", "Polonia", "Romania", "Brasile"], names: ["Société anonyme", "Sociedad Anónima", "Sociedade Anónima", "Spółka akcyjna", "Societate pe acțiuni", "Sociedade Anônima"] },
  { canonical: "S.A.S.", areas: ["Francia", "Colombia"], names: ["Société par actions simplifiée", "Sociedad por Acciones Simplificada"] },
  { canonical: "S.A.S.U.", areas: ["Francia"], names: ["Société par actions simplifiée unipersonnelle"] },
  { canonical: "S.A.R.L.", areas: ["Francia"], names: ["Société à responsabilité limitée"] },
  { canonical: "E.U.R.L.", areas: ["Francia"], names: ["Entreprise unipersonnelle à responsabilité limitée"] },
  { canonical: "S.N.C.", areas: ["Francia"], names: ["Société en nom collectif"] },
  { canonical: "GmbH", areas: ["Germania", "Austria", "Svizzera"], names: ["Gesellschaft mit beschränkter Haftung"] },
  { canonical: "UG", areas: ["Germania"], names: ["Unternehmergesellschaft"] },
  { canonical: "AG", areas: ["Germania", "Austria", "Svizzera"], names: ["Aktiengesellschaft"] },
  { canonical: "KGaA", areas: ["Germania"], names: ["Kommanditgesellschaft auf Aktien"] },
  { canonical: "OHG", areas: ["Germania"], names: ["Offene Handelsgesellschaft"] },
  { canonical: "KG", areas: ["Germania"], names: ["Kommanditgesellschaft"] },
  { canonical: "SA", areas: ["Svizzera", "Africa francofona"], names: ["Société anonyme"] },
  { canonical: "Sàrl", areas: ["Svizzera"], names: ["Société à responsabilité limitée"] },
  { canonical: "Sagl", areas: ["Svizzera"], names: ["Società a garanzia limitata"] },
  { canonical: "B.V.", areas: ["Paesi Bassi", "Belgio"], names: ["Besloten vennootschap"] },
  { canonical: "N.V.", areas: ["Paesi Bassi", "Belgio"], names: ["Naamloze vennootschap"] },
  { canonical: "V.O.F.", areas: ["Paesi Bassi"], names: ["Vennootschap onder firma"] },
  { canonical: "C.V.", areas: ["Paesi Bassi"], names: ["Commanditaire vennootschap"] },
  { canonical: "S.L.", areas: ["Spagna"], names: ["Sociedad Limitada"] },
  { canonical: "S.L.U.", areas: ["Spagna"], names: ["Sociedad Limitada Unipersonal"] },
  { canonical: "S.C.", areas: ["Spagna"], names: ["Sociedad Colectiva"] },
  { canonical: "Lda.", areas: ["Portogallo"], names: ["Limitada"] },
  { canonical: "Unipessoal Lda.", areas: ["Portogallo"], names: ["Sociedade Unipessoal por Quotas"] },
  { canonical: "AB", areas: ["Svezia"], names: ["Aktiebolag"] },
  { canonical: "AS", areas: ["Norvegia"], names: ["Aksjeselskap"] },
  { canonical: "ASA", areas: ["Norvegia"], names: ["Allmennaksjeselskap"] },
  { canonical: "A/S", areas: ["Danimarca"], names: ["Aktieselskab"] },
  { canonical: "ApS", areas: ["Danimarca"], names: ["Anpartsselskab"] },
  { canonical: "Oy", areas: ["Finlandia"], names: ["Osakeyhtiö"] },
  { canonical: "Oyj", areas: ["Finlandia"], names: ["Julkinen osakeyhtiö"] },
  { canonical: "OÜ", areas: ["Estonia"], names: ["Osaühing"] },
  { canonical: "Sp. z o.o.", areas: ["Polonia"], names: ["Spółka z ograniczoną odpowiedzialnością"] },
  { canonical: "Kft.", areas: ["Ungheria"], names: ["Korlátolt felelősségű társaság"] },
  { canonical: "Zrt.", areas: ["Ungheria"], names: ["Zártkörűen működő részvénytársaság"] },
  { canonical: "s.r.o.", areas: ["Repubblica Ceca", "Slovacchia"], names: ["Společnost s ručením omezeným", "Spoločnosť s ručením obmedzeným"] },
  { canonical: "a.s.", areas: ["Repubblica Ceca"], names: ["Akciová společnost"] },
  { canonical: "d.o.o.", areas: ["Croazia"], names: ["Društvo s ograničenom odgovornošću"] },
  { canonical: "S.R.L.", areas: ["Romania"], names: ["Societate cu răspundere limitată"] },
  { canonical: "OOO", areas: ["Russia"], names: ["Общество с ограниченной ответственностью"] },
  { canonical: "AO", areas: ["Russia"], names: ["Акционерное общество"] },
  { canonical: "K.K.", areas: ["Giappone"], names: ["Kabushiki Kaisha"] },
  { canonical: "G.K.", areas: ["Giappone"], names: ["Godo Kaisha"] },
  { canonical: "有限公司", areas: ["Cina"], names: ["Youxian Gongsi"] },
  { canonical: "股份有限公司", areas: ["Cina"], names: ["Gufen Youxian Gongsi"] },
  { canonical: "株式会社", areas: ["Corea del Sud"], names: ["Jusik Hoesa"] },
  { canonical: "유한회사", areas: ["Corea del Sud"], names: ["Yuhan Hoesa"] },
  { canonical: "Pte. Ltd.", areas: ["Singapore"], names: ["Private Limited"] },
  { canonical: "Pvt. Ltd.", areas: ["India"], names: ["Private Limited"] },
  { canonical: "Sdn. Bhd.", areas: ["Malaysia"], names: ["Sendirian Berhad"] },
  { canonical: "Bhd.", areas: ["Malaysia"], names: ["Berhad"] },
  { canonical: "Ltda.", areas: ["Brasile"], names: ["Limitada"] },
  { canonical: "S.A. de C.V.", areas: ["Messico"], names: ["Sociedad Anónima de Capital Variable"] },
  { canonical: "S. de R.L. de C.V.", areas: ["Messico"], names: ["Sociedad de Responsabilidad Limitada de Capital Variable"] },
  { canonical: "SpA", areas: ["Cile"], names: ["Sociedad por Acciones"] },
  { canonical: "S.A.C.", areas: ["Perù"], names: ["Sociedad Anónima Cerrada"] },
  { canonical: "Pty Ltd", areas: ["Australia", "Sudafrica"], names: ["Proprietary Limited"] },
  { canonical: "SARL", areas: ["Africa francofona"], names: ["Société à responsabilité limitée"] },
  { canonical: "L.L.C.", areas: ["Emirati Arabi Uniti"], names: ["Limited Liability Company"] },
  { canonical: "W.L.L.", areas: ["Bahrein e Kuwait"], names: ["With Limited Liability"] },
  { canonical: "S.c.p.A.", areas: ["legacy"], names: ["Società consortile per azioni"] },
  { canonical: "S.d.f.", areas: ["legacy"], names: ["Società di fatto"] },
  { canonical: "S.c.a.r.l.", areas: ["legacy"], names: ["Società cooperativa a responsabilità limitata"] },
  { canonical: "GmbH & Co. KG", areas: ["legacy"], names: ["GmbH & Co. KG"] },
  { canonical: "Co. KG", areas: ["legacy"], names: ["Co. KG"] },
  { canonical: "e.K.", areas: ["legacy"], names: ["eingetragener Kaufmann"] },
  { canonical: "BVBA", areas: ["legacy"], names: ["Besloten vennootschap met beperkte aansprakelijkheid"] },
  { canonical: "CVBA", areas: ["legacy"], names: ["Coöperatieve vennootschap met beperkte aansprakelijkheid"] },
  { canonical: "VZW", areas: ["legacy"], names: ["Vereniging zonder winstoogmerk"] },
  { canonical: "Limited", areas: ["legacy"], names: ["Limited"] },
  { canonical: "Private Limited", areas: ["legacy"], names: ["Private Limited"] },
  { canonical: "(Private) Limited", areas: ["legacy"], names: ["Private Limited"] },
  { canonical: "Corporation", areas: ["legacy"], names: ["Corporation"] },
  { canonical: "A.G.", areas: ["legacy"], names: ["Aktiengesellschaft (grafia punteggiata legacy)"] },
];

const AMBIGUOUS_NAKED_KEYS = new Set([
  'AG', 'AB', 'AS', 'BV', 'NV', 'SA', 'KG', 'OY', 'SE', 'CO', 'LP',
  'UG', 'AO', 'KK', 'GK', 'SC', 'SS',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function legalFormCompactKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function latinTokenPattern(token: string): string {
  const chars = [...token];
  if (chars.length <= 4) {
    return chars.map((char) => escapeRegex(char)).join(String.raw`[\s.]*`);
  }
  return escapeRegex(token);
}

function formPattern(canonical: string): string {
  if (/[^\x00-\x7F]/u.test(canonical) && !/[A-Za-zÀ-ÿ]/u.test(canonical)) {
    return [...canonical].map((char) => escapeRegex(char)).join(String.raw`\s*`);
  }

  const tokens = canonical.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length) return escapeRegex(canonical);
  return tokens
    .map((token) => latinTokenPattern(token))
    .join(String.raw`[\s./-]*`);
}

const UNIQUE_PATTERNS = [...new Set(
  LEGAL_FORM_CATALOG
    .map((entry) => formPattern(entry.canonical))
    .filter(Boolean)
)].sort((a, b) => b.length - a.length);

export const INTERNATIONAL_LEGAL_FORM_PATTERN_SOURCE =
  `(?:${UNIQUE_PATTERNS.join('|')})`;

const NON_LATIN_FORMS = LEGAL_FORM_CATALOG
  .map((entry) => entry.canonical)
  .filter((value) => /[^\x00-\x7F]/u.test(value) && !/[A-Za-zÀ-ÿ]/u.test(value));

export const NON_LATIN_LEGAL_FORM_PATTERN_SOURCE = `(?:${
  NON_LATIN_FORMS.map((value) => formPattern(value)).join('|')
})`;

const KEY_TO_FORMS = new Map<string, string[]>();
for (const entry of LEGAL_FORM_CATALOG) {
  const key = legalFormCompactKey(entry.canonical);
  const values = KEY_TO_FORMS.get(key) ?? [];
  if (!values.includes(entry.canonical)) values.push(entry.canonical);
  KEY_TO_FORMS.set(key, values);
}

const PREFERRED_DISPLAY: Readonly<Record<string, string>> = {
  SRL: 'S.r.l.',
  SRLS: 'S.r.l.s.',
  SPA: 'S.p.A.',
  SCPA: 'S.c.p.A.',
  SNC: 'S.n.c.',
  SAS: 'S.a.s.',
  SASU: 'S.A.S.U.',
  SAPA: 'S.a.p.A.',
  SDF: 'S.d.f.',
  SCARL: 'S.c.a.r.l.',
  STP: 'S.T.P.',
  GMBH: 'GmbH',
  GMBHCOKG: 'GmbH & Co. KG',
  COKG: 'Co. KG',
  EK: 'e.K.',
  KFT: 'Kft.',
  SPZOO: 'Sp. z o.o.',
  APS: 'ApS',
  LLC: 'LLC',
  LLP: 'LLP',
  LTD: 'Ltd.',
  INC: 'Inc.',
  CORP: 'Corp.',
  PLC: 'PLC',
  SARL: 'SARL',
};

export function preferredLegalFormDisplayForKey(key: string): string | null {
  const normalized = legalFormCompactKey(key);
  if (!normalized) return null;
  const preferred = PREFERRED_DISPLAY[normalized];
  if (preferred) return preferred;
  const values = KEY_TO_FORMS.get(normalized);
  if (!values?.length) return null;
  if (values.length === 1) return values[0]!;
  return normalized;
}

export function isKnownLegalFormKey(value: string): boolean {
  return KEY_TO_FORMS.has(legalFormCompactKey(value));
}

/**
 * True se la punteggiatura/spaziatura osservata coincide con una grafia del
 * catalogo (case-insensitive). Le forme compatte senza separatori, es. SRL,
 * LLC, SpA, sono anch'esse grafie valide da preservare.
 */
export function isKnownLegalFormTypography(value: string): boolean {
  const observed = value.trim().replace(/\s+/g, ' ');
  if (!observed) return false;
  if (/^[\p{L}\p{N}]+\.?$/u.test(observed) && isKnownLegalFormKey(observed)) {
    return true;
  }
  const lower = observed.toLocaleLowerCase();
  return LEGAL_FORM_CATALOG.some(
    (entry) => entry.canonical.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === lower
  );
}

export function isAmbiguousNakedLegalFormKey(value: string): boolean {
  return AMBIGUOUS_NAKED_KEYS.has(legalFormCompactKey(value));
}

export function canonicalizeKnownLegalForm(value: string): string | null {
  const key = legalFormCompactKey(value);
  if (!KEY_TO_FORMS.has(key)) return null;
  return preferredLegalFormDisplayForKey(key);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        cur[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/**
 * OCR repair conservativo per una coda societaria:
 * - match esatto -> forma riconosciuta;
 * - altrimenti massimo 1 edit;
 * - il compact-key vincente deve essere unico;
 * - nessuna correzione se due forme diverse sono alla stessa distanza.
 */
export function repairUniqueLegalFormOcr(value: string): string | null {
  const key = legalFormCompactKey(value);
  if (!key || key.length < 2 || key.length > 24) return null;

  if (KEY_TO_FORMS.has(key)) return preferredLegalFormDisplayForKey(key);

  let bestDistance = Number.POSITIVE_INFINITY;
  const bestKeys: string[] = [];
  const observedParts = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  const observedAsSegmentedAcronym =
    observedParts.length >= 2 && observedParts.every((part) => [...part].length === 1);
  for (const candidateKey of KEY_TO_FORMS.keys()) {
    if (Math.abs(candidateKey.length - key.length) > 1) continue;
    if (observedAsSegmentedAcronym) {
      const candidateDisplay = preferredLegalFormDisplayForKey(candidateKey) ?? '';
      const candidateParts = candidateDisplay.match(/[\p{L}\p{N}]+/gu) ?? [];
      const candidateIsSegmentedAcronym =
        candidateParts.length >= 2 &&
        candidateParts.every((part) => [...part].length === 1);
      if (!candidateIsSegmentedAcronym) continue;
    }
    // Open-set OCR repair: no per-glyph table. A substitution, insertion or
    // deletion is accepted only when the whole international catalog yields
    // one unique nearest legal-form key at distance 1.
    const distance = levenshtein(key, candidateKey);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestKeys.length = 0;
      bestKeys.push(candidateKey);
    } else if (distance === bestDistance) {
      bestKeys.push(candidateKey);
    }
  }

  if (bestDistance > 1 || bestKeys.length !== 1) return null;
  return preferredLegalFormDisplayForKey(bestKeys[0]!);
}

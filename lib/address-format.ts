import type { Address } from '../types';

/** Parti strutturate prima della composizione in `full`. */
export interface AddressParts {
  street?: string;
  civicNumber?: string;
  postalCode?: string;
  city?: string;
  /** IT: sigla provincia (VI). Estero: stato, contea, cantone, Land, district… */
  region?: string;
  country?: string;
}

export const VALID_PROVINCE_CODES = new Set([
  'AG', 'AL', 'AN', 'AO', 'AP', 'AQ', 'AR', 'AT', 'AV',
  'BA', 'BG', 'BI', 'BL', 'BN', 'BO', 'BR', 'BS', 'BT', 'BZ',
  'CA', 'CB', 'CE', 'CH', 'CI', 'CL', 'CN', 'CO', 'CR', 'CS', 'CT', 'CZ',
  'EN',
  'FC', 'FE', 'FG', 'FI', 'FM', 'FR',
  'GE', 'GO', 'GR',
  'IM', 'IS',
  'KR',
  'LC', 'LE', 'LI', 'LO', 'LT', 'LU',
  'MB', 'MC', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT',
  'NA', 'NO', 'NU',
  'OG', 'OR', 'OT',
  'PA', 'PC', 'PD', 'PE', 'PG', 'PI', 'PN', 'PO', 'PR', 'PT', 'PU', 'PV', 'PZ',
  'RA', 'RC', 'RE', 'RG', 'RI', 'RM', 'RN', 'RO',
  'SA', 'SI', 'SO', 'SP', 'SR', 'SS', 'SU', 'SV',
  'TA', 'TE', 'TN', 'TO', 'TP', 'TR', 'TS', 'TV',
  'UD',
  'VA', 'VB', 'VC', 'VE', 'VI', 'VR', 'VS', 'VT', 'VV',
]);

const PROVINCE_BY_CITY: Record<string, string> = {
  TORINO: 'TO', ALESSANDRIA: 'AL', ASTI: 'AT', BIELLA: 'BI', CUNEO: 'CN', NOVARA: 'NO',
  VERBANIA: 'VB', VERCELLI: 'VC', MONCALIERI: 'TO', NICHELINO: 'TO', AOSTA: 'AO',
  MILANO: 'MI', BERGAMO: 'BG', BRESCIA: 'BS', COMO: 'CO', CREMONA: 'CR', LECCO: 'LC',
  LODI: 'LO', MANTOVA: 'MN', MONZA: 'MB', PAVIA: 'PV', SONDRIO: 'SO', VARESE: 'VA',
  'BUSTO ARSIZIO': 'VA', GALLARATE: 'VA', LEGNANO: 'MI', 'SESTO SAN GIOVANNI': 'MI',
  'CINISELLO BALSAMO': 'MI', RHO: 'MI', VIGEVANO: 'PV', CREMA: 'CR',
  'DESENZANO DEL GARDA': 'BS', SALO: 'BS',
  TRENTO: 'TN', BOLZANO: 'BZ',
  VENEZIA: 'VE', VERONA: 'VR', VICENZA: 'VI', PADOVA: 'PD', TREVISO: 'TV', ROVIGO: 'RO',
  BELLUNO: 'BL', SCHIO: 'VI', 'BASSANO DEL GRAPPA': 'VI', THIENE: 'VI', VALDAGNO: 'VI',
  SANTORSO: 'VI', ARSIERO: 'VI', CASTELGOMBERTO: 'VI', VILLAVERLA: 'VI',
  RONCADE: 'TV', 'TREZZANO SUL NAVIGLIO': 'MI', BRUSAPORTO: 'BG',
  ZANE: 'VI',
  ARZIGNANO: 'VI', 'MONTECCHIO MAGGIORE': 'VI', LONIGO: 'VI', 'NOVENTA VICENTINA': 'VI',
  CONEGLIANO: 'TV', 'CASTELFRANCO VENETO': 'TV', MONTEBELLUNA: 'TV', ODERZO: 'TV',
  CITTADELLA: 'PD', LEGNAGO: 'VR', 'VILLAFRANCA DI VERONA': 'VR', MESTRE: 'VE',
  CHIOGGIA: 'VE', 'SAN DONA DI PIAVE': 'VE',
  TRIESTE: 'TS', UDINE: 'UD', PORDENONE: 'PN', GORIZIA: 'GO',
  GENOVA: 'GE', IMPERIA: 'IM', 'LA SPEZIA': 'SP', SAVONA: 'SV',
  BOLOGNA: 'BO', FERRARA: 'FE', FORLI: 'FC', CESENA: 'FC', CESENATICO: 'FC',
  MODENA: 'MO', CARPI: 'MO', PARMA: 'PR', BUSSETO: 'PR', PIACENZA: 'PC',
  RAVENNA: 'RA', FAENZA: 'RA', 'REGGIO EMILIA': 'RE', RIMINI: 'RN', IMOLA: 'BO',
  FIRENZE: 'FI', EMPOLI: 'FI', AREZZO: 'AR', GROSSETO: 'GR', LIVORNO: 'LI',
  LUCCA: 'LU', VIAREGGIO: 'LU', MASSA: 'MS', CARRARA: 'MS', PISA: 'PI',
  PISTOIA: 'PT', PRATO: 'PO', SIENA: 'SI',
  PERUGIA: 'PG', TERNI: 'TR',
  ANCONA: 'AN', 'ASCOLI PICENO': 'AP', FERMO: 'FM', MACERATA: 'MC', PESARO: 'PU',
  ROMA: 'RM', TIVOLI: 'RM', ANZIO: 'RM', CIVITAVECCHIA: 'RM', FROSINONE: 'FR',
  LATINA: 'LT', APRILIA: 'LT', RIETI: 'RI', VITERBO: 'VT',
  AQUILA: 'AQ', LAQUILA: 'AQ', CHIETI: 'CH', PESCARA: 'PE', TERAMO: 'TE',
  CAMPOBASSO: 'CB', ISERNIA: 'IS',
  NAPOLI: 'NA', 'TORRE DEL GRECO': 'NA', POMPEI: 'NA', 'CASTELLAMMARE DI STABIA': 'NA',
  AVELLINO: 'AV', BENEVENTO: 'BN', CASERTA: 'CE', SALERNO: 'SA', 'NOCERA INFERIORE': 'SA',
  BARI: 'BA', MOLFETTA: 'BA', ALTAMURA: 'BA', BARLETTA: 'BT', ANDRIA: 'BT', TRANI: 'BT',
  BRINDISI: 'BR', FOGGIA: 'FG', MANFREDONIA: 'FG', CERIGNOLA: 'FG', LECCE: 'LE', TARANTO: 'TA',
  POTENZA: 'PZ', MATERA: 'MT',
  CATANZARO: 'CZ', COSENZA: 'CS', CROTONE: 'KR', 'REGGIO CALABRIA': 'RC', 'VIBO VALENTIA': 'VV',
  PALERMO: 'PA', AGRIGENTO: 'AG', CALTANISSETTA: 'CL', CATANIA: 'CT', ACIREALE: 'CT',
  ENNA: 'EN', MESSINA: 'ME', RAGUSA: 'RG', VITTORIA: 'RG', SIRACUSA: 'SR', TRAPANI: 'TP',
  MARSALA: 'TP', GELA: 'CL',
  CAGLIARI: 'CA', NUORO: 'NU', ORISTANO: 'OR', SASSARI: 'SS', 'SUD SARDEGNA': 'SU',
  CARBONIA: 'SU', IGLESIAS: 'SU',
};

const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const STREET_TYPE =
  /\b(?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?|street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.?)\b/i;

const STREET_TYPE_LABELS: Record<string, string> = {
  via: 'Via',
  viale: 'Viale',
  'v.': 'V.',
  piazza: 'Piazza',
  'p.za': 'P.za',
  'p. za': 'P.za',
  corso: 'Corso',
  'c.so': 'C.so',
  galleria: 'Galleria',
  largo: 'Largo',
  vicolo: 'Vicolo',
  'v.lo': 'V.lo',
  str: 'Str.',
  street: 'Street',
  st: 'St.',
  road: 'Road',
  rd: 'Rd.',
  avenue: 'Avenue',
  ave: 'Ave.',
  boulevard: 'Boulevard',
  blvd: 'Blvd.',
};

const COUNTRY_ALIASES: Record<string, string> = {
  IT: 'IT',
  ITALY: 'IT',
  ITALIA: 'IT',
  ITAL: 'IT',
  UK: 'GB',
  GB: 'GB',
  'GREAT BRITAIN': 'GB',
  'UNITED KINGDOM': 'GB',
  ENGLAND: 'GB',
  SCOTLAND: 'GB',
  WALES: 'GB',
  US: 'US',
  USA: 'US',
  'UNITED STATES': 'US',
  DE: 'DE',
  GERMANY: 'DE',
  DEUTSCHLAND: 'DE',
  FR: 'FR',
  FRANCE: 'FR',
  CH: 'CH',
  SWITZERLAND: 'CH',
  SCHWEIZ: 'CH',
  SVIZZERA: 'CH',
  AT: 'AT',
  AUSTRIA: 'AT',
  OSTERREICH: 'AT',
  ES: 'ES',
  SPAIN: 'ES',
  ESPANA: 'ES',
  NL: 'NL',
  NETHERLANDS: 'NL',
  BE: 'BE',
  BELGIUM: 'BE',
  PT: 'PT',
  PORTUGAL: 'PT',
  IE: 'IE',
  IRELAND: 'IE',
  DK: 'DK',
  DENMARK: 'DK',
  DANMARK: 'DK',
  SE: 'SE',
  SWEDEN: 'SE',
  SVERIGE: 'SE',
  NO: 'NO',
  NORWAY: 'NO',
  NORGE: 'NO',
  FI: 'FI',
  FINLAND: 'FI',
  PL: 'PL',
  POLAND: 'PL',
  POLSKA: 'PL',
  CZ: 'CZ',
  CZECHIA: 'CZ',
  'CZECH REPUBLIC': 'CZ',
  SK: 'SK',
  SLOVAKIA: 'SK',
  HU: 'HU',
  HUNGARY: 'HU',
  RO: 'RO',
  ROMANIA: 'RO',
  GR: 'GR',
  GREECE: 'GR',
  TR: 'TR',
  TURKEY: 'TR',
  TURKIYE: 'TR',
  CA: 'CA',
  CANADA: 'CA',
  MX: 'MX',
  MEXICO: 'MX',
  BR: 'BR',
  BRAZIL: 'BR',
  BRASIL: 'BR',
  AR: 'AR',
  ARGENTINA: 'AR',
  CR: 'CR',
  'COSTA RICA': 'CR',
  AU: 'AU',
  AUSTRALIA: 'AU',
  NZ: 'NZ',
  'NEW ZEALAND': 'NZ',
  ZA: 'ZA',
  'SOUTH AFRICA': 'ZA',
  IN: 'IN',
  INDIA: 'IN',
  PK: 'PK',
  PAKISTAN: 'PK',
  CN: 'CN',
  CHINA: 'CN',
  JP: 'JP',
  JAPAN: 'JP',
  KR: 'KR',
  KOREA: 'KR',
  COREA: 'KR',
  'SOUTH KOREA': 'KR',
  'REPUBLIC OF KOREA': 'KR',
  SA: 'SA',
  'SAUDI ARABIA': 'SA',
  AE: 'AE',
  UAE: 'AE',
  'UNITED ARAB EMIRATES': 'AE',
  SG: 'SG',
  SINGAPORE: 'SG',
  HK: 'HK',
  'HONG KONG': 'HK',
  TW: 'TW',
  TAIWAN: 'TW',
  CI: 'CI',
  'COTE D IVOIRE': 'CI',
  'IVORY COAST': 'CI',
  BA: 'BA',
  'BOSNIA HERZEGOVINA': 'BA',
  'BOSNIA AND HERZEGOVINA': 'BA',
  DO: 'DO',
  'DOMINICAN REPUBLIC': 'DO',
  MK: 'MK',
  'NORTH MACEDONIA': 'MK',
  LK: 'LK',
  'SRI LANKA': 'LK',
  PR: 'PR',
  'PUERTO RICO': 'PR',
};

/** Codice paese mostrato in `full` (UK sui biglietti, non GB). */
const COUNTRY_DISPLAY: Record<string, string> = {
  IT: 'IT',
  GB: 'UK',
  US: 'US',
  DE: 'DE',
  FR: 'FR',
  CH: 'CH',
  AT: 'AT',
  ES: 'ES',
  NL: 'NL',
  BE: 'BE',
  PT: 'PT',
  IE: 'IE',
  DK: 'DK',
  SE: 'SE',
  NO: 'NO',
  FI: 'FI',
  PL: 'PL',
  CZ: 'CZ',
  SK: 'SK',
  HU: 'HU',
  RO: 'RO',
  GR: 'GR',
  TR: 'TR',
  CA: 'CA',
  MX: 'MX',
  BR: 'BR',
  AR: 'AR',
  CR: 'CR',
  AU: 'AU',
  NZ: 'NZ',
  ZA: 'ZA',
  IN: 'IN',
  PK: 'PK',
  CN: 'CN',
  JP: 'JP',
  KR: 'KR',
  SA: 'SA',
  AE: 'AE',
  SG: 'SG',
  HK: 'HK',
  TW: 'TW',
  CI: 'CI',
  BA: 'BA',
  DO: 'DO',
  MK: 'MK',
  LK: 'LK',
  PR: 'PR',
};

function capitalizeToken(word: string): string {
  if (!word) return '';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function normalizeOcrWordCaps(word: string): string {
  if (!word || word.length < 2) return word;
  if (/^\d/.test(word) || /^[A-Z]\.$/.test(word)) return word;
  if (/[a-zà-ü][A-ZÀ-Ü]/.test(word)) return capitalizeToken(word);
  return word;
}

export function formatStreetLine(street: string): string {
  const t = street.trim();
  const typedStart = t.match(
    /^(?:(\d+[a-zA-Z/]?\s+))?((?:via|viale|v\.|piazza|p\.?\s*za\.?|corso|c\.so|galleria|largo|vicolo|v\.lo|str\.?|street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd\.))\.?\s+(.+)$/i
  );
  if (typedStart) {
    const prefix = typedStart[1] ?? '';
    const rawType = typedStart[2].toLowerCase().replace(/\s+/g, ' ').trim();
    const formattedType = STREET_TYPE_LABELS[rawType.replace(/\s+/g, ' ')] ?? capitalizeToken(rawType);
    const rest = typedStart[3]
      .trim()
      .split(/\s+/)
      .map((w) => normalizeOcrWordCaps(w))
      .map((w) => (/^[A-Za-zÀ-ü'.-]+$/.test(w) ? capitalizeToken(w) : w))
      .join(' ');
    return `${prefix}${formattedType} ${rest}`.trim();
  }
  return t
    .split(/\s+/)
    .map((w) => normalizeOcrWordCaps(w))
    .map((w) => (/^[A-Za-zÀ-ü'.-]+$/.test(w) ? capitalizeToken(w) : w))
    .join(' ');
}

export function formatCityName(city: string): string {
  return city
    .split(/\s+/)
    .map((w) => normalizeOcrWordCaps(w))
    .map((w) => capitalizeToken(w))
    .join(' ');
}

function normalizeCityKey(city: string): string {
  return city
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, '')
    .trim();
}

export function resolveProvince(
  city: string | undefined,
  provinceRaw: string | undefined
): string | undefined {
  const cleanRaw = provinceRaw?.replace(/[()]/g, '').trim().toUpperCase();
  if (cleanRaw && VALID_PROVINCE_CODES.has(cleanRaw)) return cleanRaw;
  const cityKey = city ? normalizeCityKey(city) : '';
  return cityKey ? PROVINCE_BY_CITY[cityKey] : undefined;
}

export function normalizeCountryCode(raw?: string): string | undefined {
  if (!raw) return undefined;
  const key = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[.’'`´-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return COUNTRY_ALIASES[key];
}

function displayCountry(code?: string): string | undefined {
  if (!code) return undefined;
  return COUNTRY_DISPLAY[code] ?? code;
}

function formatItalianProvince(raw?: string): string | undefined {
  const code = raw?.replace(/[()]/g, '').trim().toUpperCase();
  if (!code) return undefined;
  return VALID_PROVINCE_CODES.has(code) ? code : undefined;
}

function formatForeignRegion(raw: string | undefined, countryCode?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[()]/g, '').trim();
  if (!cleaned) return undefined;
  if (countryCode === 'US' && /^[A-Za-z]{2}$/.test(cleaned) && US_STATE_CODES.has(cleaned.toUpperCase())) {
    return cleaned.toUpperCase();
  }
  if (/^[A-Za-z]{2}$/.test(cleaned) && countryCode && countryCode !== 'US') {
    return cleaned.toUpperCase();
  }
  return cleaned
    .split(/\s+/)
    .map((w) => normalizeOcrWordCaps(w))
    .map((w) => capitalizeToken(w))
    .join(' ');
}

function isLikelyItalianAddress(parts: AddressParts, countryCode?: string): boolean {
  if (countryCode === 'IT') return true;
  if (countryCode && countryCode !== 'IT') return false;
  if (parts.postalCode && /^\d{5}$/.test(parts.postalCode)) {
    const prov = formatItalianProvince(parts.region);
    if (prov) return true;
    if (parts.city && resolveProvince(parts.city, parts.region)) return true;
  }
  if (parts.region && formatItalianProvince(parts.region)) return true;
  return false;
}

function parseProvinceFromText(text: string): string | undefined {
  const paren = text.match(/\(([A-Za-z]{2})\)/);
  if (paren) return paren[1].toUpperCase();
  const bare = text.match(/\b([A-Za-z]{2})\b/);
  return bare && VALID_PROVINCE_CODES.has(bare[1].toUpperCase()) ? bare[1].toUpperCase() : undefined;
}

/** Separa nome via e numero civico (es. "Via S. D. Savio 3" → via + 3). */
const ADDRESS_LABEL_PREFIX_RE =
  /^(?:sede\s*(?:legale|operativa|amministrativa|fiscale)?|dom\.?\s*fisc\.?|domicilio\s*fisc(?:ale)?|uff(?:icio)?|office|head\s*quarters?|hq)\s*[:\.]?\s*/i;

export const CIVIC_LABEL_PATTERN_SOURCE =
  String.raw`(?:n(?:ro|r|o)?\.?\s*(?:[°º]\s*)?|n[uú]m(?:ero)?\.?\s*|numero\s*|civico\s*|hausnummer\s*|#\s*|[°º]\s*)`;

const CIVIC_LABEL_PATTERN = CIVIC_LABEL_PATTERN_SOURCE;

const NUMBERED_STREET_TYPE_PATTERN_SOURCE =
  String.raw`(?:via|viale|piazza|corso|vicolo|strada|street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|lane|ln\.?|drive|route|rue|cours|crs\.?|bd\.?|calle|carrer|avenida|paseo|ul\.?|ulica|platz|allee|weg|gasse|gade|gata|gatan|vej|ut)`;

const FUSED_STREET_SUFFIX_PATTERN_SOURCE =
  String.raw`(?:strasse|straße|straat|gracht|singel|weg|laan|kade|plein|dijk|gade|gata|gatan|vägen|vagen|vej|tie|katu|intie)`;

/** Struttura civico+via forte, riusata per separare code indirizzo da etichette numeriche. */
export function hasStrongNumberedStreetStructure(text: string): boolean {
  const candidate = text
    .trim()
    .replace(/^[,;:–—-]+\s*/, '')
    .replace(/\s+/g, ' ');
  if (!candidate) return false;
  const civic = String.raw`(?:${CIVIC_LABEL_PATTERN_SOURCE})?\d{1,5}[a-zA-Z]?(?:\/[a-zA-Z0-9]+)?`;
  const word = String.raw`[\p{L}0-9][\p{L}\p{M}0-9'’.-]*`;
  return (
    new RegExp(
      String.raw`^${civic}\s+${word}(?:\s+${word}){0,6}\s+${NUMBERED_STREET_TYPE_PATTERN_SOURCE}\b(?:\s+[\p{Lu}]{1,3})?$`,
      'iu'
    ).test(candidate) ||
    new RegExp(
      String.raw`^${civic}\s+${NUMBERED_STREET_TYPE_PATTERN_SOURCE}\s+${word}(?:\s+${word}){0,6}$`,
      'iu'
    ).test(candidate) ||
    new RegExp(
      String.raw`^${NUMBERED_STREET_TYPE_PATTERN_SOURCE}\s+${word}(?:\s+${word}){0,6}[,\s]+${civic}$`,
      'iu'
    ).test(candidate) ||
    new RegExp(
      String.raw`^${word}(?:\s+${word}){0,6}\s+${NUMBERED_STREET_TYPE_PATTERN_SOURCE}[,\s]+${civic}$`,
      'iu'
    ).test(candidate) ||
    new RegExp(
      String.raw`^${word}(?:${FUSED_STREET_SUFFIX_PATTERN_SOURCE})[,\s]+${civic}$`,
      'iu'
    ).test(candidate)
  );
}

function stripAddressLabelPrefix(text: string): string {
  return text.replace(ADDRESS_LABEL_PREFIX_RE, '').trim();
}

function civicAlreadyInStreet(street: string, civic?: string): boolean {
  if (!civic || !street) return false;
  const esc = civic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    new RegExp(
      `(?:${CIVIC_LABEL_PATTERN}|,\\s*|\\s+)${esc}\\b`,
      'i'
    ).test(street)
  ) {
    return true;
  }
  const letter = civic.replace(/\d/g, '').toLowerCase();
  if (letter && new RegExp(`\\b\\d+${letter}\\s*Ed\\.?\\b`, 'i').test(street)) return true;
  return false;
}

/** Rimuove duplicati tipo "4b Ed." quando il civico verrà aggiunto come Nr. XX. */
function stripRedundantEdUnitFromStreet(street: string, civic?: string): string {
  if (!street?.trim()) return street;
  let result = street.trim();
  if (civic) {
    result = result.replace(/,\s*\d+[a-zA-Z]?\s*Ed\.?\s*$/i, '');
    result = result.replace(/\s+\d+[a-zA-Z]?\s*Ed\.?\s*$/i, '');
    const letter = civic.replace(/\d/g, '').toLowerCase();
    if (letter) {
      result = result.replace(new RegExp(`,\\s*\\d+${letter}\\s*Ed\\.?\\s*$`, 'i'), '');
    }
  }
  return result.replace(/,\s*$/, '').trim();
}

function cityAlreadyInText(text: string, city?: string): boolean {
  if (!city || !text) return false;
  const cityKey = city.replace(/\s*\([A-Za-z]{2}\)\s*$/i, '').trim().toLowerCase();
  if (cityKey.length < 3) return false;
  return text.toLowerCase().includes(cityKey);
}

function normalizeProvinceInText(text: string): string {
  return text.replace(/\(([a-z]{2})\)/g, (_, p: string) => `(${p.toUpperCase()})`);
}

function isBareStreetTypeToken(street: string): boolean {
  return /^(?:via|viale|piazza|corso|vicolo|v\.|strada|str\.?|localit[aà]|galleria|largo|contrada)\.?$/i.test(
    street.trim()
  );
}

function isInvalidStreetName(street?: string): boolean {
  if (!street?.trim()) return true;
  const t = street.trim();
  if (isBareStreetTypeToken(t)) return true;
  if (/^(?:via|viale|piazza|corso|vicolo|v\.|strada|str\.|localit[aà]|galleria|largo|contrada)\b/i.test(t)) {
    return false;
  }
  if (/^\d{5}\b/.test(t)) return true;
  if (/\b(?:s\.?\s*r\.?\s*l|s\.?\s*p\.?\s*a|soluzioni\s+software|ingegneria)\b/i.test(t)) return true;
  if (/\b(?:italy|italia)\b/i.test(t) && !STREET_TYPE.test(t)) return true;
  return !STREET_TYPE.test(t) && t.length > 48;
}

function formatItalianProvinceSegment(code?: string): string | undefined {
  const clean = code?.replace(/[()]/g, '').trim().toUpperCase();
  if (!clean || !VALID_PROVINCE_CODES.has(clean)) return undefined;
  return `(${clean})`;
}

function stripProvinceParens(segment: string): string {
  const m = segment.match(/^\(([A-Z]{2})\)$/i);
  return m ? m[1].toUpperCase() : segment.replace(/[()]/g, '').trim().toUpperCase();
}

/** Rimuove segmenti ridondanti (CAP/città/provincia già presenti in un blocco precedente). */
function collapseRedundantAddressSegments(segments: string[]): string[] {
  const result: string[] = [];
  let seenCap = '';
  let seenCity = '';
  let seenProv = '';

  for (const raw of segments) {
    const seg = normalizeProvinceInText(raw.trim());
    if (!seg) continue;

    const capCityProv = seg.match(/^(\d{5})\s+(.+?)\s+\(([A-Z]{2})\)$/i);
    if (capCityProv) {
      seenCap = capCityProv[1];
      seenCity = capCityProv[2].trim().toLowerCase();
      seenProv = capCityProv[3].toUpperCase();
      result.push(seg);
      continue;
    }

    if (/^\d{5}$/.test(seg)) {
      if (seg === seenCap || result.includes(seg)) continue;
      seenCap = seg;
      result.push(seg);
      continue;
    }

    if (/^\([A-Z]{2}\)$/.test(seg)) {
      const prov = stripProvinceParens(seg);
      if (prov === seenProv) continue;
      seenProv = prov;
      result.push(formatItalianProvinceSegment(prov) ?? seg);
      continue;
    }

    if (/^[A-Z]{2}$/.test(seg) && VALID_PROVINCE_CODES.has(seg.toUpperCase())) {
      const prov = seg.toUpperCase();
      if (prov === seenProv) continue;
      seenProv = prov;
      result.push(formatItalianProvinceSegment(prov) ?? prov);
      continue;
    }

    if (/^[A-Z]{2}$/.test(seg)) {
      const prov = seg.toUpperCase();
      if (prov === seenProv) continue;
      seenProv = prov;
      result.push(seg);
      continue;
    }

    const cityProvOnly = seg.match(/^(.+?)\s+\(([A-Z]{2})\)$/i);
    if (cityProvOnly) {
      const city = cityProvOnly[1].trim().toLowerCase();
      const prov = cityProvOnly[2].toUpperCase();
      if (seenCity === city && (seenProv === prov || !seenProv)) {
        if (seenProv !== prov) seenProv = prov;
        continue;
      }
    }

    const cityBare = seg.toLowerCase();
    if (seenCity && cityBare === seenCity) continue;

    const capCityProvInline = seg.match(/^(\d{5})\s+(.+?)\s+\(([A-Z]{2})\)$/i);
    if (capCityProvInline) {
      const cap = capCityProvInline[1];
      const city = capCityProvInline[2].trim().toLowerCase();
      const prov = capCityProvInline[3].toUpperCase();
      if (seenCap === cap && seenCity === city && (seenProv === prov || !seenProv)) continue;
      seenCap = cap;
      seenCity = city;
      seenProv = prov;
      result.push(cap);
      result.push(capCityProvInline[2].trim());
      result.push(formatItalianProvinceSegment(prov) ?? prov);
      continue;
    }

    if (seenCap && seenCity && seg.includes(seenCap) && seg.toLowerCase().includes(seenCity)) {
      if (!/^(?:via|viale|piazza|corso|vicolo|v\.|strada)/i.test(seg)) continue;
    }

    const duplicateLocationTail = seg.match(
      /^(?:via|viale|piazza|corso|vicolo|v\.|strada)\b.+,\s*(?:Nr\.?\s*)?\d+[a-zA-Z0-9/]*\s*-\s*(\d{5})\s+([A-Za-zÀ-ÿ'’ .\-]+)\s*\(([A-Z]{2})\)/i
    );
    if (duplicateLocationTail) {
      const cap = duplicateLocationTail[1];
      const city = duplicateLocationTail[2].trim().toLowerCase();
      const prov = duplicateLocationTail[3].toUpperCase();
      if (seenCap === cap || seenCity === city) {
        const streetOnly = seg.replace(
          /\s*-\s*\d{5}\s+[A-Za-zÀ-ÿ'’ .\-]+\s*\([A-Z]{2}\)\s*$/i,
          ''
        );
        if (streetOnly.trim()) result.push(streetOnly.trim());
        continue;
      }
    }

    if (/^(?:via|viale|piazza|corso|vicolo|v\.|strada)/i.test(seg)) {
      const capInSeg = seg.match(/\b(\d{5})\b/);
      if (capInSeg) seenCap = capInSeg[1];
      const cityInSeg = seg.match(/\b(\d{5})\s+([A-Za-zÀ-ÿ'’ .\-]+?)\s*\(([A-Z]{2})\)/i);
      if (cityInSeg) {
        seenCity = cityInSeg[2].trim().toLowerCase();
        seenProv = cityInSeg[3].toUpperCase();
      }
    }

    result.push(seg);
  }
  return result;
}

function dedupeAddressFullString(full: string): string {
  const segments = full.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  return collapseRedundantAddressSegments(segments).join(' - ');
}

function dedupeAddressParts(parts: AddressParts): AddressParts {
  const next = { ...parts };

  if (next.street) {
    next.street = stripAddressLabelPrefix(next.street);
    next.street = next.street
      .replace(/,\s*\d{5}\s+[A-Za-zÀ-ÿ'’ .\-]+(?:\s*\([A-Za-z]{2}\))?\s*(?:,\s*Nr\.?\s*\d+[a-zA-Z0-9/]*)?$/i, '')
      .replace(/\s*-\s*\d{5}\s+[A-Za-zÀ-ÿ'’ .\-]+(?:\s*\([A-Za-z]{2}\))?\s*(?:,\s*Nr\.?\s*\d+[a-zA-Z0-9/]*)?$/i, '')
      .replace(/\s*-\s*\d{5}\s*$/i, '')
      .replace(/,\s*Nr\.?\s*\d{5}\b.*$/i, '')
      .replace(/\bI\s+T\s+\+39\b.*$/i, '')
      .replace(/\s*(?:C\.?\s*F\.?(?:\s*\/\s*|\s*e\s*)?P\.?\s*IVA|P\.?\s*IVA(?:\s*e\s*C\.?\s*F\.?)?)\s*:?\s*[\dA-Z./\s-]*/gi, ' ')
      .replace(/,\s*Nr\.?\s*0\b/gi, '')
      .replace(/\bNr\.?\s*0\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  if (next.civicNumber && /^0+$/.test(next.civicNumber.replace(/\s+/g, ''))) {
    next.civicNumber = undefined;
  }

  if (next.city) {
    const provInCity = next.city.match(/\(([A-Za-z]{2})\)\s*$/);
    if (provInCity && !next.region) {
      next.region = provInCity[1].toUpperCase();
    }
    next.city = normalizeProvinceInText(next.city);
  }

  if (next.region) {
    next.region = next.region.replace(/[()]/g, '').trim().toUpperCase();
  }

  if (next.civicNumber && civicAlreadyInStreet(next.street ?? '', next.civicNumber)) {
    next.civicNumber = undefined;
  }

  if (next.street && next.civicNumber) {
    next.street = stripRedundantEdUnitFromStreet(next.street, next.civicNumber);
  }

  if (next.city && cityAlreadyInText(next.street ?? '', next.city)) {
    const cityBare = next.city.replace(/\s*\([A-Z]{2}\)\s*$/i, '').trim();
    if (cityAlreadyInText(next.street ?? '', cityBare)) {
      next.city = undefined;
      if (next.postalCode && (next.street ?? '').includes(next.postalCode)) {
        next.postalCode = undefined;
      }
    }
  }

  return next;
}

const CIVIC_TOKEN_RE = /\d+[a-zA-Z0-9]*(?:\/[a-zA-Z0-9]+)?/;

function splitStreetAndCivic(rawStreet: string): { streetName: string; civic?: string } {
  const t = rawStreet.trim();
  const labeledCommaNr = t.match(
    new RegExp(
      `^(.+?)[,\\s]+${CIVIC_LABEL_PATTERN}(${CIVIC_TOKEN_RE.source})$`,
      'i'
    )
  );
  if (labeledCommaNr) {
    return {
      streetName: labeledCommaNr[1].trim(),
      civic: labeledCommaNr[2],
    };
  }

  const bareCommaNr = t.match(
    new RegExp(`^(.+?),\\s*(${CIVIC_TOKEN_RE.source})$`, 'i')
  );
  if (bareCommaNr && !/^\d{5}$/.test(bareCommaNr[2])) {
    return {
      streetName: bareCommaNr[1].trim(),
      civic: bareCommaNr[2],
    };
  }

  const spaceNr = t.match(new RegExp(`^(.+?)\\s+(${CIVIC_TOKEN_RE.source})$`));
  if (spaceNr && spaceNr[2].length <= 6 && !/^\d{5}$/.test(spaceNr[2])) {
    return { streetName: spaceNr[1].trim(), civic: spaceNr[2] };
  }
  return { streetName: t };
}

function parseStreetHeadSegment(seg: string): { street?: string; civicNumber?: string } {
  const nrLabel = seg.match(
    new RegExp(
      `^(.+?)[,\\s]+${CIVIC_LABEL_PATTERN}(${CIVIC_TOKEN_RE.source})$`,
      'i'
    )
  );
  if (nrLabel) return { street: nrLabel[1].trim(), civicNumber: nrLabel[2] };
  const leadingCivic = seg.match(
    new RegExp(
      `^(${CIVIC_TOKEN_RE.source})[\\s,]+(.+\\b(?:street|st\\.?|road|rd\\.?|avenue|ave\\.?|boulevard|blvd\\.?|lane|drive|court|strasse|rue|calle)(?:\\s+(?:N|S|E|W|NE|NW|SE|SW))?)$`,
      'i'
    )
  );
  if (leadingCivic) {
    return { street: leadingCivic[2].trim(), civicNumber: leadingCivic[1] };
  }
  const split = splitStreetAndCivic(seg);
  return { street: split.streetName, civicNumber: split.civic };
}

function splitAddressFullSegments(full: string): string[] {
  const dashed = full.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (dashed.length > 1) return dashed;

  // Some cards print a complete address on one comma-separated line rather
  // than using the canonical " - " separator. Only treat commas as structural
  // when the line also contains explicit street and location/country evidence.
  // P.O. Box blocks stay verbatim because their commas often separate the box
  // from a second street and require a richer multi-address representation.
  if (/^\s*P\.?\s*O\.?\s*Box\b/i.test(full)) return dashed;
  const commaSeparated = full.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  if (commaSeparated.length < 2) return dashed;

  const streetIndex = commaSeparated.findIndex((segment) => STREET_TYPE.test(segment));
  const locationIndex = commaSeparated.findIndex(
    (segment, index) =>
      index > streetIndex &&
      (/^\d{4,6}\s+[A-Za-zÀ-ÿ]/.test(segment) ||
        /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]+\s+[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(segment) ||
        /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .-]+\s+\d{4,6}(?:-\d{4})?$/.test(segment) ||
        normalizeCountryCode(segment) !== undefined)
  );

  return streetIndex >= 0 && locationIndex > streetIndex ? commaSeparated : dashed;
}

/**
 * Riga OCR italiana su un'unica linea con separatori · o ". " (es. Dal Zotto):
 * "via S. D. Savio 3- Torrebelvicino . VI . IT"
 */
function looksFormattedAddressFull(full: string): boolean {
  const segments = full.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length >= 3) return true;
  if (segments.length === 2 && /^\d{5}$/.test(segments[1] ?? '')) return true;
  return false;
}

export function parseItalianInlineAddress(line: string): AddressParts | undefined {
  const t = line.trim();
  if (!/^(?:via|viale|piazza|corso|vicolo|largo|galleria)\b/i.test(t)) return undefined;
  if (looksFormattedAddressFull(t)) return undefined;

  const m = t.match(
    /^(via|viale|piazza|corso|vicolo|largo|galleria)\s+(.+?)\s+(\d+[a-zA-Z]?)\s*(?:[-–·•]|\s+[-–·•.]\s*)\s*([A-Za-zÀ-ü][A-Za-zÀ-ü'`-]+)\s*(?:\s*[-–·•.]+\s*)([A-Za-z]{2})\s*(?:\s*[-–·•.]+\s*)(IT|ITALY|ITALIA)\s*$/i
  );
  if (!m || /^\d{5}$/.test(m[3]) || /,\s*(?:Nr\.?\s*)?\d/.test(m[2])) return undefined;

  return {
    street: `${m[1]} ${m[2]}`.trim(),
    civicNumber: m[3],
    city: m[4].trim(),
    region: m[5].toUpperCase(),
    country: 'IT',
  };
}

function isUkPostcode(s: string): boolean {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(s.trim());
}

function parseUsCityStateZip(
  segment: string
): Pick<AddressParts, 'postalCode' | 'city' | 'region'> | undefined {
  const match = segment.trim().match(/^(.+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!match || !US_STATE_CODES.has(match[2].toUpperCase())) return undefined;
  return {
    city: match[1].trim(),
    region: match[2].toUpperCase(),
    postalCode: match[3],
  };
}

function parseLocationSegment(
  segment: string,
  countryCode?: string
): Pick<AddressParts, 'postalCode' | 'city' | 'region'> {
  const t = segment.trim();
  if (!t) return {};

  const itCap = t.match(/^(\d{5})\s+(.+)$/);
  if (itCap && (!countryCode || countryCode === 'IT' || isLikelyItalianAddress({ postalCode: itCap[1] }, countryCode))) {
    const tail = itCap[2].trim();
    const prov = parseProvinceFromText(tail);
    const city = tail.replace(/\s*\([A-Za-z]{2}\)\s*$/, '').trim();
    return { postalCode: itCap[1], city, region: prov };
  }

  const us = parseUsCityStateZip(t);
  if (us && (!countryCode || countryCode === 'US')) {
    return us;
  }

  const uk = t.match(/^(.+?)\s+([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})$/i);
  if (uk && (!countryCode || countryCode === 'GB')) {
    return { city: uk[1].trim(), postalCode: uk[2].toUpperCase().replace(/\s+/g, ' ') };
  }

  const labeled = t.match(
    /^(.+?)(?:,\s*|\s+)(?:County|District|Canton|State|Prov\.?|Province|Kreis|Land|Bundesland|Regione|Département|Departement)\s+(.+)$/i
  );
  if (labeled) {
    return { city: labeled[1].trim(), region: labeled[2].trim() };
  }

  const cityRegion = t.match(/^(.+?),\s*([A-Za-z]{2,})$/);
  if (cityRegion && countryCode && countryCode !== 'IT') {
    return { city: cityRegion[1].trim(), region: cityRegion[2].trim() };
  }

  return { city: t };
}

function isRedundantMiddleAddressSegment(seg: string, headSegment?: string): boolean {
  const t = seg.trim();
  if (!t) return true;
  const dupCityCivic = t.match(
    new RegExp(
      String.raw`^(.+?)\s*\(([A-Z]{2})\),\s*${CIVIC_LABEL_PATTERN}(\d+[a-zA-Z0-9/]*)$`,
      'i'
    )
  );
  if (dupCityCivic && headSegment && civicAlreadyInStreet(headSegment, dupCityCivic[3])) return true;
  const civicOnly = t.match(
    new RegExp(
      `^${CIVIC_LABEL_PATTERN}(\\d+[a-zA-Z0-9/]*)$`,
      'i'
    )
  );
  if (civicOnly && headSegment && civicAlreadyInStreet(headSegment, civicOnly[1])) {
    return true;
  }
  return false;
}

function isValidItalianPostalCode(postalCode?: string): boolean {
  return Boolean(postalCode && /^\d{5}$/.test(postalCode) && !/^0{5}$/.test(postalCode));
}

function sanitizePostalCode(postalCode?: string, countryCode?: string): string | undefined {
  const clean = postalCode?.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  if (countryCode === 'IT') {
    return isValidItalianPostalCode(clean) ? clean : undefined;
  }
  if (!countryCode) {
    return /^(?:\d{4,6}|\d{5}-\d{4})$/.test(clean) ? clean : undefined;
  }
  return clean;
}

function absorbLocationSegments(
  rest: string[],
  countryCode?: string
): Pick<AddressParts, 'postalCode' | 'city' | 'region'> {
  let postalCode: string | undefined;
  let city: string | undefined;
  let region: string | undefined;

  for (const seg of rest) {
    if (/^\d{5}$/.test(seg)) {
      if (!postalCode && isValidItalianPostalCode(seg)) postalCode = seg;
      continue;
    }
    if (/^\([A-Z]{2}\)$/.test(seg)) {
      if (!region) region = stripProvinceParens(seg);
      continue;
    }
    if (/^[A-Z]{2}$/.test(seg) && VALID_PROVINCE_CODES.has(seg.toUpperCase())) {
      if (!region) region = seg.toUpperCase();
      continue;
    }

    const loc = parseLocationSegment(seg, countryCode);
    if (loc.postalCode) {
      if (!postalCode) postalCode = loc.postalCode;
      if (!city && loc.city) city = loc.city;
      if (!region && loc.region) region = loc.region;
      continue;
    }
    if (loc.city) {
      const bare = loc.city.replace(/\s*\([A-Za-z]{2}\)\s*$/i, '').trim();
      if (!city) city = bare;
      if (!region) region = parseProvinceFromText(loc.city) ?? region;
    }
  }

  return { postalCode, city, region };
}

function parseAddressFull(full: string): AddressParts {
  const trimmed = full.trim();
  if (!trimmed) return {};

  const segments = splitAddressFullSegments(trimmed);
  if (segments.length === 0) return {};

  let countryCode: string | undefined;
  const work = [...segments];

  const last = work[work.length - 1];
  const maybeCountry = normalizeCountryCode(last);
  if (maybeCountry && last.length <= 20) {
    countryCode = maybeCountry;
    work.pop();
  } else if (work.some((segment) => parseUsCityStateZip(segment) !== undefined)) {
    countryCode = 'US';
  }

  if (work.length === 0) {
    return { country: countryCode };
  }

  const head = parseStreetHeadSegment(work[0]);
  const rest = work.slice(1).filter((seg) => !isRedundantMiddleAddressSegment(seg, work[0]));

  if (rest.length === 1) {
    const loc = parseLocationSegment(rest[0], countryCode);
    return {
      street: head.street,
      civicNumber: head.civicNumber,
      ...loc,
      country: countryCode,
    };
  }

  const absorbed = absorbLocationSegments(rest, countryCode);

  return {
    street: head.street,
    civicNumber: head.civicNumber,
    postalCode: absorbed.postalCode,
    city: absorbed.city,
    region: absorbed.region
      ? formatItalianProvince(absorbed.region) ?? formatForeignRegion(absorbed.region, countryCode)
      : undefined,
    country: countryCode,
  };
}

function mergeAddressParts(input: Address): AddressParts {
  const inlineSource = input.street?.trim()
    ? input.street
    : input.full?.trim() && !looksFormattedAddressFull(input.full)
      ? input.full
      : undefined;
  const inline = inlineSource
    ? parseItalianInlineAddress(stripAddressLabelPrefix(inlineSource))
    : undefined;

  if (inline) return dedupeAddressParts(inline);

  const fromFull = input.full?.trim() ? parseAddressFull(stripAddressLabelPrefix(input.full)) : {};

  const inputStreet = input.street?.trim();
  const inputFull = input.full?.trim();
  const parsedFullStreet = fromFull.street?.trim();
  const preferParsedFullStreet = Boolean(
    parsedFullStreet &&
      inputFull &&
      (!inputStreet || isInvalidStreetName(inputStreet)) &&
      (fromFull.postalCode || fromFull.city) &&
      inputFull.includes(',')
  );
  const streetRaw = stripAddressLabelPrefix(
    preferParsedFullStreet
      ? parsedFullStreet!
      : inputStreet &&
      inputFull === inputStreet &&
      parsedFullStreet &&
      parsedFullStreet !== inputStreet
      ? parsedFullStreet
      : inputStreet ?? parsedFullStreet ?? ''
  );
  const split = streetRaw ? splitStreetAndCivic(streetRaw) : { streetName: '' };

  const fromStructured: AddressParts = dedupeAddressParts({
    street: split.streetName || streetRaw || undefined,
    civicNumber: input.civicNumber?.trim() || split.civic || fromFull.civicNumber,
    postalCode: input.postalCode?.trim() || fromFull.postalCode,
    city: input.city?.trim() || fromFull.city,
    region:
      input.region?.trim().replace(/[()]/g, '').toUpperCase() ||
      fromFull.region ||
      parseProvinceFromText(input.city ?? fromFull.city ?? ''),
    country: normalizeCountryCode(input.country) ?? fromFull.country ?? input.country?.trim(),
  });
  if (
    fromStructured.civicNumber &&
    fromStructured.postalCode &&
    fromStructured.civicNumber.replace(/\s+/g, '') ===
      fromStructured.postalCode.replace(/\s+/g, '') &&
    !new RegExp(
      `${CIVIC_LABEL_PATTERN}${fromStructured.civicNumber.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      )}\\b`,
      'i'
    ).test(`${input.street ?? ''} ${input.full ?? ''}`)
  ) {
    fromStructured.civicNumber = undefined;
  }
  if (
    fromStructured.street &&
    fromStructured.postalCode &&
    !new RegExp(
      `${CIVIC_LABEL_PATTERN}${fromStructured.postalCode.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      )}\\b`,
      'i'
    ).test(`${input.street ?? ''} ${input.full ?? ''}`)
  ) {
    const postalAtStreetEnd = new RegExp(
      `(?:,|\\s)\\s*${fromStructured.postalCode.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      )}\\s*$`
    );
    fromStructured.street = fromStructured.street
      .replace(postalAtStreetEnd, '')
      .replace(/,\s*$/, '')
      .trim();
  }

  if (isInvalidStreetName(fromStructured.street) && fromFull.street && !isInvalidStreetName(fromFull.street)) {
    fromStructured.street = fromFull.street;
    fromStructured.civicNumber = fromStructured.civicNumber || fromFull.civicNumber;
  }

  if (isInvalidStreetName(fromStructured.street) && input.full?.trim()) {
    const reparsed = parseAddressFull(stripAddressLabelPrefix(input.full));
    if (reparsed.street && !isInvalidStreetName(reparsed.street)) {
      fromStructured.street = reparsed.street;
      fromStructured.civicNumber = fromStructured.civicNumber || reparsed.civicNumber;
      fromStructured.postalCode = fromStructured.postalCode || reparsed.postalCode;
      fromStructured.city = fromStructured.city || reparsed.city;
      fromStructured.region = fromStructured.region || reparsed.region;
    }
  }

  if (fromStructured.street || fromStructured.city || fromStructured.postalCode) {
    return fromStructured;
  }

  if (input.full?.trim()) {
    return dedupeAddressParts(fromFull);
  }

  return fromStructured;
}

/**
 * Composizione uniforme:
 * - Italia: Via Nome, Nr. civico - CAP - Città - (PROV) - IT
 * - Estero: Via Nome, Nr. civico - CAP - Città - Regione - CC
 */
export function buildFormattedAddress(parts: AddressParts): Address | undefined {
  const deduped = dedupeAddressParts(parts);
  const countryCode = normalizeCountryCode(deduped.country);
  const isItaly = isLikelyItalianAddress(deduped, countryCode);

  const split = splitStreetAndCivic(deduped.street?.trim() ?? '');
  const civic = deduped.civicNumber?.trim() || split.civic;
  let streetLine = split.streetName ? formatStreetLine(split.streetName) : undefined;
  if (streetLine && civic) {
    streetLine = stripRedundantEdUnitFromStreet(streetLine, civic);
  }
  let city = deduped.city?.trim() ? formatCityName(deduped.city.trim()) : undefined;
  const postalCode = sanitizePostalCode(deduped.postalCode?.replace(/\s+/g, ' ').trim(), countryCode);

  let region: string | undefined;
  let country = countryCode;

  if (isItaly) {
    country = 'IT';
    region = resolveProvince(city, formatItalianProvince(deduped.region) ?? deduped.region);
  } else {
    region = formatForeignRegion(deduped.region, countryCode);
    if (!country && isLikelyItalianAddress(deduped, countryCode)) {
      country = 'IT';
      region = resolveProvince(city, deduped.region);
    }
  }

  const segments: string[] = [];
  if (streetLine) {
    const streetSeg =
      civic && !civicAlreadyInStreet(streetLine, civic) ? `${streetLine}, Nr. ${civic}` : streetLine;
    segments.push(streetSeg);
  }

  const cityBare = city?.replace(/\s*\([A-Z]{2}\)\s*$/i, '').trim();
  const provInCity = city?.match(/\(([A-Z]{2})\)/i)?.[1];
  const effectiveRegion = (region ?? provInCity)?.toUpperCase();
  const head = segments[0] ?? '';
  const cityInHead = cityBare ? cityAlreadyInText(head, cityBare) : false;
  const capInHead = postalCode ? head.includes(postalCode) : false;
  const provInHead = effectiveRegion
    ? new RegExp(`(?:\\(${effectiveRegion}\\)|\\b${effectiveRegion}\\b)`, 'i').test(head)
    : false;

  if (postalCode && !capInHead) {
    segments.push(postalCode);
  }
  if (cityBare && !cityInHead) {
    segments.push(cityBare);
  }
  if (effectiveRegion && !provInHead && !cityInHead) {
    const provSegment =
      isItaly || country === 'IT'
        ? formatItalianProvinceSegment(effectiveRegion)
        : effectiveRegion;
    if (provSegment) segments.push(provSegment);
  }

  const displayCc = displayCountry(country);
  if (displayCc && !segments.some((s) => /\b(?:IT|UK|US|DE|FR|CH|AT|ES|NL|BE|PT)\b/i.test(s))) {
    segments.push(displayCc);
  }

  const full = dedupeAddressFullString(collapseRedundantAddressSegments(segments).join(' - ')).trim();
  if (!full) return undefined;

  return {
    street: streetLine || undefined,
    civicNumber: civic || undefined,
    postalCode: postalCode || undefined,
    city: cityBare || city || undefined,
    region: effectiveRegion || region || undefined,
    country: displayCc || undefined,
    full,
  };
}

/** Normalizza lettura OCR, merge AI, modifica utente e salvataggio. */
export function normalizeAddress(input?: Address | null): Address | undefined {
  if (!input) return undefined;
  const full = input.full?.trim();
  if (
    full &&
    /\n/.test(full) &&
    /\b(?:head|daegu|main|branch|registered|corporate|sales|regional)\s+office\s*:/i.test(full)
  ) {
    return {
      ...input,
      full,
      country: input.country ?? (/\bkorea\b/i.test(full) ? 'KR' : input.country),
    };
  }
  const hasAny =
    Boolean(input.full?.trim()) ||
    Boolean(input.street?.trim()) ||
    Boolean(input.city?.trim()) ||
    Boolean(input.postalCode?.trim());
  if (!hasAny) return undefined;
  return buildFormattedAddress(mergeAddressParts(input));
}

/**
 * Test modalità best-effort con confidence per campo.
 * Uso: npx tsx scripts/test-confidence-extraction.mjs
 *
 * Metriche osservate (non confronto legacy):
 * - campi utili estratti
 * - campi marcati incerti (medium/low + reviewFields)
 * - errori gravi con confidence high (da ispezione manuale)
 */
import Module, { register } from 'node:module';

function uuidV4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const expoStub = { uuid: { v4: uuidV4 } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'expo-modules-core') return expoStub;
  if (request === 'react-native' || request.startsWith('react-native/')) return {};
  return originalLoad.apply(this, arguments);
};

const expoModulesCoreStub = `
export const uuid = {
  v4: () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    }),
};
`;

const loaderCode = `
const EXPO_SOURCE = ${JSON.stringify(expoModulesCoreStub)};
const RN_SOURCE = 'export default {}; export const Platform = { OS: "test" };';
function isExpo(u) { return u.includes('expo-modules-core'); }
function isRN(u) { return /[\\\\/]react-native[\\\\/]/.test(u) || u.endsWith('/react-native'); }
export async function load(url, context, nextLoad) {
  if (isExpo(url)) {
    return { format: 'module', source: EXPO_SOURCE, shortCircuit: true };
  }
  if (isRN(url)) {
    return { format: 'module', source: RN_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(loaderCode));

const { extractCardWithConfidence } = await import(
  '../lib/parser-engine/extract-card-with-confidence.ts'
);

function toLines(text) {
  return text.split('\n').map((t, i) => ({
    text: t.trim(),
    confidence: 0.9,
    boundingBox: { x: 0, y: i * 22, width: 100, height: 20 },
  }));
}

function toPages(texts) {
  return texts.map((rawText) => ({ lines: toLines(rawText), rawText }));
}

function fmtValue(field) {
  if (field.value == null) return '(null)';
  if (Array.isArray(field.value)) {
    if (!field.value.length) return '[]';
    if (typeof field.value[0] === 'string') return field.value.join(' | ');
    return field.value.map((p) => p.number).join(' | ');
  }
  if (typeof field.value === 'object') {
    const a = field.value;
    return a.full || [a.street, a.postalCode, a.city, a.province].filter(Boolean).join(', ') || JSON.stringify(a);
  }
  return String(field.value);
}

function printField(name, field) {
  const reasons = field.reasons.length ? field.reasons.slice(0, 3).join(' · ') : '-';
  console.log(
    `  ${name.padEnd(11)} [${field.confidence.toUpperCase().padEnd(6)} score=${field.score.toFixed(2)} src=${field.source}]`
  );
  console.log(`             value: ${fmtValue(field)}`);
  console.log(`             reasons: ${reasons}`);
}

function runCase(label, pageTexts) {
  const result = extractCardWithConfidence(toPages(pageTexts));
  console.log('\n' + '='.repeat(72));
  console.log(`CASO: ${label}`);
  console.log('='.repeat(72));
  printField('firstName', result.firstName);
  printField('lastName', result.lastName);
  printField('company', result.company);
  printField('role', result.role);
  printField('emails', result.emails);
  printField('phones', result.phones);
  printField('website', result.website);
  printField('address', result.address);
  printField('vatNumber', result.vatNumber);
  printField('taxCode', result.taxCode);
  console.log(`  needsReview: ${result.needsReview}`);
  console.log(`  reviewFields: ${result.reviewFields.length ? result.reviewFields.join(', ') : '(nessuno)'}`);
  return result;
}

// --- 10 casi diversi (corpus OCR esistente, non ottimizzati per legacy) ---

const CASES = [
  {
    label: '1. GIVI — fronte+retro classico',
    pages: [
      `GIVI
MARIO FRATI
Responsabile
Ufficio Comunicazione
0039.030.2686927
m.frati@givi.it`,
      `GIVI srl
Via S. Quasimodo, 45
25020 FLERO (BS) ITALY
info@givi.it
www.givimoto.com
T 0039.030.3581253
F 0039.030.3583723
C. F. e P. IVA 01384670178`,
    ],
  },
  {
    label: '2. GARBIN — OCR reale degradato',
    pages: [
      `GARBIN
MAULE
&M
COMMERCIALISTI
ASS OCIA TI
Dottore Commercialista e Revisore Contabile
Michela Maule
garbinmaule@garbinmaule.it
www.garbinmaule.it
T +39 0444 123456`,
      `GARBIN MAULE & M COMMERCIALISTI ASSOCIATI
Via Roma 1
36100 Vicenza (VI)
P.IVA 02700130244`,
    ],
  },
  {
    label: '3. WISE — slogan fronte + S.r.l. retro',
    pages: [
      `Wise
Ingegneria e Soluzioni
PER L'IMPRESA
MES & WMS
Software Solutions Manager
Marco Rossi
marco.rossi@wise.it`,
      `Wise Ingegneria e Soluzioni Software S.r.l.
Via dell'Industria 12
37036 San Martino Buon Albergo (VR)
P.IVA 12345678901`,
    ],
  },
  {
    label: '4. KBLUE — attività ≠ azienda, email dominio',
    pages: [
      `KBLUE
Consulenza informatica
Andrea Bianchi
andrea@kblue.it
+39 02 1234567
www.kblue.it`,
    ],
  },
  {
    label: '5. CEREAL DOCKS — nome grande + attività',
    pages: [
      `CEREAL DOCKS
Agricoltura, Alimentazione, Ambiente
Andrea Zanuso
andreazanuso@cerealdocks.com
+39 0445 315055`,
    ],
  },
  {
    label: '6. Bellotto — senza nome persona',
    pages: [
      `ABellotto
SERRAMENTI& COMPONENTI
Porte per interni
info@bellotto.it
www.bellotto.it`,
    ],
  },
  {
    label: '7. Arredamenti Bussola — brand+descrittore',
    pages: [
      `arredamenti la bussola
PROGETTAZIONE D'INTERNI
Via Garibaldi 10
35010 Limena (PD)
info@labussola.it`,
    ],
  },
  {
    label: '8. Dal Zotto — titolare in ragione sociale',
    pages: [
      `Dal Zotto Silvano
Falegnameria
Via Castellana 22
31030 Carbonera (TV)
dalzottosilvano@libero.it`,
    ],
  },
  {
    label: '9. D.F. INTERNI — connettivo OCR spezzato',
    pages: [
      `D.F. INTERNI
d
Arredamento su misura
Paolo Ferro
paolo.ferro@dfinterni.it`,
    ],
  },
  {
    label: '10. LCS — persona sopra ragione sociale',
    pages: [
      `Laura Colombo
LCS S.p.A.
Sales Manager
laura.colombo@lcsgroup.it
www.lcsgroup.it`,
    ],
  },
];

const results = CASES.map((c) => runCase(c.label, c.pages));

// --- Riepilogo metriche ---
console.log('\n' + '#'.repeat(72));
console.log('RIEPILOGO METRICHE CONFIDENCE');
console.log('#'.repeat(72));

const fieldKeys = [
  'firstName',
  'lastName',
  'company',
  'role',
  'emails',
  'phones',
  'website',
  'address',
  'vatNumber',
  'taxCode',
];

let usefulFields = 0;
let totalFields = 0;
let lowOrMedium = 0;
let highWithValue = 0;
const highFields = [];
const mediumFields = [];
const lowFields = [];

for (let i = 0; i < results.length; i++) {
  const result = results[i];
  const caseLabel = CASES[i].label;
  for (const key of fieldKeys) {
    totalFields++;
    const field = result[key];
    const hasValue =
      field.value != null &&
      !(Array.isArray(field.value) && field.value.length === 0) &&
      field.value !== '';
    if (hasValue) usefulFields++;
    if (hasValue && field.confidence !== 'high') lowOrMedium++;
    if (hasValue && field.confidence === 'high') {
      highWithValue++;
      highFields.push({ case: caseLabel, key, value: fmtValue(field) });
    }
    if (hasValue && field.confidence === 'medium') {
      mediumFields.push({ case: caseLabel, key, value: fmtValue(field) });
    }
    if (hasValue && field.confidence === 'low') {
      lowFields.push({ case: caseLabel, key, value: fmtValue(field) });
    }
  }
}

const reviewCount = results.filter((r) => r.needsReview).length;
const reviewFieldTotal = results.reduce((n, r) => n + r.reviewFields.length, 0);

console.log(`Casi analizzati:              ${results.length}`);
console.log(`Campi utili estratti:         ${usefulFields} / ${totalFields} slot`);
console.log(`Campi utili non-high:         ${lowOrMedium} (medium/low → da rivedere)`);
console.log(`Campi high con valore:        ${highWithValue}`);
console.log(`Casi con needsReview:         ${reviewCount} / ${results.length}`);
console.log(`Totale campi in reviewFields: ${reviewFieldTotal}`);

console.log('\nEsempi HIGH (caso · campo · valore):');
for (const item of highFields.slice(0, 8)) {
  console.log(`  - ${item.case} · ${item.key}: ${item.value}`);
}
if (highFields.length > 8) console.log(`  ... +${highFields.length - 8} altri`);

console.log('\nEsempi MEDIUM:');
for (const item of mediumFields.slice(0, 6)) {
  console.log(`  - ${item.case} · ${item.key}: ${item.value}`);
}

console.log('\nEsempi LOW (con valore):');
for (const item of lowFields.slice(0, 6)) {
  console.log(`  - ${item.case} · ${item.key}: ${item.value}`);
}

console.log('\nDone.');

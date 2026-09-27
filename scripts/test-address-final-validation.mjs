/**
 * Validazione finale indirizzo — blocca testo spazzatura OCR.
 * Uso: npx tsx scripts/test-address-final-validation.mjs
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

const { validateFinalAddress } = await import('../lib/parser-engine/validators/address.ts');
const { parseCardFromPages } = await import('../lib/parser-engine/pipeline.ts');
const { extractCardWithConfidence } = await import(
  '../lib/parser-engine/extract-card-with-confidence.ts'
);

const ICT_GARBAGE_OCR = `--- ICT GROUP
S.r.l.
Bictgroup Software | Technology | Innovation
Andrea Frosini
Sales Area Manager
+39 3357750826
www.ict-group.it
andrea.frosini@ict-group.it`;

function addr(full) {
  return validateFinalAddress({ full });
}

function fmtAddress(value) {
  if (!value) return '(vuoto)';
  return value.full ?? [value.street, value.postalCode, value.city, value.region].filter(Boolean).join(', ');
}

function check(label, actual, expectedEmpty) {
  const empty = actual == null;
  const ok = expectedEmpty ? empty : !empty;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}: ${expectedEmpty ? '(vuoto)' : fmtAddress(actual)}`);
  return ok;
}

let passed = 0;
let total = 0;

console.log('='.repeat(72));
console.log('VALIDAZIONE FINALE ADDRESS');
console.log('='.repeat(72));

const directTests = [
  [
    '1. testo spazzatura ICT',
    addr(
      'Bictgroup Software | Technology | Innovation Andrea Frosini Sales Area Manager +39 3357750826'
    ),
    true,
  ],
  [
    '2. Via Cavallotti, 8 + 42122 Reggio Emilia (RE)',
    addr('Via Cavallotti, 8 - 42122 Reggio Emilia (RE)'),
    false,
  ],
  [
    '3. 42122 Reggio Emilia (RE) Via Cavallotti, 8',
    addr('42122 Reggio Emilia (RE) - Via Cavallotti, 8'),
    false,
  ],
  ['4. Software Technology Innovation', addr('Software Technology Innovation'), true],
  [
    '5. Andrea Frosini Sales Area Manager + telefono',
    addr('Andrea Frosini Sales Area Manager +39 3357750826'),
    true,
  ],
  [
    '6. Via Pozzati - 36014 Santorso (VI)',
    addr('Via Pozzati - 36014 Santorso (VI)'),
    false,
  ],
  ['7. www.ict-group.it', addr('www.ict-group.it'), true],
  ['ICT GROUP', addr('ICT GROUP'), true],
  ['solo telefono', addr('+39 3357750826'), true],
];

for (const [label, result, expectedEmpty] of directTests) {
  total += 1;
  if (check(label, result, expectedEmpty)) passed += 1;
}

const pages = [
  {
    lines: ICT_GARBAGE_OCR.split('\n').map((text, i) => ({
      text: text.trim(),
      confidence: 0.9,
      boundingBox: { x: 0, y: i * 20, width: 100, height: 18 },
    })),
    rawText: ICT_GARBAGE_OCR,
  },
];

const parsed = parseCardFromPages(pages);
const confidence = extractCardWithConfidence(pages);

total += 1;
if (check('8. pipeline ICT garbage → address vuoto', parsed.address ?? null, true)) passed += 1;

total += 1;
if (
  check(
    '9. confidence ICT garbage → address vuoto',
    confidence.address.value,
    true
  )
) {
  passed += 1;
}

console.log('\n' + '#'.repeat(72));
console.log(`RISULTATO: ${passed}/${total} PASS`);
console.log('#'.repeat(72));

process.exit(passed === total ? 0 : 1);

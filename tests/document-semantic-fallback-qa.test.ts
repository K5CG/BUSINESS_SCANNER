import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildSemanticFallbackExtraction,
  extractSemanticDocumentSnapshot,
  extractStrongDocumentNumber,
  findClientBlockCustomer,
  findSemanticDocumentTotals,
} from '../lib/document-semantic-fallback';
import { inferCanonicalDocumentType } from '../lib/document-label-dictionary';

const qaRoot = path.join(process.cwd(), 'test-data', 'qa-export-2026-08-08-real-full', 'raw-text');

const FIXTURES = {
  motorparts: 'a13fa9a4-b89f-48df-9f51-8a3d48d5d318',
  northbridge: '28ff5440-74cf-4c9d-8637-dfb664ddc02e',
  rheinwerk: '960e93ce-0385-4c6a-b6f1-a67440d1ccbf',
  enersoluciones: '7b8fc549-4ed2-474d-b020-82fc4f7a241c',
  thermoflux: '21359f33-28de-4232-8e9e-105e99635468',
} as const;

function loadRaw(id: string): { rawText: string; lines: string[] } {
  const rawText = fs.readFileSync(path.join(qaRoot, `${id}.txt`), 'utf8')
    .replace(/^=== PAGE[^\n]*\n/gm, '');
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { rawText, lines };
}

function assertField(actual: unknown, expected: unknown, label: string): void {
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

test('Motorparts semantic fallback prefers 2025/0874 over CUK-26', () => {
  const { rawText, lines } = loadRaw(FIXTURES.motorparts);
  const number = extractStrongDocumentNumber(rawText, lines);
  assert.equal(number, '2025/0874');
  assert.notEqual(number, 'CUK-26');
});

test('Motorparts semantic snapshot totals and customer', () => {
  const { rawText, lines } = loadRaw(FIXTURES.motorparts);
  const snapshot = extractSemanticDocumentSnapshot('order', rawText, lines);
  assertField(snapshot.documentType, 'order', 'type');
  assertField(snapshot.documentNumber, '2025/0874', 'number');
  assert.match(snapshot.customer ?? '', /Autofficina Chiozza Service/i);
  assertField(snapshot.vat, 133.86, 'VAT');
  assertField(snapshot.total, 742.32, 'total');
});

test('Northbridge semantic fallback keeps full quotation number', () => {
  const { rawText, lines } = loadRaw(FIXTURES.northbridge);
  const number = extractStrongDocumentNumber(rawText, lines);
  assert.match(number ?? '', /^OTN-\d{2}-\d{4}$/);
  assert.notEqual(number, 'OTN-24');
  assert.notEqual(number, 'OTN-26');
});

test('Northbridge semantic snapshot totals and customer', () => {
  const { rawText, lines } = loadRaw(FIXTURES.northbridge);
  const snapshot = extractSemanticDocumentSnapshot('quote', rawText, lines);
  assertField(snapshot.documentType, 'quote', 'type');
  assert.match(snapshot.documentNumber ?? '', /^OTN-\d{2}-\d{4}$/);
  assert.match(snapshot.customer ?? '', /Institute of Marine Geoscience Research/i);
  assertField(snapshot.vat, 4543.5, 'VAT');
  assertField(snapshot.total, 27261, 'total');
  assertField(snapshot.currency, 'GBP', 'currency');
});

test('Rheinwerk semantic fallback keeps full Angebotsnummer and quote hint', () => {
  const { rawText, lines } = loadRaw(FIXTURES.rheinwerk);
  const number = extractStrongDocumentNumber(rawText, lines);
  assert.equal(number, 'AN-2025-0457');
  const fallback = buildSemanticFallbackExtraction('invoice', rawText, lines, 'structured_layout_timeout');
  const inferred = inferCanonicalDocumentType(rawText.slice(0, 1200));
  assert.ok(inferred?.type === 'quotation' || fallback.reasons.includes('semantic_fallback_applied'));
});

test('Rheinwerk semantic snapshot totals and customer', () => {
  const { rawText, lines } = loadRaw(FIXTURES.rheinwerk);
  const snapshot = extractSemanticDocumentSnapshot('quote', rawText, lines);
  assertField(snapshot.documentNumber, 'AN-2025-0457', 'number');
  assert.match(snapshot.customer ?? '', /Bergmann Verpackungstechnik AG/i);
  assertField(snapshot.subtotal, 1783.5, 'net');
  assertField(snapshot.vat, 338.87, 'VAT');
  assertField(snapshot.total, 2122.37, 'total');
  assertField(snapshot.currency, 'EUR', 'currency');
});

test('EnerSoluciones semantic fallback prefers PRES-2025 over registry A-123456', () => {
  const { rawText, lines } = loadRaw(FIXTURES.enersoluciones);
  const number = extractStrongDocumentNumber(rawText, lines);
  assert.match(number ?? '', /^PRES-2025[./-]0478$/);
  assert.notEqual(number, 'A-123456');
});

test('EnerSoluciones semantic snapshot totals and customer', () => {
  const { rawText, lines } = loadRaw(FIXTURES.enersoluciones);
  const snapshot = extractSemanticDocumentSnapshot('quote', rawText, lines);
  assert.match(snapshot.documentNumber ?? '', /^PRES-2025[./-]0478$/);
  assert.match(snapshot.customer ?? '', /Comunidad Residencial Mirador del Mar/i);
  assertField(snapshot.subtotal, 9090, 'net');
  assertField(snapshot.vat, 1908.9, 'VAT');
  assertField(snapshot.total, 10998.9, 'total');
  assertField(snapshot.currency, 'EUR', 'currency');
});

test('ThermoFlux semantic fallback keeps DEV-2025-0612 from page 1', () => {
  const { rawText, lines } = loadRaw(FIXTURES.thermoflux);
  const number = extractStrongDocumentNumber(rawText, lines);
  assert.equal(number, 'DEV-2025-0612');
});

test('ThermoFlux semantic fallback maps document totals and full customer', () => {
  const { rawText, lines } = loadRaw(FIXTURES.thermoflux);
  const fallback = buildSemanticFallbackExtraction('quote', rawText, lines, 'structured_layout_timeout');
  const subtotal = fallback.summary.subtotal?.normalizedValue;
  const vat = fallback.summary.vatAmount?.normalizedValue;
  const total = fallback.summary.total?.normalizedValue;
  assert.equal(subtotal, 39649);
  assert.equal(vat, 7929.8);
  assert.equal(total, 47578.8);
  const customer = fallback.customer?.name?.normalizedValue ?? findClientBlockCustomer(lines);
  assert.match(customer ?? '', /Domaine Viticole des Hautes Collines/i);
  assert.match(fallback.issuer?.name?.normalizedValue ?? '', /ThermoFlux Industrie SAS/i);
});

test('ThermoFlux page subtotals do not override document-level totals', () => {
  const { lines } = loadRaw(FIXTURES.thermoflux);
  const totals = findSemanticDocumentTotals(lines);
  assert.notEqual(totals.subtotal, 9465.5);
  assert.notEqual(totals.subtotal, 30183.5);
  assert.equal(totals.subtotal, 39649);
  assert.equal(totals.vat, 7929.8);
  assert.equal(totals.total, 47578.8);
});

test('semantic label association: TOTAL HT → net, TVA → VAT, TOTAL TTC → grand total', () => {
  const sample = [
    '9 465,50€',
    'Sous-total page 2',
    '39 649,00€',
    'TOTAL HT',
    '7 929.80€',
    'TVA 20%',
    '47 578,80 €',
    'TOTAL TTC',
  ];
  const totals = findSemanticDocumentTotals(sample);
  assert.equal(totals.subtotal, 39649);
  assert.equal(totals.vat, 7929.8);
  assert.equal(totals.total, 47578.8);
});

test('semantic label association: label-before-amount order still resolves', () => {
  const sample = [
    'TOTAL HT',
    '39 649,00€',
    'TVA 20%',
    '7 929.80€',
    'TOTAL TTC',
    '47 578,80 €',
  ];
  const totals = findSemanticDocumentTotals(sample);
  assert.equal(totals.subtotal, 39649);
  assert.equal(totals.vat, 7929.8);
  assert.equal(totals.total, 47578.8);
});

test('full customer name preserved after CLIENT label', () => {
  const sample = [
    'CLIENT',
    'CUE',
    'Domaine Viticole des Hautes Collines',
    'À lattention de :',
    'Mne Claire Bernard',
  ];
  assert.equal(findClientBlockCustomer(sample), 'Domaine Viticole des Hautes Collines');
});

test('semantic fallback timing stays under hard budget on ThermoFlux', () => {
  const { rawText, lines } = loadRaw(FIXTURES.thermoflux);
  const snapshot = extractSemanticDocumentSnapshot('quote', rawText, lines);
  assert.ok(snapshot.elapsedMs < 300, `semantic fallback too slow: ${snapshot.elapsedMs}ms`);
});

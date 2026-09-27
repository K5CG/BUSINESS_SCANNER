import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractCardV5 } from '../lib/parser-v5/engine';
import { pickBestFuzzyCompanyLineFromOcr } from '../lib/parser-v5/company-normalize';
import { finalizeCompanyValue } from '../lib/parser-v5/finalize';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

test('camera retry: boundary ambiguo non scarta lo scatto e non mostra alert di reinquadratura', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /physical_boundary_fallback_overlay/);
  assert.doesNotMatch(scanner, /Scansione da ripetere[\s\S]{0,300}bordo fisico/);
});

test('camera retry: maxZoomRatio transitorio <=1 non azzera un piano zoom gia risolto', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /currentPlan\.effectiveMagnification > 1/);
  assert.match(scanner, /maxZoomRatio == null \|\| maxZoomRatio <= 1/);
  assert.match(scanner, /setCameraZoom\(currentPlan\.appliedZoomValue\)/);
});

test('company: punto finale di sigla puntata prima della forma legale non diventa virgola', () => {
  const page: any = {
    rawText: 'DANTE CHIERICO\nPERITO INDUSTRIALE\nS.A. GE. MA, s.n.c.',
    lines: [
      'DANTE CHIERICO',
      'PERITO INDUSTRIALE',
      'S.A. GE. MA, s.n.c.',
    ].map((text, i) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + i * 30, width: 220, height: 24 },
    })),
  };
  const result = extractCardV5([page]);
  assert.ok(result.company.value);
  assert.doesNotMatch(result.company.value ?? '', /MA\s*,\s*S\.n\.c/i);
  assert.match(result.company.value ?? '', /MA\.\s*S\.n\.c/i);
});

test("company: brand OCR multi-parola recupera solo residuo corto osservabile dal dominio", () => {
  const raw = "www.lmexhaustsystem.it\ninfo@Imexhaustsystem.it\nEXHAUST SYSTÃˆM\nMOSCATELLI LUCA\nPARTI SPECIALI RACING";
  const page: any = {
    rawText: raw,
    lines: raw.split("\\n").map((text, i) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + i * 30, width: 260, height: 24 },
    })),
  };
  const result = extractCardV5([page]);
  assert.match(result.company.value ?? "", /^LM\s+Exhaust\s+System$/i);
});

test("company: dominio con residuo lungo non inventa un prefisso nel brand OCR", () => {
  const raw = "www.longprefixalphasystem.it\ninfo@longprefixalphasystem.it\nALPHA SYSTEM\nMarco Bianchi\nSales Manager";
  const page: any = {
    rawText: raw,
    lines: raw.split("\\n").map((text, i) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + i * 30, width: 260, height: 24 },
    })),
  };
  const result = extractCardV5([page]);
  assert.doesNotMatch(result.company.value ?? "", /^LONGPREFIX\s+/i);
});


test('company helper: OCR sporco + sito coerente ricostruisce il brand', function () {
  const raw = fs.readFileSync('tests/fixtures/replay-audit-70/raw-text/5af3896f-b529-4f8a-a9f7-b164f5935e8f.txt', 'utf8');
  const result = pickBestFuzzyCompanyLineFromOcr(raw, ['info@Imexhaustsystem.it'], ['www.lmexhaustsystem.it']);
  assert.match(result ?? '', /LM\s+Exhaust\s+System$/i);
});





test('company: riga descrittiva con copula non sostituisce intestazione osservata', () => {
  const raw = 'www.novadesignschool.com\nNova Design School is a department\nNova Design School\nMarco Rossi\nDirector';
  const page: any = {
    rawText: raw,
    lines: raw.split('\\n').map((text, i) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + i * 30, width: 260, height: 24 },
    })),
  };
  const result = extractCardV5([page]);
  assert.doesNotMatch(result.company.value ?? '', /is a department/i);
  assert.match(result.company.value ?? '', /Nova Design School/i);
});


test('company: punteggiatura terminale OCR non nasconde un brand maiuscolo osservato', () => {
  const raw = '2HOPI\nMOTOTECNICA,\nPaolo Coletto\nSales Manager\nVia Pontarola, 6\n35011 Campodarsego Pd';
  const page: any = {
    rawText: raw,
    lines: raw.split('\n').map((text, i) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + i * 30, width: 260, height: 24 },
    })),
  };
  const result = extractCardV5([page]);
  assert.match(result.company.value ?? '', /^Mototecnica$/i);
  assert.doesNotMatch(result.company.value ?? '', /\bShop\b/i);
});

test('company: brand pulito + riga fiscale OCR quasi uguale conserva il brand e aggiunge la forma legale', () => {
  const raw = [
    'OrientaForm',
    'formazione@orientaform.it',
    'www.orientaform.it',
    'Formazione e Orientamento',
    'OrientoForm snc CF /PNA 03674360247 Loc Ponte d oro 8/E Schio (VI)',
  ].join('\n');
  const page: any = {
    rawText: raw,
    lines: raw.split('\n').map((text, i) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + i * 30, width: 320, height: 24 },
    })),
  };
  const result = extractCardV5([page]);
  assert.match(result.company.value ?? '', /^OrientaForm\s+S\.?n\.?c\.?$/i);
  assert.doesNotMatch(result.company.value ?? '', /^OrientoForm/i);
});

test('company: dominio corroborato da sito + una email prevale su una seconda email OCR discordante', () => {
  const raw = [
    'Potonio Gaboardk',
    'Senior Partner',
    'agaboardi@thenissoluzioni it',
    'www themissoluzioni it',
    'info@ themissoluzioni it',
  ].join('\n');
  const page: any = {
    rawText: raw,
    lines: raw.split('\n').map((text, i) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + i * 30, width: 320, height: 24 },
    })),
  };
  const result = extractCardV5([page]);
  assert.match(result.company.value ?? '', /^Themis\s+Soluzioni$/i);
});

test('address: uia + I/l/| come civico viene riparato solo con forte struttura CAP-citta-provincia', () => {
  const raw = [
    'Antonio Gaboardi',
    'Senior Partner',
    'uia F Lana l- 25020 Flero (Bs)',
    'info@themissoluzioni.it',
    'www.themissoluzioni.it',
  ].join('\n');
  const page: any = {
    rawText: raw,
    lines: raw.split('\n').map((text, i) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + i * 30, width: 320, height: 24 },
    })),
  };
  const result = extractCardV5([page]);
  assert.match(result.address.value?.street ?? '', /^Via\s+F\s+Lana$/i);
  assert.equal(result.address.value?.civicNumber, '1');
  assert.equal(result.address.value?.postalCode, '25020');
  assert.match(result.address.value?.city ?? '', /^Flero$/i);
});


test('real-class regression: dotted acronym before legal suffix canonicalizes OCR comma', () => {
  const raw = ['Dante Chierico','PERITO INDUSTRIALE','S. A.GE. MA, s. n.c.','Telefono (0445) 671155'].join('\n');
  const page: any = { rawText: raw, lines: raw.split('\n').map((text, i) => ({ text, confidence: 0.96, boundingBox: { x: 10, y: 20 + i * 30, width: 320, height: 24 } })) };
  const result = extractCardV5([page]);
  assert.equal(result.company.value, 'S.A.GE.MA. S.n.c.');
  assert.ok((result.phones.value ?? []).some((phone: any) => phone.number === '0445 671155'));
});

test('real-class regression: observed standalone brand can beat a longer email-domain root', () => {
  const raw = ['Filippo Faccin','Tel_0445.51 2.360','cell_345.004,53,48','f.faccin@intercasanet.it','intercasa'].join('\n');
  const page: any = { rawText: raw, lines: raw.split('\n').map((text, i) => ({ text, confidence: 0.96, boundingBox: { x: 10, y: 20 + i * 30, width: 320, height: 24 } })) };
  const result = extractCardV5([page]);
  assert.equal(result.company.value, 'Intercasa');
  const phones = (result.phones.value ?? []).map((phone: any) => phone.number);
  assert.ok(phones.includes('0445 51 2 360'));
  assert.ok(phones.includes('345 004 53 48'));
});

test('real-class regression: formatting-only email repair remains usable and fragmented activity is not a role', () => {
  const raw = ['bNOA','CONSU LT IN G','Stefano Celati','+39 340 9733823','stefano.celati@ bnova.it','www.bnova.it'].join('\n');
  const page: any = { rawText: raw, lines: raw.split('\n').map((text, i) => ({ text, confidence: 0.96, boundingBox: { x: 10, y: 20 + i * 30, width: 320, height: 24 } })) };
  const result = extractCardV5([page]);
  assert.ok((result.emails.value ?? []).includes('stefano.celati@bnova.it'));
  assert.equal(result.role.value, null);
});

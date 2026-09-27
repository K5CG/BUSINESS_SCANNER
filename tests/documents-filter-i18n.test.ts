import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function loadLocale(code: string): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'i18n', `${code}.json`), 'utf8')
  ) as Record<string, string>;
}

const en = loadLocale('en');
const it = loadLocale('it');

const FILTER_KEYS = [
  'documentsFilterAll',
  'documentsFilterQuote',
  'documentsFilterOrder',
  'documentsFilterInvoice',
  'documentsFilterFreeDocument',
] as const;

/** Abbreviazioni italiane che non devono comparire nella lingua inglese. */
const ITALIAN_ABBREVIATIONS = ['Tutti', 'Prev.', 'Ord.', 'Fatt.', 'Doc.'];

test('le etichette inglesi dei filtri non contengono abbreviazioni italiane', () => {
  for (const key of FILTER_KEYS) {
    const label = en[key];
    assert.ok(label, `chiave mancante in en.json: ${key}`);
    for (const abbreviation of ITALIAN_ABBREVIATIONS) {
      assert.notEqual(
        label,
        abbreviation,
        `etichetta italiana "${abbreviation}" usata in inglese per ${key}`
      );
    }
  }
});

test('le etichette inglesi dei filtri sono quelle attese', () => {
  assert.equal(en.documentsFilterAll, 'All');
  assert.equal(en.documentsFilterQuote, 'Quotes');
  assert.equal(en.documentsFilterOrder, 'Orders');
  assert.equal(en.documentsFilterInvoice, 'Invoices');
  assert.equal(en.documentsFilterFreeDocument, 'Documents');
});

test('le etichette italiane dei filtri restano invariate', () => {
  assert.equal(it.documentsFilterAll, 'Tutti');
  assert.equal(it.documentsFilterQuote, 'Prev.');
  assert.equal(it.documentsFilterOrder, 'Ord.');
  assert.equal(it.documentsFilterInvoice, 'Fatt.');
  assert.equal(it.documentsFilterFreeDocument, 'Doc.');
});

test('nessuna etichetta mostra la chiave di traduzione grezza', () => {
  for (const key of FILTER_KEYS) {
    for (const [locale, bundle] of Object.entries({ en, it })) {
      const label = bundle[key];
      assert.notEqual(label, key, `${locale} mostra la chiave grezza ${key}`);
      assert.doesNotMatch(
        label,
        /^documents[A-Z]/,
        `${locale} mostra una chiave non tradotta per ${key}`
      );
    }
  }
});

test('la schermata Documenti risolve i filtri tramite i18n', () => {
  const screen = fs.readFileSync(
    path.join(process.cwd(), 'app', '(tabs)', 'documents.tsx'),
    'utf8'
  );
  for (const key of FILTER_KEYS) {
    assert.ok(
      screen.includes(`'${key}'`),
      `la schermata non usa la chiave i18n ${key}`
    );
  }
  // Nessuna etichetta letterale né condizione sulla lingua nel componente.
  assert.doesNotMatch(screen, /['"]Fatt\.['"]|['"]Prev\.['"]|['"]Ord\.['"]/);
  assert.doesNotMatch(screen, /language === ['"](it|en)['"]/);
});

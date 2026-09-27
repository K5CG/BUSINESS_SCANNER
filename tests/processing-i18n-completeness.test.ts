import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function loadLocale(code: string): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'i18n', `${code}.json`), 'utf8'),
  ) as Record<string, string>;
}

const it = loadLocale('it');
const en = loadLocale('en');
const fr = loadLocale('fr');
const de = loadLocale('de');
const es = loadLocale('es');

const BASE = it as Record<string, string>;
const LOCALES: Record<string, Record<string, string>> = { it, en, fr, de, es };

const PROCESSING_KEYS = Object.keys(BASE).filter((key) => key.startsWith('processing.'));

test('processing i18n keys exist in IT EN FR DE ES', () => {
  for (const key of PROCESSING_KEYS) {
    for (const [locale, bundle] of Object.entries(LOCALES)) {
      assert.ok(bundle[key], `missing ${key} in ${locale}`);
    }
  }
});

test('processing.ocrPage includes page interpolation placeholders', () => {
  for (const bundle of Object.values(LOCALES)) {
    assert.match(bundle['processing.ocrPage'], /\{\{current\}\}/);
    assert.match(bundle['processing.ocrPage'], /\{\{total\}\}/);
  }
});

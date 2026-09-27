import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('il wordmark resta originale in light mode e visibile in dark mode', () => {
  const logo = read('components/BusinessScannerLogo.tsx');
  assert.match(logo, /useIsDarkMode\(\)/);
  assert.match(logo, /LIGHT_LOGO[^\n]+logo-wordmark\.png/);
  assert.match(logo, /DARK_LOGO[^\n]+logo-wordmark-dark\.png/);
  assert.match(logo, /source=\{isDarkMode \? DARK_LOGO : LIGHT_LOGO\}/);
  assert.doesNotMatch(logo, /tintColor=/);
});

test('il selettore tema offre Sistema, Chiaro e Scuro con persistenza', () => {
  const picker = read('components/ThemePicker.tsx');
  const provider = read('components/ThemePreferenceProvider.tsx');
  const prefs = read('lib/theme-prefs.ts');
  assert.match(picker, /value: 'system'/);
  assert.match(picker, /value: 'light'/);
  assert.match(picker, /value: 'dark'/);
  assert.match(prefs, /DEFAULT_THEME_PREFERENCE: ThemePreference = 'system'/);
  assert.match(prefs, /theme-preference\.txt/);
  assert.match(prefs, /readAsStringAsync/);
  assert.match(prefs, /writeAsStringAsync/);
  assert.match(provider, /getSavedThemePreference\(\)/);
  assert.match(provider, /saveThemePreference\(nextPreference\)/);
});

test('Sistema segue il telefono e il cambio forzato avviene senza riavvio', () => {
  const provider = read('components/ThemePreferenceProvider.tsx');
  assert.match(provider, /preference === 'system' \? null : preference/);
  assert.match(provider, /Appearance\.setColorScheme/);
  assert.match(
    provider,
    /setPreferenceState\(nextPreference\);[\s\S]*applyThemePreference\(nextPreference\);[\s\S]*await saveThemePreference/,
  );
  assert.doesNotMatch(provider, /reload|restart|Updates\.reloadAsync/);
});

test('il selettore Home è simmetrico alla lingua, responsive e accessibile', () => {
  const home = read('app/(tabs)/index.tsx');
  const picker = read('components/ThemePicker.tsx');
  assert.match(home, /<ThemePicker \/>[\s\S]*<LanguagePicker \/>/);
  assert.match(home, /justifyContent: 'space-between'/);
  assert.match(picker, /accessibilityLabel=\{t\('themeSelectorLabel'\)\}/);
  assert.match(picker, /accessibilityHint=\{t\('themeSelectorHint'\)\}/);
  assert.match(picker, /accessibilityRole="radio"/);
  assert.match(picker, /accessibilityHint=\{t\(hintKey\)\}/);
  assert.match(picker, /minWidth: 44/);
  assert.match(picker, /minHeight: 44/);
  assert.match(picker, /top: insets\.top \+ 36/);
  assert.match(picker, /maxWidth: '80%'/);
});

test('italiano e inglese localizzano tutte le opzioni tema', () => {
  for (const locale of ['it', 'en']) {
    const translations = JSON.parse(read(`i18n/${locale}.json`)) as Record<string, string>;
    for (const key of [
      'themeSelectorLabel',
      'themeSelectorHint',
      'themeSystem',
      'themeSystemHint',
      'themeLight',
      'themeLightHint',
      'themeDark',
      'themeDarkHint',
    ]) {
      assert.ok(translations[key], `${locale}: ${key}`);
    }
  }
});

test('ogni tab usa una vera icona vettoriale con stato attivo e inattivo', () => {
  const tabs = read('app/(tabs)/_layout.tsx');
  assert.match(tabs, /import \{ Ionicons \} from '@expo\/vector-icons'/);
  for (const icon of ['home', 'people', 'documents']) {
    assert.match(tabs, new RegExp(`focused \\? '${icon}' : '${icon}-outline'`));
  }
  assert.equal((tabs.match(/tabBarIcon:/g) ?? []).length, 3);
  assert.equal((tabs.match(/tabBarAccessibilityLabel:/g) ?? []).length, 3);
});

test('tab e schermate usano la palette adattiva', () => {
  const tabs = read('app/(tabs)/_layout.tsx');
  assert.match(tabs, /useUiPalette\(\)/);
  assert.match(tabs, /backgroundColor: palette\.surface/);
  assert.match(tabs, /sceneStyle: \{ backgroundColor: palette\.background \}/);
});

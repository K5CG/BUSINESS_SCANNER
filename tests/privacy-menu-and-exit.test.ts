import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FALLBACK_PRIVACY_POLICY_URL } from '../lib/privacy-config.ts';
import { exitAppSessionSideEffects } from '../lib/app-exit-policy.ts';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const PRODUCTION_DIRS = ['app', 'components', 'lib'];
const SKIP_DIR = new Set(['.backup-worktrees']);

function listProductionTsFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    if (SKIP_DIR.has(path.basename(dir))) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry.name) && !/backup/i.test(entry.name)) files.push(full);
    }
  }
  for (const dir of PRODUCTION_DIRS) {
    walk(path.join(root, dir));
  }
  return files;
}

test('permanent Privacy entry is on Home with IT/EN labels', () => {
  const home = read('app/(tabs)/index.tsx');
  const it = JSON.parse(read('i18n/it.json'));
  const en = JSON.parse(read('i18n/en.json'));
  assert.match(home, /t\('privacyPolicy'\)/);
  assert.match(home, /openPrivacyPolicyUrl/);
  assert.match(home, /shield-checkmark-outline/);
  assert.doesNotMatch(home, /savePrivacyConsent/);
  assert.doesNotMatch(home, /\.accept\(/);
  assert.equal(it.privacyPolicy, 'Informativa Privacy');
  assert.equal(en.privacyPolicy, 'Privacy Policy');
});

test('privacy link uses configured HTTPS URL and shared Linking helper', () => {
  assert.equal(FALLBACK_PRIVACY_POLICY_URL, 'https://mybizscanner.com/privacy');
  const helper = read('lib/open-privacy-policy.ts');
  assert.match(helper, /Linking\.openURL/);
  assert.match(helper, /parseSafePrivacyPolicyUrl/);
  assert.doesNotMatch(helper, /Intent|ACTION_VIEW|startActivity/);
  const consent = read('components/PrivacyConsentScreen.tsx');
  assert.match(consent, /openPrivacyPolicyUrl/);
  assert.doesNotMatch(consent, /Linking\.openURL/);
});

test('permanent Privacy access does not alter first-launch consent', () => {
  const home = read('app/(tabs)/index.tsx');
  const helper = read('lib/open-privacy-policy.ts');
  assert.doesNotMatch(home, /savePrivacyConsent|markPrivacyConsent|policyVersion/);
  assert.doesNotMatch(helper, /savePrivacyConsent|markPrivacyConsent/);
});

test('shared screens do not call BackHandler.exitApp or force-kill', () => {
  const adapter = path.join(root, 'lib', 'app-exit.ts');
  const adapterSrc = read('lib/app-exit.ts');
  const adapterCode = adapterSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(adapterSrc, /BackHandler\.exitApp\(\)/);
  assert.match(adapterCode, /attempted: false/);
  assert.doesNotMatch(adapterCode, /System\.exit|killProcess|exit\(0\)/);

  for (const file of listProductionTsFiles()) {
    const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /System\.exit|killProcess/);
    if (path.normalize(file) === path.normalize(adapter)) continue;
    assert.doesNotMatch(
      src,
      /BackHandler\.exitApp/,
      `${path.relative(root, file)} must not call BackHandler.exitApp`,
    );
  }

  const home = read('app/(tabs)/index.tsx');
  const consent = read('components/PrivacyConsentScreen.tsx');
  assert.match(home, /exitAppSession\(\)/);
  assert.match(consent, /exitAppSession\(\)/);
  const effects = exitAppSessionSideEffects();
  assert.equal(effects.clearsLocalData, false);
  assert.equal(effects.resetsPrivacyConsent, false);
  assert.equal(effects.resetsTrial, false);
  assert.equal(effects.resetsLicense, false);
  assert.equal(effects.clearsSecureStore, false);
});

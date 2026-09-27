#!/usr/bin/env node
/**
 * Cancella tutti i dati dell'app sul telefono collegato via USB:
 * contatti, documenti, foto scansionate, licenza, preferenze.
 *
 * Uso: npm run wipe:app-data
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const PACKAGE_CANDIDATES = [
  'com.ideebusiness.cardscanner.test',
  'com.ideebusiness.cardscanner',
];

function listInstalledPackages(adbPath, deviceId) {
  const r = adb(adbPath, ['-s', deviceId, 'shell', 'pm', 'list', 'packages']);
  if (r.status !== 0) return [];
  return (r.stdout || '')
    .split('\n')
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter(Boolean);
}

function resolvePackages(installed) {
  const hits = PACKAGE_CANDIDATES.filter((pkg) => installed.includes(pkg));
  if (hits.length > 0) return hits;
  return installed.filter(
    (pkg) => pkg.startsWith('com.ideebusiness.cardscanner') && !pkg.includes('.uninstalled')
  );
}

function getAdb() {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  return join(sdk, 'platform-tools', platform() === 'win32' ? 'adb.exe' : 'adb');
}

function adb(adbPath, args) {
  return spawnSync(adbPath, args, { encoding: 'utf8' });
}

function listDevices(adbPath) {
  const r = adb(adbPath, ['devices']);
  if (r.status !== 0) return [];
  return (r.stdout || '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.endsWith('\tdevice'))
    .map((l) => l.split('\t')[0]);
}

const adbPath = getAdb();
if (!existsSync(adbPath)) {
  console.error('[wipe-app-data] adb non trovato. Installa Android SDK platform-tools.');
  process.exit(1);
}

const devices = listDevices(adbPath);
if (devices.length === 0) {
  console.error('[wipe-app-data] Nessun telefono collegato (adb devices vuoto).');
  console.error('  Collega USB, attiva Debug USB, accetta il prompt sul telefono.');
  process.exit(1);
}

const deviceId = devices[0];
console.log(`[wipe-app-data] Device: ${deviceId}`);

const installed = listInstalledPackages(adbPath, deviceId);
const packages = resolvePackages(installed);

if (packages.length === 0) {
  console.error('[wipe-app-data] Nessuna app Business Scanner trovata sul telefono.');
  console.error('  Cercavo:', PACKAGE_CANDIDATES.join(', '));
  process.exit(1);
}

let ok = 0;
for (const pkg of packages) {
  console.log(`[wipe-app-data] Cancello dati di ${pkg}…`);
  adb(adbPath, ['-s', deviceId, 'shell', 'am', 'force-stop', pkg]);
  const r = adb(adbPath, ['-s', deviceId, 'shell', 'pm', 'clear', pkg]);
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status === 0 && /success/i.test(out)) {
    console.log(`[wipe-app-data]   OK`);
    ok++;
  } else {
    console.error(`[wipe-app-data]   Fallito:`, out || `exit ${r.status}`);
  }
}

if (ok === 0) {
  process.exit(1);
}

console.log('[wipe-app-data] OK — app azzerata.');
console.log('  • Contatti e biglietti eliminati');
console.log('  • Documenti (preventivi/ordini) eliminati');
console.log('  • Foto scansionate eliminate');
console.log('  • Licenza, GDPR e preferenze resettate (reinserire al primo avvio)');
console.log('');
console.log('  Se dopo reinstall vedi ancora dati vecchi:');
console.log('  • Google può ripristinare backup cloud — alla reinstallazione rifiuta il restore');
console.log('  • Verifica di aprire com.ideebusiness.cardscanner.test (non la copia senza .test)');

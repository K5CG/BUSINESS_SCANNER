#!/usr/bin/env node
/**
 * Collega telefono a Metro: adb reverse + metro.host (Wi‑Fi).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces, homedir, platform } from 'node:os';
import { join } from 'node:path';

const PORT = '8081';

function getAdb() {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    join(homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  return join(sdk, 'platform-tools', platform() === 'win32' ? 'adb.exe' : 'adb');
}

function getLanIp() {
  for (const ifaces of Object.values(networkInterfaces())) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
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
const ip = getLanIp();

if (!existsSync(adbPath)) {
  console.error('[connect-phone] adb non trovato. Installa Android SDK platform-tools.');
  process.exit(1);
}

adb(adbPath, ['kill-server']);
adb(adbPath, ['start-server']);
const devices = listDevices(adbPath);

if (devices.length === 0) {
  console.error('');
  console.error('══════════════════════════════════════════════════');
  console.error('  TELEFONO NON VISTO DA ADB');
  console.error('══════════════════════════════════════════════════');
  console.error('  1. Cavo USB dati (non solo ricarica)');
  console.error('  2. Impostazioni → Opzioni sviluppatore → Debug USB ON');
  console.error('  3. Sul telefono: accetta "Consenti debug USB?"');
  console.error('  4. Tipo USB: "Trasferimento file" / MTP');
  console.error('  5. Riprova: npm run connect:phone');
  console.error('');
  console.error('  ALTERNATIVA (niente Metro): npm run install:app');
  console.error('══════════════════════════════════════════════════');
  console.error('');
  process.exit(1);
}

const id = devices[0];
console.log(`[connect-phone] Device: ${id}`);

const rev = adb(adbPath, ['-s', id, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`]);
if (rev.status === 0) {
  console.log(`[connect-phone] adb reverse tcp:${PORT} OK`);
} else {
  console.warn('[connect-phone] adb reverse fallito');
}

if (ip) {
  adb(adbPath, ['-s', id, 'shell', 'setprop', 'metro.host', ip]);
  console.log(`[connect-phone] metro.host = ${ip} (Wi‑Fi backup)`);
  console.log(`[connect-phone] Se serve: Dev menu → host ${ip}:${PORT}`);
}

console.log('[connect-phone] Fatto. Apri l\'app o premi RELOAD.');

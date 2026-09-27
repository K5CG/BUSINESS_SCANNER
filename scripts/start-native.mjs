#!/usr/bin/env node
/**
 * Avvio dev: prima collega telefono (se USB), poi Metro.
 * Per app SENZA schermata rossa: npm run install:app (JS dentro APK).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces, homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
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

const adbPath = getAdb();
if (existsSync(adbPath)) {
  spawnSync('node', [join(__dirname, 'connect-phone.mjs')], {
    stdio: 'inherit',
    cwd: root,
  });
} else {
  console.warn('[start:native] adb non trovato');
}

const ip = getLanIp();
console.log('');
console.log('──────────────────────────────────────────────────────');
console.log('  SCHERMATA ROSSA? Esegui UNA VOLTA:');
console.log('    npm run install:app');
console.log('  (installa APK con codice dentro — niente Metro)');
console.log('──────────────────────────────────────────────────────');
if (ip) console.log(`  Metro LAN: ${ip}:${PORT}`);
console.log('');

const child = spawn('npx', ['expo', 'start', '--port', PORT, '--clear', '--lan'], {
  stdio: 'inherit',
  shell: true,
  cwd: root,
});

child.on('exit', (code) => process.exit(code ?? 0));

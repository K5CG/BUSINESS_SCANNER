const { execSync, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

/** Porta Metro — deve coincidere con react_native_dev_server_port nell'APK debug (8081). */
const METRO_PORT = '8081';

function getAdbPath() {
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');

  return path.join(sdk, 'platform-tools', os.platform() === 'win32' ? 'adb.exe' : 'adb');
}

function runAdb(adb, args) {
  return spawnSync(adb, args, { encoding: 'utf8' });
}

function listDevices(adb) {
  const result = runAdb(adb, ['devices']);
  if (result.error) return [];
  return (result.stdout || '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((id) => id && id !== 'List');
}

function main() {
  const strict = process.argv.includes('--strict');
  const extra = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
  const ports = extra.length ? extra : [METRO_PORT];
  const adb = getAdbPath();

  if (!require('fs').existsSync(adb)) {
    console.warn(`[adb] Non trovato: ${adb}`);
    console.warn('[adb] Metro parte comunque. Per USB: installa Android SDK platform-tools.');
    process.exit(strict ? 1 : 0);
  }

  let devices = listDevices(adb);
  if (devices.length === 0) {
    console.warn('[adb] Nessun device — riavvio server adb…');
    runAdb(adb, ['kill-server']);
    runAdb(adb, ['start-server']);
    devices = listDevices(adb);
  }

  if (devices.length === 0) {
    console.warn('');
    console.warn('[adb] Nessun telefono/emulatore collegato.');
    console.warn('[adb] Metro parte COMUNQUE — usa:  npm run start');
    console.warn('[adb] Quando ricolleghi USB:  npm run adb:reverse');
    console.warn('');
    process.exit(strict ? 1 : 0);
  }

  let ok = true;
  for (const port of ports) {
    const result = runAdb(adb, ['reverse', `tcp:${port}`, `tcp:${port}`]);
    if (result.status !== 0) {
      ok = false;
      console.warn(`[adb] reverse tcp:${port} fallito`);
      if (result.stderr) console.warn(result.stderr.trim());
    } else {
      console.log(`[adb] reverse tcp:${port} tcp:${port} OK (${devices[0]})`);
    }
  }

  if (!ok && strict) process.exit(1);
}

main();

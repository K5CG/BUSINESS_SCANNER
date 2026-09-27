import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';

const root = process.cwd();
const PORT = 8081;
const packageName = process.env.BS_ANDROID_PACKAGE || 'com.mybizscanner.ai';
const failedOnly = process.argv.includes('--failed-only');

function adbPath() {
  if (process.env.ADB) return process.env.ADB;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  const candidate = path.join(sdk, 'platform-tools', platform() === 'win32' ? 'adb.exe' : 'adb');
  return existsSync(candidate) ? candidate : (platform() === 'win32' ? 'adb.exe' : 'adb');
}

const adb = adbPath();
function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: options.stdio ?? 'pipe', env: process.env });
}

function fail(message, detail = '') {
  console.error(`REAL IMAGE LIVE GATE ERROR: ${message}`);
  if (detail.trim()) console.error(detail.trim());
  process.exit(2);
}

function waitMetro(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const probe = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/status`, { timeout: 1500 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200 && /packager-status:running/i.test(body)) return resolve();
          retry();
        });
      });
      req.on('timeout', () => { req.destroy(); retry(); });
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) return reject(new Error('Metro non pronto entro 120 secondi'));
      setTimeout(probe, 1000);
    };
    probe();
  });
}

function stopTree(child) {
  if (!child?.pid) return;
  try {
    if (platform() === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {}
}

async function main() {
  const state = run(adb, ['get-state']);
  if (state.status !== 0 || !/device/i.test(state.stdout || '')) {
    fail('telefono non disponibile via ADB', `${state.stdout || ''}\n${state.stderr || ''}`);
  }

  const installed = run(adb, ['shell', 'pm', 'path', packageName]);
  if (installed.status !== 0 || !/package:/i.test(installed.stdout || '')) {
    fail(`app ${packageName} non installata sul telefono`);
  }

  const reverse = run(adb, ['reverse', `tcp:${PORT}`, `tcp:${PORT}`]);
  if (reverse.status !== 0) fail('adb reverse 8081 fallito', reverse.stderr || reverse.stdout || '');

  // Garantisce che il bundle servito sia ESATTAMENTE quello del progetto corrente.
  const killOld = path.join(root, 'scripts', 'kill-port.js');
  run(process.execPath, [killOld, String(PORT)], { stdio: 'ignore' });

  // Node 26 on Windows can throw spawn EINVAL when launching .cmd shims such
  // as npx.cmd directly. Start Expo with Node itself instead, bypassing the
  // Windows command shim entirely.
  const expoCli = path.join(root, 'node_modules', 'expo', 'bin', 'cli');
  if (!existsSync(expoCli)) {
    fail('Expo CLI locale non trovato', `Atteso: ${expoCli}`);
  }

  console.log('REAL IMAGE LIVE GATE');
  console.log('1/3 Avvio Metro con il codice corrente...');
  const metro = spawn(process.execPath, [expoCli, 'start', '--port', String(PORT), '--clear', '--localhost'], {
    cwd: root,
    env: { ...process.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  metro.on('error', (error) => {
    metroTail = `${metroTail}\nMETRO SPAWN ERROR: ${error instanceof Error ? error.message : String(error)}`.slice(-12000);
  });

  let metroTail = '';
  const keepTail = (chunk) => {
    metroTail = (metroTail + chunk.toString()).slice(-12000);
  };
  metro.stdout?.on('data', keepTail);
  metro.stderr?.on('data', keepTail);

  try {
    await waitMetro();
    console.log(failedOnly ? '2/3 Metro pronto. Riprovo solo i FAIL reali precedenti...' : '2/3 Metro pronto. Lancio le JPEG reali nel ML Kit del telefono...');
    const gateArgs = [path.join(root, 'scripts', 'android-real-image-gate.mjs'), ...(failedOnly ? ['--failed-only'] : [])];
    const gate = run(process.execPath, gateArgs, { stdio: 'inherit' });
    const diagLines = metroTail.split(/\r?\n/).filter((line) => line.includes('[OCR_EMAIL_V24]'));
    if (diagLines.length) {
      console.log('\n=== OCR EMAIL DIAGNOSTIC V24 ===');
      for (const line of diagLines) console.log(line);
      console.log('=== END OCR EMAIL DIAGNOSTIC V24 ===\n');
    } else {
      console.log('\nOCR EMAIL DIAGNOSTIC V24: nessuna riga diagnostica ricevuta da Metro.');
    }
    if (gate.status !== 0) {
      process.exitCode = gate.status ?? 1;
      return;
    }
    console.log('3/3 Gate fotografie reali completato.');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), metroTail);
  } finally {
    stopTree(metro);
  }
}

await main();

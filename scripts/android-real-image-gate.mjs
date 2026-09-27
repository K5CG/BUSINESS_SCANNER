import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const fixtureDir = path.join(root, 'test-data', 'qa-real-image-2026-09-13');
const imagesDir = path.join(fixtureDir, 'images');
const expectedPath = path.join(fixtureDir, 'expected.json');
const outputPath = path.join(root, 'QA_REAL_IMAGE_RESULT.json');
const packageName = process.env.BS_ANDROID_PACKAGE || 'com.mybizscanner.ai';
const timeoutMs = Number(process.env.BS_REAL_IMAGE_TIMEOUT_MS || 8 * 60 * 1000);
const adbCommandTimeoutMs = Number(process.env.BS_ADB_COMMAND_TIMEOUT_MS || 60 * 1000);

function adbPath() {
  if (process.env.ADB) return process.env.ADB;
  const candidates = [];
  if (process.env.ANDROID_HOME) candidates.push(path.join(process.env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'));
  candidates.push(process.platform === 'win32' ? 'adb.exe' : 'adb');
  return candidates.find((candidate) => {
    try { execFileSync(candidate, ['version'], { stdio: 'ignore', timeout: 10000 }); return true; } catch { return false; }
  }) || candidates.at(-1);
}

const adb = adbPath();
function run(args, options = {}) {
  return execFileSync(adb, args, {
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? adbCommandTimeoutMs,
  });
}
function runAs(shellCommand, options = {}) {
  return run(['exec-out', 'run-as', packageName, 'sh', '-c', shellCommand], options);
}
function safeRemote(relativePath) {
  const safe = relativePath.replace(/\\/g, '/');
  if (safe.includes("'") || safe.includes('..')) throw new Error(`Unsafe path: ${relativePath}`);
  return safe;
}

// V16: NEVER stream JPEG bytes through "adb exec-out ... cat" stdin on Windows.
// Node 26 + adb can block indefinitely there. Push a normal file to /data/local/tmp,
// then copy it into the app sandbox with run-as.
let tempCounter = 0;
function installPrivateFile(relativePath, localPath) {
  const safe = safeRemote(relativePath);
  const dir = path.posix.dirname(safe);
  runAs(`mkdir -p files/${dir}`);

  const base = path.basename(localPath).replace(/[^A-Za-z0-9._-]/g, '_');
  const remoteTmp = `/data/local/tmp/bs-real-image-${process.pid}-${tempCounter++}-${base}`;
  try {
    run(['push', localPath, remoteTmp], { timeout: 60000 });
    run(['shell', 'chmod', '0644', remoteTmp]);
    run(['shell', 'run-as', packageName, 'cp', remoteTmp, `files/${safe}`]);
  } finally {
    try { run(['shell', 'rm', '-f', remoteTmp], { timeout: 10000 }); } catch {}
  }
}

function writePrivateJson(relativePath, value) {
  const tmp = path.join(os.tmpdir(), `bs-real-image-${process.pid}-${tempCounter++}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    installPrivateFile(relativePath, tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
function tryReadPrivate(relativePath) {
  const safe = safeRemote(relativePath);
  try {
    const raw = runAs(`if [ -f files/${safe} ]; then cat files/${safe}; fi`);
    return raw && raw.trim().startsWith('{') ? raw : null;
  } catch {
    return null;
  }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function main() {
  if (!fs.existsSync(expectedPath)) throw new Error(`Fixture missing: ${expectedPath}`);
  const fixture = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    throw new Error('Invalid real-image fixture');
  }

  const failedOnly = process.argv.includes('--failed-only');
  let selectedCases = fixture.cases;
  if (failedOnly) {
    if (!fs.existsSync(outputPath)) throw new Error('No previous QA_REAL_IMAGE_RESULT.json for --failed-only');
    const previous = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const failedIds = new Set((previous.results ?? []).filter((item) => !item.pass).map((item) => item.id));
    selectedCases = fixture.cases.filter((item) => failedIds.has(item.id));
    if (!selectedCases.length) throw new Error('Previous result has no failed real-image cases');
    process.stdout.write(`FAILED-ONLY MODE: ${selectedCases.length} previous failures\n`);
  }

  run(['get-state']);
  try { runAs('rm -f files/qa-real-image-result.json files/qa-real-image-request.json'); } catch {}
  runAs('rm -rf files/qa-real-image-input && mkdir -p files/qa-real-image-input');

  const copied = new Set();
  const requestCases = selectedCases.map((item) => {
    const imageFiles = item.images.map((name) => {
      const localPath = path.join(imagesDir, name);
      if (!fs.existsSync(localPath)) throw new Error(`Missing JPEG: ${localPath}`);
      const remote = `qa-real-image-input/${name}`;
      if (!copied.has(remote)) {
        process.stdout.write(`COPY ${name} ... `);
        installPrivateFile(remote, localPath);
        process.stdout.write('OK\n');
        copied.add(remote);
      }
      return remote;
    });
    return { id: item.id, title: item.title, imageFiles, expected: item.expected };
  });

  writePrivateJson('qa-real-image-request.json', { schemaVersion: 1, cases: requestCases });

  process.stdout.write(`REAL IMAGE GATE: ${requestCases.length} contacts / ${copied.size} actual JPEGs\n`);
  process.stdout.write('Starting app QA hook...\n');
  try { run(['shell', 'am', 'force-stop', packageName]); } catch {}
  try {
    run(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], { stdio: 'ignore' });
  } catch {
    run(['shell', 'am', 'start', '-n', `${packageName}/.MainActivity`], { stdio: 'ignore' });
  }

  const started = Date.now();
  let raw = null;
  while (Date.now() - started < timeoutMs) {
    await sleep(2000);
    raw = tryReadPrivate('qa-real-image-result.json');
    if (raw && raw.trim().startsWith('{')) break;
    const elapsed = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`waiting ${elapsed}s...\r`);
  }
  process.stdout.write('\n');
  if (!raw || !raw.trim().startsWith('{')) {
    throw new Error(`No valid QA JSON result after ${Math.round(timeoutMs / 1000)}s (the device hook did not finish; no invalid cat output will be parsed)`);
  }

  const result = JSON.parse(raw);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  if (result.error) throw new Error(`Device QA hook failed: ${result.error}`);

  process.stdout.write(`\nREAL IMAGE QA — PASS=${result.passed} FAIL=${result.failed} TOTAL=${result.total}\n`);
  for (const item of result.results ?? []) {
    process.stdout.write(`${item.pass ? 'PASS' : 'FAIL'} ${item.title} — errors=${item.errors} warnings=${item.warnings}\n`);
    if (!item.pass) {
      for (const assertion of item.assertions.filter((entry) => !entry.pass && entry.severity === 'error')) {
        process.stdout.write(`  - ${assertion.id}: expected=${JSON.stringify(assertion.expected)} actual=${JSON.stringify(assertion.actual)}\n`);
      }
      for (const page of item.pageDiagnostics ?? []) {
        for (const diag of page.emailRefinementDiagnostics ?? []) {
          process.stdout.write(`    EMAIL-DIAG observed=${JSON.stringify(diag.observedLine)} email=${JSON.stringify(diag.observedEmail)}\n`);
          for (const entry of diag.focused ?? []) {
            process.stdout.write(`      ${entry.variant}: ${JSON.stringify(entry.text)} email=${JSON.stringify(entry.email)}\n`);
          }
          process.stdout.write(`      consensus: ${JSON.stringify(diag.consensus)}\n`);
          for (const entry of diag.hostFocused ?? []) {
            process.stdout.write(`      ${entry.variant}: ${JSON.stringify(entry.text)} email=${JSON.stringify(entry.email)}\n`);
          }
          if (diag.hostConsensus) process.stdout.write(`      hostConsensus: ${JSON.stringify(diag.hostConsensus)}\n`);
        }
      }
    }
    const pageStats = (item.pageDiagnostics ?? []).map((p) => `${path.basename(p.imageFile)}:${p.rawText?.length ?? 0}ch/${p.lineCount ?? 0}ln`).join(' | ');
    process.stdout.write(`    OCR ${pageStats}\n`);
  }
  process.stdout.write(`\nReport: ${outputPath}\n`);
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`REAL IMAGE GATE ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});

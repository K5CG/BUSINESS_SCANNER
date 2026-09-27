import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';

const root = process.cwd();
const take = Math.max(1, Math.min(20, Number(process.argv[2] || 5)) || 5);

function adbPath() {
  if (process.env.ADB) return process.env.ADB;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  const candidate = path.join(sdk, 'platform-tools', platform() === 'win32' ? 'adb.exe' : 'adb');
  return existsSync(candidate) ? candidate : (platform() === 'win32' ? 'adb.exe' : 'adb');
}

const adb = adbPath();
function run(args, options = {}) {
  // Keep ADB invocation identical to the proven real-image gate on Windows.
  // Do not use spawnSync timeout here: with Node 26 + adb background server
  // it can produce a false ETIMEDOUT even when `adb devices -l` sees the phone.
  const r = spawnSync(adb, args, {
    cwd: root,
    encoding: options.binary ? null : 'utf8',
    maxBuffer: 1024 * 1024 * 200,
    stdio: 'pipe',
    env: process.env,
  });
  if (r.error) {
    fail('errore avvio ADB', `${r.error.code || ''} ${r.error.message || r.error}`);
  }
  return r;
}

function fail(msg, detail = '') {
  console.error(`CAMERA QA PULL ERROR: ${msg}`);
  if (detail) console.error(String(detail).trim());
  process.exit(2);
}

console.log(`CAMERA QA PULL — ultimi ${take} scatti`);
console.log('1/4 Verifica telefono ADB...');
const devices = run(['devices', '-l']);
const devicesText = String(devices.stdout || '');
if (devices.status !== 0 || !/^\S+\s+device\b/m.test(devicesText)) {
  fail('telefono non disponibile via ADB', `${devicesText}\n${devices.stderr || ''}`);
}
const deviceLine = devicesText.split(/\r?\n/).find((line) => /^\S+\s+device\b/.test(line)) || 'device';
console.log(`   OK — ${deviceLine.trim()}`);

const packageCandidates = [
  process.env.BS_ANDROID_PACKAGE,
  'com.mybizscanner.ai',
  'com.kfive.businessscanner',
].filter(Boolean);
let packageName = null;
for (const candidate of packageCandidates) {
  const r = run(['shell', 'pm', 'path', candidate]);
  if (r.status === 0 && /package:/i.test(r.stdout || '')) {
    packageName = candidate;
    break;
  }
}
if (!packageName) fail('Business Scanner non trovato sul telefono');
console.log(`   OK — package ${packageName}`);

const dirs = [
  { remote: 'files/qa-card-geometry', local: 'qa-card-geometry', re: /^card-(\d+)-/ },
  { remote: 'files/qa-card-ocr', local: 'qa-card-ocr', re: /^ocr-(\d+)-([a-z0-9]+)-/i },
];

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'qa_export', `camera-capture-${stamp}`);
mkdirSync(outDir, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  packageName,
  requestedLatestCaptures: take,
  sources: [],
};

function listRemote(remote) {
  const r = run(['shell', 'run-as', packageName, 'ls', '-1', remote]);
  if (r.status !== 0) return [];
  return String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

function selectLatestGroups(files, re, count) {
  const groups = new Map();
  for (const name of files) {
    const m = name.match(re);
    if (!m) continue;
    const ts = Number(m[1]);
    // OCR prefix includes random suffix; preserve it so one capture stays grouped.
    const key = re.source.startsWith('^ocr-') ? `ocr-${m[1]}-${m[2]}` : `card-${m[1]}`;
    const g = groups.get(key) || { key, ts, files: [] };
    g.files.push(name);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a,b) => b.ts - a.ts).slice(0, count).sort((a,b) => a.ts - b.ts);
}

console.log('2/4 Cerco artefatti QA sul telefono...');
for (const spec of dirs) {
  const files = listRemote(spec.remote);
  const groups = selectLatestGroups(files, spec.re, take);
  const localDir = path.join(outDir, spec.local);
  mkdirSync(localDir, { recursive: true });
  const sourceInfo = { remote: spec.remote, groups: [] };
  console.log(`   ${spec.remote}: ${files.length} file, ${groups.length} gruppi selezionati`);

  for (const group of groups) {
    const gi = { key: group.key, timestamp: group.ts, files: [] };
    console.log(`   COPY ${group.key}: ${group.files.length} file`);
    for (const name of group.files.sort()) {
      process.stdout.write(`      ${name} ... `);
      const rr = run(['exec-out', 'run-as', packageName, 'cat', `${spec.remote}/${name}`], { binary: true });
      if (rr.status !== 0 || !rr.stdout) {
        console.log('FAIL');
        gi.files.push({ name, copied: false, status: rr.status, stderr: String(rr.stderr || '').trim() });
        continue;
      }
      writeFileSync(path.join(localDir, name), rr.stdout);
      gi.files.push({ name, copied: true, bytes: rr.stdout.length });
      console.log(`OK (${rr.stdout.length} bytes)`);
    }
    sourceInfo.groups.push(gi);
  }
  manifest.sources.push(sourceInfo);
}

writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const totalGroups = manifest.sources.reduce((n, src) => n + src.groups.length, 0);
if (totalGroups === 0) {
  fail('nessun artefatto CAMERA QA trovato sul telefono', `Controllati: ${dirs.map(d => d.remote).join(', ')}`);
}

console.log('3/4 Scrivo manifest...');
const zipPath = `${outDir}.zip`;
console.log('4/4 Creo ZIP...');
if (platform() === 'win32') {
  const esc = (s) => s.replace(/'/g, "''");
  const cmd = `Compress-Archive -Path '${esc(path.join(outDir, '*'))}' -DestinationPath '${esc(zipPath)}' -Force`;
  const z = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 120000, windowsHide: true });
  if (z.error?.code === 'ETIMEDOUT') {
    console.log(`Artefatti copiati in: ${outDir}`);
    fail('ZIP timeout dopo 120s');
  }
  if (z.status !== 0) {
    console.log(`Artefatti copiati in: ${outDir}`);
    fail('ZIP non creato', `${z.stdout || ''}\n${z.stderr || ''}`);
  }
} else {
  const z = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: outDir, encoding: 'utf8', stdio: 'pipe' });
  if (z.status !== 0) {
    console.log(`Artefatti copiati in: ${outDir}`);
    fail('ZIP non creato', `${z.stdout || ''}\n${z.stderr || ''}`);
  }
}

console.log('CAMERA QA PULL COMPLETATO');
console.log(`Pacchetto: ${zipPath}`);
for (const src of manifest.sources) {
  console.log(`${src.remote}: ${src.groups.length} gruppi`);
}

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir, platform } from 'node:os';
import { createHash } from 'node:crypto';

const root = process.cwd();
const mode = String(process.argv[2] || '').toLowerCase();
const expected = Math.max(1, Math.min(20, Number(process.argv[3] || 5) || 5));
const statePath = path.join(root, 'qa_export', 'camera-qa-session-state.json');

function adbPath() {
  if (process.env.ADB) return process.env.ADB;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  const candidate = path.join(sdk, 'platform-tools', platform() === 'win32' ? 'adb.exe' : 'adb');
  return existsSync(candidate) ? candidate : (platform() === 'win32' ? 'adb.exe' : 'adb');
}
const adb = adbPath();
function run(args, binary = false) {
  return spawnSync(adb, args, {
    cwd: root,
    encoding: binary ? null : 'utf8',
    maxBuffer: 1024 * 1024 * 250,
    stdio: 'pipe',
    env: process.env,
  });
}
function fail(msg, detail = '') {
  console.error(`CAMERA QA SESSION ERROR: ${msg}`);
  if (detail) console.error(String(detail).trim());
  process.exit(2);
}
function detectDeviceAndPackage() {
  const d = run(['devices', '-l']);
  const text = String(d.stdout || '');
  if (d.status !== 0 || !/^\S+\s+device\b/m.test(text)) fail('telefono non disponibile via ADB', `${text}\n${d.stderr || ''}`);
  const deviceLine = text.split(/\r?\n/).find(l => /^\S+\s+device\b/.test(l))?.trim() || 'device';
  const candidates = [process.env.BS_ANDROID_PACKAGE, 'com.mybizscanner.ai', 'com.kfive.businessscanner'].filter(Boolean);
  for (const pkg of candidates) {
    const r = run(['shell', 'pm', 'path', pkg]);
    if (r.status === 0 && /package:/i.test(String(r.stdout || ''))) return { deviceLine, packageName: pkg };
  }
  fail('Business Scanner non trovato sul telefono');
}
const specs = [
  { id: 'geometry', remote: 'files/qa-card-geometry', local: 'qa-card-geometry', re: /^card-(\d+)-/, key: m => `card-${m[1]}` },
  { id: 'ocr', remote: 'files/qa-card-ocr', local: 'qa-card-ocr', re: /^ocr-(\d+)-([a-z0-9]+)-/i, key: m => `ocr-${m[1]}-${m[2]}` },
];
function listFiles(pkg, remote) {
  const r = run(['shell', 'run-as', pkg, 'ls', '-1', remote]);
  if (r.status !== 0) return [];
  return String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function groupsFor(files, spec) {
  const map = new Map();
  for (const name of files) {
    const m = name.match(spec.re);
    if (!m) continue;
    const timestamp = Number(m[1]);
    const key = spec.key(m);
    const g = map.get(key) || { key, timestamp, files: [] };
    g.files.push(name);
    map.set(key, g);
  }
  return [...map.values()].sort((a,b) => a.timestamp - b.timestamp);
}
function latestTs(pkg, spec) {
  const gs = groupsFor(listFiles(pkg, spec.remote), spec);
  return gs.length ? gs[gs.length - 1].timestamp : 0;
}
function sha(buf) { return createHash('sha256').update(buf).digest('hex'); }
function readLocal(p) { return readFileSync(p); }

if (!['start','pull'].includes(mode)) {
  console.log('Uso:');
  console.log('  node scripts\\camera-qa-session.mjs start 5');
  console.log('  node scripts\\camera-qa-session.mjs pull 5');
  process.exit(1);
}

const { deviceLine, packageName } = detectDeviceAndPackage();
mkdirSync(path.dirname(statePath), { recursive: true });

if (mode === 'start') {
  const baseline = {};
  for (const spec of specs) baseline[spec.id] = latestTs(packageName, spec);
  const state = { startedAt: new Date().toISOString(), packageName, deviceLine, expected, baseline };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log('CAMERA QA SESSION START');
  console.log(`Telefono: ${deviceLine}`);
  console.log(`Package: ${packageName}`);
  console.log(`Baseline geometry=${baseline.geometry} ocr=${baseline.ocr}`);
  console.log(`Ora esegui ${expected} acquisizioni REALI nella app. Poi lancia:`);
  console.log(`node scripts\\camera-qa-session.mjs pull ${expected}`);
  process.exit(0);
}

if (!existsSync(statePath)) fail('sessione non inizializzata; esegui prima START');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (state.packageName !== packageName) fail('package diverso dalla sessione START');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(root, 'qa_export', `camera-session-${stamp}`);
mkdirSync(outDir, { recursive: true });
const manifest = { generatedAt: new Date().toISOString(), startedAt: state.startedAt, packageName, expected, baseline: state.baseline, sources: [], pairing: [] };

console.log('CAMERA QA SESSION PULL');
console.log(`Telefono: ${deviceLine}`);
for (const spec of specs) {
  const all = groupsFor(listFiles(packageName, spec.remote), spec);
  const groups = all.filter(g => g.timestamp > Number(state.baseline?.[spec.id] || 0));
  console.log(`${spec.remote}: ${groups.length} gruppi NUOVI`);
  const localDir = path.join(outDir, spec.local);
  mkdirSync(localDir, { recursive: true });
  const si = { id: spec.id, remote: spec.remote, groups: [] };
  for (const group of groups) {
    const gi = { key: group.key, timestamp: group.timestamp, files: [] };
    console.log(`  COPY ${group.key}: ${group.files.length} file`);
    for (const name of group.files.sort()) {
      const rr = run(['exec-out', 'run-as', packageName, 'cat', `${spec.remote}/${name}`], true);
      if (rr.status !== 0 || !rr.stdout) {
        gi.files.push({ name, copied: false, status: rr.status });
        console.log(`    FAIL ${name}`);
        continue;
      }
      const dest = path.join(localDir, name);
      writeFileSync(dest, rr.stdout);
      gi.files.push({ name, copied: true, bytes: rr.stdout.length, sha256: sha(rr.stdout) });
    }
    si.groups.push(gi);
  }
  manifest.sources.push(si);
}

const geom = manifest.sources.find(s => s.id === 'geometry')?.groups || [];
const ocr = manifest.sources.find(s => s.id === 'ocr')?.groups || [];
if (geom.length < expected) fail(`trovati solo ${geom.length} nuovi scatti geometrici; attesi ${expected}`, `Non uso artefatti precedenti alla sessione START.`);

for (const g of geom) {
  const b = g.files.find(f => /-03-boundary-output\.jpg$/i.test(f.name) && f.copied);
  const oi = g.files.find(f => /-04-ocr-base-input\.jpg$/i.test(f.name) && f.copied);
  const sameBoundaryAndOcr = !!(b && oi && b.sha256 === oi.sha256);
  let match = null;
  if (oi) {
    for (const og of ocr) {
      const inp = og.files.find(f => /-10-latin-000-input\.jpg$/i.test(f.name) && f.copied);
      if (inp && inp.sha256 === oi.sha256) { match = og; break; }
    }
  }
  if (!match && ocr.length) {
    const candidates = ocr.map(og => ({ og, deltaMs: og.timestamp - g.timestamp })).filter(x => x.deltaMs >= 0 && x.deltaMs <= 120000).sort((a,b) => a.deltaMs - b.deltaMs);
    if (candidates.length === 1) match = candidates[0].og;
  }
  manifest.pairing.push({ geometry: g.key, geometryTimestamp: g.timestamp, boundaryEqualsOcrBase: sameBoundaryAndOcr, ocr: match?.key || null, ocrTimestamp: match?.timestamp || null, pairing: match ? 'matched' : 'unmatched' });
}

writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('PAIRING:');
for (const p of manifest.pairing) console.log(`  ${p.geometry} -> ${p.ocr || 'NO MATCH'} | boundary==ocrBase ${p.boundaryEqualsOcrBase ? 'YES' : 'NO'}`);

const zipPath = `${outDir}.zip`;
if (platform() === 'win32') {
  const esc = s => s.replace(/'/g, "''");
  const cmd = `Compress-Archive -Path '${esc(path.join(outDir, '*'))}' -DestinationPath '${esc(zipPath)}' -Force`;
  const z = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 120000, windowsHide: true });
  if (z.status !== 0) fail('ZIP non creato', `${z.stdout || ''}\n${z.stderr || ''}`);
} else {
  const z = spawnSync('zip', ['-rq', zipPath, '.'], { cwd: outDir, encoding: 'utf8', stdio: 'pipe' });
  if (z.status !== 0) fail('ZIP non creato', `${z.stdout || ''}\n${z.stderr || ''}`);
}
console.log('CAMERA QA SESSION COMPLETATA');
console.log(`Pacchetto: ${zipPath}`);

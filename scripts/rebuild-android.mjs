#!/usr/bin/env node
/**
 * Rebuild Android con patch camera (expo-camera v4).
 *
 * Uso:
 *   npm run rebuild:android          → APK debug in android/app/build/outputs/
 *   npm run rebuild:android:install  → build + install su device USB
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const androidDir = join(root, 'android');
const gradlew = join(androidDir, os.platform() === 'win32' ? 'gradlew.bat' : 'gradlew');
const install = process.argv.includes('--install');

// Ora che expo-camera viene compilato dai sorgenti, della patch nativa restano
// attive le sole aggiunte che non toccano inquadratura e scatto: diagnostica
// degli stream, stati di messa a fuoco e punto AF scalato sui pixel della
// PreviewView. Una patch a metà deve far fallire la build invece di degradare
// in silenzio.
const PATCH_MARKERS = [
  'previewUseCase',
  'onAutofocusStateChanged',
  'CAMERA_OPEN',
  'previewStreamSize',
  'imageCaptureSize',
  'putFloat("maxZoomRatio"',
  'cameraInfo.zoomState.observe(currentActivity)',
  'meteringPointX * previewView.width'
];

function log(msg) {
  console.log(`[rebuild-android] ${msg}`);
}

function run(cmd, opts = {}) {
  log(cmd);
  execSync(cmd, { stdio: 'inherit', cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env } });
}

function getSdkDir() {
  const localProps = join(androidDir, 'local.properties');
  if (existsSync(localProps)) {
    const m = readFileSync(localProps, 'utf8').match(/sdk\.dir=(.+)/);
    if (m) return m[1].trim().replace(/\\\\/g, '/');
  }
  return (
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk')
  );
}

function getAdb() {
  return join(getSdkDir(), 'platform-tools', os.platform() === 'win32' ? 'adb.exe' : 'adb');
}

function verifyPatch() {
  const kt = join(
    root,
    'node_modules/expo-camera/android/src/main/java/expo/modules/camera/ExpoCameraView.kt'
  );
  const mod = join(
    root,
    'node_modules/expo-camera/android/src/main/java/expo/modules/camera/CameraViewModule.kt'
  );
  if (!existsSync(kt) || !existsSync(mod)) {
    throw new Error('expo-camera non trovato — esegui npm install');
  }
  const src = readFileSync(kt, 'utf8') + readFileSync(mod, 'utf8');
  const missing = PATCH_MARKERS.filter((m) => !src.includes(m));
  if (missing.length) {
    throw new Error(`Patch camera incompleta, mancano: ${missing.join(', ')}`);
  }
  log('Patch camera verificata OK');
  verifyPatchReachesBuild();
}

/**
 * Da expo-camera 17 il modulo viene distribuito anche come artefatto
 * precompilato in local-maven-repo: in quel caso Gradle ignora i sorgenti
 * Kotlin e la patch resta inerte pur risultando "verificata". Senza questo
 * avviso l'assenza delle dimensioni di stream sembra un bug del lato JS.
 */
function verifyPatchReachesBuild() {
  const prebuilt = join(root, 'node_modules/expo-camera/local-maven-repo');
  if (!existsSync(prebuilt)) return;

  let buildFromSource = [];
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    buildFromSource = pkg?.expo?.autolinking?.buildFromSource ?? [];
  } catch {
    buildFromSource = [];
  }
  if (buildFromSource.some((entry) => String(entry).includes('expo-camera'))) {
    log('expo-camera compilato dai sorgenti: patch nativa attiva');
    return;
  }

  log('!! ATTENZIONE: expo-camera viene linkato come AAR precompilato.');
  log('!! La patch nativa NON finisce nell APK: niente previewStreamSize,');
  log('!! quindi il ritaglio della cornice biglietto resta disattivato.');
  log('!! Per attivarla: package.json > expo.autolinking.buildFromSource');
  log('!! ["expo-camera"].');
}

function findApk() {
  const outDir = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug');
  const apk = join(outDir, 'app-debug.apk');
  if (!existsSync(apk)) {
    throw new Error(`APK non trovato in ${outDir}`);
  }
  return apk;
}

/**
 * Evita un falso verde: TypeScript e test possono essere aggiornati mentre
 * l'APK contiene ancora un index.android.bundle precedente. Il valore e'
 * usato a runtime nei contatti/esportazioni, quindi deve comparire nel bundle
 * embedded appena generato.
 */
function verifyEmbeddedParserBuild(bundlePath) {
  const versionFile = join(root, 'lib', 'parser-version.ts');
  const versionSource = readFileSync(versionFile, 'utf8');
  const match = versionSource.match(/PARSER_BUILD_ID\s*=\s*['\"]([^'\"]+)['\"]/);
  if (!match) {
    throw new Error('PARSER_BUILD_ID non leggibile da lib/parser-version.ts');
  }
  const parserBuildId = match[1];
  const bundle = readFileSync(bundlePath, 'utf8');
  if (!bundle.includes(parserBuildId)) {
    throw new Error(
      `Bundle Android non aggiornato: manca parser build ${parserBuildId}. ` +
      'Interrompo la build per evitare di installare codice precedente.'
    );
  }
  log(`Bundle embedded verificato: ${parserBuildId}`);
}

function main() {
  log('1/6 — Riapplico patch expo-camera…');
  run('node scripts/patch-expo-camera-focus.mjs');

  log('1/6 — Rigenero icon/splash con safe zone Android…');
  run('node scripts/render-brand-icons.mjs');

  log('2/6 — Sincronizzo icon/splash native Android da assets/…');
  run('node scripts/sync-android-brand-assets.mjs');

  log('3/6 — Verifico marker patch…');
  verifyPatch();

  const assetsDir = join(androidDir, 'app', 'src', 'main', 'assets');
  const bundleOut = join(assetsDir, 'index.android.bundle');
  log('4/6 — Rigenero JS bundle embedded (export:embed)…');
  run(
    `npx expo export:embed --platform android --dev false --reset-cache --bundle-output "${bundleOut}" --assets-dest "${join(androidDir, 'app', 'src', 'main', 'res')}"`,
  );
  verifyEmbeddedParserBuild(bundleOut);

  log('5/6 — Gradle clean + assembleDebug…');
  run(`"${gradlew}" clean :app:assembleDebug`, { cwd: androidDir });

  const apk = findApk();
  log(`APK debug: ${apk}`);

  if (install) {
    const adb = getAdb();
    if (!existsSync(adb)) {
      throw new Error(`adb non trovato: ${adb}`);
    }
    log('6/6 — Install su device…');
    const devices = spawnSync(adb, ['devices'], { encoding: 'utf8' });
    const lines = (devices.stdout || '')
      .split('\n')
      .filter((l) => l.includes('\tdevice'));
    if (!lines.length) {
      throw new Error('Nessun device Android collegato (adb devices vuoto)');
    }
    run(`"${adb}" install -r "${apk}"`);
    log('Install completata. Il JS è dentro l’APK — non serve Metro per testare la camera.');
  } else {
    log('7/7 — Salta install (usa --install o npm run rebuild:android:install)');
    log('Per installare: adb install -r "' + apk + '"');
    log('Poi Metro: npm run start:native');
  }
}

try {
  main();
} catch (e) {
  console.error('[rebuild-android] ERRORE:', e.message || e);
  process.exit(1);
}

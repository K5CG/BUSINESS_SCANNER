import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QA_CORPUS_DIRS } from '../lib/qa-corpus-12';
import { LATEST_QA_DIR } from '../lib/qa-latest-fixtures';

const PACKAGE_ID = 'com.mybizscanner.ai';
const REQUEST_NAME = 'qa-replay-request.json';
const RESULT_NAME = 'qa-replay-result.json';

function resolveAdb(): string {
  const sdk = process.env.ANDROID_HOME
    || process.env.ANDROID_SDK_ROOT
    || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
  const candidate = path.join(sdk, 'platform-tools', os.platform() === 'win32' ? 'adb.exe' : 'adb');
  if (fs.existsSync(candidate)) return candidate;
  return 'adb';
}

const ADB = resolveAdb();

function adb(args: string[]): string {
  return execFileSync(ADB, args, { encoding: 'utf8' }).trim();
}

function main() {
  const documents = [];
  for (const qaDir of QA_CORPUS_DIRS) {
    const fixtureDir = path.join(process.cwd(), qaDir, 'fixtures');
    if (!fs.existsSync(path.join(fixtureDir, 'index.json'))) continue;
    const index = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'index.json'), 'utf8')) as {
      documents: Array<{ id: string }>;
    };
    for (const entry of index.documents) {
      documents.push(JSON.parse(
        fs.readFileSync(path.join(fixtureDir, `${entry.id}.document.json`), 'utf8'),
      ));
    }
  }
  const requestPath = path.join(process.cwd(), LATEST_QA_DIR, REQUEST_NAME);
  fs.writeFileSync(requestPath, JSON.stringify({
    deadlineMode: 'production',
    documents,
  }));
  const devices = adb(['devices']).split(/\r?\n/).filter((line) => /\tdevice$/.test(line));
  if (devices.length === 0) {
    console.error('NO_ANDROID_DEVICE');
    process.exit(2);
  }
  const remoteTmp = `/data/local/tmp/${REQUEST_NAME}`;
  adb(['push', requestPath, remoteTmp]);
  adb(['shell', `cat ${remoteTmp} | run-as ${PACKAGE_ID} sh -c 'cat > files/${REQUEST_NAME}'`]);
  try {
    adb(['shell', `run-as ${PACKAGE_ID} rm files/${RESULT_NAME}`]);
  } catch {
    /* no previous result */
  }
  adb(['shell', `am force-stop ${PACKAGE_ID}`]);
  adb(['shell', `monkey -p ${PACKAGE_ID} -c android.intent.category.LAUNCHER 1`]);
  const outPath = path.join(process.cwd(), LATEST_QA_DIR, RESULT_NAME);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const pulled = adb(['shell', `run-as ${PACKAGE_ID} cat files/${RESULT_NAME}`]);
      if (pulled.includes('"runtime"')) {
        fs.writeFileSync(outPath, pulled);
        console.log(`Wrote ${outPath}`);
        return;
      }
    } catch {
      /* result not ready */
    }
    execFileSync(ADB, ['shell', 'sleep', '3']);
  }
  console.error('ANDROID_REPLAY_TIMEOUT');
  process.exit(3);
}

main();


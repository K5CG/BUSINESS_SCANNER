import fs from 'node:fs';
import path from 'node:path';
import { firstDifferingStage, type CanonicalParseSnapshot } from '../lib/document-parse-snapshot';
import { LATEST_QA_DIR } from '../lib/qa-latest-fixtures';

interface AndroidReplayFile {
  runtime?: string;
  error?: string;
  results?: Array<{
    id: string;
    title?: string;
    snapshot: CanonicalParseSnapshot;
  }>;
}

function main() {
  const root = path.join(process.cwd(), LATEST_QA_DIR);
  const androidPath = path.join(root, 'qa-replay-result.json');
  const nodeDir = path.join(root, 'node-snapshots');
  if (!fs.existsSync(androidPath)) {
    console.log('Android Hermes snapshot missing. Node-only rows:');
    for (const file of fs.readdirSync(nodeDir).filter((name) => name.endsWith('.json'))) {
      const node = JSON.parse(fs.readFileSync(path.join(nodeDir, file), 'utf8')) as {
        id: string;
        title: string;
        snapshot: CanonicalParseSnapshot;
      };
      console.log([
        node.title,
        'ANDROID_SNAPSHOT_MISSING',
        node.snapshot.stages.find((s) => s.stage === 'canonical_result')?.hash,
        'n/a',
        'NO',
      ].join('\t'));
    }
    process.exit(0);
  }
  const android = JSON.parse(fs.readFileSync(androidPath, 'utf8')) as AndroidReplayFile;
  if (android.error || !android.results) {
    console.error(android.error ?? 'empty android results');
    process.exit(1);
  }
  console.log(['Fixture', 'First differing stage', 'Node hash', 'Android hash', 'Same final result'].join('\t'));
  for (const result of android.results) {
    const nodeFile = path.join(nodeDir, `${result.id}.json`);
    const node = JSON.parse(fs.readFileSync(nodeFile, 'utf8')) as {
      title: string;
      snapshot: CanonicalParseSnapshot;
    };
    const first = firstDifferingStage(node.snapshot, result.snapshot) ?? 'none';
    const nodeHash = node.snapshot.stages.find((s) => s.stage === 'canonical_result')?.hash ?? '';
    const androidHash = result.snapshot.stages.find((s) => s.stage === 'canonical_result')?.hash ?? '';
    console.log([
      node.title,
      first,
      nodeHash,
      androidHash,
      first === 'none' ? 'YES' : 'NO',
    ].join('\t'));
  }
}

main();

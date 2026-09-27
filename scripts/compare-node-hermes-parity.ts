import fs from 'node:fs';
import path from 'node:path';
import {
  firstDifferingStage,
  firstSemanticDifferingStage,
  type CanonicalParseSnapshot,
} from '../lib/document-parse-snapshot';
import { QA_CORPUS_DIRS } from '../lib/qa-corpus-12';

interface ReplayFile {
  runtime?: string;
  results?: Array<{
    id: string;
    title?: string;
    snapshot: CanonicalParseSnapshot;
  }>;
}

function main() {
  let compared = 0;
  let same = 0;
  const diffs: Array<{ title: string; first: string; qaDir: string }> = [];
  for (const qaDir of QA_CORPUS_DIRS) {
    const root = path.join(process.cwd(), qaDir);
    const hermesPath = [
      path.join(root, 'hermes-replay-result.json'),
      path.join(root, 'qa-replay-result.json'),
    ].find((candidate) => fs.existsSync(candidate));
    const nodeDir = path.join(root, 'node-snapshots');
    if (!hermesPath || !fs.existsSync(nodeDir)) {
      console.log(`${qaDir}\tHERMES_SNAPSHOT_MISSING`);
      continue;
    }
    const hermes = JSON.parse(fs.readFileSync(hermesPath, 'utf8')) as ReplayFile;
    if (!hermes.results) {
      console.log(`${qaDir}\tHERMES_RESULTS_EMPTY`);
      continue;
    }
    for (const result of hermes.results) {
      const nodeFile = path.join(nodeDir, `${result.id}.json`);
      if (!fs.existsSync(nodeFile)) continue;
      const node = JSON.parse(fs.readFileSync(nodeFile, 'utf8')) as {
        title: string;
        snapshot: CanonicalParseSnapshot;
      };
      const first = firstDifferingStage(node.snapshot, result.snapshot) ?? 'none';
      const semantic = firstSemanticDifferingStage(node.snapshot, result.snapshot) ?? 'none';
      compared += 1;
      if (semantic === 'none') same += 1;
      else diffs.push({ title: node.title, first: semantic, qaDir });
      console.log([node.title, first, semantic, semantic === 'none' ? 'YES' : 'NO', qaDir].join('\t'));
    }
  }
  console.log(`semantic_parity\t${same}/${compared}`);
  if (diffs.length > 0) {
    console.log('first_divergent_stages');
    for (const diff of diffs) console.log(`${diff.title}\t${diff.first}\t${diff.qaDir}`);
  }
  process.exitCode = compared > 0 && same === compared ? 0 : 1;
}

main();

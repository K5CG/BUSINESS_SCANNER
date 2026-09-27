import fs from 'node:fs';
import path from 'node:path';
import type { AnyDocument } from '../types';
import {
  LATEST_QA_DIR,
  fixtureFromPersistedDocument,
  slimDocumentForReplay,
} from '../lib/qa-latest-fixtures';

const relativeRoot = process.argv[2] ?? LATEST_QA_DIR;
const root = path.join(process.cwd(), relativeRoot);
const fixtureDir = path.join(root, 'fixtures');
const documents = JSON.parse(
  fs.readFileSync(path.join(root, 'documents.json'), 'utf8'),
) as AnyDocument[];

fs.mkdirSync(fixtureDir, { recursive: true });
const index = documents.map((document) => {
  const fixture = fixtureFromPersistedDocument(document);
  const slim = slimDocumentForReplay(document);
  fs.writeFileSync(
    path.join(fixtureDir, `${document.id}.json`),
    JSON.stringify(fixture, null, 2),
  );
  fs.writeFileSync(
    path.join(fixtureDir, `${document.id}.document.json`),
    JSON.stringify(slim),
  );
  return {
    id: document.id,
    type: document.type,
    title: document.title,
    pageCount: fixture.pages.length,
    ocrLineCount: fixture.pages.reduce((sum, page) => sum + page.lines.length, 0),
    geometryCount: fixture.pages.reduce(
      (sum, page) => sum + page.lines.filter((line) => !!line.boundingBox).length,
      0,
    ),
  };
});
fs.writeFileSync(path.join(fixtureDir, 'index.json'), JSON.stringify({
  source: relativeRoot,
  count: index.length,
  documents: index,
}, null, 2));
console.log(`Wrote ${index.length} fixtures to ${path.relative(process.cwd(), fixtureDir)}`);

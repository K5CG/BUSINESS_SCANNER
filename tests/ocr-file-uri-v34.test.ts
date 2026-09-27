import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.join(process.cwd(), 'lib/ocr.ts'), 'utf8');

test('V34: ML Kit non riceve mai un path assoluto senza schema URI', () => {
  const start = source.indexOf('function ocrUriCandidates');
  const end = source.indexOf('\nasync function recognizeOnce', start);
  const body = source.slice(start, end);
  assert.match(body, /for \(const uri of \[normalized, imageUri\]\)/);
  assert.match(body, /uri\.startsWith\('\/'\)[\s\S]{0,120}file:\/\//);
  assert.doesNotMatch(body, /candidates\.add\((?:decodeURI\()?uri\.slice\(7\)/);
});

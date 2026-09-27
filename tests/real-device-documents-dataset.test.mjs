import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const datasetRoot = path.join(root, 'test-data', 'real-device-documents');
const manifest = JSON.parse(
  fs.readFileSync(path.join(datasetRoot, 'manifest.json'), 'utf8'),
);

test('il manifest reale usa lo schema corrente e non supera otto casi', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.cases));
  assert.ok(manifest.cases.length <= 8);
  assert.equal(new Set(manifest.cases).size, manifest.cases.length);
});

for (const relativeCasePath of manifest.cases) {
  test(`dataset reale completo: ${relativeCasePath}`, () => {
    assert.equal(typeof relativeCasePath, 'string');
    const casePath = path.resolve(datasetRoot, relativeCasePath);
    assert.ok(casePath.startsWith(`${path.resolve(datasetRoot)}${path.sep}`));
    assert.ok(fs.existsSync(casePath), `case.json mancante: ${relativeCasePath}`);

    const caseDirectory = path.dirname(casePath);
    const fixture = JSON.parse(fs.readFileSync(casePath, 'utf8'));
    assert.match(fixture.caseId, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(['quote', 'order', 'free_document'].includes(fixture.documentType));
    assert.ok(Array.isArray(fixture.images) && fixture.images.length > 0);
    assert.ok(Array.isArray(fixture.rawOcrPages) && fixture.rawOcrPages.length > 0);
    assert.equal(fixture.images.length, fixture.rawOcrPages.length);

    for (const relativeAsset of [...fixture.images, ...fixture.rawOcrPages]) {
      const assetPath = path.resolve(caseDirectory, relativeAsset);
      assert.ok(assetPath.startsWith(`${path.resolve(caseDirectory)}${path.sep}`));
      assert.ok(fs.existsSync(assetPath), `asset mancante: ${relativeAsset}`);
      assert.ok(fs.statSync(assetPath).size > 0, `asset vuoto: ${relativeAsset}`);
    }

    const expectedPath = path.resolve(caseDirectory, fixture.expectedFile);
    assert.ok(expectedPath.startsWith(`${path.resolve(caseDirectory)}${path.sep}`));
    const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
    assert.equal(expected.verifiedManually, true);
    assert.ok(['PASS', 'PARTIAL', 'FAIL'].includes(expected.status));
    assert.equal(typeof expected.fields, 'object');
    assert.equal(typeof expected.fieldOrigins, 'object');
    assert.deepEqual(
      Object.keys(expected.issues).sort(),
      ['merge', 'ocr', 'parser', 'persistence', 'ui'],
    );
  });
}

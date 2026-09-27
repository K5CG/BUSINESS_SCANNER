import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseCardFromPagesV5 } from '../lib/parser-v5';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('V91: surname can recover exactly one observed terminal OCR letter on the same person line', () => {
  const parsed = parseCardFromPagesV5([
    {
      rawText: 'D.F. Interni di De Franceschi Luigi & C SAS',
      lines: [
        { text: 'Luigi De Francesch', confidence: 0.9 },
        { text: 'D.F. Interni di De Franceschi Luigi & C SAS', confidence: 0.9 },
        { text: 'Amministratore', confidence: 0.9 },
      ],
    },
  ]);
  assert.equal(parsed.firstName, 'Luigi');
  assert.equal(parsed.lastName, 'De Franceschi');
});

test('V91: draft persistence retains both displayed and original card assets', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  assert.match(scanner, /const retainedBusinessCardUris = new Set\(\[/);
  assert.match(scanner, /\.\.\.\(document\.originalImages \?\? \[\]\)/);
  assert.match(scanner, /for \(const uri of retainedBusinessCardUris\) sessionScope\.retain\(uri\)/);
});

test('V91: save failures identify persistence, never a camera shutter', () => {
  const detail = read('app/document/[id].tsx');
  assert.match(detail, /CONTACT_SAVE_FAILED/);
  assert.match(detail, /contactSaveFailed/);
  assert.match(detail, /documentSaveFailed/);
  const storage = read('lib/image-storage.ts');
  assert.match(storage, /\[AssetPersistence\] stage_copy_failed/);
  const persistence = read('lib/persistence.ts');
  assert.match(persistence, /withoutUnavailableContactOriginals/);
  assert.match(persistence, /original_backups_unavailable_preserving_preview/);
});

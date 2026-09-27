import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  applyAiCreditsRemainingToStatus,
  nextAiCreditsRemainingFromServer,
} from '../lib/ai-credits-ui-sync';

const baseStatus = {
  access: 'active' as const,
  kind: 'trial' as const,
  daysRemaining: 7,
  aiCreditsRemaining: 5,
  aiCreditsTotal: 5,
  aiCreditsUsed: 0,
  entitlement: { status: 'ACTIVE', features: { cloudAi: true } },
};

test('A. server returns 3 → status credits = 3', () => {
  const next = applyAiCreditsRemainingToStatus(baseStatus, 3);
  assert.ok(next);
  assert.equal(next.aiCreditsRemaining, 3);
});

test('B. server returns 0 → status credits = 0', () => {
  const next = applyAiCreditsRemainingToStatus(baseStatus, 0);
  assert.ok(next);
  assert.equal(next.aiCreditsRemaining, 0);
});

test('C. server returns null → existing balance unchanged', () => {
  assert.equal(nextAiCreditsRemainingFromServer(null), null);
  assert.equal(applyAiCreditsRemainingToStatus(baseStatus, null), null);
  assert.equal(applyAiCreditsRemainingToStatus(baseStatus, undefined), null);
});

test('D. other license status fields remain unchanged', () => {
  const next = applyAiCreditsRemainingToStatus(baseStatus, 3)!;
  assert.equal(next.access, baseStatus.access);
  assert.equal(next.kind, baseStatus.kind);
  assert.equal(next.daysRemaining, baseStatus.daysRemaining);
  assert.equal(next.aiCreditsTotal, baseStatus.aiCreditsTotal);
  assert.equal(next.aiCreditsUsed, baseStatus.aiCreditsUsed);
  assert.deepEqual(next.entitlement, baseStatus.entitlement);
});

test('E. PDF success path syncs Edge balance exactly once', () => {
  const root = process.cwd();
  const provider = fs.readFileSync(
    path.join(root, 'components/LicenseProvider.tsx'),
    'utf8'
  );
  const scanner = fs.readFileSync(
    path.join(root, 'components/Camera/MultiPageScanner.tsx'),
    'utf8'
  );
  const pdfImport = fs.readFileSync(path.join(root, 'lib/pdf-import.ts'), 'utf8');
  const parsePdf = fs.readFileSync(path.join(root, 'lib/parse-pdf.ts'), 'utf8');

  assert.match(provider, /updateAiCreditsRemaining/);
  assert.match(scanner, /updateAiCreditsRemaining\(aiCreditsRemaining, 'pdf'\)/);
  assert.equal(
    (scanner.match(/updateAiCreditsRemaining\(/g) ?? []).length,
    1
  );
  assert.match(pdfImport, /aiCreditsRemaining/);
  assert.match(parsePdf, /aiCreditsRemaining: outcome\.aiCreditsRemaining/);
  assert.doesNotMatch(scanner, /currentCredits\s*-\s*pageCount/);
  assert.doesNotMatch(pdfImport, /aiCreditsRemaining\s*-\s*/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCardV5 } from '../lib/parser-v5/engine';
import { detectBusinessCardForegroundBoundsFromRgba } from '../lib/business-card-boundary';

function page(lines: string[]) {
  return {
    rawText: lines.join('\n'),
    lines: lines.map((text, index) => ({
      text,
      confidence: 0.96,
      boundingBox: { x: 10, y: 20 + index * 28, width: Math.max(180, text.length * 8), height: 22 },
    })),
  } as any;
}

test('generic: acronym company punctuation is canonical before a legal suffix', () => {
  const result = extractCardV5([page(['A. BC. DE, s. n.c.', 'Jane Doe', 'Technical Director'])]);
  assert.equal(result.company.value, 'A.BC.DE. S.n.c.');
});

test('generic: phone normalization removes area-code parentheses without inferring country', () => {
  const result = extractCardV5([page(['Jane Doe', 'Technical Director', 'Tel: (0445) 671155'])]);
  assert.equal(result.phones.value?.[0]?.number, '0445 671155');
});

test('generic: labeled OCR-dirty phone separators recover fixed and mobile numbers', () => {
  const result = extractCardV5([page([
    'Jane Doe',
    'Technical Director',
    'Tel_0445.51 2.360',
    'cell_345.004,53,48',
  ])]);
  assert.deepEqual(result.phones.value?.map((phone) => [phone.number, phone.type]), [
    ['0445512360', 'work'],
    ['3450045348', 'mobile'],
  ]);
});

test('generic: whitespace around a literal @ is emitted only as repaired/review email', () => {
  const result = extractCardV5([page(['Jane Doe', 'Technical Director', 'jane.doe@ example.com'])]);
  assert.deepEqual(result.emails.value, ['jane.doe@example.com']);
  const evidence = result.emailEvidence.find((item) => item.value === 'jane.doe@example.com');
  assert.equal(evidence?.origin, 'repaired');
  assert.equal(evidence?.requiresReview, true);
  assert.equal(evidence?.confirmed, false);
});

test('generic: a standalone activity/logo word is not a personal role, but a real role remains valid', () => {
  const activityOnly = extractCardV5([page(['ACME', 'CONSU LT IN G', 'Jane Doe', 'jane@acme.com'])]);
  assert.equal(activityOnly.role.value, null);

  const personalRole = extractCardV5([page(['ACME', 'Jane Doe', 'Consulting Manager', 'jane@acme.com'])]);
  assert.match(personalRole.role.value ?? '', /Consulting Manager/i);
});

test('generic: observed brand can beat a domain root with a generic technical suffix', () => {
  const result = extractCardV5([page(['Jane Doe', 'Sales Manager', 'jane@orbitnet.example', 'orbit'])]);
  assert.equal(result.company.value, 'Orbit');
});

test('generic: thin background grid does not drag irregular foreground to the frame edge', () => {
  const width = 240;
  const height = 320;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 35;
    rgba[i * 4 + 1] = 35;
    rgba[i * 4 + 2] = 38;
    rgba[i * 4 + 3] = 255;
  }
  const paint = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * width + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
  };

  for (let x = 0; x < width; x++) for (let y = 8; y < 10; y++) paint(x, y, 180, 180, 185);
  for (let y = 0; y < height; y++) for (let x = 230; x < 232; x++) paint(x, y, 180, 180, 185);
  for (let y = 28; y < 286; y++) {
    for (let x = 34; x < 206; x++) {
      const concavity = y > 120 && y < 235 && x > 166;
      if (!concavity) paint(x, y, 225, 190, 125);
    }
  }
  for (let y = 9; y < 30; y++) for (let x = 70; x < 72; x++) paint(x, y, 180, 180, 185);

  const result = detectBusinessCardForegroundBoundsFromRgba(rgba, width, height);
  assert.ok(result);
  assert.ok(result!.rect.y > 5);
  assert.ok(result!.rect.x + result!.rect.width < width - 2);
  assert.ok(result!.mask);
  const mask = result!.mask!;
  const cx = Math.floor(190 / mask.blockSize);
  const cy = Math.floor(170 / mask.blockSize);
  assert.equal(mask.cells[cy * mask.gridWidth + cx], 0);
});

test('generic real-device: letter-spaced activity suffix is repaired only with corroborating business domain', () => {
  const result = extractCardV5([page([
    'Jane Doe',
    'Account Manager',
    'DERGA ( O N S U L T I N G',
    'www.derga.it',
  ])]);
  assert.equal(result.company.value, 'DERGA Consulting');
  assert.ok(result.company.score <= 0.79, 'a glyph repair must not retain unjustified high confidence');
});

test('generic real-device: observed surname particle spacing wins over fused email local-part', () => {
  const result = extractCardV5([page([
    'FABIO DE VECCHI',
    'Web & marketing',
    'Gruppovolta',
    'fabio.devecchi@gruppovolta.it',
    'www.gruppovolta.it',
  ])]);
  assert.equal(result.firstName.value, 'Fabio');
  assert.equal(result.lastName.value, 'De Vecchi');
});

test('generic real-device: inline single-letter phone label cannot contaminate address', () => {
  const result = extractCardV5([page([
    'Jane Doe',
    'Marketing Manager',
    'Gruppovolta',
    'Via Lelda B, Verona, T 39 045 61 000 84',
    'www.gruppovolta.it',
  ])]);
  const full = result.address.value?.full ?? '';
  assert.match(full, /Via Lelda B/i);
  assert.doesNotMatch(full, /\bT\s*39\s*045/i);
  assert.doesNotMatch(full, /61\s*000\s*84/i);
});

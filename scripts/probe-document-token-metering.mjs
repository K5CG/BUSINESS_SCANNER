/**
 * Document AI token probe only (valid JPEG via sharp).
 * Fresh installationIds + check-license grant. Numbers-only output.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim()])
);

const base = env.EXPO_PUBLIC_SUPABASE_URL;
const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

async function ensureTrialCredits(installationId) {
  const response = await fetch(`${base}/functions/v1/check-license`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ installationId }),
  });
  return response.json();
}

async function callDocument(imageBase64, installationId) {
  const response = await fetch(`${base}/functions/v1/parse-document`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      imageBase64,
      mimeType: 'image/jpeg',
      pageIndex: 0,
      pageCount: 1,
      kind: 'document',
      installationId,
      operationId: randomUUID(),
      operationType: 'document_page_ai',
    }),
  });
  const body = await response.json();
  return {
    httpStatus: response.status,
    errorCode: body.errorCode ?? null,
    providerTokenUsage: body.providerTokenUsage ?? null,
    aiCreditsRemaining: body.aiCreditsRemaining ?? null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const labels = ['DOC-PROBE-A', 'DOC-PROBE-B', 'DOC-PROBE-C'];
const samples = [];

for (let i = 0; i < labels.length; i += 1) {
  const label = labels[i];
  const svg = Buffer.from(
    `<svg width="800" height="1100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <text x="40" y="80" font-size="28" fill="black">PREVENTIVO ${label}</text>
      <text x="40" y="140" font-size="20" fill="black">Issuer: Vendor Probe Srl</text>
      <text x="40" y="180" font-size="20" fill="black">Customer: Buyer Probe SpA</text>
      <text x="40" y="240" font-size="20" fill="black">Total EUR ${(100 + i * 50).toFixed(2)}</text>
      <text x="40" y="300" font-size="18" fill="black">Item ${i + 1} qty 1 EUR ${(100 + i * 50).toFixed(2)}</text>
    </svg>`
  );
  const jpeg = await sharp(svg).jpeg({ quality: 85 }).toBuffer();
  const installationId = randomUUID();
  await ensureTrialCredits(installationId);
  await sleep(2000);
  const sample = await callDocument(jpeg.toString('base64'), installationId);
  samples.push({
    case: 'document_page_ai',
    index: i + 1,
    creditsChargedExpected: 1,
    jpegBytes: jpeg.length,
    ...sample,
  });
  console.log(JSON.stringify(samples[samples.length - 1]));
  await sleep(2000);
}

mkdirSync('.tmp-qa', { recursive: true });
const path = '.tmp-qa/ai-token-metering-samples.json';
const existing = existsSync(path)
  ? JSON.parse(readFileSync(path, 'utf8'))
  : { samples: [] };
existing.samples = [
  ...existing.samples.filter((s) => s.case !== 'document_page_ai'),
  ...samples,
];
existing.documentProbeAt = new Date().toISOString();
writeFileSync(path, JSON.stringify(existing, null, 2));
console.log(JSON.stringify({ ok: true, count: samples.length }, null, 2));

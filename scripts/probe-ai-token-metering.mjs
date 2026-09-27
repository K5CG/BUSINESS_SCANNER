/**
 * Probe Edge AI endpoints for privacy-safe providerTokenUsage samples.
 * Uses fresh installationIds so the device trial balance is not consumed.
 * Never prints document contents / OCR / license keys.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim()])
);

const base = env.EXPO_PUBLIC_SUPABASE_URL;
const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!base || !key) {
  console.error(JSON.stringify({ error: 'missing_supabase_public_env' }));
  process.exit(1);
}

mkdirSync('.tmp-qa', { recursive: true });

async function ensureTrialCredits(installationId) {
  const startedAt = Date.now();
  const response = await fetch(`${base}/functions/v1/check-license`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ installationId }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      httpStatus: response.status,
      elapsedMs: Date.now() - startedAt,
      errorCode: 'UNPARSABLE_LICENSE',
      aiCreditsRemaining: null,
    };
  }
  return {
    httpStatus: response.status,
    elapsedMs: Date.now() - startedAt,
    errorCode: parsed.errorCode ?? null,
    aiCreditsRemaining: parsed.aiCreditsRemaining ?? null,
  };
}

async function callEdge(fn, body) {
  const startedAt = Date.now();
  const response = await fetch(`${base}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      httpStatus: response.status,
      elapsedMs: Date.now() - startedAt,
      errorCode: 'UNPARSABLE',
    };
  }
  return {
    httpStatus: response.status,
    elapsedMs: Date.now() - startedAt,
    errorCode: parsed.errorCode ?? null,
    providerTokenUsage: parsed.providerTokenUsage ?? null,
    aiCreditsRemaining: parsed.aiCreditsRemaining ?? null,
    model: parsed.providerTokenUsage?.model ?? null,
    hasRawText: typeof parsed.rawText === 'string',
    itemCount: Array.isArray(parsed.items) ? parsed.items.length : null,
  };
}

function tinyJpegBase64() {
  // Minimal valid 1x1 JPEG
  return Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z',
    'base64'
  ).toString('base64');
}

async function makeSimplePdfBase64(label) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(`Quotation ${label}`, { x: 50, y: 780, size: 16, font });
  page.drawText('Issuer: Sample Vendor Srl', { x: 50, y: 750, size: 12, font });
  page.drawText('Customer: Sample Customer SpA', { x: 50, y: 730, size: 12, font });
  page.drawText('Total: EUR 100.00', { x: 50, y: 700, size: 12, font });
  page.drawText('Item 1  Qty 1  EUR 100.00', { x: 50, y: 670, size: 12, font });
  const bytes = await doc.save();
  return Buffer.from(bytes).toString('base64');
}

const CARD_SAMPLES = [
  `KFIVE SRL\nVia Roma 1\nMilano\nMario Rossi\nSales Manager\nmario.rossi@example.invalid\n+39 02 0000000`,
  `Alltena GmbH\nAnna Weber\nProduct Owner\nanna.weber@example.invalid\n+49 30 000000`,
  `CIRA SCPA\nUfficio Acquisti\nLuca Bianchi\nluca.bianchi@example.invalid\nNapoli`,
];

const results = {
  collectedAt: new Date().toISOString(),
  note: 'Fresh installationIds used; device credits not consumed. Numbers only.',
  samples: [],
};

for (const [index, ocrText] of CARD_SAMPLES.entries()) {
  const installationId = randomUUID();
  const grant = await ensureTrialCredits(installationId);
  const sample = await callEdge('structure-business-card', {
    ocrText,
    installationId,
    operationId: randomUUID(),
    operationType: 'business_card_ai',
  });
  results.samples.push({
    case: 'business_card_ai',
    index: index + 1,
    creditsChargedExpected: 1,
    grantCredits: grant.aiCreditsRemaining,
    ...sample,
  });
}

for (let index = 0; index < 3; index += 1) {
  const installationId = randomUUID();
  const grant = await ensureTrialCredits(installationId);
  const sample = await callEdge('parse-document', {
    imageBase64: tinyJpegBase64(),
    mimeType: 'image/jpeg',
    pageIndex: 0,
    pageCount: 1,
    kind: 'document',
    installationId,
    operationId: randomUUID(),
    operationType: 'document_page_ai',
  });
  results.samples.push({
    case: 'document_page_ai',
    index: index + 1,
    creditsChargedExpected: 1,
    grantCredits: grant.aiCreditsRemaining,
    ...sample,
  });
}

{
  const installationId = randomUUID();
  const pdfBase64 = await makeSimplePdfBase64('AN-1002-PROBE');
  const sample = await callEdge('parse-pdf', {
    pdfBase64,
    mimeType: 'application/pdf',
    pageCount: 1,
    documentType: 'quotation',
    installationId,
    operationId: randomUUID(),
    operationType: 'pdf_page_ai',
  });
  results.samples.push({
    case: 'pdf_page_ai_simple_1p',
    index: 1,
    creditsChargedExpected: 1,
    ...sample,
  });
}

{
  const complexPath = '.tmp-qa/preventivo_test_pdf_complesso_2026.pdf';
  if (existsSync(complexPath)) {
    const installationId = randomUUID();
    const pdfBase64 = readFileSync(complexPath).toString('base64');
    const { PDFDocument: PDFLib } = await import('pdf-lib');
    const pageCount = (
      await PDFLib.load(Uint8Array.from(Buffer.from(pdfBase64, 'base64')))
    ).getPageCount();
    const sample = await callEdge('parse-pdf', {
      pdfBase64,
      mimeType: 'application/pdf',
      pageCount,
      documentType: 'quotation',
      installationId,
      operationId: randomUUID(),
      operationType: 'pdf_page_ai',
    });
    results.samples.push({
      case: 'pdf_page_ai_complex_2p',
      index: 1,
      pageCount,
      creditsChargedExpected: pageCount,
      ...sample,
    });
  } else {
    results.samples.push({
      case: 'pdf_page_ai_complex_2p',
      skipped: true,
      reason: 'fixture_missing',
    });
  }
}

const outPath = '.tmp-qa/ai-token-metering-samples.json';
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(
  JSON.stringify(
    {
      outPath,
      sampleCount: results.samples.length,
      summary: results.samples.map((s) => ({
        case: s.case,
        httpStatus: s.httpStatus,
        errorCode: s.errorCode,
        creditsRemaining: s.aiCreditsRemaining,
        providerTokenUsage: s.providerTokenUsage,
      })),
    },
    null,
    2
  )
);

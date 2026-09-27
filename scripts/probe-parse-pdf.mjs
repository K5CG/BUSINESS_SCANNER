/**
 * Sonda di collaudo: manda un PDF reale alla Edge Function parse-pdf deployata
 * e mostra soltanto la forma della risposta, mai il contenuto del documento.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].trim()])
);

const url = `${env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/parse-pdf`;
const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const pdfPath = process.argv[2];
const installationId = process.argv[3] ?? randomUUID();

const pdfBase64 = readFileSync(pdfPath).toString('base64');
const { PDFDocument } = await import('pdf-lib');
const pdfBytes = Uint8Array.from(Buffer.from(pdfBase64, 'base64'));
const pageCount = (await PDFDocument.load(pdfBytes)).getPageCount();
const startedAt = Date.now();
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    pdfBase64,
    mimeType: 'application/pdf',
    pageCount,
    documentType: 'quotation',
    installationId,
    operationId: randomUUID(),
    operationType: 'pdf_page_ai',
  }),
});

const text = await response.text();
const elapsedMs = Date.now() - startedAt;
let body;
try {
  body = JSON.parse(text);
} catch {
  console.log(JSON.stringify({ httpStatus: response.status, elapsedMs, unparsable: text.slice(0, 200) }));
  process.exit(1);
}

writeFileSync('.tmp-qa/parse-pdf-response.json', JSON.stringify(body, null, 2));
const issuer =
  body.structured?.issuer?.name?.value ??
  body.structured?.issuer?.name ??
  null;
const customer =
  body.customerName ??
  body.structured?.customer?.name?.value ??
  null;
const subject = body.structured?.document?.subject?.value ?? null;
const currency = body.structured?.document?.currency?.value ?? null;
const diag = body.itemsPassDiagnostics ?? null;

console.log(
  JSON.stringify(
    {
      httpStatus: response.status,
      elapsedMs,
      installationId,
      pageCount,
      errorCode: body.errorCode ?? null,
      providerTimings: body.providerTimings ?? null,
      itemsPassFailed: body.itemsPassFailed ?? false,
      flatItems: Array.isArray(body.items) ? body.items.length : null,
      structuredItems: Array.isArray(body.structured?.items)
        ? body.structured.items.length
        : null,
      documentNumber: body.documentNumber ?? null,
      date: body.date ?? null,
      issuer,
      customer,
      subject: typeof subject === 'string' ? subject.slice(0, 60) : subject,
      subtotal: body.subtotal ?? null,
      vatAmount: body.vatAmount ?? null,
      total: body.total ?? null,
      currency,
      aiCreditsRemaining: body.aiCreditsRemaining ?? null,
      itemsPassDiagnostics: diag,
    },
    null,
    2
  )
);

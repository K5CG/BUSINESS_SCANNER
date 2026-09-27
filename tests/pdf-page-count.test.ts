import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { MAX_CLOUD_DOCUMENT_PAGES } from '../lib/cloud-ai-limits';
import {
  resolvePdfPageCount,
  type PdfPageCountResult,
} from '../lib/pdf-page-count';

async function syntheticPdfBase64(pageCount: number): Promise<string> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage();
  }
  const bytes = await document.save();
  return Buffer.from(bytes).toString('base64');
}

function assertOk(result: PdfPageCountResult, pageCount: number): void {
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pageCount, pageCount);
  assert.equal(result.method, 'pdf-lib');
  assert.equal(result.errorCode, null);
}

test('A. PDF a 1 pagina → pageCount = 1', async () => {
  assertOk(await resolvePdfPageCount(await syntheticPdfBase64(1)), 1);
});

test('B. PDF a 2 pagine → pageCount = 2', async () => {
  assertOk(await resolvePdfPageCount(await syntheticPdfBase64(2)), 2);
});

test('C. PDF a 5 pagine → pageCount = 5', async () => {
  assertOk(await resolvePdfPageCount(await syntheticPdfBase64(5)), 5);
});

test('D. PDF corrotto: errore esplicito, mai pageCount=1 silenzioso', async () => {
  const result = await resolvePdfPageCount('not-a-pdf');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.pageCount, null);
  assert.equal(result.errorCode, 'PDF_INVALID');
});

test('D2. oltre il massimo pagine: errore esplicito', async () => {
  const result = await resolvePdfPageCount(
    await syntheticPdfBase64(MAX_CLOUD_DOCUMENT_PAGES + 1)
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.pageCount, null);
  assert.equal(result.errorCode, 'PDF_PAGE_LIMIT_EXCEEDED');
});

test('E. pageCount usato in modo coerente in payload/log client', () => {
  const parsePdf = fs.readFileSync(
    path.join(process.cwd(), 'lib', 'parse-pdf.ts'),
    'utf8'
  );
  const pdfImport = fs.readFileSync(
    path.join(process.cwd(), 'lib', 'pdf-import.ts'),
    'utf8'
  );
  const edge = fs.readFileSync(
    path.join(
      process.cwd(),
      'supabase',
      'functions',
      '_shared',
      'document-edge-handlers.ts'
    ),
    'utf8'
  );
  assert.match(pdfImport, /resolvePdfPageCount\(payload\.base64\)/);
  assert.match(pdfImport, /pdfPageCount\.pageCount/);
  assert.match(pdfImport, /pageCount: pdfPageCount\.pageCount/);
  assert.doesNotMatch(
    parsePdf,
    /parsePdfWithSupabaseVerbose\(\s*pdfBase64,\s*1\s*,/
  );
  assert.match(parsePdf, /pageCount,/);
  assert.match(parsePdf, /\.\.\.aiContextPayload\(ctx\)/);
  assert.match(
    parsePdf,
    /typeof pageCount !== 'number'[\s\S]*return null/
  );
  assert.match(edge, /\{\s*\.\.\.body,\s*pageCount: pageCount\.value\s*\}/);
});

test('il PDF QA complesso ha 2 pagine reali', async () => {
  const qaPath = path.join(
    process.cwd(),
    '.tmp-qa',
    'preventivo_test_pdf_complesso_2026.pdf'
  );
  if (!fs.existsSync(qaPath)) {
    // Ambiente senza fixture: non blocca la suite.
    return;
  }
  const base64 = fs.readFileSync(qaPath).toString('base64');
  assertOk(await resolvePdfPageCount(base64), 2);
});

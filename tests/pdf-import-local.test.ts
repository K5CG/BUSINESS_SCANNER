import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  basenameOf,
  classifyLocalReadError,
  logPdfLocal,
  looksLikePdf,
  pdfErrorMessageKey,
  readUriScheme,
  sanitizeErrorMessage,
  validatePickedPdf,
  type PdfLocalStage,
} from '../lib/pdf-import-local';
import { MAX_CLOUD_PDF_BYTES } from '../lib/cloud-ai-limits';

const root = path.resolve(__dirname, '..');
const importSource = fs.readFileSync(path.join(root, 'lib', 'pdf-import.ts'), 'utf8');
const it_ = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'it.json'), 'utf8'));
const en_ = JSON.parse(fs.readFileSync(path.join(root, 'i18n', 'en.json'), 'utf8'));

const CACHE_PDF = 'file:///data/user/0/com.app/cache/DocumentPicker/1720000000.pdf';
const SAF_PDF = 'content://com.android.providers.downloads.documents/document/msf%3A1000000123';

test('1 un PDF copiato in cache è già leggibile come file locale', () => {
  assert.equal(readUriScheme(CACHE_PDF), 'file');
  const check = validatePickedPdf({
    uri: CACHE_PDF,
    name: 'fattura.pdf',
    mimeType: 'application/pdf',
    size: 240_000,
  });
  assert.deepEqual(check, { ok: true, name: 'fattura.pdf' });
});

test('2 una selezione content:// va riconosciuta come non-file', () => {
  assert.equal(readUriScheme(SAF_PDF), 'content');
  assert.equal(readUriScheme('/data/local/x.pdf'), 'other');
  assert.equal(readUriScheme(null), 'other');

  // La copia locale scatta solo quando lo schema non è file://.
  assert.match(importSource, /if \(initialScheme !== 'file'\) \{[\s\S]{0,200}?copySelectionToCache\(uri\)/);
});

test('3 il tipo application/pdf è accettato', () => {
  assert.ok(looksLikePdf({ uri: CACHE_PDF, name: 'a.pdf', mimeType: 'application/pdf' }));
  assert.ok(looksLikePdf({ uri: CACHE_PDF, name: 'a.pdf', mimeType: 'application/pdf; charset=binary' }));
});

test('4 tipo assente ed estensione .pdf restano validi', () => {
  assert.ok(looksLikePdf({ uri: CACHE_PDF, name: 'Ordine 2026.PDF', mimeType: null }));
  assert.ok(looksLikePdf({ uri: CACHE_PDF, name: null, mimeType: undefined }));
  // Alcuni fornitori dichiarano un tipo generico: decide l'estensione.
  assert.ok(looksLikePdf({ uri: CACHE_PDF, name: 'x.pdf', mimeType: 'application/octet-stream' }));
});

test('5 il selettore annullato non è un errore', () => {
  assert.match(
    importSource,
    /if \(picked\.canceled \|\| !picked\.assets\?\.\[0\]\?\.uri\) \{\s*progress\.dispose\(\);\s*return \{ document: null, errorCode: null \};/,
  );
  // L'esito del selettore viene tracciato prima di ogni decisione.
  assert.ok(
    importSource.indexOf("logPdfLocal('picker_result'") < importSource.indexOf('if (picked.canceled'),
  );
});

test('6 un file non leggibile diventa PDF_FILE_NOT_READABLE', () => {
  assert.equal(classifyLocalReadError(new Error('PDF_FILE_MISSING')), 'PDF_FILE_NOT_READABLE');
  assert.equal(classifyLocalReadError(new Error('ENOENT')), 'PDF_FILE_NOT_READABLE');
  assert.equal(classifyLocalReadError(undefined), 'PDF_FILE_NOT_READABLE');
  assert.equal(classifyLocalReadError(new Error('PDF_TOO_LARGE')), 'PDF_TOO_LARGE');
});

test('7 la copia locale usa la cache dell\'app, non percorsi fissi', () => {
  assert.match(importSource, /new File\(Paths\.cache, `pdf-import-\$\{Date\.now\(\)\}\.pdf`\)/);
  assert.match(importSource, /new File\(uri\)\.copy\(target\)/);
  assert.doesNotMatch(importSource, /\/storage\/emulated|\/sdcard/);
});

test('8 payload_ready ed edge_call_start precedono la chiamata al servizio', () => {
  const assertOrder = (body: string, stages: PdfLocalStage[]) => {
    let cursor = -1;
    for (const stage of stages) {
      const at = body.indexOf(`logPdfLocal('${stage}'`);
      assert.ok(at > 0, `manca la traccia ${stage}`);
      assert.ok(at > cursor, `traccia ${stage} fuori ordine`);
      cursor = at;
    }
  };

  const readBody = importSource.slice(
    importSource.indexOf('async function readLocalPdf'),
    importSource.indexOf('export async function pickAndParsePdf'),
  );
  assertOrder(readBody, [
    'uri_normalization',
    'local_copy_start',
    'local_copy_ok',
    'file_stat',
    'read_start',
    'read_ok',
  ]);

  const pickBody = importSource.slice(importSource.indexOf('export async function pickAndParsePdf'));
  assertOrder(pickBody, ['picker_result', 'asset_received', 'payload_ready', 'edge_call_start']);

  // La lettura locale si conclude prima di dichiarare il payload pronto, e la
  // chiamata al servizio arriva dopo la sua traccia di partenza.
  assert.ok(
    pickBody.indexOf('await readLocalPdf(') < pickBody.indexOf("logPdfLocal('payload_ready'"),
  );
  assert.ok(
    pickBody.indexOf("logPdfLocal('edge_call_start'") <
      pickBody.indexOf('await parsePdfWithSupabase('),
  );
  assert.ok(
    pickBody.indexOf('await parsePdfWithSupabase(') <
      pickBody.indexOf("logPdfLocal('edge_call_result'"),
  );
});

test('9 un file senza estensione PDF viene rifiutato', () => {
  assert.deepEqual(validatePickedPdf({ uri: CACHE_PDF, name: 'foto.jpg', mimeType: 'image/jpeg' }), {
    ok: false,
    code: 'PDF_INVALID',
  });
  assert.deepEqual(validatePickedPdf({ uri: null, name: 'a.pdf' }), {
    ok: false,
    code: 'PDF_FILE_NOT_READABLE',
  });
  assert.deepEqual(
    validatePickedPdf({
      uri: CACHE_PDF,
      name: 'grande.pdf',
      mimeType: 'application/pdf',
      size: MAX_CLOUD_PDF_BYTES + 1,
    }),
    { ok: false, code: 'PDF_TOO_LARGE' },
  );
});

test('10 ogni classificazione ha un messaggio in italiano e inglese', () => {
  for (const code of [
    'PDF_FILE_NOT_READABLE',
    'PDF_TOO_LARGE',
    'PDF_INVALID',
    'PDF_PAGE_LIMIT_EXCEEDED',
    'PDF_UPLOAD_FAILED',
  ] as const) {
    const key = pdfErrorMessageKey(code);
    assert.ok(it_[key]?.length > 0, `manca il testo italiano per ${code}`);
    assert.ok(en_[key]?.length > 0, `manca il testo inglese per ${code}`);
  }
  assert.ok(it_.pdfErrorTitle?.length > 0);
  assert.ok(en_.pdfErrorTitle?.length > 0);
});

test('11 la traccia non contiene contenuto del PDF né percorsi', () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    logPdfLocal('asset_received', {
      uriScheme: 'file',
      mimeType: 'application/pdf',
      displayName: 'fattura.pdf',
      fileSize: 240_000,
    });
    logPdfLocal('read_ok', { base64Length: 320_000 });
  } finally {
    console.warn = original;
  }

  assert.equal(warnings.length, 0);
  for (const line of warnings) {
    assert.match(line, /^\[PdfLocal\] \{/);
    assert.doesNotMatch(line, /base64":"|JVBER|content:\/\/|file:\/\//);
  }

  // Il messaggio tecnico perde gli URI prima di finire nel log.
  assert.equal(
    sanitizeErrorMessage(new Error('cannot open content://x/y/z for reading')),
    'cannot open <uri> for reading',
  );
  assert.equal(basenameOf(SAF_PDF), 'msf_1000000123');
});

test('12 la conversione base64 è nativa, non un ciclo JavaScript', () => {
  assert.match(importSource, /await file\.base64\(\)/);
  assert.doesNotMatch(importSource, /String\.fromCharCode/);
  assert.doesNotMatch(importSource, /btoa/);
  // Il limite resta quello già stabilito per il cloud.
  assert.match(importSource, /fileSize > MAX_CLOUD_PDF_BYTES/);
});

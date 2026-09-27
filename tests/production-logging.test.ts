import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  createSafeRuntimeLogger,
  normalizeRuntimeLogCode,
  sanitizeSafeLogMetadata,
  type SafeLogSink,
} from '../lib/safe-runtime-logger';
import {
  createSafeEdgeLogger,
  normalizeEdgeLogCode,
  type EdgeLogSink,
} from '../supabase/functions/_shared/safe-logging';

interface CapturedLog {
  level: 'log' | 'info' | 'warn' | 'error';
  values: unknown[];
}

function createCapture(): {
  entries: CapturedLog[];
  sink: SafeLogSink & EdgeLogSink;
} {
  const entries: CapturedLog[] = [];
  return {
    entries,
    sink: {
      log: (...values) => entries.push({ level: 'log', values }),
      info: (...values) => entries.push({ level: 'info', values }),
      warn: (...values) => entries.push({ level: 'warn', values }),
      error: (...values) => entries.push({ level: 'error', values }),
    },
  };
}

function serialized(entries: CapturedLog[]): string {
  return JSON.stringify(entries);
}

for (const fixture of [
  { id: '7A-01', label: 'rawText', key: 'rawText', value: 'OCR_SECRET_SENTINEL' },
  { id: '7A-02', label: 'email', key: 'email', value: 'person@example.invalid' },
  { id: '7A-03', label: 'telefono', key: 'phone', value: '+390000000000' },
  { id: '7A-04', label: 'nome', key: 'firstName', value: 'NOME_SENTINEL' },
  { id: '7A-05', label: 'indirizzo', key: 'address', value: 'VIA_SENTINEL_1' },
  { id: '7A-16', label: 'URI immagine', key: 'imageUri', value: 'file:///private/scan.jpg' },
  { id: '7A-17', label: 'P.IVA', key: 'vatNumber', value: '00000000000' },
  { id: '7A-18', label: 'codice fiscale', key: 'taxCode', value: 'AAAAAA00A00A000A' },
  { id: '7A-19', label: 'nota utente', key: 'notes', value: 'NOTE_SECRET_SENTINEL' },
]) {
  test(`${fixture.id} produzione senza ${fixture.label}`, () => {
    const capture = createCapture();
    const logger = createSafeRuntimeLogger({
      isDevelopment: false,
      sink: capture.sink,
    });
    logger.error(
      'OCR_FAILED',
      new Error(fixture.value),
      { [fixture.key]: fixture.value }
    );
    assert.equal(serialized(capture.entries).includes(fixture.value), false);
  });
}

test('7A-06 sviluppo consente diagnostica dietro il gate', () => {
  const capture = createCapture();
  const logger = createSafeRuntimeLogger({
    isDevelopment: true,
    sink: capture.sink,
  });
  logger.debug('CAMERA_DIAGNOSTIC', { status: 'active' }, {
    fixture: 'DEV_ONLY_SENTINEL',
  });
  assert.equal(serialized(capture.entries).includes('DEV_ONLY_SENTINEL'), true);
});

for (const fixture of [
  { id: '7A-07', code: 'OCR_FAILED' },
  { id: '7A-08', code: 'CONTACT_CLEAR_FAILED' },
  { id: '7A-09', code: 'DOCUMENT_CLOUD_FAILED' },
] as const) {
  test(`${fixture.id} errore ${fixture.code} sanitizzato`, () => {
    const capture = createCapture();
    const logger = createSafeRuntimeLogger({
      isDevelopment: false,
      sink: capture.sink,
    });
    logger.error(fixture.code, new Error('PRIVATE_ERROR_SENTINEL'));
    const output = serialized(capture.entries);
    assert.equal(output.includes(fixture.code), true);
    assert.equal(output.includes('PRIVATE_ERROR_SENTINEL'), false);
  });
}

test('7A-10 Edge Function non registra payload', () => {
  const capture = createCapture();
  const logger = createSafeEdgeLogger(capture.sink);
  Reflect.apply(logger.error, logger, [
    'DOCUMENT_PARSE_FAILED',
    {
      payload: 'PAYLOAD_SECRET_SENTINEL',
      payloadBytes: 1024,
    },
  ]);
  const output = serialized(capture.entries);
  assert.equal(output.includes('PAYLOAD_SECRET_SENTINEL'), false);
  assert.equal(output.includes('1024'), true);
});

test('7A-11 Edge Function non registra prompt completo', () => {
  const capture = createCapture();
  const logger = createSafeEdgeLogger(capture.sink);
  Reflect.apply(logger.error, logger, [
    'GEMINI_PROVIDER_REJECTED',
    { prompt: 'PROMPT_SECRET_SENTINEL' },
  ]);
  assert.equal(serialized(capture.entries).includes('PROMPT_SECRET_SENTINEL'), false);
});

test('7A-12 Edge Function non registra risposta AI completa', () => {
  const capture = createCapture();
  const logger = createSafeEdgeLogger(capture.sink);
  Reflect.apply(logger.error, logger, [
    'GEMINI_PROVIDER_REJECTED',
    {
      response: 'RESPONSE_SECRET_SENTINEL',
      httpStatus: 500,
    },
  ]);
  assert.equal(serialized(capture.entries).includes('RESPONSE_SECRET_SENTINEL'), false);
});

test('7A-13 metadati anonimi consentiti restano disponibili', () => {
  const safe = sanitizeSafeLogMetadata({
    pageCount: 3,
    durationMs: 25,
    documentType: 'business_card',
    fieldCount: 7,
  });
  assert.deepEqual(safe, {
    pageCount: 3,
    durationMs: 25,
    documentType: 'business_card',
    fieldCount: 7,
  });
});

test('7A-14 ogni errore produzione contiene un codice stabile', () => {
  const capture = createCapture();
  const logger = createSafeRuntimeLogger({
    isDevelopment: false,
    sink: capture.sink,
  });
  logger.error('CONTACT_CLEAR_FAILED');
  const record = capture.entries[0]?.values[0] as Record<string, unknown>;
  assert.equal(record.errorCode, 'CONTACT_CLEAR_FAILED');
});

test('7A-15 stack presente solo in sviluppo', () => {
  const prod = createCapture();
  const dev = createCapture();
  const error = new Error('STACK_SENTINEL');
  createSafeRuntimeLogger({ isDevelopment: false, sink: prod.sink })
    .error('OCR_FAILED', error);
  createSafeRuntimeLogger({ isDevelopment: true, sink: dev.sink })
    .error('OCR_FAILED', error);
  assert.equal(serialized(prod.entries).includes('STACK_SENTINEL'), false);
  assert.equal(serialized(dev.entries).includes('STACK_SENTINEL'), true);
});

test('7A-21 nessun console diretto resta nel runtime fuori dai logger', () => {
  const roots = ['app', 'components', 'lib', 'store', 'supabase/functions'];
  // Superfici di logging/diagnostica legacy già censite e deliberate.
  // Il gate resta fail-closed per qualunque nuovo file runtime che introduca
  // console.* o write diretti senza passare da una superficie approvata.
  const approved = new Set([
    path.normalize('lib/safe-runtime-logger.ts'),
    path.normalize('supabase/functions/_shared/safe-logging.ts'),
    path.normalize('components/Camera/MultiPageScanner.tsx'),
    path.normalize('lib/ai-credits-ui-sync.ts'),
    path.normalize('lib/business-card-zoom-policy.ts'),
    path.normalize('lib/camera-focus-diagnostics.ts'),
    path.normalize('lib/card-capture-artifacts.ts'),
    path.normalize('lib/card-capture-diagnostics.ts'),
    path.normalize('lib/document-field-evidence.ts'),
    path.normalize('lib/document-items-totals.ts'),
    path.normalize('lib/document-label-dictionary.ts'),
    path.normalize('lib/document-parser.ts'),
    path.normalize('lib/document-parties-metadata.ts'),
    path.normalize('lib/document-process-log.ts'),
    path.normalize('lib/document-process-perf.ts'),
    path.normalize('lib/document-semantic-fallback.ts'),
    path.normalize('lib/document-structured-extraction.ts'),
    path.normalize('lib/license-log.ts'),
    path.normalize('lib/ocr.ts'),
    path.normalize('lib/orientation-capture-log.ts'),
    path.normalize('lib/parse-pdf.ts'),
    path.normalize('lib/pdf-import-local.ts'),
    path.normalize('lib/pdf-import-progress.ts'),
    path.normalize('lib/pdf-page-count.ts'),
    path.normalize('lib/pdf-stage-trace.ts'),
    path.normalize('lib/privacy-consent-log.ts'),
    path.normalize('lib/qa-document-logging.ts'),
    path.normalize('lib/scan-process-workflow.ts'),
    path.normalize('lib/scan-trace.ts'),
    path.normalize('lib/structured-layout-runtime.ts'),
  ]);
  const violations: string[] = [];

  const visit = (relative: string) => {
    const absolute = path.join(process.cwd(), relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || approved.has(path.normalize(child))) {
        continue;
      }
      const source = fs.readFileSync(path.join(process.cwd(), child), 'utf8');
      const directConsole =
        /(?:globalThis\s*\.\s*)?console\s*(?:\.\s*(?:log|info|warn|error|debug|trace)|\[\s*['"](?:log|info|warn|error|debug|trace)['"]\s*\])/;
      const directProcessStream =
        /process\s*\.\s*(?:stdout|stderr)\s*\.\s*write/;
      if (directConsole.test(source) || directProcessStream.test(source)) {
        violations.push(child);
      }
    }
  };

  for (const root of roots) visit(root);
  assert.deepEqual(violations, []);
});

test('7A-22 campi stringa tecnici accettano solo valori enumerati', () => {
  for (const sentinel of [
    'RSSMRA80A01H501U',
    '01234567890',
    'PERSON_FIXTURE',
    'file:///private/scan.jpg',
  ]) {
    const safe = sanitizeSafeLogMetadata({
      status: sentinel,
      stage: sentinel,
      source: sentinel,
      method: sentinel,
      mimeType: sentinel,
      documentType: sentinel,
      reasonCode: sentinel,
    });
    assert.deepEqual(safe, {});
  }
});

test('7A-23 i codici evento provengono da cataloghi chiusi', () => {
  assert.equal(normalizeRuntimeLogCode('OCR_CJK_ANGLE_FAILED'), 'OCR_CJK_ANGLE_FAILED');
  assert.equal(normalizeRuntimeLogCode('RSSMRA80A01H501U'), 'INVALID_LOG_CODE');
  assert.equal(normalizeEdgeLogCode('01234567890'), 'INVALID_LOG_CODE');
  assert.equal(normalizeRuntimeLogCode('OCR_FAILED'), 'OCR_FAILED');
  assert.equal(
    normalizeEdgeLogCode('DOCUMENT_PARSE_FAILED'),
    'DOCUMENT_PARSE_FAILED'
  );
});

test('7A-24 le risposte Edge di errore sono sanitizzate e codificate', () => {
  const endpointPaths = [
    'supabase/functions/check-license/index.ts',
    'supabase/functions/parse-document/index.ts',
    'supabase/functions/parse-pdf/index.ts',
    'supabase/functions/structure-business-card/index.ts',
    'supabase/functions/validate-license/index.ts',
  ];

  for (const endpointPath of endpointPaths) {
    const source = fs.readFileSync(
      path.join(process.cwd(), endpointPath),
      'utf8'
    );
    assert.doesNotMatch(source, /String\s*\(\s*error\s*\)|error\.message/);
    assert.doesNotMatch(
      source,
      /GEMINI_API_KEY non configurat|Gemini non ha/
    );

    const errorBodies =
      source.match(/\{[^{}]*\berror:\s*['"][^'"]+['"][^{}]*\}/gs) ?? [];
    for (const body of errorBodies) {
      assert.match(
        body,
        /\berrorCode:\s*(?:['"][A-Za-z0-9_]+['"]|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/,
        `${endpointPath} contiene una risposta di errore senza errorCode`
      );
    }
  }

  const structureEndpoint = fs.readFileSync(
    path.join(
      process.cwd(),
      'supabase/functions/structure-business-card/index.ts'
    ),
    'utf8'
  );
  assert.doesNotMatch(
    structureEndpoint,
    /jsonResponse\s*\(\s*\{[^{}]*\bdebugInfo\b/gs
  );
});

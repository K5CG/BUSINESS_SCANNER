import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

test('P0 OCR QA: debug salva gli stadi camera fino alla base OCR dopo auto-orientamento', () => {
  const scanner = read('components/Camera/MultiPageScanner.tsx');
  const orient = scanner.indexOf('ocrPreparedUri = await autoOrientBusinessCardImage');
  const save = scanner.lastIndexOf('await saveCardCaptureArtifacts({');
  assert.ok(orient >= 0 && save > orient);
  assert.match(scanner, /overlayCropUri: useOverlayCrop \? overlayCropUri : undefined/);
  assert.match(scanner, /boundaryUri: boundaryOutputUri/);
  assert.match(scanner, /ocrInputUri: ocrPreparedUri/);
  assert.match(scanner, /boundaryMode: boundaryRefinement\.mode/);
});

test('P0 OCR QA: ogni tentativo Latin passato a ML Kit viene copiato con il proprio RAW OCR', () => {
  const ocr = read('lib/ocr.ts');
  const qa = read('lib/business-card-ocr-artifacts.ts');
  assert.match(ocr, /beginBusinessCardOcrQaSession\(\)/);
  assert.match(ocr, /saveBusinessCardOcrAttempt\([\s\S]*attemptUri[\s\S]*result\.text/);
  assert.match(qa, /10-latin-\$\{angleLabel\}-input\.jpg/);
  assert.match(qa, /10-latin-\$\{angleLabel\}-raw\.txt/);
  assert.match(qa, /99-final-raw-ocr\.txt/);
});

test('P0 OCR QA: la diagnostica non viene collegata alla pipeline documenti', () => {
  const ocr = read('lib/ocr.ts');
  const start = ocr.indexOf('export async function scanDocumentBest');
  const end = ocr.indexOf('export async function scanBusinessCardBest');
  assert.ok(start >= 0 && end > start);
  const documentSection = ocr.slice(start, end);
  assert.doesNotMatch(documentSection, /beginBusinessCardOcrQaSession|saveBusinessCardOcrAttempt|saveBusinessCardOcrSummary/);
});

test('V81 P0 OCR QA: nessuna foreground mask può essere applicata al biglietto', () => {
  const imageUtils = read('lib/image-utils.ts');
  assert.match(imageUtils, /mode: 'none' \| 'rectangle_crop' \| 'foreground_bbox'/);
  assert.doesNotMatch(imageUtils, /foreground_mask|writeMaskedForegroundSample/);
  assert.match(imageUtils, /mode: 'foreground_bbox'/);
  assert.match(imageUtils, /mode: 'rectangle_crop'/);
});

test('P0 OCR QA: debug abilita artefatti senza attivarli nelle build store', () => {
  const diag = read('lib/card-capture-diagnostics.ts');
  assert.match(diag, /RELEASE_QA_DIAGNOSTICS \|\| isDevLogEnabled\(\) \|\| CARD_QA_DIAGNOSTICS_FROM_ENV/);
  assert.match(diag, /EXPO_PUBLIC_CARD_QA_DIAGNOSTICS === '1'/);
});


test('P0 OCR QA: il codice di errore diagnostico e registrato nel logger tipizzato', () => {
  const logger = read('lib/safe-runtime-logger.ts');
  const qa = read('lib/business-card-ocr-artifacts.ts');
  assert.match(logger, /'OCR_QA_ARTIFACT_FAILED'/);
  assert.match(qa, /runtimeLogger\.debug\('OCR_QA_ARTIFACT_FAILED'/);
});

test('V81 P0 OCR QA: il fallback foreground conserva pixel interi nel bounding box', () => {
  const imageUtils = read('lib/image-utils.ts');
  assert.match(imageUtils, /BUSINESS_CARD_BOUNDARY_ANALYSIS_LONG_SIDE = 720/);
  assert.match(imageUtils, /BUSINESS_CARD_FOREGROUND_OCR_LONG_SIDE = 900/);
  assert.match(imageUtils, /foregroundDecoded[\s\S]*writeForegroundBoundingBoxSample\(/);
  assert.match(imageUtils, /foreground_primary_write_failed/);
  assert.match(imageUtils, /fallbackForeground[\s\S]*foreground_fallback_write_failed/);
  assert.match(imageUtils, /refinement_exception'[\s\S]*refinementStage/);
});



test('P0 OCR QA: encoder foreground inizializza Buffer su Hermes prima di jpeg-js encode', () => {
  const imageUtils = read('lib/image-utils.ts');
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
  assert.match(imageUtils, /import \{ Buffer \} from 'buffer'/);
  assert.match(imageUtils, /jpegRuntimeGlobal\.Buffer = Buffer/);
  assert.ok(imageUtils.indexOf('jpegRuntimeGlobal.Buffer = Buffer') < imageUtils.indexOf('const encoded = encode('));
  assert.equal(pkg.dependencies?.buffer, '^5.7.1');
});
test('P0 OCR QA: i recognizer CJK lasciano un RAW separato per script e angolo', () => {
  const ocr = read('lib/ocr.ts');
  const qa = read('lib/business-card-ocr-artifacts.ts');
  assert.match(ocr, /saveBusinessCardCjkOcrAttempt/);
  assert.match(ocr, /qaLabel: 'chinese'/);
  assert.match(ocr, /qaLabel: 'japanese'/);
  assert.match(ocr, /qaLabel: 'korean'/);
  assert.match(qa, /20-cjk-\$\{script\}-\$\{angleLabel\}-raw\.txt/);
});

test('P0 OCR QA: un recognizer CJK che fallisce non annulla gli altri script o il risultato Latin', () => {
  const ocr = read('lib/ocr.ts');
  const qa = read('lib/business-card-ocr-artifacts.ts');
  const loops = ocr.match(/for \(const candidate of BUSINESS_CARD_EXTRA_SCRIPTS\) \{[\s\S]*?\n\s*\}/g) ?? [];
  assert.ok(loops.length >= 2, 'devono esistere i due percorsi CJK: fallback e augment');
  assert.match(ocr, /saveBusinessCardCjkOcrFailure/);
  assert.match(qa, /20-cjk-\$\{script\}-\$\{angleLabel\}-failed\.txt/);
  assert.match(ocr, /catch \(error\) \{[\s\S]*?saveBusinessCardCjkOcrFailure[\s\S]*?OCR_CJK_ANGLE_FAILED/);
  assert.match(ocr, /return mergeOcrResults\(primary, extras\)/);
});

test('P0 OCR QA: CJK debole non viene mescolato al risultato Latin', () => {
  const ocr = read('lib/ocr.ts');
  const gate = read('lib/ocr-script-gate.ts');
  assert.match(ocr, /keepSubstantiveCjkLines/);
  assert.match(ocr, /const gatedExtra = keepSubstantiveCjkLines\(extra\)/);
  assert.match(gate, /cjkCount >= 2/);
  assert.match(gate, /return cjkCount >= latinCount/);
});

test('P0 OCR QA: righe email hanno un secondo OCR focalizzato sui pixel', () => {
  const ocr = read('lib/ocr.ts');
  const imageUtils = read('lib/image-utils.ts');
  assert.match(ocr, /refineBusinessCardEmailRows/);
  assert.match(ocr, /prepareFocusedOcrHighContrastRegion\(orientedUri, line\.boundingBox, 2600\)/);
  assert.match(ocr, /chooseFocusedEmail\(line\.text, focused\.text\)/);
  assert.match(imageUtils, /export async function prepareFocusedOcrRegion/);
});


test('P0 OCR QA: una foreground debole non puo distruggere il biglietto', () => {
  const imageUtils = read('lib/image-utils.ts');
  assert.match(imageUtils, /foreground\.confidence >= 0\.86 && foreground\.areaRatio >= 0\.58/);
  assert.match(imageUtils, /foreground_component_rejected/);
});

test('P0 OCR QA: la maschera non viene dilatata sul tappetino esterno', () => {
  const boundary = read('lib/business-card-boundary.ts');
  assert.match(boundary, /const safeMask = componentMask/);
  assert.doesNotMatch(boundary, /const safeMask = dilateForegroundMask\(/);
});

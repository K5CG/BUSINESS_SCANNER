import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUSINESS_CARD_OCR_TIMEOUT_MS,
  scanBusinessCardBest,
} from '../lib/ocr';
import {
  resetTextRecognitionStub,
  setTextRecognitionHandler,
  type StubRecognitionResult,
} from './stubs/ml-kit-text-recognition-stub';
import { resetFileSystemStub } from './stubs/expo-file-system-legacy-stub';
import {
  resetImageManipulatorStub,
  setImageManipulatorHandler,
} from './stubs/expo-image-manipulator-stub';

const EMPTY_RESULT: StubRecognitionResult = { text: '', blocks: [] };

test('V31: OCR biglietto rispetta un budget globale anche se ML Kit resta pendente', async () => {
  resetTextRecognitionStub();
  resetFileSystemStub();
  resetImageManipulatorStub();
  let resolveRecognition!: (result: StubRecognitionResult) => void;
  const pendingRecognition = new Promise<StubRecognitionResult>((resolve) => {
    resolveRecognition = resolve;
  });
  setTextRecognitionHandler(async () => pendingRecognition);

  const startedAt = Date.now();
  const scan = await scanBusinessCardBest(
    'file:///tmp/card.jpg',
    undefined,
    { timeoutMs: 10 },
  );
  const elapsed = Date.now() - startedAt;

  assert.ok(BUSINESS_CARD_OCR_TIMEOUT_MS <= 10_000);
  assert.ok(elapsed < 500, `timeout globale non rispettato: ${elapsed}ms`);
  assert.equal(scan.text, '');

  // Chiude la Promise nativa tardiva per non lasciare timer pendenti nel test.
  resolveRecognition(EMPTY_RESULT);
  await Promise.resolve();
  await Promise.resolve();
});

test('V31: al timeout restituisce il consenso gia disponibile fra le rotazioni concluse', async () => {
  resetTextRecognitionStub();
  resetFileSystemStub();
  resetImageManipulatorStub();
  let rotatedImageCount = 0;
  setImageManipulatorHandler(async () => {
    rotatedImageCount += 1;
    return {
      uri: `file:///tmp/card-rotated-${rotatedImageCount}.jpg`,
      width: 1200,
      height: 800,
    };
  });
  let callCount = 0;
  let resolveFourth!: (result: StubRecognitionResult) => void;
  const fourthPending = new Promise<StubRecognitionResult>((resolve) => {
    resolveFourth = resolve;
  });
  const observed = (company: string, companyWidth: number): StubRecognitionResult => ({
    text: ['DANTE CHIERICO', company, 'Tel. 0445 671155'].join('\n'),
    blocks: [{
      lines: [
        { text: 'DANTE CHIERICO', frame: { left: 10, top: 10, width: 220, height: 18 } },
        { text: company, frame: { left: 10, top: 40, width: companyWidth, height: 18 } },
        { text: 'Tel. 0445 671155', frame: { left: 10, top: 70, width: 220, height: 18 } },
      ],
    }],
  });
  setTextRecognitionHandler(async () => {
    callCount += 1;
    if (callCount === 1) return observed('S.A.GE.A. s.n.c.', 600);
    if (callCount === 2 || callCount === 3) return observed('S.A.GE.MA. s.n.c.', 220);
    return fourthPending;
  });

  const scan = await scanBusinessCardBest('file:///tmp/card.jpg', undefined, { timeoutMs: 50 });
  assert.match(scan.text, /S\.A\.GE\.MA\. s\.n\.c\./);
  assert.doesNotMatch(scan.text, /S\.A\.GE\.A\. s\.n\.c\./);

  resolveFourth(EMPTY_RESULT);
  await Promise.resolve();
  await Promise.resolve();
});

test('V32: email personale confermata 4/4 non avvia riletture focalizzate costose', async () => {
  resetTextRecognitionStub();
  resetFileSystemStub();
  resetImageManipulatorStub();
  let rotatedImageCount = 0;
  setImageManipulatorHandler(async () => ({
    uri: `file:///tmp/only-type-${++rotatedImageCount}.jpg`,
    width: 1200,
    height: 800,
  }));
  let recognitionCount = 0;
  setTextRecognitionHandler(async () => {
    recognitionCount += 1;
    const texts = [
      'Only Type',
      'di Balduzzo Raimondo',
      'Centro Revisioni Autorizzato',
      'Concessionario Ufficiale Kawasaki Vicenza',
      'onlytype @ libero.it',
    ];
    return {
      text: texts.join('\n'),
      blocks: [{ lines: texts.map((text, index) => ({
        text,
        frame: { left: 10, top: 10 + index * 30, width: 360, height: 18 },
      })) }],
    };
  });

  const result = await scanBusinessCardBest('file:///tmp/only-type.jpg', undefined, { timeoutMs: 2_000 });
  assert.match(result.text, /onlytype@libero\.it/i);
  assert.deepEqual(result.multiAngleConfirmedEmails, ['onlytype@libero.it']);
  assert.equal(recognitionCount, 4, 'devono restare soltanto le quattro letture full-card');
});

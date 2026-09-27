import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  autoOrientBusinessCardImage,
  ORIENTATION_ATTEMPT_CONCURRENCY,
} from '../lib/card-orientation-fix';
import { scanBusinessCardBest } from '../lib/ocr';
import { isTemporaryCacheImageUri } from '../lib/temporary-image-cleanup';
import {
  imageManipulatorCalls,
  resetImageManipulatorStub,
  setImageManipulatorHandler,
  type Action,
} from './stubs/expo-image-manipulator-stub';
import {
  resetReactNativeImageStub,
  setStubImageSize,
} from './stubs/react-native-image-stub';
import {
  resetTextRecognitionStub,
  setTextRecognitionHandler,
  type StubRecognitionResult,
} from './stubs/ml-kit-text-recognition-stub';
import {
  deletedFileUris,
  resetFileSystemStub,
} from './stubs/expo-file-system-legacy-stub';

const ORIGINAL_URI = 'file:///cache/original.jpg';
const EMPTY_RESULT: StubRecognitionResult = { text: '', blocks: [] };

function resetStubs(): void {
  resetImageManipulatorStub();
  resetReactNativeImageStub();
  resetTextRecognitionStub();
  resetFileSystemStub();
  setStubImageSize(ORIGINAL_URI, 2000, 1000);
}

function rotationOf(actions: Action[]): number | null {
  const action = actions.find((candidate) => 'rotate' in candidate);
  return action && 'rotate' in action ? action.rotate : null;
}

function installImageHandler(): void {
  setImageManipulatorHandler(async (uri, actions) => {
    const resize = actions.find((action) => 'resize' in action);
    if (resize) {
      const output = 'file:///cache/thumb.jpg';
      setStubImageSize(output, 480, 240);
      return { uri: output, width: 480, height: 240 };
    }

    const rotation = rotationOf(actions) ?? 0;
    const isFullSize = uri === ORIGINAL_URI;
    const output = isFullSize
      ? `file:///cache/final-${rotation}.jpg`
      : `file:///cache/thumb-${rotation}.jpg`;
    const oddQuarterTurn = rotation === 90 || rotation === 270;
    const width = isFullSize
      ? oddQuarterTurn
        ? 1000
        : 2000
      : oddQuarterTurn
        ? 240
        : 480;
    const height = isFullSize
      ? oddQuarterTurn
        ? 2000
        : 1000
      : oddQuarterTurn
        ? 480
        : 240;
    setStubImageSize(output, width, height);
    return { uri: output, width, height };
  });
}

async function flushUntil(
  predicate: () => boolean,
  message: string,
  maxTurns: number = 100
): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

test('4B-I01 orientamento reale limita a due OCR e trattiene solo il risultato finale', async () => {
  resetStubs();
  installImageHandler();
  let inFlight = 0;
  let maxInFlight = 0;

  setTextRecognitionHandler(async (uri) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    if (uri.includes('thumb-90')) {
      return {
        text: 'mario@example.com 02418014317',
        blocks: [
          {
            lines: [
              {
                text: 'mario@example.com 02418014317',
                frame: { left: 0, top: 0, width: 300, height: 20 },
              },
            ],
          },
        ],
      };
    }
    return EMPTY_RESULT;
  });

  const output = await autoOrientBusinessCardImage(
    ORIGINAL_URI,
    'landscape',
    {
      operationId: 'integration-success',
      isActive: () => true,
      timeoutMs: 1000,
    }
  );

  assert.equal(output, 'file:///cache/final-90.jpg');
  assert.ok(maxInFlight >= 1);
  assert.ok(maxInFlight <= ORIENTATION_ATTEMPT_CONCURRENCY);
  assert.equal(
    imageManipulatorCalls().filter(
      (call) => call.uri === ORIGINAL_URI && rotationOf(call.actions) !== null
    ).length,
    1
  );
  assert.deepEqual([...deletedFileUris()].sort(), [
    'file:///cache/thumb-180.jpg',
    'file:///cache/thumb-270.jpg',
    'file:///cache/thumb-90.jpg',
    'file:///cache/thumb.jpg',
  ]);
  assert.equal(deletedFileUris().includes(ORIGINAL_URI), false);
  assert.equal(deletedFileUris().includes(output), false);
});

test('4B-I02 timeout reale ignora OCR tardivo e non ruota mai il full-size', async () => {
  resetStubs();
  installImageHandler();
  let resolveRecognition!: (result: StubRecognitionResult) => void;
  const pendingRecognition = new Promise<StubRecognitionResult>((resolve) => {
    resolveRecognition = resolve;
  });
  setTextRecognitionHandler(async () => pendingRecognition);

  const output = await autoOrientBusinessCardImage(
    ORIGINAL_URI,
    'landscape',
    {
      operationId: 'integration-timeout',
      isActive: () => true,
      timeoutMs: 5,
    }
  );

  assert.equal(output, ORIGINAL_URI);
  assert.equal(
    imageManipulatorCalls().some(
      (call) => call.uri === ORIGINAL_URI && rotationOf(call.actions) !== null
    ),
    false
  );
  assert.equal(deletedFileUris().includes('file:///cache/thumb.jpg'), false);

  resolveRecognition({
    text: 'late@example.com 02418014317',
    blocks: [
      {
        lines: [
          {
            text: 'late@example.com 02418014317',
            frame: { left: 0, top: 0, width: 300, height: 20 },
          },
        ],
      },
    ],
  });
  await flushUntil(
    () => deletedFileUris().includes('file:///cache/thumb.jpg'),
    'il cleanup deve partire dopo il settlement OCR tardivo'
  );

  assert.equal(
    imageManipulatorCalls().some(
      (call) => call.uri === ORIGINAL_URI && rotationOf(call.actions) !== null
    ),
    false
  );
  assert.equal(deletedFileUris().includes(ORIGINAL_URI), false);
});

test('4B-I03 lease già stale non avvia thumbnail, OCR o trasformazioni', async () => {
  resetStubs();
  installImageHandler();
  let recognizes = 0;
  setTextRecognitionHandler(async () => {
    recognizes += 1;
    return EMPTY_RESULT;
  });

  const output = await autoOrientBusinessCardImage(
    ORIGINAL_URI,
    'landscape',
    {
      operationId: 'integration-stale',
      isActive: () => false,
      timeoutMs: 100,
    }
  );

  assert.equal(output, ORIGINAL_URI);
  assert.equal(recognizes, 0);
  assert.equal(imageManipulatorCalls().length, 0);
  assert.deepEqual(deletedFileUris(), []);
});

test('4B-I04 entrambi gli scanner invalidano e finalizzano la lease prima degli effetti', () => {
  const multiPage = readFileSync(
    resolve('components/Camera/MultiPageScanner.tsx'),
    'utf8'
  );
  const singlePage = readFileSync(
    resolve('components/Camera/CardScanner.tsx'),
    'utf8'
  );

  assert.match(multiPage, /captureOperationsRef\.current\.begin\(\)/);
  assert.match(multiPage, /invalidateCaptureOperation\('screen_blurred'\)/);
  assert.match(multiPage, /processOperationsRef\.current\.begin\(\)/);
  assert.match(multiPage, /finalizeAfterSettlement\(pendingNativeCapture/);
  assert.match(multiPage, /if \(!operation\.tryFinalize\(\)\) return/);
  assert.match(multiPage, /onDiscardedValue:\s*\(latePhoto\)/);
  assert.match(multiPage, /captureScope\.retain\(imageUris\.persistenceSourceUri\)/);
  assert.match(multiPage, /operation\.tryFinalize\(\)/);
  assert.match(multiPage, /operationId:\s*operation\.operationId/);
  assert.match(singlePage, /scanOperationsRef\.current\.begin\(\)/);
  assert.match(singlePage, /useFocusEffect\(/);
  assert.match(singlePage, /scanInProgressRef\.current/);
  assert.match(singlePage, /finalizeAfterSettlement\(pendingNativeCapture/);
  assert.match(singlePage, /onDiscardedValue:\s*\(latePhoto\)/);
  assert.match(singlePage, /scanScope\.retain\(imageUris\.persistenceSourceUri\)/);
  assert.match(singlePage, /scanOperationsRef\.current\.dispose\(\)/);
  assert.match(singlePage, /operation\.tryFinalize\(\)/);
  assert.match(singlePage, /scanBusinessCardBest\(\s*imageUris\.ocrPreparedUri,\s*operation/);
});

test('4B-I05 orientamento e OCR principale condividono lo stesso limite nativo', async () => {
  resetStubs();
  installImageHandler();
  let inFlight = 0;
  let maxInFlight = 0;
  const releases: Array<() => void> = [];

  setTextRecognitionHandler(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    inFlight -= 1;
    return {
      text: 'ACME',
      blocks: [
        {
          lines: [
            {
              text: 'ACME',
              frame: { left: 0, top: 0, width: 120, height: 20 },
            },
          ],
        },
      ],
    };
  });

  let settled = false;
  const work = Promise.all([
    autoOrientBusinessCardImage(ORIGINAL_URI, 'landscape', {
      operationId: 'shared-orientation',
      isActive: () => true,
      timeoutMs: 100_000,
    }),
    scanBusinessCardBest(ORIGINAL_URI),
  ]).finally(() => {
    settled = true;
  });

  await flushUntil(
    () => releases.length >= 2,
    'due chiamate native devono occupare il limite condiviso'
  );
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(releases.length, 2);
  assert.equal(inFlight, 2);

  for (let turn = 0; turn < 50 && !settled; turn += 1) {
    await flushUntil(
      () => releases.length > 0 || settled,
      'il limiter deve avviare il prossimo batch'
    );
    const batch = releases.splice(0);
    assert.ok(inFlight <= 2);
    batch.forEach((release) => release());
    await Promise.resolve();
    await Promise.resolve();
  }
  const [, scan] = await work;

  assert.ok(scan.text.includes('ACME'));
  assert.ok(maxInFlight >= 1);
  assert.ok(maxInFlight <= ORIENTATION_ATTEMPT_CONCURRENCY);
});

test('4B-I06 cleanup accetta solo immagini realmente interne alla cache', () => {
  const cache = 'file:///cache/';
  assert.equal(
    isTemporaryCacheImageUri('file:///cache/scan/photo.jpg', cache),
    true
  );
  assert.equal(
    isTemporaryCacheImageUri('file:///documents/photo.jpg', cache),
    false
  );
  assert.equal(
    isTemporaryCacheImageUri(
      'file:///cache/%2e%2e/documents/photo.jpg',
      cache
    ),
    false
  );
  assert.equal(
    isTemporaryCacheImageUri('content://camera/photo.jpg', cache),
    false
  );
});

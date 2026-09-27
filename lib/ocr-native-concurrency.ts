import {
  createAsyncConcurrencyGate,
  type AsyncConcurrencyOutcome,
} from './guarded-operation';

export const OCR_NATIVE_CONCURRENCY_LIMIT = 2;
export const OCR_NATIVE_PENDING_LIMIT = 4;
/** ML Kit su alcuni Android non risponde mai: libera il gate e fallisce. */
export const OCR_NATIVE_TASK_TIMEOUT_MS = 18_000;

const nativeOcrGate = createAsyncConcurrencyGate(
  OCR_NATIVE_CONCURRENCY_LIMIT,
  OCR_NATIVE_PENDING_LIMIT
);

function withNativeTimeout<T>(
  task: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('OCR_NATIVE_TIMEOUT'));
    }, timeoutMs);
    Promise.resolve()
      .then(task)
      .then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

/**
 * Unico confine concorrente per ML Kit. Le pipeline possono scadere
 * logicamente, ma non possono accumulare chiamate native senza limite.
 */
export function runOcrNativeTask<T>(
  task: () => Promise<T>,
  isActive: () => boolean = () => true,
  timeoutMs: number = OCR_NATIVE_TASK_TIMEOUT_MS,
): Promise<AsyncConcurrencyOutcome<T>> {
  return nativeOcrGate.run({
    task: () => withNativeTimeout(task, timeoutMs),
    isActive,
  });
}

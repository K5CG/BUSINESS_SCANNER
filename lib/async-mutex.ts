export interface AsyncMutex {
  runExclusive: <T>(task: () => Promise<T>) => Promise<T>;
}
export function createAsyncMutex(): AsyncMutex {
  let queue: Promise<void> = Promise.resolve();

  return {
    async runExclusive<T>(task: () => Promise<T>): Promise<T> {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

export const EDGE_DATABASE_TIMEOUT_MS = 2_000;

export async function withEdgeDatabaseDeadline<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs = EDGE_DATABASE_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('EDGE_DATABASE_TIMEOUT'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve(operation(controller.signal)),
      expired,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

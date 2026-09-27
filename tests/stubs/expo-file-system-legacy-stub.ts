export const cacheDirectory = 'file:///cache/';

let deleted: string[] = [];

export function resetFileSystemStub(): void {
  deleted = [];
}

export function deletedFileUris(): readonly string[] {
  return deleted;
}

export async function deleteAsync(
  uri: string,
  _options?: { idempotent?: boolean }
): Promise<void> {
  deleted.push(uri);
}

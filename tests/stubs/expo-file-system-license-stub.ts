const files = new Map<string, string>();

export const documentDirectory = 'file:///test-documents/';

export const cacheDirectory = 'file:///cache/';

export function resetLicenseFileStub(): void {
  files.clear();
}

export function stubFileContents(): ReadonlyMap<string, string> {
  return files;
}

export async function getInfoAsync(uri: string): Promise<{ exists: boolean }> {
  return { exists: files.has(uri) };
}

export async function readAsStringAsync(uri: string): Promise<string> {
  const value = files.get(uri);
  if (value === undefined) throw new Error(`missing ${uri}`);
  return value;
}

export async function writeAsStringAsync(uri: string, contents: string): Promise<void> {
  files.set(uri, contents);
}

export async function deleteAsync(uri: string, _options?: { idempotent?: boolean }): Promise<void> {
  files.delete(uri);
}

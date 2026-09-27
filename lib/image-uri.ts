/** Normalizza URI locali per `<Image>`, ML Kit e condivisione su Android. */
export function resolveImageUri(uri: string): string {
  if (!uri) return uri;
  if (uri.startsWith('file:/') && !uri.startsWith('file://')) {
    return uri.replace(/^file:\/*/, 'file:///');
  }
  if (
    uri.startsWith('file://') ||
    uri.startsWith('content://') ||
    uri.startsWith('http://') ||
    uri.startsWith('https://')
  ) {
    return uri;
  }
  if (uri.startsWith('/')) {
    return `file://${uri}`;
  }
  return uri;
}

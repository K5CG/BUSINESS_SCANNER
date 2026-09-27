/** RN/Android safe — does not rely on crypto.getRandomValues (uuid v4 breaks on device). */
export function createReactNativeSafeInstallationId(prefix = 'bs'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

declare const __DEV__: boolean | undefined;

export function traceScan(
  step: string,
  detail?: Record<string, string | number | boolean>,
): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__ === false) return;
  console.warn(`[SCAN] ${step}`, detail ? JSON.stringify(detail) : '');
}

/**
 * React Native surface used only by phase 6B bundled tests.
 */
export const Alert = { alert: (..._args: unknown[]) => undefined };
export const Dimensions = {
  get: (_name: string) => ({ width: 1080, height: 1920, scale: 1, fontScale: 1 }),
};
export const Platform = {
  OS: 'android' as const,
  select: <T>(spec: { android?: T; ios?: T; default?: T }) =>
    spec.android ?? spec.default ?? spec.ios,
};
export const NativeModules: Record<string, unknown> = {};
export const Image = { resolveAssetSource: (source: unknown) => source };
export default { Alert, Dimensions, Platform, NativeModules, Image };

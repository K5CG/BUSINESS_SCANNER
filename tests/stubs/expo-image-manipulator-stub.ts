export enum SaveFormat {
  JPEG = 'jpeg',
  PNG = 'png',
  WEBP = 'webp',
}

export enum FlipType {
  Vertical = 'vertical',
  Horizontal = 'horizontal',
}

export type Action =
  | { resize: { width?: number; height?: number } }
  | { rotate: number }
  | {
      crop: {
        originX: number;
        originY: number;
        width: number;
        height: number;
      };
    }
  | { flip: FlipType }
  | {
      extent: {
        originX?: number;
        originY?: number;
        width: number;
        height: number;
        backgroundColor?: string | null;
      };
    };

export interface StubResult {
  uri: string;
  width: number;
  height: number;
  base64?: string;
}

export interface ManipulatorCall {
  uri: string;
  actions: Action[];
  options: Record<string, unknown>;
}

const calls: ManipulatorCall[] = [];
const results: StubResult[] = [];
let failure: Error | null = null;
let handler:
  | ((
      uri: string,
      actions: Action[],
      options: Record<string, unknown>
    ) => Promise<StubResult>)
  | null = null;

export function resetImageManipulatorStub(): void {
  calls.splice(0);
  results.splice(0);
  failure = null;
  handler = null;
}

export function queueImageManipulatorResult(result: StubResult): void {
  results.push(result);
}

export function failImageManipulatorWith(error: Error): void {
  failure = error;
}

export function setImageManipulatorHandler(
  nextHandler: (
    uri: string,
    actions: Action[],
    options: Record<string, unknown>
  ) => Promise<StubResult>
): void {
  handler = nextHandler;
}

export function imageManipulatorCalls(): readonly ManipulatorCall[] {
  return calls;
}

export async function manipulateAsync(
  uri: string,
  actions: Action[] = [],
  options: Record<string, unknown> = {}
): Promise<StubResult> {
  calls.push({ uri, actions, options });
  if (failure) throw failure;
  if (handler) return handler(uri, actions, options);
  const result = results.shift();
  if (!result) throw new Error('missing image manipulator stub result');
  return result;
}

export interface StubRecognizedLine {
  text: string;
  frame?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

export interface StubRecognitionResult {
  text: string;
  blocks: Array<{ lines: StubRecognizedLine[] }>;
}

export enum TextRecognitionScript {
  LATIN = 'latin',
  CHINESE = 'chinese',
  DEVANAGARI = 'devanagari',
  JAPANESE = 'japanese',
  KOREAN = 'korean',
}

let handler: (uri: string, script?: TextRecognitionScript) => Promise<StubRecognitionResult> = async () => ({
  text: '',
  blocks: [],
});
let calls: string[] = [];
let scriptCalls: Array<TextRecognitionScript | undefined> = [];

export function resetTextRecognitionStub(): void {
  calls = [];
  scriptCalls = [];
  handler = async () => ({ text: '', blocks: [] });
}

export function setTextRecognitionHandler(
  nextHandler: (uri: string, script?: TextRecognitionScript) => Promise<StubRecognitionResult>
): void {
  handler = nextHandler;
}

export function textRecognitionCalls(): readonly string[] {
  return calls;
}

export function textRecognitionScriptCalls(): readonly (TextRecognitionScript | undefined)[] {
  return scriptCalls;
}

const TextRecognition = {
  async recognize(uri: string, script?: TextRecognitionScript): Promise<StubRecognitionResult> {
    calls.push(uri);
    scriptCalls.push(script);
    return handler(uri, script);
  },
};

export default TextRecognition;

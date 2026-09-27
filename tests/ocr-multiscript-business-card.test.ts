import assert from 'node:assert/strict';
import test from 'node:test';
import { scanBusinessCardBest } from '../lib/ocr';
import {
  resetTextRecognitionStub,
  setTextRecognitionHandler,
  textRecognitionScriptCalls,
  TextRecognitionScript,
} from './stubs/ml-kit-text-recognition-stub';

function result(lines: string[]) {
  return {
    text: lines.join('\n'),
    blocks: [{
      lines: lines.map((text, index) => ({
        text,
        frame: { left: 10, top: 10 + index * 24, width: 220, height: 18 },
      })),
    }],
  };
}

test('OCR multiscript: Latin resta autoritativo e CJK aggiunge solo righe nuove', async () => {
  resetTextRecognitionStub();
  setTextRecognitionHandler(async (_uri, script) => {
    if (script === TextRecognitionScript.CHINESE) return result(['KOMINE CO., LTD.', '小峰']);
    if (script === TextRecognitionScript.JAPANESE) return result(['KOMINE CO., LTD.', '株式会社コミネ']);
    if (script === TextRecognitionScript.KOREAN) return result(['KOMINE CO., LTD.', '코미네']);
    return result(['MICHAEL CHANG', 'KOMINE CO., LTD.']);
  });

  const scan = await scanBusinessCardBest('file:///tmp/card.jpg');
  assert.match(scan.text, /MICHAEL CHANG/);
  assert.match(scan.text, /小峰/);
  assert.match(scan.text, /株式会社コミネ/);
  assert.match(scan.text, /코미네/);
  assert.equal((scan.text.match(/KOMINE CO\., LTD\./g) ?? []).length, 1);

  const scripts = textRecognitionScriptCalls();
  assert.ok(scripts.includes(TextRecognitionScript.CHINESE));
  assert.ok(scripts.includes(TextRecognitionScript.JAPANESE));
  assert.ok(scripts.includes(TextRecognitionScript.KOREAN));
});

test('OCR multiscript: se Latin è vuoto il fallback CJK resta disponibile', async () => {
  resetTextRecognitionStub();
  setTextRecognitionHandler(async (_uri, script) => {
    if (script === TextRecognitionScript.JAPANESE) return result(['株式会社コミネ']);
    return result([]);
  });

  const scan = await scanBusinessCardBest('file:///tmp/card.jpg');
  assert.match(scan.text, /株式会社コミネ/);
});

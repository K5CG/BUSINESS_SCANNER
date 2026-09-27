import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createFocusGate } from '../lib/camera-focus-gate';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

test('V34: NOT_FOCUSED_LOCKED non autorizza lo scatto', async () => {
  const gate = createFocusGate();
  const waiting = gate.waitForFocusedLocked(10);
  gate.onAutofocusStateChanged({ nativeEvent: { state: 'NOT_FOCUSED_LOCKED' } });
  assert.equal(await waiting, 'TIMEOUT');
});

test('V34: FOCUSED_LOCKED autorizza lo scatto nel ciclo corrente', async () => {
  const gate = createFocusGate();
  const waiting = gate.waitForFocusedLocked(100);
  gate.onAutofocusStateChanged({ nativeEvent: { state: 'FOCUSED_LOCKED' } });
  assert.equal(await waiting, 'FOCUSED_LOCKED');
});

test('V34: il ramo card conserva TIMEOUT senza trasformarlo in stato AF precedente', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'components/Camera/useFocusPulse.ts'),
    'utf8'
  );
  const start = source.indexOf("if (mode === 'card')");
  const branch = source.slice(start, source.indexOf('\n\n      gate.invalidateFocusLock();', start));
  assert.match(branch, /return cardState/);
  assert.doesNotMatch(branch, /cardState === 'TIMEOUT'\s*\?\s*gate\.getLastAfState/);
});
